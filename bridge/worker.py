import asyncio
import base64
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
from pathlib import Path

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps

from workflows import Workflows

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
''')
LAST_REQUEST = time.monotonic()
IN_FLIGHT = 0
ACTIVE = None
PREVIEW = None
SESSION = None
OWNED = None
CLIENT_FILE = DATA / 'client_id.txt'
if not CLIENT_FILE.exists():
    CLIENT_FILE.write_text('comfybridge-' + secrets.token_hex(16))
CLIENT = CLIENT_FILE.read_text().strip()
CATALOG = None
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


async def websocket():
    global PREVIEW
    while True:
        try:
            async with SESSION.ws_connect(COMFY.replace('http', 'ws', 1)+'/ws?clientId='+CLIENT,
                                          max_msg_size=16*1024*1024) as ws:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.BINARY and ACTIVE:
                        raw = msg.data
                        if len(raw) > 8 and int.from_bytes(raw[:4], 'big') == 1:
                            PREVIEW = raw[8:]
                        elif len(raw) > 8 and int.from_bytes(raw[:4], 'big') == 4:
                            length = int.from_bytes(raw[4:8], 'big')
                            metadata = json.loads(raw[8:8+length])
                            if metadata.get('prompt_id', ACTIVE) == ACTIVE:
                                PREVIEW = raw[8+length:]
                    elif msg.type == aiohttp.WSMsgType.TEXT:
                        event = json.loads(msg.data); d = event.get('data', {})
                        if not ACTIVE or d.get('prompt_id') != ACTIVE:
                            continue
                        if event['type'] == 'progress':
                            update(ACTIVE, progress=d.get('value', 0)/max(1, d.get('max', 1)))
                        elif event['type'] == 'executing':
                            update(ACTIVE, current_node=str(d.get('node') or 'Saving'))
        except (aiohttp.ClientError, asyncio.TimeoutError):
            await asyncio.sleep(3)


def collect(job, entry):
    settings = json.loads(job['settings'])
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
                else:
                    duration = (5+17*max(0, math.ceil((int(settings['frames'])-5)/17)))/float(settings['fps'])
                    # The submitted first frame is a reliable cover even without ffmpeg installed.
                    with Image.open(ROOT/'input'/settings['upload']) as img:
                        img.thumbnail((400, 400)); img.convert('RGB').save(thumb, quality=80)
                DB.execute('INSERT OR IGNORE INTO media VALUES(?,?,?,?,?,?,?,0)',
                           (id, job['id'], job['kind'], str(path), str(thumb), duration, time.time()))
    DB.commit()


async def run_jobs():
    global ACTIVE, PREVIEW
    while True:
        jobs = rows("SELECT * FROM jobs WHERE status IN ('pending','submitting','running','cancelling') ORDER BY created, ordinal LIMIT 1")
        if not jobs:
            ACTIVE = None
            await asyncio.sleep(1)
            continue
        j = jobs[0]; ACTIVE = j['id']; PREVIEW = None
        try:
            await ensure_comfy()
            if j['status'] == 'pending':
                if j['batch'] in STOPPING:
                    update(j['id'], status='cancelled'); continue
                settings = json.loads(j['settings'])
                graph = WF.build(j['kind'], settings, 'ComfyBridge/'+j['id'])
                update(j['id'], status='submitting')
                await comfy('/prompt', dict(prompt=graph, client_id=CLIENT, prompt_id=j['id']))
                update(j['id'], status='running')
            missing = 0
            while True:
                history = await comfy('/history/'+j['id'])
                if j['id'] in history:
                    entry = history[j['id']]
                    status = entry.get('status', {})
                    if status.get('status_str') == 'error':
                        update(j['id'], status='cancelled' if j['batch'] in STOPPING else 'error', error=json.dumps(status.get('messages', []))[-3000:])
                    else:
                        collect(j, entry)
                        update(j['id'], status='complete', progress=1)
                    break
                q = await comfy('/queue')
                known = any(x[1] == j['id'] for x in q['queue_running']+q['queue_pending'])
                missing = 0 if known else missing+1
                if missing >= 3:
                    update(j['id'], status='cancelled' if j['batch'] in STOPPING else 'error',
                           error='Job is absent from ComfyUI queue/history. It was not resubmitted to avoid duplicates.')
                    break
                await asyncio.sleep(2)
        except (ValueError, OSError, sqlite3.Error, aiohttp.ClientError, asyncio.TimeoutError) as e:
            logging.exception('Job %s failed', j['id'])
            # A transport failure after submission is ambiguous: reconcile before changing state.
            if rows('SELECT status FROM jobs WHERE id=?', (j['id'],))[0]['status'] in ('submitting','running','cancelling') and isinstance(e, (aiohttp.ClientError, asyncio.TimeoutError)):
                await asyncio.sleep(5)
            else:
                update(j['id'], status='error', error=str(e)[:5000])
        ACTIVE = None


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


async def api(request):
    path = request.match_info.get('path', '')
    if path == 'catalog':
        return web.json_response(await catalogue())
    if path == 'monitor':
        jobs = rows("SELECT id,kind,status,progress,current_node,ordinal,total,created FROM jobs WHERE status IN ('pending','submitting','running','cancelling') ORDER BY created,ordinal")
        return web.json_response(dict(jobs=jobs, active=ACTIVE))
    if path == 'status':
        jobs = rows('SELECT id,batch,kind,status,progress,current_node,error,ordinal,total,created FROM jobs ORDER BY created DESC,ordinal DESC LIMIT 100')
        return web.json_response(dict(jobs=jobs, active=ACTIVE, preview=bool(PREVIEW), ownedComfy=bool(OWNED)))
    if path == 'preview':
        return web.Response(body=PREVIEW or b'', content_type='image/jpeg')
    if path == 'library':
        items = rows('SELECT id,job,kind,duration,created,archived FROM media ORDER BY created DESC')
        return web.json_response(items)
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
        existing = rows('SELECT id FROM jobs WHERE batch=?', (batch,))
        if existing:
            return web.json_response(dict(batch=batch, ids=[j['id'] for j in existing]))
        kind = d['kind']; s = d['settings']; count = int(d.get('count', 1))
        if count not in (1, 2, 4, 8, 16):
            raise ValueError('Batch must be 1, 2, 4, 8 or 16.')
        if len(rows("SELECT id FROM jobs WHERE status IN ('pending','running','submitting','cancelling')")) + count > 64:
            raise ValueError('The bridge queue is full (64 jobs).')
        checked_upload(s.get('upload')); checked_upload(s.get('mask'))
        cat = await catalogue()
        if kind == 'image' and s['model'] not in cat['models']:
            raise ValueError('The selected checkpoint is not available.')
        for l in s.get('loras', []):
            if l.get('enabled', True) and l['name'] not in cat['loras']:
                raise ValueError('A selected LoRA is not available: '+l['name'])
        ids = []; created = time.time()
        prepared = []
        for i in range(count):
            settings = dict(s); settings['seed'] = str((int(s['seed'])+(i if s.get('increment') else 0)) % (2**64))
            id = str(uuid.uuid4()); WF.build(kind, settings, 'ComfyBridge/'+id)
            prepared.append((id,batch,kind,json.dumps(settings),'pending',created,i+1,count)); ids.append(id)
        DB.executemany('INSERT INTO jobs(id,batch,kind,settings,status,created,ordinal,total) VALUES(?,?,?,?,?,?,?,?)', prepared); DB.commit()
        return web.json_response(dict(batch=batch, ids=ids))
    if path == 'stop' and request.method == 'POST':
        d = await request.json(); batch = d['batch']; STOPPING.add(batch)
        affected = rows("SELECT id,status FROM jobs WHERE batch=? AND status IN ('pending','running','submitting','cancelling')", (batch,))
        DB.execute("UPDATE jobs SET status='cancelled' WHERE batch=? AND status='pending'", (batch,)); DB.commit()
        q = await comfy('/queue')
        ids = {j['id'] for j in affected}
        queued = [j[1] for j in q['queue_pending'] if j[1] in ids]
        if queued:
            await comfy('/queue', {'delete': queued})
        for j in q['queue_running']:
            if j[1] in ids:
                # This ComfyUI version supports targeted interruption; never interrupt another client.
                update(j[1], status='cancelling')
                await comfy('/interrupt', {'prompt_id': j[1]})
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
