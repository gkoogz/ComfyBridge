"""Durable desired-state social outbox. No network work on enqueue."""
import hashlib
import json
import math
import sqlite3
import threading
import time
import uuid
from civitai_requests import governor, background_work, Deferred

KINDS=('reaction','collect','follow')
REACTIONS=('Like','Heart','Laugh','Cry')

class SocialOutbox:
    def __init__(self,browser,clock=time.time):
        self.b=browser;self.clock=clock;self.lock=threading.RLock();self.flush_lock=threading.Lock()
        self.wake=threading.Event();self.stop=threading.Event();self.thread=None
        with self.b.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS social_outbox(account TEXT,key TEXT,payload TEXT,PRIMARY KEY(account,key));
              CREATE TABLE IF NOT EXISTS social_receipts(account TEXT,id TEXT,hash TEXT,revision INTEGER,PRIMARY KEY(account,id));
              CREATE TABLE IF NOT EXISTS social_sequences(account TEXT,client TEXT,key TEXT,seq INTEGER,PRIMARY KEY(account,client,key));''')

    def rows(self,account,pending=False):
        with self.b.db() as db:items=[json.loads(r[0]) for r in db.execute('SELECT payload FROM social_outbox WHERE account=?',(account,))]
        return [r for r in items if not pending or r['state']!='synced']

    @staticmethod
    def key(p):
        def ident(v):
            if not str(v).isdigit() or not 0<int(v)<10**15:raise ValueError('Invalid social target')
            return str(int(v))
        if p.get('kind') not in KINDS or type(p.get('selected')) is not bool:raise ValueError('Choose a social action and final selected state')
        if p['kind']=='follow':return 'follow:'+ident(p.get('creatorId'))
        image=ident(p.get('imageId'))
        if p['kind']=='collect':return 'collect:'+image+':'+ident(p.get('collectionId'))
        if p.get('reaction') not in REACTIONS:raise ValueError('Invalid reaction')
        return 'reaction:'+image+':'+p['reaction']

    def save(self,db,account,row):
        db.execute('INSERT OR REPLACE INTO social_outbox VALUES(?,?,?)',(account,row['key'],json.dumps(row)))

    def enqueue(self,p):
        me,token=self.b.account(cached=True);account=me['id']
        if str(p.get('account'))!=account:raise ValueError('Civitai account changed. Reopen Browse.')
        key=self.key(p);request=str(uuid.UUID(p.get('requestId','')));client=str(uuid.UUID(p.get('clientId','')))
        seq=p.get('clientSeq');first=p.get('firstAt',self.clock())
        if type(seq) is not int or seq<1 or not isinstance(first,(int,float)) or not math.isfinite(first):raise ValueError('Invalid queued action')
        fingerprint=hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()
        with self.lock,self.b.db() as db:
            db.execute('BEGIN IMMEDIATE')
            receipt=db.execute('SELECT hash,revision FROM social_receipts WHERE account=? AND id=?',(account,request)).fetchone()
            if receipt:
                if receipt[0]!=fingerprint:raise ValueError('Action identifier was already used')
                return dict(ok=True,queued=True,requestId=request,revision=receipt[1])
            prior=db.execute('SELECT payload FROM social_outbox WHERE account=? AND key=?',(account,key)).fetchone()
            old=json.loads(prior[0]) if prior else None
            previous=db.execute('SELECT seq FROM social_sequences WHERE account=? AND client=? AND key=?',(account,client,key)).fetchone()
            if previous and previous[0]>=seq:return dict(ok=True,queued=True,requestId=request,revision=old['revision'] if old else 0,superseded=True)
            if p['kind']!='follow' and not self.b.stored(account,p['imageId']):raise ValueError('Open this media before interacting with it')
            if p['kind']=='collect' and int(p['collectionId']) not in [c['id'] for c in self.b.setting(account,'collections',{}).get('items',[])]:raise ValueError('Select one of your known collections')
            pending=old and old['state']!='synced'
            row=dict(key=key,requestId=request,revision=(old['revision'] if old else 0)+1,
                     kind=p['kind'],selected=p['selected'],imageId=str(p.get('imageId','')),creatorId=str(p.get('creatorId','')),
                     collectionId=str(p.get('collectionId','')),reaction=p.get('reaction',''),
                     firstAt=old['firstAt'] if pending else min(self.clock(),max(0,first)),updated=self.clock(),
                     state='pending',retryAt=0,attempted=bool(old and old.get('attempted')),attempts=0,error='')
            self.save(db,account,row)
            if row['kind']=='collect':self.b.set_collection_delta(db,account,row['collectionId'],row['imageId'],row['selected'])
            db.execute('INSERT OR REPLACE INTO social_sequences VALUES(?,?,?,?)',(account,client,key,seq))
            db.execute('INSERT INTO social_receipts VALUES(?,?,?,?)',(account,request,fingerprint,row['revision']))
        self.learn(account,row);self.wake.set()
        return dict(ok=True,queued=True,requestId=request,revision=row['revision'])

    def learn(self,account,row):
        if row['kind']=='follow':return
        item=self.b.stored(account,row['imageId'])
        if not item:return
        source='reactions' if row['kind']=='reaction' else 'collection:'+row['collectionId']
        score=len([r for r in item.get('reactions',[]) if r in REACTIONS]) if row['kind']=='reaction' else int(row['selected'])
        self.b.observe(account,source,item,score,str(self.clock()))

    def overlay(self,account,item):
        if not item:return item
        result=dict(item);reactions=list(item.get('reactions',[]));members=list(item.get('collections',[]));stats=dict(item.get('stats',{}))
        for r in self.rows(account,True):
            if r['kind']=='follow' and r['creatorId']==str(item.get('creatorId')):result['following']=r['selected']
            if r['imageId']!=str(item.get('id')):continue
            if r['kind']=='reaction':
                before=r['reaction'] in reactions
                reactions=[x for x in reactions if x!=r['reaction']]+([r['reaction']] if r['selected'] else [])
                countkey=r['reaction'].lower()+'CountAllTime'
                if countkey in stats:stats[countkey]=max(0,stats[countkey]+int(r['selected'])-int(before))
                result.update(reactions=reactions,stats=stats)
            if r['kind']=='collect':
                members=[x for x in members if str(x.get('collectionId'))!=r['collectionId']]+([{'collectionId':int(r['collectionId'])}] if r['selected'] else [])
                result['collections']=members
        return result

    def follows(self,account,values):
        ids={str(v) for v in values}
        for r in self.rows(account,True):
            if r['kind']=='follow':ids.add(r['creatorId']) if r['selected'] else ids.discard(r['creatorId'])
        return list(ids)

    def snapshot(self):
        me,_=self.b.account(cached=True);rows=self.rows(me['id'])
        rows=[r for r in rows if r['state']!='synced' or self.clock()-r['updated']<86400]
        return dict(account=me['id'],items=rows,pending=sum(r['state']!='synced' for r in rows))

    def busy(self):
        if not self.b.models.token():return False
        try:
            me,_=self.b.account(cached=True)
            # Remain awake beyond normal ten-minute delivery; failures may sleep and
            # resume on next launch, rather than pinning a worker indefinitely.
            return any(self.clock()-r['firstAt']<1200 for r in self.rows(me['id'],True))
        except (ValueError,OSError):return False

    def current(self,account,row,mark=False):
        with self.lock,self.b.db() as db:
            found=db.execute('SELECT payload FROM social_outbox WHERE account=? AND key=?',(account,row['key'])).fetchone()
            now=json.loads(found[0]) if found else None
            if not now or now['revision']!=row['revision'] or now['state']=='synced':return False
            if mark:now['attempted']=True;self.save(db,account,now)
            return True

    def settle(self,account,row):
        # Persist confirmed display state before acknowledging completion. A crash
        # between these commits leaves a safely reconcilable pending action.
        self.confirm_cache(account,row)
        with self.lock,self.b.db() as db:
            found=db.execute('SELECT payload FROM social_outbox WHERE account=? AND key=?',(account,row['key'])).fetchone()
            now=json.loads(found[0]) if found else None
            if now and now['revision']==row['revision']:
                now.update(state='synced',attempted=False,error='',updated=self.clock());self.save(db,account,now)

    def confirm_cache(self,account,row):
        with self.b.db() as db:
            if row['kind']=='follow':
                old=db.execute("SELECT value FROM settings WHERE account=? AND key='follows'",(account,)).fetchone()
                ids={str(v) for v in json.loads(old[0])} if old else set()
                ids.add(row['creatorId']) if row['selected'] else ids.discard(row['creatorId'])
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'follows',json.dumps(list(ids))))
            else:
                old=db.execute('SELECT payload FROM media WHERE account=? AND id=?',(account,row['imageId'])).fetchone()
                if not old:return
                item=json.loads(old[0])
                if row['kind']=='reaction':
                    values=set(item.get('reactions',[]));before=row['reaction'] in values
                    values.add(row['reaction']) if row['selected'] else values.discard(row['reaction']);item['reactions']=list(values)
                    stats=item.get('stats',{});key=row['reaction'].lower()+'CountAllTime'
                    if key in stats:stats[key]=max(0,stats[key]+int(row['selected'])-int(before))
                else:
                    item['collections']=[c for c in item.get('collections',[]) if str(c.get('collectionId'))!=row['collectionId']]+([{'collectionId':int(row['collectionId'])}] if row['selected'] else [])
                    item['collectionsChecked']=self.clock()
                db.execute('UPDATE media SET payload=? WHERE account=? AND id=?',(json.dumps(item),account,row['imageId']))

    def failed(self,account,rows,error):
        with self.lock,self.b.db() as db:
            for row in rows:
                found=db.execute('SELECT payload FROM social_outbox WHERE account=? AND key=?',(account,row['key'])).fetchone()
                now=json.loads(found[0]) if found else None
                if not now or now['revision']!=row['revision'] or now['state']=='synced':continue
                attempts=now.get('attempts',0)+1
                delay=max(getattr(error,'retry_after',0),min(300,5*2**min(attempts,6)))
                deadline=now['firstAt']+600
                if isinstance(error,Deferred) and error.reason in ('browsing_priority','background_limit') and self.clock()<deadline:
                    delay=min(delay,deadline-self.clock())
                now.update(state='retrying',attempts=attempts,retryAt=self.clock()+delay,error='Waiting to sync with Civitai; your choice is saved.')
                self.save(db,account,now)

    def flush(self):
        if not self.flush_lock.acquire(False):return
        try:
            me,token=self.b.account(cached=True);account=me['id'];now=self.clock()
            rows=sorted([r for r in self.rows(account,True) if r['retryAt']<=now],key=lambda r:r['firstAt'])
            if not rows:return
            urgent=now-rows[0]['firstAt']>=600
            if not urgent and not governor.has_headroom():return
            # Batch reads and collection additions; pacing and server cooldowns
            # still apply at the deadline. No unsafe concurrent toggle burst.
            with background_work(quiet=not urgent,writeback=True,urgent=urgent):
                self.send(account,token,rows[:200],urgent)
        finally:self.flush_lock.release()

    def send(self,account,token,rows,urgent):
        b=self.b
        def permitted(group):
            b.assert_account(account,token)
            if not urgent and not governor.has_headroom():return []
            return [r for r in group if self.current(account,r)]
        # Reactions share one fresh status lookup per 100 images, followed by
        # single toggles only where remote state differs from desired final state.
        reactions=[r for r in rows if r['kind']=='reaction']
        for offset in range(0,len(reactions),100):
            group=permitted(reactions[offset:offset+100])
            if not group:continue
            try:
                actual=b.call(token,'reaction.getMyImageReactions',{'imageIds':list({int(r['imageId']) for r in group})},fresh=True)
                for r in group:
                    if not permitted([r]):continue
                    values=actual.get(r['imageId'],[]);values=[v.get('reaction') if isinstance(v,dict) else v for v in values]
                    if (r['reaction'] in values)!=r['selected']:
                        if not self.current(account,r,True):continue
                        b.call(token,'reaction.toggle',{'entityId':int(r['imageId']),'entityType':'image','reaction':r['reaction']},True)
                    self.settle(account,r)
            except (ValueError,OSError) as e:self.failed(account,group,e)
        follows=permitted([r for r in rows if r['kind']=='follow'])
        if follows:
            try:
                values={str(v.get('id') if isinstance(v,dict) else v) for v in b.call(token,'user.getFollowingUsers',fresh=True)}
                for r in follows:
                    if not permitted([r]):continue
                    if (r['creatorId'] in values)!=r['selected']:
                        if not self.current(account,r,True):continue
                        b.call(token,'user.toggleFollow',{'targetUserId':int(r['creatorId'])},True)
                    self.settle(account,r)
            except (ValueError,OSError) as e:self.failed(account,follows,e)
        collections={r['collectionId'] for r in rows if r['kind']=='collect' and r['selected']}
        for cid in collections:
            candidates=[r for r in rows if r['kind']=='collect' and r['selected'] and r['collectionId']==cid]
            for offset in range(0,len(candidates),100):
                group=permitted(candidates[offset:offset+100])
                if not group:continue
                try:
                    # Membership is a set; replaying a bulk add is idempotent.
                    group=[r for r in group if self.current(account,r,True)]
                    if not group:continue
                    reply=b.call(token,'collection.bulkSaveItems',{'collectionId':int(cid),'imageIds':[int(r['imageId']) for r in group]},True)
                    for r in group:
                        if reply.get('count')!=len(group):
                            # Bulk count excludes duplicates and may be partial.
                            # Verify ambiguous items rather than claiming they saved.
                            members=b.call(token,'collection.getUserCollectionItemsByItem',{'imageId':int(r['imageId'])},fresh=True)
                            if not any(str(c.get('collectionId'))==cid for c in members):
                                self.failed(account,[r],ValueError('Collection addition not confirmed'));continue
                        self.settle(account,r)
                except (ValueError,OSError) as e:self.failed(account,group,e)
        # Coalesce removals across collections into one call per image.
        for iid in {r['imageId'] for r in rows if r['kind']=='collect' and not r['selected']}:
            group=permitted([r for r in rows if r['kind']=='collect' and not r['selected'] and r['imageId']==iid])
            try:
                group=[r for r in group if self.current(account,r,True)]
                if not group:continue
                b.call(token,'collection.saveItem',{'imageId':int(iid),'collections':[],'removeFromCollectionIds':[int(r['collectionId']) for r in group]},True)
                for r in group:self.settle(account,r)
            except (ValueError,OSError) as e:self.failed(account,group,e)
        b.invalidate(token,'reaction.getMyImageReactions','user.getFollowingUsers','collection.getUserCollectionItemsByItem','image.getInfinite')

    def start(self):
        if self.thread and self.thread.is_alive():return
        self.thread=threading.Thread(target=self.run,daemon=True,name='civitai-social-outbox');self.thread.start()

    def run(self):
        while not self.stop.is_set():
            try:
                if self.b.models.token():self.flush()
            except (ValueError,OSError,sqlite3.Error):pass
            self.wake.wait(2);self.wake.clear()
