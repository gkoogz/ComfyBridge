import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from civitai_browser import Browser
from feed_bank import FeedBank
from test_civitai_browser import Models, API, image


class BankTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.models=Models();self.api=API()
        self.b=Browser(self.tmp.name,self.models,None,self.api);self.b.account()
        self.b.bank.kick=lambda *args:None
        self.b.bank.warm_media=lambda *args:None

    def tearDown(self):self.tmp.cleanup()

    def items(self,count,start=1):
        return [self.b.public(self.b.remember('1',image(i,creator=20+(i%40)))) for i in range(start,start+count)]

    def seed(self,count=200):
        self.b.bank.write('1',dict(items=self.items(count),cursor='',filling=count<100,retryAt=0))

    def test_one_fifo_peek_does_not_consume_take_atomic_receipts_and_low_water(self):
        self.seed();first=self.b.bank.peek({});self.assertEqual(len(first['items']),25);self.assertEqual(first['bankCount'],200)
        with self.b.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM feed_exposure').fetchone()[0],0)
        one=self.b.feed(dict(channel='mix',bank=True,requestId='a'));self.assertEqual(len(one['items']),12)
        self.assertEqual(one,self.b.feed(dict(channel='mix',bank=True,requestId='a')))
        self.assertEqual(self.b.bank.read('1')['items'][0]['id'],'13')
        for n in range(3):self.b.bank.take({'requestId':str(n)})
        self.assertEqual(len(self.b.bank.read('1')['items']),152);self.assertFalse(self.b.bank.read('1')['filling'])
        self.b.bank.take({'requestId':'low'})
        self.assertEqual(len(self.b.bank.read('1')['items']),140);self.assertTrue(self.b.bank.read('1')['filling'])
        self.assertFalse(any(route=='image.getInfinite' for route,_,_ in self.api.calls))

    def test_refill_is_metadata_only_planning_survives_restart_without_exposure(self):
        serial=[1000]
        def transport(token,route,value,write,rest):
            if route=='image.getInfinite':
                serial[0]+=200
                return {'items':[image(serial[0]+i,creator=20+i%40) for i in range(200)],'nextCursor':serial[0]}
            return self.api(token,route,value,write,rest)
        self.b.transport=transport
        for _ in range(18):self.b.bank.replenish_once('1','account-a')
        state=self.b.bank.read('1');self.assertEqual(len(state['items']),200);self.assertFalse(state['filling'])
        with self.b.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM feed_exposure').fetchone()[0],0)
        restarted=Browser(self.tmp.name,self.models,None,transport);restarted.bank.kick=lambda *a:None
        self.assertEqual(len(restarted.bank.peek({})['items']),25)
        with restarted.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM feed_exposure').fetchone()[0],0)
        self.assertFalse((restarted.data/'media').exists())
        self.assertEqual(restarted.bank.take({})['items'][0]['id'],state['items'][0]['id'])

    def test_delivery_rechecks_seen_bans_timeout_zero_weight_and_spacing(self):
        self.seed(80)
        self.b.save('1','weight-overrides',{'creator:21':{'banned':True}})
        self.b.save('1','creator-timeouts',{'22':{'until':time.time()+100,'name':'Creator 22'}})
        result=self.b.bank.take({'seen':['3','4','5']})
        self.assertFalse(any(i['id'] in ('1','2','3','4','5') for i in result['items']))
        self.assertTrue(all(i['creatorId'] not in ('21','22') for i in result['items']))
        items=self.items(20,300)
        for i in items:i['chosenBy']={'kind':'tags','ids':['12','13']}
        self.b.bank.write('1',dict(items=items,cursor='',filling=False))
        self.assertEqual(self.b.bank.peek({})['items'],[])

    def test_take_does_not_wait_for_slow_selection_and_concurrent_clients_get_distinct_pages(self):
        self.seed(80);started=threading.Event();release=threading.Event()
        def blocked(*a,**kw):started.set();release.wait(5);return dict(items=[],nextCursor='fake')
        with patch.object(self.b,'_feed',blocked):
            planner=threading.Thread(target=self.b.bank.replenish_once,args=('1','account-a'));planner.start();self.assertTrue(started.wait(1))
            before=time.monotonic();a=self.b.bank.take({'requestId':'one'});b=self.b.bank.take({'requestId':'two'})
            self.assertLess(time.monotonic()-before,1);self.assertFalse({i['id'] for i in a['items']} & {i['id'] for i in b['items']})
            release.set();planner.join(5);self.assertFalse(planner.is_alive())

    def test_account_change_and_cached_identity_do_not_need_civitai_for_ready_bank(self):
        self.seed();restarted=Browser(self.tmp.name,self.models,None,self.api);restarted.bank.kick=lambda *a:None
        def offline(*a,**kw):raise AssertionError('A ready bank must not perform a network call')
        restarted.transport=offline;self.assertEqual(len(restarted.bank.take({})['items']),12)
        self.models.key='account-b';restarted.transport=self.api
        self.assertEqual(restarted.bank.peek({})['items'],[])
        self.assertEqual(len(restarted.bank.read('1')['items']),188)

    def test_corrupt_checkpoints_recover_without_losing_feed_preferences(self):
        self.b.save('1','weight-overrides',{'tag:12':{'banned':True,'name':'ceramics'}})
        with self.b.db() as db:
            db.execute("INSERT INTO settings VALUES('1','mix-progress','{bad')")
            db.execute("INSERT INTO feed_sessions VALUES('1','damaged','mix','{bad',?)",(time.time(),))
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        self.assertEqual(restarted.setting('1','mix-progress',{}),{})
        page=restarted._feed(dict(channel='mix',cursor='damaged'),planning=True)
        self.assertTrue(page['recovered'])
        self.assertEqual(restarted.bans('1'),[dict(kind='tag',id='12',name='ceramics')])
        with restarted.db() as db:
            count=db.execute("SELECT count(*) FROM feed_sessions WHERE id=? AND json_valid(payload)",(page['nextCursor'],)).fetchone()[0]
        self.assertEqual(count,1)

    def test_fresh_refill_precedes_old_reserve_but_preserves_prepared_head(self):
        self.seed(140);self.b.bank.peek({});before=self.b.bank.read('1')['items']
        fresh=self.items(12,500)
        with patch.object(self.b,'_feed',return_value=dict(items=fresh,nextCursor='new')):self.b.bank.replenish_once('1','account-a')
        ids=[i['id'] for i in self.b.bank.read('1')['items']]
        self.assertEqual(ids[:25],[i['id'] for i in before[:25]])
        self.assertTrue(any(i['id'] in ids[25:37] for i in fresh))
        self.assertTrue(self.b.bank.read('1')['filling'],'Refill stays active past 150 until target 200')

    def test_expiry_is_random_seven_to_fourteen_days_and_never_marks_viewed(self):
        self.seed(50);now=time.time();self.b.bank.peek({});state=self.b.bank.read('1')
        expires=[i['bankExpiresAt'] for i in state['items']]
        self.assertTrue(all(now+7*86400<=t<=time.time()+14*86400 for t in expires));self.assertGreater(len(set(expires)),40)
        expired=state['items'][0]['id'];state['items'][0]['bankExpiresAt']=now-1
        self.b.bank.write('1',state)
        session=dict(account='1',channel='mix',planning=True,seen=[expired],sources={})
        with self.b.db() as db:db.execute('INSERT INTO feed_sessions VALUES(?,?,?,?,?)',('1','planner','mix',json.dumps(session),now))
        self.b.bank.peek({})
        self.assertNotIn(expired,[i['id'] for i in self.b.bank.read('1')['items']])
        with self.b.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM feed_exposure WHERE image=?',(expired,)).fetchone()[0],0)
            saved=json.loads(db.execute('SELECT payload FROM feed_sessions WHERE id=?',('planner',)).fetchone()[0])
        self.assertNotIn(expired,saved['seen'])

    def test_pc_warms_only_twenty_five_originals_without_consuming_or_viewing(self):
        self.seed();calls=[]
        with patch.object(self.b,'media_file',side_effect=lambda account,image_id,size:calls.append((image_id,size))):
            with self.b.bank.lock:FeedBank.warm_media(self.b.bank,'1','account-a')
            until=time.monotonic()+3
            while self.b.bank.media_running and time.monotonic()<until:time.sleep(.01)
            self.assertFalse(self.b.bank.media_running)
        self.assertEqual(len([x for x in calls if x[1]=='full']),25)
        self.assertEqual({x[0] for x in calls},{str(i) for i in range(1,26)})
        self.assertEqual(len(self.b.bank.read('1')['items']),200)
        self.assertEqual(self.b.bank.read('1')['protected'],[str(i) for i in range(1,26)])
        with self.b.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM feed_exposure').fetchone()[0],0)


if __name__=='__main__':unittest.main()
