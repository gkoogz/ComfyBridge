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
from civitai_requests import before, governor, Deferred, background_work
from civitai_requests import context as request_context
import api_debug
from feed_bank import FeedBank
from social_outbox import SocialOutbox

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
        if not transport:
            governor.configure(self.data.parent/'civitai-api-backoff.json')
            api_debug.configure(self.data.parent)
        self.lock = threading.RLock()
        self.network = threading.Lock()
        self.action_lock = threading.RLock()
        self.collections_lock = threading.RLock()
        self.follows_lock = threading.RLock()
        self.mix_lock = threading.Lock()
        self.media_lock = threading.Lock()
        self.cache_locks=[threading.RLock() for _ in range(64)]
        self.identity = None
        self.leases = {}
        self.running = set()
        self.feeds = {}
        self.next_request = 0
        self.media_locks=[threading.Lock() for _ in range(64)]
        with self.db() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS settings(account TEXT,key TEXT,value TEXT,PRIMARY KEY(account,key));
              CREATE TABLE IF NOT EXISTS media(account TEXT,id TEXT,payload TEXT,touched REAL,PRIMARY KEY(account,id));
              CREATE TABLE IF NOT EXISTS observations(account TEXT,source TEXT,image TEXT,creator TEXT,tags TEXT,score REAL,stamp TEXT,PRIMARY KEY(account,source,image));
              CREATE TABLE IF NOT EXISTS actions(account TEXT,id TEXT,payload TEXT,state TEXT,result TEXT,PRIMARY KEY(account,id));
              CREATE TABLE IF NOT EXISTS feed_sessions(account TEXT,id TEXT,channel TEXT,payload TEXT,touched REAL,PRIMARY KEY(account,id));
              CREATE TABLE IF NOT EXISTS feed_exposure(account TEXT,image TEXT,viewed REAL NOT NULL DEFAULT 0,served REAL NOT NULL DEFAULT 0,PRIMARY KEY(account,image));
              CREATE TABLE IF NOT EXISTS api_cache(identity TEXT,route TEXT,key TEXT,payload TEXT,expires REAL,PRIMARY KEY(identity,route,key));
              CREATE TABLE IF NOT EXISTS collection_members(account TEXT,collection TEXT,image TEXT,present INTEGER,local_updated REAL DEFAULT 0,seen REAL DEFAULT 0,missing INTEGER DEFAULT 0,PRIMARY KEY(account,collection,image));
              CREATE INDEX IF NOT EXISTS collection_members_image ON collection_members(account,image);
              CREATE TABLE IF NOT EXISTS social_members(account TEXT,kind TEXT,subject TEXT,value TEXT,present INTEGER,local_updated REAL DEFAULT 0,seen REAL DEFAULT 0,missing INTEGER DEFAULT 0,PRIMARY KEY(account,kind,subject,value));
            ''')
            if not db.execute("SELECT 1 FROM settings WHERE account='' AND key='social-index-migrated'").fetchone():
                for row in db.execute("SELECT account,value FROM settings WHERE key='follows'").fetchall():
                    for uid in json.loads(row['value']):db.execute("INSERT OR IGNORE INTO social_members(account,kind,subject,value,present) VALUES(?,'follow',?,'',1)",(row['account'],str(uid)))
                for row in db.execute('SELECT account,id,payload FROM media').fetchall():
                    try:cached=json.loads(row['payload'])
                    except (ValueError,TypeError):continue # A broken media cache entry must not block startup.
                    for reaction in cached.get('reactions',[]) or []:
                        if reaction in REACTIONS:db.execute("INSERT OR IGNORE INTO social_members(account,kind,subject,value,present) VALUES(?,'reaction',?,?,1)",(row['account'],row['id'],reaction))
                db.execute("INSERT INTO settings VALUES('','social-index-migrated','true')")
            if not db.execute("SELECT 1 FROM settings WHERE account='' AND key='collection-index-migrated'").fetchone():
                # Seed from existing durable data before any network refresh.
                db.execute("INSERT OR IGNORE INTO collection_members(account,collection,image,present) SELECT account,substr(source,12),image,1 FROM observations WHERE source LIKE 'collection:%' AND score>0")
                for row in db.execute('SELECT account,id,payload FROM media').fetchall():
                    try:cached=json.loads(row['payload'])
                    except (ValueError,TypeError):continue
                    for member in cached.get('collections',[]) or []:
                        if member.get('collectionId'):db.execute('INSERT OR IGNORE INTO collection_members(account,collection,image,present) VALUES(?,?,?,1)',(row['account'],str(member['collectionId']),row['id']))
                db.execute("INSERT INTO settings VALUES('','collection-index-migrated','true')")
            db.execute('DELETE FROM api_cache WHERE expires<?',(time.time(),))
            # Upgrade existing sessions as recently offered, not proven viewed.
            for row in db.execute("SELECT account,payload,touched FROM feed_sessions WHERE channel='mix' AND json_valid(payload)").fetchall():
                payload=json.loads(row['payload'])
                if payload.get('planning'):continue
                db.executemany('INSERT INTO feed_exposure(account,image,served) VALUES(?,?,?) ON CONFLICT(account,image) DO UPDATE SET served=MAX(served,excluded.served)',
                    [(row['account'],str(i),row['touched']) for i in payload.get('seen',[]) if str(i).isdigit()])
        self.bank=FeedBank(self)
        self.social=SocialOutbox(self)

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
        try:
            value=json.loads(row[0]) if row else default
        except json.JSONDecodeError:
            # A disposable cursor must never block Browse or overwrite account data.
            if key!='mix-progress':raise
            return default
        if key=='follows' and value is not None and hasattr(self,'social'):return self.social.follows(account,value)
        return value

    def save(self, account, key, value):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', (account, key, json.dumps(value)))

    def invalidate(self, token, *routes):
        identity=hashlib.sha256(token.encode()).hexdigest()
        with self.db() as db:db.executemany('DELETE FROM api_cache WHERE identity=? AND route=?',[(identity,r) for r in routes])

    def call(self, token, route, value=None, write=False, rest=False, fresh=False):
        ttl={'image.getInfinite':120,'image.getGenerationData':7*86400,'image.getResources':86400,
             'user.getFollowingUsers':600,'user.getCreator':86400,'tag.getVotableTags':3600,
             'collection.getUserCollectionItemsByItem':300,'collection.getAllUser':600,
             'user.getBookmarkCollections':600,'collection.getEntryCount':600,'collection.getInfinite':86400}.get(route,0)
        if write or not ttl:return self.raw_call(token,route,value,write,rest)
        diagnostic=api_debug.recorder.begin()
        identity=hashlib.sha256(token.encode()).hexdigest();key=json.dumps(value,sort_keys=True,separators=(',',':'))
        lock=self.cache_locks[int(hashlib.sha256((identity+route+key).encode()).hexdigest(),16)%64]
        with lock:
            with self.db() as db:
                row=db.execute('SELECT payload FROM api_cache WHERE identity=? AND route=? AND key=? AND expires>?',(identity,route,key,time.time())).fetchone()
            api_debug.recorder.finish(diagnostic,'cache',route,'refresh' if fresh else 'hit' if row else 'miss',background=getattr(request_context,'background',False))
            if row and not fresh:return json.loads(row[0])
            result=self.raw_call(token,route,value,write,rest)
            payload=json.dumps(result)
            if len(payload)<2*1024*1024:
                with self.db() as db:
                    db.execute('INSERT OR REPLACE INTO api_cache VALUES(?,?,?,?,?)',(identity,route,key,payload,time.time()+ttl))
                    db.execute('DELETE FROM api_cache WHERE rowid IN (SELECT rowid FROM api_cache ORDER BY expires DESC LIMIT -1 OFFSET 2000)')
            return result

    def raw_call(self, token, route, value=None, write=False, rest=False):
        if self.transport:
            return self.transport(token, route, value, write, rest)
        diagnostic=api_debug.recorder.begin()
        measurement={'sent':False,'wait':0,'bytes':0,'status':'error'} if diagnostic else None
        try:
            return self._raw_call(token,route,value,write,rest,diagnostic,measurement)
        except Deferred as error:
            if measurement and not measurement['sent']:measurement['status']=error.reason
            raise
        finally:
            if measurement:
                api_debug.recorder.finish(diagnostic,'network' if measurement['sent'] else 'budget',route,measurement['status'],
                    background=getattr(request_context,'background',False),wait_ms=measurement['wait'],byte_count=measurement['bytes'],items=measurement.get('items',0))

    def _raw_call(self, token, route, value, write, rest, diagnostic, measurement):
        with self.network:
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
            before(url)
            if measurement:
                measurement['wait']=(api_debug.recorder.monotonic()-diagnostic[0])*1000
                measurement['sent']=True
            try:
                with urllib.request.build_opener(CivitaiRedirect()).open(req, timeout=25) as response:
                    raw = response.read(16 * 1024 * 1024 + 1)
                    if measurement:measurement.update(bytes=len(raw),status='http_'+str(getattr(response,'status',200)))
                    if len(raw) > 16 * 1024 * 1024:
                        raise ValueError('Civitai response is too large. Try a smaller page.')
                    result = json.loads(raw)
            except urllib.error.HTTPError as error:
                if measurement:measurement['status']='http_'+str(error.code)
                governor.failed(error.code,error.headers.get('Retry-After'))
                if error.code in (429,500,502,503,504):
                    raise Deferred(max(5,governor.until-time.time())) from None
                if error.code in (401, 403):
                    raise ValueError('Civitai denied access. Check the desktop API key, its permissions and your account setup.') from None
                raise ValueError('Civitai request failed (HTTP %s). Please retry.' % error.code) from None
            except (OSError, TimeoutError):
                if measurement:measurement['status']='timeout'
                governor.failed(503)
                raise Deferred(max(5,governor.until-time.time())) from None
            governor.succeeded()
            if rest:
                return result
            if 'error' in result:
                if measurement:measurement['status']='protocol_error'
                raise ValueError('Civitai could not complete this request.')
            data = result.get('result', {}).get('data', {})
            data=data.get('json', data) if isinstance(data, dict) else data
            if measurement and isinstance(data,dict) and isinstance(data.get('items'),list):measurement['items']=len(data['items'])
            return data

    def account(self, cached=False):
        token = self.models.token()
        if not token:
            self.identity = None
            raise ValueError('Open the Civitai status button on your PC to add your API key and connect Browse.')
        digest = hashlib.sha256(token.encode()).hexdigest()
        if cached:
            identity=self.identity if self.identity and self.identity['digest']==digest else self.setting('','identity:'+digest)
            if identity and identity.get('digest')==digest:return dict(identity),token
        with self.lock:
            if not self.identity or self.identity['digest'] != digest or time.time() - self.identity['checked'] > 300:
                me = self.call(token, 'me', rest=True)
                self.identity = dict(id=str(ident(me['id'])), username=str(me['username']), digest=digest, checked=time.time())
                self.save('','identity:'+digest,self.identity)
            return dict(self.identity), token

    def assert_account(self, account, token):
        if self.models.token() != token:
            raise ValueError('Civitai account changed. Refresh Browse before continuing.')

    def user_url(self, name):
        return 'https://civitai.red/user/' + urllib.parse.quote(str(name), safe='')

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
        avatar = user.get('profilePicture') or user.get('image') or user.get('avatarUrl')
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
        tags.extend(dict(id=ident(t),name='') for t in (raw.get('tagIds') or []) if str(t).isdigit() and not any(str(x['id'])==str(t) for x in tags))
        item = dict(id=image_id, type=kind, width=raw.get('width') or 512, height=raw.get('height') or 768, duration=(raw.get('metadata') or {}).get('duration'),
                    prompt=str(meta.get('prompt') or ''), negativePrompt=str(meta.get('negativePrompt') or ''),
                    created=str(raw.get('createdAt') or ''), credit=str(user.get('username') or raw.get('username') or ''),
                    creatorId=str(user.get('id') or ''), path=prefix+'thumb', fullPath=prefix+'full', avatarPath=prefix+'avatar' if cdn(avatar) else '',
                    imageUrl='https://civitai.red/images/'+image_id, resources=resources, tags=tags, tagsKnown=isinstance(raw.get('tags'),list) or isinstance(raw.get('tagIds'),list), reactions=reactions,
                    stats=raw.get('stats') or {}, parameters={k:meta[k] for k in ('seed','steps','cfgScale','sampler','Size','Model','Clip skip') if k in meta},
                    _urls=dict(thumb=thumb, full=original, avatar=cdn(avatar, 'width=96')))
        item['mediaUrls']={k:v for k,v in item['_urls'].items() if k in ('thumb','full') and v}
        with self.db() as db:
            # Feed/import responses are deliberately lighter than generation data.
            # Never let them erase details already fetched for this account.
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT payload FROM media WHERE account=? AND id=?',(account,image_id)).fetchone()
            previous=json.loads(row[0]) if row else {}
            for reaction in reactions:
                if reaction in REACTIONS:db.execute("INSERT OR IGNORE INTO social_members(account,kind,subject,value,present) VALUES(?,'reaction',?,?,1)",(account,image_id,reaction))
            for key in ('collections','collectionsChecked'):
                if key in previous:item[key]=previous[key]
            if previous.get('detailVersion')==2:
                for key in ('prompt','negativePrompt','resources','parameters','detailVersion','generationDataAvailable'):
                    item[key]=previous[key]
            if not item['avatarPath'] and previous.get('avatarPath'):
                item['avatarPath']=previous['avatarPath'];item['_urls']['avatar']=previous['_urls']['avatar']
            db.execute('INSERT OR REPLACE INTO media VALUES(?,?,?,?)', (account, image_id, json.dumps(item), time.time()))
        return self.collection_item(account,item)

    @staticmethod
    def public(item):
        result={k:v for k,v in item.items() if not k.startswith('_')}
        if item.get('_urls'):result['mediaUrls']={k:v for k,v in item['_urls'].items() if k in ('thumb','full') and cdn(v)}
        return result

    def stored(self, account, image_id):
        with self.db() as db:
            row = db.execute('SELECT payload FROM media WHERE account=? AND id=?', (account, str(ident(image_id)))).fetchone()
        return self.collection_item(account,json.loads(row[0])) if row else None

    def collection_item(self, account, item):
        with self.db() as db:
            members=[{'collectionId':int(r[0])} for r in db.execute('SELECT collection FROM collection_members WHERE account=? AND image=? AND present=1',(account,str(item['id'])))]
            reactions=[r[0] for r in db.execute("SELECT value FROM social_members WHERE account=? AND kind='reaction' AND subject=? AND present=1",(account,str(item['id'])))]
        return self.social.overlay(account,dict(item,collections=members,reactions=reactions,following=str(item.get('creatorId')) in {str(i) for i in self.setting(account,'follows',[])}))

    def set_social_delta(self, db, account, kind, subject, value, selected):
        db.execute('''INSERT INTO social_members(account,kind,subject,value,present,local_updated) VALUES(?,?,?,?,?,?)
            ON CONFLICT(account,kind,subject,value) DO UPDATE SET present=excluded.present,local_updated=excluded.local_updated,missing=0''',
            (account,kind,str(subject),value,int(selected),time.time()))

    def merge_social_page(self, account, kind, values, stamp):
        with self.db() as db:
            db.executemany('''INSERT INTO social_members(account,kind,subject,value,present,seen) VALUES(?,?,?,?,1,?)
                ON CONFLICT(account,kind,subject,value) DO UPDATE SET present=CASE WHEN local_updated>excluded.seen THEN present ELSE 1 END,
                seen=MAX(seen,excluded.seen),missing=0''',[(account,kind,str(subject),value,stamp) for subject,value in values])

    def finish_social_scan(self, account, kind, stamp):
        with self.db() as db:
            key='social-scan:'+kind;old=db.execute('SELECT value FROM settings WHERE account=? AND key=?',(account,key)).fetchone()
            if old and float(json.loads(old[0]))>=stamp:return
            db.execute('UPDATE social_members SET missing=missing+1 WHERE account=? AND kind=? AND present=1 AND seen<? AND local_updated<?',(account,kind,stamp,stamp))
            db.execute('UPDATE social_members SET present=0 WHERE account=? AND kind=? AND missing>=2 AND local_updated<?',(account,kind,stamp))
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,key,json.dumps(stamp)))
            if kind=='follow':
                ids=[r[0] for r in db.execute("SELECT subject FROM social_members WHERE account=? AND kind='follow' AND present=1",(account,))]
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'follows',json.dumps(ids)))

    def sync_follows(self, account, token):
        with self.follows_lock:
            old=self.setting(account,'follow-sync',{})
            if time.time()-old.get('attempted',0)<86400:return
            stamp=time.time();self.save(account,'follow-sync',dict(attempted=stamp))
            try:
                raw=self.call(token,'user.getFollowingUsers',fresh=True)
                self.merge_social_page(account,'follow',[(x.get('id') if isinstance(x,dict) else x,'') for x in raw],stamp)
                self.finish_social_scan(account,'follow',stamp)
            except (ValueError,OSError):pass # Keep the cached follows and durable daily retry limit.

    def like_index(self, account):
        with self.db() as db:
            result={}
            for row in db.execute("SELECT subject,value FROM social_members WHERE account=? AND kind='reaction' AND present=1",(account,)):
                result.setdefault(row['subject'],[]).append(row['value'])
            return result

    def merge_collection_page(self, account, cid, items, stamp):
        with self.db() as db:
            db.executemany('''INSERT INTO collection_members(account,collection,image,present,seen) VALUES(?,?,?,1,?)
                ON CONFLICT(account,collection,image) DO UPDATE SET
                present=CASE WHEN local_updated>excluded.seen THEN present ELSE 1 END,
                seen=MAX(seen,excluded.seen),missing=0''',[(account,str(cid),str(i['id']),stamp) for i in items])

    def finish_collection_scan(self, account, cid, stamp):
        # Only completed scans can detect removals. Two misses favor inclusion.
        with self.db() as db:
            key='collection-scan:'+str(cid)
            old=db.execute('SELECT value FROM settings WHERE account=? AND key=?',(account,key)).fetchone()
            if old and float(json.loads(old[0]))>=stamp:return
            db.execute('UPDATE collection_members SET missing=missing+1 WHERE account=? AND collection=? AND present=1 AND seen<? AND local_updated<?',(account,str(cid),stamp,stamp))
            db.execute('UPDATE collection_members SET present=0 WHERE account=? AND collection=? AND missing>=2 AND local_updated<?',(account,str(cid),stamp))
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,key,json.dumps(stamp)))

    def collection_index(self, account):
        result={}
        with self.db() as db:
            for row in db.execute('SELECT image,collection FROM collection_members WHERE account=? AND present=1',(account,)):
                result.setdefault(row['image'],[]).append(row['collection'])
        return result

    def set_collection_delta(self, db, account, cid, iid, selected):
        db.execute('''INSERT INTO collection_members(account,collection,image,present,local_updated) VALUES(?,?,?,?,?)
            ON CONFLICT(account,collection,image) DO UPDATE SET present=excluded.present,local_updated=excluded.local_updated,missing=0''',
            (account,str(cid),str(iid),int(selected),time.time()))

    def images(self, account, token, filters, limit=20, meta=True, social_stamp=None):
        raw = self.call(token, 'image.getInfinite', {'limit':limit, 'browsingLevel':31, 'withMeta':meta, 'withTags':True, 'include':['tagIds','profilePictures'], **filters})
        if social_stamp is not None:
            values=[]
            for image in raw.get('items',[]):
                reactions=[r.get('reaction') if isinstance(r,dict) else r for r in image.get('reactions',[]) or []]
                # A reaction-filtered page proves a positive relationship even if its light metadata omits the emoji.
                values.extend((image['id'],r) for r in reactions or ['Like'] if r in REACTIONS)
            self.merge_social_page(account,'reaction',values,social_stamp)
        items = [self.remember(account, x) for x in raw.get('items', [])]
        return [i for i in items if i], raw.get('nextCursor')

    def collections(self, account, token, refresh=False):
        # Even an explicit Browse refresh trusts this directory for one day.
        # Keep the attempt timestamp durable so failures/restarts cannot hammer it.
        with self.collections_lock:
            old = self.setting(account, 'collections', {})
            if time.time() - max(old.get('checked', 0),old.get('attempted',0)) < 86400:
                return old.get('items', [])
            attempted=time.time()
            self.save(account,'collections',dict(old,attempted=attempted))
            try:
                raw = self.call(token, 'collection.getAllUser', {'contributingOnly':False})
                bookmarks = self.call(token, 'user.getBookmarkCollections')
                bookmark_ids={c['id'] for c in bookmarks if c.get('type')=='Image'}
                items = []
                for c in raw:
                    if c.get('type') != 'Image' or not c.get('isOwner') or c.get('archivedAt'): continue
                    counts = self.call(token, 'collection.getEntryCount', {'id':ident(c['id'])})
                    items.append(dict(id=ident(c['id']), name=str(c['name']), count=counts.get('ACCEPTED', 0), bookmark=c['id'] in bookmark_ids))
                ids={c['id'] for c in items}
                items.extend(dict(c,missing=c.get('missing',0)+1) for c in old.get('items',[]) if c['id'] not in ids and c.get('missing',0)<1)
                items.sort(key=lambda c:c['count'], reverse=True)
                self.save(account, 'collections', dict(items=items, checked=time.time(),attempted=attempted))
                return items
            except (ValueError,OSError):
                if 'items' in old:return old['items']
                # Preserve the attempt time even on first-run failures.
                raise

    def memberships(self, image_id):
        me,token=self.account(cached=True);account=me['id'];iid=ident(image_id)
        with self.action_lock:
            item=self.stored(account,iid)
            if not item:raise ValueError('Open this media before bookmarking it.')
            return dict(account=account,collections=self.social.overlay(account,item).get('collections',[]))

    def observe(self, account, source, item, score, stamp):
        for r in self.social.rows(account,True):
            if r['imageId']!=str(item['id']):continue
            if source=='reactions' and r['kind']=='reaction':score=len(self.social.overlay(account,item).get('reactions',[]))
            elif source=='collection:'+r['collectionId'] and r['kind']=='collect':score=int(r['selected'])
        tags = json.dumps({str(t['id']):t['name'] for t in item.get('tags', [])})
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?,?,?)',
                       (account, source, str(item['id']), item.get('creatorId', ''), tags, score, stamp))

    def public_curations(self, account, token, follows, refresh=True):
        """One directory page at most per minute, never a crawl of every follow.

        Only public Image collections owned by a currently followed creator qualify.
        Collection ownership does not imply that the owner personally liked a post.
        The directory refresh runs in the existing foreground-leased importer;
        the feed itself only reads the cached directory.
        """
        directory=self.setting(account,'public-curations',{})
        people=directory.setdefault('people',{})
        follows={str(uid) for uid in follows}
        people={uid:p for uid,p in people.items() if uid in follows}
        directory['people']=people
        now=time.time();reads=0
        eligible=[uid for uid in follows if now-people.get(uid,{}).get('checked',0)>=86400]
        if refresh and eligible and now-directory.get('lastLookup',0)>=60:
            uid=min(eligible,key=lambda k:(people.get(k,{}).get('checked',0),int(k)))
            directory['lastLookup']=now
            # Save the attempt as well, so a failing optional endpoint cannot spin.
            self.save(account,'public-curations',directory)
            reads=1
            try:
                with background_work():
                    raw=self.call(token,'collection.getInfinite',dict(userId=int(uid),types=['Image'],privacy=['Public'],limit=20,browsingLevel=31))
                entries=[]
                for c in raw.get('items',[]):
                    owner=c.get('user') or {}
                    if c.get('read')!='Public' or c.get('type')!='Image' or str(c.get('userId'))!=uid:continue
                    if not c.get('id') or not owner.get('username') or c.get('archivedAt'):continue
                    entries.append(dict(id=ident(c['id']),name=str(c.get('name','Collection')),
                                        ownerId=uid,ownerName=str(owner['username'])))
                people[uid]=dict(checked=now,items=entries)
            except ValueError:
                # Optional discovery must not block the user's normal feed. Retry
                # later, but stop using stale permissions after a failed refresh.
                people[uid]=dict(checked=now-86400+3600,items=[])
            self.save(account,'public-curations',directory)
        items=[c for p in people.values() if now-p.get('checked',0)<86400 for c in p.get('items',[])]
        return items,reads

    @staticmethod
    def artist_keys(item):
        return ([str(item['creatorId'])] if item.get('creatorId') else [])+(
            ['name:'+item['credit'].strip().casefold()] if item.get('credit','').strip() else ['unknown'])

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

    def preference_rows(self, account, include_creator_names=True):
        learned = self.learned_weights(account)
        overrides = self.setting(account, 'weight-overrides', {})
        creators = {}
        if include_creator_names:
            with self.db() as db:
                creators = {str(r[0]): r[1] for r in db.execute(
                    "SELECT json_extract(payload,'$.creatorId'), json_extract(payload,'$.credit') FROM media WHERE account=? AND json_valid(payload) ORDER BY touched",
                    (account,)) if r[0] and r[1]}
        rows = []
        for kind, group in (('creator', 'creators'), ('tag', 'tags')):
            ids=set(learned[group]) | {key.split(':',1)[1] for key in overrides if key.startswith(kind+':')}
            for item_id in ids:
                base=learned[group].get(item_id,0)
                change = overrides.get(kind + ':' + item_id, {})
                name = creators.get(item_id, change.get('name','Creator ' + item_id)) if kind == 'creator' else learned['names'].get(item_id, change.get('name','Tag ' + item_id))
                disabled=bool(change.get('disabled'));banned=bool(change.get('banned'))
                rows.append(dict(kind=kind, id=item_id, name=name, weight=0 if disabled or banned else max(0, base + change.get('offset', 0)),
                                 disabled=disabled, banned=banned, base=base, offset=change.get('offset',0),
                                 revisions=change.get('revisions',{})))
        return sorted(rows, key=lambda r: (2 if r['banned'] else 1 if r['disabled'] else 0, -r['weight'], r['name'].casefold()))

    def bans(self, account):
        return [dict(kind=key.split(':',1)[0],id=key.split(':',1)[1],name=value.get('name',''))
                for key,value in self.setting(account,'weight-overrides',{}).items() if value.get('banned')]

    @staticmethod
    def is_banned(item, bans):
        for rule in bans:
            if rule['kind']=='creator':
                if str(item.get('creatorId',''))==rule['id'] or (rule.get('name') and rule['name'].casefold()==item.get('credit','').casefold()):return True
            elif any(str(t.get('id',''))==rule['id'] or (rule.get('name') and rule['name'].casefold()==t.get('name','').casefold()) for t in item.get('tags',[])):return True
        return False

    def preferences(self):
        me, token = self.account()
        rows = self.preference_rows(me['id'])
        unresolved = [r for r in rows if r['kind']=='creator' and r['name']=='Creator '+r['id']]
        for row in unresolved[:2]:
            key='creator-name-checked:'+row['id']
            if time.time()-self.setting(me['id'],key,0)<86400:continue
            try:
                self.images(me['id'], token, {'userId':int(row['id']), 'sort':'Newest'}, 1, meta=False)
                self.save(me['id'],key,time.time())
            except ValueError:
                break
        return dict(account=me['id'], items=self.preference_rows(me['id']), bans=self.bans(me['id']),**self.tag_weight_snapshot(me['id']))

    def weights(self, account):
        rows = self.preference_rows(account, include_creator_names=False)
        return dict(creators={r['id']:r['weight'] for r in rows if r['kind']=='creator' and not r['disabled'] and r['weight']>0},
                    tags={r['id']:r['weight'] for r in rows if r['kind']=='tag' and not r['disabled'] and r['weight']>0},
                    names={r['id']:r['name'] for r in rows if r['kind']=='tag'})

    def tag_weight_snapshot(self, account):
        with self.action_lock:
            stamp=time.time()
            return dict(tagWeightsAt=stamp,tagWeights={r['id']:r['weight'] for r in self.preference_rows(account) if r['kind']=='tag'})

    @staticmethod
    def roll_tag_pair(weights, rng=random):
        candidates={str(k):v for k,v in weights.items() if v>0}
        if len(candidates)<2:return []
        first=rng.choices(list(candidates),weights=list(candidates.values()))[0]
        candidates.pop(first)
        second=rng.choices(list(candidates),weights=list(candidates.values()))[0]
        return sorted([first,second],key=int)

    @staticmethod
    def matches_tags(item, tags):
        return set(map(str,tags)).issubset({str(t['id']) for t in item.get('tags',[])})

    def status(self, active=True, cursors=None, activity_age=7200):
        me, token = self.account(); account=me['id']
        # Keep exactly the client's open feeds alive based on user activity,
        # not on background polling. Never renew another account's cursors.
        if isinstance(cursors,list) and isinstance(activity_age,(int,float)) and 0<=activity_age<7200:
            stamp=time.time()-activity_age
            ids=[x for x in cursors[:40] if isinstance(x,str) and re.fullmatch('[a-f0-9]{32}',x)]
            with self.lock:
                for key in ids:
                    state=self.feeds.get(key)
                    if state and state['account']==account:state['touched']=max(state['touched'],stamp)
                with self.db() as db:
                    for key in ids:
                        db.execute('UPDATE feed_sessions SET touched=? WHERE account=? AND id=? AND touched<? AND touched>?',
                            (stamp,account,key,stamp-30,time.time()-7200))
        collections = self.collections(account, token)
        # Establish relationships before serving the very first feed. The history
        # importer is asynchronous; otherwise a well-connected new account would
        # incorrectly get a full page of LoRA filler on its first visit.
        if self.setting(account, 'follows') is None:
            self.sync_follows(account,token)
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
                    collectionIndex=self.collection_index(account),
                    likeIndex=self.like_index(account),
                    followingIds=[str(x) for x in self.setting(account,'follows',[])],
                    timeouts=self.timeouts(account), bans=self.bans(account), importState=state, learned=count, follows=len(self.setting(account, 'follows', [])),**self.tag_weight_snapshot(account))

    def import_loop(self, account, token):
        with background_work(quiet=True):self._import_loop(account,token)

    def _import_loop(self, account, token):
        try:
            if self.leases.get(account,0)>time.monotonic() and self.models.token()==token:self.sync_follows(account,token)
            if self.leases.get(account,0)>time.monotonic() and self.models.token()==token:
                try:self.public_curations(account,token,self.setting(account,'follows',[]))
                except (Deferred,ValueError):pass
            state = self.setting(account, 'import', {})
            bootstrap=not self.setting(account,'collection-index-complete',False)
            social_bootstrap=not self.setting(account,'like-index-complete',False)
            if state.get('complete') and time.time()-state.get('finished', 0)<86400 and not bootstrap and not social_bootstrap:return
            if not state.get('sources') or state.get('complete'):
                recent=state.get('complete') and time.time()-state.get('finished',0)<86400
                sources = (['reactions'] if social_bootstrap or not recent else []) + (['collection:'+str(c['id']) for c in self.collections(account, token)] if bootstrap or not recent else [])
                state = dict(sources=sources, index=0, cursor=None, processed=0, complete=False, stamp=str(time.time()))
                self.save(account, 'import', state)
            state.pop('error', None)
            while self.leases.get(account, 0)>time.monotonic() and self.models.token()==token:
                if state['index'] >= len(state['sources']):
                    state.update(complete=True, finished=time.time(), label='Preferences up to date')
                    self.save(account,'collection-index-complete',True)
                    self.save(account,'like-index-complete',True)
                    self.save(account, 'import', state);break
                source=state['sources'][state['index']]
                filters = {'reactions':list(REACTIONS)} if source=='reactions' else {'collectionId':int(source.split(':')[1])}
                filters['sort']='Newest'
                if state.get('cursor') is not None: filters['cursor']=state['cursor']
                state['label']='Learning from your reactions' if source=='reactions' else 'Learning from your collections'
                with background_work(quiet=True):items, cursor=self.images(account, token, filters, 200, meta=False,social_stamp=float(state['stamp']) if source=='reactions' else None)
                if source.startswith('collection:'):self.merge_collection_page(account,source.split(':')[1],items,float(state['stamp']))
                for item in items:
                    score=max(1,len([r for r in item['reactions'] if r in REACTIONS])) if source=='reactions' else 1
                    self.observe(account, source, item, score, state['stamp'])
                state['processed']+=len(items)
                if cursor is not None and cursor==state.get('cursor'):
                    raise ValueError('Civitai repeated a page cursor. Import paused; retry later.')
                state['cursor']=cursor
                if cursor is None:
                    if source=='reactions':self.finish_social_scan(account,'reaction',float(state['stamp']))
                    if source.startswith('collection:'):self.finish_collection_scan(account,source.split(':')[1],float(state['stamp']))
                    with self.db() as db:
                        db.execute('DELETE FROM observations WHERE account=? AND source=? AND CAST(stamp AS REAL)<?', (account, source, float(state['stamp'])))
                    state['index']+=1
                self.save(account, 'import', state)
                time.sleep(3)
        except Exception as error:
            state=self.setting(account, 'import', locals().get('state', {}))
            state['error']=str(error) if isinstance(error, ValueError) else 'Preference import paused. Reopen Browse to retry.'
            self.save(account, 'import', state)
        finally:
            with self.lock:self.running.discard(account)

    def exposure(self, query):
        me,_=self.account();account=me['id']
        if str(query.get('account'))!=account:raise ValueError('Civitai account changed. Refresh Browse.')
        def ids(key):
            values=query.get(key,[])
            if not isinstance(values,list) or len(values)>500:raise ValueError('At most 500 media IDs are allowed.')
            return list({str(ident(i)) for i in values})
        viewed=ids('viewed');candidates=ids('candidates');now=time.time()
        with self.db() as db:
            db.executemany('INSERT INTO feed_exposure(account,image,viewed) VALUES(?,?,?) ON CONFLICT(account,image) DO UPDATE SET viewed=MAX(viewed,excluded.viewed)',[(account,i,now) for i in viewed])
            known=[]
            if candidates:
                slots=','.join('?' for _ in candidates)
                known=[r[0] for r in db.execute('SELECT image FROM feed_exposure WHERE account=? AND viewed>0 AND image IN ('+slots+')',(account,*candidates))]
                known+= [r[0] for r in db.execute('SELECT DISTINCT image FROM observations WHERE account=? AND score>0 AND image IN ('+slots+')',(account,*candidates))]
        return dict(account=account,seen=list(set(known)))

    def feed(self, query):
        diagnostic=api_debug.recorder.begin();result=None
        try:
            if query.get('channel','mix')=='mix' and query.get('bank') is True:
                result=self.bank.take(query)
            elif query.get('channel','mix')=='mix':
                # Concurrent phones must not receive the same newly reserved posts.
                with self.mix_lock:result=self._feed(query)
            else:result=self._feed(query)
            return result
        finally:
            if diagnostic:
                r=result or {}
                api_debug.recorder.finish(diagnostic,'feed','feed.'+query.get('channel','mix').split(':')[0],
                    'error' if result is None else 'limited' if r.get('limited') else 'ok',
                    items=len(r.get('items',[])),reads=r.get('sourceReads',0),scanned=r.get('scanned',0),filtered=r.get('filtered',0))

    def _feed(self, query, planning=False, artist_tail=None):
        me, token=self.account(); account=me['id']; cursor=query.get('cursor',''); channel=query.get('channel','mix')
        with self.lock:
            self.feeds={k:v for k,v in self.feeds.items() if time.time()-v['touched']<7200}
            state=None
            if cursor:
                state=self.feeds.get(cursor)
                if not state:
                    with self.db() as db:
                        row=db.execute('SELECT payload FROM feed_sessions WHERE account=? AND id=? AND channel=? AND touched>? AND json_valid(payload)',
                            (account,cursor,channel,time.time()-7200)).fetchone()
                    if row:
                        state=json.loads(row[0]);state['lock']=threading.Lock();self.feeds[cursor]=state
                if state and (state['account']!=account or state['channel']!=channel):
                    raise ValueError('This feed belongs to a different account or channel.')
            recovered=bool(cursor and state is None)
            if state is None:
                cursor=uuid.uuid4().hex
                loras=[{k:i[k] for k in ('id','kind','name','title','versionId','modelId') if k in i}
                       for i in self.models.snapshot()['items'] if i.get('kind')=='loras' and i.get('versionId') and not i.get('archived')]
                seen=[str(i) for i in query.get('seen',[])[-5000:] if str(i).isdigit()]
                state=dict(account=account,channel=channel,planning=planning,touched=time.time(),seen=seen,sources={},loras=loras,turn=0,lora=0, lock=threading.Lock())
                if channel=='mix' and not planning and not query.get('refresh'):
                    progress=self.setting(account,'mix-progress',{})
                    if time.time()-progress.get('at',0)<1800 and progress.get('muted',[])==sorted(self.timeouts(account)):
                        for field in ('sources','turn','lora'):state[field]=progress.get(field,state[field])
                self.feeds[cursor]=state
        with state['lock']:
            state['touched']=time.time();out=[];weights=self.weights(account);bans=self.bans(account)
            reads=0;limited=False;retry_after=0;scanned=0
            excluded=set()
            if channel=='mix':
                with self.db() as db:
                    excluded={r[0] for r in db.execute('SELECT image FROM feed_exposure WHERE account=? AND (viewed>0 OR served>?)',(account,time.time()-7*86400))}
                    excluded.update(r[0] for r in db.execute('SELECT DISTINCT image FROM observations WHERE account=? AND score>0',(account,)))
                excluded.update(str(i) for i in query.get('seen',[])[-5000:] if str(i).isdigit())
            muted=self.timeouts(account) if channel=='mix' else {}
            weights['creators']={k:v for k,v in weights['creators'].items() if k not in muted}
            follows=[uid for uid in self.setting(account,'follows',[]) if str(uid) in weights['creators']]
            rich=bool(follows or weights['creators'] or len(weights['tags'])>=2)
            following={str(x) for x in self.setting(account,'follows',[])}
            recent=(artist_tail if artist_tail is not None else self.setting(account,'mix-artists',[]))[-9:] if channel=='mix' else []
            curations=[]
            if channel=='mix' and follows:
                curations,_=self.public_curations(account,token,follows,refresh=False)
            for attempt in range(36 if channel=='mix' else (12 if recovered else 2)):
                if len(out)>=12:break
                chosen={};required_tags=[]
                if channel=='mix':
                    # Seven tag discovery slots, one public collection, one creator,
                    # one LoRA filler. Missing curations fall back to tags. Artist
                    # spacing applies to every source, across requests and restarts.
                    slot=state['turn']%10;state['turn']+=1
                    blocked={k for keys in recent for k in keys}
                    eligible={uid:w for uid,w in weights['creators'].items() if uid not in blocked}
                    if (slot==9 or not rich) and state['loras']:
                        item=state['loras'][state['lora']%len(state['loras'])];state['lora']+=1
                        key='lora:'+str(item['versionId']);filters={'modelVersionId':int(item['versionId']),'sort':'Most Reactions'};reason='From '+item['title']
                        chosen=dict(kind='lora',id=str(item['versionId']),name=item['title'],modelId=item.get('modelId'))
                    elif slot==7 and curations:
                        collection=random.choice(curations)
                        key='curation:'+str(collection['id']);filters={'collectionId':collection['id'],'sort':'Newest'}
                        reason='From a public collection by '+collection['ownerName']
                        chosen=dict(kind='curation',collectionId=collection['id'],collectionName=collection['name'],
                                    via=dict(id=collection['ownerId'],name=collection['ownerName']))
                    elif (slot==8 or len(weights['tags'])<2) and eligible:
                        uid=random.choices(list(eligible),weights=list(eligible.values()))[0]
                        key='creator:'+uid;filters={'userId':int(uid),'sort':'Newest'};reason='A creator you enjoy'
                        chosen=dict(kind='creator',id=str(uid))
                    elif len(weights['tags'])>=2:
                        required_tags=self.roll_tag_pair(weights['tags'])
                        # Once the network budget is used, draw from saved tag pages
                        # instead of stranding their candidates behind new random pairs.
                        buffered=[k.split(':',1)[1].split(',') for k,s in state['sources'].items()
                                  if k.startswith('tags:') and s['items'] and all(t in weights['tags'] for t in k.split(':',1)[1].split(','))]
                        if reads>=3 and buffered:
                            required_tags=random.choices(buffered,weights=[sum(weights['tags'][t] for t in pair) for pair in buffered])[0]
                        key='tags:'+','.join(required_tags);filters={'tags':list(map(int,required_tags)),'sort':'Newest'}
                        reason='Because you enjoy '+' + '.join(weights['names'][t] for t in required_tags)
                        chosen=dict(kind='tags',ids=required_tags)
                    else:key='discover';filters={'sort':'Newest'};reason='Discover something new'
                elif channel.startswith(('creator:', 'tag:', 'tags:')):
                    parts=channel.split(':')
                    if len(parts)!=3 or parts[2] not in ('all','image','video'):raise ValueError('Invalid feed filter')
                    key=channel;reason=''
                    if parts[0]=='creator':
                        subject=ident(parts[1]);filters={'sort':'Newest','userId':subject};chosen=dict(kind='creator',id=str(subject))
                    else:
                        ids=parts[1].split(',')
                        if not ids or len(ids)>100:raise ValueError('Choose between 1 and 100 tags.')
                        required_tags=sorted({str(ident(t)) for t in ids},key=int)
                        filters={'sort':'Newest','tags':list(map(int,required_tags))};chosen=dict(kind='tags',ids=required_tags)
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
                if channel=='mix':
                    # Keep the active source and retain at most 24 recent page buffers.
                    # The seen list and exposure table still deduplicate evicted sources.
                    state['sources'][key]=state['sources'].pop(key)
                    while len(state['sources'])>24:
                        del state['sources'][next(iter(state['sources']))]
                if not source['items'] and not source['done']:
                    if reads>=3:
                        limited=True
                        continue
                    if source['cursor'] is not None:filters['cursor']=source['cursor']
                    try:
                        reads+=1
                        items,nxt=self.images(account,token,filters,200 if len(required_tags)>=2 else 100)
                    except Deferred as error:
                        limited=True;retry_after=error.retry_after;break
                    source.update(items=items,cursor=nxt,started=True,done=nxt is None)
                # Resolve missing tag metadata in one batch, never one call per image.
                # Keep candidates and cursor intact if the API budget is exhausted.
                if required_tags or any(b['kind']=='tag' for b in bans):
                    unknown=[i for i in source['items'] if not i.get('tagsKnown')]
                    if unknown:
                        if reads>=3:
                            limited=True;continue
                        try:
                            reads+=1
                            resolved,_=self.images(account,token,{'ids':[int(i['id']) for i in unknown[:200]]},200,meta=False)
                            by_id={i['id']:i for i in resolved}
                            for i in unknown:
                                if by_id.get(i['id'],{}).get('tagsKnown'):
                                    i.update(tags=by_id[i['id']]['tags'],tagsKnown=True)
                            if any(not i.get('tagsKnown') for i in unknown):
                                limited=True;retry_after=60;break
                        except Deferred as error:
                            limited=True;retry_after=error.retry_after;break
                take=1 if channel=='mix' else 12
                before=len(out)
                remaining=len(source['items'])
                while remaining and source['items'] and len(out)-before<take and len(out)<12:
                    remaining-=1
                    item=source['items'].pop(0)
                    scanned+=1
                    if self.is_muted(item,muted):continue
                    if item['id'] in state['seen']:continue
                    if item['id'] in excluded:continue
                    if required_tags and not self.matches_tags(item,required_tags):continue
                    if self.is_banned(item,bans):continue
                    if channel=='mix':
                        keys=self.artist_keys(item)
                        if any(set(keys).intersection(previous) for previous in recent):
                            source['items'].append(item)
                            continue
                        recent=(recent+[keys])[-9:]
                    if channel.startswith('collection:'):self.merge_collection_page(account,channel.split(':')[1],[item],time.time())
                    public=dict(self.public(self.collection_item(account,item)),reason=reason,chosenBy=chosen,following=str(item.get('creatorId')) in following)
                    state['seen'].append(item['id']);out.append(public)
                state['empty']=state.get('empty',0)+1 if len(out)==before else 0
            state['seen']=state['seen'][-5000:]
            ended=channel!='mix' and all(s['done'] and not s['items'] for s in state['sources'].values())
            with self.db() as db:
                if channel=='mix':
                    if not planning:
                        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'mix-artists',json.dumps(recent)))
                        db.executemany('INSERT INTO feed_exposure(account,image,served) VALUES(?,?,?) ON CONFLICT(account,image) DO UPDATE SET served=excluded.served',[(account,i['id'],time.time()) for i in out])
                        progress=dict(at=time.time(),muted=sorted(muted),**{k:state[k] for k in ('sources','turn','lora')})
                        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'mix-progress',json.dumps(progress)))
                db.execute('DELETE FROM feed_sessions WHERE touched<?',(time.time()-7200,))
                db.execute('INSERT OR REPLACE INTO feed_sessions VALUES(?,?,?,?,?)',
                    (account,cursor,channel,json.dumps({k:v for k,v in state.items() if k!='lock'}),time.time()))
            return dict(account=account,items=out,nextCursor=None if ended else cursor,recovered=recovered,
                        limited=limited,retryAfter=retry_after,sourceReads=reads,scanned=scanned,filtered=scanned-len(out))

    def timeouts(self, account):
        return {k:v for k,v in self.setting(account,'creator-timeouts',{}).items() if v.get('until',0)>time.time()}

    @staticmethod
    def is_muted(item, muted):
        return str(item.get('creatorId','')) in muted or any(
            v.get('name') and v['name'].casefold()==item.get('credit','').casefold() for v in muted.values())

    def detail(self, image_id, prefetch=False):
        diagnostic=api_debug.recorder.begin();outcome='error'
        try:
            if prefetch:
                with background_work():result=self._detail(image_id,True)
            else:result=self._detail(image_id,False)
            outcome='ok';return result
        except Deferred:
            outcome='deferred';raise
        finally:api_debug.recorder.finish(diagnostic,'detail','detail.prefetch' if prefetch else 'detail.open',outcome,background=prefetch)

    def generation_data(self, token, image_id):
        # Same endpoint as the website's Generation data panel. A caller serving
        # a listing sample must first verify it belongs to that visible listing.
        generation=self.call(token,'image.getGenerationData',{'id':ident(image_id)})
        meta=generation.get('meta') or {}
        raw=generation.get('resources') or []
        return dict(prompt=str(meta.get('prompt') or ''),negativePrompt=str(meta.get('negativePrompt') or ''),
                    parameters={k:meta[k] for k in ('seed','steps','cfgScale','sampler','Size','Model','clipSkip','Clip skip','denoise') if k in meta},
                    resources=[dict(versionId=str(r.get('modelVersionId') or r.get('versionId') or ''),modelId=str(r.get('modelId') or ''),
                                    name=str(r.get('modelName') or r.get('name') or 'Resource'),version=str(r.get('versionName') or r.get('modelVersionName') or ''),
                                    type=str(r.get('modelType') or r.get('type') or 'Resource'),weight=r.get('strength',r.get('weight',''))) for r in raw],
                    generationDataAvailable=True)

    def _detail(self, image_id, prefetch):
        me, token=self.account();account=me['id'];image_id=str(ident(image_id))
        if not prefetch and self.setting(account,'follows') is None:self.sync_follows(account,token)
        item=self.stored(account,image_id)
        if not item:
            items,_=self.images(account,token,{'imageId':int(image_id)},1)
            if not items:raise ValueError('This media is no longer available to your account.')
            item=next((i for i in items if i['id']==image_id),None)
            if not item:raise ValueError('This media is no longer available to your account.')
        try:
            item.update(self.generation_data(token,image_id));item['detailVersion']=2
        except Deferred:
            if prefetch:raise
            item['generationDataAvailable']=False;item['detailVersion']=0
        except ValueError:
            # Keep useful cached content; do not mislabel a temporary lookup failure
            # as an uploader withholding the prompt. Clients may retry this detail.
            item['generationDataAvailable']=False;item['detailVersion']=0
        if not prefetch and not item.get('avatarPath') and item.get('creatorId'):
            key='creator-avatar:'+item['creatorId'];cached=self.setting(account,key,{})
            if cached.get('expires',0)<time.time():
                try:
                    creator=self.call(token,'user.getCreator',{'id':int(item['creatorId'])})
                    avatar=creator.get('profilePicture') or creator.get('image') or creator.get('avatarUrl')
                    if isinstance(avatar,dict):avatar=avatar.get('url')
                    cached=dict(url=cdn(avatar,'width=96'),expires=time.time()+86400)
                except ValueError:cached=dict(url=cached.get('url',''),expires=time.time()+600)
                self.save(account,key,cached)
            if cached.get('url'):
                item['_urls']['avatar']=cached['url']
                item['avatarPath']='model-preview/browse/'+account+'/'+image_id+'/avatar'
        item['avatarResolved']=bool(item.get('avatarPath')) or not prefetch
        if not prefetch and not item['generationDataAvailable'] and not item['resources']:
            raw=self.call(token,'image.getResources',{'id':int(image_id)})
            item['resources']=[dict(versionId=str(r.get('modelVersionId') or ''),modelId=str(r.get('modelId') or ''),
                name=str(r.get('modelName') or 'Resource'),version=str(r.get('modelVersionName') or ''),type=str(r.get('modelType') or 'Resource'),weight='') for r in raw]
        if not prefetch:
            follows=[str(x) for x in self.setting(account,'follows',[])]
            item['following']=item['creatorId'] in follows
            if not item.get('tagsKnown') or any(not t.get('name') for t in item['tags']):
                item['tags']=self.call(token,'tag.getVotableTags',{'type':'image','id':int(image_id)});item['tagsKnown']=True
            item['collections']=self.collection_item(account,item)['collections']
        item['socialComplete']=not prefetch
        with self.db() as db:db.execute('UPDATE media SET payload=? WHERE account=? AND id=?',(json.dumps(item),account,image_id))
        snapshot=self.tag_weight_snapshot(account)
        public=self.public(self.collection_item(account,item))
        public['tags']=[dict(id=t['id'],name=t.get('name',''),weight=snapshot['tagWeights'].get(str(t['id']),0)) for t in item['tags']]
        public['tags'].sort(key=lambda t:(-t['weight'],t['name'].casefold()))
        return dict(account=account,item=public,collections=self.setting(account,'collections',{}).get('items',[]),**snapshot)

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
                until=min(time.time()+7200,float(payload.get('until',time.time()+7200)))
                muted[uid]=dict(until=max(until,muted.get(uid,{}).get('until',0)),name=str(payload.get('name',''))[:200])
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
                change['name']=row['name']
                if 'delta' in payload:
                    delta = payload['delta']
                    if type(delta) is not int or delta not in (-1,1):raise ValueError('Invalid weight adjustment')
                    if row['disabled'] or row['banned']:raise ValueError('Restore this item before adjusting its weight.')
                    change['offset'] = max(0, row['weight'] + delta) - row['base']
                    change.setdefault('revisions',{})['offset']=request_id
                elif type(payload.get('banned')) is bool:
                    change['banned']=payload['banned']
                    change.setdefault('revisions',{})['banned']=request_id
                    if not payload['banned']:
                        change['disabled']=False;change['disabledByVote']=False;change['revisions']['disabled']=request_id
                elif type(payload.get('disabled')) is bool:
                    if row['banned']:raise ValueError('Unban this item before changing its weight.')
                    change['disabled'] = payload['disabled']
                    change['disabledByVote']=False
                    change.setdefault('revisions',{})['disabled']=request_id
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
                created=self.call(token,'collection.upsert',{'name':name,'type':'Image','read':'Private','write':'Private'},True)
                cid=ident(created.get('id'))
                with self.collections_lock:
                    saved=self.setting(account,'collections',{})
                    items=[c for c in saved.get('items',[]) if c['id']!=cid]
                    items.append(dict(id=cid,name=str(created.get('name') or name),count=0,bookmark=False))
                    saved['items']=items;self.save(account,'collections',saved)
                result=dict(ok=True,collections=items,collectionId=cid)
            elif kind=='follow':
                uid=ident(payload.get('creatorId'));desired=payload.get('selected')
                if type(desired) is not bool:raise ValueError('Choose follow or unfollow.')
                def current():return [str(x.get('id') if isinstance(x,dict) else x) for x in self.call(token,'user.getFollowingUsers',fresh=True)]
                follows=current()
                if (str(uid) in follows)!=desired:self.call(token,'user.toggleFollow',{'targetUserId':uid},True)
                follows=current()
                if (str(uid) in follows)!=desired:raise ValueError('Follow change is not confirmed yet. Refresh before retrying.')
                self.save(account,'follows',follows)
                with self.db() as db:self.set_social_delta(db,account,'follow',uid,'',desired)
                result=dict(ok=True,selected=desired)
            else:
                iid=ident(payload.get('imageId'));item=self.stored(account,iid)
                if not item:raise ValueError('Open this media before interacting with it.')
                if kind=='tag-ban':
                    ids=payload.get('tagIds');banned=payload.get('banned')
                    if not isinstance(ids,list) or not 1<=len(ids)<=100 or type(banned) is not bool:
                        raise ValueError('Choose tags and a ban state.')
                    ids={str(ident(tid)) for tid in ids}
                    tags={str(t['id']):t for t in item.get('tags',[])}
                    if not ids.issubset(tags):raise ValueError('Refresh this media before changing its tags.')
                    overrides=self.setting(account,'weight-overrides',{})
                    rows={r['id']:r for r in self.preference_rows(account) if r['kind']=='tag'}
                    snapshot=self.tag_weight_snapshot(account)
                    for tid in ids:
                        key='tag:'+tid;change=overrides.get(key,{})
                        change.update(name=tags[tid]['name'],banned=banned)
                        change.setdefault('revisions',{})['banned']=request_id
                        if not banned:
                            change['disabled']=False;change['disabledByVote']=False;change['revisions']['disabled']=request_id
                        overrides[key]=change
                        snapshot['tagWeights'][tid]=0 if banned else max(0,rows.get(tid,{}).get('base',0)+change.get('offset',0))
                    bans=[dict(kind=k.split(':',1)[0],id=k.split(':',1)[1],name=v.get('name','')) for k,v in overrides.items() if v.get('banned')]
                    result=dict(ok=True,bans=bans,**snapshot)
                    # All selected tags and the retry receipt persist together; no upstream writes.
                    with self.db() as db:
                        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'weight-overrides',json.dumps(overrides)))
                        db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?',('done',json.dumps(result),account,request_id))
                    return result
                elif kind=='reaction':
                    reaction=payload.get('reaction');desired=payload.get('selected')
                    if reaction not in REACTIONS or type(desired) is not bool:raise ValueError('Invalid reaction')
                    def current():
                        raw=self.call(token,'reaction.getMyImageReactions',{'imageIds':[iid]}).get(str(iid),[])
                        return [r.get('reaction') if isinstance(r,dict) else r for r in raw]
                    values=current()
                    if (reaction in values)!=desired:self.call(token,'reaction.toggle',{'entityId':iid,'entityType':'image','reaction':reaction},True)
                    values=current()
                    if (reaction in values)!=desired:raise ValueError('Reaction is not confirmed yet. Refresh before retrying.')
                    with self.db() as db:self.set_social_delta(db,account,'reaction',iid,reaction,desired)
                    self.observe(account,'reactions',item,len([r for r in values if r in REACTIONS]),str(time.time()))
                    result=dict(ok=True,reactions=values)
                elif kind=='collect':
                    cid=ident(payload.get('collectionId'));desired=payload.get('selected')
                    if type(desired) is not bool or cid not in [c['id'] for c in self.setting(account,'collections',{}).get('items',[])]:raise ValueError('Select one of your collections.')
                    self.call(token,'collection.saveItem',dict(imageId=iid,collections=[{'collectionId':cid}] if desired else [],removeFromCollectionIds=[] if desired else [cid]),True)
                    memberships=self.call(token,'collection.getUserCollectionItemsByItem',{'imageId':iid},fresh=True)
                    self.invalidate(token,'collection.getEntryCount','image.getInfinite')
                    present=any(int(c.get('collectionId',0))==cid for c in memberships)
                    if present!=desired:raise ValueError('Collection change is not confirmed yet. Refresh before retrying.')
                    self.observe(account,'collection:'+str(cid),item,1 if desired else 0,str(time.time()))
                    previous=item.get('collections')
                    item.update(collections=memberships,collectionsChecked=time.time())
                    with self.db() as db:db.execute('UPDATE media SET payload=? WHERE account=? AND id=?',(json.dumps(item),account,str(iid)))
                    with self.db() as db:self.set_collection_delta(db,account,cid,iid,desired)
                    if isinstance(previous,list):
                        was_present=any(int(c.get('collectionId',0))==cid for c in previous)
                        with self.collections_lock:
                            saved=self.setting(account,'collections',{})
                            for c in saved.get('items',[]):
                                if c['id']==cid:c['count']=max(0,c.get('count',0)+int(desired)-int(was_present))
                            self.save(account,'collections',saved)
                    result=dict(ok=True,selected=desired,collections=memberships)
                elif kind in ('tag-weight','vote'):
                    tid=ident(payload.get('tagId'))
                    delta=payload.get('delta') if kind=='tag-weight' else (payload.get('vote')*5 if type(payload.get('vote')) is int else None)
                    if type(delta) is not int or delta not in (-5,5):raise ValueError('Choose +5 or -5 for your tag weight.')
                    tags=item.get('tags',[]);tag=next((t for t in tags if int(t['id'])==tid),None)
                    if not tag:raise ValueError('Refresh the tags before adjusting their weight.')
                    row=next((r for r in self.preference_rows(account) if r['kind']=='tag' and r['id']==str(tid)),dict(base=0,weight=0,banned=False))
                    if row['banned']:raise ValueError('Unban this tag in Your feed before changing its weight.')
                    overrides=self.setting(account,'weight-overrides',{});key='tag:'+str(tid)
                    change=overrides.get(key,{})
                    weight=max(0,row['weight']+delta)
                    change.update(name=tag['name'],offset=weight-row['base'],disabled=weight==0,disabledByVote=True)
                    change.setdefault('revisions',{}).update(offset=request_id,disabled=request_id)
                    overrides[key]=change
                    snapshot=self.tag_weight_snapshot(account);snapshot['tagWeights'][str(tid)]=weight
                    result=dict(ok=True,tagId=str(tid),weight=weight,**snapshot)
                    with self.db() as db:
                        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'weight-overrides',json.dumps(overrides)))
                        db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?',('done',json.dumps(result),account,request_id))
                    return result
                else:raise ValueError('Unknown Civitai action')
            with self.db() as db:
                db.execute('UPDATE actions SET state=?,result=? WHERE account=? AND id=?',('done',json.dumps(result),account,request_id))
            return result

    @staticmethod
    def media_key(account,url,size):
        return hashlib.sha256((account+'|'+url+('|original-size-v2' if size=='full' else '')).encode()).hexdigest()

    def media_file(self, account, image_id, size):
        me,token=self.account(cached=True)
        if account!=me['id'] or size not in ('thumb','full','avatar'):raise FileNotFoundError()
        item=self.stored(account,image_id)
        url=(item or {}).get('_urls',{}).get(size,'')
        if not url:raise FileNotFoundError('Media unavailable')
        key=self.media_key(account,url,size)
        folder=self.data/'media';folder.mkdir(exist_ok=True)
        is_video=size=='full' and item['type']=='video'
        path=folder/(key+('.mp4' if is_video else '.jpg'))
        with self.media_locks[int(key,16)%64]:
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
                        if size!='full':im.thumbnail((640,640))
                        im.convert('RGB').save(converted,'JPEG',quality=90)
                    converted.replace(path)
                with self.media_lock:
                    # Other lanes rename their temporary files outside this lock.
                    # Enumerate only committed media when trimming the shared cache.
                    files=sorted((f for f in folder.glob('*.*') if f.suffix in ('.jpg','.mp4')),key=lambda f:f.stat().st_mtime,reverse=True);total=0
                    for f in files:
                        try:
                            total+=f.stat().st_size
                            if total>2*1024*1024*1024 and f!=path and f.suffix!='.tmp' and f.stem not in self.bank.protected_keys:f.unlink(missing_ok=True)
                        except OSError:pass
                return path
            finally:
                temp.unlink(missing_ok=True);converted.unlink(missing_ok=True)
