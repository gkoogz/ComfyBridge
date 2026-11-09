"""On-demand model sample pages and bounded disk cache; no GPU or weight loading."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import io
import json
import re
import threading
import time
import urllib.error
import urllib.parse

from PIL import Image
from model_library import API, MATURE_API, BROWSING_MATURE, fetch, safe_preview

PAGE_SIZE = 20
PAGE_TTL = 3600
CACHE_BYTES = 256 * 1024 * 1024


def positive_id(value):
    return str(value) if re.fullmatch(r'[1-9][0-9]{0,18}',str(value or '')) else ''


def image_source(url):
    parsed=urllib.parse.urlparse(str(url))
    try:
        return (parsed.scheme=='https' and parsed.hostname in ('image.civitai.com','image.civitai.red','imagecache.civitai.com')
                and not parsed.username and not parsed.password and parsed.port in (None,443))
    except ValueError:return False


class Gallery:
    def __init__(self, library):
        self.library=library;self.files=library.data/'gallery';self.files.mkdir(exist_ok=True)
        self.pages_lock=threading.Lock();self.images_lock=threading.Lock()
        self.resources=ThreadPoolExecutor(max_workers=3,thread_name_prefix='listing-details')
        with library.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS gallery_images(asset TEXT,image TEXT,payload TEXT,touched REAL,
                    PRIMARY KEY(asset,image));
                CREATE TABLE IF NOT EXISTS gallery_pages(asset TEXT,auth TEXT,cursor TEXT,payload TEXT,checked REAL,
                    PRIMARY KEY(asset,auth,cursor));
                CREATE TABLE IF NOT EXISTS gallery_resources(version TEXT,auth TEXT,payload TEXT,checked REAL,
                    PRIMARY KEY(version,auth));
            ''')

    def asset(self, identity):
        if not re.fullmatch('[a-f0-9]{32}',identity):raise ValueError('Invalid model identity')
        with self.library.db() as db:
            row=db.execute('SELECT payload FROM assets WHERE id=?',(identity,)).fetchone()
        if not row:raise FileNotFoundError('Model listing no longer available')
        return json.loads(row['payload'])

    def sample(self, raw, asset, mature, catalogue=None):
        if not isinstance(raw,dict) or not safe_preview(raw,mature):return None
        image_id=positive_id(raw.get('id'));url=raw.get('url','')
        if not image_id or not image_source(url):return None
        meta=raw.get('meta') if isinstance(raw.get('meta'),dict) else {}
        resources=[];seen=set()
        raw_resources=[]
        for key in ('resources','civitaiResources'):
            if isinstance(meta.get(key),list):raw_resources+=meta[key][:64]
        for resource in raw_resources:
            if not isinstance(resource,dict):continue
            version=positive_id(resource.get('modelVersionId'));kind=str(resource.get('type','resource'))[:80]
            name=str(resource.get('name') or resource.get('modelName') or '')[:300]
            matched=(catalogue or {}).get(version,{})
            if not name:name=matched.get('title','')
            key=(version,kind.lower(),name)
            if key in seen:continue
            seen.add(key)
            resources.append(dict(name=name,type=kind,versionId=version,modelId=positive_id(resource.get('modelId') or matched.get('modelId')),
                                  weight=str(resource.get('weight',''))[:80]))
            if len(resources)>=64:break
        parameters={k:str(meta[k])[:1000] for k in ('seed','steps','cfgScale','sampler','Size','Model','Clip skip','clipSkip')
                    if k in meta and isinstance(meta[k],(str,int,float))}
        host='https://civitai.red' if mature else 'https://civitai.com'
        width=raw.get('width');height=raw.get('height')
        return dict(id=image_id,source=url,assetVersion=positive_id(asset.get('versionId')),path=f'model-preview/gallery/{asset["id"]}/{image_id}/thumb',
                    fullPath=f'model-preview/gallery/{asset["id"]}/{image_id}/full',
                    width=width if type(width) is int and 0<width<=50000 else 0,
                    height=height if type(height) is int and 0<height<=50000 else 0,
                    credit=str(raw.get('username',''))[:200],created=str(raw.get('createdAt',''))[:80],
                    prompt=str(meta.get('prompt') or '')[:60000],negativePrompt=str(meta.get('negativePrompt') or '')[:60000],
                    resources=resources,parameters=parameters,mature=not safe_preview(raw),
                    imageUrl=host+'/images/'+image_id,listingUrl=asset.get('sourceUrl','').replace('https://civitai.com/',host+'/'))

    def visible(self, sample):
        return not sample.get('mature') or bool(self.library.token())

    def public_page(self, payload):
        return dict(payload,items=[item for item in payload['items'] if self.visible(item)],
                    nsfwHidden=not bool(self.library.token()))

    def page(self, identity, cursor=''):
        if not isinstance(cursor,str) or len(cursor)>4096 or any(ord(c)<32 for c in cursor):
            raise ValueError('Invalid gallery cursor')
        asset=self.asset(identity);version=positive_id(asset.get('versionId'))
        if asset.get('source')!='Civitai' or not version:
            return dict(items=[],nextCursor=None,nsfwHidden=not bool(self.library.token()),note='This listing has no Civitai image gallery.')
        token=self.library.token();generation=self.library.auth_generation(token)+':'+version
        with self.pages_lock:
            with self.library.db() as db:
                cached=db.execute('SELECT payload,checked FROM gallery_pages WHERE asset=? AND auth=? AND cursor=?',
                                  (identity,generation,cursor)).fetchone()
            if cached and time.time()-cached['checked']<PAGE_TTL:
                return self.public_page(json.loads(cached['payload']))
            params=dict(modelVersionId=version,limit=PAGE_SIZE,type='image',withMeta='true',sort='Most Reactions',
                        browsingLevel=BROWSING_MATURE if token else 1)
            if cursor:params['cursor']=cursor
            try:
                raw=json.loads(fetch((MATURE_API if token else API)+'images?'+urllib.parse.urlencode(params),token=token))
                if not isinstance(raw,dict) or not isinstance(raw.get('items',[]),list) or not isinstance(raw.get('metadata',{}),dict):
                    raise ValueError('Invalid gallery response')
            except (OSError,ValueError) as error:
                if cached:
                    result=self.public_page(json.loads(cached['payload']));result['note']='Offline · showing cached previews';return result
                if isinstance(error,urllib.error.HTTPError) and error.code in (401,403):
                    raise ValueError('Civitai rejected this request. Check the PC Civitai key and account browsing settings.') from None
                raise ValueError('Civitai previews are temporarily unavailable. Try again.') from None
            with self.library.db() as db:
                local=[json.loads(row['payload']) for row in db.execute('SELECT payload FROM assets')]
            catalogue={positive_id(item.get('versionId')):item for item in local if item.get('versionId')}
            samples=[self.sample(item,asset,bool(token),catalogue) for item in (raw.get('items') or [])[:PAGE_SIZE]]
            samples=list({item['id']:item for item in samples if item}.values())
            metadata=raw.get('metadata') or {};next_cursor=metadata.get('nextCursor')
            # Older Civitai responses carry the opaque cursor only inside nextPage.
            if not next_cursor and metadata.get('nextPage'):
                next_cursor=urllib.parse.parse_qs(urllib.parse.urlparse(metadata['nextPage']).query).get('cursor',[None])[0]
            if not isinstance(next_cursor,str) or len(next_cursor)>4096 or next_cursor==cursor:next_cursor=None
            payload=dict(items=samples,nextCursor=next_cursor,note='')
            now=time.time()
            with self.library.db() as db:
                for sample in samples:
                    db.execute('INSERT OR REPLACE INTO gallery_images VALUES(?,?,?,?)',
                               (identity,sample['id'],json.dumps(sample),now))
                db.execute('INSERT OR REPLACE INTO gallery_pages VALUES(?,?,?,?,?)',
                           (identity,generation,cursor,json.dumps(payload),now))
                db.execute('DELETE FROM gallery_pages WHERE checked<?',(now-7*86400,))
                db.execute('DELETE FROM gallery_images WHERE rowid IN (SELECT rowid FROM gallery_images ORDER BY touched DESC LIMIT -1 OFFSET 10000)')
            return self.public_page(payload)

    def preview(self, identity, image, size):
        asset=self.asset(identity)
        if not positive_id(image) or size not in ('thumb','full'):raise ValueError('Invalid gallery preview')
        with self.library.db() as db:
            row=db.execute('SELECT payload FROM gallery_images WHERE asset=? AND image=?',(identity,image)).fetchone()
        if not row:raise FileNotFoundError('Reload the model gallery to retrieve this preview')
        sample=json.loads(row['payload'])
        if not self.visible(sample) or sample.get('assetVersion')!=positive_id(asset.get('versionId')):
            raise FileNotFoundError('Preview unavailable')
        source=sample['source']
        if not image_source(source):raise ValueError('Invalid preview source')
        key=hashlib.sha256(source.encode()).hexdigest()[:24]
        dest=self.files/(key+'-'+size+'.jpg')
        # Serialize downloads so browsing cannot saturate generation traffic or decode RAM.
        with self.images_lock:
            if not dest.is_file():
                raw=fetch(source,20*1024*1024)
                with Image.open(io.BytesIO(raw)) as image_file:
                    if image_file.width*image_file.height>40000000:raise ValueError('Preview exceeds image size limit')
                    image_file.thumbnail((2048,2048) if size=='full' else (768,768))
                    tmp=dest.with_suffix('.tmp');image_file.convert('RGB').save(tmp,format='JPEG',quality=90 if size=='full' else 84);tmp.replace(dest)
            dest.touch();self.trim_cache(dest)
        if not self.visible(sample):raise FileNotFoundError('Preview unavailable')
        return dest

    def resource(self, version, token):
        generation=self.library.auth_generation(token)
        with self.library.db() as db:
            old=db.execute('SELECT payload,checked FROM gallery_resources WHERE version=? AND auth=?',(version,generation)).fetchone()
        if old and time.time()-old['checked']<(7*86400 if json.loads(old['payload']) else 600):return json.loads(old['payload'])
        value={}
        try:
            raw=json.loads(fetch((MATURE_API if token else API)+'model-versions/'+version,token=token))
            if positive_id(raw.get('id'))==version and isinstance(raw.get('model'),dict):
                value=dict(name=str(raw['model'].get('name') or '')[:300],type=str(raw['model'].get('type') or '')[:80],
                           modelId=positive_id(raw.get('modelId')),versionId=version)
        except (OSError,ValueError,AttributeError):pass
        with self.library.db() as db:
            db.execute('INSERT OR REPLACE INTO gallery_resources VALUES(?,?,?,?)',(version,generation,json.dumps(value),time.time()))
            db.execute('DELETE FROM gallery_resources WHERE rowid IN (SELECT rowid FROM gallery_resources ORDER BY checked DESC LIMIT -1 OFFSET 10000)')
        return value

    def details(self, identity, image):
        asset=self.asset(identity)
        if not positive_id(image):raise ValueError('Invalid gallery image')
        with self.library.db() as db:
            row=db.execute('SELECT payload FROM gallery_images WHERE asset=? AND image=?',(identity,image)).fetchone()
        if not row:raise FileNotFoundError('Reload the model gallery to retrieve its details')
        sample=json.loads(row['payload'])
        if not self.visible(sample) or sample.get('assetVersion')!=positive_id(asset.get('versionId')):
            raise FileNotFoundError('Preview unavailable')
        token=self.library.token()
        versions={x['versionId'] for x in sample['resources'] if x.get('versionId') and (not x.get('name') or not x.get('modelId'))}
        tasks={version:self.resources.submit(self.resource,version,token) for version in sorted(versions)[:12]}
        for resource in sample['resources']:
            task=tasks.get(resource.get('versionId'))
            if not task:continue
            value=task.result()
            for key in ('name','modelId','type'):
                if value.get(key) and (not resource.get(key) or key=='type' and resource[key]=='resource'):resource[key]=value[key]
        if not self.visible(sample):raise FileNotFoundError('Preview unavailable')
        return dict(resources=sample['resources'])

    def trim_cache(self, keep):
        files=sorted(self.files.glob('*.jpg'),key=lambda p:p.stat().st_mtime)
        total=sum(p.stat().st_size for p in files)
        for path in files:
            if total<=CACHE_BYTES:break
            if path==keep:continue
            try:
                size=path.stat().st_size;path.unlink();total-=size
            except OSError:pass
