import tempfile,time,unittest,uuid
from unittest.mock import patch
from civitai_browser import Browser
from test_civitai_browser import Models,API,image

class Remote(API):
    def __init__(self):super().__init__();self.values={};self.memberships={};self.lost=False;self.during=None;self.offline=False;self.partial=False
    def __call__(self,token,route,value,write,rest):
        if self.offline and route!='me':raise OSError('Offline')
        if route=='reaction.getMyImageReactions':
            self.calls.append((route,value,write));return {str(i):list(self.values.get(str(i),set())) for i in value['imageIds']}
        if route=='reaction.toggle':
            self.calls.append((route,value,write));values=self.values.setdefault(str(value['entityId']),set());r=value['reaction']
            values.remove(r) if r in values else values.add(r)
            if self.during:fn=self.during;self.during=None;fn()
            if self.lost:self.lost=False;raise OSError('Response lost after remote commit')
            return {}
        if route=='collection.bulkSaveItems':
            self.calls.append((route,value,write));ids=value['imageIds'][:1] if self.partial else value['imageIds']
            for i in ids:self.memberships.setdefault(str(i),set()).add(value['collectionId'])
            return {'count':len(ids)}
        if route=='collection.saveItem':
            self.calls.append((route,value,write));members=self.memberships.setdefault(str(value['imageId']),set())
            members.update(c['collectionId'] for c in value['collections']);members.difference_update(value.get('removeFromCollectionIds',[]));return {}
        if route=='collection.getUserCollectionItemsByItem':
            self.calls.append((route,value,write));return [{'collectionId':i} for i in self.memberships.get(str(value['imageId']),set())]
        return super().__call__(token,route,value,write,rest)

class Quiet:
    last_foreground=0
    idle=60
    def quiet_for(self):return self.idle

class SocialTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.api=Remote();self.b=Browser(self.tmp.name,Models(),None,self.api)
        self.b.account();self.b.collections('1','account-a');self.now=10000.;self.b.social.clock=lambda:self.now
        self.client=str(uuid.uuid4());self.seq=0;self.quiet=Quiet();self.mock=patch('social_outbox.governor',self.quiet);self.mock.start()
        for i in range(1,106):self.b.remember('1',image(i))
    def tearDown(self):self.mock.stop();self.tmp.cleanup()
    def queue(self,kind='reaction',selected=True,**kw):
        self.seq+=1;p=dict(kind=kind,account='1',selected=selected,imageId='1',reaction='Heart',clientId=self.client,clientSeq=self.seq,firstAt=self.now,requestId=str(uuid.uuid4()),**kw)
        self.b.social.enqueue(p);return p
    def sends(self,route):return [v for r,v,w in self.api.calls if r==route and w]
    def test_enqueue_never_calls_network_and_overlays_pending_reads(self):
        n=len(self.api.calls);self.queue();self.assertEqual(n,len(self.api.calls))
        self.assertIn('Heart',self.b.stored('1',1)['reactions'])
        self.b.remember('1',image());self.assertIn('Heart',self.b.stored('1',1)['reactions'])
        self.assertEqual(self.b.social.snapshot()['pending'],1)
    def test_quiet_minute_or_five_minute_deadline_and_edits_do_not_extend(self):
        self.queue();self.quiet.idle=59;self.b.social.flush();self.assertFalse(self.sends('reaction.toggle'))
        self.now+=290;self.queue(selected=False);self.now+=10;self.quiet.idle=0;self.b.social.flush()
        self.assertFalse(self.sends('reaction.toggle'),'Final false already matches remote, no toggle needed')
        self.assertEqual(self.b.social.snapshot()['pending'],0)
        self.queue();self.quiet.idle=60;self.b.social.flush();self.assertEqual(len(self.sends('reaction.toggle')),1)
    def test_restart_lost_response_reconciles_without_double_toggle(self):
        self.queue();self.api.lost=True;self.b.social.flush();self.assertEqual(self.b.social.snapshot()['pending'],1)
        self.assertEqual(len(self.sends('reaction.toggle')),1)
        self.b=Browser(self.tmp.name,Models(),None,self.api);self.b.social.clock=lambda:self.now;self.now+=60
        self.b.social.flush();self.assertEqual(len(self.sends('reaction.toggle')),1);self.assertEqual(self.b.social.snapshot()['pending'],0)
    def test_receipts_and_out_of_order_local_retries_cannot_restore_old_choice(self):
        a=self.queue();self.queue(selected=False);self.b.social.enqueue(a)
        old=dict(a,requestId=str(uuid.uuid4()));reply=self.b.social.enqueue(old);self.assertTrue(reply['superseded'])
        self.b.social.flush();self.assertFalse(self.sends('reaction.toggle'))
    def test_change_during_write_remains_pending_then_corrects_remote(self):
        self.queue();self.api.during=lambda:self.queue(selected=False);self.b.social.flush()
        self.assertEqual(self.b.social.snapshot()['pending'],1);self.assertNotIn('Heart',self.b.stored('1',1)['reactions'])
        self.b.social.flush();self.assertEqual(self.b.social.snapshot()['pending'],0);self.assertNotIn('Heart',self.api.values['1'])
    def test_bulk_adds_chunk_at_100_and_removals_group_by_image(self):
        for i in range(1,106):
            self.seq+=1;self.b.social.enqueue(dict(account='1',kind='collect',selected=True,imageId=str(i),collectionId='4',clientId=self.client,clientSeq=self.seq,requestId=str(uuid.uuid4()),firstAt=self.now))
        self.b.social.flush();self.assertEqual([len(v['imageIds']) for v in self.sends('collection.bulkSaveItems')],[100,5]);self.assertEqual(self.b.social.snapshot()['pending'],0)
        saved=self.b.setting('1','collections');saved['items'].append(dict(id=9,name='Blue',count=0));self.b.save('1','collections',saved)
        self.queue(kind='collect',selected=False,collectionId='4');self.queue(kind='collect',selected=False,collectionId='9');self.b.social.flush()
        self.assertEqual(len(self.sends('collection.saveItem')),1);self.assertEqual(set(self.sends('collection.saveItem')[0]['removeFromCollectionIds']),{4,9})
    def test_bulk_partial_success_does_not_claim_unsaved_items(self):
        self.queue(kind='collect',collectionId='4');self.seq+=1
        self.b.social.enqueue(dict(account='1',kind='collect',selected=True,imageId='2',collectionId='4',clientId=self.client,clientSeq=self.seq,requestId=str(uuid.uuid4()),firstAt=self.now))
        self.api.partial=True;self.b.social.flush();self.assertEqual(self.b.social.snapshot()['pending'],1)
    def test_reaction_reads_are_batched_and_follow_choices_overlay(self):
        self.queue();self.seq+=1;self.b.social.enqueue(dict(account='1',kind='reaction',reaction='Like',selected=True,imageId='2',clientId=self.client,clientSeq=self.seq,requestId=str(uuid.uuid4()),firstAt=self.now))
        self.queue(kind='follow',creatorId='8');self.assertIn('8',self.b.setting('1','follows',[]))
        self.b.social.flush();reads=[v for r,v,w in self.api.calls if r=='reaction.getMyImageReactions'];self.assertEqual(len(reads),1);self.assertEqual(set(reads[0]['imageIds']),{1,2});self.assertIn(8,self.api.followed)
    def test_offline_keeps_choices_and_respects_retry_at(self):
        self.queue();self.api.offline=True;self.b.social.flush();row=self.b.social.rows('1',True)[0];self.assertGreater(row['retryAt'],self.now)
        self.api.offline=False;self.b.social.flush();self.assertFalse(self.sends('reaction.toggle'))
        self.now+=301;self.b.social.flush();self.assertEqual(self.b.social.snapshot()['pending'],0)
    def test_account_rotation_never_sends_previous_accounts_changes(self):
        self.queue();self.b.models.key='account-b';self.b.social.flush();self.assertFalse(self.sends('reaction.toggle'));self.assertEqual(len(self.b.social.rows('1',True)),1)

if __name__=='__main__':unittest.main()
