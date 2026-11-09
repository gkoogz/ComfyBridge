import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from PIL import Image
from model_library import CivitaiRedirect, Library, plain, request_for, safe_preview


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'comfy';self.data=Path(self.temp.name)/'data'
        self.file=self.root/'models/loras'/'neutral.safetensors';self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b'neutral fixture weights')
        self.sha=hashlib.sha256(self.file.read_bytes()).hexdigest();self.library=Library(self.root,self.data)
        image=io.BytesIO();Image.new('RGB',(48,64),'lightblue').save(image,format='PNG');self.image=image.getvalue();self.calls=[];self.auth=[]
    def fetch(self,url,limit=8*1024*1024,token=''):
        self.calls.append(url);self.auth.append((url,token))
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
        self.assertTrue(safe_preview({'type':'image','browsingLevel':16,'nsfw':True}, mature=True))
        self.assertFalse(safe_preview({'type':'video','browsingLevel':16}, mature=True))
        self.assertEqual(plain('<p>Text</p><style>hidden</style><script>bad()</script>'),'Text')
        key='c'*32;req=request_for('https://civitai.red/api/v1/images?browsingLevel=31', key)
        self.assertEqual(req.get_header('Authorization'),'Bearer '+key);self.assertNotIn(key, req.full_url)
        self.assertIsNone(request_for('https://image.civitai.com/preview.png', key).get_header('Authorization'))

    def test_metadata_variant_requires_verified_tensor_hash(self):
        import struct
        header=json.dumps({'__metadata__':{'sshs_model_hash':'not trusted by itself'}}).encode()
        body=b'neutral tensor payload';tensor=hashlib.sha256(body).hexdigest()
        self.file.write_bytes(struct.pack('<Q',len(header))+header+body)
        def fetch(url,limit=8*1024*1024,token=''):
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

    def listing(self, images, extra=None):
        def fetch(url, limit=8*1024*1024, token=''):
            self.auth.append((url, token))
            if '/by-hash/' in url:return json.dumps(dict(id=7,modelId=8,name='Version 2',baseModel='SDXL',files=[dict(hashes={'SHA256':self.sha},metadata={})],images=images)).encode()
            if '/models/8' in url:return json.dumps(dict(name='Neutral pottery style',creator={'username':'Artist'},description='Ceramics.')).encode()
            if '/images?' in url:return json.dumps(dict(items=extra or [])).encode()
            if url.startswith('https://image.civitai.com/'):return self.image
            raise AssertionError(url)
        return fetch
    def test_without_a_key_nsfw_previews_stay_hidden(self):
        images=[dict(url='https://image.civitai.com/mature.png',type='image',nsfw=True,browsingLevel=8),dict(url='https://image.civitai.com/safe.png',type='image',nsfwLevel=1,browsingLevel=1)]
        with patch('model_library.fetch',side_effect=self.listing(images)):self.library.scan()
        item=self.library.snapshot()['items'][0]
        self.assertTrue(self.library.snapshot()['nsfwHidden'])
        self.assertEqual([image['source'] for image in item['images']],['https://image.civitai.com/safe.png'])
        self.assertTrue(any('civitai.com/api/v1/images?' in url and 'browsingLevel=1' in url and token=='' for url,token in self.auth))
        self.assertFalse(any('civitai.red' in url for url,_token in self.auth))
        only=[dict(url='https://image.civitai.com/mature.png',type='image',nsfw=True,browsingLevel=16)]
        with patch('model_library.fetch',side_effect=self.listing(only)):self.library.scan(force=True)
        hidden=self.library.snapshot()['items'][0]
        self.assertEqual(hidden['images'],[]);self.assertIn('NSFW previews stay hidden',hidden['previewNote'])
    def test_saved_key_requests_mature_previews_and_refreshes_immediately(self):
        with patch('model_library.fetch',side_effect=self.fetch):self.library.scan()
        self.auth.clear();key='d'*32;(self.data/'civitai-api-key.txt').write_text(key+'\n',encoding='utf-8')
        images=[dict(url='https://image.civitai.com/safe.png',type='image',browsingLevel=1),dict(url='https://image.civitai.com/mature.png',type='image',nsfw=True,browsingLevel=8)]
        extra=[dict(url='https://image.civitai.com/mature.png',type='image',nsfw=True,browsingLevel=8)]
        with patch('model_library.fetch',side_effect=self.listing(images, extra)):self.library.scan()
        item=self.library.snapshot()['items'][0]
        self.assertFalse(self.library.snapshot()['nsfwHidden'])
        self.assertEqual(item['images'][0]['source'],'https://image.civitai.com/mature.png')
        self.assertTrue(any(url.startswith('https://civitai.red/api/v1/images?') and 'browsingLevel=31' in url and token==key for url,token in self.auth))
        self.assertTrue(all(token=='' for url,token in self.auth if url.startswith('https://image.civitai.com/')))
        self.assertFalse(self.library.preview_auth_changed())
        self.auth.clear();(self.data/'civitai-api-key.txt').write_text('not-a-key',encoding='utf-8')
        self.assertTrue(self.library.snapshot()['nsfwHidden']);self.assertTrue(self.library.preview_auth_changed())
    def test_rejected_key_warns_and_stays_out_of_the_catalogue(self):
        key='e'*32;(self.data/'civitai-api-key.txt').write_text(key,encoding='utf-8')
        def fetch(url,limit=8*1024*1024,token=''):
            self.auth.append((url,token))
            if '/images?' in url:
                if key in url:raise AssertionError('API key leaked into a URL')
                raise urllib.error.HTTPError(url,401,'Unauthorized',{},None)
            if '/by-hash/' in url:return json.dumps(dict(id=7,modelId=8,name='v',files=[dict(hashes={'SHA256':self.sha})],images=[dict(url='https://image.civitai.com/safe.png',browsingLevel=1,type='image')])).encode()
            if '/models/8' in url:return b'{"name":"Neutral pottery style","creator":{}}'
            if url.startswith('https://image.civitai.com/'):return self.image
            raise AssertionError(url)
        with patch('model_library.fetch',side_effect=fetch):self.library.scan()
        item=self.library.snapshot()['items'][0]
        self.assertIn('rejected',item['previewWarning'].lower())
        self.assertEqual(item['images'][0]['source'],'https://image.civitai.com/safe.png')
        self.assertNotIn(key,json.dumps(self.library.snapshot()))

    def test_key_clearing_immediately_hides_cached_mature_previews_even_offline(self):
        key='f'*32;keyfile=self.data/'civitai-api-key.txt';keyfile.write_text(key)
        images=[dict(url='https://image.civitai.com/mature.png',browsingLevel=8),
                dict(url='https://image.civitai.com/safe.png',browsingLevel=1)]
        with patch('model_library.fetch',side_effect=self.listing(images)):
            self.library.scan()
        item=self.library.snapshot()['items'][0];identity=item['id']
        self.assertEqual(len(item['images']),2)
        self.assertTrue(self.library.preview(identity,0).is_file())
        keyfile.unlink()
        with self.assertRaises(FileNotFoundError):self.library.preview(identity,0)
        self.assertTrue(self.library.preview(identity,1).is_file())
        with patch('model_library.fetch',side_effect=OSError('Offline')):self.library.scan()
        snapshot=self.library.snapshot();self.assertTrue(snapshot['nsfwHidden'])
        self.assertEqual([i['source'] for i in snapshot['items'][0]['images']],['https://image.civitai.com/safe.png'])
        with self.assertRaises(FileNotFoundError):self.library.preview(identity,0)

    def test_api_key_is_removed_on_redirects_outside_https_civitai_api(self):
        key='g'*32;req=request_for('https://civitai.red/api/v1/images',key)
        redirect=CivitaiRedirect()
        for url in ['https://example.test/api/v1/images','https://image.civitai.com/image.png',
                    'http://civitai.red/api/v1/images','https://civitai.red:8443/api/v1/images',
                    'https://civitai.red/not-api']:
            self.assertIsNone(request_for(url,key).get_header('Authorization'))
            self.assertIsNone(redirect.redirect_request(req,None,302,'Found',{},url).get_header('Authorization'))
        kept=redirect.redirect_request(req,None,302,'Found',{},'https://civitai.com/api/v1/images')
        self.assertEqual(kept.get_header('Authorization'),'Bearer '+key)


if __name__=='__main__':unittest.main()
