"""Exercise production coordinator functions with isolated stores and fake Comfy."""
import ast
import asyncio
from contextlib import closing
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid
import aiohttp
import chat
import gpu_handoff as gpu
from progress import Progress


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.data=Path(self.tmp.name);self.job=str(uuid.uuid4())
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE jobs(id,status,current_node,progress)')
        self.db.executemany('INSERT INTO jobs VALUES(?,?,?,?)',[(self.job,'running','Sample video',.4),('next','pending','',0)])
        self.events=[];self.busy=False
        async def comfy(path,data=None):
            self.events.append((path,data))
            if path=='/queue':return dict(queue_running=[[0,'unrelated']] if self.busy else [],queue_pending=[])
            if path=='/system_stats':return dict(devices=[dict(torch_vram_total=0)])
            return {}
        def update(id,**values):
            self.db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),id));self.db.commit()
        def kill(*args,**kwargs):
            self.events.append(('kill',None));return types.SimpleNamespace(returncode=0)
        self.ns=dict(DATA=self.data,ROOT=self.data,DB=self.db,gpu=gpu,asyncio=asyncio,aiohttp=aiohttp,json=json,
            OWNED=types.SimpleNamespace(pid=123,poll=lambda:None),COMFY_START_LOCK=asyncio.Lock(),
            HANDOFF_STAGE={},comfy=comfy,update=update,Progress=Progress,TRACKER=None,CLIENT='fixture',math=math,
            rows=lambda sql,args=():[dict(r) for r in self.db.execute(sql,args)],
            subprocess=types.SimpleNamespace(run=kill,CREATE_NO_WINDOW=0))
        tree=ast.parse(Path(__file__).with_name('worker.py').read_text(encoding='utf-8'))
        functions=[n for n in tree.body if isinstance(n,(ast.AsyncFunctionDef,ast.FunctionDef)) and n.name in ('release_for_chat','chat_window','resume_checkpoint','verify_checkpoint_output')]
        exec(compile(ast.Module(body=functions,type_ignores=[]),'production GPU coordinator','exec'),self.ns)
        async def ensure():self.events.append(('ensure',None))
        self.ns['ensure_comfy']=ensure

    def active_chat(self):
        db=chat.database(self.data)
        with db:
            db.execute("UPDATE chat_meta SET active='reply',status='waiting',runner_at=? WHERE id=1",(time.time(),))
        db.close()

    def checkpoint(self):
        root=gpu.folder(self.data,self.job);root.mkdir(parents=True)
        (root/'state.pt').write_bytes(b'placeholder: sampler roundtrip tested separately')
        gpu.atomic_json(root/'paused.json',dict(step=3,total=8))

    async def test_no_release_or_grant_while_unrelated_job_running(self):
        self.busy=True
        self.assertFalse(await self.ns['release_for_chat']())
        self.assertNotIn(('kill',None),self.events)
        self.assertFalse(gpu.granted(self.data,'reply'))

    async def test_resume_waits_for_chat_process_exit_and_keeps_job_identity(self):
        self.active_chat();self.checkpoint()
        graph={'1':dict(class_type='SamplerCustomAdvanced',inputs={})}
        job=dict(id=self.job,kind='video',settings=json.dumps(dict(steps=8,width=64,height=64,frames=5)))
        task=asyncio.create_task(self.ns['resume_checkpoint'](job,graph))
        try:
            for _ in range(350):
                if gpu.granted(self.data,'reply'):break
                await asyncio.sleep(.01)
            self.assertTrue(gpu.granted(self.data,'reply'))
            self.assertIn(('/free',dict(unload_models=True,free_memory=True)),self.events)
            self.assertNotIn(('kill',None),self.events)
            self.assertFalse(any(path=='/prompt' for path,_ in self.events))
            with closing(chat.database(self.data)) as db,db:
                db.execute("UPDATE chat_meta SET active=NULL,gpu=1,engine_pid=456,status='idle' WHERE id=1")
            await asyncio.sleep(1.1)
            self.assertFalse(task.done(),'must wait for engine.close, not just final message')
            with closing(chat.database(self.data)) as db,db:db.execute('UPDATE chat_meta SET gpu=0,engine_pid=0 WHERE id=1')
            self.assertTrue(await asyncio.wait_for(task,3))
            prompt=next(body for path,body in self.events if path=='/prompt')
            self.assertEqual(prompt['prompt_id'],self.job)
            self.assertEqual(prompt['prompt'],graph)
            self.assertEqual(self.db.execute("SELECT status FROM jobs WHERE id='next'").fetchone()[0],'pending')
            self.assertFalse(gpu.granted(self.data,'reply'))
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)

    async def test_cancel_while_paused_does_not_resubmit(self):
        self.active_chat();self.checkpoint()
        self.db.execute("UPDATE jobs SET status='cancelling' WHERE id=?",(self.job,))
        self.assertFalse(await self.ns['chat_window'](self.job))
        self.assertEqual(self.db.execute('SELECT status FROM jobs WHERE id=?',(self.job,)).fetchone()[0],'cancelled')
        self.assertFalse(any(path=='/prompt' for path,_ in self.events))

    async def test_dead_chat_releases_queue_without_erasing_partial_reply(self):
        self.active_chat()
        with closing(chat.database(self.data)) as db,db:
            db.execute("INSERT INTO chat_messages(id,role,content,status) VALUES('reply','assistant','Partial answer','responding')")
            db.execute('UPDATE chat_meta SET runner_at=1,engine_pid=0,gpu=1 WHERE id=1')
        self.assertFalse(gpu.wants_chat(self.data))
        with closing(chat.database(self.data)) as db,db:
            self.assertEqual(db.execute("SELECT content,status FROM chat_messages WHERE id='reply'").fetchone()[:],('Partial answer','error'))

    async def test_recovery_rejects_incomplete_output_before_collecting(self):
        import av
        from PIL import Image
        path=self.data/'output.mp4'
        with av.open(str(path),'w') as video:
            stream=video.add_stream('libx264',rate=24);stream.width=stream.height=32;stream.pix_fmt='yuv420p'
            for i in range(5):
                frame=av.VideoFrame.from_image(Image.new('RGB',(32,32),'blue'));frame.pts=i
                for packet in stream.encode(frame):video.mux(packet)
            for packet in stream.encode():video.mux(packet)
        verify=self.ns['verify_checkpoint_output']
        verify(path,dict(frames=5,exactFrames=True,sound=False))
        with self.assertRaisesRegex(ValueError,'incomplete'):verify(path,dict(frames=6,exactFrames=True,sound=False))
        with self.assertRaisesRegex(ValueError,'soundtrack'):verify(path,dict(frames=5,sound=True))


if __name__=='__main__':unittest.main()
