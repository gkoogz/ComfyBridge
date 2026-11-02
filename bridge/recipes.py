"""Keep a generation's inputs and ComfyUI graph for Library replay."""
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import extension

_publish_lock=threading.Lock()


def checked_source(path):
    if not path.is_file():
        raise ValueError('The saved generation source is missing on the PC.')
    digest=hashlib.sha256()
    with path.open('rb') as src:
        for chunk in iter(lambda:src.read(1024*1024),b''):
            digest.update(chunk)
    if digest.hexdigest()!=path.stem:
        raise ValueError('The saved generation source has changed on the PC.')
    return path


def preserve(root, source, suffix):
    folder=root/'input/ComfyBridge/recipes'
    folder.mkdir(parents=True,exist_ok=True)
    if source.parent.resolve()==folder.resolve():
        return checked_source(source)
    digest=hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=folder,delete=False) as out:
        tmp=Path(out.name)
    try:
        with source.open('rb') as src, tmp.open('wb') as out:
            for chunk in iter(lambda:src.read(1024*1024),b''):
                digest.update(chunk)
                out.write(chunk)
        target=folder/(digest.hexdigest()+suffix)
        with _publish_lock:
            if not target.exists():
                tmp.replace(target)
                return target
        checked_source(target)
        return target
    finally:
        tmp.unlink(missing_ok=True)


def keep_images(root,settings):
    for key in ('upload','mask'):
        if settings.get(key):
            source=(root/'input'/settings[key]).resolve()
            if not source.is_relative_to((root/'input/ComfyBridge').resolve()):
                raise ValueError('The image source is outside ComfyBridge inputs.')
            path=preserve(root,source,'.png')
            settings[key]=path.resolve().relative_to((root/'input').resolve()).as_posix()


def keep_clip(root,source,info):
    version=info['revision']
    if extension.revision(source)!=version:
        raise ValueError('The original source video changed on the PC.')
    saved=preserve(root,source,'.mp4')
    if extension.revision(source)!=version:
        raise ValueError('Source video changed while preserving it.')
    cover=saved.with_suffix('.jpg')
    if not cover.is_file():
        extension.save_cover(saved,cover)
    return dict(info,id='recipe-'+saved.stem,revision=extension.revision(saved))


def preserve_library(db,root):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='jobs'").fetchone():
        return 0,0
    saved=missing=0
    # Original job JSON is retained. This separate copy records verified paths for replay.
    db.execute("CREATE TABLE IF NOT EXISTS legacy_sources(job TEXT PRIMARY KEY,sources TEXT NOT NULL)")
    candidates=db.execute("""SELECT id,settings FROM jobs WHERE status='complete'
        AND EXISTS (SELECT 1 FROM media WHERE job=jobs.id)
        AND NOT EXISTS (SELECT 1 FROM legacy_sources WHERE job=jobs.id)""").fetchall()
    for job,raw in candidates:
        settings=json.loads(raw)
        if settings.get('recipeVersion') or not any(settings.get(k) for k in ('upload','mask','extension')):
            continue
        refs={key:settings[key] for key in ('upload','mask','extension') if settings.get(key)}
        try:
            keep_images(root,refs)
            if refs.get('extension'):
                clip=refs['extension']
                refs['extension']=keep_clip(root,extension.source_path(db,root,clip['id']),clip)
        except (OSError,ValueError):
            missing+=1
            continue
        with db:
            db.execute('INSERT OR IGNORE INTO legacy_sources VALUES(?,?)',(job,json.dumps(refs)))
        saved+=1
    return saved,missing


def recorded_graph(db,job):
    row=db.execute('SELECT graph FROM generation_graphs WHERE job=?',(job,)).fetchone()
    return json.loads(row[0]) if row else None


def graph_for_replay(db,kind,settings,new_id):
    original=settings.get('replayOf')
    if not original:
        return None
    row=db.execute('SELECT settings FROM jobs WHERE id=? AND kind=?',(original,kind)).fetchone()
    if not row:
        return None
    previous=json.loads(row[0])
    keys=('model','loras','positive','negative','width','height','steps','cfg','denoise',
          'upload','mask','frames','fps','extension','exactFrames','sound')
    if any(settings.get(k)!=previous.get(k) for k in keys):
        return None  # An edited recipe should use the newly selected inputs.
    graph=recorded_graph(db,original)
    if graph is None:
        return None
    for node in graph.values():
        inputs=node['inputs']
        if node['class_type'] in ('SaveImage','SaveVideo'):
            inputs['filename_prefix']='ComfyBridge/'+new_id
        if node['class_type']=='LoadImage' and previous.get('extension'):
            inputs['image']=inputs['image'].replace(original,new_id)
        if node['class_type']=='KSampler':
            inputs['seed']=int(settings['seed'])
        if node['class_type']=='RandomNoise':
            inputs['noise_seed']=int(settings['seed'])
    return graph
