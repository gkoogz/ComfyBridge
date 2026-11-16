import concurrent.futures
from email.utils import formatdate
import time
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from civitai_requests import Governor, Deferred, before
from civitai_browser import Browser
import test_civitai_browser as fixtures
from test_civitai_browser import image


class Clock:
    now=1000.
    def time(self):return self.now
    def sleep(self,n):self.now+=n


class PacingTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock();self.g=Governor(self.clock.time,self.clock.sleep)
    def test_background_reserves_foreground_and_total_is_bounded(self):
        for _ in range(20):self.g.acquire(True)
        with self.assertRaises(Deferred):self.g.acquire(True)
        for _ in range(40):self.g.acquire()
        with self.assertRaises(Deferred):self.g.acquire()
        self.clock.now+=61;self.g.acquire(True)
    def test_server_retry_after_and_exponential_backoff(self):
        self.g.failed(429,'120')
        with self.assertRaises(Deferred):self.g.acquire()
        self.clock.now+=121;self.g.acquire()
        self.g.failed(503,formatdate(self.clock.now+180,usegmt=True))
        self.assertGreaterEqual(self.g.until,self.clock.now+179)
        self.clock.now+=181;self.g.acquire();self.g.succeeded();self.g.failed(429)
        self.assertEqual(self.g.until,self.clock.now+5)
    def test_cdn_media_does_not_consume_api_budget(self):
        with patch('civitai_requests.governor',self.g):
            before('https://image.civitai.com/example')
            self.assertEqual(len(self.g.recent),0)
            before('https://civitai.red/api/trpc/image.getInfinite')
            self.assertEqual(len(self.g.recent),1)
    def test_server_cooldown_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'backoff.json';self.g.configure(path);self.g.failed(429,'120')
            restarted=Governor(self.clock.time,self.clock.sleep);restarted.configure(path)
            with self.assertRaises(Deferred):restarted.acquire()
            self.clock.now+=121;restarted.acquire()


class CacheTests(unittest.TestCase):
    setUp=fixtures.BrowseTests.setUp
    tearDown=fixtures.BrowseTests.tearDown
    act=fixtures.BrowseTests.act

def test_shared_details_and_follow_cache(self):
    self.b.account();self.b.collections('1','account-a');self.api.calls=[]
    for i in range(1,13):
        self.b.remember('1',image(i));self.b.detail(i,prefetch=True)
    self.assertEqual(len(self.api.calls),12)
    self.assertTrue(all(r=='image.getGenerationData' for r,_,_ in self.api.calls))
    for i in range(1,13):self.b.detail(i)
    self.assertEqual(sum(r=='user.getFollowingUsers' for r,_,_ in self.api.calls),1)
    self.assertEqual(sum(r=='image.getGenerationData' for r,_,_ in self.api.calls),12)
    self.assertFalse(any(r=='image.getInfinite' for r,_,_ in self.api.calls))
    restarted=Browser(self.tmp.name,self.models,None,self.api);restarted.account();self.api.calls=[]
    for i in range(1,13):restarted.detail(i)
    self.assertEqual(self.api.calls,[])

def test_concurrent_cache_miss_is_coalesced_and_writes_are_fresh(self):
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _:self.b.call('account-a','user.getFollowingUsers'),range(12)))
    self.assertEqual(sum(r=='user.getFollowingUsers' for r,_,_ in self.api.calls),1)
    self.b.action(self.act(kind='follow',creatorId=8,selected=True))
    self.assertIn(8,self.b.call('account-a','user.getFollowingUsers'))
    self.b.remember('1',image());self.b.detail(1)
    self.b.action(self.act(kind='collect',imageId=1,collectionId=4,selected=True))
    self.assertEqual(self.b.detail(1)['item']['collections'],[{'collectionId':4}])
    self.models.key='account-b';self.b.detail(1)
    self.assertEqual(sum(r=='image.getGenerationData' for r,_,_ in self.api.calls),2)

def test_multi_tag_budget_bulk_metadata_and_resume(self):
    original=self.b.transport;calls=[]
    def request(token,route,value,write,rest):
        if route!='image.getInfinite':return original(token,route,value,write,rest)
        calls.append(value)
        if value.get('ids'):
            return {'items':[image(i,tags=[{'id':12,'name':'ceramics'},{'id':13,'name':'blue'}] if i>400 else [{'id':12,'name':'ceramics'}]) for i in value['ids']]}
        start=int(value.get('cursor') or 0)
        items=[image(start+i) for i in range(1,201)]
        for item in items:item.pop('tags')
        return {'items':items,'nextCursor':str(start+200)}
    self.b.transport=request
    first=self.b.feed({'channel':'tags:12,13:all'})
    self.assertEqual(len(calls),3);self.assertTrue(first['limited']);self.assertFalse(first['items']);self.assertTrue(first['nextCursor'])
    restarted=Browser(self.tmp.name,self.models,None,request);calls.clear()
    second=restarted.feed({'channel':'tags:12,13:all','cursor':first['nextCursor']})
    self.assertLessEqual(len(calls),3);self.assertEqual(len(second['items']),12)
    self.assertTrue(all(int(i['id'])>400 for i in second['items']))
    self.assertTrue(all(restarted.matches_tags(i,[12,13]) for i in second['items']))
    calls.clear();third=restarted.feed({'channel':'tags:12,13:all','cursor':second['nextCursor']})
    self.assertEqual(calls,[]);self.assertEqual(len(third['items']),12)

CacheTests.test_shared_details_and_follow_cache=test_shared_details_and_follow_cache
CacheTests.test_concurrent_cache_miss_is_coalesced_and_writes_are_fresh=test_concurrent_cache_miss_is_coalesced_and_writes_are_fresh
CacheTests.test_multi_tag_budget_bulk_metadata_and_resume=test_multi_tag_budget_bulk_metadata_and_resume

def test_temporary_failure_preserves_partial_feed_and_cursor(self):
    original=self.b.transport;failing=[True]
    def request(token,route,value,write,rest):
        if route!='image.getInfinite':return original(token,route,value,write,rest)
        if not value.get('cursor'):return {'items':[image(i) for i in range(1,6)],'nextCursor':'page2'}
        if failing[0]:raise Deferred(5)
        return {'items':[image(i) for i in range(6,18)],'nextCursor':None}
    self.b.transport=request
    first=self.b.feed({'channel':'tag:12:all'})
    self.assertEqual(len(first['items']),5);self.assertGreater(first['retryAfter'],0);self.assertTrue(first['nextCursor'])
    failing[0]=False
    second=self.b.feed({'channel':'tag:12:all','cursor':first['nextCursor']})
    self.assertEqual([i['id'] for i in second['items']],[str(i) for i in range(6,18)])
CacheTests.test_temporary_failure_preserves_partial_feed_and_cursor=test_temporary_failure_preserves_partial_feed_and_cursor

if __name__=='__main__':unittest.main()
