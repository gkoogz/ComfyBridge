import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from civitai_browser import Browser, cdn


class Models:
    key='account-a'
    def token(self):return self.key
    def snapshot(self):return {'items':[dict(kind='loras',versionId=i,id=str(i),title='LoRA '+str(i)) for i in (101,102,103)]}


def image(i=1,creator=7,tags=None):
    return dict(id=i,url='06c1e11a-6a5b-465c-b014-2e22104488f6',width=400,height=800,type='image',
        user={'id':creator,'username':'Potter','image':'06c1e11a-6a5b-465c-b014-2e22104488f6'},
        tags=tags or [{'id':12,'name':'ceramics'}],reactions=[{'reaction':'Like'}],meta={'prompt':'A ceramic vase.'})


class API:
    def __init__(self):self.calls=[];self.reactions=['Like'];self.followed=[7];self.members=[];self.serial=1000;self.fail=False
    def __call__(self,token,route,value,write,rest):
        self.calls.append((route,value,write))
        if route=='me':return dict(id=1 if token=='account-a' else 2,username='Example')
        if route=='collection.getAllUser':return [dict(id=4,name='Ceramics',type='Image',isOwner=True),dict(id=5,name='Models',type='Model',isOwner=True),dict(id=6,name='Someone else',type='Image',isOwner=False)]
        if route=='user.getBookmarkCollections':return [{'id':4,'type':'Image'}]
        if route=='collection.getEntryCount':return {'ACCEPTED':2}
        if route=='user.getFollowingUsers':return self.followed
        if route=='user.toggleFollow':
            uid=value['targetUserId'];self.followed.remove(uid) if uid in self.followed else self.followed.append(uid);return {}
        if route=='reaction.getMyImageReactions':return {str(value['imageIds'][0]):[{'reaction':r} for r in self.reactions]}
        if route=='reaction.toggle':
            r=value['reaction'];self.reactions.remove(r) if r in self.reactions else self.reactions.append(r)
            if self.fail:self.fail=False;raise ValueError('Connection lost after submission')
            return {}
        if route=='collection.getUserCollectionItemsByItem':return self.members
        if route=='collection.saveItem':self.members=[{'collectionId':x['collectionId']} for x in value['collections']];return {}
        if route=='image.getResources':return [{'modelVersionId':20,'modelId':30,'modelName':'Ceramics','modelType':'LORA'}]
        if route=='tag.getVotableTags':return [{'id':12,'name':'ceramics','vote':1}]
        if route in ('tag.addTagVotes','collection.upsert'):return {}
        if route=='image.getInfinite':
            if value.get('imageId'):return {'items':[image(value['imageId'])]}
            if value.get('limit')==12:
                self.serial+=12
                return {'items':[image(self.serial+i) for i in range(12)],'nextCursor':None}
            self.serial+=1
            return {'items':[image(self.serial)],'nextCursor':None}
        raise AssertionError(route)


class BrowseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.models=Models();self.api=API();self.b=Browser(self.tmp.name,self.models,None,self.api)
    def tearDown(self):self.tmp.cleanup()
    def act(self,**kw):return dict(account='1',requestId=str(uuid.uuid4()),**kw)
    def test_account_isolation_and_key_rotation(self):
        self.b.remember('1',image());self.b.observe('1','reactions',self.b.stored('1',1),1,'1')
        self.assertIn('12',self.b.weights('1')['tags']);self.assertEqual(self.b.weights('2')['tags'],{})
        self.models.key='account-b';self.assertEqual(self.b.account()[0]['id'],'2')
        with self.assertRaisesRegex(ValueError,'account changed'):self.b.action(self.act(kind='follow',creatorId=8,selected=True))
        with self.assertRaises(FileNotFoundError):self.b.media_file('1','1','thumb')
    def test_normalization_and_resources(self):
        x=self.b.detail(1)['item'];self.assertEqual(x['prompt'],'A ceramic vase.');self.assertEqual(x['resources'][0]['name'],'Ceramics')
        self.assertNotIn('_urls',x);self.assertTrue(x['following']);self.assertIn('/1/1/',x['path'])
    def test_only_owned_media_collections_and_bookmark(self):
        cs=self.b.collections('1','account-a');self.assertEqual(len(cs),1);self.assertTrue(cs[0]['bookmark'])
    def test_observations_are_idempotent_and_removal_reverses(self):
        x=self.b.remember('1',image())
        for _ in range(4):self.b.observe('1','reactions',x,1,'1')
        self.b.observe('1','collection:4',x,1,'1');self.assertEqual(self.b.weights('1')['tags']['12'],2)
        self.b.observe('1','reactions',x,0,'2');self.assertEqual(self.b.weights('1')['tags']['12'],1)
    def test_import_resumes_and_does_not_inflate(self):
        self.b.leases['1']=time.monotonic()+20;self.b.running.add('1');self.b.import_loop('1','account-a')
        self.assertTrue(self.b.setting('1','import')['complete']);weights=self.b.weights('1')
        self.b.import_loop('1','account-a');self.assertEqual(weights,self.b.weights('1'))
        self.assertFalse(any(write for _,_,write in self.api.calls))
    def test_paused_import_saves_state(self):
        self.b.leases['1']=0;self.b.import_loop('1','account-a')
        self.assertFalse(any(r=='image.getInfinite' for r,_,_ in self.api.calls))
    def test_reaction_retry_reconciles_instead_of_toggling_twice(self):
        self.b.remember('1',image());payload=self.act(kind='reaction',imageId=1,reaction='Heart',selected=True);self.api.fail=True
        with self.assertRaises(ValueError):self.b.action(payload)
        result=self.b.action(payload);self.assertIn('Heart',result['reactions']);self.b.action(payload)
        self.assertEqual(sum(r=='reaction.toggle' for r,_,_ in self.api.calls),1)
    def test_follow_set_state_and_collection_confirmed(self):
        self.b.remember('1',image());self.b.action(self.act(kind='follow',creatorId=7,selected=True))
        self.assertFalse(any(r=='user.toggleFollow' for r,_,_ in self.api.calls))
        self.b.action(self.act(kind='collect',imageId=1,collectionId=4,selected=True));self.assertEqual(self.b.weights('1')['tags']['12'],1)
    def test_tag_vote_only_changes_local_tag_score_and_requested_vote(self):
        self.b.remember('1',image());self.b.action(self.act(kind='vote',imageId=1,tagId=12,vote=1))
        self.assertEqual(self.b.weights('1')['tags']['12'],1);self.assertEqual(self.b.weights('1')['creators'],{})
        self.assertEqual([r for r,_,w in self.api.calls if w],['tag.addTagVotes'])
    def test_relationships_dominate_lora_filler(self):
        self.b.save('1','follows',[7]);x=self.b.remember('1',image());self.b.observe('1','reactions',x,2,'1')
        result=self.b.feed({});sources=[i['reason'] for i in result['items']]
        self.assertLessEqual(sum(s.startswith('From LoRA') for s in sources),2)
    def test_first_visit_knows_relationships_before_history_import(self):
        status=self.b.status(active=False)
        self.assertEqual(status['follows'],1)
        self.assertFalse(self.b.running)
        result=self.b.feed({})
        self.assertLessEqual(sum(i['reason'].startswith('From LoRA') for i in result['items']),2)
    def test_cdn_whitelist(self):
        for bad in ['https://evil.test/a','http://image.civitai.com/a','https://image.civitai.com@evil.test/a','https://image.civitai.com:88/a']:self.assertFalse(cdn(bad))
        self.assertTrue(cdn('https://blobs-b2.civitai.com/file/blobs-managed-public/a.jpg'))


if __name__=='__main__':unittest.main()
