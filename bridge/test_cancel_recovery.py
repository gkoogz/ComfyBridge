import unittest
import ast
import asyncio
import logging
from pathlib import Path
import sqlite3
import types
import tempfile
import json
import hashlib
import os
from unittest.mock import patch
import aiohttp
from cancel_recovery import can_recover
from progress import Progress

class RecoveryTests(unittest.TestCase):
    def test_worker_recycles_only_cancelled_job_and_preserves_pending_batch(self):
        tree=ast.parse(Path(__file__).with_name('worker.py').read_text(encoding='utf-8'))
        node=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_cancel_ids')
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE jobs(id,status,current_node)')
        db.executemany('INSERT INTO jobs VALUES(?,?,?)',[('ours','cancelling','7/8'),('next','pending','')]);db.commit()
        kills=[]
        async def comfy(path,data=None):
            if path=='/queue':return {'queue_running':[[0,'ours']],'queue_pending':[]}
            return {}
        async def run(fn,*args,**kwargs):return fn(*args,**kwargs)
        def kill(args,**kwargs):kills.append(args);return types.SimpleNamespace(returncode=0)
        def update(id,**values):
            db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),id));db.commit()
        ns=dict(DB=db,OWNED=types.SimpleNamespace(pid=123,poll=lambda:None),CANCEL_STARTED={'ours':0},
                time=types.SimpleNamespace(monotonic=lambda:121),asyncio=types.SimpleNamespace(to_thread=run),
                subprocess=types.SimpleNamespace(run=kill,CREATE_NO_WINDOW=0),comfy=comfy,update=update,
                can_recover=can_recover,logging=logging)
        exec(compile(ast.Module(body=[node],type_ignores=[]),'worker cancellation','exec'),ns)
        asyncio.run(ns['_cancel_ids']({'ours'}))
        self.assertEqual(kills,[['taskkill','/PID','123','/T','/F']])
        self.assertEqual(db.execute('SELECT id,status FROM jobs ORDER BY id').fetchall(),[('next','pending'),('ours','cancelled')])
        self.assertIsNone(ns['OWNED']);db.close()

    def test_only_timed_out_explicit_cancel_of_owned_isolated_job(self):
        q={'queue_running':[[0,'ours']], 'queue_pending':[]}
        self.assertTrue(can_recover(True,120,q,{'ours'}))
        self.assertFalse(can_recover(True,119,q,{'ours'}))
        self.assertFalse(can_recover(False,600,q,{'ours'}))
        self.assertFalse(can_recover(True,600,q,{'another'}))
        self.assertFalse(can_recover(True,600,dict(q,queue_pending=[[1,'other']]),{'ours'}))
        self.assertFalse(can_recover(True,600,dict(q,queue_running=[[0,'ours'],[1,'other']]),{'ours'}))
        self.assertFalse(can_recover(True,600,dict(q,queue_running=[]),{'ours'}))

    def test_stale_progress_warning_clears_when_step_advances(self):
        now=[0.0]
        p=Progress('video',{'1':{'class_type':'SamplerCustomAdvanced'}},dict(steps=8,width=576,height=864,frames=180),clock=lambda:now[0])
        p.step('1',{'value':7,'max':8});now[0]=601
        self.assertIn('no new progress',p.sample()[1])
        p.step('1',{'value':8,'max':8})
        self.assertNotIn('no new progress',p.sample()[1])


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_updates_only_owned_idle_process_and_does_not_restart_again(self):
        tree=ast.parse(Path(__file__).with_name('worker.py').read_text(encoding='utf-8'))
        node=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_ensure_comfy')
        for owned,busy,matching,expected in ((True,False,False,1),(True,True,False,0),(False,False,False,0),(True,False,True,0)):
            with self.subTest(owned=owned,busy=busy,matching=matching), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);target=root/'custom_nodes/comfybridge_eros_vsa/__init__.py'
                target.parent.mkdir(parents=True);target.write_text('# revision')
                revision=hashlib.sha256(target.read_bytes()).hexdigest()
                if matching:(root/'comfy-node-version.json').write_text(json.dumps(dict(pid=123,revision=revision)))
                kills=[];launches=[]
                async def comfy(path):
                    return {'queue_running':[[0,'ours']] if busy else [],'queue_pending':[]}
                def kill(args,**kwargs):kills.append(args);return types.SimpleNamespace(returncode=0)
                def launch(args,**kwargs):launches.append(args);return types.SimpleNamespace(pid=456,poll=lambda:None)
                async def immediate(_):pass
                ns=dict(ROOT=root,DATA=root,OWNED=types.SimpleNamespace(pid=123,poll=lambda:None) if owned else None,
                        hashlib=hashlib,json=json,os=os,comfy=comfy,asyncio=asyncio,aiohttp=aiohttp,
                        subprocess=types.SimpleNamespace(run=kill,Popen=launch,CREATE_NO_WINDOW=0))
                exec(compile(ast.Module(body=[node],type_ignores=[]),'worker startup','exec'),ns)
                with patch('asyncio.sleep',immediate):await ns['_ensure_comfy']()
                self.assertEqual(len(kills),expected);self.assertEqual(len(launches),expected)
                if expected:
                    self.assertIn('--cache-none',launches[0])
                    self.assertEqual(json.loads((root/'comfy-node-version.json').read_text()),dict(pid=456,revision=revision))
                    await ns['_ensure_comfy']()
                    self.assertEqual(len(kills),1)
