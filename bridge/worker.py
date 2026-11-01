import asyncio
import base64
import hashlib
import re
from media_index import media_manifest
import io
import json
import logging
import math
import os
import secrets
import sqlite3
import subprocess
import sys
import time
import uuid
import threading
from pathlib import Path
import extension

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps

from queue_progress import LIVE_JOBS, positions, prepare
from studio import prepare as prepare_studio, mark_skipping
from workflows import Workflows
from progress import Progress

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('COMFYBRIDGE_DATA', str(Path(os.environ.get('LOCALAPPDATA', BASE)) / 'ComfyBridge')))
DATA.mkdir(parents=True, exist_ok=True)
logging.basicConfig(filename=DATA/'worker.log', level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
CONFIG = json.loads((BASE / 'config.json').read_text(encoding='utf-8-sig'))
ROOT = Path(CONFIG['comfyRoot'])
COMFY = CONFIG.get('comfyUrl', 'http://127.0.0.1:8188')
TOKEN = (DATA / 'token.txt').read_text().strip()
WF = Workflows(ROOT)
DB = sqlite3.connect(DATA / 'library.sqlite')
DB.row_factory = sqlite3.Row
DB.executescript('''
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, batch TEXT, kind TEXT, settings TEXT,
 status TEXT, progress REAL DEFAULT 0, current_node TEXT DEFAULT '', error TEXT DEFAULT '',
 created REAL, ordinal INTEGER, total INTEGER);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, job TEXT, kind TEXT, path TEXT UNIQUE,
 thumbnail TEXT, duration REAL, created REAL, archived INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS profiles(device TEXT PRIMARY KEY, name TEXT, modified REAL, state TEXT);
CREATE TABLE IF NOT EXISTS stage_cost(kind TEXT, node TEXT, factor REAL, PRIMARY KEY(kind,node));
''')
if 'owner' not in {r[1] for r in DB.execute('PRAGMA table_info(jobs)')}:
    DB.execute("ALTER TABLE jobs ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy'");DB.commit()
prepare(DB)
prepare_studio(DB)
TRACKER = None
LAST_REQUEST = time.monotonic()
IN_FLIGHT = 0
ACTIVE = None
PREVIEW = None
PREVIEW_JOB = None
PREVIEW_REV = 0
PREVIEW_CHANGE = None
SESSION = None
OWNED = None
CLIENT_FILE = DATA / 'client_id.txt'
if not CLIENT_FILE.exists():
    CLIENT_FILE.write_text('comfybridge-' + secrets.token_hex(16))
CLIENT = CLIENT_FILE.read_text().strip()
CATALOG = None
CATALOG_LOCK = asyncio.Lock()
STOPPING = set()


def rows(sql, args=()):
    return [dict(r) for r in DB.execute(sql, args).fetchall()]

def update(id, **values):
    DB.execute('UPDATE jobs SET ' + ','.join(k+'=?' for k in values) + ' WHERE id=?', (*values.values(), id))
    DB.commit()


async def comfy(path, data=None):
    async with SESSION.request('GET' if data is None else 'POST', COMFY+path, json=data,
                               timeout=aiohttp.ClientTimeout(total=30)) as r:
        raw = await r.text()
        result = json.loads(raw) if raw else {}
        if r.status >= 400:
            raise ValueError(json.dumps(result, ensure_ascii=False)[:5000])
        return result


async def ensure_comfy():
    global OWNED
    try:
        await comfy('/system_stats')
        return
    except (aiohttp.ClientError, asyncio.TimeoutError):
        pass
    if OWNED is None or OWNED.poll() is not None:
        env = os.environ.copy()
        hip = str(ROOT / 'rocm/6.4')
        env.update(HIP_PATH=hip, HIP_PATH_64=hip, MIOPEN_FIND_MODE='2', MIOPEN_LOG_LEVEL='3',
                   TORCH_BACKENDS_CUDNN_ENABLED='0', TORCH_BACKENDS_CUDNN_BENCHMARK='0',
                   TRITON_OVERRIDE_ARCH='gfx1100', ZLUDA_COMGR_LOG_LEVEL='1')
        env['PATH'] = ';'.join([hip+'\\bin', hip+'\\lib', hip+'\\lib\\llvm\\bin', env['PATH']])
        log = open(DATA / 'comfy.log', 'ab')
        OWNED = subprocess.Popen([str(ROOT/'zluda/zluda.exe'), '--', str(ROOT/'venv/Scripts/python.exe'),
            'main.py', '--listen', '127.0.0.1', '--port', '8188', '--use-quad-cross-attention',
            '--reserve-vram', '2', '--disable-async-offload', '--disable-pinned-memory', '--force-fp16',
            '--preview-method', 'auto'], cwd=ROOT, env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)
        log.close()
    for _ in range(180):
        await asyncio.sleep(1)
        try:
            await comfy('/system_stats')
            return
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if OWNED.poll() is not None:
                raise ValueError('ComfyUI could not start. See tray monitor and comfy.log.')
    raise ValueError('ComfyUI startup took too long. Check comfy.log.')


async def catalogue():
    if CATALOG is not None:return CATALOG
    async with CATALOG_LOCK:
        return await load_catalogue()


async def load_catalogue():
    global CATALOG
    if CATALOG is not None:
        return CATALOG
    await ensure_comfy()
    obj = await comfy('/object_info')
    def choices(cls, name):
        field = obj[cls]['input']['required'][name]
        return field[0] if isinstance(field[0], list) else field[1].get('options', [])
    CATALOG = dict(defaults=WF.defaults(), models=choices('CheckpointLoaderSimple', 'ckpt_name'),
                   loras=choices('LoraLoader', 'lora_name'))
    return CATALOG


def checked_upload(name):
    if not name:
        return
    path = (ROOT / 'input' / name).resolve()
    allowed = (ROOT / 'input/ComfyBridge').resolve()
    if not path.is_relative_to(allowed) or not path.is_file():
        raise ValueError('Uploaded image is no longer available. Please choose it again.')


def publish_preview(job, data):
    global PREVIEW, PREVIEW_JOB, PREVIEW_REV, PREVIEW_CHANGE
    PREVIEW, PREVIEW_JOB = data, job
    PREVIEW_REV += 1
    if PREVIEW_CHANGE is not None:
        PREVIEW_CHANGE.set()
    PREVIEW_CHANGE = asyncio.Event()


async def websocket():
    while True:
        try:
            async with SESSION.ws_connect(COMFY.replace('http', 'ws', 1)+'/ws?clientId='+CLIENT,
                                          max_msg_size=16*1024*1024) as ws:
                await ws.send_json({'type':'feature_flags','data':{'supports_preview_metadata':True}})
                executing = None
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.BINARY and ACTIVE:
                        raw = msg.data
                        if len(raw) > 8 and int.from_bytes(raw[:4], 'big') == 1 and executing == ACTIVE:
                            publish_preview(ACTIVE, raw[8:])
                        elif len(raw) > 8 and int.from_bytes(raw[:4], 'big') == 4:
                            length = int.from_bytes(raw[4:8], 'big')
                            metadata = json.loads(raw[8:8+length])
                            if metadata.get('prompt_id') == ACTIVE:
                                publish_preview(ACTIVE, raw[8+length:])
                    elif msg.type == aiohttp.WSMsgType.TEXT:
                        event = json.loads(msg.data); d = event.get('data', {})
                        if event['type'] in ('execution_start','executing','progress'):
                            executing=d.get('prompt_id')
                        if not ACTIVE or d.get('prompt_id') != ACTIVE:
                            continue
                        if TRACKER: TRACKER.event(event['type'],d)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            await asyncio.sleep(3)


async def collect(job, entry):
    settings = json.loads(job['settings'])
    ext = settings.get('extension')
    collected = False
    for output in entry.get('outputs', {}).values():
        for key in ('images', 'gifs', 'videos'):
            for item in output.get(key, []):
                if item.get('type') != 'output':
                    continue
                path = (ROOT/'output'/item.get('subfolder', '')/item['filename']).resolve()
                if not path.is_relative_to((ROOT/'output/ComfyBridge').resolve()) or not path.is_file():
                    continue
                id = uuid.uuid4().hex
                thumb = DATA / 'thumbnails' / (id+'.jpg'); thumb.parent.mkdir(exist_ok=True)
                duration = 0
                if job['kind'] == 'image':
                    with Image.open(path) as img:
                        img.thumbnail((400, 400)); img.convert('RGB').save(thumb, quality=80)
                elif ext:
                    src = extension.source_path(DB, ROOT, ext['id'])
                    update(job['id'], current_node='Joining continuation', progress=.99)
                    stop = threading.Event()
                    joining = asyncio.create_task(asyncio.to_thread(extension.join,src,path,ext,int(settings['frames']),thumb,stop.is_set))
                    try:
                        while not joining.done():
                            await asyncio.wait({joining}, timeout=.4)
                            status = DB.execute('SELECT status FROM jobs WHERE id=?',(job['id'],)).fetchone()[0]
                            if status in ('cancelling','cancelled') or job['batch'] in STOPPING:stop.set()
                        duration = await joining
                        if stop.is_set():raise InterruptedError('Extension cancelled.')
                    finally:
                        stop.set()
                elif settings.get('upload'):
                    duration = (5+17*max(0, math.ceil((int(settings['frames'])-5)/17)))/float(settings['fps'])
                    # The submitted first frame is a reliable cover even without ffmpeg installed.
                    with Image.open(ROOT/'input'/settings['upload']) as img:
                        img.thumbnail((400, 400)); img.convert('RGB').save(thumb, quality=80)
                else:
                    import av
                    with av.open(str(path)) as video:
                        stream = video.streams.video[0]
                        frame = next(video.decode(stream), None)
                        if frame is None:
                            raise ValueError('The generated video has no frames.')
                        img = frame.to_image()
                        img.thumbnail((400, 400)); img.convert('RGB').save(thumb, quality=80)
                        duration = stream.frames / float(stream.average_rate)
                DB.execute('INSERT OR IGNORE INTO media VALUES(?,?,?,?,?,?,?,0)',
                           (id, job['id'], job['kind'], str(path), str(thumb), duration, time.time()))
                collected = True
    if job['kind']=='video' and not collected:
        raise ValueError('ComfyUI returned no video.')
    DB.commit()


async def run_jobs():
    global ACTIVE, PREVIEW, TRACKER
    while True:
        jobs = rows(f"SELECT * FROM jobs WHERE {LIVE_JOBS} ORDER BY rowid LIMIT 1")
        if not jobs:
            ACTIVE = None
            await asyncio.sleep(1)
            continue
        j = jobs[0]
        if PREVIEW_JOB != j['id']:
            publish_preview(j['id'], None)
        try:
            settings = json.loads(j['settings'])
            locked=settings['loras'][0]['strength'] if j['kind']=='video' and settings.get('loras') else None
            graph = WF.build(j['kind'], settings, 'ComfyBridge/'+j['id'], recorded_video_strength=locked)
            if ACTIVE!=j['id'] or not TRACKER:
                learned=dict(DB.execute('SELECT node,factor FROM stage_cost WHERE kind=?',(j['kind'],)))
                TRACKER=Progress(j['kind'],graph,settings,learned=learned)
                TRACKER.last=min(.99,float(j['progress'] or 0))
            ACTIVE=j['id']
            await ensure_comfy()
            if j['status'] == 'pending':
                if j['batch'] in STOPPING:
                    update(j['id'], status='cancelled'); continue
                ext = settings.get('extension')
                if ext:
                    update(j['id'],current_node='Reading last five frames')
                    src = extension.source_path(DB,ROOT,ext['id'])
                    await asyncio.to_thread(extension.prepare_guide,ROOT,src,ext,j['id'])
                    if DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]!='pending':
                        continue
                update(j['id'], status='submitting')
                await comfy('/prompt', dict(prompt=graph, client_id=CLIENT, prompt_id=j['id']))
                update(j['id'], status='running')
                if j['batch'] in STOPPING:
                    await cancel_submitted(j['batch'])
            missing = 0
            while True:
                current=DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]
                if current=='cancelled':
                    break
                stopping = current=='cancelling' or j['batch'] in STOPPING
                history = await comfy('/history/'+j['id'])
                if j['id'] in history:
                    stopping = stopping or DB.execute("SELECT status IN ('cancelling','cancelled') FROM jobs WHERE id=?", (j['id'],)).fetchone()[0]
                    entry = history[j['id']]
                    status = entry.get('status', {})
                    if stopping and (settings.get('extension') or not entry.get('outputs')):
                        update(j['id'], status='cancelled')
                    elif status.get('status_str') == 'error':
                        update(j['id'], status='cancelled' if stopping else 'error', error=json.dumps(status.get('messages', []))[-3000:])
                    else:
                        await collect(j, entry)
                        DB.executemany('INSERT INTO stage_cost VALUES(?,?,?) ON CONFLICT(kind,node) DO UPDATE SET factor=0.65*stage_cost.factor+0.35*excluded.factor',
                                       ((j['kind'],node,factor) for node,factor in TRACKER.observed.items()))
                        update(j['id'], status='complete', progress=1, current_node='Saved to library')
                    break
                if current=='cancelling':
                    await cancel_ids({j['id']})
                q = await comfy('/queue')
                progress,stage=TRACKER.sample()
                update(j['id'],progress=progress,current_node=stage)
                known = any(x[1] == j['id'] for x in q['queue_running']+q['queue_pending'])
                missing = 0 if known else missing+1
                if missing >= 3:
                    # A retiring ComfyUI instance can lose history just after SaveVideo closes the MP4.
                    # Recover only a unique output of this job; join verifies its frame count and decodes it.
                    outputs = []
                    if settings.get('extension') and not stopping:
                        folder = ROOT/'output/ComfyBridge'
                        outputs = [p for p in folder.glob(j['id']+'_*.mp4')
                                   if re.fullmatch(re.escape(j['id'])+r'_\d+_\.mp4',p.name)]
                    if len(outputs)==1:
                        item=dict(type='output',subfolder='ComfyBridge',filename=outputs[0].name)
                        await collect(j,{'outputs':{'16':{'images':[item]}}})
                        update(j['id'],status='complete',progress=1,current_node='Saved to library')
                    else:
                        update(j['id'], status='cancelled' if stopping else 'error',
                               error='Job is absent from ComfyUI queue/history. It was not resubmitted to avoid duplicates.')
                    break
                await asyncio.sleep(2)
        except InterruptedError:
            update(j['id'],status='cancelled')
        except (ValueError, OSError, sqlite3.Error, aiohttp.ClientError, asyncio.TimeoutError) as e:
            logging.exception('Job %s failed', j['id'])
            # A transport failure after submission is ambiguous: reconcile before changing state.
            if rows('SELECT status FROM jobs WHERE id=?', (j['id'],))[0]['status'] in ('submitting','running','cancelling') and isinstance(e, (aiohttp.ClientError, asyncio.TimeoutError)):
                await asyncio.sleep(5)
            else:
                update(j['id'], status='error', error=str(e)[:5000])
        finally:
            if json.loads(j['settings']).get('extension') and DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0] in ('complete','cancelled','error'):
                for name in extension.guide_names(j['id']):
                    (ROOT/'input'/name).unlink(missing_ok=True)
        ACTIVE = None
        publish_preview(None, None)


async def idle_watch():
    while True:
        await asyncio.sleep(10)
        pending = rows("SELECT id FROM jobs WHERE status IN ('pending','running','submitting','cancelling')")
        if pending or IN_FLIGHT or time.monotonic()-LAST_REQUEST < 90:
            continue
        if OWNED and OWNED.poll() is None:
            q = await comfy('/queue')
            if q['queue_running'] or q['queue_pending']:
                continue
            # Only the process tree launched by this worker is ours to stop.
            subprocess.run(['taskkill', '/PID', str(OWNED.pid), '/T', '/F'],
                           creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True)
        os._exit(0)


@web.middleware
async def guard(request, handler):
    global LAST_REQUEST, IN_FLIGHT
    if not secrets.compare_digest(request.headers.get('Authorization', ''), 'Bearer '+TOKEN):
        return web.json_response({'error': 'Pairing key required.'}, status=401)
    activity = request.path != "/api/monitor"
    if activity:
        LAST_REQUEST = time.monotonic()
        IN_FLIGHT += 1
    try:
        return await handler(request)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
        return web.json_response({'error': str(e)}, status=400)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        return web.json_response({'error': str(e)}, status=503)
    finally:
        if activity:
            IN_FLIGHT -= 1
            LAST_REQUEST = time.monotonic()


async def cancel_submitted(batch):
    ids={r['id'] for r in rows("SELECT id FROM jobs WHERE batch=? AND status IN ('running','submitting','cancelling')",(batch,))}
    await cancel_ids(ids)


async def cancel_ids(ids):
    if not ids:return
    q=await comfy('/queue')
    queued=[j[1] for j in q['queue_pending'] if j[1] in ids]
    if queued:
        await comfy('/queue',{'delete':queued})
        q=await comfy('/queue')
        remaining={j[1] for j in q['queue_running']+q['queue_pending']}
        for id in queued:
            if id not in remaining and id not in await comfy('/history/'+id):
                update(id,status='cancelled')
    for j in q['queue_running']:
        if j[1] in ids:
            with DB:
                changed=DB.execute("UPDATE jobs SET status='cancelling' WHERE id=? AND status IN ('running','submitting','cancelling')",(j[1],)).rowcount
            if changed:
                await comfy('/interrupt',{'prompt_id':j[1]})


async def api(request):
    path = request.match_info.get('path', '')
    device=request.headers.get('X-Bridge-Device','legacy')
    if device!='legacy': device=str(uuid.UUID(device))
    if path.startswith(('profile-blob/','profile-has/')):
        digest=path.split('/',1)[1]
        if not re.fullmatch('[0-9a-f]{64}',digest): raise ValueError('Invalid backup reference')
        folder=DATA/'profile-inputs';folder.mkdir(exist_ok=True);target=folder/digest
        if path.startswith('profile-has/'):return web.json_response({'exists':target.is_file()})
        if request.method=='POST':
            value=(await request.json())['value']
            if not value.startswith('data:image/') or hashlib.sha256(value.encode()).hexdigest()!=digest:raise ValueError('Invalid backup data')
            if not target.exists():
                tmp=folder/(digest+'.tmp');tmp.write_text(value,encoding='utf8');tmp.replace(target)
            return web.json_response({'ok':True})
        if not target.exists():raise web.HTTPNotFound()
        return web.json_response({'value':target.read_text(encoding='utf8')})
    if path=='profiles':
        return web.json_response(rows('SELECT device,name,modified FROM profiles ORDER BY modified DESC'))
    if path=='profile' and request.method=='POST':
        d=await request.json(); profile=d['state']
        if device=='legacy' or not all(k in profile for k in ('settings','presets','prompts','inputs')):raise ValueError('Incomplete phone backup')
        def verify(value):
            if isinstance(value,dict):
                if 'bridgeInput' in value:
                    h=value['bridgeInput']
                    if not isinstance(h,str) or not re.fullmatch('[0-9a-f]{64}',h) or not (DATA/'profile-inputs'/h).is_file():
                        raise ValueError('A backup input is missing. Previous settings were kept.')
                else:
                    for v in value.values():verify(v)
            elif isinstance(value,list):
                for v in value:verify(v)
        verify(profile)
        DB.execute('INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(device) DO UPDATE SET name=excluded.name,modified=excluded.modified,state=excluded.state WHERE profiles.state!=excluded.state OR profiles.name!=excluded.name',
                   (device,str(d['name'])[:80],time.time(),json.dumps(profile,sort_keys=True)));DB.commit()
        return web.json_response({'ok':True})
    if path.startswith('profile/'):
        p=rows('SELECT state FROM profiles WHERE device=?',(str(uuid.UUID(path[8:])),))
        if not p:raise web.HTTPNotFound()
        return web.json_response(json.loads(p[0]['state']))
    if path == 'catalog':
        return web.json_response(await catalogue())
    if path in ('monitor','status') or path.startswith('batch/'):
        fields='id,batch,owner,kind,status,progress,current_node,error,ordinal,total,created'
        if path=='monitor':jobs=rows(f"SELECT {fields} FROM jobs WHERE {LIVE_JOBS} ORDER BY rowid")
        elif path=='status':
            jobs=rows(f"SELECT {fields} FROM jobs WHERE {LIVE_JOBS} OR rowid IN "
                      "(SELECT rowid FROM jobs ORDER BY rowid DESC LIMIT 100) ORDER BY rowid DESC")
        else:jobs=rows(f'SELECT {fields} FROM jobs WHERE batch=? AND owner=? ORDER BY ordinal',(str(uuid.UUID(path[6:])),device))
        counts = positions(DB) if jobs else {}
        for j in jobs:
            if j['id'] in counts:
                j['queuePosition'], j['queueTotal'] = counts[j['id']]
            if j['id']==ACTIVE and TRACKER and j['status'] not in ('complete','cancelled','error'):
                j['progress'],j['current_node']=TRACKER.sample()
        return web.json_response(dict(protocol=10,jobs=jobs, active=ACTIVE, preview=bool(PREVIEW), previewRevision=PREVIEW_REV,ownedComfy=bool(OWNED)))
    if path.startswith('preview/'):
        job=str(uuid.UUID(path[8:]))
        after=int(request.query.get('after','-1'))
        if ACTIVE==job and PREVIEW_JOB==job and PREVIEW_CHANGE is not None and (not PREVIEW or after==PREVIEW_REV):
            try:
                await asyncio.wait_for(PREVIEW_CHANGE.wait(),5)
            except asyncio.TimeoutError:
                pass
        if ACTIVE!=job or PREVIEW_JOB!=job:
            raise web.HTTPGone()
        headers={'Cache-Control':'no-store','X-Preview-Revision':str(PREVIEW_REV)}
        if not PREVIEW or after==PREVIEW_REV:
            return web.Response(status=204,headers=headers)
        mime='image/png' if PREVIEW.startswith(b'\x89PNG') else 'image/jpeg'
        return web.Response(body=PREVIEW,content_type=mime,headers=headers)
    if path == 'preview':
        return web.Response(body=PREVIEW or b'', content_type='image/jpeg')
    if path == 'library':
        items = rows('SELECT id,job,kind,duration,created,archived FROM media ORDER BY created DESC')
        return web.json_response(items)
    if path.startswith('extension/'):
        media_id = path.split('/',1)[1]
        source = extension.source_path(DB,ROOT,media_id)
        return web.json_response(await asyncio.to_thread(extension.describe,source,media_id))
    if path == 'media-index':
        items = rows('SELECT id,job,kind,duration,created,archived,path FROM media ORDER BY created DESC,id DESC')
        return web.json_response(await asyncio.to_thread(media_manifest, items, ROOT, DATA))
    if path.startswith('media/') or path.startswith('thumb/'):
        parts = path.split('/')
        item = rows('SELECT * FROM media WHERE id=?', (parts[1],))
        if not item:
            raise web.HTTPNotFound()
        return web.FileResponse(item[0]['path' if parts[0] == 'media' else 'thumbnail'])
    if path == 'archive' and request.method == 'POST':
        d = await request.json()
        DB.execute('UPDATE media SET archived=? WHERE id=?', (int(bool(d['archived'])), d['id'])); DB.commit()
        return web.json_response({'ok': True})
    if path == 'upload' and request.method == 'POST':
        d = await request.json()
        raw = base64.b64decode(d['data'].split(',')[-1], validate=True)
        with Image.open(io.BytesIO(raw)) as src:
            if src.width*src.height > 40_000_000:
                raise ValueError('Image exceeds 40 megapixels.')
            img = ImageOps.exif_transpose(src).convert('RGB')
            name = 'ComfyBridge/'+uuid.uuid4().hex+'.png'
            (ROOT/'input/ComfyBridge').mkdir(exist_ok=True)
            img.save(ROOT/'input'/name)
            return web.json_response(dict(name=name, width=img.width, height=img.height))
    if path == 'generate' and request.method == 'POST':
        d = await request.json(); batch = str(uuid.UUID(d['requestId']))
        kind = d['kind']; s = d['settings']; count = int(d.get('count', 1))
        if count not in (1, 2, 4, 8, 16):
            raise ValueError('Batch must be 1, 2, 4, 8 or 16.')
        existing=rows('SELECT id,owner FROM jobs WHERE batch=? ORDER BY ordinal',(batch,))
        if existing:
            if existing[0]['owner']!=device:raise web.HTTPForbidden()
            return web.json_response(dict(batch=batch,ids=[r['id'] for r in existing]))
        checked_upload(s.get('upload')); checked_upload(s.get('mask'))
        if s.get('extension'):
            if kind!='video' or s.get('upload') or s.get('mask'):
                raise ValueError('An extension needs one source video.')
            requested=s['extension'];source=extension.source_path(DB,ROOT,requested['id'])
            info=await asyncio.to_thread(extension.describe,source,requested['id'])
            if info['revision']!=requested.get('revision'):
                raise ValueError('Source video changed. Select Extend video again.')
            s.update(extension=info,width=info['width'],height=info['height'],fps=info['fps'],scale=0)
        cat = await catalogue()
        existing=rows('SELECT id,owner FROM jobs WHERE batch=? ORDER BY ordinal',(batch,))
        if existing:
            if existing[0]['owner']!=device:raise web.HTTPForbidden()
            return web.json_response(dict(batch=batch,ids=[r['id'] for r in existing]))
        if len(rows("SELECT id FROM jobs WHERE status IN ('pending','running','submitting','cancelling')")) + count > 64:
            raise ValueError('The bridge queue is full (64 jobs).')
        if kind == 'image' and s['model'] not in cat['models']:
            raise ValueError('The selected checkpoint is not available.')
        locked=None
        if kind == 'video' and s.get('loras'):
            required,locked=WF.widgets('video',8)[:2]
            if s.get('replayOf'):
                original=DB.execute("SELECT settings FROM jobs WHERE id=? AND kind='video'",(str(uuid.UUID(s['replayOf'])),)).fetchone()
                original_loras=json.loads(original[0]).get('loras',[]) if original else []
                if not original_loras or original_loras[0]['name']!=required:
                    raise ValueError('The original video workflow LoRA is unavailable.')
                locked=original_loras[0]['strength']
            s['loras'][0]['strength']=locked
        for l in s.get('loras', []):
            if l.get('enabled', True) and l['name'] not in cat['loras']:
                raise ValueError('A selected LoRA is not available: '+l['name'])
        ids = []; created = time.time()
        prepared = []
        for i in range(count):
            settings = dict(s); settings['seed'] = str((int(s['seed'])+(i if s.get('increment') else 0)) % (2**64))
            id = str(uuid.uuid4()); WF.build(kind, settings, 'ComfyBridge/'+id, recorded_video_strength=locked)
            prepared.append((id,batch,kind,json.dumps(settings),'pending',created,i+1,count,device)); ids.append(id)
        with DB:
            DB.executemany('INSERT INTO jobs(id,batch,kind,settings,status,created,ordinal,total,owner) '
                           'VALUES(?,?,?,?,?,?,?,?,?)', prepared)
        return web.json_response(dict(batch=batch, ids=ids))
    if path=='skip' and request.method=='POST':
        job=str(uuid.UUID((await request.json())['id']))
        try:
            interrupt=mark_skipping(DB,job,device,ACTIVE)
        except PermissionError:
            raise web.HTTPForbidden()
        except ValueError as error:
            return web.json_response({'error':str(error)},status=409)
        if interrupt:
            await cancel_ids({job})
        return web.json_response({'ok':True})
    if path == 'stop' and request.method == 'POST':
        d = await request.json(); batch = str(uuid.UUID(d['batch']))
        owner=rows('SELECT owner FROM jobs WHERE batch=? LIMIT 1',(batch,))
        if not owner or owner[0]['owner']!=device:raise web.HTTPForbidden()
        STOPPING.add(batch)
        DB.execute("UPDATE jobs SET status='cancelled' WHERE batch=? AND status='pending'", (batch,)); DB.commit()
        await cancel_submitted(batch)
        return web.json_response({'ok': True})
    raise web.HTTPNotFound()


async def start(app):
    global SESSION
    SESSION = aiohttp.ClientSession()
    app['tasks'] = [asyncio.create_task(f()) for f in (run_jobs, websocket, idle_watch)]


async def cleanup(app):
    for task in app['tasks']:
        task.cancel()
    await SESSION.close()


if __name__ == '__main__':
    app = web.Application(middlewares=[guard], client_max_size=55*1024*1024)
    app.router.add_route('*', '/api/{path:.*}', api)
    app.on_startup.append(start); app.on_cleanup.append(cleanup)
    web.run_app(app, host='127.0.0.1', port=18766, print=None, access_log=None)
