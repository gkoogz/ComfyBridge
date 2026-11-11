"""Confirmed, durable Civitai LoRA downloads. Never loads weights or overwrites a model."""
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import psutil
from model_library import API, LOCK, CivitaiRedirect, fetch, plain, request_for, roots

MAX_BYTES=16*1024**3
RESERVE=512*1024**2
LORA_TYPES={'lora','locon','lycoris','dora'}


def version_id(value):
    value=str(value or '')
    if not re.fullmatch('[1-9][0-9]{0,18}',value):raise ValueError('A Civitai LoRA version is required.')
    return value


def filename(value):
    value=str(value)
    if '/' in value or '\\' in value or not value.lower().endswith('.safetensors'):raise ValueError('This LoRA has no supported SafeTensor file.')
    value=re.sub(r'[<>:"|?*\x00-\x1f]','_',value).strip(' .')
    stem=Path(value).stem[:150].rstrip(' .')
    if not stem or stem.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}:stem='LoRA_'+stem
    return stem+'.safetensors'


def download_url(url, version):
    parsed=urllib.parse.urlparse(str(url))
    if not (parsed.scheme=='https' and parsed.hostname in ('civitai.com','civitai.red') and
            parsed.port in (None,443) and not parsed.username and not parsed.password and
            parsed.path=='/api/download/models/'+version):raise ValueError('Civitai did not supply a supported download URL.')
    query=urllib.parse.parse_qsl(parsed.query)
    if any(key not in ('type','format','size','fp') for key,_ in query):raise ValueError('Unexpected Civitai download parameters.')
    return parsed._replace(fragment='').geturl()


def download_host(url):
    try:
        p=urllib.parse.urlparse(url);host=p.hostname or ''
        return (p.scheme=='https' and p.port in (None,443) and not p.username and not p.password and
                (host in ('civitai.com','civitai.red','b2.civitai.com') or
                 host.endswith(('.civitai.com','.civitai.red','.r2.cloudflarestorage.com','.amazonaws.com','.backblazeb2.com'))))
    except ValueError:return False


class DownloadRedirect(CivitaiRedirect):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not download_host(newurl):raise ValueError('Unsupported model download redirect. Open the original listing to inspect its download.')
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def open_download(url, token):
    request=request_for(url,token);request.add_header('Accept','application/octet-stream, */*')
    return urllib.request.build_opener(DownloadRedirect()).open(request,timeout=30)


def sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()


class Downloads:
    def __init__(self, library, background=True):
        self.library=library;self.background=background;self.lock=threading.Lock();self.thread=None
        self.pid=os.getpid();self.born=psutil.Process(self.pid).create_time()
        with library.db() as db:
            db.execute('PRAGMA synchronous=FULL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS model_downloads(version TEXT PRIMARY KEY,status TEXT,plan TEXT,
                    received INTEGER,total INTEGER,error TEXT,created REAL,updated REAL,owner INTEGER,born REAL);
                CREATE TABLE IF NOT EXISTS model_download_plans(id TEXT PRIMARY KEY,version TEXT,payload TEXT,created REAL);
            ''')

    def installed(self, version, digest=''):
        with self.library.db() as db:
            rows=db.execute("SELECT name,stamp,hash,payload FROM assets WHERE kind='loras'").fetchall()
        for row in rows:
            item=json.loads(row['payload'])
            if str(item.get('versionId',''))!=version and (not digest or row['hash'].lower()!=digest):continue
            for folder in roots(self.library.root)['loras']:
                path=folder/row['name']
                try:
                    stat=path.stat()
                    if path.is_file() and row['stamp']==f'{stat.st_size}:{stat.st_mtime_ns}':return row['name']
                except OSError:pass
        return ''

    def status(self, versions):
        if not isinstance(versions,list) or len(versions)>64:raise ValueError('At most 64 LoRA versions can be checked at once.')
        result={}
        for value in dict.fromkeys(versions):
            version=version_id(value);name=self.installed(version)
            if name:result[version]=dict(status='installed',name=name);continue
            with self.library.db() as db:row=db.execute('SELECT * FROM model_downloads WHERE version=?',(version,)).fetchone()
            if row and row['status'] in ('queued','downloading','verifying','error'):
                result[version]=dict(status=row['status'],received=row['received'],total=row['total'],error=row['error'])
            else:result[version]=dict(status='available')
        return result

    def prepare(self, value):
        version=version_id(value);current=self.status([version])[version]
        if current['status'] in ('installed','queued','downloading','verifying'):return dict(current,versionId=version)
        try:raw=json.loads(fetch(API+'model-versions/'+version,token=self.library.token()))
        except urllib.error.HTTPError as error:
            if error.code in (401,403):raise ValueError('Civitai requires access to this LoRA. Check the PC Civitai key and your account access.') from None
            if error.code==404:raise ValueError('This LoRA version is no longer available on Civitai.') from None
            raise ValueError('Civitai could not load this LoRA. Try again.') from None
        if not isinstance(raw,dict) or not re.fullmatch('[1-9][0-9]{0,18}',str(raw.get('modelId',''))) or str(raw.get('id'))!=version or str((raw.get('model') or {}).get('type','')).lower() not in LORA_TYPES:
            raise ValueError('This resource is not a downloadable LoRA.')
        files=[]
        for file in raw.get('files') or []:
            if str(file.get('type','')).lower()!='model' or not str(file.get('name','')).lower().endswith('.safetensors'):continue
            digest=str((file.get('hashes') or {}).get('SHA256','')).lower()
            if not re.fullmatch('[a-f0-9]{64}',digest):continue
            try:name=filename(file['name']);url=download_url(file.get('downloadUrl',''),version)
            except ValueError:continue
            size=file.get('sizeKB')
            if type(size) not in (int,float) or not math.isfinite(size) or not 0<size<=MAX_BYTES/1024:continue
            if file.get('virusScanResult')=='Danger' or file.get('pickleScanResult')=='Danger':continue
            files.append((file,name,url,digest,round(size*1024)))
        if not files:raise ValueError('No downloadable SafeTensor file with a published SHA-256 was found for this LoRA.')
        file,name,url,digest,size=next((f for f in files if f[0].get('primary')),files[0])
        existing=self.installed(version,digest)
        if existing:return dict(status='installed',name=existing,versionId=version)
        folder=roots(self.library.root)['loras'][0]
        if folder.exists():
            target=folder/name
            if target.is_file() and sha256(target)==digest:
                plan=dict(versionId=version,name=name,sha256=digest,title=(raw.get('model') or {}).get('name') or name,
                          version=raw.get('name',''),baseModel=raw.get('baseModel',''),modelId=raw.get('modelId'),keywords=raw.get('trainedWords') or [],
                          description=plain(raw.get('description')),fileMetadata=file.get('metadata') or {})
                self.publish(target,plan);return dict(status='installed',name=name,versionId=version)
        plan=dict(versionId=version,name=name,url=url,sha256=digest,bytes=size,title=str(raw['model'].get('name') or name)[:300],
                  version=str(raw.get('name') or '')[:300],baseModel=str(raw.get('baseModel') or '')[:100],modelId=raw.get('modelId'),
                  keywords=[str(word)[:1000] for word in (raw.get('trainedWords') or [])[:100]],description=plain(raw.get('description')),
                  fileMetadata=file.get('metadata') or {})
        confirmation=secrets.token_urlsafe(24)
        with self.library.db() as db:
            db.execute('DELETE FROM model_download_plans WHERE created<?',(time.time()-900,))
            db.execute('INSERT INTO model_download_plans VALUES(?,?,?,?)',(confirmation,version,json.dumps(plan),time.time()))
        return dict(status='confirm',confirmation=confirmation,versionId=version,title=plan['title'],version=plan['version'],
                    baseModel=plan['baseModel'],bytes=size,filename=name,destination=str(folder))

    def start(self, confirmation):
        with self.lock, self.library.db() as db:
            db.execute('PRAGMA synchronous=FULL');db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM model_download_plans WHERE id=?',(str(confirmation),)).fetchone()
            if not row or time.time()-row['created']>900:raise ValueError('Download confirmation expired. Tap + again to check this LoRA.')
            plan=json.loads(row['payload']);version=row['version'];name=self.installed(version,plan['sha256'])
            if name:return dict(status='installed',name=name,versionId=version)
            existing=db.execute('SELECT status FROM model_downloads WHERE version=?',(version,)).fetchone()
            if not existing or existing['status'] not in ('queued','downloading','verifying'):
                now=time.time();db.execute('INSERT OR REPLACE INTO model_downloads VALUES(?,?,?,?,?,?,?,?,?,?)',
                    (version,'queued',json.dumps(plan),0,plan['bytes'],'',now,now,0,0))
        self.kick();return dict(self.status([version])[version],versionId=version)

    def update(self, version, **values):
        values['updated']=time.time()
        with self.library.db() as db:
            db.execute('UPDATE model_downloads SET '+','.join(k+'=?' for k in values)+' WHERE version=?',(*values.values(),version))

    def busy(self):
        with self.library.db() as db:return db.execute("SELECT 1 FROM model_downloads WHERE status IN ('queued','downloading','verifying') LIMIT 1").fetchone() is not None

    def recover(self):
        with self.library.db() as db:rows=db.execute("SELECT version,owner,born FROM model_downloads WHERE status IN ('downloading','verifying')").fetchall()
        for row in rows:
            try:alive=psutil.Process(row['owner']).create_time()==row['born']
            except psutil.Error:alive=False
            if not alive:self.update(row['version'],status='queued',owner=0,born=0,received=0,error='')
        self.kick()

    def kick(self):
        if not self.background:return
        with self.lock:
            if self.thread and self.thread.is_alive():return
            self.thread=threading.Thread(target=self.run,name='LoRA download',daemon=True);self.thread.start()

    def run(self):
        while True:
            with self.lock, self.library.db() as db:
                db.execute('BEGIN IMMEDIATE')
                row=db.execute("SELECT * FROM model_downloads WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                if not row:self.thread=None;return
                db.execute("UPDATE model_downloads SET status='downloading',owner=?,born=? WHERE version=?",(self.pid,self.born,row['version']))
            try:
                plan=json.loads(row['plan']);target=self.transfer(plan)
                # Finish the download first; catalogue enrichment never delays its green check.
                try:
                    with LOCK:self.library.inspect(target,'loras',target.relative_to(roots(self.library.root)['loras'][0]).as_posix(),hashlib.sha256(('loras:'+target.name).encode()).hexdigest()[:32],False)
                except (OSError,ValueError,sqlite3.Error):pass
            except urllib.error.HTTPError as error:
                self.update(row['version'],status='error',error='Civitai denied the download. Check the PC key and account access.' if error.code in (401,403) else 'Model download failed (HTTP '+str(error.code)+'). Tap + to retry.')
            except (OSError,ValueError,sqlite3.Error) as error:
                message=str(error) if isinstance(error,ValueError) else 'The LoRA download was interrupted or the PC could not save it. Tap + to retry.'
                self.update(row['version'],status='error',error=message[:500])

    def transfer(self, plan):
        folder=roots(self.library.root)['loras'][0];folder.mkdir(parents=True,exist_ok=True)
        staging=folder/'.comfybridge-downloads';staging.mkdir(exist_ok=True)
        part=staging/(plan['versionId']+'-'+plan['sha256']+'.part')
        digest=hashlib.sha256();received=0;last=0
        try:
            if shutil.disk_usage(folder).free<plan['bytes']+RESERVE:raise ValueError('Not enough free disk space on the PC for this LoRA.')
            with open_download(download_url(plan['url'],plan['versionId']),self.library.token()) as response, part.open('wb') as out:
                length=response.headers.get('Content-Length')
                if length and (not length.isdigit() or int(length)>MAX_BYTES):raise ValueError('The model download exceeds the supported file size.')
                for block in iter(lambda:response.read(1024*1024),b''):
                    received+=len(block)
                    if received>MAX_BYTES or received>plan['bytes']+1024*1024:raise ValueError('Civitai returned a different file size. Nothing was installed.')
                    out.write(block);digest.update(block)
                    if time.monotonic()-last>=.5:self.update(plan['versionId'],received=received);last=time.monotonic()
                out.flush();os.fsync(out.fileno())
            self.update(plan['versionId'],status='verifying',received=received)
            if digest.hexdigest()!=plan['sha256']:raise ValueError('The downloaded file failed its SHA-256 check. Nothing was installed; tap + to retry.')
            target=folder/filename(plan['name'])
            if target.exists() and sha256(target)!=plan['sha256']:
                target=folder/(target.stem+'_civitai_v'+plan['versionId']+'_'+plan['sha256'][:8]+'.safetensors')
            if not target.exists():
                try:os.link(part,target)
                except FileExistsError:pass
                except OSError as error:
                    if os.name!='nt' or error.errno not in (errno.EPERM,errno.EACCES,errno.ENOTSUP):raise
                    part.rename(target)
            if sha256(target)!=plan['sha256']:raise ValueError('A different file already uses the download filename. Existing files were preserved.')
            self.publish(target,plan)
            self.update(plan['versionId'],status='complete',received=received,total=received,error='',owner=0,born=0)
            return target
        finally:part.unlink(missing_ok=True)

    def publish(self, path, plan):
        folder=roots(self.library.root)['loras'][0];name=path.relative_to(folder).as_posix();stat=path.stat()
        identity=hashlib.sha256(('loras:'+name).encode()).hexdigest()[:32]
        item=dict(id=identity,kind='loras',name=name,title=plan['title'],bytes=stat.st_size,sha256=plan['sha256'],author='',
                  description=plan.get('description',''),version=plan['version'],baseModel=plan['baseModel'],keywords=plan['keywords'],images=[],
                  status='matched',source='Civitai',sourceUrl=f"https://civitai.com/models/{plan['modelId']}?modelVersionId={plan['versionId']}",
                  modelId=plan['modelId'],versionId=int(plan['versionId']),match='Verified downloaded SHA-256',fileMetadata=plan.get('fileMetadata',{}),checked=time.time())
        with LOCK, self.library.db() as db:
            db.execute('INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?,?,?)',(identity,'loras',name,f'{stat.st_size}:{stat.st_mtime_ns}',plan['sha256'],0,json.dumps(item)))
            self.library.last=time.time()
