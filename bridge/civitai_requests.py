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
        self.last_foreground=0

    def configure(self, path):
        with self.lock:
            if self.state_path is not None:return
            self.state_path=Path(path)
            try:
                saved=json.loads(self.state_path.read_text())
                self.until=max(self.until,float(saved.get('until',0)))
            except (OSError,ValueError,TypeError):pass

    def spare_delay(self, now):
        # Local conservative budgets, not an assertion of Civitai's quota.
        # Leave 40% of minute capacity for browsing and notice short bursts too.
        delay=max(0,self.until-now)
        for queue,window,limit in ((self.recent,60,36),(self.recent,10,6),(self.background,60,12)):
            recent=[t for t in queue if t>now-window]
            if len(recent)>=limit:delay=max(delay,recent[-limit]+window-now)
        return delay

    def has_headroom(self):
        with self.lock:return self.spare_delay(self.clock())<=0

    def acquire(self, background=False, quiet=False, writeback=False):
        with self.lock:
            now=self.clock()
            for queue in (self.recent,self.background):
                while queue and queue[0]<=now-60:queue.popleft()
            delays=[(max(0,self.until-now),'cooldown')]
            if quiet:delays.append((self.spare_delay(now),'browsing_priority'))
            if len(self.recent)>=60:delays.append((self.recent[0]+60-now,'total_limit'))
            if background and len(self.background)>=20:delays.append((self.background[0]+60-now,'background_limit'))
            delay,reason=max(delays,key=lambda x:x[0])
            if delay:raise Deferred(delay,reason)
            self.sleep(max(0,self.next-now))
            now=self.clock();self.next=now+.6;self.recent.append(now)
            if background:self.background.append(now)
            elif not writeback:self.last_foreground=now

    def quiet_for(self):
        with self.lock:return self.clock()-(self.recent[-1] if self.recent else 0)

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
def background_work(quiet=False, writeback=False, urgent=False):
    old={k:getattr(context,k,False) for k in ('background','quiet','writeback')}
    context.background=not urgent;context.quiet=quiet;context.writeback=writeback
    try:yield
    finally:
        for k,v in old.items():setattr(context,k,v)

def before(url):
    parsed=urllib.parse.urlparse(url)
    if parsed.hostname in ('civitai.com','civitai.red') and parsed.path.startswith('/api/'):
        governor.acquire(getattr(context,'background',False),getattr(context,'quiet',False),getattr(context,'writeback',False))
