"""Image-family boundaries and the native Krea 2 Turbo graph."""
import json
import re
from functools import lru_cache
from pathlib import Path

KREA_MODEL = 'krea2_turbo_bf16.safetensors'
HOMOFIDELIS_BF16 = 'HomoFidelis_Krea2_Turbo_BF16_v1.safetensors'
KREA_MODELS = {KREA_MODEL: 'Krea 2 Turbo · BF16', HOMOFIDELIS_BF16: 'HomoFidelis Krea 2 Turbo · BF16'}
KREA_ENCODER = 'qwen3vl_4b_bf16.safetensors'
KREA_VAE = 'qwen_image_vae.safetensors'
KREA_DEFAULTS = dict(model=KREA_MODEL, width=1024, height=1024, steps=8, cfg=1,
                     sampler='euler', scheduler='simple', seed='1', increment=True,
                     denoise=1, positive='', negative='', loras=[], scale=0, batch=1)

def family(text):
    text = str(text or '').lower()
    if re.search(r'krea[ _-]?2', text): return 'krea2'
    if re.search(r'sdxl|sdxl_base|sd xl|pony|illustrious|noob|animagine|stable-diffusion-xl', text): return 'sdxl'
    if re.search(r'minimax|h3|eros', text): return 'h3'
    if 'wan' in text: return 'wan'
    if 'flux' in text: return 'flux'
    if re.search(r'sd[ _.-]?1[._ -]|stable.diffusion.v1', text): return 'sd1'
    if re.search(r'sd[ _.-]?2[._ -]|stable.diffusion.v2', text): return 'sd2'
    return ''

@lru_cache(maxsize=2048)
def _file_family(path, size, modified):
    try:
        with open(path, 'rb') as source:
            length = int.from_bytes(source.read(8), 'little')
            if length > 32*1024*1024: return ''
            header = json.loads(source.read(length))
        meta = header.get('__metadata__', {})
        declared = family(' '.join(str(meta.get(k,'')) for k in
            ('ss_base_model_version','modelspec.architecture','base_model','base_model_version')))
        if declared: return declared
        keys = ' '.join(header)
        if 'txtfusion' in keys: return 'krea2'
        if 'lora_te2_' in keys or ('clip_g' in header and 'clip_l' in header): return 'sdxl'
    except (OSError, ValueError, TypeError): pass
    return ''

def resource_family(root, item):
    declared = family(item.get('baseModel')) or family(item.get('encoderFamily'))
    if declared: return declared
    path = (Path(root)/'models'/str(item.get('kind',''))/str(item.get('name',''))).resolve()
    if path.is_relative_to((Path(root)/'models').resolve()) and path.suffix.lower()=='.safetensors':
        try:
            stat = path.stat()
            declared = _file_family(str(path),stat.st_size,stat.st_mtime_ns)
        except OSError: pass
    # Named official Krea files have an explicit family even before indexing.
    return declared or family(item.get('name'))

def compatible(target, item_family):
    # Unknown resources are not offered as compatible. Existing saved settings
    # remain untouched; callers validate known cross-family mismatches as well.
    return bool(target and item_family and target == item_family)

def profile(obj, choices, model=KREA_MODEL):
    required = ('UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode',
                'ConditioningZeroOut','EmptyLatentImage','KSampler','VAEDecode','SaveImage')
    missing = [node for node in required if node not in obj]
    for node, field, value in (('UNETLoader','unet_name',model),
                               ('CLIPLoader','clip_name',KREA_ENCODER),
                               ('CLIPLoader','type','krea2'),('VAELoader','vae_name',KREA_VAE)):
        if node not in obj or value not in choices(node,field): missing.append(value)
    return dict(model=model,label=KREA_MODELS[model],family='krea2',
                defaults={**KREA_DEFAULTS, 'model': model},missing=missing)

def normalize(settings):
    if settings.get('model') not in KREA_MODELS: return
    if re.search(r'\bembedding\s*:', settings.get('positive',''), re.I):
        raise ValueError('SDXL textual inversions cannot be used by the Krea 2 text encoder.')
    settings.update(steps=8,cfg=1,sampler='euler',scheduler='simple',negative='')
    settings.pop('clipSkip',None)

def build(settings, prefix):
    s = dict(settings)
    normalize(s)
    width,height = int(s['width']),int(s['height'])
    if width%16 or height%16 or not (256<=width<=2048 and 256<=height<=2048):
        raise ValueError('Krea 2 dimensions must be multiples of 16 between 256 and 2048.')
    g = {}
    def node(id, cls, **inputs):
        g[str(id)] = dict(class_type=cls,inputs=inputs)
        return [str(id),0]
    model = node(4,'UNETLoader',unet_name=s['model'],weight_dtype='default')
    clip = node(18,'CLIPLoader',clip_name=KREA_ENCODER,type='krea2',device='default')
    for i,lora in enumerate(s.get('loras',[])):
        if lora.get('enabled',True):
            model = node(100+i,'LoraLoaderModelOnly',model=model,lora_name=lora['name'],strength_model=float(lora['strength']))
    vae = node(19,'VAELoader',vae_name=KREA_VAE)
    pos = node(6,'CLIPTextEncode',clip=clip,text=s.get('positive',''))
    neg = node(7,'ConditioningZeroOut',conditioning=pos)
    if s.get('upload'):
        image = node(21,'LoadImage',image=s['upload'])
        image = node(50,'ImageScale',image=image,upscale_method='lanczos',width=width,height=height,crop='disabled')
        if s.get('mask'):
            mask = node(40,'LoadImage',image=s['mask'])
            mask = node(51,'ImageScale',image=mask,upscale_method='nearest-exact',width=width,height=height,crop='disabled')
            mask = node(52,'ImageToMask',image=mask,channel='red')
            latent = node(43,'VAEEncodeForInpaint',pixels=image,vae=vae,mask=mask,grow_mask_by=6)
        else:
            latent = node(22,'VAEEncode',pixels=image,vae=vae)
        denoise = float(s.get('denoise',1))
    else:
        latent = node(5,'EmptyLatentImage',width=width,height=height,batch_size=1)
        denoise = 1
    if not 0<denoise<=1: raise ValueError('Krea 2 denoise must be greater than zero and at most 1.')
    latent = node(3,'KSampler',model=model,positive=pos,negative=neg,latent_image=latent,
                  seed=int(s['seed']),steps=8,cfg=1,sampler_name='euler',scheduler='simple',denoise=denoise)
    image = node(8,'VAEDecode',samples=latent,vae=vae)
    node(9,'SaveImage',images=image,filename_prefix=prefix)
    return g
