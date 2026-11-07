"""Check against installed Comfy's real KSAMPLER on CPU; no model weights loaded.
Run with Comfy's Python: checkpoint-installed.py E:/ComfyUI-Zluda
"""
import sys
from pathlib import Path
import tempfile
import types
import uuid
import os
import time
import torch

sys.path.insert(0,sys.argv[1])
import comfy.cli_args
comfy.cli_args.args.cpu=True
import comfy.samplers
import comfy.model_management
assert comfy.model_management.get_torch_device().type=='cpu'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
import comfybridge_checkpoint as cp

sigmas=torch.tensor([1.,.83,.71,.56,.40,.28,.15,.06,0.])
noise=torch.randn((1,1,1,2397),generator=torch.Generator().manual_seed(42))
latent=torch.linspace(-.2,.2,noise.numel()).reshape_as(noise)
class Sampling:
    sigma_max=1.
    def noise_scaling(self,sigma,noise,latent,max_denoise):return noise*sigma+latent*(1-sigma)
    def inverse_noise_scaling(self,sigma,x):return x/(1+sigma)
class Model:
    inner_model=types.SimpleNamespace(model_sampling=Sampling(),model=object())
    model_patcher=types.SimpleNamespace(model=object())
    cfg=1.
    def __call__(self,x,sigma,model_options,seed):
        assert torch.equal(model_options['transformer_options']['sample_sigmas'],sigmas)
        assert seed==42
        return torch.tanh(x*.13+sigma.view(-1,1,1,1)*.07)
model=Model()
def sample(sampler,callback=None):
    return sampler.sample(model,sigmas,dict(seed=42,model_options=dict(transformer_options=dict(sample_sigmas=sigmas))),
                          callback,noise,latent_image=latent,disable_pbar=True)
expected=sample(comfy.samplers.ksampler('euler'))
with tempfile.TemporaryDirectory() as folder:
    os.environ['COMFYBRIDGE_DATA']=folder
    job=str(uuid.uuid4());root=Path(folder)/'checkpoints'/job
    sampler=cp.ComfyBridgeCheckpointEuler().build(job,'a'*64)[0]
    assert torch.equal(sample(sampler),expected)
    for boundary in (1,3,6,7):
        def callback(i,*args):
            if i==boundary-1:
                root.mkdir(parents=True,exist_ok=True)
                cp.write_json(root/'request.json',dict(updated=time.time()))
        try:sample(sampler,callback)
        except cp.ComfyBridgeCheckpointPaused:pass
        else:raise AssertionError('Did not pause')
        (root/'request.json').unlink()
        # Build a fresh sampler as Comfy does after unloading/reloading.
        sampler=cp.ComfyBridgeCheckpointEuler().build(job,'a'*64)[0]
    actual=sample(sampler)
    assert torch.equal(expected,actual),float((expected-actual).abs().max())
    print('PASS: installed Comfy KSAMPLER + checkpoint node, four repeated pauses, packed tensor, full sigma schedule, bitwise identical. CPU only.')
