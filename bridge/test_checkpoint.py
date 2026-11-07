"""CPU-only tests. Never initialize Comfy's GPU or touch a real generation."""
import ast
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid

import torch
import comfybridge_checkpoint as cp
import gpu_handoff as gpu


def to_d(x, sigma, denoised):
    return (x-denoised)/sigma


@contextlib.contextmanager
def cpu_comfy():
    modules = {name: types.ModuleType(name) for name in
               ('comfy','comfy.k_diffusion','comfy.k_diffusion.sampling','comfy.model_management')}
    modules['comfy.k_diffusion.sampling'].to_d = to_d
    modules['comfy.model_management'].throw_exception_if_processing_interrupted = lambda: None
    with patch.dict(sys.modules,modules):
        yield


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.sigmas=torch.tensor([1.,.88,.73,.59,.44,.30,.18,.07,0.])
        self.x=torch.randn((1,4,16,16),generator=torch.Generator().manual_seed(123))
        self.signature='a'*64

    def model(self,x,sigma,**kwargs):
        return torch.tanh(x*.17+sigma.reshape(-1,1,1,1)*.11)

    def run_sample(self,callback=None,signature=None):
        with cpu_comfy():
            return cp.checkpoint_euler(self.model,self.x.clone(),self.sigmas,
                dict(seed=123),callback,root=self.root,signature=signature or self.signature)

    def request(self):
        cp.write_json(self.root/'request.json',dict(updated=time.time()))

    def test_every_boundary_roundtrip_matches_uninterrupted_euler(self):
        expected=self.x.clone()
        for i in range(len(self.sigmas)-1):
            expected=expected+to_d(expected,self.sigmas[i],self.model(expected,self.sigmas[i].view(1)))*(self.sigmas[i+1]-self.sigmas[i])
        self.assertTrue(torch.equal(self.run_sample(),expected))
        for boundary in range(1,8):
            def callback(state):
                if state['i']==boundary-1:self.request()
            with self.assertRaises(cp.ComfyBridgeCheckpointPaused):self.run_sample(callback)
            info=json.loads((self.root/'paused.json').read_text())
            self.assertEqual(info['step'],boundary)
            (self.root/'request.json').unlink()
            steps=[]
            result=self.run_sample(lambda state:steps.append(state['i']))
            self.assertEqual(steps,list(range(boundary,8)))
            self.assertTrue(torch.equal(result,expected))
            (self.root/'state.pt').unlink();(self.root/'paused.json').unlink()

    def test_repeated_pause_resume_preserves_packed_audio_video_and_schedule(self):
        # Sampler receives a single packed tensor; both modality regions must survive.
        self.x=torch.cat([self.x.flatten(),torch.linspace(-1,1,357)]).reshape(1,1,1,-1)
        expected=self.run_sample()
        for boundary in (2,5,7):
            def callback(state):
                if state['i']==boundary-1:self.request()
            with self.assertRaises(cp.ComfyBridgeCheckpointPaused):self.run_sample(callback)
            (self.root/'request.json').unlink()
        self.assertTrue(torch.equal(self.run_sample(),expected))

    def test_disk_failure_continues_without_pausing(self):
        expected=self.run_sample();self.request()
        with patch.object(cp.shutil,'disk_usage',return_value=types.SimpleNamespace(free=0)):
            self.assertTrue(torch.equal(self.run_sample(),expected))
        self.assertFalse((self.root/'paused.json').exists())
        self.assertTrue((self.root/'warning.json').exists())

    def test_workflow_mismatch_and_corruption_never_restart_from_noise(self):
        self.request()
        with self.assertRaises(cp.ComfyBridgeCheckpointPaused):self.run_sample()
        (self.root/'request.json').unlink()
        with self.assertRaisesRegex(ValueError,'does not match'):self.run_sample(signature='b'*64)
        self.assertTrue((self.root/'state.pt').exists())
        (self.root/'state.pt').write_bytes(b'corrupt')
        with self.assertRaises(Exception):self.run_sample()

    def test_expired_request_does_not_pause(self):
        cp.write_json(self.root/'request.json',dict(updated=time.time()-30))
        self.run_sample()
        self.assertFalse((self.root/'state.pt').exists())


class HandoffTests(unittest.TestCase):
    def test_lease_is_bound_to_reply_and_expires(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder);gpu.grant(data,'one')
            self.assertTrue(gpu.granted(data,'one'));self.assertFalse(gpu.granted(data,'two'))
            with patch.object(gpu.time,'time',return_value=time.time()+20):
                self.assertFalse(gpu.granted(data,'one'))
            gpu.revoke(data);self.assertFalse(gpu.granted(data,'one'))

    def test_only_euler_h3_is_wrapped_and_replay_has_own_storage(self):
        graph={'6':dict(class_type='MiniMaxH3ImageToVideo',inputs={}),
               '10':dict(class_type='KSamplerSelect',inputs=dict(sampler_name='euler'))}
        a,b=str(uuid.uuid4()),str(uuid.uuid4())
        wrapped=gpu.resumable_graph(graph,a)
        self.assertTrue(gpu.supports_pause(wrapped))
        replay=gpu.resumable_graph(wrapped,b)
        self.assertEqual(replay['10']['inputs']['job_id'],b)
        self.assertEqual(graph['10']['class_type'],'KSamplerSelect')
        graph['10']['inputs']['sampler_name']='euler_ancestral'
        self.assertFalse(gpu.supports_pause(gpu.resumable_graph(graph,a)))
        with self.assertRaises(ValueError):gpu.folder(Path('.'),'../elsewhere')

    def test_changed_model_or_source_refuses_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'input').mkdir();(root/'input/source.png').write_bytes(b'original')
            graph={'1':dict(class_type='LoadImage',inputs=dict(image='source.png'))}
            job=str(uuid.uuid4());gpu.check_assets(root,job,root,graph)
            gpu.check_assets(root,job,root,graph)
            (root/'input/source.png').write_bytes(b'changed contents')
            with self.assertRaisesRegex(ValueError,'changed'):gpu.check_assets(root,job,root,graph)


if __name__=='__main__':unittest.main()
