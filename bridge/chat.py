"""One durable shared conversation and an on-demand, loopback-only llama.cpp worker."""
import argparse
import contextlib
import ctypes
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

BUSY = ('queued', 'waiting', 'loading', 'responding')
SYSTEM = ('You are a helpful creative assistant in ComfyBridge. Help discuss ideas and refine '
          'image and video prompts. Be clear, practical and concise. Preserve the user\'s intent; '
          'ask when a key detail is ambiguous. You can discuss prompts but cannot run generations, '
          'change settings or inspect images. Do not claim to have done those things.')


def database(data):
    data.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(data / 'chat.sqlite', timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS chat_meta(id INTEGER PRIMARY KEY CHECK(id=1), conversation TEXT,
        draft TEXT DEFAULT '', draft_revision INTEGER DEFAULT 0, draft_edit TEXT DEFAULT '',
        draft_device TEXT DEFAULT '', active TEXT, status TEXT DEFAULT 'idle', detail TEXT DEFAULT '',
        revision INTEGER DEFAULT 0, gpu_after REAL DEFAULT 0, runner_at REAL DEFAULT 0,
        gpu INTEGER DEFAULT 0, engine_pid INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, role TEXT, content TEXT,
        created REAL, source TEXT, model TEXT, status TEXT);
    ''')
    db.execute('INSERT OR IGNORE INTO chat_meta(id,conversation) VALUES(1,?)', (str(uuid.uuid4()),))
    db.commit()
    return db


def meta(db):
    return dict(db.execute('SELECT * FROM chat_meta WHERE id=1').fetchone())


def snapshot(db, after=None):
    row = meta(db)
    result = {k: row[k] for k in ('conversation', 'draft', 'draft_revision', 'draft_device', 'active', 'status', 'detail', 'revision')}
    result['busy'] = row['status'] in BUSY
    if after == row['revision']:
        return dict(unchanged=True, busy=result['busy'], revision=row['revision'])
    result['messages'] = [dict(r) for r in db.execute('SELECT * FROM chat_messages ORDER BY created,rowid')]
    return result


def runtime_config(data):
    path = data / 'chat-runtime.json'
    if not path.is_file():
        raise ValueError('Local chat is not installed. Run Setup-Chat.ps1 on the PC.')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def models(data):
    try:
        config = runtime_config(data)
        root = Path(config['modelDir']).resolve()
        entries = [dict(id=p.name, name=p.stem.replace('Qwen_Qwen', 'Qwen').replace('-', ' '), bytes=p.stat().st_size)
                   for p in sorted(root.glob('*.gguf')) if p.is_file() and p.resolve().is_relative_to(root)]
        return dict(selected=config.get('selected'), models=entries, installed=Path(config['executable']).is_file())
    except (OSError, ValueError, KeyError):
        return dict(selected=None, models=[], installed=False)


def selected_model(data):
    config = runtime_config(data)
    root = Path(config['modelDir']).resolve()
    path = (root / config.get('selected', '')).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() != '.gguf' or not path.is_file():
        raise ValueError('Choose an installed chat model in the PC bridge panel.')
    if not Path(config['executable']).is_file():
        raise ValueError('The local chat runtime is missing. Run Setup-Chat.ps1 on the PC.')
    return config, path


def start_runner(data, comfy):
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (data / 'chat-worker.log').open('ab') as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--run', '--data', str(data), '--comfy', comfy],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)


def request(data, route, body, device, comfy, launch=True):
    with contextlib.closing(database(data)) as db:
        if route == 'models':
            return models(data)
        if route == 'state':
            row = meta(db)
            if launch and row['active'] and time.time() - row['runner_at'] > 15:
                with db:
                    claimed=db.execute('UPDATE chat_meta SET runner_at=? WHERE id=1 AND active=? AND runner_at=?', (time.time(), row['active'], row['runner_at'])).rowcount
                if claimed:
                    start_runner(data, comfy)
            return snapshot(db, body.get('after'))
        db.execute('BEGIN IMMEDIATE')
        row = meta(db)
        if route == 'select':
            if row['active']:
                raise ValueError('Wait for the current reply, or start a new chat, before changing models.')
            choices = models(data)
            if body.get('id') not in {x['id'] for x in choices['models']}:
                raise ValueError('Select an installed chat model.')
            config = runtime_config(data)
            config['selected'] = body['id']
            temporary = data / 'chat-runtime.tmp'
            temporary.write_text(json.dumps(config, indent=2), encoding='utf-8')
            temporary.replace(data / 'chat-runtime.json')
            db.commit()
            return models(data)
        if route == 'yield':
            db.execute('UPDATE chat_meta SET gpu_after=? WHERE id=1', (time.time() + 45,))
            db.commit()
            # The renderer must not allocate VRAM until the chat worker has released it.
            deadline = time.monotonic() + 12
            while meta(db)['gpu'] and time.monotonic() < deadline:
                if time.time() - meta(db)['runner_at'] > 15:
                    break
                time.sleep(.08)
            if meta(db)['gpu'] and time.time() - meta(db)['runner_at'] <= 15:
                raise ValueError('Chat is releasing GPU memory. Please try Generate again in a moment.')
            return dict(ok=True)
        if body.get('conversation') != row['conversation']:
            raise ValueError('The chat was restarted on another device. Your draft is kept; refresh the chat and send again.')
        if route == 'draft':
            text = body.get('text', '')
            if not isinstance(text, str) or len(text) > 24000:
                raise ValueError('Keep the chat draft under 24,000 characters.')
            if body.get('edit') == row['draft_edit']:
                db.commit()
                return snapshot(db)
            if body.get('base') != row['draft_revision']:
                db.commit()
                result = snapshot(db)
                result['draftConflict'] = True
                return result
            db.execute('''UPDATE chat_meta SET draft=?,draft_revision=draft_revision+1,draft_edit=?,
                          draft_device=?,revision=revision+1 WHERE id=1''', (text, str(uuid.UUID(body['edit'])), device))
        elif route == 'reset':
            db.execute('DELETE FROM chat_messages')
            db.execute('''UPDATE chat_meta SET conversation=?,draft='',draft_revision=draft_revision+1,
                draft_edit='',draft_device=?,active=NULL,status='idle',detail='',revision=revision+1 WHERE id=1''', (str(uuid.uuid4()), device))
        elif route == 'send':
            message_id = str(uuid.UUID(body['id']))
            if db.execute('SELECT 1 FROM chat_messages WHERE id=?', (message_id,)).fetchone():
                db.commit()
                return snapshot(db)
            if row['active']:
                raise ValueError('A reply is already in progress. Your message stays in the field until it is ready to send.')
            text = body.get('text', '')
            if not isinstance(text, str) or not text.strip() or len(text) > 24000:
                raise ValueError('Enter a message of up to 24,000 characters.')
            config, model = selected_model(data)
            source = body.get('source', '')
            if source not in ('', 'image positive', 'image negative', 'video positive', 'video negative'):
                source = ''
            reply_id = str(uuid.uuid4())
            now = time.time()
            db.execute('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?)', (message_id, 'user', text, now, source, model.name, 'complete'))
            db.execute('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?)', (reply_id, 'assistant', '', now + .0001, '', model.name, 'queued'))
            db.execute("UPDATE chat_meta SET active=?,status='queued',detail='Preparing local chat…',revision=revision+1,runner_at=? WHERE id=1", (reply_id, time.time() if launch else 0))
            if body.get('draft_revision') == row['draft_revision']:
                db.execute("UPDATE chat_meta SET draft='',draft_revision=draft_revision+1,draft_device=? WHERE id=1", (device,))
        else:
            raise ValueError('Unknown chat request.')
        db.commit()
        result = snapshot(db)
        if route == 'send' and launch:
            start_runner(data, comfy)
        return result


def available_ram():
    if os.name != 'nt':
        return 64 * 1024**3
    class Memory(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
                   ('total', 'available', 'pageTotal', 'pageAvailable', 'virtualTotal', 'virtualAvailable', 'extended')]
    memory = Memory()
    memory.length = ctypes.sizeof(memory)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory))
    return memory.available


def json_request(url, payload=None, key=None, timeout=4):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    req = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read()
        return json.loads(body) if body.strip() else {}


def rendering(data, comfy):
    library = data / 'library.sqlite'
    if library.exists():
        with sqlite3.connect(f'file:{library.as_posix()}?mode=ro', uri=True, timeout=2) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='jobs'").fetchone() and db.execute(
                    "SELECT 1 FROM jobs WHERE status IN ('pending','submitting','running','cancelling') LIMIT 1").fetchone():
                return True
    try:
        queue = json_request(comfy + '/queue', timeout=2)
        return bool(queue.get('queue_running') or queue.get('queue_pending'))
    except OSError:
        return False


def context_messages(db, reply_id):
    # Keep all messages in the UI; only the most recent context is sent to the model.
    entries = [dict(r) for r in db.execute("SELECT role,content,source FROM chat_messages WHERE id!=? AND status='complete' ORDER BY created,rowid", (reply_id,))]
    recent, used = [], 0
    for item in reversed(entries):
        size = len(item['content'])
        if recent and used + size > 26000:
            break
        recent.append(dict(role=item['role'], content=item['content']))
        used += size
    recent.reverse()
    while recent and recent[0]['role'] != 'user':
        recent.pop(0)
    source = next((x['source'] for x in reversed(entries) if x['role'] == 'user'), '')
    return [dict(role='system', content=SYSTEM + (' The current discussion started from the ' + source + ' prompt field.' if source else ''))] + recent


class Engine:
    def __init__(self, config, model, gpu, data):
        self.process = None
        self.job = None
        self.gpu = gpu
        self.key = secrets.token_urlsafe(32)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        self.log = (data / 'chat-engine.log').open('wb')
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        args = [config['executable'], '-m', str(model), '--host', '127.0.0.1', '--port', str(port),
                '--api-key', self.key, '--no-webui', '--jinja', '--ctx-size', '12288', '--parallel', '1',
                '--n-gpu-layers', 'auto' if gpu else '0', '--fit-target', '1536', '--threads', '6', '--threads-batch', '6',
                '--batch-size', '512', '--ubatch-size', '128', '--flash-attn', 'on', '--no-warmup',
                '--reasoning-budget', '0', '--no-context-shift', '--prio', '-1', '--poll', '0']
        if not gpu:
            args += ['--device', 'none']
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log, creationflags=flags)
        if os.name == 'nt':
            # The OS releases GPU/RAM even if the Python worker is terminated unexpectedly.
            from ctypes import wintypes
            class Basic(ctypes.Structure):
                _fields_ = [('processTime', ctypes.c_longlong), ('jobTime', ctypes.c_longlong), ('flags', wintypes.DWORD),
                            ('minWs', ctypes.c_size_t), ('maxWs', ctypes.c_size_t), ('active', wintypes.DWORD),
                            ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
            class Limits(ctypes.Structure):
                _fields_ = [('basic', Basic), ('io', ctypes.c_ulonglong * 6), ('processMemory', ctypes.c_size_t),
                            ('jobMemory', ctypes.c_size_t), ('peakProcessMemory', ctypes.c_size_t), ('peakJobMemory', ctypes.c_size_t)]
            kernel = ctypes.windll.kernel32
            kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.job = kernel.CreateJobObjectW(None, None)
            limits = Limits()
            limits.basic.flags = 0x2000
            if not self.job or not kernel.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(self.job, int(self.process._handle)):
                self.close()
                raise OSError('Could not enable safe cleanup for the local chat runtime.')

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.log.close()
        if self.job:
            ctypes.windll.kernel32.CloseHandle(self.job)
            self.job = None


def run(data, comfy):
    import msvcrt
    lock = (data / 'chat-worker.lock').open('a+b')
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        lock.close()
        return
    if os.fstat(lock.fileno()).st_size == 0:
        lock.write(b'0')
        lock.flush()
    db = database(data)
    engine = None
    idle_since = time.monotonic()
    try:
        with db:
            db.execute('UPDATE chat_meta SET gpu=0,engine_pid=0,runner_at=? WHERE id=1', (time.time(),))
        while True:
            row = meta(db)
            with db:
                db.execute('UPDATE chat_meta SET runner_at=? WHERE id=1', (time.time(),))
            reply_id = row['active']
            if not reply_id:
                if engine:
                    engine.close()
                    engine = None
                    with db:
                        db.execute('UPDATE chat_meta SET gpu=0,engine_pid=0 WHERE id=1')
                if time.monotonic() - idle_since > 3:
                    break
                time.sleep(.25)
                continue
            idle_since = time.monotonic()
            cancel = threading.Event()
            reason = []
            def update(status, detail, content=None):
                with db:
                    db.execute('BEGIN IMMEDIATE')
                    if meta(db)['active'] != reply_id:
                        return False
                    db.execute('UPDATE chat_meta SET status=?,detail=?,revision=revision+1,runner_at=? WHERE id=1', (status, detail, time.time()))
                    if content is not None:
                        db.execute('UPDATE chat_messages SET content=?,status=? WHERE id=?', (content, status, reply_id))
                return True
            try:
                config, model = selected_model(data)
                busy = rendering(data, comfy)
                gpu = not busy and row['gpu_after'] < time.time()
                required = model.stat().st_size + 2 * 1024**3 if not gpu else 3 * 1024**3
                if available_ram() < required:
                    if row['status'] != 'waiting':
                        update('waiting', 'Waiting for free memory. Your generation continues normally.')
                    time.sleep(1)
                    continue
                if gpu:
                    # Release cached Comfy models only when both its queue and the bridge queue are idle.
                    try:
                        json_request(comfy + '/free', dict(unload_models=True, free_memory=True))
                    except OSError:
                        pass
                with db:
                    db.execute('BEGIN IMMEDIATE')
                    fresh = meta(db)
                    if fresh['active'] != reply_id:
                        continue
                    if gpu and fresh['gpu_after'] > time.time():
                        continue
                    db.execute('UPDATE chat_meta SET gpu=? WHERE id=1', (int(gpu),))
                update('loading', 'Loading local model on Radeon GPU…' if gpu else 'Loading on CPU while ComfyUI uses the GPU…', '')
                engine = Engine(config, model, gpu, data)
                with db:
                    db.execute('UPDATE chat_meta SET engine_pid=? WHERE id=1', (engine.process.pid,))
                current_engine = engine
                def monitor():
                    with contextlib.closing(database(data)) as watcher:
                        while not cancel.wait(.3):
                            current = meta(watcher)
                            with watcher:
                                watcher.execute('UPDATE chat_meta SET runner_at=? WHERE id=1', (time.time(),))
                            changed = current['active'] != reply_id
                            yield_gpu = gpu and (current['gpu_after'] > time.time() or rendering(data, comfy))
                            low_memory = not gpu and available_ram() < 1024**3
                            if changed or yield_gpu or low_memory:
                                reason.append('reset' if changed else 'yield' if yield_gpu else 'memory')
                                if current_engine.process.poll() is None:
                                    current_engine.process.terminate()
                                return
                watcher = threading.Thread(target=monitor, daemon=True)
                watcher.start()
                deadline = time.monotonic() + 180
                while True:
                    if engine.process.poll() is not None:
                        raise RuntimeError('Local model stopped while loading. Check the PC chat status or choose another model.')
                    try:
                        if json_request(engine.url + '/health', key=engine.key, timeout=1).get('status') == 'ok':
                            break
                    except OSError:
                        pass
                    if time.monotonic() > deadline:
                        raise TimeoutError('The local model took too long to load.')
                    time.sleep(.2)
                update('responding', 'Replying locally · Radeon GPU' if gpu else 'Replying locally · CPU while GPU is busy')
                payload = dict(messages=context_messages(db, reply_id), stream=True, max_tokens=2048,
                               temperature=.7, top_p=.8, top_k=20, repeat_penalty=1.05,
                               chat_template_kwargs=dict(enable_thinking=False))
                req = urllib.request.Request(engine.url + '/v1/chat/completions', data=json.dumps(payload).encode(),
                        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + engine.key})
                text = ''
                last = 0
                finished = False
                with urllib.request.urlopen(req, timeout=180) as stream:
                    for line in stream:
                        if not line.startswith(b'data: '):
                            continue
                        if line.strip() == b'data: [DONE]':
                            finished = True
                            break
                        chunk = json.loads(line[6:])
                        if chunk.get('error'):
                            raise ValueError(str(chunk['error']))
                        choices = chunk.get('choices', [])
                        if not choices:
                            continue
                        text += choices[0].get('delta', {}).get('content') or ''
                        if time.monotonic() - last > .15:
                            if not update('responding', 'Replying locally · ' + ('Radeon GPU' if gpu else 'CPU while GPU is busy'), text):
                                break
                            last = time.monotonic()
                if not finished:
                    raise OSError('The local model response was interrupted. Your draft and conversation are kept.')
                with db:
                    db.execute('BEGIN IMMEDIATE')
                    if meta(db)['active'] == reply_id:
                        db.execute("UPDATE chat_messages SET content=?,status='complete' WHERE id=?", (text, reply_id))
                        db.execute("UPDATE chat_meta SET active=NULL,status='idle',detail='',revision=revision+1 WHERE id=1")
            except Exception as error:
                if reason and reason[0] == 'yield':
                    update('waiting', 'Generation has priority. Moving chat off the GPU…', '')
                elif reason and reason[0] == 'memory':
                    update('waiting', 'Waiting for free memory. Your generation continues normally.', '')
                elif not reason:
                    detail = str(error)
                    if isinstance(error, urllib.error.HTTPError):
                        try:
                            problem = json.loads(error.read(8192)).get('error', {})
                            detail = 'Local model: ' + (problem.get('message', str(problem)) if isinstance(problem, dict) else str(problem))
                        except (ValueError, OSError):
                            detail = f'Local model request failed (HTTP {error.code}).'
                        finally:
                            error.close()
                    with db:
                        db.execute('BEGIN IMMEDIATE')
                        if meta(db)['active'] == reply_id:
                            db.execute("UPDATE chat_messages SET status='error' WHERE id=?", (reply_id,))
                            db.execute("UPDATE chat_meta SET active=NULL,status='error',detail=?,revision=revision+1 WHERE id=1", (detail[:700],))
            finally:
                cancel.set()
                if 'watcher' in locals() and watcher.is_alive():
                    watcher.join(timeout=4)
                if engine:
                    engine.close()
                    engine = None
                with db:
                    db.execute('UPDATE chat_meta SET gpu=0,engine_pid=0 WHERE id=1')
    finally:
        if engine:
            engine.close()
        with db:
            db.execute('UPDATE chat_meta SET gpu=0,engine_pid=0,runner_at=0 WHERE id=1')
        db.close()
        lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--comfy', default='http://127.0.0.1:8188')
    args = parser.parse_args()
    run(args.data, args.comfy)
