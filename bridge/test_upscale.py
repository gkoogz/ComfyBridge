import tempfile
import unittest
from pathlib import Path
from PIL import Image
from workflows import Workflows, REMACRI
from provenance import generation_type


class RemacriTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.wf=Workflows.__new__(Workflows)
        self.wf.root=self.root
        (self.root/'models/upscale_models').mkdir(parents=True)
        (self.root/'models/upscale_models'/REMACRI).touch()
        (self.root/'input/ComfyBridge').mkdir(parents=True)
        Image.new('RGB',(1024,1536)).save(self.root/'input/ComfyBridge/source.png')

    def settings(self):
        return dict(operation='remacri4x',upload='ComfyBridge/source.png',width=1,height=1,
                    mask='old-mask',loras=[{'name':'unused'}],positive='Do not sample',
                    seed='123',steps=30,sourceMedia='source-id',replayOf='old-job')

    def test_actual_dimensions_and_pure_tiled_graph(self):
        s=self.settings();self.wf.prepare_upscale('image',s)
        self.assertEqual((s['width'],s['height']),(4096,6144))
        self.assertEqual(s['sourceMedia'],'source-id')
        self.assertNotIn('mask',s);self.assertNotIn('replayOf',s)
        self.assertEqual(s['loras'],[])
        graph=self.wf.build('image',s,'ComfyBridge/test')
        self.assertEqual({n['class_type'] for n in graph.values()},
                         {'LoadImage','UpscaleModelLoader','ImageUpscaleWithModel','SaveImage'})
        self.assertEqual(graph['61']['inputs']['image'],['21',0])
        self.assertEqual(graph['9']['inputs']['images'],['61',0])
        self.assertIn('Remacri',generation_type('image',s))

    def test_reject_missing_model_and_source(self):
        s=self.settings();s['upload']='../outside.png'
        with self.assertRaisesRegex(ValueError,'starting image'):self.wf.prepare_upscale('image',s)
        (self.root/'models/upscale_models'/REMACRI).unlink()
        with self.assertRaisesRegex(ValueError,'not installed'):self.wf.prepare_upscale('image',self.settings())

    def test_reject_output_too_large(self):
        Image.new('RGB',(2048,2048)).save(self.root/'input/ComfyBridge/source.png')
        with self.assertRaisesRegex(ValueError,'40 megapixels'):self.wf.prepare_upscale('image',self.settings())

    def test_reject_wrong_operation_and_video(self):
        with self.assertRaises(ValueError):self.wf.prepare_upscale('video',self.settings())
        s=self.settings();s['operation']='other'
        with self.assertRaises(ValueError):self.wf.build('image',s,'test')

if __name__=='__main__':unittest.main()
