import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from PIL import Image
import provenance
import recipes
from studio import replay
from workflows import Workflows, EROS_BETA7


class FinalFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config=json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))
        cls.workflows=Workflows(config['comfyRoot'])

    def settings(self, **changes):
        s=copy.deepcopy(self.workflows.defaults()['video'])
        s.update(width=64,height=96,frames=180,fps=18,exactFrames=True,sound=False,
                 positive='A blue ceramic bowl slowly rotates on a table.',negative='',seed='31',
                 upload='ComfyBridge/start.png',finalFrame='ComfyBridge/end.png')
        s.update(changes);return s

    def graph(self, **changes):return self.workflows.build('video',self.settings(**changes),'ComfyBridge/'+str(uuid.uuid4()))

    def test_first_and_final_frames_wire_both_models_and_anchor_the_kept_end(self):
        for model in (self.workflows.defaults()['video']['model'],EROS_BETA7):
            g=self.graph(model=model)
            self.assertEqual(g['6']['inputs']['first_frame'],['2',0]);self.assertEqual(g['6']['inputs']['last_frame'],['60',0])
            self.assertEqual(g['60']['inputs']['image'],'ComfyBridge/end.png')
            self.assertEqual(g['6']['inputs']['length'],192);self.assertEqual(g['65']['inputs']['frame_idx'],179)
            self.assertEqual(g['9']['inputs']['conditioning'],['65',0]);self.assertEqual(g['51']['inputs']['length'],180)

    def test_aligned_duration_uses_native_end_without_extra_guide(self):
        g=self.graph(frames=175)
        self.assertEqual(g['6']['inputs']['length'],175);self.assertIn('last_frame',g['6']['inputs'])
        self.assertNotIn('65',g)

    def test_negative_conditioning_has_identical_first_and_final_references(self):
        g=self.graph(negative='blur')
        self.assertEqual(g['55']['inputs']['first_frame'],g['6']['inputs']['first_frame'])
        self.assertEqual(g['55']['inputs']['last_frame'],g['6']['inputs']['last_frame'])
        self.assertEqual(g['66']['inputs']['frame_idx'],179)
        self.assertEqual(g['9']['inputs']['positive'],['65',0]);self.assertEqual(g['9']['inputs']['negative'],['66',0])

    def test_final_frame_alone_preserves_text_video_canvas_and_omitting_it_is_unchanged(self):
        g=self.graph(upload=None)
        self.assertNotIn('first_frame',g['6']['inputs']);self.assertEqual(g['6']['inputs']['last_frame'],['60',0])
        no_end=self.graph(finalFrame=None)
        self.assertNotIn('last_frame',no_end['6']['inputs']);self.assertNotIn('60',no_end);self.assertNotIn('65',no_end)
        with self.assertRaisesRegex(ValueError,'at least two'):self.graph(frames=1)
        with self.assertRaisesRegex(ValueError,'only available for video'):
            self.workflows.build('image',self.settings(),'unused')

    def test_extension_final_frame_targets_the_last_new_frame_after_overlap(self):
        g=self.graph(upload=None,extension={'id':'unused'},negative='blur')
        self.assertNotIn('first_frame',g['6']['inputs'])
        self.assertEqual(g['6']['inputs']['last_frame'],['60',0])
        self.assertEqual(g['65']['inputs']['positive'],['50',0]);self.assertEqual(g['65']['inputs']['frame_idx'],184)
        self.assertEqual(g['66']['inputs']['positive'],['56',0]);self.assertEqual(g['66']['inputs']['frame_idx'],184)
        self.assertEqual(g['51']['inputs']['batch_index'],5);self.assertEqual(g['51']['inputs']['length'],180)

    def test_final_input_is_immutable_replayable_inspectable_and_invalidates_edited_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input/ComfyBridge/end.png';source.parent.mkdir(parents=True)
            Image.new('RGB',(32,48),'lightblue').save(source)
            settings=self.settings(upload=None);recipes.keep_images(root,settings);source.unlink()
            db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
            db.executescript('CREATE TABLE jobs(id,kind,settings);CREATE TABLE generation_graphs(job,graph);')
            job=str(uuid.uuid4());db.execute('INSERT INTO jobs VALUES(?,?,?)',(job,'video',json.dumps(settings)))
            graph=self.workflows.build('video',settings,'ComfyBridge/'+job)
            db.execute('INSERT INTO generation_graphs VALUES(?,?)',(job,json.dumps(graph)))
            result=replay(db,root,job)
            self.assertTrue(result['inputs']['finalFrame']['data'].startswith('data:image/png;base64,'))
            self.assertTrue(Path(provenance.source_file(db,root,root,job,'finalFrame')['path']).is_file())
            loaded=dict(settings,replayOf=job)
            self.assertIsNotNone(recipes.graph_for_replay(db,'video',loaded,str(uuid.uuid4())))
            loaded['finalFrame']='ComfyBridge/another.png'
            self.assertIsNone(recipes.graph_for_replay(db,'video',loaded,str(uuid.uuid4())))
            Path(root/'input'/settings['finalFrame']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'changed'):replay(db,root,job)
            db.close()


if __name__=='__main__':unittest.main()
