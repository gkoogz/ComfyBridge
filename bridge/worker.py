import asyncio
import base64
import hashlib
import re
from media_index import media_manifest, with_ratings
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
import recipes
import gpu_handoff as gpu
from model_gallery import Gallery
from model_library import Library as ModelLibrary
from handoff import adopt

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps

from queue_progress import LIVE_JOBS, positions, prepare
from studio import prepare as prepare_studio, mark_skipping
from workflows import Workflows, EROS_BETA7, H3_AUDIO_VAE
from progress import Progress
from queue_eta import QueueEta
from cancel_recovery import can_recover
ETA = QueueEta()
IMPORT_LOCK = asyncio.Lock()
COMFY_START_LOCK = asyncio.Lock()
MAX_VIDEO_UPLOAD = 512*1024*1024

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
PRAGMA synchronous=FULL;
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
DB.execute("CREATE TABLE IF NOT EXISTS generation_graphs(job TEXT PRIMARY KEY,graph TEXT NOT NULL)")
TRACKER = None
LAST_REQUEST = time.monotonic()
IN_FLIGHT = 0
ACTIVE = None
PREVIEW = None
PREVIEW_JOB = None
PREVIEW_REV = 0
PREVIEW_CHANGE = None
SESSION = None
OWNED = adopt(DATA, ROOT)
CLIENT_FILE = DATA / 'client_id.txt'
if not CLIENT_FILE.exists():
    CLIENT_FILE.write_text('comfybridge-' + secrets.token_hex(16))
CLIENT = CLIENT_FILE.read_text().strip()
CATALOG = None
CATALOG_AT = 0
CATALOG_EROS_ON_DISK = None
CATALOG_LOCK = asyncio.Lock()
MODELS = ModelLibrary(ROOT, DATA)
MODEL_GALLERY = Gallery(MODELS)
STOPPING = set()
CANCEL_STARTED = {}
HANDOFF_STAGE = {}


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
    async with COMFY_START_LOCK:
        await _ensure_comfy()


async def _ensure_comfy():
    global OWNED
    state=gpu.chat_state(DATA)
    if state.get('gpu') or gpu.granted(DATA,state.get('active')):
        raise ValueError('Chat is using the GPU. Generation stays queued until the reply finishes.')
    node=ROOT/'custom_nodes/comfybridge_eros_vsa/__init__.py'
    checkpoint_node=ROOT/'custom_nodes/comfybridge_checkpoint/__init__.py'
    revision=hashlib.sha256(b''.join(p.read_bytes() for p in (node,checkpoint_node) if p.is_file())).hexdigest()
    marker=DATA/'comfy-node-version.json'
    try:
        await comfy('/system_stats')
        try:loaded=json.loads(marker.read_text())
        except (OSError,ValueError):loaded={}
        if not revision or OWNED is None or OWNED.poll() is not None or loaded==dict(pid=OWNED.pid,revision=revision):
            return
        queue=await comfy('/queue')
        if queue['queue_running'] or queue['queue_pending']:
            return
        # The queue is idle: apply custom-node updates without interrupting work.
        result=await asyncio.to_thread(subprocess.run,['taskkill','/PID',str(OWNED.pid),'/T','/F'],
                                      creationflags=subprocess.CREATE_NO_WINDOW,capture_output=True,timeout=20)
        if result.returncode!=0:
            raise OSError('Could not reload the updated Eros node safely.')
        OWNED=None
    except (aiohttp.ClientError, asyncio.TimeoutError):
        pass
    if OWNED is None or OWNED.poll() is not None:
        env = os.environ.copy()
        env['COMFYBRIDGE_DATA'] = str(DATA)
        hip = str(ROOT / 'rocm/6.4')
        env.update(HIP_PATH=hip, HIP_PATH_64=hip, MIOPEN_FIND_MODE='2', MIOPEN_LOG_LEVEL='3',
                   TORCH_BACKENDS_CUDNN_ENABLED='0', TORCH_BACKENDS_CUDNN_BENCHMARK='0',
                   TRITON_OVERRIDE_ARCH='gfx1100', ZLUDA_COMGR_LOG_LEVEL='1')
        env['PATH'] = ';'.join([hip+'\\bin', hip+'\\lib', hip+'\\lib\\llvm\\bin', env['PATH']])
        log = open(DATA / 'comfy.log', 'ab')
        OWNED = subprocess.Popen([str(ROOT/'zluda/zluda.exe'), '--', str(ROOT/'venv/Scripts/python.exe'),
            'main.py', '--listen', '127.0.0.1', '--port', '8188', '--use-quad-cross-attention',
            '--reserve-vram', '2', '--disable-async-offload', '--disable-pinned-memory', '--force-fp16',
            # Release consumed encoder/model outputs instead of retaining tens of GB between stages.
            '--cache-none', '--preview-method', 'auto'], cwd=ROOT, env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)
        log.close()
    for _ in range(180):
        await asyncio.sleep(1)
        try:
            await comfy('/system_stats')
            if OWNED is not None:
                marker.write_text(json.dumps(dict(pid=OWNED.pid,revision=revision)))
            return
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if OWNED.poll() is not None:
                raise ValueError('ComfyUI could not start. See tray monitor and comfy.log.')
    raise ValueError('ComfyUI startup took too long. Check comfy.log.')


async def catalogue():
    global CATALOG
    installed=(ROOT/'models/diffusion_models'/EROS_BETA7).is_file()
    if CATALOG_EROS_ON_DISK is not None and installed!=CATALOG_EROS_ON_DISK:
        CATALOG=None
    if MODELS.last>CATALOG_AT:CATALOG=None
    if CATALOG is not None:return CATALOG
    async with CATALOG_LOCK:
        return await load_catalogue()


async def load_catalogue():
    global CATALOG, CATALOG_EROS_ON_DISK, CATALOG_AT
    if CATALOG is not None:
        return CATALOG
    await ensure_comfy()
    eros_on_disk=(ROOT/'models/diffusion_models'/EROS_BETA7).is_file()
    obj = await comfy('/object_info')
    def choices(cls, name):
        field = obj[cls]['input']['required'][name]
        return field[0] if isinstance(field[0], list) else field[1].get('options', [])
    CATALOG = dict(defaults=WF.defaults(), models=choices('CheckpointLoaderSimple', 'ckpt_name'),
                   loras=choices('LoraLoader', 'lora_name'))
    h3_inputs=obj.get('MiniMaxH3ImageToVideo',{}).get('input',{})
    CATALOG['finalFrameSupported']=any('last_frame' in h3_inputs.get(key,{}) for key in ('required','optional'))
    CATALOG['videoModels']=WF.video_models(obj,choices('UNETLoader','unet_name'),choices('CLIPLoader','clip_name'),
                                            choices('VAELoader','vae_name'),CATALOG['loras'])
    CATALOG['audioMissing']=[name for name in ('LTXVAudioVAEDecode','TrimAudioDuration') if name not in obj]
    if H3_AUDIO_VAE not in choices('VAELoader','vae_name'):
        CATALOG['audioMissing'].append(H3_AUDIO_VAE)
    CATALOG_EROS_ON_DISK=eros_on_disk
    CATALOG_AT=time.time()
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
                        if event['type']=='execution_error' and d.get('exception_type','').endswith('ComfyBridgeCheckpointPaused'):
                            HANDOFF_STAGE[ACTIVE]='Checkpoint saved · paused for chat'
                            continue
                        if event['type']=='executing' and d.get('node') is None and ACTIVE in HANDOFF_STAGE:
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
                if job['kind']=='video' and settings.get('sound') and not ext:
                    update(job['id'], current_node='Timing soundtrack', progress=.99)
                    await asyncio.to_thread(extension.finish_sound,path,settings['fps'])
                if job['kind'] == 'image':
                    with Image.open(path) as img:
                        img.thumbnail((400, 400)); img.convert('RGB').save(thumb, quality=80)
                elif ext:
                    src = extension.source_path(DB, ROOT, ext['id'])
                    update(job['id'], current_node='Joining continuation', progress=.99)
                    stop = threading.Event()
                    joining = asyncio.create_task(asyncio.to_thread(extension.join,src,path,ext,int(settings['frames']),thumb,stop.is_set,settings.get('sound')))
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
                    frames=int(settings['frames'])
                    if not settings.get('exactFrames'):frames=5+17*max(0,math.ceil((frames-5)/17))
                    duration = frames/float(settings['fps'])
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


async def release_for_chat():
    """Release only an idle renderer; never interrupt a forward pass or other work."""
    global OWNED
    async with COMFY_START_LOCK:
        try:
            q = await comfy('/queue')
        except aiohttp.ClientConnectorError:
            # A dead process has no GPU allocations. A live but unreachable one is unsafe.
            return OWNED is None or OWNED.poll() is not None
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return False
        if q['queue_running'] or q['queue_pending']:
            return False
        # Cooperatively empty both execution and model caches. Do not terminate
        # ComfyUI: a different client could submit work after our queue check.
        # Comfy processes /free between executions, then we verify release.
        await comfy('/free', dict(unload_models=True, free_memory=True))
        await asyncio.sleep(2)
        stats = await comfy('/system_stats')
        devices = stats.get('devices', [])
        q=await comfy('/queue')
        return (not q['queue_running'] and not q['queue_pending'] and bool(devices)
                and all(d.get('torch_vram_total', float('inf')) < 512*1024**2 for d in devices))


async def chat_window(job=None):
    """Hold admission until chat has actually exited, including its failure cleanup."""
    released = False
    try:
        while gpu.wants_chat(DATA):
            if released:
                try:
                    q=await comfy('/queue')
                    if q['queue_running'] or q['queue_pending']:
                        released=False
                        gpu.revoke(DATA)
                except aiohttp.ClientConnectorError:
                    pass
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    released=False
                    gpu.revoke(DATA)
            if job:
                state = rows('SELECT status FROM jobs WHERE id=?', (job,))[0]['status']
                if state in ('cancelled','cancelling'):
                    update(job, status='cancelled', current_node='Cancelled while paused')
                    return False
                saved=gpu.checkpoint(DATA,job)
                HANDOFF_STAGE[job] = (f"Video paused at {saved['step']}/{saved['total']} · "+('chat using GPU' if released else 'releasing video memory')) if saved else 'Waiting for chat to release GPU'
                update(job, current_node=HANDOFF_STAGE[job])
            if not released:
                released = await release_for_chat()
            state = gpu.chat_state(DATA)
            if released and state.get('active'):
                gpu.grant(DATA, state['active'])
            await asyncio.sleep(1)
        return True
    finally:
        if not gpu.wants_chat(DATA):
            gpu.revoke(DATA)
        if job:
            HANDOFF_STAGE.pop(job, None)


async def resume_checkpoint(j, graph):
    """Resume only an acknowledged checkpoint, after the old execution has exited."""
    global TRACKER
    if not await chat_window(j['id']):
        return False
    gpu.check_assets(DATA,j['id'],ROOT,graph)
    gpu.request_pause(DATA, j['id'], False)
    HANDOFF_STAGE[j['id']] = 'Resuming video · reloading model'
    update(j['id'], current_node=HANDOFF_STAGE[j['id']])
    await ensure_comfy()
    q = await comfy('/queue')
    if any(x[1]==j['id'] for x in q['queue_running']+q['queue_pending']):
        return True
    if q['queue_running'] or q['queue_pending']:
        return False
    # Clear the previous paused execution, not anyone else's history.
    await comfy('/history', dict(delete=[j['id']]))
    previous=float(rows('SELECT progress FROM jobs WHERE id=?',(j['id'],))[0]['progress'] or 0)
    TRACKER=Progress(j['kind'],graph,json.loads(j['settings']))
    TRACKER.last=min(.99,previous)
    await comfy('/prompt', dict(prompt=graph, client_id=CLIENT, prompt_id=j['id']))
    update(j['id'], status='running')
    HANDOFF_STAGE.pop(j['id'], None)
    return True


def verify_checkpoint_output(path, settings):
    """A crash after MP4 save must not cause a second copy of a finished video."""
    import av
    expected=int(settings['frames'])
    if not settings.get('exactFrames'):
        expected=5+17*max(0,math.ceil((expected-5)/17))
    with av.open(str(path)) as video:
        if settings.get('sound') and not video.streams.audio:
            raise ValueError('Existing checkpoint output has no soundtrack. Checkpoint kept for recovery.')
        count=sum(1 for _ in video.decode(video=0))
        if count!=expected:
            raise ValueError('Existing checkpoint output is incomplete. Checkpoint kept rather than duplicating it.')


async def run_jobs():
    global ACTIVE, PREVIEW, TRACKER
    while True:
        jobs = rows(f"SELECT * FROM jobs WHERE {LIVE_JOBS} ORDER BY rowid LIMIT 1")
        if not jobs:
            ACTIVE = None
            try:
                if gpu.wants_chat(DATA):
                    await chat_window()
            except (OSError, sqlite3.Error, aiohttp.ClientError, asyncio.TimeoutError):
                logging.exception('Idle GPU handoff will retry')
            await asyncio.sleep(1)
            continue
        j = jobs[0]
        if PREVIEW_JOB != j['id']:
            publish_preview(j['id'], None)
        try:
            settings = json.loads(j['settings'])
            locked=settings['loras'][0]['strength'] if j['kind']=='video' and settings.get('loras') else None
            graph = recipes.recorded_graph(DB,j['id']) or WF.build(j['kind'], settings, 'ComfyBridge/'+j['id'], recorded_video_strength=locked)
            if ACTIVE!=j['id'] or not TRACKER:
                learned=dict(DB.execute('SELECT node,factor FROM stage_cost WHERE kind=?',(j['kind'],)))
                TRACKER=Progress(j['kind'],graph,settings,learned=learned)
                TRACKER.last=min(.99,float(j['progress'] or 0))
            ACTIVE=j['id']
            if j['status'] == 'pending':
                if not await chat_window(j['id']):
                    continue
            elif gpu.checkpoint(DATA,j['id']) and gpu.wants_chat(DATA):
                try:
                    q=await comfy('/queue')
                except aiohttp.ClientConnectorError:
                    q=dict(queue_running=[],queue_pending=[])
                if not any(x[1]==j['id'] for x in q['queue_running']+q['queue_pending']):
                    if not await chat_window(j['id']):
                        continue
            try:
                await ensure_comfy()
            except (ValueError,OSError,aiohttp.ClientError,asyncio.TimeoutError):
                # A renderer that is still restarting must not consume a saved
                # job as a failure. Keep its recipe and position and retry.
                status=DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]
                if status=='cancelling':update(j['id'],status='cancelled')
                elif status in ('pending','running','submitting'):
                    update(j['id'],current_node='Waiting for ComfyUI to restart · queue saved')
                    await asyncio.sleep(5)
                continue
            if j['status'] == 'pending':
                if j['batch'] in STOPPING:
                    update(j['id'], status='cancelled'); continue
                if settings.get('recipeVersion'):
                    for field in ('upload','mask','finalFrame'):
                        if settings.get(field):
                            await asyncio.to_thread(recipes.checked_source,ROOT/'input'/settings[field])
                ext = settings.get('extension')
                if ext:
                    update(j['id'],current_node='Reading last five frames')
                    src = extension.source_path(DB,ROOT,ext['id'])
                    if ext['id'].startswith('recipe-'):
                        await asyncio.to_thread(recipes.checked_source,src)
                    await asyncio.to_thread(extension.prepare_guide,ROOT,src,ext,j['id'])
                if DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]!='pending':
                    continue
                update(j['id'], status='submitting')
                # Old queued recipes are wrapped only before their first submission.
                # Never replace the sampler of a generation already in progress.
                graph = gpu.resumable_graph(graph, j['id'])
                if gpu.supports_pause(graph):
                    gpu.check_assets(DATA,j['id'],ROOT,graph)
                DB.execute('INSERT OR REPLACE INTO generation_graphs VALUES(?,?)', (j['id'],json.dumps(graph)))
                DB.commit()
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
                can_pause = j['kind']=='video' and gpu.supports_pause(graph)
                wants_pause = can_pause and not stopping and gpu.wants_chat(DATA)
                if can_pause:
                    try:
                        gpu.request_pause(DATA, j['id'], wants_pause)
                    except OSError:
                        logging.warning('Could not request checkpoint; generation continues',exc_info=True)
                history = await comfy('/history/'+j['id'])
                if j['id'] in history:
                    stopping = stopping or DB.execute("SELECT status IN ('cancelling','cancelled') FROM jobs WHERE id=?", (j['id'],)).fetchone()[0]
                    entry = history[j['id']]
                    status = entry.get('status', {})
                    paused = any(event=='execution_error' and data.get('exception_type','').endswith('ComfyBridgeCheckpointPaused')
                                 for event,data in status.get('messages',[]))
                    if not stopping and paused and gpu.checkpoint(DATA,j['id']):
                        try:
                            await resume_checkpoint(j, graph)
                        except (OSError, aiohttp.ClientError, asyncio.TimeoutError):
                            HANDOFF_STAGE[j['id']]='Checkpoint kept · retrying video reload'
                            await asyncio.sleep(5)
                        missing = 0
                        await asyncio.sleep(1)
                        continue
                    if stopping and (settings.get('extension') or not entry.get('outputs')):
                        update(j['id'], status='cancelled')
                    elif status.get('status_str') == 'error':
                        failure=next((data for event,data in reversed(status.get('messages',[]))
                                      if event=='execution_error'),{})
                        message=failure.get('exception_message') or 'ComfyUI reported an error. See the PC log.'
                        node=failure.get('node_type')
                        update(j['id'],status='cancelled' if stopping else 'error',
                               error=((node+': ' if node else '')+message)[:3000])
                    else:
                        await collect(j, entry)
                        DB.executemany('INSERT INTO stage_cost VALUES(?,?,?) ON CONFLICT(kind,node) DO UPDATE SET factor=0.65*stage_cost.factor+0.35*excluded.factor',
                                       ((j['kind'],node,factor) for node,factor in TRACKER.observed.items()))
                        update(j['id'], status='complete', progress=1, current_node='Saved to library')
                    break
                if current=='cancelling':
                    await cancel_ids({j['id']})
                    if DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]=='cancelled':
                        break
                q = await comfy('/queue')
                progress,stage=TRACKER.sample()
                if wants_pause:
                    warning=gpu.read(gpu.folder(DATA,j['id'])/'warning.json')
                    stage=('Checkpoint unavailable · finishing video before chat' if warning else 'Pause requested · finishing current step')
                    HANDOFF_STAGE[j['id']] = stage
                else:
                    HANDOFF_STAGE.pop(j['id'],None)
                update(j['id'],progress=progress,current_node=stage)
                known = any(x[1] == j['id'] for x in q['queue_running']+q['queue_pending'])
                missing = 0 if known else missing+1
                if missing >= 3:
                    # A retiring ComfyUI instance can lose history just after SaveVideo closes the MP4.
                    # Recover only a unique output of this job; join verifies its frame count and decodes it.
                    outputs = []
                    saved_checkpoint=can_pause and gpu.checkpoint(DATA,j['id'])
                    if not stopping:
                        folder = ROOT/'output/ComfyBridge'
                        suffix='mp4' if j['kind']=='video' else 'png'
                        outputs = [p for p in folder.glob(j['id']+'_*.'+suffix)
                                   if re.fullmatch(re.escape(j['id'])+r'_\d+_\.'+suffix,p.name)]
                    if len(outputs)==1:
                        try:
                            if j['kind']=='video' and not settings.get('extension'):
                                await asyncio.to_thread(verify_checkpoint_output,outputs[0],settings)
                            elif j['kind']=='image':
                                with Image.open(outputs[0]) as img:img.verify()
                        except (ValueError,OSError):
                            # Keep the interrupted file for inspection, outside the
                            # final-output pattern, and restart from the saved inputs.
                            outputs[0].rename(outputs[0].with_name(outputs[0].name+'.interrupted-'+uuid.uuid4().hex))
                            outputs=[]
                    if len(outputs)==1:
                        item=dict(type='output',subfolder='ComfyBridge',filename=outputs[0].name)
                        await collect(j,{'outputs':{'16':{'images':[item]}}})
                        update(j['id'],status='complete',progress=1,current_node='Saved to library')
                    elif not outputs and not stopping and saved_checkpoint:
                        await resume_checkpoint(j,graph)
                        missing=0
                        continue
                    elif not outputs and not stopping:
                        # Queue admission is durable. A reboot loses ComfyUI's
                        # volatile queue/history, never the original job/recipe.
                        update(j['id'],status='pending',progress=0,error='',
                               current_node='Recovered after interruption · restarting saved job')
                    else:
                        update(j['id'], status='cancelled' if stopping else 'error',
                               error='' if stopping else 'Multiple saved outputs need review before this job can restart.')
                    break
                await asyncio.sleep(2)
        except InterruptedError:
            update(j['id'],status='cancelled')
        except (ValueError, OSError, sqlite3.Error, aiohttp.ClientError, asyncio.TimeoutError) as e:
            logging.exception('Job %s failed', j['id'])
            # A transport failure after submission is ambiguous: reconcile before changing state.
            status=rows('SELECT status FROM jobs WHERE id=?', (j['id'],))[0]['status']
            if status in ('complete','cancelled','error'):
                pass
            elif status in ('submitting','running','cancelling') and isinstance(e, (aiohttp.ClientError, asyncio.TimeoutError)):
                await asyncio.sleep(5)
            else:
                update(j['id'], status='error', error=str(e)[:5000])
        finally:
            final_status=DB.execute('SELECT status FROM jobs WHERE id=?',(j['id'],)).fetchone()[0]
            if final_status in ('complete','cancelled'):
                gpu.cleanup(DATA,j['id'])
            if final_status in ('complete','cancelled','error'):
                HANDOFF_STAGE.pop(j['id'],None)
                CANCEL_STARTED.pop(j['id'],None)
            if json.loads(j['settings']).get('extension') and (final_status in ('complete','cancelled') or final_status=='error' and not gpu.checkpoint(DATA,j['id'])):
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
        if gpu.wants_chat(DATA):
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
    async with COMFY_START_LOCK:
        await _cancel_ids(ids)


async def _cancel_ids(ids):
    global OWNED
    if not ids:return
    try:
        q=await comfy('/queue')
    except aiohttp.ClientConnectorError:
        if all(gpu.checkpoint(DATA,id) for id in ids):
            for id in ids:
                update(id,status='cancelled',current_node='Cancelled while paused')
                gpu.cleanup(DATA,id)
            return
        raise
    queued=[j[1] for j in q['queue_pending'] if j[1] in ids]
    present={j[1] for j in q['queue_running']+q['queue_pending']}
    for id in ids-present:
        if gpu.checkpoint(DATA,id):
            update(id,status='cancelled',current_node='Cancelled while paused')
            gpu.cleanup(DATA,id)
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
                CANCEL_STARTED.setdefault(j[1],time.monotonic())
                await comfy('/interrupt',{'prompt_id':j[1]})
    elapsed=min((time.monotonic()-CANCEL_STARTED.get(j[1],time.monotonic()) for j in q['queue_running']),default=0)
    if can_recover(OWNED is not None and OWNED.poll() is None,elapsed,q,ids):
        logging.warning('Cancellation exceeded 120 seconds; recycling owned ComfyUI for jobs %s',sorted(ids))
        try:
            result=await asyncio.to_thread(subprocess.run,['taskkill','/PID',str(OWNED.pid),'/T','/F'],
                                          creationflags=subprocess.CREATE_NO_WINDOW,capture_output=True,timeout=20)
        except subprocess.TimeoutExpired:
            logging.warning('Timed out stopping owned ComfyUI; cancellation will retry.')
            return
        if result.returncode==0:
            OWNED=None
            for id in ids:
                if id in CANCEL_STARTED:
                    update(id,status='cancelled',current_node='Cancelled; unresponsive ComfyUI stopped safely')
                    CANCEL_STARTED.pop(id,None)


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
        return web.json_response(dict(await catalogue(),listings=MODELS.snapshot()['items']))
    if path == 'model-library':
        return web.json_response(MODELS.snapshot())
    if path.startswith('model-gallery/'):
        identity=path.split('/',1)[1]
        return web.json_response(await asyncio.to_thread(MODEL_GALLERY.page,identity,request.query.get('cursor','')))
    if path.startswith('model-gallery-detail/'):
        try:
            _,identity,image=path.split('/')
            return web.json_response(await asyncio.to_thread(MODEL_GALLERY.details,identity,image))
        except (ValueError,FileNotFoundError):raise web.HTTPNotFound()
    if path.startswith('model-preview/gallery/'):
        try:
            _,_,identity,image,size=path.split('/')
            file=await asyncio.to_thread(MODEL_GALLERY.preview,identity,image,size)
            return web.FileResponse(file,headers={'Cache-Control':'private, max-age=3600'})
        except (ValueError,FileNotFoundError):raise web.HTTPNotFound()
    if path.startswith('model-preview/'):
        try:
            _,identity,index=path.split('/')
            return web.FileResponse(MODELS.preview(identity,index),headers={'Cache-Control':'private, max-age=86400'})
        except (ValueError,FileNotFoundError):raise web.HTTPNotFound()
    if path.startswith('resume-checkpoint/') and request.method=='POST':
        id=str(uuid.UUID(path.split('/',1)[1]))
        job=rows('SELECT * FROM jobs WHERE id=?',(id,))
        if not job or device=='legacy':
            raise web.HTTPForbidden()
        if job[0]['status']!='error' or not gpu.checkpoint(DATA,id):
            raise ValueError('No interrupted video checkpoint to resume.')
        graph=recipes.recorded_graph(DB,id)
        if not graph or not gpu.supports_pause(graph):
            raise ValueError('The checkpoint workflow is unavailable.')
        gpu.check_assets(DATA,id,ROOT,graph)
        try:
            q=await comfy('/queue')
            if any(x[1]==id for x in q['queue_running']+q['queue_pending']):
                raise ValueError('This generation is already in ComfyUI.')
            history=await comfy('/history/'+id)
            if history.get(id,{}).get('status',{}).get('status_str')=='success':
                raise ValueError('This generation has already finished; refresh the library.')
            await comfy('/history',dict(delete=[id]))
        except aiohttp.ClientConnectorError:
            pass
        # Re-enter reconciliation rather than submitting blindly; it checks for
        # an existing live job/output first. The original seed and job ID stay fixed.
        with DB:
            DB.execute("UPDATE jobs SET status='running',error='',current_node='Resuming saved checkpoint' WHERE id=?",(id,))
            DB.execute('UPDATE job_times SET ended=NULL WHERE job=?',(id,))
        return web.json_response(dict(ok=True))
    if path in ('monitor','status') or path.startswith('batch/'):
        fields='id,batch,owner,kind,status,progress,current_node,error,ordinal,total,created'
        if path=='monitor':jobs=rows(f"SELECT {fields} FROM jobs WHERE {LIVE_JOBS} ORDER BY rowid")
        elif path=='status':
            jobs=rows(f"SELECT {fields} FROM jobs WHERE {LIVE_JOBS} OR rowid IN "
                      "(SELECT rowid FROM jobs ORDER BY rowid DESC LIMIT 100) ORDER BY rowid DESC")
        else:jobs=rows(f'SELECT {fields} FROM jobs WHERE batch=? AND owner=? ORDER BY ordinal',(str(uuid.UUID(path[6:])),device))
        counts = positions(DB) if jobs else {}
        estimates,total_eta=ETA.snapshot(DB,ACTIVE,TRACKER)
        if HANDOFF_STAGE:
            total_eta=None
        for j in jobs:
            j['etaSeconds']=estimates.get(j['id'])
            if j['id'] in counts:
                j['queuePosition'], j['queueTotal'] = counts[j['id']]
            if j['id']==ACTIVE and TRACKER and j['status'] not in ('complete','cancelled','error'):
                if j['id'] in HANDOFF_STAGE:
                    j['current_node']=HANDOFF_STAGE[j['id']]
                    j['etaSeconds']=None
                else:
                    j['progress'],j['current_node']=TRACKER.sample()
        return web.json_response(dict(protocol=19,build='0.1.0-beta.62',jobs=jobs, active=ACTIVE, preview=bool(PREVIEW), previewRevision=PREVIEW_REV,ownedComfy=bool(OWNED),queueEtaSeconds=total_eta))
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
        return web.json_response(with_ratings(items,DATA))
    if path.startswith('extension/'):
        media_id = path.split('/',1)[1]
        source = extension.source_path(DB,ROOT,media_id)
        return web.json_response(await asyncio.to_thread(extension.describe,source,media_id))
    if path == 'media-index':
        items = rows('SELECT id,job,kind,duration,created,archived,path FROM media ORDER BY created DESC,id DESC')
        return web.json_response(await asyncio.to_thread(media_manifest, items, ROOT, DATA))
    if path.startswith('media/') or path.startswith('thumb/'):
        parts = path.split('/')
        if parts[0]=='thumb' and re.fullmatch(r'(upload|recipe)-[0-9a-f]{64}',parts[1]):
            return web.FileResponse(extension.source_path(DB,ROOT,parts[1]).with_suffix('.jpg'))
        item = rows('SELECT * FROM media WHERE id=?', (parts[1],))
        if not item:
            raise web.HTTPNotFound()
        return web.FileResponse(item[0]['path' if parts[0] == 'media' else 'thumbnail'])
    if path == 'archive' and request.method == 'POST':
        d = await request.json()
        DB.execute('UPDATE media SET archived=? WHERE id=?', (int(bool(d['archived'])), d['id'])); DB.commit()
        return web.json_response({'ok': True})
    if path == 'upload-video' and request.method == 'POST':
        size=request.content_length
        if not size or not 0<size<=MAX_VIDEO_UPLOAD:
            raise ValueError('Choose a video up to 512 MiB.')
        folder=ROOT/'input/ComfyBridge/videos';folder.mkdir(parents=True,exist_ok=True)
        raw=folder/(uuid.uuid4().hex+'.part')
        digest=hashlib.sha256();received=0
        try:
            with raw.open('xb') as out:
                async for chunk in request.content.iter_chunked(256*1024):
                    received+=len(chunk)
                    if received>size:raise ValueError('Invalid video size.')
                    out.write(chunk);digest.update(chunk)
            if received!=size:raise ValueError('Video transfer incomplete.')
            async with IMPORT_LOCK:
                source=await asyncio.to_thread(extension.import_clip,raw,folder,digest.hexdigest())
            return web.json_response(source)
        finally:
            raw.unlink(missing_ok=True)
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
        checked_upload(s.get('upload')); checked_upload(s.get('mask')); checked_upload(s.get('finalFrame'))
        if s.get('finalFrame') and kind!='video':raise ValueError('Final frame is only available for video.')
        await asyncio.to_thread(recipes.keep_images,ROOT,s)
        if s.get('extension'):
            if kind!='video' or s.get('upload') or s.get('mask'):
                raise ValueError('An extension needs one source video.')
            requested=s['extension'];source=extension.source_path(DB,ROOT,requested['id'])
            info=await asyncio.to_thread(extension.describe,source,requested['id'])
            if info['revision']!=requested.get('revision'):
                raise ValueError('Source video changed. Select Extend video again.')
            info=await asyncio.to_thread(recipes.keep_clip,ROOT,source,info)
            s.update(extension=info,width=info['width'],height=info['height'],fps=info['fps'],scale=0)
        cat = await catalogue()
        if s.get('finalFrame') and not cat.get('finalFrameSupported'):
            raise ValueError('The PC H3 nodes do not support a final frame. Update ComfyUI before using this input.')
        existing=rows('SELECT id,owner FROM jobs WHERE batch=? ORDER BY ordinal',(batch,))
        if existing:
            if existing[0]['owner']!=device:raise web.HTTPForbidden()
            return web.json_response(dict(batch=batch,ids=[r['id'] for r in existing]))
        if len(rows("SELECT id FROM jobs WHERE status IN ('pending','running','submitting','cancelling')")) + count > 64:
            raise ValueError('The bridge queue is full (64 jobs).')
        if kind == 'image' and s['model'] not in cat['models']:
            raise ValueError('The selected checkpoint is not available.')
        locked=None
        if kind=='video':
            s.setdefault('sound', not s.get('replayOf'))
            if not isinstance(s['sound'], bool): raise ValueError('Video sound must be on or off.')
            if s['sound']:
                if cat.get('audioMissing'):
                    raise ValueError('Video sound needs '+', '.join(cat['audioMissing'])+' on the PC. Install it or turn off Include sound.')
                extension.ffmpeg_path()
        if kind=='video' and cat.get('videoModels'):
            profile=next((p for p in cat['videoModels'] if p['model']==s.get('model')),None)
            if not profile:raise ValueError('Choose a supported H3 video model.')
            if profile['missing']:raise ValueError('Missing on PC: '+', '.join(profile['missing']))
        if kind=='video' and s.get('model')==EROS_BETA7:
            required=WF.widgets('video',8)[0]
            s['loras']=[l for l in s.get('loras',[]) if l['name']!=required]
        elif kind == 'video' and s.get('loras'):
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
        graphs = []
        s['recipeVersion']=1
        for i in range(count):
            settings = dict(s); settings['seed'] = str((int(s['seed'])+(i if s.get('increment') else 0)) % (2**64))
            id = str(uuid.uuid4())
            graph=recipes.graph_for_replay(DB,kind,settings,id) or WF.build(kind, settings, 'ComfyBridge/'+id, recorded_video_strength=locked)
            graphs.append((id,json.dumps(graph)))
            prepared.append((id,batch,kind,json.dumps(settings),'pending',created,i+1,count,device)); ids.append(id)
        with DB:
            DB.executemany('INSERT INTO generation_graphs VALUES(?,?)',graphs)
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
    if path == 'stop-all' and request.method == 'POST':
        if device=='legacy':
            raise web.HTTPForbidden()
        # Capture this queue before awaiting ComfyUI. Later submissions form a new queue.
        targets=rows(f"SELECT id,batch,status FROM jobs WHERE {LIVE_JOBS}")
        STOPPING.update(j['batch'] for j in targets)
        with DB:
            DB.execute("UPDATE jobs SET status='cancelled' WHERE status='pending'")
            DB.execute("UPDATE jobs SET status='cancelling' WHERE status IN ('running','submitting')")
        await cancel_ids({j['id'] for j in targets})
        return web.json_response({'ok':True,'cancelled':len(targets)})
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
    app['tasks'] = [asyncio.create_task(f()) for f in (run_jobs, websocket, idle_watch, model_watch)]


async def model_watch():
    while True:
        try:await asyncio.to_thread(MODELS.scan)
        except Exception:logging.exception('Model catalogue refresh will retry')
        # A saved or cleared Civitai key should refresh previews without waiting out the half hour.
        for _ in range(360):
            await asyncio.sleep(5)
            if MODELS.preview_auth_changed():break


async def cleanup(app):
    for task in app['tasks']:
        task.cancel()
    await SESSION.close()
    MODEL_GALLERY.resources.shutdown(wait=False,cancel_futures=True)


if __name__ == '__main__':
    app = web.Application(middlewares=[guard], client_max_size=55*1024*1024)
    app.router.add_route('*', '/api/{path:.*}', api)
    app.on_startup.append(start); app.on_cleanup.append(cleanup)
    web.run_app(app, host='127.0.0.1', port=18766, print=None, access_log=None)
