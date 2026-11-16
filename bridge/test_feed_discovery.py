import random
import time
import tempfile
import unittest
from unittest.mock import patch
from test_civitai_browser import Models, API, Browser, image
from civitai_requests import Deferred


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.models=Models();self.api=API();self.b=Browser(self.tmp.name,self.models,None,self.api)
        self.b.save('1','follows',[7,8])
        self.b.save('1','weight-overrides',{'tag:12':{'offset':10,'name':'Ceramics'},'tag:13':{'offset':5,'name':'Blue'}})
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite' and not value.get('imageId'):
                self.api.calls.append((route,value,write));self.api.serial+=200
                # A heavily overrepresented creator, followed by a diverse tail.
                creators=[7]*80+list(range(20,60))*3
                return {'items':[image(self.api.serial+i,creator=value.get('userId',creator),
                    tags=[{'id':12,'name':'Ceramics'},{'id':13,'name':'Blue'}]) for i,creator in enumerate(creators)],'nextCursor':self.api.serial}
            return original(token,route,value,write,rest)
        self.b.transport=request

    def tearDown(self):self.tmp.cleanup()

    def test_discovery_is_tag_heavy_and_artist_spacing_survives_refresh_restart(self):
        sequence=[];kinds=[];cursor=None
        with patch('civitai_browser.random',random.Random(50)):
            for n in range(5):
                if n==2:self.b=Browser(self.tmp.name,self.models,None,self.b.transport)
                r=self.b.feed({'channel':'mix','cursor':cursor} if n!=3 else {'channel':'mix','refresh':True})
                self.assertLessEqual(r['sourceReads'],3)
                self.assertGreaterEqual(len(r['items']),8)
                for item in r['items']:
                    self.assertNotIn(item['creatorId'],sequence[-9:]);sequence.append(item['creatorId']);kinds.append(item['chosenBy'].get('kind'))
                cursor=r['nextCursor']
        self.assertGreaterEqual(kinds.count('tags')/len(kinds),.65)
        self.assertLessEqual(kinds.count('lora')/len(kinds),.2)

    def test_lora_cause_is_explicit_and_is_not_a_generation_resource(self):
        self.b.save('1','weight-overrides',{});self.b.save('1','follows',[])
        items=self.b.feed({'channel':'mix'})['items']
        self.assertTrue(items)
        for item in items:
            self.assertEqual(item['chosenBy']['kind'],'lora')
            self.assertIn(item['chosenBy']['id'],['101','102','103'])
            self.assertTrue(item['chosenBy']['name'].startswith('LoRA '))
            self.assertEqual(item['resources'],[])

    def test_throttled_candidates_are_retained_and_explicit_artist_feed_is_unrestricted(self):
        r=self.b.feed({'channel':'mix'})
        buffers=self.b.feeds[r['nextCursor']]['sources']
        self.assertTrue(any(i['creatorId']=='7' for s in buffers.values() for i in s['items']))
        direct=self.b.feed({'channel':'creator:7:all'})['items']
        self.assertEqual(len(direct),12);self.assertTrue(all(i['creatorId']=='7' for i in direct))

    def test_public_curations_are_bounded_private_safe_cached_and_follow_scoped(self):
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='collection.getInfinite':
                self.api.calls.append((route,value,write));uid=value['userId']
                return {'items':[
                    dict(id=81,name='Public pottery',read='Public',type='Image',userId=uid,user={'username':'Curator'}),
                    dict(id=82,name='Private',read='Private',type='Image',userId=uid,user={'username':'Curator'}),
                    dict(id=83,name='Wrong owner',read='Public',type='Image',userId=99,user={'username':'Other'})]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        items,reads=self.b.public_curations('1','account-a',[7,8])
        self.assertEqual(reads,1);self.assertEqual([c['id'] for c in items],[81])
        self.assertEqual(self.b.public_curations('1','account-a',[7,8])[1],0)
        result=self.b.feed({'channel':'mix'})
        via=[i for i in result['items'] if i['chosenBy'].get('kind')=='curation']
        self.assertTrue(via);self.assertEqual(via[0]['chosenBy']['via'],{'id':'7','name':'Curator'})
        self.assertEqual(result['sourceReads'],3)
        self.assertEqual(len([c for c in self.api.calls if c[0]=='collection.getInfinite']),1)
        self.assertEqual(self.b.public_curations('1','account-a',[]),( [],0))
        self.assertEqual(self.b.setting('2','public-curations',{}),{})

    def test_optional_public_directory_failure_does_not_fail_feed_or_hammer_api(self):
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='collection.getInfinite':
                self.api.calls.append((route,value,write));raise ValueError('Unavailable')
            return original(token,route,value,write,rest)
        self.b.transport=request
        self.b.public_curations('1','account-a',[7,8])
        for _ in range(2):self.assertTrue(self.b.feed({'channel':'mix'})['items'])
        self.assertEqual(len([c for c in self.api.calls if c[0]=='collection.getInfinite']),1)


