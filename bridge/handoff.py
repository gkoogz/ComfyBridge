"""Transfer an idle bridge worker's Comfy launcher without stopping the GPU process."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import sys
import psutil

PORT = 18766


def launcher(proc, root):
    args = proc.cmdline()
    return (Path(proc.exe()).resolve() == (root/'zluda/zluda.exe').resolve()
            and any(Path(a).name.lower() == 'main.py' for a in args)
            and '--port' in args and args[args.index('--port')+1] == '8188')


class Adopted:
    def __init__(self, process):
        self.process, self.pid = process, process.pid

    def poll(self):
        return None if self.process.is_running() else 0


def adopt(data, root):
    marker = data/'launcher-handoff.json'
    try:
        claim = json.loads(marker.read_text())
        proc = psutil.Process(claim['pid'])
        if proc.create_time() == claim['born'] and launcher(proc, root):
            return Adopted(proc)
    except (OSError, ValueError, KeyError, IndexError, psutil.Error):
        pass
    return None


def retire(home, data, root):
    sockets = psutil.net_connections('tcp')
    listeners = [c for c in sockets if c.status=='LISTEN' and c.laddr==('127.0.0.1',PORT)]
    if len(listeners)!=1:return False
    proc = psutil.Process(listeners[0].pid)
    args = proc.cmdline()
    if proc.name().lower() != 'python.exe' or len(args)!=2 or Path(args[1]).resolve()!=(home/'worker.py').resolve():
        return False
    # The tray holds its admission gate. Also protect requests from an earlier tray.
    if any(c.pid==proc.pid and c.laddr[1]==PORT and c.status=='ESTABLISHED' for c in sockets):
        return False
    with closing(sqlite3.connect((data/'library.sqlite').as_uri()+'?mode=rw',uri=True,timeout=1)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute("SELECT 1 FROM jobs WHERE status IN ('running','submitting','pending','cancelling') LIMIT 1").fetchone():
            return False
        children = [p for p in proc.children() if launcher(p,root)]
        if len(children)>1:return False
        if children:
            child=children[0]
            tmp=data/'launcher-handoff.tmp'
            tmp.write_text(json.dumps(dict(pid=child.pid,born=child.create_time())))
            tmp.replace(data/'launcher-handoff.json')
        # psutil verifies PID identity. Terminate this bridge worker only, never its tree.
        proc.terminate()
        proc.wait(timeout=4)
    return True


if __name__=='__main__':
    home=Path(__file__).resolve().parent
    data=Path(os.environ['LOCALAPPDATA'])/'ComfyBridge'
    root=Path(json.loads((home/'config.json').read_text(encoding='utf-8-sig'))['comfyRoot'])
    try:
        sys.exit(0 if retire(home,data,root) else 1)
    except (psutil.Error, OSError, ValueError, IndexError, sqlite3.Error):
        sys.exit(1)
