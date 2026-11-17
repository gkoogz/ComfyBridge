import copy
import json
from pathlib import Path
import sqlite3
import unittest
import uuid
import recipes
from workflows import Workflows, EROS_BETA7

class SamplingSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config=json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))
        cls.w=Workflows(config['comfyRoot'])
    def settings(self,kind):
        s=copy.deepcopy(self.w.defaults()[kind]);s.update(positive='A ceramic bowl.',negative='blur',loras=[],width=64,height=96,seed='1',sound=False)
        return s
    def test_image_settings_reach_sampler_and_clip(self):
        s=self.settings('image');s.update(sampler='heun',clipSkip=3)
        g=self.w.build('image',s,'fixture')
        self.assertEqual(g['3']['inputs']['sampler_name'],'heun')
        self.assertEqual(g['18']['inputs']['stop_at_clip_layer'],-3)
        del s['sampler'];del s['clipSkip'];g=self.w.build('image',s,'fixture')
        self.assertEqual(g['3']['inputs']['sampler_name'],self.w.widgets('image',3)[4])
        self.assertEqual(g['18']['inputs']['stop_at_clip_layer'],self.w.widgets('image',18)[0])
        s['clipSkip']=0
        with self.assertRaises(ValueError):self.w.build('image',s,'fixture')
    def test_video_sampler_override_and_default_are_preserved(self):
        s=self.settings('video');s.update(model=EROS_BETA7,sampler='heun')
        self.assertEqual(self.w.build('video',s,'fixture')['10']['inputs']['sampler_name'],'heun')
        del s['sampler'];self.assertEqual(self.w.build('video',s,'fixture')['10']['inputs']['sampler_name'],'euler')
    def test_sampling_changes_invalidate_recorded_replay(self):
        with sqlite3.connect(':memory:') as db:
            db.row_factory=sqlite3.Row
            db.executescript('CREATE TABLE jobs(id,kind,settings);CREATE TABLE generation_graphs(job,graph);')
            job=str(uuid.uuid4());s=self.settings('image');g=self.w.build('image',s,'fixture')
            db.execute('INSERT INTO jobs VALUES(?,?,?)',(job,'image',json.dumps(s)))
            db.execute('INSERT INTO generation_graphs VALUES(?,?)',(job,json.dumps(g)))
            loaded=dict(s,replayOf=job)
            self.assertIsNotNone(recipes.graph_for_replay(db,'image',loaded,str(uuid.uuid4())))
            for change in [dict(sampler='heun'),dict(clipSkip=12)]:
                self.assertIsNone(recipes.graph_for_replay(db,'image',dict(loaded,**change),str(uuid.uuid4())))

if __name__=='__main__':unittest.main()
