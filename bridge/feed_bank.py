"""One durable, metadata-only For You FIFO per Civitai account.

Selection runs ahead under the shared background request budget. Taking or
peeking never waits for network selection. The PC warms a bounded media window;
phones prefer the CDN and can fall back to that cached copy.
"""
import json
import random
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from civitai_requests import Deferred, background_work

TARGET, LOW, WINDOW = 200, 150, 25


class FeedBank:
    def __init__(self, browser):
        self.b=browser;self.lock=threading.RLock();self.running=set();self.media_running=set();self.media_retry={};self.leases={};self.protected_keys=set()
        with self.b.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS feed_bank(account TEXT PRIMARY KEY,payload TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS bank_receipts(account TEXT,id TEXT,payload TEXT,stamp REAL,PRIMARY KEY(account,id))')

    def read(self, account):
        with self.b.db() as db:row=db.execute('SELECT payload FROM feed_bank WHERE account=?',(account,)).fetchone()
        return json.loads(row[0]) if row else dict(items=[],cursor='',filling=True,retryAt=0)

    def write(self, account, state, db=None):
        if db is None:
            with self.b.db() as db:self.write(account,state,db)
        else:db.execute('INSERT OR REPLACE INTO feed_bank VALUES(?,?)',(account,json.dumps(state)))

    def clean(self, account, state, seen=()):
        """Recheck changed preferences and artist spacing before every delivery."""
        b=self.b;weights=b.weights(account);bans=b.bans(account);muted=b.timeouts(account)
        follows={str(x) for x in b.setting(account,'follows',[])}
        with b.db() as db:
            excluded={r[0] for r in db.execute('SELECT image FROM feed_exposure WHERE account=? AND (viewed>0 OR served>?)',(account,time.time()-7*86400))}
            excluded.update(r[0] for r in db.execute('SELECT DISTINCT image FROM observations WHERE account=? AND score>0',(account,)))
        excluded.update(str(i) for i in seen)
        loras={str(i['versionId']) for i in b.models.snapshot()['items'] if i.get('kind')=='loras' and i.get('versionId') and not i.get('archived')}
        candidates=[];expired=[];now=time.time()
        for i in state['items']:
            i.setdefault('bankExpiresAt',now+random.uniform(7,14)*86400)
            if i['bankExpiresAt']<=now:expired.append(i['id']);continue
            if i['id'] in excluded or b.is_banned(i,bans) or b.is_muted(i,muted):continue
            cause=i.get('chosenBy',{});kind=cause.get('kind')
            if kind=='tags' and (not all(t in weights['tags'] for t in cause.get('ids',[])) or not b.matches_tags(i,cause['ids'])):continue
            if kind=='creator' and str(cause.get('id')) not in weights['creators']:continue
            if kind=='lora' and str(cause.get('id')) not in loras:continue
            if kind=='curation' and str(cause.get('via',{}).get('id')) not in follows:continue
            if not i.get('fullPath') or not i.get('path'):continue
            i['following']=str(i.get('creatorId')) in follows;candidates.append(i);excluded.add(i['id'])
        recent=b.setting(account,'mix-artists',[])[-9:];ordered=[]
        while candidates:
            position=next((n for n,i in enumerate(candidates) if not any(set(b.artist_keys(i)).intersection(p) for p in recent)),None)
            if position is None:break
            item=candidates.pop(position);ordered.append(item);recent=(recent+[b.artist_keys(item)])[-9:]
        state['items']=ordered[:TARGET]
        if expired:
            # Expiry is not an impression. Permit the selector to find it again.
            with b.lock:
                with b.db() as db:
                    for row in db.execute('SELECT id,payload FROM feed_sessions WHERE account=?',(account,)).fetchall():
                        session=json.loads(row['payload'])
                        if not session.get('planning'):continue
                        session['seen']=[i for i in session.get('seen',[]) if i not in expired]
                        db.execute('UPDATE feed_sessions SET payload=? WHERE account=? AND id=?',(json.dumps(session),account,row['id']))
                        if row['id'] in b.feeds:b.feeds[row['id']]['seen']=session['seen']
        if len(ordered)<=LOW:state['filling']=True
        return state

    def kick(self, account, token):
        with self.lock:
            # Finish a bounded refill on the PC even if the phone leaves Browse.
            # Only phone transfers require the app foreground; no endless timer.
            self.leases[account]=max(self.leases.get(account,0),time.monotonic()+600)
            state=self.read(account)
            if len(state['items'])<=LOW:state['filling']=True;self.write(account,state)
            self.warm_media(account,token)
            if not state.get('filling') or state.get('retryAt',0)>time.time() or account in self.running:return
            self.running.add(account)
            threading.Thread(target=self.run,args=(account,token),daemon=True,name='civitai-feed-bank').start()

    def bootstrap(self):
        if not self.b.models.token():return
        try:
            me,token=self.b.account(cached=True);self.kick(me['id'],token)
        except (ValueError,OSError):pass

    def response(self, account, state, items):
        return dict(account=account,items=items,nextCursor='bank',bank=True,bankCount=len(state['items']),
                    bankTarget=TARGET,filling=bool(state.get('filling')),limited=not items,
                    retryAfter=max(2,min(60,int(state.get('retryAt',0)-time.time())+1)) if not items else 0,
                    sourceReads=0,scanned=0,filtered=0)

    def peek(self, query):
        me,token=self.b.account(cached=True);account=me['id']
        with self.lock:
            state=self.clean(account,self.read(account),query.get('seen',[])[:5000]);self.write(account,state)
            state['protected']=[i['id'] for i in state['items'][:WINDOW]];self.write(account,state)
            result=self.response(account,state,state['items'][:WINDOW])
        self.kick(account,token);return result

    def take(self, query):
        me,token=self.b.account(cached=True);account=me['id'];receipt=str(query.get('requestId',''))[:128]
        with self.lock:
            if receipt:
                with self.b.db() as db:row=db.execute('SELECT payload FROM bank_receipts WHERE account=? AND id=? AND stamp>?',(account,receipt,time.time()-7200)).fetchone()
                if row:return json.loads(row[0])
            state=self.clean(account,self.read(account),query.get('seen',[])[:5000])
            items=state['items'][:12];state['items']=state['items'][12:]
            if len(state['items'])<=LOW:state['filling']=True
            result=self.response(account,state,items)
            # Receipt, consumption and exposure reservation commit together. A
            # timeout/retry cannot consume a second page or mark banked posts seen.
            with self.b.db() as db:
                self.write(account,state,db)
                recent=self.b.setting(account,'mix-artists',[])
                recent=(recent+[self.b.artist_keys(i) for i in items])[-9:]
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'mix-artists',json.dumps(recent)))
                db.executemany('INSERT INTO feed_exposure(account,image,served) VALUES(?,?,?) ON CONFLICT(account,image) DO UPDATE SET served=excluded.served',[(account,i['id'],time.time()) for i in items])
                db.execute('DELETE FROM bank_receipts WHERE stamp<?',(time.time()-7200,))
                if receipt and items:db.execute('INSERT OR REPLACE INTO bank_receipts VALUES(?,?,?,?)',(account,receipt,json.dumps(result),time.time()))
        self.kick(account,token);return result

    def replenish_once(self, account, token):
        with self.lock:
            state=self.clean(account,self.read(account));self.write(account,state)
            if len(state['items'])>=TARGET:state['filling']=False;self.write(account,state);return 0
            if not state.get('filling'):return 0
            tail=(self.b.setting(account,'mix-artists',[])+[self.b.artist_keys(i) for i in state['items'][-9:]])[-9:]
            query=dict(channel='mix',cursor=state.get('cursor',''),seen=[i['id'] for i in state['items']])
        # Deliberately outside bank.lock: consumers can take ready posts during
        # an upstream timeout. The selector's existing 3-read budget still applies.
        with background_work(),self.b.mix_lock:
            result=self.b._feed(query,planning=True,artist_tail=tail)
        if self.b.models.token()!=token:return 0
        with self.lock:
            current=self.read(account);before=len(current['items'])
            # Keep the prepared/advertised head stable. Fresh selections go before
            # the old reserve, not behind it. Retain existing relative order.
            protected=set(current.get('protected',[]))
            head=[i for i in current['items'] if i['id'] in protected][:WINDOW]
            older=[i for i in current['items'] if i['id'] not in {h['id'] for h in head}]
            current['items']=head+result['items']+older;current['cursor']=result['nextCursor']
            current=self.clean(account,current)
            current['filling']=len(current['items'])<TARGET
            current['retryAt']=time.time()+result.get('retryAfter',0) if result.get('retryAfter') else 0
            self.write(account,current)
            self.warm_media(account,token)
            return max(0,len(current['items'])-before)

    def warm_media(self, account, token):
        # Caller holds the reentrant bank lock. One bounded 25-item window on PC.
        if account in self.media_running:return
        state=self.read(account);items=state['items'][:WINDOW]
        if not items:return
        state['protected']=[i['id'] for i in items];self.write(account,state)
        self.protected_keys={self.b.media_key(account,url,size) for i in items for size,url in i.get('mediaUrls',{}).items() if size in ('full','thumb')}
        self.media_running.add(account)
        def download(item):
            if self.b.models.token()!=token:return
            retry_key=(account,item['id'])
            if self.media_retry.get(retry_key,0)>time.time():return
            for size in ('thumb','full'):
                if self.b.models.token()!=token:return
                try:self.b.media_file(account,item['id'],size)
                except (OSError,ValueError):self.media_retry[retry_key]=time.time()+60;return
        def run():
            try:
                with ThreadPoolExecutor(max_workers=2,thread_name_prefix='civitai-media-bank') as pool:list(pool.map(download,items))
            finally:
                with self.lock:
                    self.media_running.discard(account)
                    if self.leases.get(account,0)>time.monotonic() and [i['id'] for i in self.read(account)['items'][:WINDOW]]!=[i['id'] for i in items]:self.warm_media(account,token)
        threading.Thread(target=run,daemon=True,name='civitai-media-window').start()

    def run(self, account, token):
        try:
            empty=0
            while self.leases.get(account,0)>time.monotonic() and self.b.models.token()==token:
                state=self.read(account)
                if not state.get('filling'):break
                if state.get('retryAt',0)>time.time():
                    time.sleep(max(0,min(5,state['retryAt']-time.time())));continue
                try:added=self.replenish_once(account,token)
                except (Deferred,ValueError,OSError) as error:
                    with self.lock:
                        state=self.read(account);state['retryAt']=time.time()+getattr(error,'retry_after',30);self.write(account,state)
                    continue
                empty=0 if added else empty+1
                if empty>=3:
                    with self.lock:
                        state=self.read(account);state['retryAt']=time.time()+30;self.write(account,state)
                    empty=0;continue
                # Bounded background pace; no timer/service remains when idle.
                time.sleep(1 if added else 3)
        finally:
            with self.lock:self.running.discard(account)
