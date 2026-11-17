import json,tempfile,time,unittest,uuid
from unittest.mock import patch
from civitai_browser import Browser
from test_civitai_browser import Models,API,image

class SocialCacheTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.api=API();self.models=Models();self.b=Browser(self.tmp.name,self.models,None,self.api)
  self.b.account();self.b.collections('1','account-a')
 def tearDown(self):self.tmp.cleanup()
 def test_opening_media_uses_cached_follows_and_likes(self):
  self.b.sync_follows('1','account-a');self.b.remember('1',image())
  before=len(self.api.calls)
  for _ in range(3):
   result=self.b.detail(1)['item'];self.assertTrue(result['following']);self.assertIn('Like',result['reactions'])
  self.assertFalse(any(r in ('user.getFollowingUsers','reaction.getMyImageReactions') for r,_,_ in self.api.calls[before:]))
  stale=image();stale['reactions']=[];self.b.remember('1',stale)
  self.assertEqual(self.b.stored('1',1)['reactions'],['Like'])
 def test_bad_media_cache_does_not_block_index_migration(self):
  self.b.remember('1',image())
  with self.b.db() as db:
   db.execute("DELETE FROM settings WHERE account='' AND key='social-index-migrated'")
   db.execute('DELETE FROM social_members')
   db.execute('INSERT INTO media VALUES(?,?,?,?)',('1','2','broken cache',time.time()))
  restarted=Browser(self.tmp.name,self.models,None,self.api)
  self.assertEqual(restarted.like_index('1'),{'1':['Like']})
 def test_follows_daily_limit_restart_failures_and_inclusion(self):
  self.b.sync_follows('1','account-a');before=len(self.api.calls)
  restarted=Browser(self.tmp.name,self.models,None,self.api);restarted.sync_follows('1','account-a')
  self.assertEqual(len(self.api.calls),before)
  self.api.followed=[8];restarted.save('1','follow-sync',dict(attempted=time.time()-86401));restarted.sync_follows('1','account-a')
  self.assertEqual(set(map(str,restarted.setting('1','follows'))),{'7','8'})
  restarted.save('1','follow-sync',dict(attempted=time.time()-86401));restarted.sync_follows('1','account-a')
  self.assertEqual(list(map(str,restarted.setting('1','follows'))),['8'])
  restarted.save('1','follow-sync',dict(attempted=time.time()-86401))
  with patch.object(restarted,'call',side_effect=OSError('offline')) as call:
   restarted.sync_follows('1','account-a');restarted.sync_follows('1','account-a');self.assertEqual(call.call_count,1)
  self.assertEqual(list(map(str,restarted.setting('1','follows'))),['8'])
 def test_local_deltas_survive_restart_and_stale_scan(self):
  self.b.remember('1',image());stamp=time.time()-1
  for kind,selected,extra in [('reaction',False,dict(imageId=1,reaction='Like')),('follow',True,dict(creatorId=9))]:
   self.b.social.enqueue(dict(account='1',kind=kind,selected=selected,clientId=str(uuid.uuid4()),clientSeq=1,requestId=str(uuid.uuid4()),**extra))
  self.b.merge_social_page('1','reaction',[(1,'Like')],stamp);self.b.finish_social_scan('1','reaction',stamp)
  restarted=Browser(self.tmp.name,self.models,None,self.api)
  self.assertEqual(restarted.stored('1',1)['reactions'],[]);self.assertIn('9',list(map(str,restarted.setting('1','follows',[]))))
  self.assertEqual(restarted.like_index('2'),{})
 def test_daily_import_populates_complete_like_index(self):
  original=self.b.transport
  def remote(token,route,value,write,rest):
   if route=='image.getInfinite' and value.get('reactions'):
    self.api.calls.append((route,value,write));return dict(items=[image(2 if value.get('cursor') else 1)],nextCursor=None if value.get('cursor') else 'next')
   return original(token,route,value,write,rest)
  self.b.transport=remote;self.b.save('1','import',dict(complete=True,finished=time.time()));self.b.save('1','collection-index-complete',True)
  self.b.public_curations=lambda *a,**k:([],0);self.b.leases['1']=time.monotonic()+45
  with patch('civitai_browser.time.sleep'):self.b._import_loop('1','account-a')
  self.assertEqual(self.b.like_index('1'),{'1':['Like'],'2':['Like']});n=len(self.api.calls)
  with patch('civitai_browser.time.sleep'):self.b._import_loop('1','account-a')
  self.assertEqual(len(self.api.calls),n)
  stamp=time.time()+1;self.b.finish_social_scan('1','reaction',stamp);self.b.finish_social_scan('1','reaction',stamp)
  self.assertEqual(len(self.b.like_index('1')),2)
  self.b.finish_social_scan('1','reaction',stamp+86400);self.assertEqual(self.b.like_index('1'),{})

if __name__=='__main__':unittest.main()
