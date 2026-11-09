import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse

from PIL import Image
from model_library import Library
from model_gallery import Gallery


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.data=Path(self.temp.name)/'data';self.library=Library(Path(self.temp.name)/'comfy',self.data)
        self.id='a'*32;self.asset=dict(id=self.id,source='Civitai',sourceUrl='https://civitai.com/models/8',
                                     title='Ceramic Detail',kind='loras',name='ceramic.safetensors',versionId=7,modelId=8)
        self.put_asset();self.gallery=Gallery(self.library);self.addCleanup(self.gallery.resources.shutdown)
        image=io.BytesIO();Image.new('RGB',(120,240),'lightblue').save(image,format='PNG');self.image=image.getvalue()
        self.calls=[]

    def put_asset(self):
        with self.library.db() as db:db.execute('INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?,?,?)',
            (self.id,'loras','ceramic.safetensors','stamp','hash',0,json.dumps(self.asset)))

    def sample(self, id=1, level=1):
        return dict(id=id,url=f'https://image.civitai.com/{id}.png',width=120,height=240,browsingLevel=level,
                    meta=dict(prompt='A ceramic bowl on a wooden table.',negativePrompt='blur',seed=31,
                              civitaiResources=[dict(type='lora',modelVersionId=7,weight=.6)]))

    def fetch(self,url,limit=8*1024*1024,token=''):
        self.calls.append((url,token))
        if url.startswith('https://image.civitai.com/'):return self.image
        query=urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        self.assertEqual(query['withMeta'],['true']);self.assertEqual(query['modelVersionId'],['7'])
        cursor=query.get('cursor',[''])[0]
        return json.dumps(dict(items=[self.sample(2 if cursor else 1)],metadata=dict(nextCursor=None if cursor else 'feed:next|opaque'))).encode()

    def test_cursor_pages_include_prompt_loras_and_reuse_cached_metadata(self):
        with patch('model_gallery.fetch',side_effect=self.fetch):
            first=self.gallery.page(self.id);again=self.gallery.page(self.id)
            second=self.gallery.page(self.id,first['nextCursor'])
        self.assertEqual(first,again);self.assertEqual(len(self.calls),2)
        self.assertEqual(second['items'][0]['id'],'2');self.assertIsNone(second['nextCursor'])
        self.assertIn('ceramic bowl',first['items'][0]['prompt'])
        resource=first['items'][0]['resources'][0]
        self.assertEqual(resource['name'],'Ceramic Detail');self.assertEqual(resource['weight'],'0.6')
        self.assertEqual(first['items'][0]['imageUrl'],'https://civitai.com/images/1')
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(self.calls[1][0]).query)['cursor'],['feed:next|opaque'])

    def test_empty_page_retains_next_cursor_without_following_untrusted_next_url(self):
        raw=dict(items=[],metadata=dict(nextPage='https://example.test/inject?cursor=opaque%3A2'))
        with patch('model_gallery.fetch',return_value=json.dumps(raw).encode()):page=self.gallery.page(self.id)
        self.assertEqual(page['nextCursor'],'opaque:2');self.assertEqual(page['items'],[])
        with patch('model_gallery.fetch',side_effect=self.fetch):self.gallery.page(self.id,page['nextCursor'])
        self.assertTrue(self.calls[0][0].startswith('https://civitai.com/api/v1/images?'))

    def test_full_preview_preserves_aspect_ratio_is_lazy_and_cache_is_bounded(self):
        with patch('model_gallery.fetch',side_effect=self.fetch):
            self.gallery.page(self.id);self.assertFalse(list(self.gallery.files.iterdir()))
            file=self.gallery.preview(self.id,'1','full')
            with Image.open(file) as image:self.assertEqual(image.size,(120,240))
            count=len(self.calls);self.gallery.preview(self.id,'1','full');self.assertEqual(len(self.calls),count)
        old=self.gallery.files/'old.jpg';old.write_bytes(b'obsolete')
        with patch('model_gallery.CACHE_BYTES',1):self.gallery.trim_cache(file)
        self.assertFalse(old.exists());self.assertTrue(file.exists())

    def test_mature_mode_uses_existing_key_rule_and_clearing_blocks_cached_images(self):
        key='z'*32;(self.data/'civitai-api-key.txt').write_text(key)
        def fetch(url,limit=8*1024*1024,token=''):
            if url.startswith('https://image.civitai.com/'):
                self.assertFalse(token);return self.image
            self.assertTrue(url.startswith('https://civitai.red/api/v1/images?'));self.assertEqual(token,key)
            return json.dumps(dict(items=[self.sample(level=8)],metadata={})).encode()
        with patch('model_gallery.fetch',side_effect=fetch):
            page=self.gallery.page(self.id);self.gallery.preview(self.id,'1','thumb')
        self.assertFalse(page['nsfwHidden']);self.assertNotIn(key,json.dumps(page))
        (self.data/'civitai-api-key.txt').unlink()
        with self.assertRaises(FileNotFoundError):self.gallery.preview(self.id,'1','thumb')

    def test_offline_reuses_page_and_invalid_sources_never_download(self):
        with patch('model_gallery.fetch',side_effect=self.fetch):self.gallery.page(self.id)
        with patch('model_gallery.PAGE_TTL',0),patch('model_gallery.fetch',side_effect=OSError('Offline')):
            self.assertIn('cached',self.gallery.page(self.id)['note'])
        bad=self.sample();bad['url']='https://example.test/private'
        self.assertIsNone(self.gallery.sample(bad,self.asset,False))
        for identity,image,size in [('../bad','1','thumb'),(self.id,'../1','thumb'),(self.id,'1','../full')]:
            with self.assertRaises(ValueError):self.gallery.preview(identity,image,size)

    def test_replaced_model_invalidates_gallery_pages_and_previous_image(self):
        with patch('model_gallery.fetch',side_effect=self.fetch):self.gallery.page(self.id)
        self.asset['versionId']=9;self.put_asset()
        with self.assertRaises(FileNotFoundError):self.gallery.preview(self.id,'1','thumb')
        with patch('model_gallery.fetch',return_value=b'{"items":[],"metadata":{}}') as fetch:
            self.gallery.page(self.id);self.assertIn('modelVersionId=9',fetch.call_args.args[0])

    def test_resource_details_resolve_names_and_cache_them_without_loading_weights(self):
        raw=self.sample();raw['meta']['civitaiResources']=[dict(type='lora',modelVersionId=99,weight=.8)]
        with patch('model_gallery.fetch',return_value=json.dumps(dict(items=[raw],metadata={})).encode()):self.gallery.page(self.id)
        version=dict(id=99,modelId=42,model=dict(name='Watercolor finish',type='LORA'))
        with patch('model_gallery.fetch',return_value=json.dumps(version).encode()) as fetch:
            result=self.gallery.details(self.id,'1');again=self.gallery.details(self.id,'1')
        self.assertEqual(fetch.call_count,1);self.assertEqual(result,again)
        self.assertEqual(result['resources'][0]['name'],'Watercolor finish')
        self.assertEqual(result['resources'][0]['modelId'],'42');self.assertEqual(result['resources'][0]['weight'],'0.8')


if __name__=='__main__':unittest.main()
