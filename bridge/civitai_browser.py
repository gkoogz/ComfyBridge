"""Account-scoped Civitai browsing, explicit social actions and resumable preferences.

No GPU work. The account key stays on the PC. Import advances only while a
foreground browser renews its lease. Reads never create Civitai interactions.
"""
from contextlib import contextmanager
import hashlib
import json
import random
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from PIL import Image
from model_library import CivitaiRedirect, request_for

REACTIONS = ('Like', 'Heart', 'Laugh', 'Cry')
CDN = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/'


def ident(value):
    if isinstance(value, bool) or not re.fullmatch(r'[1-9][0-9]{0,14}', str(value or '')):
        raise ValueError('Invalid Civitai identifier')
    return int(value)


def cdn(value, variant='width=640'):
    value = str(value or '')
    if re.fullmatch(r'[a-fA-F0-9-]{36}', value):
        value = CDN + value + '/' + variant
    p = urllib.parse.urlparse(value)
    if p.scheme != 'https' or p.hostname not in ('image.civitai.com', 'image.civitai.red', 'imagecache.civitai.com', 'blobs-b2.civitai.com', 'blobs.civitai.com') or p.username or p.password or p.port not in (None, 443):
        return ''
    return value


class Browser:
    def __init__(self, data, models, gallery, transport=None):
        self.data = Path(data) / 'civitai-browser'
        self.data.mkdir(exist_ok=True)
        self.models, self.gallery, self.transport = models, gallery, transport
        self.lock = threading.RLock()
        self.network = threading.Lock()
        self.action_lock = threading.Lock()
        self.media_lock = threading.Lock()
        self.identity = None
        self.leases = {}
        self.running = set()
        self.feeds = {}
        self.next_request = 0
        with self.db() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS settings(account TEXT,key TEXT,value TEXT,PRIMARY KEY(account,key));
              CREATE TABLE IF NOT EXISTS media(account TEXT,id TEXT,payload TEXT,touched REAL,PRIMARY KEY(account,id));
              CREATE TABLE IF NOT EXISTS observations(account TEXT,source TEXT,image TEXT,creator TEXT,tags TEXT,score REAL,stamp TEXT,PRIMARY KEY(account,source,image));
              CREATE TABLE IF NOT EXISTS actions(account TEXT,id TEXT,payload TEXT,state TEXT,result TEXT,PRIMARY KEY(account,id));
            ''')

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.data / 'browser.sqlite', timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def setting(self, account, key, default=None):
        with self.db() as db:
            row = db.execute('SELECT value FROM settings WHERE account=? AND key=?', (account, key)).fetchone()
        return json.loads(row[0]) if row else default

    def save(self, account, key, value):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', (account, key, json.dumps(value)))

    def call(self, token, route, value=None, write=False, rest=False):
        if self.transport:
            return self.transport(token, route, value, write, rest)
        with self.network:
            if self.next_request - time.monotonic() > 2:
                raise ValueError('Civitai is rate limiting requests. Please wait before retrying.')
            time.sleep(max(0, self.next_request - time.monotonic()))
            self.next_request = time.monotonic() + .2
            url = 'https://civitai.red/api/' + ('v1/' if rest else 'trpc/') + route
            body = None
            if rest:
                if value:
                    url += '?' + urllib.parse.urlencode(value)
            elif write:
                body = json.dumps({'json': value}, separators=(',', ':')).encode()
            else:
                url += '?' + urllib.parse.urlencode({'input': json.dumps({'json': value}, separators=(',', ':'))})
            req = request_for(url, token)
            req.add_header('User-Agent', 'ComfyBridge-Browse/1.0')
            if body is not None:
                req.data = body
                req.add_header('Content-Type', 'application/json')
            try:
                with urllib.request.build_opener(CivitaiRedirect()).open(req, timeout=25) as response:
                    raw = response.read(16 * 1024 * 1024 + 1)
                    if len(raw) > 16 * 1024 * 1024:
                        raise ValueError('Civitai response is too large. Try a smaller page.')
                    result = json.loads(raw)
            except urllib.error.HTTPError as error:
                if error.code == 429:
                    try: delay = min(300, max(5, int(error.headers.get('Retry-After', 30))))
                    except ValueError: delay = 30
                    self.next_request = time.monotonic() + delay
                    raise ValueError('Civitai is rate limiting requests. Please wait before retrying.') from None
                if error.code in (401, 403):
                    raise ValueError('Civitai denied access. Check the desktop API key, its permissions and your account setup.') from None
                raise ValueError('Civitai request failed (HTTP %s). Please retry.' % error.code) from None
            except (OSError, TimeoutError):
                raise ValueError('Civitai could not be reached. Your saved preferences are kept.') from None
            if rest:
                return result
            if 'error' in result:
                raise ValueError('Civitai could not complete this request.')
            data = result.get('result', {}).get('data', {})
            return data.get('json', data) if isinstance(data, dict) else data

    def account(self):
        token = self.models.token()
        if not token:
            self.identity = None
            raise ValueError('Add your Civitai API key in the Windows bridge gear to connect Browse.')
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            if not self.identity or self.identity['digest'] != digest or time.time() - self.identity['checked'] > 300:
                me = self.call(token, 'me', rest=True)
                self.identity = dict(id=str(ident(me['id'])), username=str(me['username']), digest=digest, checked=time.time())
            return dict(self.identity), token

    def assert_account(self, account, token):
        if self.models.token() != token:
            raise ValueError('Civitai account changed. Refresh Browse before continuing.')

    def user_url(self, name):
        return 'https://civitai.com/user/' + urllib.parse.quote(str(name), safe='')

    def remember(self, account, raw):
        image_id = str(ident(raw['id']))
        meta = raw.get('meta') if isinstance(raw.get('meta'), dict) else {}
        user = raw.get('user') or {}
        kind = raw.get('type', 'image')
        if kind not in ('image', 'video'):
            return None
        original = cdn(raw.get('url'), 'original=true' if kind == 'image' else 'transcode=true')
        thumb = cdn(raw.get('thumbnailUrl') or (raw.get('thumbnail') or {}).get('url'))
        if not thumb:
            thumb = cdn(raw.get('url'), 'width=640' if kind == 'image' else 'anim=false,width=640')
            if kind=='video' and re.fullmatch(r'[a-fA-F0-9-]{36}',str(raw.get('url',''))):
                thumb=CDN+raw['url']+'/anim=false,transcode=true,optimized=true/'+raw['url']+'.jpeg'
                original=CDN+raw['url']+'/original=true/'+raw['url']+'.mp4'
        avatar = user.get('image') or user.get('avatarUrl')
        if isinstance(avatar, dict): avatar = avatar.get('url')
        reactions = raw.get('reactions') or []
        reactions = [r.get('reaction') if isinstance(r, dict) else r for r in reactions]
        prefix = 'model-preview/browse/' + account + '/' + image_id + '/'
        resources = []
        seen = set()
        for r in (meta.get('civitaiResources') or []) + (meta.get('resources') or []):
            if not isinstance(r, dict): continue
            vid = str(r.get('modelVersionId') or '')
            if vid in seen or not vid.isdigit(): continue
            seen.add(vid)
            resources.append(dict(versionId=vid, modelId=str(r.get('modelId') or ''), name=str(r.get('name') or r.get('modelName') or ''), type=str(r.get('type') or 'Resource'), weight=r.get('weight', '')))
        tags = [dict(id=ident(t['id']), name=str(t.get('name', '')), score=t.get('score', 0), upVotes=t.get('upVotes', 0), downVotes=t.get('downVotes', 0), vote=t.get('vote', 0)) for t in raw.get('tags', []) if isinstance(t, dict) and t.get('id')]
        item = dict(id=image_id, type=kind, width=raw.get('width') or 512, height=raw.get('height') or 768, duration=(raw.get('metadata') or {}).get('duration'),
                    prompt=str(meta.get('prompt') or ''), negativePrompt=str(meta.get('negativePrompt') or ''),
                    created=str(raw.get('createdAt') or ''), credit=str(user.get('username') or raw.get('username') or ''),
                    creatorId=str(user.get('id') or ''), path=prefix+'thumb', fullPath=prefix+'full', avatarPath=prefix+'avatar' if cdn(avatar) else '',
                    imageUrl='https://civitai.com/images/'+image_id, resources=resources, tags=tags, reactions=reactions,
                    stats=raw.get('stats') or {}, parameters={k:meta[k] for k in ('seed','steps','cfgScale','sampler','Size','Model','Clip skip') if k in meta},
                    _urls=dict(thumb=thumb, full=original, avatar=cdn(avatar, 'width=96')))
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO media VALUES(?,?,?,?)', (account, image_id, json.dumps(item), time.time()))
        return item

    @staticmethod
    def public(item):
        return {k:v for k,v in item.items() if not k.startswith('_')}

    def stored(self, account, image_id):
        with self.db() as db:
            row = db.execute('SELECT payload FROM media WHERE account=? AND id=?', (account, str(ident(image_id)))).fetchone()
        return json.loads(row[0]) if row else None

    def images(self, account, token, filters, limit=20, meta=True):
        raw = self.call(token, 'image.getInfinite', {'limit':limit, 'browsingLevel':31, 'withMeta':meta, 'withTags':True, **filters})
        items = [self.remember(account, x) for x in raw.get('items', [])]
        return [i for i in items if i], raw.get('nextCursor')

    def collections(self, account, token, refresh=False):
        old = self.setting(account, 'collections', {})
        if not refresh and time.time() - old.get('checked', 0) < 300:
            return old.get('items', [])
        raw = self.call(token, 'collection.getAllUser', {'contributingOnly':False})
        bookmarks = self.call(token, 'user.getBookmarkCollections')
        bookmark_ids={c['id'] for c in bookmarks if c.get('type')=='Image'}
        items = []
        for c in raw:
            if c.get('type') != 'Image' or not c.get('isOwner') or c.get('archivedAt'): continue
            counts = self.call(token, 'collection.getEntryCount', {'id':ident(c['id'])})
            items.append(dict(id=ident(c['id']), name=str(c['name']), count=counts.get('ACCEPTED', 0), bookmark=c['id'] in bookmark_ids))
        items.sort(key=lambda c:c['count'], reverse=True)
        self.save(account, 'collections', dict(items=items, checked=time.time()))
        return items

    def observe(self, account, source, item, score, stamp):
        tags = json.dumps({str(t['id']):t['name'] for t in item.get('tags', [])})
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?,?,?)',
                       (account, source, str(item['id']), item.get('creatorId', ''), tags, score, stamp))

    def learned_weights(self, account):
        creators, tags, names = {}, {}, {}
        follows = self.setting(account, 'follows', [])
        for uid in follows: creators[str(uid)] = 2.0
        with self.db() as db:
            for r in db.execute('SELECT creator,tags,score,source FROM observations WHERE account=?', (account,)):
                if r['creator']: creators[r['creator']] = creators.get(r['creator'], 0) + r['score']
                for tid, name in json.loads(r['tags']).items():
                    tags[tid] = tags.get(tid, 0) + r['score']; names[tid] = name
        return dict(creators=creators, tags=tags, names=names)

    def preference_rows(self, account):
        learned = self.learned_weights(account)
        overrides = self.setting(account, 'weight-overrides', {})
        with self.db() as db:
            creators = {str(r[0]): r[1] for r in db.execute(
                "SELECT json_extract(payload,'$.creatorId'), json_extract(payload,'$.credit') FROM media WHERE account=? ORDER BY touched",
                (account,)) if r[0] and r[1]}
        rows = []
        for kind, group in (('creator', 'creators'), ('tag', 'tags')):
            for item_id, base in learned[group].items():
                change = overrides.get(kind + ':' + item_id, {})
                name = creators.get(item_id, 'Creator ' + item_id) if kind == 'creator' else learned['names'].get(item_id, 'Tag ' + item_id)
                rows.append(dict(kind=kind, id=item_id, name=name, weight=max(0, base + change.get('offset', 0)),
                                 disabled=bool(change.get('disabled')), base=base))
        return sorted(rows, key=lambda r: (r['disabled'], -r['weight'], r['name'].casefold()))

    def preferences(self):
        me, token = self.account()
        rows = self.preference_rows(me['id'])
        unresolved = [r for r in rows if r['kind']=='creator' and r['name']=='Creator '+r['id']]
        for row in unresolved[:10]:
            try:
                self.images(me['id'], token, {'userId':int(row['id']), 'sort':'Newest'}, 1, meta=False)
            except ValueError:
                break
        return dict(account=me['id'], items=self.preference_rows(me['id']))

    def weights(self, account):
        rows = self.preference_rows(account)
        return dict(creators={r['id']:r['weight'] for r in rows if r['kind']=='creator' and not r['disabled'] and r['weight']>0},
                    tags={r['id']:r['weight'] for r in rows if r['kind']=='tag' and not r['disabled'] and r['weight']>0},
                    names={r['id']:r['name'] for r in rows if r['kind']=='tag'})

    def status(self, active=True):
        me, token = self.account(); account=me['id']
        collections = self.collections(account, token)
        # Establish relationships before serving the very first feed. The history
        # importer is asynchronous; otherwise a well-connected new account would
        # incorrectly get a full page of LoRA filler on its first visit.
        if self.setting(account, 'follows') is None:
            follows = self.call(token, 'user.getFollowingUsers')
            self.save(account, 'follows', [ident(x['id'] if isinstance(x, dict) else x) for x in follows])
        with self.lock:
            if active:
                self.leases[account] = time.monotonic()+45
                if account not in self.running:
                    self.running.add(account)
                    threading.Thread(target=self.import_loop, args=(account, token), daemon=True, name='civitai-preferences').start()
        state = self.setting(account, 'import', {})
        with self.db() as db:
            count = db.execute('SELECT COUNT(DISTINCT image) FROM observations WHERE account=?', (account,)).fetchone()[0]
        return dict(account=account, username=me['username'], profile=self.user_url(me['username']), collections=collections,
                    timeouts=self.timeouts(account), importState=state, learned=count, follows=len(self.setting(account, 'follows', [])))

    def import_loop(self, account, token):
        try:
            state = self.setting(account, 'import', {})
            if state.get('complete') and time.time()-state.get('finished', 0)<86400: return
            if not state.get('sources') or state.get('complete'):
                sources = ['reactions'] + ['collection:'+str(c['id']) for c in self.collections(account, token)]
                state = dict(sources=sources, index=0, cursor=None, processed=0, complete=False, stamp=str(time.time()))
                follows = self.call(token, 'user.getFollowingUsers')
                self.save(account, 'follows', [ident(x['id'] if isinstance(x, dict) else x) for x in follows])
                self.save(account, 'import', state)
            state.pop('error', None)
            while self.leases.get(account, 0)>time.monotonic() and self.models.token()==token:
                if state['index'] >= len(state['sources']):
                    state.update(complete=True, finished=time.time(), label='Preferences up to date')
                    self.save(account, 'import', state);break
                source=state['sources'][state['index']]
                filters = {'reactions':list(REACTIONS)} if source=='reactions' else {'collectionId':int(source.split(':')[1])}
                filters['sort']='Newest'
                if state.get('cursor') is not None: filters['cursor']=state['cursor']
                state['label']='Learning from your reactions' if source=='reactions' else 'Learning from your collections'
                items, cursor=self.images(account, token, filters, 40, meta=False)
                for item in items:
                    score=max(1,len([r for r in item['reactions'] if r in REACTIONS])) if source=='reactions' else 1
                    self.observe(account, source, item, score, state['stamp'])
                state['processed']+=len(items)
                if cursor is not None and cursor==state.get('cursor'):
                    raise ValueError('Civitai repeated a page cursor. Import paused; retry later.')
                state['cursor']=cursor
                if cursor is None:
                    with self.db() as db:
                        db.execute('DELETE FROM observations WHERE account=? AND source=? AND CAST(stamp AS REAL)<?', (account, source, float(state['stamp'])))
                    state['index']+=1
                self.save(account, 'import', state)
                time.sleep(.8)
        except Exception as error:
            state=self.setting(account, 'import', locals().get('state', {}))
            state['error']=str(error) if isinstance(error, ValueError) else 'Preference import paused. Reopen Browse to retry.'
            self.save(account, 'import', state)
        finally:
            with self.lock:self.running.discard(account)

    def feed(self, query):
        me, token=self.account(); account=me['id']; cursor=query.get('cursor',''); channel=query.get('channel','mix')
        with self.lock:
            self.feeds={k:v for k,v in self.feeds.items() if time.time()-v['touched']<1800}
            if cursor:
                state=self.feeds.get(cursor)
                if not state or state['account']!=account or state['channel']!=channel:
                    raise ValueError('This feed expired. Refresh Browse.')
            else:
                cursor=uuid.uuid4().hex
                loras=[i for i in self.models.snapshot()['items'] if i.get('kind')=='loras' and i.get('versionId') and not i.get('archived')]
                state=dict(account=account,channel=channel,touched=time.time(),seen=[],sources={},loras=loras,turn=0,lora=0, lock=threading.Lock())
                self.feeds[cursor]=state
        with state['lock']:
            state['touched']=time.time();out=[];weights=self.weights(account)
            muted=self.timeouts(account) if channel=='mix' else {}
            weights['creators']={k:v for k,v in weights['creators'].items() if k not in muted}
            follows=[uid for uid in self.setting(account,'follows',[]) if str(uid) in weights['creators']]
            rich=bool(follows or weights['creators'] or weights['tags'])
            for attempt in range(36 if channel=='mix' else 2):
                if len(out)>=12:break
                if channel=='mix':
                    # Relationship sources dominate. LoRA samples occupy only one in
                    # ten slots once preferences exist, or fill empty source pages.
                    slot=state['turn']%10;state['turn']+=1
                    if (slot==9 or not rich or state.get('empty',0)>=3) and state['loras']:
                        item=state['loras'][state['lora']%len(state['loras'])];state['lora']+=1
                        key='lora:'+str(item['versionId']);filters={'modelVersionId':int(item['versionId']),'sort':'Most Reactions'};reason='From '+item['title']
                    elif slot in (0,2,4,6) and follows:
                        uid=random.choices(follows, weights=[weights['creators'][str(u)] for u in follows])[0]
                        key='creator:'+str(uid);filters={'userId':int(uid),'sort':'Newest'};reason='Creators you follow'
                    elif (slot in (1,3,5) or not weights['tags']) and weights['creators']:
                        uid=random.choices(list(weights['creators']),weights=list(weights['creators'].values()))[0]
                        key='creator:'+uid;filters={'userId':int(uid),'sort':'Newest'};reason='A creator you enjoy'
                    elif weights['tags']:
                        tag=random.choices(list(weights['tags']),weights=list(weights['tags'].values()))[0]
                        key='tag:'+tag;filters={'tags':[int(tag)],'sort':'Newest'};reason='Because you enjoy '+weights['names'][tag]
                    else:key='discover';filters={'sort':'Newest'};reason='Discover something new'
                elif channel.startswith(('creator:', 'tag:')):
                    parts=channel.split(':')
                    if len(parts)!=3 or parts[2] not in ('all','image','video'):raise ValueError('Invalid feed filter')
                    subject=ident(parts[1]);key=channel;reason=''
                    filters={'sort':'Newest', **({'userId':subject} if parts[0]=='creator' else {'tags':[subject]})}
                    if parts[2]!='all':filters['types']=[parts[2]]
                elif channel=='reactions':key=channel;filters={'reactions':list(REACTIONS),'sort':'Newest'};reason='Your reactions'
                elif channel.startswith('collection:'):
                    cid=ident(channel.split(':')[1])
                    if cid not in [c['id'] for c in self.collections(account,token)]:raise ValueError('Select one of your media collections.')
                    key=channel;filters={'collectionId':cid,'sort':'Newest'};reason='From your collection'
                else:raise ValueError('Unknown feed')
                if key not in state['sources']:
                    cached=[]
                    if key.startswith('lora:') and hasattr(self.models,'db'):
                        # Reuse gallery metadata and the same phone cache keys before
                        # asking Civitai for another page of this LoRA's examples.
                        try:
                            with self.models.db() as db:
                                rows=db.execute('SELECT payload FROM gallery_images WHERE asset=? ORDER BY touched DESC LIMIT 3',(item['id'],)).fetchall()
                            for row in rows:
                                sample=json.loads(row['payload'])
                                raw=dict(id=sample['id'],url=sample['source'],width=sample['width'],height=sample['height'],username=sample.get('credit',''),
                                    meta=dict(prompt=sample.get('prompt',''),negativePrompt=sample.get('negativePrompt',''),resources=[dict(modelVersionId=r.get('versionId'),modelId=r.get('modelId'),type=r.get('type'),name=r.get('name'),weight=r.get('weight')) for r in sample.get('resources',[])]))
                                seed=self.remember(account,raw)
                                seed.update(cacheAsset={k:item[k] for k in ('id','kind','name')},cacheSample=sample)
                                cached.append(seed)
                        except (sqlite3.Error,KeyError,ValueError):pass
                    state['sources'][key]=dict(items=cached,cursor=None,started=False,done=False)
                source=state['sources'][key]
                if not source['items'] and not source['done']:
                    if source['cursor'] is not None:filters['cursor']=source['cursor']
                    items,nxt=self.images(account,token,filters,12)
                    source.update(items=items,cursor=nxt,started=True,done=nxt is None)
                take=1 if channel=='mix' else 12
                before=len(out)
                for _ in range(take):
                    if not source['items']:break
                    item=source['items'].pop(0)
                    if self.is_muted(item,muted):continue
                    if item['id'] in state['seen']:continue
                    state['seen'].append(item['id']);out.append(dict(self.public(item),reason=reason))
                state['empty']=state.get('empty',0)+1 if len(out)==before else 0
            state['seen']=state['seen'][-5000:]
            ended=channel!='mix' and all(s['done'] and not s['items'] for s in state['sources'].values())
            return dict(account=account,items=out,nextCursor=None if ended else cursor)

    def timeouts(self, account):
        return {k:v for k,v in self.setting(account,'creator-timeouts',{}).items() if v.get('until',0)>time.time()}

    @staticmethod
    def is_muted(item, muted):
        return str(item.get('creatorId','')) in muted or any(
            v.get('name') and v['name'].casefold()==item.get('credit','').casefold() for v in muted.values())

    def detail(self, image_id):
        me, token=self.account();account=me['id'];image_id=str(ident(image_id))
        items,_=self.images(account,token,{'imageId':int(image_id)},1)
        if not items:raise ValueError('This media is no longer available to your account.')
        item=items[0]
        raw=self.call(token,'image.getResources',{'id':int(image_id)})
        strengths={r['versionId']:r.get('weight','') for r in item['resources']}
        item['resources']=[dict(versionId=str(r.get('modelVersionId') or ''),modelId=str(r.get('modelId') or ''),
            name=str(r.get('modelName') or r.get('name') or 'Resource'),version=str(r.get('modelVersionName') or ''),type=str(r.get('modelType') or 'Resource'),weight=strengths.get(str(r.get('modelVersionId') or ''),'')) for r in raw]
        follows=self.call(token,'user.getFollowingUsers')
        follows=[str(x.get('id') if isinstance(x,dict) else x) for x in follows]
        self.save(account,'follows',follows)
        item['following']=item['creatorId'] in follows
        item['tags']=self.call(token,'tag.getVotableTags',{'type':'image','id':int(image_id)})
        memberships=self.call(token,'collection.getUserCollectionItemsByItem',{'imageId':int(image_id)})
        item['collections']=memberships
        with self.db() as db:db.execute('UPDATE media SET payload=? WHERE account=? AND id=?',(json.dumps(item),account,image_id))
        return dict(account=account,item=self.public(item),collections=self.collections(account,token))

    def action(self, payload):
        me,token=self.account();account=me['id']
        if str(payload.get('account'))!=account:raise ValueError('Civitai account changed. Refresh before continuing.')
        request_id=str(uuid.UUID(payload.get('requestId','')))
        body=json.dumps(payload,sort_keys=True)
        kind=payload.get('kind')
        with self.action_lock:
            with self.db() as db:
                old=db.execute('SELECT * FROM actions WHERE account=? AND id=?',(account,request_id)).fetchone()
                if old:
                    if old['payload']!=body:raise ValueError('Action identifier was already used.')
                    if old['state']=='done':return json.loads(old['result'])
                    if kind=='create':raise ValueError('Collection creation was already attempted. Refresh your collections before trying again.')
                else:db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(account,request_id,body,'started',''))
            self.assert_account(account,token)
            if kind=='timeout':
                uid=str(ident(payload.get('creatorId')))
                muted=self.timeouts(account)
                muted[uid]=dict(until=time.time()+7200,name=str(payload.get('name',''))[:200])
                result=dict(ok=True,creatorId=uid,**muted[uid])
                with self.db() as db:
                    db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'creator-timeouts',json.dumps(muted)))
                    db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?',('done',json.dumps(result),account,request_id))
                return result
            elif kind=='preference':
                subject = payload.get('subject')
                item_id = str(ident(payload.get('id')))
                row = next((r for r in self.preference_rows(account) if r['kind']==subject and r['id']==item_id), None)
                if row is None:raise ValueError('This preference is no longer tracked. Refresh the list.')
                overrides = self.setting(account, 'weight-overrides', {})
                key = subject + ':' + item_id
                change = overrides.get(key, {})
                if 'delta' in payload:
                    delta = payload['delta']
                    if type(delta) is not int or delta not in (-1,1):raise ValueError('Invalid weight adjustment')
                    change['offset'] = max(0, row['weight'] + delta) - row['base']
                elif type(payload.get('disabled')) is bool:
                    change['disabled'] = payload['disabled']
                else:raise ValueError('Choose a weight adjustment or disable state')
                overrides[key] = change
                # Commit the adjustment and retry receipt together.
                result = dict(ok=True)
                with self.db() as db:
                    db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', (account, 'weight-overrides', json.dumps(overrides)))
                    db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?', ('done',json.dumps(result),account,request_id))
                return result
            elif kind=='create':
                name=str(payload.get('name','')).strip()
                if not name or len(name)>30:raise ValueError('Collection names must be 1–30 characters.')
                self.call(token,'collection.upsert',{'name':name,'type':'Image','read':'Private','write':'Private'},True)
                result=dict(ok=True,collections=self.collections(account,token,True))
            elif kind=='follow':
                uid=ident(payload.get('creatorId'));desired=payload.get('selected')
                if type(desired) is not bool:raise ValueError('Choose follow or unfollow.')
                def current():return [str(x.get('id') if isinstance(x,dict) else x) for x in self.call(token,'user.getFollowingUsers')]
                follows=current()
                if (str(uid) in follows)!=desired:self.call(token,'user.toggleFollow',{'targetUserId':uid},True)
                follows=current()
                if (str(uid) in follows)!=desired:raise ValueError('Follow change is not confirmed yet. Refresh before retrying.')
                self.save(account,'follows',follows);result=dict(ok=True,selected=desired)
            else:
                iid=ident(payload.get('imageId'));item=self.stored(account,iid)
                if not item:raise ValueError('Open this media before interacting with it.')
                if kind=='reaction':
                    reaction=payload.get('reaction');desired=payload.get('selected')
                    if reaction not in REACTIONS or type(desired) is not bool:raise ValueError('Invalid reaction')
                    def current():
                        raw=self.call(token,'reaction.getMyImageReactions',{'imageIds':[iid]}).get(str(iid),[])
                        return [r.get('reaction') if isinstance(r,dict) else r for r in raw]
                    values=current()
                    if (reaction in values)!=desired:self.call(token,'reaction.toggle',{'entityId':iid,'entityType':'image','reaction':reaction},True)
                    values=current()
                    if (reaction in values)!=desired:raise ValueError('Reaction is not confirmed yet. Refresh before retrying.')
                    self.observe(account,'reactions',item,len([r for r in values if r in REACTIONS]),str(time.time()))
                    result=dict(ok=True,reactions=values)
                elif kind=='collect':
                    cid=ident(payload.get('collectionId'));desired=payload.get('selected')
                    if type(desired) is not bool or cid not in [c['id'] for c in self.collections(account,token)]:raise ValueError('Select one of your collections.')
                    self.call(token,'collection.saveItem',dict(imageId=iid,collections=[{'collectionId':cid}] if desired else [],removeFromCollectionIds=[] if desired else [cid]),True)
                    memberships=self.call(token,'collection.getUserCollectionItemsByItem',{'imageId':iid})
                    present=any(int(c.get('collectionId',0))==cid for c in memberships)
                    if present!=desired:raise ValueError('Collection change is not confirmed yet. Refresh before retrying.')
                    self.observe(account,'collection:'+str(cid),item,1 if desired else 0,str(time.time()))
                    self.save(account,'collections',{})
                    result=dict(ok=True,selected=desired)
                elif kind=='vote':
                    tid=ident(payload.get('tagId'));vote=payload.get('vote')
                    if type(vote) is not int or vote not in (-1,0,1):raise ValueError('Invalid vote')
                    tags=item.get('tags',[]);tag=next((t for t in tags if int(t['id'])==tid),None)
                    if not tag:raise ValueError('Refresh the tags before voting.')
                    self.call(token,'tag.addTagVotes',{'type':'image','id':iid,'tags':[tid],'vote':vote},True)
                    self.observe(account,'vote:'+str(tid),dict(id=str(iid),tags=[tag]),vote,str(time.time()))
                    result=dict(ok=True,vote=vote)
                else:raise ValueError('Unknown Civitai action')
            with self.db() as db:
                db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?',('done',json.dumps(result),account,request_id))
            return result

    def media_file(self, account, image_id, size):
        me,token=self.account()
        if account!=me['id'] or size not in ('thumb','full','avatar'):raise FileNotFoundError()
        item=self.stored(account,image_id)
        url=(item or {}).get('_urls',{}).get(size,'')
        if not url:raise FileNotFoundError('Media unavailable')
        key=hashlib.sha256((account+'|'+url).encode()).hexdigest()
        folder=self.data/'media';folder.mkdir(exist_ok=True)
        is_video=size=='full' and item['type']=='video'
        path=folder/(key+('.mp4' if is_video else '.jpg'))
        with self.media_lock:
            if path.is_file():path.touch();return path
            temp=path.with_suffix('.tmp');converted=path.with_suffix('.converted.tmp')
            try:
                # No authorization header on CDN requests. Never accept arbitrary hosts/redirects.
                class SafeCDN(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self,req,fp,code,msg,headers,newurl):
                        if not cdn(newurl):raise ValueError('Untrusted media redirect')
                        return super().redirect_request(req,fp,code,msg,headers,newurl)
                with urllib.request.build_opener(SafeCDN()).open(urllib.request.Request(url,headers={'User-Agent':'ComfyBridge-Browse/1.0'}),timeout=30) as response, temp.open('wb') as out:
                    total=0
                    while True:
                        chunk=response.read(256*1024)
                        if not chunk:break
                        total+=len(chunk)
                        if total>(256 if is_video else 32)*1024*1024:raise ValueError('This preview exceeds the media download limit.')
                        out.write(chunk)
                if is_video:temp.replace(path)
                else:
                    with Image.open(temp) as im:
                        im.thumbnail((2048,2048) if size=='full' else (640,640));im.convert('RGB').save(converted,'JPEG',quality=90)
                    converted.replace(path)
                files=sorted(folder.glob('*.*'),key=lambda f:f.stat().st_mtime,reverse=True);total=0
                for f in files:
                    total+=f.stat().st_size
                    if total>1024*1024*1024 and f!=path and f.suffix!='.tmp':f.unlink(missing_ok=True)
                return path
            finally:
                temp.unlink(missing_ok=True);converted.unlink(missing_ok=True)
