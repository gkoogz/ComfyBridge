import tempfile
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from civitai_browser import Browser
from test_civitai_browser import API, Models, image


class CollectionCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.api=API();self.models=Models()
        self.b=Browser(self.tmp.name,self.models,None,self.api);self.b.account()
        self.b.collections('1','account-a');self.b.remember('1',image())

    def tearDown(self):self.tmp.cleanup()

    def action(self,**kw):return self.b.action(dict(account='1',requestId=str(uuid.uuid4()),**kw))

    def reads(self):return sum(r=='collection.getAllUser' for r,_,_ in self.api.calls)

    def test_hourly_limit_survives_restart_and_forced_refresh(self):
        before=self.reads();saved=self.b.setting('1','collections')
        saved['checked']=time.time()-3590;saved['attempted']=saved['checked'];self.b.save('1','collections',saved)
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        for _ in range(3):self.assertEqual(restarted.collections('1','account-a',True)[0]['id'],4)
        self.assertEqual(self.reads(),before)
        saved['checked']=saved['attempted']=time.time()-3601;self.b.save('1','collections',saved)
        self.b.invalidate('account-a','collection.getAllUser')
        with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(lambda _:self.b.collections('1','account-a'),range(4)))
        self.assertEqual(self.reads(),before+1)

    def test_failed_refresh_keeps_known_list_and_throttles_retry(self):
        saved=self.b.setting('1','collections');saved['checked']=saved['attempted']=time.time()-3601;self.b.save('1','collections',saved)
        with patch.object(self.b,'call',side_effect=ValueError('Temporary failure')) as call:
            for _ in range(3):self.assertEqual(self.b.collections('1','account-a',True),saved['items'])
            self.assertEqual(call.call_count,1)

    def test_collect_preserves_directory_and_confirmed_membership(self):
        before=self.reads();saved=self.b.setting('1','collections')
        self.b.memberships(1)
        self.action(kind='collect',imageId=1,collectionId=4,selected=True)
        self.assertEqual(self.b.setting('1','collections')['checked'],saved['checked'])
        self.assertEqual(self.b.collections('1','account-a')[0]['count'],3)
        self.assertEqual(self.b.memberships(1)['collections'],[{'collectionId':4}])
        self.assertEqual(self.reads(),before)
        self.action(kind='collect',imageId=1,collectionId=4,selected=False)
        self.assertEqual(self.b.collections('1','account-a')[0]['count'],2)

    def test_creation_merges_response_without_directory_or_count_reads(self):
        original=self.b.transport
        self.b.transport=lambda token,route,value,write,rest:dict(id=99,name=value['name']) if route=='collection.upsert' else original(token,route,value,write,rest)
        before=len(self.api.calls);result=self.action(kind='create',name='New ceramics')
        self.assertEqual([c['id'] for c in result['collections']],[4,99])
        self.assertFalse(any(r.startswith('collection.get') or r=='user.getBookmarkCollections' for r,_,_ in self.api.calls[before:]))
        self.assertEqual(self.b.collections('1','account-a')[-1]['name'],'New ceramics')

    def test_membership_only_lookup_is_cached_and_account_scoped(self):
        before=len(self.api.calls);self.b.memberships(1);self.b.memberships(1)
        self.assertEqual([r for r,_,_ in self.api.calls[before:]],['collection.getUserCollectionItemsByItem'])
        self.models.key='account-b'
        with self.assertRaises(ValueError):self.b.memberships(1)

    def test_detail_does_not_refresh_expired_directory(self):
        saved=self.b.setting('1','collections');saved['checked']=saved['attempted']=time.time()-3601;self.b.save('1','collections',saved)
        before=self.reads();result=self.b.detail(1)
        self.assertEqual(result['collections'],saved['items']);self.assertEqual(self.reads(),before)


if __name__=='__main__':unittest.main()
