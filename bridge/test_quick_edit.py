import contextlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
import chat
import quick_edit


class QuickEditTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.data=Path(self.temp.name)
        (self.data/'models').mkdir();(self.data/'models/test.gguf').write_bytes(b'fixture');(self.data/'runtime.exe').touch()
        (self.data/'chat-runtime.json').write_text(json.dumps(dict(modelDir=str(self.data/'models'),executable=str(self.data/'runtime.exe'),selected='test.gguf')))
        self.state=chat.request(self.data,'state',{},'phone1','http://fixture',launch=False)
        self.body=dict(id=str(uuid.uuid4()),source='image positive',prompt='An orange bowl.',instructions='Make it blue.')

    def call(self,route,body=None,device='phone1'):
        return chat.request(self.data,route,body or self.body,device,'http://fixture',launch=False)

    def test_isolated_payload_preserves_chat_and_draft(self):
        with contextlib.closing(chat.database(self.data)) as db,db:
            db.execute("INSERT INTO chat_messages(id,role,content,status) VALUES('private','user','Unrelated discussion','complete')")
            db.execute("UPDATE chat_meta SET draft='Unsent draft' WHERE id=1")
        result=self.call('quick-submit');self.assertEqual(result['status'],'queued')
        with contextlib.closing(chat.database(self.data)) as db:
            messages=chat.context_messages(db,self.body['id'])
            self.assertEqual(len(messages),2);self.assertNotIn('Unrelated',json.dumps(messages))
            self.assertEqual(json.loads(messages[1]['content'])['edit_instructions'],'Make it blue.')
            self.assertEqual(chat.meta(db)['draft'],'Unsent draft')
            self.assertEqual(chat.snapshot(db)['messages'][0]['content'],'Unrelated discussion')

    def test_idempotency_ownership_queue_and_chat_reset(self):
        self.call('quick-submit');self.call('quick-submit')
        with self.assertRaisesRegex(ValueError,'another device'):self.call('quick-state',device='phone2')
        with self.assertRaisesRegex(ValueError,'different text'):self.call('quick-submit',dict(self.body,instructions='Make it red.'))
        second=dict(self.body,id=str(uuid.uuid4()),source='video negative')
        self.call('quick-submit',second,device='phone2')
        self.call('reset',dict(conversation=self.state['conversation']))
        with contextlib.closing(chat.database(self.data)) as db:
            self.assertEqual(chat.meta(db)['active'],self.body['id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM quick_edits').fetchone()[0],2)
        self.call('quick-discard')
        with contextlib.closing(chat.database(self.data)) as db:self.assertEqual(chat.meta(db)['active'],second['id'])

    def test_invalid_output_is_not_used(self):
        for value in ('{"prompt":"A blue bowl."}','Here is your prompt: a blue bowl.','{"edited_prompt":""}','{"edited_prompt":"<prompt></prompt>"}','{"edited_prompt":42}','{"edited_prompt":"unfinished'):
            with self.subTest(value=value),self.assertRaises(ValueError):quick_edit.result(value)
        self.assertEqual(quick_edit.result('{"edited_prompt":"A blue bowl.\\nSoft light."}'),'A blue bowl.\nSoft light.')

    def test_unchanged_output_is_rejected_including_legacy_results(self):
        for text in ('An orange bowl.', '  An orange   bowl.\n', '<prompt>An orange bowl.</prompt>'):
            with self.assertRaisesRegex(ValueError,'without applying an edit'):
                quick_edit.result(json.dumps(dict(edited_prompt=text)), self.body['prompt'])
        self.assertEqual(quick_edit.result('{"edited_prompt":"A blue bowl."}', self.body['prompt']), 'A blue bowl.')
        self.call('quick-submit')
        with contextlib.closing(chat.database(self.data)) as db,db:
            db.execute("UPDATE quick_edits SET status='complete',result=prompt WHERE id=?",(self.body['id'],))
        response=self.call('quick-state')
        self.assertEqual(response['status'],'error')
        self.assertEqual(response['result'],'')
        self.assertEqual(response['instructions'],self.body['instructions'])

    def test_cosmetic_change_does_not_count_as_content_edit(self):
        with self.assertRaises(quick_edit.UnchangedEdit):
            quick_edit.result('{"edited_prompt":"An orange bowl!"}','An orange bowl.','Make it blue.')
        self.assertEqual(quick_edit.result('{"edited_prompt":"An orange bowl!"}', 'An orange bowl.',
                         'Use an exclamation mark.'),'An orange bowl!')

    def test_patch_validation(self):
        source='A red bowl on a red table.'
        good=dict(edits=[dict(find='red bowl',replace='blue bowl'),dict(find='red table',replace='white table')])
        self.assertEqual(quick_edit.patch_result(json.dumps(good),source),'A blue bowl on a white table.')
        for edits in ([],[dict(find='red',replace='blue')],[dict(find='missing',replace='blue')],
                      [dict(find='red bowl',replace='blue'),dict(find='bowl on',replace='cup on')],
                      [dict(find='red bowl',replace='red bowl')]):
            with self.assertRaises(ValueError):quick_edit.patch_result(json.dumps(dict(edits=edits)),source)

    def exercise_worker(self,malformed=False,leased=False,unchanged=False,recover=False):
        self.call('quick-submit')
        second=dict(self.body,id=str(uuid.uuid4()),source='video negative')
        self.call('quick-submit',second,device='phone2')
        engines=[];payloads=[];lease_checks={}
        def granted(data,identity):
            lease_checks[identity]=lease_checks.get(identity,0)+1
            if lease_checks[identity]==1:return False
            if lease_checks[identity]==2:
                with contextlib.closing(chat.database(data)) as db:
                    self.assertEqual(quick_edit.get(db,identity)['status'],'waiting')
            return True
        class Process:
            pid=123
            def __init__(self):self.stopped=False
            def poll(self):return 1 if self.stopped else None
            def terminate(self):self.stopped=True
        class Engine:
            def __init__(self,*args):self.process=Process();self.url='http://fixture';self.key='fixture';engines.append(self)
            def close(self):self.process.terminate()
        class Stream:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def __iter__(self):
                output='not a prompt' if malformed else json.dumps(dict(edited_prompt='An orange bowl.' if unchanged or (recover and len(payloads)%2==1) else 'A blue bowl.'))
                if (recover or unchanged) and len(payloads)%2==0:
                    output=json.dumps(dict(edits=[dict(find='An orange',replace='An orange' if unchanged else 'A blue')]))
                for chunk in (output[:7],output[7:]):
                    yield b'data: '+json.dumps(dict(choices=[dict(delta=dict(content=chunk))])).encode()+b'\n'
                yield b'data: [DONE]\n'
        def urlopen(req,**kwargs):payloads.append(json.loads(req.data));return Stream()
        with patch.object(chat,'Engine',Engine),patch.object(chat,'rendering',return_value=leased),patch.object(chat,'renderer_queue_busy',return_value=False),patch.object(chat.gpu_handoff,'granted',side_effect=granted if leased else lambda *args:False),patch.object(chat,'available_ram',return_value=64*1024**3),patch.object(chat,'json_request',return_value=dict(status='ok')),patch.object(chat.urllib.request,'urlopen',side_effect=urlopen):
            chat.run(self.data,'http://fixture')
        self.assertEqual(len(engines),2);self.assertTrue(all(e.process.stopped for e in engines))
        self.assertEqual(payloads[0]['response_format'],quick_edit.FORMAT)
        self.assertTrue(payloads[0]['chat_template_kwargs']['enable_thinking'])
        self.assertEqual(len(payloads),4 if unchanged or recover else 2)
        if unchanged or recover:
            self.assertEqual(payloads[1]['messages'][-1]['role'],'user')
            self.assertEqual(payloads[1]['response_format'],quick_edit.PATCH_FORMAT)
        result=self.call('quick-state')
        self.assertEqual(result['status'],'error' if malformed or unchanged else 'complete')
        self.assertEqual(result['result'],'' if malformed or unchanged else 'A blue bowl.')
        self.assertGreaterEqual(result['elapsedSeconds'],0)
        with contextlib.closing(chat.database(self.data)) as db:
            self.assertEqual(chat.snapshot(db)['messages'],[])
            self.assertIsNone(chat.meta(db)['active']);self.assertEqual(chat.meta(db)['gpu'],0)

    def test_worker_recovers_after_one_unchanged_response(self):self.exercise_worker(recover=True)

    def test_worker_rejects_unchanged_output(self):self.exercise_worker(unchanged=True)

    def test_same_worker_runs_two_edits_and_releases_gpu(self):self.exercise_worker()
    def test_failure_isolated_and_next_request_still_runs(self):self.exercise_worker(True)
    def test_quick_edits_wait_for_the_video_gpu_handoff(self):self.exercise_worker(leased=True)


if __name__=='__main__':unittest.main()
