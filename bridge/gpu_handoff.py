"""Disk protocol for the bridge's exclusive renderer/chat GPU handoff.

Only the generation worker grants a lease, after Comfy has left its queue.
The chat worker must keep checking it; a dead coordinator cannot leave an
unmanaged LLM using the GPU. Checkpoints themselves live in the Comfy node.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def read(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def folder(data, job):
    return Path(data) / 'checkpoints' / str(uuid.UUID(job))


def chat_state(data):
    path = Path(data) / 'chat.sqlite'
    if not path.exists():
        return {}
    with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='chat_meta'").fetchone():
            return {}
        return dict(db.execute('SELECT * FROM chat_meta WHERE id=1').fetchone() or {})


def wants_chat(data):
    state = chat_state(data)
    if (state.get('active') or state.get('gpu')) and time.time()-state.get('runner_at',0)>45:
        # A crashed chat process cannot hold the generation queue forever. Its
        # Windows job object terminates llama.cpp; verify that before recovery.
        import psutil
        pid=state.get('engine_pid')
        alive=False
        if pid:
            try:
                process=psutil.Process(pid)
                alive=(process.name().lower()=='llama-server.exe' and process.create_time()<=state.get('runner_at',0)+2)
            except psutil.NoSuchProcess:
                pass
            except psutil.Error:
                alive=True  # Cannot verify ownership; do not assume memory is free.
        if not alive:
            with contextlib.closing(sqlite3.connect(Path(data)/'chat.sqlite',timeout=2)) as db,db:
                db.execute('BEGIN IMMEDIATE')
                current=db.execute('SELECT runner_at,active FROM chat_meta WHERE id=1').fetchone()
                if current and current[0]==state.get('runner_at'):
                    if current[1]:
                        db.execute("UPDATE chat_messages SET status='error' WHERE id=?",(current[1],))
                    db.execute("UPDATE chat_meta SET active=NULL,gpu=0,engine_pid=0,status='error',detail='Chat stopped unexpectedly. Your video can resume; send again to retry.',revision=revision+1 WHERE id=1")
                    return False
    return bool(state.get('active') or state.get('gpu') or state.get('engine_pid'))


def grant(data, reply):
    atomic_json(Path(data)/'gpu-handoff.json', dict(reply=reply, ready=True, updated=time.time()))


def granted(data, reply):
    lease = read(Path(data)/'gpu-handoff.json')
    return bool(reply and lease.get('reply') == reply and lease.get('ready')
                and 0 <= time.time()-lease.get('updated', 0) < 15)


def revoke(data):
    (Path(data)/'gpu-handoff.json').unlink(missing_ok=True)


def request_pause(data, job, wanted):
    path = folder(data, job)/'request.json'
    if wanted:
        atomic_json(path, dict(updated=time.time()))
    else:
        path.unlink(missing_ok=True)


def checkpoint(data, job):
    root = folder(data, job)
    info = read(root/'paused.json')
    return info if info and (root/'state.pt').is_file() else {}


def cleanup(data, job):
    # Never recurse over computed paths or delete other jobs' state.
    root = folder(data, job)
    for name in ('state.pt', 'state.tmp', 'paused.json', 'paused.tmp', 'request.json', 'request.tmp', 'warning.json', 'assets.json', 'assets.tmp'):
        (root/name).unlink(missing_ok=True)
    if root.exists() and not any(root.iterdir()):
        root.rmdir()


def resumable_graph(graph, job):
    """Wrap only the known Euler H3 sampler; all original graph inputs stay intact."""
    graph = json.loads(json.dumps(graph))
    if not any(n['class_type'] == 'MiniMaxH3ImageToVideo' for n in graph.values()):
        return graph
    for node in graph.values():
        if node['class_type'] == 'ComfyBridgeCheckpointEuler':
            node['inputs']['job_id'] = str(uuid.UUID(job))
            return graph
    signature = hashlib.sha256(json.dumps(graph, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    for node in graph.values():
        if node['class_type'] == 'KSamplerSelect' and node['inputs'].get('sampler_name') == 'euler':
            node.update(class_type='ComfyBridgeCheckpointEuler', inputs=dict(job_id=str(uuid.UUID(job)), signature=signature))
    return graph


def supports_pause(graph):
    return any(n['class_type'] == 'ComfyBridgeCheckpointEuler' for n in graph.values())


def check_assets(data, job, root, graph):
    """Bind checkpoints to actual model/source files without rereading 20 GB weights."""
    kinds = {'unet_name':'diffusion_models', 'clip_name':'text_encoders', 'vae_name':'vae',
             'lora_name':'loras', 'ckpt_name':'checkpoints'}
    assets = {}
    for node in graph.values():
        for key,value in node['inputs'].items():
            if not isinstance(value,str):
                continue
            if key in kinds:
                path = root/'models'/kinds[key]/value
                if not path.exists() and key=='clip_name':
                    path = root/'models/clip'/value
                if not path.exists() and key=='unet_name':
                    path = root/'models/unet'/value
            elif key=='image' and node['class_type']=='LoadImage':
                path = root/'input'/value
            else:
                continue
            stat = path.stat()
            assets[str(path.resolve())] = [stat.st_size, stat.st_mtime_ns]
    target = folder(data,job)/'assets.json'
    if target.exists():
        if read(target) != assets:
            raise ValueError('A model or source file changed after this video started. Checkpoint kept; restore the original file before resuming.')
    else:
        atomic_json(target, assets)
