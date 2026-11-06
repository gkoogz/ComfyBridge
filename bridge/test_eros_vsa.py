"""Compare the ZLUDA-compatible routing with Comfy Kitchen's eager reference."""
import unittest
import torch
from comfy_kitchen.backends.eager.sol_attn import sol_attn
from comfybridge_eros_vsa import tiled_vsa


class ErosSparseTests(unittest.TestCase):
    def test_cancellation_is_checked_inside_attention_not_only_between_steps(self):
        q=torch.zeros(1,1,128,8)
        plan=dict(src=torch.arange(128),inv=torch.arange(128),block_len=torch.tensor([64,64]),n_prefix=1)
        calls=[]
        def stop():
            calls.append(1)
            if len(calls)==3:raise InterruptedError('requested cancellation')
        with self.assertRaises(InterruptedError):
            tiled_vsa(q,q,q,plan,check_interrupt=stop)
        self.assertEqual(len(calls),3)

    def test_partial_tiles_exact_prefix_diagonal_ties_and_multiple_heads(self):
        torch.manual_seed(17)
        lengths=torch.tensor([13,64,54,64,21,64,64,32,64,19,64,64],dtype=torch.int32)
        size=int(lengths.sum())
        original=torch.randperm(size)
        indices=torch.full((len(lengths),64),-1,dtype=torch.long)
        pos=0
        for i,n in enumerate(lengths.tolist()):
            indices[i,:n]=original[pos:pos+n];pos+=n
        src=indices.flatten();inv=torch.empty(size,dtype=torch.long)
        inv[src[src>=0]]=torch.where(src>=0)[0]
        plan=dict(src=src,inv=inv,block_len=lengths,n_prefix=1)
        q,k,v=[torch.randn(1,5,size,128) for _ in range(3)]
        for tied in (False,True):
            if tied:k.zero_()
            padded=[x[:,:,src.clamp_min(0)].transpose(1,2) for x in (q,k,v)]
            expected=sol_attn(*padded,topk_ratio=.1,tail=False,block_len=lengths,
                              sink_blocks=[0,1],sink_q=[0,1])[:,inv].transpose(1,2)
            actual=tiled_vsa(q,k,v,plan)
            torch.testing.assert_close(actual,expected,rtol=1e-4,atol=2e-5)
