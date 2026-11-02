import json
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import handoff as h


class HandoffTests(unittest.TestCase):
    def test_swap_only_our_idle_listener_and_preserve_its_gpu(self):
        with TemporaryDirectory() as folder:
            home=Path(folder)
            with closing(sqlite3.connect(home/'library.sqlite')) as db, db:
                db.execute('create table jobs(status text)')
                db.execute("insert into jobs values('running')")
            worker=Mock(pid=123);worker.name.return_value='python.exe'
            worker.cmdline.return_value=['python.exe',str(home/'worker.py')]
            gpu=Mock(pid=456);gpu.exe.return_value=str(home/'zluda/zluda.exe')
            gpu.cmdline.return_value=['zluda.exe','--','python.exe','main.py','--port','8188'];gpu.create_time.return_value=1.
            worker.children.return_value=[gpu]
            listener=SimpleNamespace(status='LISTEN',laddr=('127.0.0.1',18766),pid=123)
            with patch.object(h.psutil,'net_connections',return_value=[listener]),patch.object(h.psutil,'Process',return_value=worker):
                self.assertFalse(h.retire(home,home,home))
                worker.terminate.assert_not_called()
                with closing(sqlite3.connect(home/'library.sqlite')) as db, db:db.execute("update jobs set status='complete'")
                worker.cmdline.return_value=['python.exe',str(home/'different.py')]
                self.assertFalse(h.retire(home,home,home))
                worker.terminate.assert_not_called()
                worker.cmdline.return_value=['python.exe',str(home/'worker.py')]
                self.assertTrue(h.retire(home,home,home))
                worker.terminate.assert_called_once();gpu.terminate.assert_not_called()
                self.assertEqual(json.loads((home/'launcher-handoff.json').read_text()),{'pid':456,'born':1.})
            with patch.object(h.psutil,'Process',return_value=gpu):
                self.assertEqual(h.adopt(home,home).pid,456)
                gpu.create_time.return_value=100.
                self.assertIsNone(h.adopt(home,home))
