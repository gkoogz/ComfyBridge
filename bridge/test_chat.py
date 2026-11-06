import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
import chat


class ChatTests(unittest.TestCase):
    def test_comfy_memory_release_can_succeed_without_json_body(self):
        with patch.object(chat.urllib.request,'urlopen',return_value=io.BytesIO(b'')):
            self.assertEqual(chat.json_request('http://fixture/free',{'unload_models':True}),{})
        with patch.object(chat.urllib.request,'urlopen',return_value=io.BytesIO(b'{"status":"ok"}')):
            self.assertEqual(chat.json_request('http://fixture/health'),{'status':'ok'})

    def test_idle_expiry_preserves_draft_and_does_not_count_polling(self):
        with chat.database(self.root) as db:
            db.execute("INSERT INTO chat_messages VALUES('old','assistant','A forest.',100,'','test','complete')")
            db.execute("UPDATE chat_meta SET last_activity=100,draft='Unsent idea' WHERE id=1")
            db.commit()
            old=chat.meta(db)['conversation']
            chat.expire_idle_chat(db,7299)
            self.assertEqual(chat.meta(db)['conversation'],old)
            chat.snapshot(db)
            self.assertEqual(chat.meta(db)['last_activity'],100)
            chat.expire_idle_chat(db,7300)
            self.assertNotEqual(chat.meta(db)['conversation'],old)
            self.assertEqual(chat.meta(db)['draft'],'Unsent idea')
            self.assertEqual(chat.snapshot(db)['messages'],[])

    def test_idle_expiry_never_interrupts_active_reply(self):
        with chat.database(self.root) as db:
            db.execute("INSERT INTO chat_messages VALUES('old','assistant','',100,'','test','loading')")
            db.execute("UPDATE chat_meta SET last_activity=100,active='old',status='loading' WHERE id=1")
            db.commit()
            chat.expire_idle_chat(db,9000)
            self.assertEqual(len(chat.snapshot(db)['messages']),1)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        (self.root/'models').mkdir()
        (self.root/'models/test.gguf').write_bytes(b'test fixture')
        (self.root/'runtime.exe').touch()
        (self.root/'chat-runtime.json').write_text(json.dumps(dict(modelDir=str(self.root/'models'),executable=str(self.root/'runtime.exe'),selected='test.gguf')))
        self.state=self.call('state')

    def tearDown(self):
        self.temp.cleanup()

    def call(self,route,body=None,device='one'):
        return chat.request(self.root,route,body or {},device,'http://127.0.0.1:1',launch=False)

    def send(self,text='Discuss a landscape prompt.',id=None):
        return self.call('send',dict(conversation=self.state['conversation'],text=text,id=id or str(uuid.uuid4()),draft_revision=self.state['draft_revision'],source='image positive'))

    def test_shared_active_chat_and_idempotent_send(self):
        identity=str(uuid.uuid4())
        first=self.send(id=identity)
        again=self.send(id=identity)
        self.assertEqual(first,again)
        self.assertEqual(len(again['messages']),2)
        self.assertEqual(self.call('state',device='other')['messages'],first['messages'])
        with self.assertRaisesRegex(ValueError,'already in progress'):
            self.send('A second simultaneous message')

    def test_draft_conflict_and_receipt(self):
        edit=str(uuid.uuid4())
        body=dict(conversation=self.state['conversation'],base=0,edit=edit,text='Phone one')
        first=self.call('draft',body)
        self.assertEqual(first,self.call('draft',body))
        second=self.call('draft',dict(body,edit=str(uuid.uuid4()),text='Phone two'),device='two')
        self.assertTrue(second['draftConflict'])
        self.assertEqual(second['draft'],'Phone one')

    def test_reset_invalidates_old_device_and_clears_only_chat(self):
        self.send()
        marker=self.root/'library.sqlite';marker.write_bytes(b'existing library untouched')
        reset=self.call('reset',dict(conversation=self.state['conversation']))
        self.assertFalse(reset['busy'])
        self.assertEqual(reset['messages'],[])
        self.assertNotEqual(reset['conversation'],self.state['conversation'])
        self.assertEqual(marker.read_bytes(),b'existing library untouched')
        with self.assertRaisesRegex(ValueError,'restarted'):
            self.send()

    def test_send_does_not_erase_other_devices_draft(self):
        self.call('draft',dict(conversation=self.state['conversation'],base=0,edit=str(uuid.uuid4()),text='Other device typing'))
        sent=self.send()
        self.assertEqual(sent['draft'],'Other device typing')

    def test_model_selection_does_not_accept_paths(self):
        self.assertEqual(self.call('models')['selected'],'test.gguf')
        with self.assertRaisesRegex(ValueError,'installed'):
            self.call('select',dict(id='../elsewhere.gguf'))
        self.send()
        with self.assertRaisesRegex(ValueError,'current reply'):
            self.call('select',dict(id='test.gguf'))

    def test_empty_oversize_and_missing_model_do_not_create_messages(self):
        for text in ('',' '*10,'x'*24001):
            with self.assertRaises(ValueError):self.send(text)
        (self.root/'models/test.gguf').unlink()
        with self.assertRaisesRegex(ValueError,'installed'):
            self.send()
        self.assertEqual(self.call('state')['messages'],[])

    def test_context_omits_incomplete_assistant_and_preserves_raw_text(self):
        text='<b>literal prompt</b>\nSecond line.'
        sent=self.send(text)
        db=chat.database(self.root)
        try:
            messages=chat.context_messages(db,sent['active'])
            self.assertEqual(messages[-1],dict(role='user',content=text))
            self.assertEqual(len(messages),2)
        finally:db.close()

    def test_unchanged_poll_and_gpu_handoff_without_runtime(self):
        self.assertTrue(self.call('state',dict(after=self.state['revision']))['unchanged'])
        self.assertTrue(self.call('yield')['ok'])
        db=chat.database(self.root)
        try:self.assertGreater(chat.meta(db)['gpu_after'],0)
        finally:db.close()


if __name__=='__main__':unittest.main()
