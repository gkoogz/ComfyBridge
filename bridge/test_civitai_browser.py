import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
import random
from civitai_browser import Browser, cdn


class Models:
    key='account-a'
    def token(self):return self.key
    def snapshot(self):return {'items':[dict(kind='loras',versionId=i,id=str(i),title='LoRA '+str(i)) for i in (101,102,103)]}


def image(i=1,creator=7,tags=None):
    return dict(id=i,url='06c1e11a-6a5b-465c-b014-2e22104488f6',width=400,height=800,type='image',
        user={'id':creator,'username':'Potter' if creator==7 else 'Creator '+str(creator),'image':'06c1e11a-6a5b-465c-b014-2e22104488f6'},
        tags=tags or [{'id':12,'name':'ceramics'}],reactions=[{'reaction':'Like'}],meta={'prompt':'A ceramic vase.'})


class API:
    def __init__(self):self.calls=[];self.reactions=['Like'];self.followed=[7];self.members=[];self.serial=1000;self.fail=False
    def __call__(self,token,route,value,write,rest):
        self.calls.append((route,value,write))
        if route=='me':return dict(id=1 if token=='account-a' else 2,username='Example')
        if route=='collection.getAllUser':return [dict(id=4,name='Ceramics',type='Image',isOwner=True),dict(id=5,name='Models',type='Model',isOwner=True),dict(id=6,name='Someone else',type='Image',isOwner=False)]
        if route=='collection.getInfinite':return {'items':[]}
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
        if route=='image.getGenerationData':return {'meta':{'prompt':'A ceramic vase.'},'resources':[{'modelVersionId':20,'modelId':30,'modelName':'Ceramics','modelType':'LORA'}]}
        if route=='user.getCreator':return {'profilePicture':{'url':'06c1e11a-6a5b-465c-b014-2e22104488f6'}}
        if route=='tag.getVotableTags':return [{'id':12,'name':'ceramics','vote':1}]
        if route in ('tag.addTagVotes','collection.upsert'):return {}
        if route=='image.getInfinite':
            if value.get('imageId'):return {'items':[image(value['imageId'])]}
            if value.get('ids'):return {'items':[image(i) for i in value['ids']]}
            if value.get('limit') in (12,100,200):
                count=value['limit'];self.serial+=count
                return {'items':[image(self.serial+i) for i in range(count)],'nextCursor':None}
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
    def test_generation_endpoint_fills_missing_feed_metadata_and_all_resources(self):
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite':
                raw=image(value.get('imageId',1));raw['meta']=None;raw['user']['image']=None
                return {'items':[raw]}
            if route=='image.getGenerationData':return {'meta':{'prompt':'A blue ceramic vase.','negativePrompt':'blurry','seed':42},'resources':[
                {'modelVersionId':i,'modelId':i+100,'modelName':'Resource '+str(i),'modelType':'LORA','versionName':'v1','strength':0.4} for i in range(1,10)]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        item=self.b.detail(1)['item']
        self.assertEqual(item['prompt'],'A blue ceramic vase.');self.assertEqual(item['negativePrompt'],'blurry')
        self.assertEqual(len(item['resources']),9);self.assertEqual(item['resources'][0]['weight'],0.4)
        self.assertEqual(item['detailVersion'],2);self.assertTrue(item['avatarPath'])
        self.b.images('1','account-a',{},meta=False)
        saved=self.b.stored('1',1)
        self.assertEqual(saved['prompt'],item['prompt']);self.assertEqual(len(saved['resources']),9)
        self.b.detail(1)
        self.assertEqual(sum(r=='user.getCreator' for r,_,_ in self.api.calls),1)
    def test_generation_failure_is_retryable_and_keeps_cached_prompt(self):
        self.b.detail(1)
        self.b.invalidate('account-a','image.getGenerationData')
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getGenerationData':raise ValueError('Temporary failure')
            return original(token,route,value,write,rest)
        self.b.transport=request
        item=self.b.detail(1)['item']
        self.assertFalse(item['generationDataAvailable']);self.assertEqual(item['detailVersion'],0)
        self.assertEqual(item['prompt'],'A ceramic vase.')
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
    def test_tag_vote_only_changes_personal_weight_by_five(self):
        self.b.remember('1',image());self.b.action(self.act(kind='vote',imageId=1,tagId=12,vote=1))
        self.assertEqual(self.b.weights('1')['tags']['12'],5);self.assertEqual(self.b.weights('1')['creators'],{})
        self.assertEqual([r for r,_,w in self.api.calls if w],[])

    def test_tag_steps_clamp_hold_zero_retry_and_reactivate(self):
        item=self.b.remember('1',image());self.b.observe('1','reactions',item,3,'1')
        down=self.act(kind='tag-weight',imageId=1,tagId=12,delta=-5)
        result=self.b.action(down);self.assertEqual(result['weight'],0)
        self.assertEqual(self.b.action(down),result)
        self.b.observe('1','collection:4',item,10,'2')
        self.assertNotIn('12',self.b.weights('1')['tags'])
        up=self.act(kind='tag-weight',imageId=1,tagId=12,delta=5)
        self.assertEqual(self.b.action(up)['weight'],5)
        self.assertEqual(self.b.action(up)['weight'],5)
        self.assertEqual(self.b.action(self.act(kind='tag-weight',imageId=1,tagId=12,delta=5))['weight'],10)
        self.assertEqual(self.b.tag_weight_snapshot('2')['tagWeights'],{})
        self.b.action(self.act(kind='preference',subject='tag',id=12,banned=True))
        with self.assertRaisesRegex(ValueError,'Unban'):self.b.action(self.act(kind='tag-weight',imageId=1,tagId=12,delta=5))

    def test_detail_reports_personal_weights_not_public_votes(self):
        self.b.remember('1',image());self.b.action(self.act(kind='tag-weight',imageId=1,tagId=12,delta=5))
        result=self.b.detail(1);tag=result['item']['tags'][0]
        self.assertEqual(tag['weight'],5);self.assertNotIn('score',tag);self.assertNotIn('vote',tag)
        self.assertEqual(result['tagWeights']['12'],5)

    def test_pair_sampling_is_distinct_weighted_and_excludes_zero(self):
        rng=random.Random(7);hits={'1':0,'2':0,'3':0}
        for _ in range(3000):
            pair=self.b.roll_tag_pair({'1':30,'2':1,'3':1,'4':0,'5':-1},rng)
            self.assertEqual(len(set(pair)),2)
            for tid in pair:hits[tid]+=1
        self.assertGreater(hits['1'],hits['2']*1.7)
        self.assertGreater(hits['1'],hits['3']*1.7)
        self.assertEqual(self.b.roll_tag_pair({'1':5,'2':0}),[])

    def test_selected_tags_search_requires_all_tags_and_keeps_media_filter(self):
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite' and value.get('tags'):
                self.api.calls.append((route,value,write))
                return {'items':[image(1,tags=[{'id':12,'name':'ceramics'}]),image(2,tags=[{'id':12,'name':'ceramics'},{'id':13,'name':'blue'}]),
                    image(3,tags=[{'id':12,'name':'ceramics'},{'id':13,'name':'blue'},{'id':14,'name':'glaze'}])]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        # Explicit searches are allowed even with no positive personal weights.
        self.assertFalse(self.b.weights('1')['tags'])
        result=self.b.feed({'channel':'tags:14,12,13,12:video'})
        self.assertEqual([i['id'] for i in result['items']],['3'])
        self.assertEqual(result['items'][0]['chosenBy'],dict(kind='tags',ids=['12','13','14']))
        query=[v for r,v,_ in self.api.calls if r=='image.getInfinite'][-1]
        self.assertEqual(query['tags'],[12,13,14]);self.assertEqual(query['types'],['video'])
        with self.assertRaises(ValueError):self.b.feed({'channel':'tags:12,nope:all'})

    def test_pair_feed_enforces_and_and_labels_actual_selection(self):
        item=self.b.remember('1',image(tags=[{'id':12,'name':'ceramics'},{'id':13,'name':'blue'}]))
        self.b.observe('1','reactions',item,5,'1')
        self.b.action(self.act(kind='preference',subject='creator',id=7,disabled=True))
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite' and len(value.get('tags',[]))==2:
                self.api.calls.append((route,value,write));self.api.serial+=3
                return {'items':[image(self.api.serial,tags=[{'id':12,'name':'ceramics'}]),image(self.api.serial+1,tags=[{'id':13,'name':'blue'}]),image(self.api.serial+2,tags=[{'id':12,'name':'ceramics'},{'id':13,'name':'blue'}])]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        result=self.b.feed({'channel':'mix'})
        paired=[i for i in result['items'] if i['chosenBy'].get('kind')=='tags']
        self.assertTrue(paired)
        self.assertTrue(all(set(i['chosenBy']['ids'])=={'12','13'} and self.b.matches_tags(i,['12','13']) for i in paired))
        self.b.action(self.act(kind='tag-weight',imageId=1,tagId=12,delta=-5))
        again=self.b.feed({'channel':'mix','cursor':result['nextCursor']})
        self.assertFalse(any(i['chosenBy'].get('kind')=='tags' for i in again['items']))
        creator=self.b.feed({'channel':'creator:7:all'})['items']
        self.assertTrue(all(i['chosenBy']=={'kind':'creator','id':'7'} for i in creator))
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
    def test_manual_weight_retry_disable_restore_and_account_scope(self):
        item=self.b.remember('1', image())
        self.b.observe('1','reactions',item,3,'1')
        edit=self.act(kind='preference',subject='tag',id=12,delta=1)
        self.b.action(edit);self.b.action(edit)
        self.assertEqual(self.b.weights('1')['tags']['12'],4)
        self.b.action(self.act(kind='preference',subject='tag',id=12,disabled=True))
        self.assertNotIn('12',self.b.weights('1')['tags'])
        rows=self.b.preferences()['items']
        self.assertTrue(rows[-1]['disabled'])
        self.assertEqual(rows[-1]['weight'],0)
        self.b.action(self.act(kind='preference',subject='tag',id=12,disabled=False))
        self.assertEqual(self.b.weights('1')['tags']['12'],4)
        self.assertEqual(self.b.setting('2','weight-overrides',{}),{})

    def test_unweight_stays_zero_as_history_grows_then_restores(self):
        item=self.b.remember('1',image());self.b.observe('1','reactions',item,2,'1')
        self.b.action(self.act(kind='preference',subject='tag',id=12,disabled=True))
        self.b.observe('1','collection:4',item,7,'2')
        row=next(r for r in self.b.preference_rows('1') if r['kind']=='tag')
        self.assertEqual(row['weight'],0);self.assertEqual(row['base'],9)
        self.assertEqual(self.b.bans('1'),[])
        self.assertTrue(self.b.feed({'channel':'collection:4'})['items'])
        with self.assertRaisesRegex(ValueError,'Restore'):
            self.b.action(self.act(kind='preference',subject='tag',id=12,delta=1))
        self.b.action(self.act(kind='preference',subject='tag',id=12,disabled=False))
        self.assertEqual(self.b.weights('1')['tags']['12'],9)

    def test_bans_filter_every_channel_and_survive_restart_and_unfollow(self):
        self.b.status(active=False)
        self.b.remember('1',image())
        ban=self.act(kind='preference',subject='creator',id=7,banned=True)
        self.b.action(ban);self.b.action(ban)
        for channel in ('mix','collection:4','reactions','creator:7:all','tag:12:all'):
            self.assertEqual(self.b.feed({'channel':channel})['items'],[],channel)
        self.b.save('1','follows',[])
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        self.assertEqual(restarted.bans('1')[0]['id'],'7')
        self.assertTrue(restarted.preference_rows('1')[0]['banned'])
        self.assertEqual(restarted.bans('2'),[])
        self.assertTrue(restarted.is_banned({'credit':'POTTER'},restarted.bans('1')))
        restarted.action(self.act(kind='preference',subject='creator',id=7,banned=False))
        self.assertFalse(restarted.preference_rows('1')[0]['disabled'])
        self.assertTrue(restarted.feed({'channel':'collection:4'})['items'])
        self.assertFalse(any(write for _,_,write in self.api.calls))

    def test_tag_ban_filters_buffered_and_metadata_missing_items(self):
        item=self.b.remember('1',image());self.b.observe('1','reactions',item,2,'1')
        first=self.b.feed({'channel':'mix'});cursor=first['nextCursor']
        self.b.action(self.act(kind='preference',subject='tag',id=12,banned=True))
        self.assertEqual(self.b.feed({'channel':'mix','cursor':cursor})['items'],[])
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite':
                if value.get('ids'):return original(token,route,value,write,rest)
                raw=image(999);raw.pop('tags');return {'items':[raw]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        self.assertEqual(self.b.feed({'channel':'collection:4'})['items'],[])
        self.assertTrue(any(route=='image.getInfinite' and value.get('ids') for route,value,_ in self.api.calls))
        self.assertFalse(any(route=='tag.getVotableTags' for route,_,_ in self.api.calls))
        self.b.action(self.act(kind='preference',subject='tag',id=12,banned=False))
        self.assertTrue(self.b.feed({'channel':'collection:4'})['items'])

    def test_exclusive_feeds_pass_recency_and_media_filter(self):
        self.b.feed({'channel':'creator:7:video'})
        query=[v for r,v,_ in self.api.calls if r=='image.getInfinite'][-1]
        self.assertEqual(query['userId'],7)
        self.assertEqual(query['types'],['video'])
        self.assertEqual(query['sort'],'Newest')
        self.b.feed({'channel':'tag:12:all'})
        query=[v for r,v,_ in self.api.calls if r=='image.getInfinite'][-1]
        self.assertEqual(query['tags'],[12])
        self.assertNotIn('types',query)

    def test_cdn_whitelist(self):
        for bad in ['https://evil.test/a','http://image.civitai.com/a','https://image.civitai.com@evil.test/a','https://image.civitai.com:88/a']:self.assertFalse(cdn(bad))
        self.assertTrue(cdn('https://blobs-b2.civitai.com/file/blobs-managed-public/a.jpg'))

    def test_feed_survives_restart_and_more_than_thirty_minutes(self):
        self.b.status(active=False)
        first=self.b.feed({'channel':'mix'})
        cursor=first['nextCursor'];seen={i['id'] for i in first['items']}
        with self.b.db() as db:
            db.execute('UPDATE feed_sessions SET touched=?',(time.time()-2400,))
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        second=restarted.feed({'channel':'mix','cursor':cursor})
        self.assertFalse(second['recovered'])
        self.assertEqual(second['nextCursor'],cursor)
        self.assertFalse(seen.intersection(i['id'] for i in second['items']))
        self.assertGreater(restarted.feeds[cursor]['turn'],0)
        with self.b.db() as db:db.execute('UPDATE feed_sessions SET touched=?',(time.time()-7201,))
        restarted.feeds.clear()
        recovered=restarted.feed({'channel':'mix','cursor':cursor,'seen':list(seen)})
        self.assertTrue(recovered['recovered'])
        self.assertNotEqual(recovered['nextCursor'],cursor)
        self.assertFalse(seen.intersection(i['id'] for i in recovered['items']))

    def test_status_renews_only_active_account_cursors(self):
        self.b.status(active=False)
        cursor=self.b.feed({'channel':'mix'})['nextCursor']
        with self.b.db() as db:db.execute('UPDATE feed_sessions SET touched=?',(time.time()-3600,))
        self.b.status(active=False,cursors=[cursor],activity_age=10)
        with self.b.db() as db:stamp=db.execute('SELECT touched FROM feed_sessions WHERE id=?',(cursor,)).fetchone()[0]
        self.assertLess(time.time()-stamp,20)
        self.b.status(active=False,cursors=[cursor],activity_age=7201)
        with self.b.db() as db:self.assertEqual(stamp,db.execute('SELECT touched FROM feed_sessions WHERE id=?',(cursor,)).fetchone()[0])
        self.models.key='account-b'
        self.b.status(active=False,cursors=[cursor],activity_age=0)
        with self.b.db() as db:self.assertEqual(stamp,db.execute('SELECT touched FROM feed_sessions WHERE id=?',(cursor,)).fetchone()[0])

    def test_feed_social_flags_and_account_cursor_isolation(self):
        status=self.b.status(active=False)
        self.assertEqual(status['followingIds'],['7'])
        items=self.b.feed({'channel':'collection:4'})['items']
        self.assertTrue(all(i['following'] for i in items))
        self.assertTrue(all(i['collections']==[{'collectionId':4}] for i in items))
        first=self.b.feed({'channel':'mix'})
        self.models.key='account-b'
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        second=restarted.feed({'channel':'mix','cursor':first['nextCursor']})
        self.assertEqual(second['account'],'2')
        self.assertTrue(second['recovered'])

    def test_seen_posts_survive_refresh_restart_and_are_account_scoped(self):
        original=self.b.transport
        def request(token,route,value,write,rest):
            if route=='image.getInfinite':return {'items':[image(i,creator=20+i%20) for i in range(1,41)]}
            return original(token,route,value,write,rest)
        self.b.transport=request
        first=self.b.feed({'channel':'mix'});a={i['id'] for i in first['items']}
        self.assertTrue(a)
        restarted=Browser(self.tmp.name,self.models,None,request)
        second=restarted.feed({'channel':'mix','refresh':True});b={i['id'] for i in second['items']}
        self.assertTrue(b);self.assertFalse(a&b)
        result=restarted.exposure(dict(account='1',viewed=list(a),candidates=list(a|b)))
        self.assertEqual(set(result['seen']),a)
        with restarted.db() as db:db.execute('UPDATE feed_exposure SET served=0')
        third=restarted.feed({'channel':'mix','refresh':True})
        self.assertFalse(a&{i['id'] for i in third['items']},'Viewed IDs never expire with delivery reservations')
        self.assertTrue(a&{i['id'] for i in restarted.feed({'channel':'creator:7:all'})['items']})
        self.models.key='account-b'
        self.assertEqual(restarted.exposure(dict(account='2',candidates=list(a)))['seen'],[])
        self.assertTrue(a&{i['id'] for i in restarted.feed({'channel':'mix','refresh':True})['items']})
        with self.assertRaisesRegex(ValueError,'account changed'):restarted.exposure(dict(account='1',viewed=['1']))
        self.assertFalse(any(write for _,_,write in self.api.calls))

    def test_exposure_validation_and_upgrade_old_mix_session(self):
        for values in (['bad'],['1']*501,'1'):
            with self.assertRaises(ValueError):self.b.exposure(dict(account='1',viewed=values))
        first=self.b.feed({'channel':'mix'})
        with self.b.db() as db:db.execute('DELETE FROM feed_exposure')
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        with restarted.db() as db:
            rows=db.execute('SELECT image,viewed,served FROM feed_exposure').fetchall()
        self.assertTrue(rows);self.assertTrue(all(r['viewed']==0 and r['served']>0 for r in rows))
        self.assertEqual({r['image'] for r in rows},{i['id'] for i in first['items']})

    def test_creator_timeout_persistent_idempotent_expires_and_exclusive_allowed(self):
        request=self.act(kind='timeout',creatorId=7,name='Potter')
        first=self.b.action(request)
        self.assertEqual(first,self.b.action(request))
        self.assertAlmostEqual(first['until']-time.time(),7200,delta=2)
        restarted=Browser(self.tmp.name,self.models,None,self.api)
        self.assertIn('7',restarted.timeouts('1'))
        self.assertEqual(restarted.timeouts('2'),{})
        self.assertEqual(restarted.feed({'channel':'mix'})['items'],[])
        self.assertTrue(restarted.feed({'channel':'creator:7:all'})['items'])
        self.assertTrue(restarted.feed({'channel':'collection:4'})['items'])
        self.assertTrue(restarted.is_muted({'credit':'POTTER'},restarted.timeouts('1')))
        restarted.save('1','creator-timeouts',{'7':dict(until=time.time()-1,name='Potter')})
        self.assertTrue(restarted.feed({'channel':'mix'})['items'])
        self.assertFalse(any(write for _,_,write in self.api.calls))


if __name__=='__main__':unittest.main()
