import sqlite3
import tempfile
from pathlib import Path
import time
import json
import unittest
import uuid

from studio import prepare, history_rows, replay, notes_sync, settings_sync


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.row_factory=sqlite3.Row
        self.db.executescript("""
            CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,batch TEXT,owner TEXT,
                              created REAL,status TEXT,settings TEXT);
            CREATE TABLE media(id TEXT PRIMARY KEY,job TEXT,created REAL);
        """)
        prepare(self.db)
        self.job=str(uuid.uuid4())

    def tearDown(self):
        self.db.close()

    def add_job(self, settings=None, created=None):
        self.db.execute("INSERT INTO jobs VALUES(?,?, 'batch','phone',?,'pending',?)",
                        (self.job,'image',created or time.time(),json.dumps(settings or {})))

    def test_elapsed_and_last_24_hours(self):
        self.add_job(created=time.time()-100000)
        self.assertEqual(len(history_rows(self.db)['jobs']),1)
        self.db.execute("UPDATE jobs SET status='running'")
        running=history_rows(self.db)['jobs'][0]
        self.assertIsNotNone(running['started'])
        self.db.execute("UPDATE jobs SET status='error'")
        finished=history_rows(self.db)['jobs'][0]
        self.assertEqual(finished['started'],running['started'])
        self.assertGreaterEqual(finished['ended'],finished['started'])
        self.db.execute("UPDATE job_times SET ended=?",(time.time()-86401,))
        self.assertFalse(history_rows(self.db)['jobs'])

    def test_pending_cancel_is_zero(self):
        self.add_job()
        self.db.execute("UPDATE jobs SET status='cancelled'")
        j=history_rows(self.db)['jobs'][0]
        self.assertEqual(j['started'],j['ended'])

    def test_replay_actual_seed_and_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=root/'input/ComfyBridge';folder.mkdir(parents=True)
            (folder/'image.png').write_bytes(b'image');(folder/'mask.png').write_bytes(b'mask')
            settings=dict(seed='18446744073709551615',positive='test',upload='ComfyBridge/image.png',mask='ComfyBridge/mask.png')
            self.add_job(settings)
            result=replay(self.db,root,self.job)
            self.assertEqual(result['settings'],{**settings,'replayOf':self.job})
            self.assertEqual(result['inputs']['mask'],'data:image/png;base64,bWFzaw==')
            (folder/'mask.png').unlink()
            with self.assertRaisesRegex(ValueError,'missing'):
                replay(self.db,root,self.job)

    def test_latest_edit_per_screen(self):
        settings_sync(self.db,{'image':{'stamp':10,'value':'image A'}},'phone A')
        settings_sync(self.db,{'video':{'stamp':15,'value':'video B'},'image':{'stamp':11,'value':'image B'}},'phone B')
        latest=settings_sync(self.db,{'image':{'stamp':9,'value':'older offline A'}},'phone A')
        self.assertEqual(latest['image']['value'],'image B')
        self.assertEqual(latest['video']['value'],'video B')

    def test_notes_survive_two_offline_writers_and_retry(self):
        def edit(text,base,tag):
            return dict(doc=dict(text=text,next=1,marks=[dict(start=0,end=1,color=0)]),base=base,edit=tag)
        first=notes_sync(self.db,edit('a',0,'1'),'A')
        self.assertEqual(notes_sync(self.db,{},'B')['doc'],first['doc'])
        later=edit('b',0,'2')
        second=notes_sync(self.db,later,'B')
        self.assertTrue(second['conflict'])
        self.assertEqual(second['doc']['text'],'a\n\n\nb')
        self.assertEqual(second['doc']['marks'][-1]['start'],3)
        self.assertEqual(notes_sync(self.db,later,'B')['rev'],second['rev'])


if __name__=='__main__':
    unittest.main(verbosity=2)
