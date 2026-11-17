"""Download official Krea 2 Turbo BF16 weights, resumably, with SHA-256 verification."""
import argparse
import os
import hashlib
import time
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests

REVISION = '588feaf955b08b9ac4723eeb751752ab045dba71'
FILES = (
    ('diffusion_models/krea2_turbo_bf16.safetensors', 26283332608, '78bbf8f4165eda19cea3cb06c78089221932a39e2eed8af9da741f942c47ffb3'),
    ('text_encoders/qwen3vl_4b_bf16.safetensors', 8875719384, '36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34'),
    ('vae/qwen_image_vae.safetensors', 253806246, 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f'),
)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8*1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()

def ranged_download(url, partial, size, workers=4):
    """Four bounded transfers; interrupted parts are reusable, never model files."""
    start = partial.stat().st_size if partial.exists() else 0
    chunk_size = 256*1024*1024
    ranges = [(offset,min(size,offset+chunk_size)-1) for offset in range(start,size,chunk_size)]
    def fetch(span):
        first,last = span
        chunk = partial.with_name(partial.name+f'.range-{first}-{last}')
        for attempt in range(6):
            have = chunk.stat().st_size if chunk.exists() else 0
            if have == last-first+1: return chunk
            try:
                with requests.get(url,headers={'Range':f'bytes={first+have}-{last}'},stream=True,timeout=(30,90)) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or not response.headers.get('Content-Range','').startswith(f'bytes {first+have}-{last}/'):
                        raise ValueError('Server did not honor the download range')
                    with chunk.open('ab') as out:
                        for block in response.iter_content(4*1024*1024):out.write(block)
                if chunk.stat().st_size != last-first+1:raise ValueError('Incomplete range')
                return chunk
            except (requests.RequestException,ValueError):
                if attempt==5:raise
                time.sleep(min(30,2**attempt))
    with ThreadPoolExecutor(max_workers=workers) as pool, partial.open('ab') as output:
        for chunk in pool.map(fetch,ranges):
            with chunk.open('rb') as source:shutil.copyfileobj(source,output,8*1024*1024)
            output.flush();chunk.unlink()

def install(root, http=False, workers=4):
    for name, size, sha in FILES:
        target = Path(root)/'models'/name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if target.stat().st_size != size or digest(target) != sha:
                raise ValueError('Existing file differs; not overwritten: '+str(target))
            print('Verified '+name, flush=True)
            continue
        partial = target.with_suffix(target.suffix+'.part')
        # Xet fetches independent chunks concurrently and resumes its own cache.
        # Prefer it on this machine; retain the plain HTTP fallback for portable installs.
        try:
            from huggingface_hub import hf_hub_download
            import hf_xet
        except ImportError:
            hf_hub_download = None
        if hf_hub_download and not http:
            os.environ.setdefault('HF_XET_HIGH_PERFORMANCE','1')
            print('Downloading with Hugging Face Xet: '+name,flush=True)
            hf_hub_download('Comfy-Org/Krea-2',name,revision=REVISION,local_dir=Path(root)/'models')
            if target.stat().st_size != size or digest(target) != sha:
                raise ValueError('Downloaded file failed verification: '+str(target))
            partial.unlink(missing_ok=True)
            print('Installed and verified '+name,flush=True)
            continue
        if http:
            print(f'Downloading with {workers} HTTP transfers: '+name,flush=True)
            ranged_download(f'https://huggingface.co/Comfy-Org/Krea-2/resolve/{REVISION}/{name}',partial,size,workers)
            if partial.stat().st_size != size or digest(partial) != sha:
                raise ValueError('Download failed verification: '+str(partial))
            partial.rename(target)
            print('Installed and verified '+name,flush=True)
            continue
        for attempt in range(6):
            offset = partial.stat().st_size if partial.exists() else 0
            if offset == size:
                break
            try:
                url = f'https://huggingface.co/Comfy-Org/Krea-2/resolve/{REVISION}/{name}'
                with requests.get(url, headers={'Range': f'bytes={offset}-'} if offset else {}, stream=True, timeout=(30,120)) as response:
                    response.raise_for_status()
                    if offset and response.status_code != 206:
                        offset = 0
                    if offset and not response.headers.get('Content-Range','').startswith(f'bytes {offset}-'):
                        raise ValueError('Invalid resumed response')
                    print('Downloading '+name+f' from {offset:,} bytes', flush=True)
                    with partial.open('ab' if offset else 'wb') as output:
                        for chunk in response.iter_content(4*1024*1024):
                            output.write(chunk)
                if partial.stat().st_size != size:
                    raise ValueError('Incomplete download')
                break
            except (requests.RequestException, ValueError):
                if attempt == 5:
                    raise
                time.sleep(min(30, 2**attempt))
        print('Verifying '+name, flush=True)
        if partial.stat().st_size != size or digest(partial) != sha:
            raise ValueError('Download failed verification; partial retained: '+str(partial))
        partial.rename(target)
        print('Installed '+name, flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=r'E:\ComfyUI-Zluda')
    parser.add_argument('--http',action='store_true',help='Use four resumable HTTP ranges instead of Xet')
    parser.add_argument('--workers',type=int,choices=range(1,17),default=4)
    args=parser.parse_args()
    install(args.root,args.http,args.workers)
