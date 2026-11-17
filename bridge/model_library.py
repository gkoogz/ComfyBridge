"""Disk-cached, hash-identified listings. Never loads weights onto the GPU."""
import argparse
from contextlib import closing
import hashlib
from html.parser import HTMLParser
import io
import json
import logging
from pathlib import Path
import re
import sqlite3
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

API = 'https://civitai.com/api/v1/'
# civitai.com clamps mature samples. civitai.red is Civitai's own mature host.
MATURE_API = 'https://civitai.red/api/v1/'
# None|Soft|Mature|X plus the historical XXX bit. Anonymous calls stay at PG (1).
BROWSING_MATURE = 31
TOKEN_FILE = 'civitai-api-key.txt'
SCAN_INTERVAL = 1800
SOURCE_INTERVAL = 7 * 86400
LOCK = threading.Lock()
# Exact LFS SHA-256 identities checked against the publishers' file listings.
HF_FILES = {
    'a2deb2f5a48911af9cc0a98278aa43f42019e55de954fb450caf933b23d17a4f':('UnplannedAI/NSFW-XL','NSFW-XL','2.1'),
    '8a51ca3f7d290a799d89fefcde4ede60962256955a91dfe4746d3cc07814fd6e':('TenStrip/10Eros-Max','10Eros Max · MiniMax H3','Beta 7 · 8-step Turbo · INT8HQ'),
    '12944c1f7791637e7de12208aef04da82bd26b95271b1b47d817364315ade993':('Comfy-Org/MiniMax-H3','MiniMax H3','FL2VA · pruned FP8 scaled'),
    'c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc':('lightx2v/Minimax-h3-Turbo','MiniMax H3 Turbo LoRA','4-step · v1.0 · 768p · BF16'),
    '2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e':('lightx2v/Minimax-h3-Turbo','MiniMax H3 Turbo LoRA','8-step · v1.0 · BF16'),
}


class Plain(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.parts=[];self.skip=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'):self.skip+=1
        if tag in ('p','br','li','h1','h2','h3','div'):self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in ('script','style'):self.skip=max(0,self.skip-1)
    def handle_data(self,data):
        if not self.skip:self.parts.append(data)


def plain(value):
    parser=Plain();parser.feed(str(value or '')[:200000])
    return re.sub(r'\n\s*\n+', '\n\n', ''.join(parser.parts)).strip()[:60000]


def valid_civitai_token(value):
    return bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{19,399}', value or ''))


def civitai_api_url(url):
    parsed=urllib.parse.urlparse(url)
    try:
        return (parsed.scheme=='https' and parsed.hostname in ('civitai.com','civitai.red')
                and parsed.port in (None,443) and not parsed.username and not parsed.password
                and parsed.path.startswith('/api/'))
    except ValueError:return False


class CivitaiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
        if redirected is not None and not civitai_api_url(newurl):
            redirected.remove_header('Authorization')
        return redirected


def request_for(url, token=''):
    headers={'User-Agent':'ComfyBridge model catalogue/1.0','Accept':'application/json,image/*'}
    # The key is a header on Civitai API hosts only. It never goes in the URL or to the image CDN.
    if token and civitai_api_url(url):headers['Authorization']='Bearer '+token
    return urllib.request.Request(url,headers=headers)


def fetch(url, limit=8*1024*1024, token=''):
    from civitai_requests import before, governor, Deferred, context
    import api_debug
    is_api=civitai_api_url(url)
    diagnostic=api_debug.recorder.begin() if is_api else None
    operation='rest.other'
    if diagnostic:
        resource=urllib.parse.urlparse(url).path.split('/')[3:4]
        if resource and resource[0] in ('images','models','model-versions'):operation='rest.'+resource[0]
    sent=False;outcome='error';wait_ms=0;byte_count=0
    req=request_for(url, token)
    try:
        before(url)
        if diagnostic:wait_ms=(api_debug.recorder.monotonic()-diagnostic[0])*1000
        sent=True
        with urllib.request.build_opener(CivitaiRedirect()).open(req,timeout=25) as response:
            raw=response.read(limit+1)
            byte_count=len(raw);outcome='http_'+str(getattr(response,'status',200))
            if len(raw)>limit:raise ValueError('Listing response exceeds limit')
            if is_api:governor.succeeded()
            return raw
    except urllib.error.HTTPError as error:
        outcome='http_'+str(error.code)
        if is_api:governor.failed(error.code,error.headers.get('Retry-After'))
        raise
    except Deferred as error:
        outcome=error.reason;raise
    except (OSError,TimeoutError):
        outcome='timeout';raise
    finally:
        api_debug.recorder.finish(diagnostic,'network' if sent else 'budget',operation,outcome,
            background=getattr(context,'background',False),wait_ms=wait_ms,byte_count=byte_count)


def metadata(path):
    try:
        if path.suffix!='.safetensors':return {}
        with path.open('rb') as f:
            size=struct.unpack('<Q',f.read(8))[0]
            return json.loads(f.read(size)).get('__metadata__',{}) if size<=32*1024*1024 else {}
    except (OSError,ValueError,struct.error):return {}


def image_level(image):
    level=image.get('browsingLevel',image.get('nsfwLevel'))
    if type(level) is int and type(level) is not bool:return level
    if isinstance(level,str):
        if level.isdigit():return int(level)
        return {'none':1,'pg':1,'soft':2,'pg13':2,'pg-13':2,'mature':4,'r':4,'x':8,'xxx':16}.get(level.lower(),1)
    if image.get('nsfw') is True:return 4
    return 1


def safe_preview(image, mature=False):
    if image.get('type','image')!='image':return False
    if mature:return True
    if image.get('nsfw') is True:return False
    level=image.get('browsingLevel',image.get('nsfwLevel'))
    if level is not None:return type(level) is int and level==1 or level=='None'
    return image.get('nsfw')=='None' or image.get('nsfw') is False


def extra_images(version_id, token=''):
    """Return (items, key_rejected). A saved key asks civitai.red for every browsing level."""
    version_id=int(version_id)
    if token:
        for base in (MATURE_API, API):
            url=f"{base}images?modelVersionId={version_id}&limit=50&browsingLevel={BROWSING_MATURE}&type=image"
            try:return json.loads(fetch(url, token=token)).get('items',[]), False
            except urllib.error.HTTPError as error:
                if error.code in (401,403):return [], True
                continue
            except (OSError, ValueError):continue
        return [], False
    try:return json.loads(fetch(API+f"images?modelVersionId={version_id}&limit=50&browsingLevel=1&type=image")).get('items',[]), False
    except (OSError, ValueError):return [], False


def roots(root):
    result={k:[root/'models'/k] for k in ('checkpoints','loras','diffusion_models','embeddings')}
    extra=root/'extra_model_paths.yaml'
    if extra.is_file():
        import yaml
        for cfg in (yaml.safe_load(extra.read_text(encoding='utf-8')) or {}).values():
            if not isinstance(cfg,dict):continue
            base=Path(cfg.get('base_path') or root)
            if not base.is_absolute():base=root/base
            for key in result:
                for folder in str(cfg.get(key,'')).splitlines():
                    if folder.strip():result[key].append(base/folder.strip())
    return result


def embedding_encoder(path):
    """Read tensor dimensions, never deserialize executable pickle weights."""
    if path.suffix.lower()!='.safetensors':return ''
    try:
        with path.open('rb') as stream:
            size=struct.unpack('<Q',stream.read(8))[0]
            if not 2<=size<=1024*1024:return ''
            header=json.loads(stream.read(size))
        shapes={key:value.get('shape',[]) for key,value in header.items() if isinstance(value,dict) and key!='__metadata__'}
        if shapes.get('clip_g',[])[-1:]==[1280] and shapes.get('clip_l',[])[-1:]==[768]:return 'SDXL'
        dims={shape[-1] for shape in shapes.values() if shape}
        if dims=={768}:return 'SD 1.x'
        if dims=={1024}:return 'SD 2.x'
    except (OSError,ValueError,struct.error,TypeError):pass
    return ''


class Library:
    def __init__(self,root,data):
        self.root=Path(root);self.data=Path(data)/'model-library';self.data.mkdir(parents=True,exist_ok=True)
        self.previews=self.data/'previews';self.previews.mkdir(exist_ok=True)
        self.running=False;self.last=0;self.preview_lock=threading.Lock()
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,kind TEXT,name TEXT,stamp TEXT,hash TEXT,checked REAL,payload TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS model_preferences(id TEXT PRIMARY KEY,archived INTEGER NOT NULL DEFAULT 0)')
            db.execute('CREATE TABLE IF NOT EXISTS embedding_search(query TEXT PRIMARY KEY,payload TEXT,checked REAL)')
    def db(self):
        db=sqlite3.connect(self.data/'catalog.sqlite',timeout=20);db.row_factory=sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL');return closing_db(db)
    def snapshot(self):
        with self.db() as db:
            items=[json.loads(row['payload']) for row in db.execute("SELECT payload FROM assets WHERE kind!='embedding_remote' ORDER BY kind,name")]
            archived={row['id'] for row in db.execute('SELECT id FROM model_preferences WHERE archived=1')}
        has_token=bool(self.token())
        for item in items:
            item['archived']=item['id'] in archived
            item['images']=[image for image in item.get('images',[]) if self.preview_allowed(item,image,has_token)]
            for image in item.get('images',[]):
                revision=item['sha256'][:8]+hashlib.sha256(image['source'].encode()).hexdigest()[:8]
                image['path']=image['path'].split('?')[0]+'?v='+revision
            item.pop('previewAuth',None)
        return dict(items=items,scanning=self.running,lastScan=self.last,nsfwHidden=not has_token)
    def archive(self, identity, archived):
        if not re.fullmatch('[a-f0-9]{32}',str(identity)) or type(archived) is not bool:raise ValueError('Invalid LoRA archive request')
        with self.db() as db:
            row=db.execute('SELECT kind FROM assets WHERE id=?',(identity,)).fetchone()
            if not row or row['kind']!='loras':raise ValueError('LoRA listing is no longer available')
            db.execute('INSERT OR REPLACE INTO model_preferences VALUES(?,?)',(identity,int(archived)))
        return dict(id=identity,archived=archived)
    @staticmethod
    def preview_allowed(item,image,has_token):
        if has_token:return True
        if 'mature' in image:return not image['mature']
        # Beta 58 cached safe images only. Conservatively hide newer unlabelled caches.
        return item.get('previewAuth','sfw')=='sfw'
    def preview_file(self,item,index):
        image=item['images'][index]
        suffix='-'+hashlib.sha256(image['source'].encode()).hexdigest()[:16] if image.get('cacheVersion')==2 else ''
        return self.previews/(item['id']+'-'+str(index)+suffix+'.jpg')
    def preview(self,identity,index,full=False):
        if not re.fullmatch('[a-f0-9]{32}',identity) or str(index) not in ('0','1','2'):raise ValueError('Invalid preview')
        with self.db() as db:
            row=db.execute('SELECT payload FROM assets WHERE id=?',(identity,)).fetchone()
        if not row:raise FileNotFoundError('Preview unavailable')
        item=json.loads(row['payload']);index=int(index)
        if index>=len(item.get('images',[])) or not self.preview_allowed(item,item['images'][index],bool(self.token())):
            raise FileNotFoundError('Preview unavailable')
        path=self.preview_file(item,index)
        if full:path=path.with_stem(path.stem+'-full')
        with self.preview_lock:
            if not path.is_file() and (full or item['images'][index].get('remote')):
                source=item['images'][index]['source'];parsed=urllib.parse.urlparse(source)
                if parsed.scheme!='https' or parsed.hostname not in ('image.civitai.com','image.civitai.red') or parsed.username or parsed.password or parsed.port not in (None,443):raise ValueError('Invalid preview source')
                raw=fetch(source,20*1024*1024)
                with Image.open(io.BytesIO(raw)) as img:
                    if img.width*img.height>40000000:raise ValueError('Preview exceeds image size limit')
                    img.thumbnail((2048,2048) if full else (768,768));tmp=path.with_suffix('.tmp');img.convert('RGB').save(tmp,format='JPEG',quality=90 if full else 85);tmp.replace(path)
        if not path.is_file():raise FileNotFoundError('Preview unavailable')
        return path
    def token(self):
        path=self.data.parent/TOKEN_FILE
        try:value=path.read_text(encoding='utf-8-sig').strip()
        except OSError:return ''
        return value if valid_civitai_token(value) else ''
    def auth_generation(self, token=None):
        if token is None:token=self.token()
        return 'sfw' if not token else hashlib.sha256(token.encode()).hexdigest()[:16]
    def stored_generation(self):
        try:return (self.data/'preview-auth.txt').read_text(encoding='utf-8').strip()
        except OSError:return None
    def write_generation(self, generation):
        path=self.data/'preview-auth.txt';tmp=path.with_suffix('.txt.tmp')
        tmp.write_text(generation,encoding='utf-8');tmp.replace(path)
    def preview_auth_changed(self):
        return self.stored_generation()!=self.auth_generation()
    def drop_unused_previews(self, item):
        keep={self.preview_file(item,index) for index in range(len(item.get('images') or []))}
        for path in self.previews.glob(item['id']+'-*.jpg'):
            if path in keep:continue
            try:path.unlink()
            except OSError:pass
    def scan(self,force=False):
        token=self.token();generation=self.auth_generation(token);stored=self.stored_generation()
        # Upgrading with no key must not throw away the previews already cached.
        if stored is None and generation=='sfw':
            self.write_generation('sfw');stored='sfw'
        refresh=stored!=generation
        if not force and not refresh and time.time()-self.last<SCAN_INTERVAL:return
        if not LOCK.acquire(blocking=False):return
        self.running=True
        try:
            seen=set()
            for kind,folders in roots(self.root).items():
                for folder in folders:
                    if not folder.is_dir():continue
                    for path in sorted(folder.rglob('*')):
                        if path.suffix.lower() not in ('.safetensors','.ckpt','.pt','.bin','.gguf'):continue
                        name=path.relative_to(folder).as_posix();identity=hashlib.sha256((kind+':'+name).encode()).hexdigest()[:32]
                        if identity in seen:continue
                        seen.add(identity)
                        try:self.inspect(path,kind,name,identity,force,refresh_listings=refresh,token=token)
                        except Exception:logging.exception('Could not index model %s',name)
            with self.db() as db:
                for row in db.execute("SELECT id FROM assets WHERE kind!='embedding_remote'").fetchall():
                    if row['id'] not in seen:db.execute('DELETE FROM assets WHERE id=?',(row['id'],))
            self.last=time.time();self.write_generation(generation)
        finally:self.running=False;LOCK.release()
    def search_embeddings(self, query, cursor=''):
        query=str(query).strip()[:200];cursor=str(cursor)
        if not query or len(cursor)>2048 or any(ord(c)<32 for c in cursor):raise ValueError('Enter an embedding name or keyword.')
        token=self.token();key=self.auth_generation(token)+':'+query.lower()+':'+cursor
        with self.db() as db:cached=db.execute('SELECT payload,checked FROM embedding_search WHERE query=?',(key,)).fetchone()
        if cached and time.time()-cached['checked']<3600:return json.loads(cached['payload'])
        params=dict(types='TextualInversion',query=query,limit=20,nsfw='true' if token else 'false')
        if cursor:params['cursor']=cursor
        raw=json.loads(fetch((MATURE_API if token else API)+'models?'+urllib.parse.urlencode(params),token=token))
        items=[]
        for model in raw.get('items',[])[:20]:
            if str(model.get('type','')).lower() not in ('textualinversion','embedding'):continue
            for version in (model.get('modelVersions') or [])[:1]:
                if not str(version.get('id','')).isdigit():continue
                file=next((f for f in version.get('files',[]) if str(f.get('name','')).lower().endswith(('.safetensors','.pt','.bin'))),None)
                if not file:continue
                identity=hashlib.sha256(('embedding_remote:'+str(version['id'])).encode()).hexdigest()[:32]
                item=dict(id=identity,kind='embedding_remote',name=file['name'],title=str(model.get('name',''))[:300],
                          version=str(version.get('name',''))[:300],baseModel=str(version.get('baseModel',''))[:100],
                          author=str((model.get('creator') or {}).get('username',''))[:200],description=plain(model.get('description')),
                          versionDescription=plain(version.get('description')),bytes=round(float(file.get('sizeKB') or 0)*1024),
                          sha256=str((file.get('hashes') or {}).get('SHA256','')),keywords=version.get('trainedWords') or [],
                          source='Civitai',sourceUrl=f"https://civitai.red/models/{model['id']}?modelVersionId={version['id']}",
                          modelId=model['id'],versionId=version['id'],images=[],status='remote',match='Available to download',previewAuth=self.auth_generation(token))
                # Gallery thumbnails are fetched lazily by the same device preview scheduler.
                for candidate in version.get('images') or []:
                    if not safe_preview(candidate,bool(token)):continue
                    url=candidate.get('url','');p=urllib.parse.urlparse(url)
                    if p.scheme!='https' or p.hostname not in ('image.civitai.com','image.civitai.red') or p.username or p.password:continue
                    item['images'].append(dict(source=url,credit=candidate.get('username',''),mature=not safe_preview(candidate),remote=True,
                                              width=candidate.get('width',0),height=candidate.get('height',0),id=str(candidate.get('id','')),
                                              path='model-preview/'+identity+'/'+str(len(item['images']))))
                    if len(item['images'])==3:break
                with self.db() as db:db.execute('INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?,?,?)',(identity,'embedding_remote',item['name'],'',item['sha256'],time.time(),json.dumps(item)))
                public=dict(item);public.pop('previewAuth',None);items.append(public)
        metadata=raw.get('metadata') or {};next_cursor=metadata.get('nextCursor')
        if not next_cursor and metadata.get('nextPage'):
            next_cursor=urllib.parse.parse_qs(urllib.parse.urlparse(metadata['nextPage']).query).get('cursor',[None])[0]
        if not isinstance(next_cursor,str) or len(next_cursor)>2048 or next_cursor==cursor:next_cursor=None
        result=dict(items=items,nextCursor=next_cursor)
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO embedding_search VALUES(?,?,?)',(key,json.dumps(result),time.time()))
            db.execute('DELETE FROM embedding_search WHERE checked<?',(time.time()-86400,))
        return result
    def cache_previews(self,item,safe):
        used={x['source'] for x in item['images']}
        for candidate in safe:
            url=candidate.get('url','');parsed=urllib.parse.urlparse(url)
            if parsed.scheme!='https' or parsed.hostname not in ('image.civitai.com','image.civitai.red') or parsed.username or parsed.password or url in used:continue
            used.add(url)
            try:
                raw=fetch(url,20*1024*1024)
                with Image.open(io.BytesIO(raw)) as img:
                    if img.width*img.height>40000000:continue
                    suffix=hashlib.sha256(url.encode()).hexdigest()[:16]
                    img.thumbnail((768,768));dest=self.previews/(item['id']+'-'+str(len(item['images']))+'-'+suffix+'.jpg')
                    tmp=dest.with_suffix('.tmp');img.convert('RGB').save(tmp,format='JPEG',quality=85);tmp.replace(dest)
                item['images'].append(dict(source=url,credit=candidate.get('username',''),id=str(candidate.get('id','')),width=candidate.get('width',0),height=candidate.get('height',0),mature=not safe_preview(candidate),cacheVersion=2,path='model-preview/'+item['id']+'/'+str(len(item['images']))))
                if len(item['images'])==3:break
            except (OSError,ValueError):continue
    def inspect(self,path,kind,name,identity,force,refresh_listings=False,token=''):
        st=path.stat();stamp=f'{st.st_size}:{st.st_mtime_ns}'
        with self.db() as db:old=db.execute('SELECT * FROM assets WHERE id=?',(identity,)).fetchone()
        unchanged=old and old['stamp']==stamp
        interval=900 if unchanged and json.loads(old['payload']).get('status')=='unavailable' else SOURCE_INTERVAL
        if unchanged and not force and not refresh_listings and time.time()-old['checked']<interval:return
        meta=metadata(path)
        if unchanged:digest=old['hash']
        else:
            h=hashlib.sha256()
            with path.open('rb') as f:
                for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
            digest=h.hexdigest()
        now=path.stat()
        if (now.st_size,now.st_mtime_ns)!=(st.st_size,st.st_mtime_ns):return
        title=meta.get('modelspec.title') or meta.get('ss_output_name') or path.stem
        if title in ('Merge 1','Merge'):title=path.stem
        item=dict(id=identity,kind=kind,name=name,title=title,bytes=st.st_size,sha256=digest,
                  author=meta.get('modelspec.author',''),description=plain(meta.get('modelspec.description','')),version='',baseModel=meta.get('modelspec.architecture',''),keywords=[],images=[],
                  status='unmatched',source='',sourceUrl='',checked=time.time(),match='Local file metadata')
        if kind=='embeddings':item['encoderFamily']=embedding_encoder(path)
        if meta.get('sd_merge_recipe'):
            item['merge']=plain(meta['sd_merge_recipe'])
            item['title']='Local checkpoint merge'
            item['description']='This is a locally merged checkpoint. Its embedded merge recipe is preserved below; no single published listing has been assumed.'
        try:
            tensor_hash=None
            try:version=json.loads(fetch(API+'model-versions/by-hash/'+digest))
            except urllib.error.HTTPError as error:
                if error.code!=404 or not meta.get('sshs_model_hash'):raise
                # Metadata-only edits change the file SHA. Verify the tensor
                # payload itself before accepting Civitai's AutoV3 identity.
                h=hashlib.sha256()
                with path.open('rb') as f:
                    n=struct.unpack('<Q',f.read(8))[0];f.seek(8+n)
                    for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
                tensor_hash=h.hexdigest()
                version=json.loads(fetch(API+'model-versions/by-hash/'+tensor_hash[:12]))
            matching=next((f for f in version.get('files',[]) if f.get('hashes',{}).get('SHA256','').lower()==digest or
                           tensor_hash and f.get('hashes',{}).get('AutoV3','').lower()==tensor_hash[:12]),None)
            if not matching:raise ValueError('Source response did not confirm the file hash')
            model=json.loads(fetch(API+'models/'+str(int(version['modelId']))))
            item.update(title=model['name'],version=version['name'],author=model.get('creator',{}).get('username',''),
                        description=plain(model.get('description')),versionDescription=plain(version.get('description')),
                        baseModel=version.get('baseModel',''),keywords=version.get('trainedWords') or [],status='matched',
                        source='Civitai',sourceUrl=f"https://civitai.com/models/{version['modelId']}?modelVersionId={version['id']}",
                        modelId=version['modelId'],versionId=version['id'],match='Exact SHA-256 file match',
                        fileMetadata=matching.get('metadata',{}))
            if tensor_hash:item.update(match='Verified tensor hash · local file metadata differs',tensorHash=tensor_hash)
            candidates=list(version.get('images') or [])
            mature=bool(token);rejected=False
            # A saved key must look past the PG stills already embedded in the version.
            if mature or len([x for x in candidates if safe_preview(x, mature)])<3:
                extra,rejected=extra_images(version['id'], token)
                candidates=list(extra)+candidates
            safe=[x for x in candidates if safe_preview(x, mature)]
            if mature:safe.sort(key=image_level, reverse=True)
            self.cache_previews(item,safe)
            if rejected:item['previewWarning']='Civitai rejected the saved API key. Check the gear next to Turn server off on the PC panel.'
            elif not item['images']:
                item['previewNote']='No listing previews were available.' if mature else 'No non-explicit listing previews were available. NSFW previews stay hidden until a Civitai API key is saved on the PC panel.'
        except urllib.error.HTTPError as error:
            item['status']='unmatched' if error.code==404 else 'unavailable'
            item['note']='No exact listing was found. This may be a local merge, removed version, or a file hosted elsewhere.' if error.code==404 else f'Source temporarily unavailable (HTTP {error.code}).'
            if error.code==404 and digest in HF_FILES:
                repo,title,version=HF_FILES[digest]
                item.update(title=title,version=version,author=repo.split('/')[0],baseModel='SDXL' if repo=='UnplannedAI/NSFW-XL' else 'MiniMax H3',
                            status='matched',source='Hugging Face',sourceUrl='https://huggingface.co/'+repo,
                            match='Exact SHA-256 match to publisher file',note='',previewNote='No verified non-explicit still previews are available from this repository.')
                try:
                    readme=fetch('https://huggingface.co/'+repo+'/raw/main/README.md').decode('utf-8')
                    readme=re.sub(r'!\[[^\]]*\]\([^)]*\)','',readme)
                    item['description']=plain(readme)
                except (OSError,ValueError):item['description']='See the publisher listing for model details.'
        except (OSError,ValueError,KeyError) as error:
            item['status']='unavailable';item['note']='Source lookup unavailable; local model remains selectable.'
        retry_previews=False
        if unchanged and item['status'] in ('unavailable','unmatched') and json.loads(old['payload']).get('status')=='matched':
            item=json.loads(old['payload']);item['note']='Source refresh unavailable; showing the previously verified cached listing.'
            retry_previews=refresh_listings
        else:item['previewAuth']=self.auth_generation(token)
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?,?,?)',(identity,kind,name,stamp,digest,0 if retry_previews else time.time(),json.dumps(item)))
        self.drop_unused_previews(item)
        print(f"{kind}/{name}: {item['status']}, {len(item['images'])} previews",flush=True) if __name__=='__main__' else None


class closing_db:
    def __init__(self,db):self.db=db
    def __enter__(self):return self.db
    def __exit__(self,*error):
        try:self.db.rollback() if error[0] else self.db.commit()
        finally:self.db.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);parser.add_argument('--data',type=Path,required=True);parser.add_argument('--force',action='store_true');args=parser.parse_args()
    library=Library(args.root,args.data);library.scan(args.force)
    items=library.snapshot()['items'];print(json.dumps(dict(total=len(items),matched=sum(x['status']=='matched' for x in items),previews=sum(len(x['images']) for x in items))))
