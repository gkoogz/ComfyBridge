"""ComfyBridge's Eros beta 7 VSA patch. Only attaches to the selected H3 model."""
import logging
import torch


def _attention(query, key, value, scale, valid=None):
    scores=torch.matmul(query*scale,key.transpose(-1,-2))
    if valid is not None:
        scores.masked_fill_(~valid.unsqueeze(-2),float('-inf'))
    weights=scores.softmax(dim=-1,dtype=torch.float32).to(value.dtype)
    return torch.matmul(weights,value)


def tiled_vsa(q,k,v,plan,keep=.1):
    """Exact prefix attention and per-head top-k video cubes, in bounded groups.

    q/k/v are the H3 model's already-normalized, rotary-embedded tensors (1,H,T,D).
    The upstream tile plan maps each 4x4x4 video cube to 64 rows. Never gather
    all heads' selected keys or materialize a token-by-token square score matrix.
    """
    if q.ndim!=4 or q.shape[0]!=1 or q.shape!=k.shape or k.shape!=v.shape:
        raise ValueError('H3 tiled attention requires one packed sequence of matching Q/K/V tensors.')
    index=plan['src'].reshape(-1,64)
    valid=index>=0
    safe=index.clamp_min(0)
    lengths=plan['block_len'].clamp_min(1)
    prefix=plan['n_prefix']
    count=index.shape[0]
    videos=count-prefix
    width=q.shape[-1]
    scale=width**-.5
    output=torch.empty_like(q)
    # Match comfy_kitchen's eager reference, including ties at the top-k boundary.
    top=max(0,min(videos-1,max(1,round(keep*videos))))
    video_ids=torch.arange(prefix,count,device=q.device)
    neighbors=(video_ids[:,None]-video_ids).abs()<=1
    for start in range(0,q.shape[1],4):
        qh,kh,vh=[x[0,start:start+4] for x in (q,k,v)]
        heads=qh.shape[0]
        qt,kt,vt=[x[:,safe] for x in (qh,kh,vh)]
        def centers(tiles):
            return (tiles*valid[None,:,:,None]).sum(dim=2,dtype=torch.float32)/lengths[:,None]
        ranks=centers(qt)[:,prefix:] @ centers(kt)[:,prefix:].transpose(-1,-2)
        mask=neighbors.expand(heads,-1,-1)
        if top:
            mask=mask | (ranks>=ranks.topk(top,dim=-1).values[...,-1:])
        mask=torch.cat([torch.ones(heads,videos,prefix,device=q.device,dtype=torch.bool),mask],dim=-1)
        nkeep=int(mask.sum(dim=-1).max().item())
        # topk on this boolean mask produces unique tile IDs; mask padded slots below.
        chosen=mask.to(torch.float32).topk(nkeep,dim=-1).indices
        out=torch.empty_like(qt)
        for tile in range(prefix):
            out[:,tile]=_attention(qt[:,tile],kh,vh,scale)
        batch=max(1,min(8,4194304//(heads*nkeep*64*width)))
        head_index=torch.arange(heads,device=q.device)[:,None,None]
        for first in range(0,videos,batch):
            last=min(first+batch,videos)
            ids=chosen[:,first:last]
            live=mask[:,first:last].gather(-1,ids)[...,None] & valid[ids]
            keys=kt[head_index,ids].flatten(2,3)
            values=vt[head_index,ids].flatten(2,3)
            span=slice(prefix+first,prefix+last)
            out[:,span]=_attention(qt[:,span],keys,values,scale,live.flatten(2,3))
        output[0,start:start+heads]=out.flatten(1,2)[:,plan['inv']]
    return output


class ComfyBridgeErosVSA:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'model':('MODEL',),'min_tokens':('INT',{'default':12288,'min':1,'max':1000000})}}
    RETURN_TYPES=('MODEL',)
    FUNCTION='apply'
    CATEGORY='ComfyBridge/video'

    def apply(self,model,min_tokens):
        from comfy_extras.nodes_sparse_attention import SparseAttnPatch,apply_block_sparse_attention
        from comfy.patcher_extension import CallbacksMP
        import comfy.model_management as mm
        device=mm.get_torch_device()
        params=dict(tau=1.3,topk_ratio=.1,vsa=True,min_tokens=min_tokens,dense_blocks={0,1},
                    sink_conditioning='exact_kv_and_rows',extra_tokens=0,verbose=False)
        if device.type=='cuda' and 'ZLUDA' not in torch.cuda.get_device_name(device).upper():
            return (apply_block_sparse_attention(model,start_percent=0.,end_percent=1.,**params),)
        patched=model.clone()
        patch=SparseAttnPatch(sigma_start=float('inf'),sigma_end=0.,**params)
        diffusion=patched.get_model_object('diffusion_model')
        # ZLUDA advertises INT8 matmul, but cuBLASLt rejects H3's projection shapes.
        # Comfy's weight-only path unrotates/dequantizes each layer for floating-point
        # compute. Object patches belong to this clone and are restored on unload.
        converted=0
        for name,layer in diffusion.named_modules():
            if getattr(layer,'quant_format',None)=='int8_tensorwise':
                patched.add_object_patch(f'diffusion_model.{name}._full_precision_mm',True)
                converted+=1
        if converted:
            logging.info('ComfyBridge Eros: floating-point compute for %d INT8 projections',converted)
        blocks=diffusion.blocks
        if any(block.attn.to_gate_compress is not None for block in blocks):
            raise ValueError('This portable VSA profile requires the ungated Eros beta 7 checkpoint.')
        def sparse(func,q,k,v,heads,**kwargs):
            options=kwargs['transformer_options']
            layout=options.get('minimax_h3_layout')
            if layout is None or q.ndim!=4 or q.shape[0]!=1 or q.shape[2]!=layout.seq_len or kwargs.get('mask') is not None:
                return func(q,k,v,heads,**kwargs)
            result=tiled_vsa(q,k,v,patch.vsa_plan(layout,q.device))
            return result if kwargs.get('skip_output_reshape') else result.transpose(1,2).reshape(1,q.shape[2],-1)
        def patch_block(args,extra):
            options=args['transformer_options']
            if args['img'].shape[0]>=min_tokens:
                # Override only the attention call in this model's selected block.
                args={**args,'transformer_options':{**options,'optimized_attention_override':sparse}}
            return extra['original_block'](args)
        for i in range(2,len(blocks)):
            patched.set_model_patch_replace(patch_block,'dit','double_block',i)
        patched.add_callback_with_key(CallbacksMP.ON_CLEANUP,'comfybridge_eros_vsa',lambda p:patch.reset())
        return (patched,)


NODE_CLASS_MAPPINGS={'ComfyBridgeErosVSA':ComfyBridgeErosVSA}
NODE_DISPLAY_NAME_MAPPINGS={'ComfyBridgeErosVSA':'Eros Max Video Sparse Attention'}
