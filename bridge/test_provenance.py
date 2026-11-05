import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from PIL import Image
import provenance
import recipes


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE jobs(id,kind,created,status,settings);
            CREATE TABLE media(id,job,kind,created,duration,archived);
            CREATE TABLE job_times(job,started,ended,observed);''')
    def add(self,kind='image',**settings):
        job=str(uuid.uuid4());media=uuid.uuid4().hex
        self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?)',(job,kind,100,'complete',json.dumps(settings)))
        self.db.execute('INSERT INTO media VALUES(?,?,?,?,?,?)',(media,job,kind,140,3 if kind=='video' else 0,1))
        self.db.execute('INSERT INTO job_times VALUES(?,?,?,?)',(job,110,140,0))
        return job,media
    def test_fork_merge_and_archived_parent(self):
        root,image=self.add(positive='original',seed='123',provenanceVersion=1)
        a,_=self.add(upload='ComfyBridge/a.png',sourceMedia=image,provenanceVersion=1)
        b,_=self.add(kind='video',upload='ComfyBridge/a.png',sourceMedia=image,fps=24,frames=240)
        fork,_=self.add(replayOf=a,upload='ComfyBridge/a.png',sourceMedia=image)
        self.assertEqual(len(provenance.node(self.db,root)['branches']),3)
        node=provenance.node(self.db,fork)
        self.assertEqual([p['job'] for p in node['parents']],[a,root])
        self.assertEqual(node['sources'][0]['media']['archived'],1)
        self.assertEqual(node['elapsed'],30)
        self.assertEqual(provenance.node(self.db,b)['type'],'Image to video')
        self.assertEqual(provenance.node(self.db,root)['settings']['seed'],'123')
    def test_missing_parent_and_legacy_are_honest(self):
        job,_=self.add(upload='ComfyBridge/a.png',sourceMedia='missing')
        node=provenance.node(self.db,job)
        self.assertEqual(node['parents'],[]);self.assertIsNone(node['sources'][0]['media'])
        self.assertFalse(node['provenanceKnown'])
    def test_source_preserved_checked_and_confined(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input/ComfyBridge/input.png';source.parent.mkdir(parents=True)
            Image.new('RGB',(32,48),'green').save(source)
            settings={'upload':'ComfyBridge/input.png'};recipes.keep_images(root,settings)
            job,_=self.add(**settings,recipeVersion=1)
            source.unlink()
            full=provenance.source_file(self.db,root,root,job,'upload')
            self.assertTrue(Path(full['path']).is_file())
            thumb=provenance.source_file(self.db,root,root,job,'upload-thumb')
            self.assertEqual(thumb['mime'],'image/jpeg')
            Path(full['path']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'changed'):provenance.source_file(self.db,root,root,job,'upload')
            outside=root/'outside.png';Image.new('RGB',(2,2)).save(outside)
            bad,_=self.add(upload=str(outside))
            with self.assertRaisesRegex(ValueError,'Invalid source'):provenance.source_file(self.db,root,root,bad,'upload')
    def test_extension_has_own_type_and_parent(self):
        job,media=self.add(kind='video')
        child,_=self.add(kind='video',sourceMedia=media,extension={'id':'recipe-'+'a'*64})
        node=provenance.node(self.db,child)
        self.assertEqual(node['type'],'Extend video');self.assertEqual(node['parents'][0]['job'],job)
    def test_reusing_original_input_keeps_its_context(self):
        root,_=self.add(upload='ComfyBridge/a.png')
        origin=dict(job=root,role='upload')
        child,_=self.add(upload='ComfyBridge/b.png',sourceOrigin=origin)
        self.assertEqual(provenance.node(self.db,child)['parents'],[dict(job=root,relation='Input reused from')])
        source=provenance.node(self.db,root)['sources'][0]
        self.assertEqual(source['branches'][0]['job'],child)
