import sqlite3
import tempfile
import unittest
from pathlib import Path
from studio import desktop_file


class DesktopFiles(unittest.TestCase):
    def test_only_indexed_files_inside_media_roots_can_be_opened(self):
        with tempfile.TemporaryDirectory() as folder, sqlite3.connect(':memory:') as db:
            root=Path(folder)
            image=root/'output/ComfyBridge/image.png'
            thumb=root/'thumbnails/thumb.jpg'
            for path in (image,thumb):
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(b'test')
            media_id='3f59770998574a8c80c18ed7d02b5389'
            db.execute('CREATE TABLE media(id,path,thumbnail)')
            db.execute('INSERT INTO media VALUES(?,?,?)',(media_id,str(image),str(thumb)))
            self.assertEqual(desktop_file(db,root,root,dict(id=media_id))['path'],str(image.resolve()))
            self.assertEqual(desktop_file(db,root,root,dict(id=media_id,thumbnail=True))['path'],str(thumb.resolve()))
            with self.assertRaises(ValueError):
                desktop_file(db,root,root,dict(id='../anything'))
            with self.assertRaises(ValueError):
                desktop_file(db,root,root,dict(id='00000000-0000-0000-0000-000000000000'))
            db.execute('UPDATE media SET path=?',(str(thumb),))
            with self.assertRaises(ValueError):
                desktop_file(db,root,root,dict(id=media_id))
            db.execute('UPDATE media SET path=?',(str(image),))
            image.unlink()
            with self.assertRaisesRegex(ValueError,'moved or deleted'):
                desktop_file(db,root,root,dict(id=media_id))
