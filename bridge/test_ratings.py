import unittest,sqlite3,tempfile
from pathlib import Path
from contextlib import closing
from studio import rate_media
from media_index import with_ratings
class RatingTests(unittest.TestCase):
 def test_persist_validate_and_clear(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder)
   with closing(sqlite3.connect(root/'library.sqlite')) as db:
    db.execute('CREATE TABLE media(id TEXT PRIMARY KEY)');db.execute("INSERT INTO media VALUES('one')");db.commit()
    for bad in (True,-1,6,2.5,'4',None):
     with self.assertRaises(ValueError):rate_media(db,dict(id='one',rating=bad))
    with self.assertRaises(ValueError):rate_media(db,dict(id='missing',rating=3))
    rate_media(db,dict(id='one',rating=4))
   self.assertEqual(with_ratings([dict(id='one')],root)[0]['rating'],4)
   with closing(sqlite3.connect(root/'library.sqlite')) as db:rate_media(db,dict(id='one',rating=0))
   self.assertEqual(with_ratings([dict(id='one')],root)[0]['rating'],0)
