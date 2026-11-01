"""Explicit adapters for the user's Image gen / Video gen workflows."""
import json
import math
from pathlib import Path
from extension import GUIDE_FRAMES, guide_names


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
                              positive=v[0], negative='', scale=0, batch=1,
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
            extension = s.get('extension')
            if not extension and not s.get('upload'):
                raise ValueError('Choose a starting image for video.')
            frames = 5 + 17 * max(0, math.ceil((int(s['frames']) - 5)/17))
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
            else:
                image = node(1, 'LoadImage', image=s['upload'])
            image = node(2, 'CUDNNToggleAMD', any_input=image, enable_cudnn=False)
            c = self.widgets('video', 3)
            clip = node(3, 'CLIPLoader', clip_name=c[0], type=c[1], device=c[2])
            vae = node(4, 'VAELoader', vae_name=self.widgets('video', 4)[0])
            u = self.widgets('video', 5)
            model = node(5, 'UNETLoader', unet_name=u[0], weight_dtype=u[1])
            mandatory = self.widgets('video', 8)
            if not loras or loras[0].get('name') != mandatory[0] or not loras[0].get('enabled', True):
                raise ValueError('The MiniMax turbo LoRA is required in the first slot.')
            for i, l in enumerate(loras):
                if l.get('enabled', True):
                    fixed = mandatory[1] if recorded_video_strength is None else recorded_video_strength
                    strength = fixed if i == 0 else l['strength']
                    model = node(100+i, 'LoraLoaderModelOnly', model=model, lora_name=l['name'], strength_model=float(strength))
            first_frame = {} if extension else {'first_frame':image}
            cond = node(6, 'MiniMaxH3ImageToVideo', clip=clip, vae=vae, prompt=s.get('positive', ''), width=width, height=height, length=frames, **first_frame)
            if extension:
                cond = node(50, 'MiniMaxH3AddGuide', positive=cond, latent=['6',1], vae=vae, image=image, frame_idx=0)
            guider = node(9, 'BasicGuider', model=model, conditioning=cond)
            sampler = node(10, 'KSamplerSelect', sampler_name=self.widgets('video', 10)[0])
            noise = node(11, 'RandomNoise', noise_seed=seed)
            sigmas = node(12, 'BasicScheduler', model=model, scheduler='simple', steps=steps, denoise=1.)
            latent = node(13, 'SamplerCustomAdvanced', noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=['6', 1])
            images = node(14, 'VAEDecode', samples=latent, vae=vae)
            if extension:
                images = node(51, 'ImageFromBatch', image=images, batch_index=GUIDE_FRAMES, length=extra)
            video = node(15, 'CreateVideo', images=images, fps=fps, bit_depth='auto', color_space='sRGB', codec='none')
            node(16, 'SaveVideo', video=video, filename_prefix=prefix, format='mp4', **{'format.codec': 'h264', 'format.codec.encoding': 'auto'})
        else:
            raise ValueError('Unknown generation type.')
        return g
