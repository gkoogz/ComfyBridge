"""Checkpointable deterministic Euler sampler, opt-in per ComfyBridge H3 job.

Save the RAW sampler tensor, not a denoised preview or normalized LATENT.
Comfy re-creates conditioning and its normal wrappers on resume; this sampler
then replaces the initial noise with x at the saved boundary. Keep the complete
sigma schedule in model_options and absolute step indices for H3 audio/video.
"""
import json
import os
from pathlib import Path
import shutil
import time
import uuid
import torch


class ComfyBridgeCheckpointPaused(Exception):
    pass


def read(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def write_json(path, value):
    tmp = path.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def save(root, x, sigmas, step, signature, seed):
    root.mkdir(parents=True, exist_ok=True)
    required = x.numel()*x.element_size() + sigmas.numel()*sigmas.element_size() + 64*1024**2
    if shutil.disk_usage(root).free < required:
        raise OSError('Not enough disk space for a safe video checkpoint')
    payload = dict(version=1, x=x.detach().cpu().clone(), sigmas=sigmas.detach().cpu().clone(),
                   step=step, signature=signature, seed=seed)
    tmp = root/'state.tmp'
    try:
        with tmp.open('wb') as stream:
            torch.save(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, root/'state.pt')
        # Written last. An incomplete checkpoint never authorizes GPU handoff.
        write_json(root/'paused.json', dict(step=step, total=len(sigmas)-1, signature=signature,
                                          bytes=(root/'state.pt').stat().st_size, saved=time.time()))
    finally:
        tmp.unlink(missing_ok=True)


@torch.no_grad()
def checkpoint_euler(model, x, sigmas, extra_args=None, callback=None, disable=None, *, root, signature):
    from comfy.k_diffusion.sampling import to_d
    from comfy.model_management import throw_exception_if_processing_interrupted
    extra_args = {} if extra_args is None else extra_args
    step = 0
    saved = root/'state.pt'
    if saved.exists():
        state = torch.load(saved, map_location='cpu', weights_only=True)
        if (state.get('version') != 1 or state.get('signature') != signature
                or state.get('seed') != extra_args.get('seed')
                or state['x'].shape != x.shape or state['x'].dtype != x.dtype
                or not torch.equal(state['sigmas'], sigmas.cpu())
                or not 0 <= state['step'] < len(sigmas)-1):
            raise ValueError('Video checkpoint does not match this workflow. It has been kept; refusing to restart from noise.')
        x = state['x'].to(device=x.device)
        step = state['step']
        del state
    s_in = x.new_ones([x.shape[0]])
    for i in range(step, len(sigmas)-1):
        throw_exception_if_processing_interrupted()
        requested = read(root/'request.json')
        if 0 <= time.time()-requested.get('updated', 0) < 15:
            try:
                save(root, x, sigmas, i, signature, extra_args.get('seed'))
            except OSError as error:
                # Failed save: keep rendering. Never discard the only live state.
                try:
                    write_json(root/'warning.json', dict(error=str(error), updated=time.time()))
                except OSError:
                    pass
            else:
                raise ComfyBridgeCheckpointPaused('Video checkpoint saved; waiting for chat GPU handoff.')
        denoised = model(x, sigmas[i]*s_in, **extra_args)
        d = to_d(x, sigmas[i], denoised)
        if callback is not None:
            callback(dict(x=x, i=i, sigma=sigmas[i], sigma_hat=sigmas[i], denoised=denoised))
        x = x + d*(sigmas[i+1]-sigmas[i])
    return x


class ComfyBridgeCheckpointEuler:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'job_id': ('STRING',), 'signature': ('STRING',)}}
    RETURN_TYPES = ('SAMPLER',)
    FUNCTION = 'build'
    CATEGORY = 'ComfyBridge/video'

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float('nan')

    def build(self, job_id, signature):
        import comfy.samplers
        root = Path(os.environ.get('COMFYBRIDGE_DATA', str(Path(os.environ['LOCALAPPDATA'])/'ComfyBridge')))
        root = root/'checkpoints'/str(uuid.UUID(job_id))
        if len(signature) != 64 or any(c not in '0123456789abcdef' for c in signature):
            raise ValueError('Invalid video checkpoint signature')
        return (comfy.samplers.KSAMPLER(checkpoint_euler, extra_options=dict(root=root, signature=signature)),)


NODE_CLASS_MAPPINGS = {'ComfyBridgeCheckpointEuler': ComfyBridgeCheckpointEuler}
NODE_DISPLAY_NAME_MAPPINGS = {'ComfyBridgeCheckpointEuler': 'ComfyBridge Resumable Euler'}
