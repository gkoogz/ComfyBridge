import io
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

import api_debug
from api_debug import Recorder,activate,report,WEEK
from civitai_browser import Browser
from civitai_requests import Deferred,background_work
from model_library import fetch
from test_civitai_browser import Models,image


class Clock:
    now=1000.
    def read(self):return self.now


class DebugTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.data=Path(self.tmp.name);self.clock=Clock()
    def recorder(self):
        activate(self.data,self.clock.now)
        return Recorder(self.data,self.clock.read,self.clock.read)
    def rows(self,recorder):
        with sqlite3.connect(recorder.path) as db:
            db.row_factory=sqlite3.Row
            return [dict(r) for r in db.execute('SELECT * FROM metrics')]
    def test_expiry_fixed_across_reenable_restart_and_inflight_work(self):
        recorder=self.recorder();original=activate(self.data,self.clock.now)
        self.clock.now+=100
        self.assertEqual(activate(self.data,self.clock.now),original)
        restarted=Recorder(self.data,self.clock.read,self.clock.read)
        self.assertEqual(restarted.expires,original['expires'])
        ticket=restarted.begin();self.clock.now=original['expires']
        before=restarted.path.read_bytes()
        with patch('api_debug.sqlite3.connect',side_effect=AssertionError('No DB work after expiry')):
            restarted.finish(ticket,'network','me')
            self.assertIsNone(restarted.begin())
            dead=Recorder(self.data,self.clock.read,self.clock.read)
            self.assertFalse(dead.enabled)
        self.assertEqual(restarted.path.read_bytes(),before)
        with patch.object(restarted,'clock',side_effect=AssertionError('Expired fast path must not read clock')):
            for _ in range(100):restarted.begin();restarted.finish(ticket,'network','me')
    def test_disabled_missing_invalid_or_excessive_window_creates_no_files(self):
        self.assertFalse(Recorder(self.data).enabled)
        self.assertFalse((self.data/'api-debug').exists())
        value=activate(self.data,self.clock.now);value['expires']+=1
        (self.data/api_debug.CONFIG).write_text(json.dumps(value))
        self.assertFalse(Recorder(self.data,self.clock.read,self.clock.read).enabled)
        self.assertFalse((self.data/'api-debug').exists())
    def test_aggregation_redaction_failure_and_report_are_read_only(self):
        recorder=self.recorder();ticket=recorder.begin();self.clock.now+=.25
        recorder.finish(ticket,'network','image.getInfinite','http_200',wait_ms=100,byte_count=2048,items=100)
        recorder.finish(recorder.begin(),'cache','image.getInfinite','hit')
        recorder.finish(recorder.begin(),'network','SECRET/token?prompt=PRIVATE','my-secret-error')
        rows=self.rows(recorder)
        self.assertEqual(sum(r['count'] for r in rows),3)
        network=next(r for r in rows if r['operation']=='image.getInfinite' and r['kind']=='network')
        self.assertEqual(network['items'],100);self.assertEqual(network['wait_ms'],100)
        self.assertEqual(network['band'],1);self.assertEqual(network['total_ms'],250)
        self.assertNotIn(b'SECRET',recorder.path.read_bytes());self.assertNotIn(b'PRIVATE',recorder.path.read_bytes())
        before=recorder.path.read_bytes();result=report(self.data)
        self.assertEqual(result['status'],'expired');self.assertEqual(len(result['operations']),3)
        self.assertEqual(recorder.path.read_bytes(),before)
        with patch('api_debug.sqlite3.connect',side_effect=sqlite3.OperationalError('disk full')):
            recorder.finish(recorder.begin(),'network','me')
        self.assertFalse(recorder.enabled)
    def test_lock_contention_drops_diagnostics_instead_of_delaying_request(self):
        recorder=self.recorder();recorder.lock.acquire()
        try:recorder.finish(recorder.begin(),'network','me')
        finally:recorder.lock.release()
        self.assertEqual(recorder.dropped,1)
        recorder.finish(recorder.begin(),'network','me')
        self.assertEqual(report(self.data)['dropped'],1)
        with patch('api_debug.sqlite3.connect',side_effect=sqlite3.OperationalError('database is locked')):
            recorder.finish(recorder.begin(),'network','me')
        self.assertTrue(recorder.enabled);self.assertEqual(recorder.dropped,1)
    def test_connections_close_immediately_and_live_clock_rollback_cannot_extend_window(self):
        connections=[];queries=[];connect=sqlite3.connect;mono=Clock()
        def opened(*args,**kw):
            connection=connect(*args,**kw);connection.set_trace_callback(queries.append);connections.append(connection);return connection
        activate(self.data,self.clock.now)
        with patch('api_debug.sqlite3.connect',side_effect=opened):
            recorder=Recorder(self.data,self.clock.read,mono.read)
            recorder.finish(recorder.begin(),'network','me')
            report(self.data)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):connection.execute('SELECT 1')
        self.assertEqual(queries.count('PRAGMA max_page_count=4096'),2)
        self.clock.now-=100;mono.now+=WEEK
        self.assertIsNone(recorder.begin());self.assertFalse(recorder.enabled)
    def test_network_cache_budget_and_catalogue_instrumentation(self):
        activate(self.data);recorder=Recorder(self.data)
        browser=Browser(self.data,Models(),None,transport=lambda *a:None);browser.transport=None
        body=json.dumps({'result':{'data':{'json':{'items':[image()]}}}}).encode()
        class Response(io.BytesIO):status=200
        class Opener:
            def open(self,*args,**kw):return Response(body)
        with patch('api_debug.recorder',recorder),patch('civitai_browser.before'),patch('civitai_browser.urllib.request.build_opener',return_value=Opener()):
            with background_work():
                browser.call('SECRET','image.getInfinite',{'limit':1,'private':'PRIVATE'})
                browser.call('SECRET','image.getInfinite',{'limit':1,'private':'PRIVATE'})
            with patch('civitai_browser.before',side_effect=Deferred(20,'total_limit')):
                with self.assertRaises(Deferred):browser.call('SECRET','user.getCreator',{'id':7})
            with patch('civitai_requests.before'):
                self.assertEqual(fetch('https://civitai.red/api/v1/models/999?token=SECRET',token='SECRET'),body)
                # CDN traffic must not be counted as an API call.
                fetch('https://image.civitai.com/example.png')
        rows=self.rows(recorder)
        self.assertEqual(sum(r['count'] for r in rows if r['kind']=='network'),2)
        self.assertEqual(sum(r['count'] for r in rows if r['kind']=='cache' and r['outcome']=='hit'),1)
        self.assertTrue(any(r['kind']=='budget' and r['outcome']=='total_limit' for r in rows))
        self.assertTrue(any(r['operation']=='image.getInfinite' and r['background']==1 for r in rows))
        self.assertNotIn(b'SECRET',recorder.path.read_bytes());self.assertNotIn(b'PRIVATE',recorder.path.read_bytes())
    def test_http429_and_feed_yield_remain_correct(self):
        activate(self.data);recorder=Recorder(self.data)
        browser=Browser(self.data,Models(),None,transport=lambda *a:None);browser.transport=None
        class Opener:
            def open(self,*a,**kw):raise urllib.error.HTTPError('https://example.test',429,'secret body',{},None)
        with patch('api_debug.recorder',recorder),patch('civitai_browser.before'),patch('civitai_browser.governor.failed'),patch('civitai_browser.urllib.request.build_opener',return_value=Opener()):
            with self.assertRaises(Deferred):browser.call('SECRET','me')
            expected=dict(items=[{}]*12,sourceReads=2,scanned=100,filtered=88,limited=True)
            with patch.object(browser,'_feed',return_value=expected):
                self.assertIs(browser.feed({'channel':'tags:12,13:all'}),expected)
        rows=self.rows(recorder)
        self.assertTrue(any(r['kind']=='network' and r['outcome']=='http_429' for r in rows))
        self.assertTrue(any(r['operation']=='feed.tags' and r['filtered']==88 and r['reads']==2 for r in rows))


if __name__=='__main__':unittest.main()
