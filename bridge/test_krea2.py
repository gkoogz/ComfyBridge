import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import image_models as im
from workflows import Workflows
from studio import prepare, settings_sync


class KreaTests(unittest.TestCase):
    def test_native_turbo_graph(self):
        s={**im.KREA_DEFAULTS,'steps':40,'cfg':8,'negative':'blur','clipSkip':2,
           'positive':'A glazed ceramic bowl on a wooden table.',
           'loras':[dict(name='krea2_style.safetensors',strength=.7),dict(name='disabled',enabled=False)]}
        wf=Workflows.__new__(Workflows)
        g=wf.build('image',s,'test/krea')
        self.assertEqual(g['3']['inputs']['steps'],8)
        self.assertEqual(g['3']['inputs']['cfg'],1)
        self.assertEqual(g['3']['inputs']['sampler_name'],'euler')
        self.assertEqual(g['3']['inputs']['scheduler'],'simple')
        self.assertEqual(g['18']['inputs']['type'],'krea2')
        self.assertEqual(g['19']['inputs']['vae_name'],im.KREA_VAE)
        self.assertEqual(g['7']['class_type'],'ConditioningZeroOut')
        self.assertEqual(g['100']['class_type'],'LoraLoaderModelOnly')
        self.assertNotIn('101',g)
        self.assertNotIn('CLIPSetLastLayer',[n['class_type'] for n in g.values()])
        self.assertEqual(s['steps'],40,'Graph building must not mutate caller settings')

    def test_homofidelis_uses_its_own_weights_and_shared_krea_components(self):
        wf=Workflows.__new__(Workflows)
        g=wf.build('image',{**im.KREA_DEFAULTS,'model':im.HOMOFIDELIS_BF16,'steps':32},'test/variant')
        self.assertEqual(g['4']['inputs']['unet_name'],im.HOMOFIDELIS_BF16)
        self.assertEqual(g['18']['inputs']['clip_name'],im.KREA_ENCODER)
        self.assertEqual(g['19']['inputs']['vae_name'],im.KREA_VAE)
        self.assertEqual(g['3']['inputs']['steps'],8)

    def test_image_and_mask_use_krea_vae(self):
        for mask in (None,'ComfyBridge/mask.png'):
            g=im.build({**im.KREA_DEFAULTS,'upload':'ComfyBridge/source.png','mask':mask,'denoise':.6},'test')
            self.assertEqual(g['43' if mask else '22']['inputs']['vae'],['19',0])
            self.assertEqual(g['3']['inputs']['denoise'],.6)

    def test_dimensions_and_embedding_validation(self):
        for change in ({'width':1025},{'width':4096},{'height':128},{'positive':'(embedding:sdxl:1.0)'}):
            with self.assertRaises(ValueError):im.build({**im.KREA_DEFAULTS,**change},'test')

    def test_metadata_family_precedes_misleading_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'models/loras';p.mkdir(parents=True)
            path=p/'krea2_named_but_wrong.safetensors'
            header=json.dumps({'__metadata__':{'ss_base_model_version':'sdxl_base_v1-0'}}).encode()
            path.write_bytes(len(header).to_bytes(8,'little')+header)
            self.assertEqual(im.resource_family(tmp,dict(kind='loras',name=path.name)),'sdxl')
            self.assertFalse(im.compatible('krea2','sdxl'))
            self.assertFalse(im.compatible('krea2',''))

    def test_dependencies_include_loader_type(self):
        obj={name:{} for name in ('UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','ConditioningZeroOut','EmptyLatentImage','KSampler','VAEDecode','SaveImage')}
        options={('UNETLoader','unet_name'):[im.KREA_MODEL],('CLIPLoader','clip_name'):[im.KREA_ENCODER],('CLIPLoader','type'):['sdxl'],('VAELoader','vae_name'):[im.KREA_VAE]}
        self.assertIn('krea2',im.profile(obj,lambda a,b:options[(a,b)])['missing'])
        options[('CLIPLoader','type')].append('krea2')
        self.assertEqual(im.profile(obj,lambda a,b:options[(a,b)])['missing'],[])

    def test_family_banks_survive_older_client_sync(self):
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE workspace(section TEXT PRIMARY KEY,stamp INTEGER,device TEXT,payload TEXT)')
        banks={'sdxl':{'settings':{'positive':'A bowl','loras':[{'name':'pottery'}]},'inputs':{}},'krea2':{'settings':im.KREA_DEFAULTS,'inputs':{}}}
        result=settings_sync(db,{'image':{'stamp':1,'value':{'settings':im.KREA_DEFAULTS,'inputs':{},'presets':[],'families':banks}}},'device')
        self.assertEqual(result['image']['value']['families'],banks)
        result=settings_sync(db,{'image':{'stamp':2,'value':{'settings':{'model':'sdxl'},'inputs':{},'presets':[]}}},'older')
        self.assertEqual(result['image']['value']['families'],banks)

if __name__=='__main__':unittest.main()
