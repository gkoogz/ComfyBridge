import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from PIL import Image
from model_library import Library, plain, safe_preview


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'comfy';self.data=Path(self.temp.name)/'data'
        self.file=self.root/'models/loras'/'neutral.safetensors';self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b'neutral fixture weights')
        self.sha=hashlib.sha256(self.file.read_bytes()).hexdigest();self.library=Library(self.root,self.data)
        image=io.BytesIO();Image.new('RGB',(48,64),'lightblue').save(image,format='PNG');self.image=image.getvalue();self.calls=[]
    def fetch(self,url,*args):
        self.calls.append(url)
        if '/by-hash/' in url:return json.dumps(dict(id=7,modelId=8,name='Version 2',baseModel='SDXL',trainedWords=['ceramic bowl'],files=[dict(hashes={'SHA256':self.sha},metadata={'format':'SafeTensor'})],images=[dict(url='https://image.civitai.com/safe.png',nsfwLevel=1)])).encode()
        if '/models/8' in url:return json.dumps(dict(name='Neutral pottery style',creator={'username':'Artist'},description='<p>Detailed ceramics.</p><script>bad()</script>')).encode()
        if '/images?' in url:return b'{"items":[]}'
        if url=='https://image.civitai.com/safe.png':return self.image
        raise AssertionError(url)
    def test_verified_listing_and_cached_preview(self):
        with patch('model_library.fetch',side_effect=self.fetch):self.library.scan()
        result=self.library.snapshot()['items'][0]
        self.assertEqual(result['title'],'Neutral pottery style');self.assertEqual(result['keywords'],['ceramic bowl'])
        self.assertEqual(result['match'],'Exact SHA-256 file match');self.assertNotIn('bad()',result['description'])
        self.assertTrue(self.library.preview(result['id'],0).is_file())
        with patch('model_library.fetch',side_effect=AssertionError('Unchanged cache must not use network')):self.library.scan(force=False)
        for bad in ('../file','g'*32,''):
            with self.assertRaises(ValueError):self.library.preview(bad,0)
        with self.assertRaises(ValueError):self.library.preview(result['id'],'../0')
    def test_changed_file_invalidates_match_and_missing_file_removed(self):
        with patch('model_library.fetch',side_effect=self.fetch):self.library.scan()
        self.file.write_bytes(b'changed neutral weights');self.library.last=0
        with patch('model_library.fetch',side_effect=self.fetch):self.library.scan()
        item=self.library.snapshot()['items'][0]
        self.assertNotEqual(item['sha256'],self.sha);self.assertNotEqual(item['status'],'matched')
        self.file.unlink();self.library.last=0;self.library.scan();self.assertEqual(self.library.snapshot()['items'],[])
    def test_not_found_keeps_local_model_selectable(self):
        error=urllib.error.HTTPError('https://civitai.com',404,'Not found',{},None)
        with patch('model_library.fetch',side_effect=error):self.library.scan()
        item=self.library.snapshot()['items'][0];self.assertEqual(item['status'],'unmatched');self.assertEqual(item['name'],self.file.name)
    def test_failed_refresh_preserves_previously_verified_data(self):
        with patch('model_library.fetch',side_effect=self.fetch):self.library.scan()
        with patch('model_library.fetch',side_effect=OSError('Offline')):self.library.scan(force=True)
        item=self.library.snapshot()['items'][0];self.assertEqual(item['status'],'matched');self.assertEqual(len(item['images']),1);self.assertIn('cached',item['note'])
    def test_rating_forms_and_untrusted_html(self):
        for item in ({'nsfwLevel':1},{'nsfwLevel':'None','nsfw':False},{'browsingLevel':1}):self.assertTrue(safe_preview(item))
        for item in ({},{'nsfwLevel':4},{'nsfwLevel':'X'},{'nsfwLevel':1,'nsfw':True},{'browsingLevel':2},{'type':'video','nsfwLevel':1}):self.assertFalse(safe_preview(item))
        self.assertEqual(plain('<p>Text</p><style>hidden</style><script>bad()</script>'),'Text')

    def test_metadata_variant_requires_verified_tensor_hash(self):
        import struct
        header=json.dumps({'__metadata__':{'sshs_model_hash':'not trusted by itself'}}).encode()
        body=b'neutral tensor payload';tensor=hashlib.sha256(body).hexdigest()
        self.file.write_bytes(struct.pack('<Q',len(header))+header+body)
        def fetch(url,*args):
            if '/by-hash/' in url:
                if not url.endswith(tensor[:12]):raise urllib.error.HTTPError(url,404,'Missing',{},None)
                return json.dumps(dict(id=7,modelId=8,name='v2',files=[dict(hashes={'AutoV3':tensor[:12]})])).encode()
            if '/models/8' in url:return b'{"name":"Neutral Style"}'
            if '/images?' in url:return b'{"items":[]}'
            raise AssertionError(url)
        with patch('model_library.fetch',side_effect=fetch):self.library.scan()
        item=self.library.snapshot()['items'][0]
        self.assertEqual(item['status'],'matched');self.assertEqual(item['tensorHash'],tensor)
        self.assertIn('metadata differs',item['match'])


if __name__=='__main__':unittest.main()
