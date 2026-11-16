"""Shared, conservative API pacing. Media CDN/file downloads are not API calls."""
from collections import deque
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
import threading
import time
import urllib.parse
import json
from pathlib import Path


class Deferred(ValueError):
    def __init__(self, seconds, reason='deferred'):
        self.retry_after=max(1,int(seconds)+1)
        self.reason=reason
        super().__init__('Civitai requests are paused briefly; cached content is still available. Retry in %s seconds.'%self.retry_after)


class Governor:
    def __init__(self, clock=time.time, sleep=time.sleep):
        self.clock,self.sleep=clock,sleep
        self.lock=threading.Lock();self.recent=deque();self.background=deque()
        self.next=0;self.until=0;self.failures=0
        self.state_path=None

    def configure(self, path):
        with self.lock:
            if self.state_path is not None:return
            self.state_path=Path(path)
            try:
                saved=json.loads(self.state_path.read_text())
                self.until=max(self.until,float(saved.get('until',0)))
            except (OSError,ValueError,TypeError):pass

    def acquire(self, background=False):
        with self.lock:
            now=self.clock()
            for queue in (self.recent,self.background):
                while queue and queue[0]<=now-60:queue.popleft()
            delays=[(max(0,self.until-now),'cooldown')]
            if len(self.recent)>=60:delays.append((self.recent[0]+60-now,'total_limit'))
            if background and len(self.background)>=20:delays.append((self.background[0]+60-now,'background_limit'))
            delay,reason=max(delays,key=lambda x:x[0])
            if delay:raise Deferred(delay,reason)
            self.sleep(max(0,self.next-now))
            now=self.clock();self.next=now+.6;self.recent.append(now)
            if background:self.background.append(now)

    def failed(self, code, retry_after=None):
        if code not in (429,500,502,503,504):return
        with self.lock:
            now=self.clock();self.failures+=1;delay=min(300,5*2**min(self.failures-1,6))
            if retry_after:
                try:delay=max(delay,float(retry_after))
                except (ValueError,TypeError):
                    try:delay=max(delay,parsedate_to_datetime(retry_after).timestamp()-now)
                    except (ValueError,TypeError,OverflowError):pass
            self.until=max(self.until,now+delay)
            if self.state_path:
                try:
                    temporary=self.state_path.with_suffix('.tmp')
                    temporary.write_text(json.dumps({'until':self.until}))
                    temporary.replace(self.state_path)
                except OSError:pass

    def succeeded(self):
        with self.lock:self.failures=0


governor=Governor()
context=threading.local()

@contextmanager
def background_work():
    old=getattr(context,'background',False);context.background=True
    try:yield
    finally:context.background=old

def before(url):
    parsed=urllib.parse.urlparse(url)
    if parsed.hostname in ('civitai.com','civitai.red') and parsed.path.startswith('/api/'):
        governor.acquire(getattr(context,'background',False))
