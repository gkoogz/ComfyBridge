"""Opt-in, one-week local API diagnostics. No daemon, polling or request payloads."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid

WEEK = 7 * 86400
CONFIG = 'api-debug-session.json'
BANDS = (100, 500, 1000, 3000, 10000, 30000, float('inf'))
ROUTES = frozenset('me image.getInfinite image.getGenerationData image.getResources user.getFollowingUsers user.getCreator tag.getVotableTags collection.getUserCollectionItemsByItem collection.getAllUser user.getBookmarkCollections collection.getEntryCount collection.upsert user.toggleFollow reaction.getMyImageReactions reaction.toggle collection.saveItem tag.addTagVotes'.split())
OPERATIONS = ROUTES | frozenset(('rest.images','rest.models','rest.model-versions','rest.other','feed.mix','feed.tags','feed.tag','feed.creator','feed.collection','feed.reactions','feed.other','detail.open','detail.prefetch','other'))
KINDS = frozenset(('network','cache','budget','feed','detail'))
OUTCOMES = frozenset(('ok','hit','miss','refresh','error','timeout','http_error','protocol_error','deferred','limited','cooldown','total_limit','background_limit'))
HTTP_OUTCOMES = frozenset('http_'+str(n) for n in range(100,600))


def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def session(data):
    try:
        value=json.loads((Path(data)/CONFIG).read_text(encoding='utf-8'))
        started=float(value['started']);expires=float(value['expires'])
        if not math.isfinite(started) or not math.isfinite(expires) or not 0<expires-started<=WEEK:raise ValueError()
        identity=str(uuid.UUID(value['id']))
        return dict(id=identity,started=started,expires=expires)
    except (OSError,ValueError,KeyError,TypeError):return None


def activate(data, now=None):
    """Only the explicit CLI enable command creates a new fixed-duration session."""
    data=Path(data);data.mkdir(parents=True,exist_ok=True)
    now=time.time() if now is None else now
    old=session(data)
    if old and old['started']<=now<old['expires']:return old
    value=dict(id=str(uuid.uuid4()),started=now,expires=now+WEEK)
    temporary=data/(CONFIG+'.tmp');temporary.write_text(json.dumps(value),encoding='utf-8')
    temporary.replace(data/CONFIG)
    return value


class Recorder:
    def __init__(self, data=None, clock=time.time, monotonic=time.monotonic):
        self.clock=clock;self.monotonic=monotonic;self.enabled=False;self.lock=threading.Lock()
        self.dropped=0;self.path=None;self.expires=0;self.deadline=0
        value=session(data) if data is not None else None
        now=clock()
        if not value or not value['started']<=now<value['expires']:return
        self.expires=value['expires'];self.deadline=monotonic()+self.expires-now
        directory=Path(data)/'api-debug';directory.mkdir(exist_ok=True)
        self.path=directory/(value['id']+'.sqlite')
        try:
            with closing(sqlite3.connect(self.path,timeout=0)) as db, db:
                db.execute('PRAGMA max_page_count=4096') # 16 MiB with default 4 KiB pages
                db.executescript('''
                  CREATE TABLE IF NOT EXISTS info(key TEXT PRIMARY KEY,value TEXT);
                  CREATE TABLE IF NOT EXISTS metrics(
                    bucket INTEGER,kind TEXT,operation TEXT,outcome TEXT,background INTEGER,band INTEGER,
                    count INTEGER,total_ms REAL,max_ms REAL,wait_ms REAL,bytes INTEGER,
                    items INTEGER,scanned INTEGER,filtered INTEGER,reads INTEGER,
                    PRIMARY KEY(bucket,kind,operation,outcome,background,band));
                ''')
                db.executemany('INSERT OR REPLACE INTO info VALUES(?,?)',[(k,str(v)) for k,v in value.items()])
            self.enabled=True
        except (OSError,sqlite3.Error):pass

    def begin(self):
        if not self.enabled:return None
        now=self.clock();monotonic=self.monotonic()
        if now>=self.expires or monotonic>=self.deadline:
            self.enabled=False
            return None
        return (monotonic,int(now//60)*60)

    def finish(self, ticket, kind, operation, outcome='ok', *, background=False, wait_ms=0,
               byte_count=0, items=0, scanned=0, filtered=0, reads=0):
        if ticket is None or not self.enabled:return
        # An operation begun before expiry must not write after expiry.
        end=self.begin()
        if end is None:return
        if not self.lock.acquire(blocking=False):
            self.dropped+=1
            return
        try:
            if kind not in KINDS:kind='network'
            if operation not in OPERATIONS:operation='other'
            if outcome not in OUTCOMES and outcome not in HTTP_OUTCOMES:outcome='error'
            elapsed=max(0,(end[0]-ticket[0])*1000)
            band=next(i for i,b in enumerate(BANDS) if elapsed<b)
            values=[max(0,min(int(v),2**40)) for v in (byte_count,items,scanned,filtered,reads)]
            wait_ms=max(0,min(float(wait_ms),elapsed))
            with closing(sqlite3.connect(self.path,timeout=0)) as db, db:
                db.execute('PRAGMA max_page_count=4096')
                db.execute('''INSERT INTO metrics VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
                    ON CONFLICT(bucket,kind,operation,outcome,background,band) DO UPDATE SET
                    count=count+1,total_ms=total_ms+excluded.total_ms,max_ms=MAX(max_ms,excluded.max_ms),
                    wait_ms=wait_ms+excluded.wait_ms,bytes=bytes+excluded.bytes,items=items+excluded.items,
                    scanned=scanned+excluded.scanned,filtered=filtered+excluded.filtered,reads=reads+excluded.reads''',
                    (ticket[1],kind,operation,outcome,int(bool(background)),band,elapsed,elapsed,wait_ms,*values))
                if self.dropped:
                    db.execute("INSERT INTO info VALUES('dropped',?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+excluded.value",(str(self.dropped),))
                    self.dropped=0
        except sqlite3.OperationalError as error:
            if 'locked' in str(error).lower() or 'busy' in str(error).lower():self.dropped+=1
            else:self.enabled=False
        except (OSError,sqlite3.Error,ValueError,TypeError,OverflowError):
            # Diagnostics must never prevent the underlying request or fill disk.
            self.enabled=False
        finally:self.lock.release()


recorder=Recorder()
configured=False

def configure(data):
    global recorder,configured
    if configured:return
    configured=True
    try:recorder=Recorder(data)
    except Exception:pass # Optional diagnostics cannot prevent bridge startup.


def report(data):
    data=Path(data);value=session(data)
    if not value:return {'status':'not enabled'}
    result={**value,'startedUtc':stamp(value['started']),'expiresUtc':stamp(value['expires']),
            'status':'active' if value['started']<=time.time()<value['expires'] else 'expired','operations':[]}
    path=data/'api-debug'/(value['id']+'.sqlite')
    if not path.is_file():return result
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row
        rows=db.execute('''SELECT kind,operation,outcome,background,SUM(count) AS count,
            ROUND(SUM(total_ms)/SUM(count),2) AS averageMs,ROUND(MAX(max_ms),2) AS maxMs,
            ROUND(SUM(wait_ms)/SUM(count),2) AS averageWaitMs,SUM(bytes) AS bytes,
            SUM(items) AS items,SUM(scanned) AS scanned,SUM(filtered) AS filtered,SUM(reads) AS reads
            FROM metrics GROUP BY kind,operation,outcome,background ORDER BY SUM(total_ms) DESC''').fetchall()
        result['operations']=[dict(row) for row in rows]
        result['windows']=[dict(r) for r in db.execute("SELECT bucket AS startUtcEpoch,SUM(count) AS apiCalls FROM metrics WHERE kind='network' GROUP BY bucket ORDER BY bucket")]
        result['latencyBandsMs']=[100,500,1000,3000,10000,30000,'over 30000']
        result['latencyHistogram']=[dict(r) for r in db.execute('SELECT kind,operation,band,SUM(count) AS count FROM metrics GROUP BY kind,operation,band')]
        result['dropped']=int((db.execute("SELECT value FROM info WHERE key='dropped'").fetchone() or [0])[0])
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('enable','report'))
    parser.add_argument('--data',default=str(Path(os.environ.get('LOCALAPPDATA','.'))/'ComfyBridge'))
    args=parser.parse_args()
    if args.command=='enable':
        value=activate(args.data)
        print(json.dumps(dict(startedUtc=stamp(value['started']),expiresUtc=stamp(value['expires']),note='Fixed seven-day window; restart the bridge to load diagnostics. Existing active windows are not extended.'),indent=2))
    else:print(json.dumps(report(args.data),indent=2))
