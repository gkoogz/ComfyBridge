"""Read immutable job recipes as a branching history, including archived results."""
import json
from pathlib import Path
import uuid
import hashlib
import recipes
import extension


def settings_for(db, job):
    row=db.execute('SELECT * FROM jobs WHERE id=?',(str(uuid.UUID(job)),)).fetchone()
    if row is None:
        raise ValueError('This generation record is no longer available.')
    row=dict(row);settings=json.loads(row.pop('settings'))
    if not settings.get('recipeVersion') and db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_sources'").fetchone():
        saved=db.execute('SELECT sources FROM legacy_sources WHERE job=?',(job,)).fetchone()
        if saved: settings.update(json.loads(saved[0]))
    return row,settings


def parents(settings, media_jobs):
    result=[]
    def add(job, relation):
        if job and not any(x['job']==job for x in result):result.append(dict(job=job,relation=relation))
    add(settings.get('replayOf'),'Regenerated from')
    source=settings.get('sourceMedia')
    if not source and settings.get('extension'):
        source=settings['extension'].get('id')
    add(media_jobs.get(source),'Extended from' if settings.get('extension') else 'Source image')
    origin=settings.get('sourceOrigin')
    if isinstance(origin,dict):add(origin.get('job'),'Input reused from')
    return result


def generation_type(kind, settings):
    if settings.get('extension'):return 'Extend video'
    if kind=='video':return 'Image to video' if settings.get('upload') else 'Text to video'
    return 'Image + mask to image' if settings.get('mask') else 'Image to image' if settings.get('upload') else 'Text to image'


def node(db, job):
    row,s=settings_for(db,job)
    media=[dict(r) for r in db.execute('SELECT id,job,kind,created,duration,archived FROM media')]
    media_jobs={m['id']:m['job'] for m in media}
    outputs=[m for m in media if m['job']==row['id']]
    timing=db.execute('SELECT started,ended,observed FROM job_times WHERE job=?',(job,)).fetchone()
    elapsed=max(0,timing['ended']-timing['started']) if timing and timing['started'] and timing['ended'] else None
    branches=[]
    candidates=[dict(r) for r in db.execute('SELECT id,kind,created,status,settings FROM jobs ORDER BY created DESC')]
    def branch(candidate):
        return dict(job=candidate['id'],kind=candidate['kind'],created=candidate['created'],status=candidate['status'],outputs=[m for m in media if m['job']==candidate['id']])
    for candidate in candidates:
        if candidate['id']==job:continue
        links=parents(json.loads(candidate['settings']),media_jobs)
        if any(link['job']==job for link in links):
            branches.append(branch(candidate))
    sources=[]
    for role in ('upload','mask','extension'):
        if not s.get(role):continue
        media_id=s.get('sourceMedia') if role!='mask' else None
        if role=='extension':media_id=media_id or s[role].get('id')
        linked=next((m for m in media if m['id']==media_id),None)
        origin=s.get('sourceOrigin') if role!='mask' else None
        origin=origin or dict(job=job,role=role)
        related=[]
        for candidate in candidates:
            other=json.loads(candidate['settings'])
            if candidate['id']==job:continue
            if other.get('sourceOrigin')==origin:
                related.append(branch(candidate))
        sources.append(dict(role=role,kind='video' if role=='extension' else 'image',media=linked,origin=origin,branches=related,
            url='/source/'+job+'/'+role,thumbnail='/source/'+job+'/'+role+'-thumb'))
    keys=('positive','negative','model','loras','seed','width','height','steps','cfg','denoise','fps','frames','seconds','sound','increment')
    components={}
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='generation_graphs'").fetchone():
        recorded=recipes.recorded_graph(db,job) or {}
        for step in recorded.values():
            for key in ('vae_name','clip_name','clip_name1','clip_name2','sampler_name','scheduler','unet_name','weight_dtype'):
                value=step.get('inputs',{}).get(key)
                if isinstance(value,str):components.setdefault(key,[]).append(value)
        components={k:list(dict.fromkeys(v)) for k,v in components.items()}
    return dict(job=job,kind=row['kind'],type=generation_type(row['kind'],s),created=row['created'],
                finished=timing['ended'] if timing else None,status=row['status'],elapsed=elapsed,
                elapsedEstimated=bool(timing and timing['observed']),settings={k:s[k] for k in keys if k in s},
                outputs=outputs,sources=sources,parents=parents(s,media_jobs),branches=branches,
                components=components,provenanceKnown=bool(s.get('provenanceVersion')),recipeVersion=s.get('recipeVersion',0))


def source_file(db,root,data,job,role):
    thumb=role.endswith('-thumb');role=role.removesuffix('-thumb')
    if role not in ('upload','mask','extension'):raise ValueError('Unknown source kind.')
    _,s=settings_for(db,job)
    if not s.get(role):raise ValueError('No saved source for this generation.')
    if role=='extension':path=extension.source_path(db,root,s[role]['id']).resolve()
    else:path=(root/'input'/s[role]).resolve()
    allowed=(root/'input/ComfyBridge').resolve()
    if not path.is_relative_to(allowed) and not (role=='extension' and path.is_relative_to((root/'output/ComfyBridge').resolve())):
        raise ValueError('Invalid source location.')
    if not path.is_file():raise ValueError('The saved source was moved or deleted on the PC.')
    if path.parent==(allowed/'recipes'):recipes.checked_source(path)
    if thumb:
        if role=='extension':
            cover=path.with_suffix('.jpg')
            if not cover.is_file():extension.save_cover(path,cover)
            path=cover
        else:
            from PIL import Image
            key=hashlib.sha256((str(path)+str(path.stat().st_mtime_ns)).encode()).hexdigest()
            cover=data/'source-thumbnails'/(key+'.jpg');cover.parent.mkdir(parents=True,exist_ok=True)
            if not cover.is_file():
                with Image.open(path) as image:
                    image.thumbnail((400,400));image.convert('RGB').save(cover,quality=85)
            path=cover
    return dict(path=str(path),mime='image/jpeg' if thumb else 'video/mp4' if role=='extension' else 'image/png')
