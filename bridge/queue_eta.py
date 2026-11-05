"""Estimate queue time from this PC's completed jobs and live sampler timing."""
import json
import math
import statistics
import time

from queue_progress import LIVE_JOBS


def work_size(kind,settings):
    pixels=max(1,int(settings['width'])*int(settings['height']))
    frames=1
    if kind=='video':
        frames=5+17*max(0,math.ceil((int(settings['frames'])-5)/17))
        if settings.get('extension'):
            frames=5+17*math.ceil(int(settings['frames'])/17)
    guidance=2 if kind=='video' and (settings.get('negative') or '').strip() else 1
    return pixels*max(1,int(settings['steps']))*frames*guidance


def profile(kind,settings):
    mode='extend' if settings.get('extension') else 'mask' if settings.get('mask') else 'image' if settings.get('upload') else 'text'
    return kind,settings.get('model'),mode,bool(settings.get('sound'))


class QueueEta:
    def __init__(self):
        self.key=None
        self.expected={}

    def refresh(self,db,live):
        latest=db.execute("SELECT MAX(ended) FROM job_times").fetchone()[0]
        key=(tuple(j['id'] for j in live),latest)
        if key==self.key:
            return
        samples=[]
        for row in db.execute("""SELECT j.kind,j.settings,t.ended-t.started AS seconds
            FROM jobs j JOIN job_times t ON t.job=j.id
            WHERE j.status='complete' AND t.observed=0 AND t.ended>t.started
            ORDER BY t.ended DESC LIMIT 120"""):
            try:
                settings=json.loads(row['settings'])
                samples.append((profile(row['kind'],settings),work_size(row['kind'],settings),row['seconds']))
            except (KeyError,ValueError,TypeError):
                continue
        expected={}
        for job in live:
            settings=json.loads(job['settings'])
            signature=profile(job['kind'],settings)
            size=work_size(job['kind'],settings)
            # Prefer similar workloads. A different model or input mode needs its own history.
            matches=[(abs(math.log(size/units)),seconds*size/units) for p,units,seconds in samples
                     if p==signature and .25<=size/units<=4]
            matches.sort(key=lambda item:item[0])
            expected[job['id']]=statistics.median(seconds for _,seconds in matches[:5]) if matches else None
        self.key,self.expected=key,expected

    def snapshot(self,db,active,tracker):
        live=[dict(row) for row in db.execute(f"""SELECT j.id,j.settings,j.kind,j.status,t.started
            FROM jobs j LEFT JOIN job_times t ON t.job=j.id WHERE {LIVE_JOBS} ORDER BY j.rowid""")]
        self.refresh(db,live)
        remaining={}
        for job in live:
            estimate=self.expected[job['id']]
            if job['status']=='cancelling':
                estimate=None
            elif job['id']==active and tracker:
                estimate=tracker.remaining(estimate,time.time()-job['started'] if job['started'] else 0)
            elif job['status']!='pending':
                elapsed=time.time()-job['started'] if job['started'] else None
                estimate=estimate-elapsed if estimate is not None and elapsed is not None and elapsed<estimate else None
            remaining[job['id']]=math.ceil(estimate) if estimate is not None else None
        total=sum(remaining.values()) if all(value is not None for value in remaining.values()) else None
        return remaining,total
