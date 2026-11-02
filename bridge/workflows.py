"""Explicit adapters for the user's Image gen / Video gen workflows."""
import json
import math
from pathlib import Path
from extension import GUIDE_FRAMES, guide_names

EROS_BETA7 = '10Eros_Max_h3_8stepTURBO_beta7_int8HQ.safetensors'
H3_AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'


class Workflows:
    def __init__(self, root):
        self.root = Path(root)
        self.image = self.read('Image gen.json')
        self.video = self.read('Video gen.json')

    def read(self, name):
        doc = json.loads((self.root / 'user/default/workflows' / name).read_text(encoding='utf-8'))
        return {str(n['id']): n for n in doc['nodes']}

    def widgets(self, kind, node):
        return (self.image if kind == 'image' else self.video)[str(node)].get('widgets_values', [])

    def video_models(self, nodes, unets, clips, vaes, loras):
        base=self.widgets('video',5)[0]
        clip=self.widgets('video',3)[0]
        vae=self.widgets('video',4)[0]
        required=self.widgets('video',8)[0]
        profiles=[]
        for name,label,steps in [(base,'MiniMax H3 · Original',4),(EROS_BETA7,'10Eros Max · Beta 7',8)]:
            builtin=name==EROS_BETA7
            dependencies=[(name,unets),(clip,clips),(vae,vaes)]
            if builtin:
                dependencies.extend((node,nodes) for node in ('MiniMaxH3SigmaShift','BlockSparseAttention','ComfyBridgeErosVSA'))
            else:
                dependencies.append((required,loras))
            missing=[item for item,available in dependencies if item not in available]
            profiles.append(dict(model=name,label=label,steps=steps,builtinTurbo=builtin,missing=missing))
        return profiles

    def defaults(self):
        k = self.widgets('image', 3)
        # Keep graph order, including disabled entries. Single user strength controls both outputs
        # after editing; an untouched entry preserves the saved CLIP strength.
        order = [44, 45, 14, 13, 12, 11, 15, 16, 17, 10]
        loras = []
        for i in order:
            n = self.image[str(i)]; v = n['widgets_values']
            loras.append(dict(name=v[0], strength=v[1], clipStrength=v[2], enabled=n.get('mode', 0) == 0))
        v = self.widgets('video', 6)
        return {'image': dict(model=self.widgets('image', 4)[0], width=1024, height=1536,
                             steps=k[2], cfg=k[3], seed=str(k[0]), increment=True, denoise=1,
                             positive=self.widgets('image', 6)[0], negative=self.widgets('image', 7)[0],
                             loras=loras, scale=0, batch=1),
                'video': dict(model=self.widgets('video', 5)[0], width=v[1], height=v[2],
                              frames=v[3], fps=self.widgets('video', 15)[0], steps=4, cfg=1,
                              seed=str(self.widgets('video', 11)[0]), increment=True, denoise=1,
                              positive=v[0], negative='', scale=0, batch=1, sound=True,
                              loras=[dict(name=self.widgets('video', 8)[0], strength=self.widgets('video', 8)[1], enabled=True, locked=True)]),
                'notices': ['Video gen.json has an invalid numeric scheduler (4) and steps=1. The bridge uses simple / 4 steps for the saved turbo LoRA. The original file is unchanged.',
                            'MiniMax H3 rounds frame count up to 17k+5. Duration uses the actual frame count / FPS.']}

    def build(self, kind, s, prefix, *, recorded_video_strength=None):
        g = {}
        def node(id, class_type, **inputs):
            g[str(id)] = {'class_type': class_type, 'inputs': inputs}
            return [str(id), 0]
        width, height = int(s['width']), int(s['height'])
        if not 32 <= width <= 8192 or not 32 <= height <= 8192:
            raise ValueError('Resolution must be between 32 and 8192 pixels per side.')
        seed = int(s['seed'])
        if not 0 <= seed <= 18446744073709551615:
            raise ValueError('Seed must be an unsigned 64-bit integer.')
        steps = int(s['steps'])
        if not 1 <= steps <= 150:
            raise ValueError('Steps must be 1–150.')
        loras = s.get('loras', [])
        if len(loras) > 100:
            raise ValueError('At most 100 LoRAs can be used in one job.')
        if kind == 'image':
            node(4, 'CheckpointLoaderSimple', ckpt_name=s['model'])
            model, clip = ['4', 0], ['4', 1]
            clip = node(18, 'CLIPSetLastLayer', clip=clip, stop_at_clip_layer=self.widgets('image', 18)[0])
            for i, l in enumerate(loras):
                if l.get('enabled', True):
                    strength = float(l['strength'])
                    model = node(100+i, 'LoraLoader', model=model, clip=clip, lora_name=l['name'],
                                 strength_model=strength, strength_clip=float(l.get('clipStrength', strength)))
                    clip = [str(100+i), 1]
            vae = node(19, 'VAELoader', vae_name=self.widgets('image', 19)[0])
            pos = node(6, 'CLIPTextEncode', clip=clip, text=s.get('positive', ''))
            neg = node(7, 'CLIPTextEncode', clip=clip, text=s.get('negative', ''))
            if s.get('upload'):
                img = node(21, 'LoadImage', image=s['upload'])
                img = node(50, 'ImageScale', image=img, upscale_method='lanczos', width=width, height=height, crop='disabled')
                if s.get('mask'):
                    mask_img = node(40, 'LoadImage', image=s['mask'])
                    mask_img = node(51, 'ImageScale', image=mask_img, upscale_method='nearest-exact', width=width, height=height, crop='disabled')
                    mask = node(52, 'ImageToMask', image=mask_img, channel='red')
                    latent = node(43, 'VAEEncodeForInpaint', pixels=img, vae=['4', 2], mask=mask, grow_mask_by=self.widgets('image', 43)[0])
                else:
                    latent = node(22, 'VAEEncode', pixels=img, vae=['4', 2])
                denoise = float(s.get('denoise', 1))
            else:
                latent = node(5, 'EmptyLatentImage', width=width, height=height, batch_size=1)
                denoise = 1
            if not 0 <= denoise <= 1:
                raise ValueError('Denoise must be between 0 and 1.')
            sampler = self.widgets('image', 3)
            latent = node(3, 'KSampler', model=model, positive=pos, negative=neg, latent_image=latent,
                          seed=seed, steps=steps, cfg=float(s['cfg']), sampler_name=sampler[4], scheduler=sampler[5], denoise=denoise)
            image = node(8, 'VAEDecode', samples=latent, vae=vae)
            node(9, 'SaveImage', images=image, filename_prefix=prefix)
        elif kind == 'video':
            base_model=self.widgets('video',5)[0]
            checkpoint=s.get('model') or base_model
            if checkpoint not in (base_model,EROS_BETA7):
                raise ValueError('Choose an installed H3 video model.')
            eros=checkpoint==EROS_BETA7
            extension = s.get('extension')
            text_only = not extension and not s.get('upload')
            if text_only and (width % 32 or height % 32):
                raise ValueError('Video width and height must be multiples of 32.')
            frames = 5 + 17 * max(0, math.ceil((int(s['frames']) - 5)/17))
            if s.get('exactFrames') and not 1<=int(s['frames'])<=3592:
                raise ValueError('Choose 1–3592 output frames.')
            fps = float(s['fps'])
            if not 5 <= frames <= 3600 or not 1 <= fps <= 120:
                raise ValueError('Frames must be 5–3592; FPS must be 1–120.')
            if extension:
                extra = int(s['frames'])
                if not 1 <= extra <= 3570:
                    raise ValueError('Choose 1–3570 additional frames.')
                frames = GUIDE_FRAMES + 17 * math.ceil(extra/17)
                names = guide_names(prefix.rsplit('/',1)[-1])
                image = node(1, 'LoadImage', image=names[0])
                for i, name in enumerate(names[1:]):
                    frame = node(30+i, 'LoadImage', image=name)
                    image = node(40+i, 'ImageBatch', image1=image, image2=frame)
            elif not text_only:
                image = node(1, 'LoadImage', image=s['upload'])
            if not text_only:
                image = node(2, 'CUDNNToggleAMD', any_input=image, enable_cudnn=False)
            c = self.widgets('video', 3)
            clip = node(3, 'CLIPLoader', clip_name=c[0], type=c[1], device=c[2])
            if text_only:
                clip = node(2, 'CUDNNToggleAMD', any_input=clip, enable_cudnn=False)
            vae = node(4, 'VAELoader', vae_name=self.widgets('video', 4)[0])
            u = self.widgets('video', 5)
            model = node(5, 'UNETLoader', unet_name=checkpoint, weight_dtype=u[1])
            mandatory = self.widgets('video', 8)
            if not eros and (not loras or loras[0].get('name') != mandatory[0] or not loras[0].get('enabled', True)):
                raise ValueError('The MiniMax turbo LoRA is required in the first slot.')
            for i, l in enumerate(loras):
                if eros and l['name']==mandatory[0]:
                    continue
                if l.get('enabled', True):
                    fixed = mandatory[1] if recorded_video_strength is None else recorded_video_strength
                    strength = fixed if i == 0 and not eros else l['strength']
                    model = node(100+i, 'LoraLoaderModelOnly', model=model, lora_name=l['name'], strength_model=float(strength))
            if eros:
                model=node(27,'MiniMaxH3SigmaShift',model=model,shift_video=12.,shift_audio=3.)
                model=node(28,'ComfyBridgeErosVSA',model=model,min_tokens=12288)
            first_frame = {'first_frame':image} if not extension and not text_only else {}
            def h3_condition(text, encode_id, guide_id):
                condition = node(encode_id, 'MiniMaxH3ImageToVideo', clip=clip, vae=vae,
                                 prompt=text, width=width, height=height, length=frames, **first_frame)
                if extension:
                    condition = node(guide_id, 'MiniMaxH3AddGuide', positive=condition, latent=['6',1],
                                     vae=vae, image=image, frame_idx=0)
                return condition

            cond = h3_condition(s.get('positive', ''), 6, 50)
            negative = (s.get('negative') or '').strip()
            if negative:
                # Give both passes the same visual reference so CFG contrasts the text alone.
                avoid = h3_condition(negative, 55, 56)
                guider = node(9, 'CFGGuider', model=model, positive=cond, negative=avoid, cfg=2.0)
            else:
                guider = node(9, 'BasicGuider', model=model, conditioning=cond)
            sampler = node(10, 'KSamplerSelect', sampler_name='euler' if eros else self.widgets('video', 10)[0])
            noise = node(11, 'RandomNoise', noise_seed=seed)
            sigmas = node(12, 'BasicScheduler', model=model, scheduler='simple', steps=steps, denoise=1.)
            latent = node(13, 'SamplerCustomAdvanced', noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=['6', 1])
            images = node(14, 'VAEDecode', samples=latent, vae=vae)
            if extension:
                images = node(51, 'ImageFromBatch', image=images, batch_index=GUIDE_FRAMES, length=extra)
            elif s.get('exactFrames') and int(s['frames'])!=frames:
                images = node(51, 'ImageFromBatch', image=images, batch_index=0, length=int(s['frames']))
            soundtrack = {}
            if s.get('sound'):
                avae = node(52, 'VAELoader', vae_name=H3_AUDIO_VAE)
                # This decoder accepts H3's nested stereo latent and uses the VAE's own sample rate.
                audio = node(53, 'LTXVAudioVAEDecode', samples=latent, audio_vae=avae)
                count = int(s['frames']) if extension or s.get('exactFrames') else frames
                # Crop on H3's native clock before the muxer can truncate either stream.
                soundtrack['audio'] = node(54, 'TrimAudioDuration', audio=audio,
                    start_index=(GUIDE_FRAMES if extension else 0)/24, duration=count/24)
            video = node(15, 'CreateVideo', images=images, fps=24 if soundtrack else fps,
                         bit_depth='auto', color_space='sRGB', codec='none', **soundtrack)
            node(16, 'SaveVideo', video=video, filename_prefix=prefix, format='mp4', **{'format.codec': 'h264', 'format.codec.encoding': 'auto'})
        else:
            raise ValueError('Unknown generation type.')
        return g
