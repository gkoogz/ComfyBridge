"""Prepare a five-frame motion guide and publish a joined, silent ComfyBridge MP4."""
from collections import deque
from fractions import Fraction
from pathlib import Path
import os
import re
import shutil
import subprocess
import uuid

GUIDE_FRAMES = 5


def source_path(db, root, media_id):
    if re.fullmatch(r'upload-[0-9a-f]{64}', media_id):
        path = root/'input/ComfyBridge/videos'/(media_id+'.mp4')
        if not path.is_file():
            raise ValueError('The imported video is missing on the PC. Choose it again.')
        return path
    row = db.execute("SELECT path FROM media WHERE id=? AND kind='video'", (media_id,)).fetchone()
    if not row:
        raise ValueError('That video is no longer in the PC library.')
    path = Path(row[0]).resolve()
    if not path.is_relative_to((root / 'output/ComfyBridge').resolve()) or not path.is_file():
        raise ValueError('The original video is missing on the PC.')
    return path


def revision(path):
    stat = path.stat()
    return f'{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}:{stat.st_ino}'


def describe(path, media_id):
    import av
    version = revision(path)
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError('This file contains no video track.')
        stream = container.streams.video[0]
        fps = stream.average_rate
        if not fps or not 1 <= fps <= 120 or stream.frames < GUIDE_FRAMES:
            raise ValueError('The source needs at least five frames and a known frame rate.')
        if stream.width % 32 or stream.height % 32:
            raise ValueError('The source dimensions are incompatible with the MiniMax canvas.')
        return dict(id=media_id, revision=version, width=stream.width, height=stream.height,
                    fps=float(fps), frames=stream.frames, hasAudio=bool(container.streams.audio))


def ffmpeg(*args):
    exe = shutil.which('ffmpeg') or Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Shotcut/ffmpeg.exe'
    if not Path(exe).is_file():
        raise ValueError('Install FFmpeg on the PC and add it to PATH, or install Shotcut, to import phone videos.')
    result = subprocess.run([str(exe),'-nostdin','-v','error','-y',*map(str,args)],
                            capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:
        raise ValueError('Could not process the selected clip: '+result.stderr.decode(errors='replace')[-350:])


def import_clip(raw, folder, digest):
    import av
    media_id = 'upload-'+digest
    target = folder/(media_id+'.mp4')
    if not target.exists():
        with av.open(str(raw),options={'format_whitelist':'mov,matroska,webm,avi,mpegts,mpeg','protocol_whitelist':'file'}) as container:
            if not container.streams.video:
                raise ValueError('Choose a file with a video track.')
            stream = container.streams.video[0]
            rate = stream.average_rate or stream.guessed_rate
            if not rate or not 1<=rate<=120 or max(stream.width,stream.height)>8192:
                raise ValueError('Choose a clip with 1–120 FPS and dimensions up to 8192.')
        tmp = folder/(uuid.uuid4().hex+'.mp4')
        try:
            # Auto-rotate phone footage, pad to the model grid, and normalize camera VFR timestamps.
            ffmpeg('-protocol_whitelist','file','-format_whitelist','mov,matroska,webm,avi,mpegts,mpeg',
                   '-i',raw,'-map','0:v:0','-map','0:a:0?','-vf','pad=ceil(iw/32)*32:ceil(ih/32)*32,setsar=1',
                   '-r',str(rate),'-fps_mode','cfr','-c:v','libx264','-pix_fmt','yuv420p','-threads','4',
                   '-preset','veryfast','-crf','16','-c:a','aac','-af','apad','-shortest',tmp)
            describe(tmp,media_id)
            if not target.exists():tmp.replace(target)
        finally:
            tmp.unlink(missing_ok=True)
    info=describe(target,media_id)
    with av.open(str(target)) as video:
        cover=next(video.decode(video=0)).to_image()
        cover.thumbnail((400,400));cover.convert('RGB').save(target.with_suffix('.jpg'),quality=80)
    return info


def guide_names(job):
    job = str(uuid.UUID(job))
    return [f'ComfyBridge/extend-{job}-{i}.png' for i in range(GUIDE_FRAMES)]


def prepare_guide(root, source, info, job):
    import av
    if revision(source) != info['revision']:
        raise ValueError('Source video changed. Select Extend video again.')
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        if stream.duration:
            container.seek(max(0,(stream.start_time or 0)+stream.duration-round(2/stream.time_base)),stream=stream)
        frames = deque(container.decode(stream), maxlen=GUIDE_FRAMES)
        if len(frames) != GUIDE_FRAMES:
            container.seek(0,stream=stream)
            frames = deque(container.decode(stream), maxlen=GUIDE_FRAMES)
        if len(frames) != GUIDE_FRAMES:
            raise ValueError('Could not decode the last five frames of the source.')
        for name, frame in zip(guide_names(job), frames):
            path = root/'input'/name
            path.parent.mkdir(parents=True, exist_ok=True)
            frame.to_image().save(path)
    if revision(source) != info['revision']:
        raise ValueError('Source video changed while decoding the guide.')


def join(source, suffix, info, extra, thumb, cancelled):
    """Replace only this job's generated suffix, atomically. A restart can safely retry."""
    import av
    if revision(source) != info['revision']:
        raise ValueError('Source video changed during generation.')
    total = info['frames'] + extra
    tmp = suffix.with_suffix('.joining.mp4')
    try:
        with av.open(str(suffix)) as tail:
            tail_frames = tail.streams.video[0].frames
        if tail_frames != total:
            if tail_frames != extra:
                raise ValueError(f'Expected {extra} continuation frames, got {tail_frames}.')
            with av.open(str(source)) as src, av.open(str(tmp),'w',options={'movflags':'+faststart'}) as out:
                stream = src.streams.video[0]
                fps = stream.average_rate
                encoder = out.add_stream('libx264',rate=fps,options={'preset':'veryfast','crf':'16'})
                encoder.width,encoder.height,encoder.pix_fmt=info['width'],info['height'],'yuv420p'
                encoder.codec_context.thread_count=4
                written=0
                def append(frames):
                    nonlocal written
                    for frame in frames:
                        if cancelled(): raise InterruptedError('Extension cancelled.')
                        frame.pts=written
                        frame.time_base=Fraction(1,fps)
                        frame.pict_type=0
                        for packet in encoder.encode(frame):out.mux(packet)
                        written+=1
                append(src.decode(stream))
                if written!=info['frames']:raise ValueError('Source frame count changed.')
                with av.open(str(suffix)) as tail:
                    append(tail.decode(video=0))
                if written!=total:raise ValueError('Continuation frame count changed.')
                for packet in encoder.encode():out.mux(packet)
        if cancelled():raise InterruptedError('Extension cancelled.')
        if revision(source)!=info['revision']:raise ValueError('Source changed while joining.')
        if tail_frames!=total:
            if info.get('hasAudio'):
                audio_tmp=tmp.with_suffix('.audio.mp4')
                try:
                    ffmpeg('-i',tmp,'-i',source,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',audio_tmp)
                    if cancelled():raise InterruptedError('Extension cancelled.')
                    audio_tmp.replace(tmp)
                finally:
                    audio_tmp.unlink(missing_ok=True)
            tmp.replace(suffix)
        with av.open(str(suffix)) as joined:
            image=next(joined.decode(video=0)).to_image()
            image.thumbnail((400,400));image.convert('RGB').save(thumb,quality=80)
        return total/info['fps']
    finally:
        tmp.unlink(missing_ok=True)
