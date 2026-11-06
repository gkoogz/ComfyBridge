"""Phone media manifest. Standalone mode only reads the existing library during a rolling upgrade."""
from contextlib import closing
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

def file_digest(path, signature):
    with open(path, 'rb') as src:
        digest = hashlib.sha256()
        for chunk in iter(lambda: src.read(1024*1024), b''):
            digest.update(chunk)
    if stat_key(os.stat(path)) != signature:
        raise OSError('Media changed during verification')
    return digest.hexdigest()


def stat_key(st):
    return st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino


def read_ratings(data):
    try:
        with closing(sqlite3.connect((data/'library.sqlite').as_uri()+'?mode=ro',uri=True)) as db:
            ratings=dict(db.execute('SELECT media,rating FROM media_ratings'))
    except sqlite3.OperationalError:
        ratings={}
    return ratings


def with_ratings(items, data):
    ratings=read_ratings(data)
    for item in items:
        item['rating']=ratings.get(item['id'],0)
    return items


def media_manifest(items, root, cache_dir):
    with_ratings(items, cache_dir)
    # The worker sleeps between visits. Keep hashes across restarts so checking
    # the library normally requires only a file stat, not rereading every MP4.
    cache = None
    saved = {}
    try:
        cache = sqlite3.connect(cache_dir/'media-hashes.sqlite')
        cache.execute('CREATE TABLE IF NOT EXISTS hashes(id TEXT PRIMARY KEY, sig TEXT, digest TEXT, checked REAL)')
        saved = {id: (sig, digest, checked) for id,sig,digest,checked in cache.execute('SELECT * FROM hashes')}
    except sqlite3.Error:
        if cache: cache.close()
        cache = None
    updates = []
    now = time.time()
    for item in items:
        path = item.pop('path')
        try:
            st = os.stat(path)
            if st.st_size == 0:
                raise OSError('Empty or unfinished media file')
            key = stat_key(st)
            sig = repr(key)
            old = saved.get(item['id'])
            if old and old[0] == sig and 0 <= now-old[2] < 86400:
                digest = old[1]
            else:
                digest = file_digest(path, key)
                updates.append((item['id'],sig,digest,now))
            item.update(sha256=digest, size=st.st_size, source='available')
        except FileNotFoundError:
            item['source'] = 'missing' if (root/'output').is_dir() else 'unavailable'
        except OSError:
            item['source'] = 'unavailable'
    if cache:
        try:
            if updates:
                cache.executemany('INSERT OR REPLACE INTO hashes VALUES(?,?,?,?)', updates)
                cache.commit()
        except sqlite3.Error:
            pass  # A busy/readonly hash cache cannot invalidate a verified transfer.
        finally:
            cache.close()
    return {'version': 1, 'items': items}

if __name__ == '__main__':
    root = Path(json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))['comfyRoot'])
    data = Path(os.environ['LOCALAPPDATA'])/'ComfyBridge/library.sqlite'
    with sqlite3.connect(data.as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        items = [dict(r) for r in db.execute('SELECT id,job,kind,duration,created,archived,path FROM media ORDER BY created DESC,id DESC')]
    print(json.dumps(media_manifest(items, root, data.parent),ensure_ascii=True))
