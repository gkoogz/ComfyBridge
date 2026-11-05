"""Install the pinned, verified local chat runtime; never modify ComfyUI's packages."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile
import concurrent.futures
import threading

RUNTIME = 'b12136'
RUNTIME_SHA = '0b67f5c54f926952a49ba98bba5cfc7ae7dd2846e4c81b1e45befa9cd01ef944'
MODEL = 'Qwen_Qwen3.5-9B-Q5_K_M.gguf'
MODEL_SHA = 'a686d88ec1e6881f9bf161526826cd6d6874b7f0e80e0f79acf6144a132c5d7e'
REVISION = '182be2fd6c7bc44887d88a91cb03ff009cc9f549'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, dest, digest, size=None):
    if dest.is_file() and sha256(dest) == digest:
        print(dest.name + ' already verified.', flush=True)
        return
    part = dest.with_suffix(dest.suffix + '.partial')
    if part.is_file() and sha256(part) == digest:
        part.replace(dest)
        return
    if size and size > 256 * 1024 * 1024:
        chunks = dest.with_suffix('.chunks')
        chunks.mkdir(exist_ok=True)
        block = 32 * 1024 * 1024
        offsets = list(range(0, size, block))
        # Reuse any complete prefix from an interrupted sequential download.
        if part.exists() and part.stat().st_size < size:
            with part.open('rb') as previous:
                for offset in offsets:
                    count = min(block, size-offset)
                    if offset + count > part.stat().st_size:
                        break
                    target = chunks / str(offset)
                    if not target.exists() or target.stat().st_size != count:
                        previous.seek(offset)
                        target.write_bytes(previous.read(count))
        progress = [sum(min(block,size-offset) for offset in offsets if (chunks/str(offset)).exists() and (chunks/str(offset)).stat().st_size == min(block,size-offset))]
        guard = threading.Lock()
        print(f'Resuming {dest.name} from {progress[0]/1024**3:.1f} / {size/1024**3:.1f} GiB.', flush=True)
        def fetch(offset):
            target = chunks / str(offset)
            end = min(offset+block,size)-1
            count = end-offset+1
            if target.exists() and target.stat().st_size == count:
                return
            for attempt in range(6):
                try:
                    request = urllib.request.Request(url,headers={'User-Agent':'ComfyBridge-local-chat','Range':f'bytes={offset}-{end}'})
                    with urllib.request.urlopen(request,timeout=45) as response:
                        if response.status != 206 or response.headers.get('Content-Range') != f'bytes {offset}-{end}/{size}':
                            raise OSError('Download server did not honor the requested byte range.')
                        with target.open('wb') as output:
                            received = 0
                            while packet := response.read(1024*1024):
                                received += len(packet)
                                if received > count:
                                    raise OSError('Unexpected download length.')
                                output.write(packet)
                    if received != count:
                        raise OSError('Incomplete download range.')
                    with guard:
                        before = progress[0]
                        progress[0] += count
                        if progress[0]//(512*1024*1024) != before//(512*1024*1024):
                            print(f'{dest.name}: {progress[0]/1024**3:.1f} / {size/1024**3:.1f} GiB',flush=True)
                    return
                except Exception as error:
                    if attempt == 5:
                        raise
                    print(f'Retrying model range {offset}: {type(error).__name__}',flush=True)
                    time.sleep(2+attempt)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(fetch,offsets))
        digest_check = hashlib.sha256()
        with part.open('wb') as output:
            for offset in offsets:
                with (chunks/str(offset)).open('rb') as source:
                    for packet in iter(lambda:source.read(1024*1024),b''):
                        output.write(packet)
                        digest_check.update(packet)
        if digest_check.hexdigest() != digest:
            raise ValueError('Model SHA-256 verification failed; no model was installed.')
        part.replace(dest)
        for offset in offsets:
            (chunks/str(offset)).unlink()
        chunks.rmdir()
        print(dest.name+' verified.',flush=True)
        return
    for attempt in range(4):
        try:
            offset = part.stat().st_size if part.exists() else 0
            headers = {'User-Agent': 'ComfyBridge-local-chat'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                append = offset and response.status == 206
                with part.open('ab' if append else 'wb') as output:
                    copied = offset if append else 0
                    next_report = copied + 512 * 1024 * 1024
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        copied += len(chunk)
                        if copied >= next_report:
                            print(f'{dest.name}: {copied / 1024**3:.1f} GiB', flush=True)
                            next_report = copied + 512 * 1024 * 1024
            if sha256(part) != digest:
                part.unlink()
                raise ValueError('Downloaded file failed SHA-256 verification.')
            part.replace(dest)
            print(dest.name + ' verified.', flush=True)
            return
        except Exception as error:
            if attempt == 3:
                raise
            print(f'Retrying {dest.name}: {type(error).__name__}',flush=True)
            time.sleep(3)


def install(root, data):
    root.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    model_dir = root / 'models'
    model_dir.mkdir(exist_ok=True)
    archive = root / f'llama-{RUNTIME}-win-vulkan-x64.zip'
    download(f'https://github.com/ggml-org/llama.cpp/releases/download/{RUNTIME}/llama-{RUNTIME}-bin-win-vulkan-x64.zip', archive, RUNTIME_SHA)
    runtime = root / RUNTIME
    runtime.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for name in bundle.namelist():
            if not (runtime / name).resolve().is_relative_to(runtime.resolve()):
                raise ValueError('Unsafe runtime archive entry.')
        bundle.extractall(runtime)
    executable = next(runtime.rglob('llama-server.exe'))
    download(f'https://huggingface.co/bartowski/Qwen_Qwen3.5-9B-GGUF/resolve/{REVISION}/{MODEL}', model_dir / MODEL, MODEL_SHA, 7111487520)
    config_file = data / 'chat-runtime.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    config.update(executable=str(executable), modelDir=str(model_dir), runtime=RUNTIME)
    config.setdefault('selected', MODEL)
    pending = config_file.with_suffix('.tmp')
    pending.write_text(json.dumps(config, indent=2), encoding='utf-8')
    pending.replace(config_file)
    print('Local chat installed. Models load only when a message is sent.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('E:/ComfyBridge-LLM'))
    parser.add_argument('--data', type=Path, default=Path(os.environ['LOCALAPPDATA']) / 'ComfyBridge')
    args = parser.parse_args()
    install(args.root, args.data)
