"""Phone workspace storage. The tray opens this helper on demand without starting ComfyUI."""
from media_index import read_ratings
import base64
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid
import urllib.request
import recipes
import provenance
import chat
from queue_eta import QueueEta


def stop_all_batches(db,token):
    batches=db.execute(f"SELECT DISTINCT batch,owner FROM jobs WHERE status IN {LIVE}").fetchall()
    for batch,owner in batches:
        request=urllib.request.Request('http://127.0.0.1:18766/api/stop',
            data=json.dumps({'batch':batch}).encode('utf-8'),
            headers={'Authorization':'Bearer '+token,'X-Bridge-Device':owner,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=15) as response:
            json.load(response)
    return dict(ok=True,batches=len(batches))

NOW_SQL = "(julianday('now')-2440587.5)*86400"
LIVE = "('pending','running','submitting','cancelling')"


def mark_skipping(db, job, device, active):
    target=db.execute("SELECT owner,status FROM jobs WHERE id=?",(job,)).fetchone()
    if not target or target['owner']!=device or device=='legacy':
        raise PermissionError('This generation belongs to another phone.')
    if target['status']=='cancelled':
        return False
    with db:
        if job==active and db.execute("""UPDATE jobs SET status='cancelling'
            WHERE id=? AND owner=? AND status IN ('running','cancelling')""",(job,device)).rowcount:
            return True
    raise ValueError('That generation is no longer running.')


def prepare(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS workspace(section TEXT PRIMARY KEY, stamp INTEGER, device TEXT, payload TEXT);
        CREATE TABLE IF NOT EXISTS note_receipts(device TEXT PRIMARY KEY, edit TEXT, revision INTEGER);
        CREATE TABLE IF NOT EXISTS job_times(job TEXT PRIMARY KEY, started REAL, ended REAL, observed INTEGER DEFAULT 0);
    """)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='jobs'").fetchone():
        return
    db.executescript(f"""
        CREATE INDEX IF NOT EXISTS media_history_job ON media(job);
        CREATE TRIGGER IF NOT EXISTS start_job_clock AFTER UPDATE OF status ON jobs
        WHEN NEW.status IN ('submitting','running') AND OLD.status!=NEW.status BEGIN
          INSERT INTO job_times(job,started) VALUES(NEW.id,{NOW_SQL})
          ON CONFLICT(job) DO UPDATE SET started=COALESCE(started,excluded.started);
        END;
        CREATE TRIGGER IF NOT EXISTS stop_job_clock AFTER UPDATE OF status ON jobs
        WHEN NEW.status IN ('complete','error','cancelled') AND OLD.status!=NEW.status BEGIN
          INSERT INTO job_times(job,started,ended) VALUES(NEW.id,
            CASE WHEN OLD.status='pending' THEN {NOW_SQL} END,{NOW_SQL})
          ON CONFLICT(job) DO UPDATE SET ended=COALESCE(ended,excluded.ended);
        END;
    """)
    with db:
        db.execute("INSERT OR IGNORE INTO job_times(job,started,observed) SELECT id,?,1 FROM jobs WHERE status IN ('running','submitting','cancelling')",(time.time(),))


def recover_times(db, comfy):
    # Comfy history has execution timestamps even for jobs from older bridge versions.
    try:
        with urllib.request.urlopen(comfy+'/history?max_items=256',timeout=2) as response:
            history=json.load(response)
    except (OSError,ValueError):
        return
    with db:
        for job,entry in history.items():
            messages=entry.get('status',{}).get('messages',[])
            times={event:body.get('timestamp',0)/1000 for event,body in messages if isinstance(body,dict)}
            start=times.get('execution_start')
            end=max((times.get(key,0) for key in ('execution_success','execution_error','execution_interrupted')),default=0)
            if start and end>=start and end>time.time()-86400:
                db.execute("""INSERT INTO job_times(job,started,ended) SELECT id,?,? FROM jobs WHERE id=?
                    ON CONFLICT(job) DO UPDATE SET started=excluded.started,ended=excluded.ended,observed=0
                    WHERE job_times.observed OR job_times.started IS NULL""",(start,end,job))

def recover_log_estimates(db, root):
    # Older ComfyUI sessions may have rotated out of /history. Use an estimate
    # only when a log completion uniquely matches both the output's write time
    # and the bridge's indexing time. Never use an edited file's current age.
    recent=time.time()-86400
    records=set()
    pattern=re.compile(r'\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[.,]\d+)\][^\n]{0,16}Prompt executed in ([\d.]+) seconds')
    for path in (root/'user').glob('comfyui*.log'):
        if path.stat().st_mtime<recent:
            continue
        try:
            with path.open(encoding='utf-8',errors='replace') as lines:
                for line in lines:
                    match=pattern.search(line)
                    if match:
                        end=datetime.fromisoformat(match[1].replace(',','.')).timestamp()
                        if end>=recent:
                            records.add((end,float(match[2])))
        except OSError:
            continue
    candidates={}
    for job,created,indexed,filename in db.execute("""
            SELECT j.id,j.created,m.created,m.path FROM media m JOIN jobs j ON j.id=m.job
            LEFT JOIN job_times t ON t.job=j.id
            WHERE m.created>=? AND j.status='complete' AND (t.started IS NULL OR t.observed=1)""",(recent,)):
        try:
            written=Path(filename).stat().st_mtime
        except OSError:
            continue
        hits=[r for r in records if abs(r[0]-written)<1 and abs(r[0]-indexed)<5 and r[0]-r[1]>=created-1]
        if len(hits)==1:
            candidates.setdefault(hits[0],[]).append(job)
    with db:
        for (end,duration),jobs in candidates.items():
            if len(jobs)==1:
                db.execute("INSERT OR REPLACE INTO job_times VALUES(?,?,?,2)",(jobs[0],end-duration,end))


def history_rows(db):
    now=time.time()
    result=db.execute(f"""
        SELECT j.id,j.batch,j.kind,j.owner,j.status,j.created,t.started,
          COALESCE(t.ended,m.created) AS ended,t.observed,m.id AS media
        FROM jobs j LEFT JOIN job_times t ON t.job=j.id
        LEFT JOIN media m ON m.rowid=(SELECT MIN(rowid) FROM media WHERE job=j.id)
        WHERE j.status IN {LIVE} OR COALESCE(t.ended,m.created,j.created)>=?
        ORDER BY CASE WHEN j.status IN ('running','submitting','cancelling') THEN 0
                      WHEN j.status='pending' THEN 1 ELSE 2 END,
                 CASE WHEN j.status IN {LIVE} THEN j.rowid END,
                 COALESCE(t.ended,m.created,j.created) DESC""",(now-86400,))
    return dict(now=now,jobs=[dict(row) for row in result])


def replay(db, root, job):
    row=db.execute("SELECT kind,settings FROM jobs WHERE id=?",(str(uuid.UUID(job)),)).fetchone()
    if row is None:
        raise ValueError('Generation no longer exists.')
    settings=json.loads(row['settings'])
    if not settings.get('recipeVersion') and db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_sources'").fetchone():
        saved=db.execute('SELECT sources FROM legacy_sources WHERE job=?',(job,)).fetchone()
        if saved:
            settings.update(json.loads(saved[0]))
    settings['replayOf']=job
    if settings.get('extension'):
        import extension
        clip=settings['extension']
        source=extension.source_path(db,root,clip['id'])
        if clip['id'].startswith('recipe-'):
            recipes.checked_source(source)
            clip['revision']=extension.revision(source)
        elif not source.is_file() or extension.revision(source)!=clip.get('revision'):
            raise ValueError('The original source video is missing or changed on the PC.')
    inputs={}
    for field,key in [('upload','data'),('mask','mask')]:
        if not settings.get(field):
            continue
        filename=(root/'input'/settings[field]).resolve()
        if not filename.is_relative_to((root/'input/ComfyBridge').resolve()) or not filename.is_file():
            raise ValueError('The original '+field+' is missing on the PC.')
        if filename.parent==(root/'input/ComfyBridge/recipes').resolve():
            recipes.checked_source(filename)
        inputs[key]='data:image/png;base64,'+base64.b64encode(filename.read_bytes()).decode('ascii')
    return dict(kind=row['kind'],settings=settings,inputs=inputs)


def settings_sync(db, updates, device):
    with db:
        # Seed older installations from their last changed PC backup before
        # accepting the first phone's (possibly older) local defaults.
        if (not db.execute("SELECT 1 FROM workspace WHERE section!='notepad'").fetchone()
                and db.execute("SELECT 1 FROM sqlite_master WHERE name='profiles'").fetchone()):
            previous=db.execute("SELECT * FROM profiles ORDER BY modified DESC LIMIT 1").fetchone()
            if previous:
                profile=json.loads(previous['state'])
                seeds={'prompts':profile.get('prompts',[])}
                for kind in ('image','video'):
                    if profile.get('settings',{}).get(kind):
                        seeds[kind]=dict(settings=profile['settings'][kind],inputs=profile.get('inputs',{}).get(kind,{}),
                                         presets=profile.get('presets',{}).get(kind,[]))
                db.executemany("INSERT OR IGNORE INTO workspace VALUES(?,?,?,?)",
                    ((k,int(previous['modified']*1000),previous['device'],json.dumps(v)) for k,v in seeds.items()))
        for key,change in updates.items():
            if key not in ('image','video','prompts'):
                raise ValueError('Unknown settings section.')
            db.execute("""INSERT INTO workspace VALUES(?,?,?,?) ON CONFLICT(section) DO UPDATE SET
                stamp=excluded.stamp,device=excluded.device,payload=excluded.payload
                WHERE (excluded.stamp,excluded.device)>(workspace.stamp,workspace.device)""",
                (key,int(change['stamp']),device,json.dumps(change['value'])))
    return {row['section']:dict(stamp=row['stamp'],device=row['device'],value=json.loads(row['payload']))
            for row in db.execute("SELECT * FROM workspace WHERE section!='notepad'")}


def notes_sync(db, change, device):
    row=db.execute("SELECT stamp,payload FROM workspace WHERE section='notepad'").fetchone()
    rev,doc=(row['stamp'],json.loads(row['payload'])) if row else (0,None)
    if not change:
        return dict(rev=rev,doc=doc)
    receipt=db.execute("SELECT edit FROM note_receipts WHERE device=?",(device,)).fetchone()
    if receipt and receipt[0]==change['edit']:
        return dict(rev=rev,doc=doc)
    incoming=change['doc']
    if not isinstance(incoming['text'],str) or not isinstance(incoming['marks'],list):
        raise ValueError('Invalid notepad.')
    conflict=doc is not None and doc!=incoming and rev!=change['base']
    if conflict:
        # Preserve both offline drafts. Offset the incoming sticky rows by the
        # actual extent of the first draft, including empty colored lines.
        rows=max(len(doc['text'].split('\n')),max((m['end']+1 for m in doc['marks']),default=1))
        prefix=doc['text']+'\n'*(rows-len(doc['text'].split('\n'))+2)
        offset=prefix.count('\n')
        incoming=dict(text=prefix+incoming['text'],next=incoming['next'],
                      marks=doc['marks']+[dict(m,start=m['start']+offset,end=m['end']+offset) for m in incoming['marks']])
    with db:
        rev+=1
        db.execute("INSERT OR REPLACE INTO workspace VALUES('notepad',?,?,?)",(rev,device,json.dumps(incoming)))
        db.execute("INSERT OR REPLACE INTO note_receipts VALUES(?,?,?)",(device,change['edit'],rev))
    return dict(rev=rev,doc=incoming,conflict=conflict)


def desktop_file(db, root, data, body):
    """Local host only: resolve an indexed result, never a caller-supplied path."""
    media_id=uuid.UUID(body['id']).hex
    row=db.execute('SELECT path,thumbnail FROM media WHERE id=?',(media_id,)).fetchone()
    if row is None:
        raise ValueError('That item is no longer in the PC library.')
    thumbnail=body.get('thumbnail',False)
    path=Path(row[1 if thumbnail else 0]).resolve()
    allowed=(data/'thumbnails' if thumbnail else root/'output/ComfyBridge').resolve()
    if not path.is_relative_to(allowed) or not path.is_file():
        raise ValueError('The file was moved or deleted on the PC.')
    return dict(path=str(path))


def rate_media(db, body):
    value=body.get('rating')
    if type(value) is not int or not 0<=value<=5:
        raise ValueError('Rating must be a number from 1 to 5, or 0 to clear.')
    identity=body.get('id')
    if not db.execute('SELECT 1 FROM media WHERE id=?',(identity,)).fetchone():
        raise ValueError('This item is no longer in the library.')
    with db:
        db.execute('CREATE TABLE IF NOT EXISTS media_ratings(media TEXT PRIMARY KEY,rating INTEGER NOT NULL)')
        db.execute('INSERT INTO media_ratings VALUES(?,?) ON CONFLICT(media) DO UPDATE SET rating=excluded.rating',(identity,value))
    return dict(id=identity,rating=value)


def serve():
    sys.stdin.reconfigure(encoding='utf-8')
    data=Path(os.environ['LOCALAPPDATA'])/'ComfyBridge'
    config=json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))
    db=sqlite3.connect(data/'library.sqlite',timeout=10)
    db.row_factory=sqlite3.Row
    prepare(db)
    recovered=False
    estimates=QueueEta()
    for line in sys.stdin:
        try:
            msg=json.loads(line);route=msg['route'];device=msg['device'];body=msg.get('body') or {}
            if route.startswith('chat/'):
                uuid.UUID(device)
                action=route.split('/',1)[1]
                if action not in ('state','draft','send','reset'):
                    raise ValueError('Unknown chat request.')
                result=chat.request(data,action,body,device,config['comfyUrl'])
            elif route.startswith('desktop-chat-'):
                result=chat.request(data,route[len('desktop-chat-'):],body,device,config['comfyUrl'])
            elif route=='ratings':
                result=read_ratings(data)
            elif route=='rating':
                uuid.UUID(device)
                result=rate_media(db,body)
            elif route=='time':
                result=round(time.time()*1000)
            elif route=='history':
                if not recovered:
                    prepare(db)
                    if db.execute("SELECT 1 FROM sqlite_master WHERE name='jobs'").fetchone():
                        recover_times(db,config['comfyUrl'])
                        recover_log_estimates(db,Path(config['comfyRoot']))
                        recovered=True
                result=history_rows(db) if recovered else dict(now=time.time(),jobs=[])
                import gpu_handoff
                for job in result['jobs']:
                    job['checkpointAvailable']=job['status']=='error' and bool(gpu_handoff.checkpoint(data,job['id']))
                result['supportsRollingSkip']=True
                remaining,total={},0
                if recovered:
                    active=db.execute("SELECT id FROM jobs WHERE status IN ('running','submitting','cancelling') ORDER BY rowid LIMIT 1").fetchone()
                    remaining,total=estimates.snapshot(db,active[0] if active else None,None)
                result.update(eta=remaining,queueEtaSeconds=total,supportsStopAll=True)
            elif route=='stop-all':
                uuid.UUID(device)
                result=stop_all_batches(db,(data/'token.txt').read_text().strip())
            elif route=='rolling-skip':
                # The beta 11 worker already reconciles durable per-job cancellations.
                # Use its active ID so an upgrade never has to restart a live render.
                probe=urllib.request.Request('http://127.0.0.1:18766/api/monitor',headers={
                    'Authorization':'Bearer '+(data/'token.txt').read_text().strip()})
                with urllib.request.urlopen(probe,timeout=4) as response:
                    monitor=json.load(response)
                if monitor.get('protocol',0)<7:
                    raise ValueError('The previous worker cannot skip individual jobs.')
                mark_skipping(db,str(uuid.UUID(body['id'])),device,monitor.get('active'))
                result=dict(ok=True)
            elif route.startswith('clock/'):
                row=db.execute("SELECT started,observed FROM job_times WHERE job=?",(route[6:],)).fetchone()
                seconds=max(0,int(time.time()-row['started'])) if row and row['started'] else None
                result=dict(seconds=seconds,observed=bool(row and row['observed']))
            elif route.startswith('replay/'):
                result=replay(db,Path(config['comfyRoot']),route[7:])
            elif route.startswith('provenance/'):
                result=provenance.node(db,route.split('/',1)[1])
            elif route.startswith('source-file/'):
                _,job,role=route.split('/')
                source=provenance.source_file(db,Path(config['comfyRoot']),data,job,role)
                print(json.dumps(dict(code=200,file=source)),flush=True)
                continue
            elif route.startswith('extension/'):
                # Let the editor open while an older worker finishes its queue.
                import extension
                media_id=route.split('/',1)[1]
                result=extension.describe(extension.source_path(db,Path(config['comfyRoot']),media_id),media_id)
            elif route=='desktop-file':
                result=desktop_file(db,Path(config['comfyRoot']),data,body)
            elif route=='settings':
                result=settings_sync(db,body,device)
            elif route=='notes':
                result=notes_sync(db,body,device)
            else:
                raise ValueError('Unknown workspace request.')
            out=dict(code=200,data=result)
        except Exception as error:
            out=dict(code=400,data=dict(error=str(error)))
        print(json.dumps(out,separators=(',',':')),flush=True)


if __name__=='__main__':
    if '--init' in sys.argv:
        with sqlite3.connect(Path(os.environ['LOCALAPPDATA'])/'ComfyBridge/library.sqlite') as db:
            prepare(db)
            config=json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))
            saved,missing=recipes.preserve_library(db,Path(config['comfyRoot']))
            print(f'Protected sources for {saved} existing generations; {missing} unavailable.')
    else:
        serve()
