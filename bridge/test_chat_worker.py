import contextlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import chat


class WorkerTests(unittest.TestCase):
    def exercise(self, interrupt=False):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder);(data/'models').mkdir();(data/'models/test.gguf').write_bytes(b'fixture')
            (data/'runtime.exe').touch()
            (data/'chat-runtime.json').write_text(json.dumps(dict(modelDir=str(data/'models'),executable=str(data/'runtime.exe'),selected='test.gguf')))
            state=chat.request(data,'state',{},'one','http://invalid',launch=False)
            chat.request(data,'send',dict(conversation=state['conversation'],text='A quiet forest.',id=str(uuid.uuid4())),'one','http://invalid',launch=False)
            engines=[];handoffs=[]
            class Process:
                pid=123
                def __init__(self):self.stopped=threading.Event()
                def poll(self):return 1 if self.stopped.is_set() else None
                def terminate(self):self.stopped.set()
            class Engine:
                def __init__(self,config,model,gpu,data):
                    self.gpu=gpu;self.process=Process();self.url='http://fixture';self.key='fixture';self.closed=False;engines.append(self)
                def close(self):self.closed=True;self.process.terminate()
            class Stream:
                def __enter__(self):return self
                def __exit__(self,*args):pass
                def __iter__(self):
                    engine=engines[-1]
                    yield b'data: '+json.dumps(dict(choices=[dict(delta=dict(content='A quiet forest'))])).encode()+b'\n'
                    if interrupt:
                        raise OSError('Fixture interrupted stream')
                    if engine.gpu:
                        def handoff():handoffs.append(chat.request(data,'yield',{},'panel','http://invalid',launch=False))
                        thread=threading.Thread(target=handoff);thread.start()
                        if not engine.process.stopped.wait(5):raise AssertionError('GPU worker did not yield')
                        raise OSError('Fixture preemption')
                    yield b'data: '+json.dumps(dict(choices=[dict(delta=dict(content=' at sunrise.'))])).encode()+b'\n'
                    yield b'data: [DONE]\n'
            with patch.object(chat,'Engine',Engine),patch.object(chat,'rendering',return_value=False),patch.object(chat,'available_ram',return_value=64*1024**3),patch.object(chat,'json_request',return_value={'status':'ok'}),patch.object(chat.urllib.request,'urlopen',return_value=Stream()):
                chat.run(data,'http://invalid')
            final=chat.request(data,'state',{},'other','http://invalid',launch=False)
            self.assertIsNone(final['active'])
            self.assertTrue(all(e.closed for e in engines))
            if interrupt:
                self.assertEqual(final['status'],'error')
                self.assertEqual(final['messages'][-1]['content'],'A quiet forest')
                self.assertIn('interrupted',final['detail'])
            else:
                self.assertEqual([e.gpu for e in engines],[True,False])
                self.assertEqual(handoffs,[dict(ok=True)])
                self.assertEqual(final['messages'][-1]['content'],'A quiet forest at sunrise.')
                self.assertEqual(final['status'],'idle')
            with contextlib.closing(chat.database(data)) as db:
                self.assertEqual(chat.meta(db)['gpu'],0)
                self.assertEqual(chat.meta(db)['engine_pid'],0)

    def test_gpu_handoff_restarts_reply_on_cpu_and_releases_memory(self):self.exercise()
    def test_interrupted_stream_keeps_partial_reply_and_reports_error(self):self.exercise(True)


if __name__=='__main__':unittest.main()
