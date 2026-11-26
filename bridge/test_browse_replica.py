import tempfile
import unittest
import uuid
from browse_replica import sync
from civitai_browser import Browser
from test_civitai_browser import API, Models, image


class StandaloneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.models = Models()
        self.api = API()
        self.browser = Browser(self.tmp.name, self.models, None, self.api)
        self.browser.save('1','weight-overrides', {'tag:12':{'offset':10,'name':'Ceramics'}})
        self.browser.save('1','collections', {'items':[{'id':4,'name':'Ceramics'}]})

    def state(self):
        return next(i for i in sync(self.browser)['items'] if i['id']=='12')

    def edit(self, row, **values):
        return {'requestId':str(uuid.uuid4()),'kind':row['kind'],'id':row['id'],'name':row['name'],
                'changes':{k:{'base':row[k],'value':v,'revision':row['revisions'].get(k,'')} for k,v in values.items()}}

    def submit(self, *changes, account='1'):
        return sync(self.browser, {'account':account,'changes':list(changes)})

    def pc(self, **changes):
        return self.browser.action(dict(account='1',kind='preference',subject='tag',id=12,requestId=str(uuid.uuid4()),**changes))

    def test_lone_decrease_and_replay_after_restart(self):
        changed = self.edit(self.state(), offset=5)
        self.submit(changed)
        self.assertEqual(self.state()['weight'],5)
        self.browser = Browser(self.tmp.name, self.models, None, self.api)
        self.pc(delta=1)
        self.assertIn(changed['requestId'],self.submit(changed)['applied'])
        self.assertEqual(self.state()['weight'],6)

    def test_concurrent_weights_and_explicit_unweight(self):
        old = self.state()
        self.pc(delta=-1)
        self.submit(self.edit(old,offset=3))
        self.assertEqual(self.state()['weight'],9)
        old=self.state()
        self.pc(disabled=True)
        self.submit(self.edit(old,offset=17))
        self.assertEqual(self.state()['weight'],0)
        self.assertTrue(self.state()['disabled'])
        self.pc(disabled=False)
        self.assertEqual(self.state()['weight'],17)

    def test_ban_survives_stale_unban_and_later_observed_unban_works(self):
        self.pc(banned=True)
        old=self.state()
        self.pc(banned=False)
        self.pc(banned=True)
        self.submit(self.edit(old,banned=False,disabled=False))
        self.assertTrue(self.state()['banned'])
        self.submit(self.edit(self.state(),banned=False,disabled=False))
        self.assertFalse(self.state()['banned'])

    def test_automatic_zero_does_not_win_over_concurrent_higher_weight(self):
        change=self.edit(self.state(),offset=0,disabled=True)
        change['autoDisabled']=True
        self.pc(delta=1)
        self.submit(change)
        self.assertEqual(self.state()['weight'],11)

    def test_disconnect_reads_do_not_create_writes_and_pc_resolves_media(self):
        client=str(uuid.uuid4())
        action=dict(kind='reaction',imageId=123,selected=False,reaction='Like',account='1', standalone=True,baseRevision=0,
                    clientId=client,clientSeq=1,requestId=str(uuid.uuid4()))
        self.assertFalse(self.browser.stored('1',123))
        receipt=self.browser.social.enqueue(action)
        self.assertTrue(receipt['queued'])
        self.assertEqual(self.browser.social.enqueue(action),receipt)
        self.assertEqual(sum(r=='image.getInfinite' for r,_,_ in self.api.calls),1)
        self.assertFalse(any(write for _,_,write in self.api.calls))
        self.browser.social.send('1','account-a',self.browser.social.rows('1',True),True)
        self.assertEqual(self.api.reactions,[])
        self.assertEqual(sum(r=='reaction.toggle' for r,_,_ in self.api.calls),1)

    def test_pc_wins_conflicting_social_and_account_switch_parks_changes(self):
        self.browser.remember('1', image())
        choice=dict(kind='reaction',imageId=1,selected=True,reaction='Like',account='1',clientId=str(uuid.uuid4()),clientSeq=1,requestId=str(uuid.uuid4()))
        self.browser.social.enqueue(choice)
        queued=dict(choice,selected=False,standalone=True,baseRevision=0,clientId=str(uuid.uuid4()),requestId=str(uuid.uuid4()))
        self.assertTrue(self.browser.social.enqueue(queued)['superseded'])
        change=self.edit(self.state(),offset=23)
        self.models.key='account-b'
        with self.assertRaises(ValueError):self.submit(change)
        with self.assertRaises(ValueError):self.browser.social.enqueue(queued)
        self.models.key='account-a'
        self.submit(change)
        self.assertEqual(self.state()['offset'],23)
