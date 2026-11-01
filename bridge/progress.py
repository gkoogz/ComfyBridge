"""Estimate elapsed work from the submitted graph, not Comfy's last node percentage."""
import math
import time


class Progress:
    def __init__(self, kind, graph, settings, clock=time.monotonic, learned=None):
        self.clock, self.kind = clock, kind
        self.steps = int(settings['steps'])
        pixels = max(.1, settings['width'] * settings['height'] / 1048576)
        frames = settings.get('frames', 1) if kind == 'video' else 1
        specs = {
            'CheckpointLoaderSimple': ('Load checkpoint', 6), 'UNETLoader': ('Load video model', 12),
            'VAELoader': ('Load VAE', 2), 'CLIPLoader': ('Load text encoder', 4),
            'CLIPTextEncode': ('Encode prompt', 2), 'MiniMaxH3ImageToVideo': ('Encode first frame and prompt', 8+pixels*frames*.2),
            'VAEEncode': ('Encode source image', 3*pixels), 'VAEEncodeForInpaint': ('Encode masked image', 4*pixels),
            'KSampler': ('Sample image', self.steps*2*pixels),
            'SamplerCustomAdvanced': ('Sample video', self.steps*2*pixels*frames),
            'VAEDecode': ('Decode video frames' if frames>1 else 'Decode image', 3*pixels*(1+frames*.3)),
            'CreateVideo': ('Assemble frames', 1+frames*.04), 'SaveVideo': ('Encode and save MP4', 2+frames*.15),
            'SaveImage': ('Save image', 1), 'LoraLoader': ('Apply image LoRA', 1),
            'LoraLoaderModelOnly': ('Apply video LoRA', 2), 'LoadImage': ('Read source', .8),
            'ImageScale': ('Scale source', .7), 'ImageToMask': ('Prepare mask', .6),
            'MiniMaxH3AddGuide': ('Encode motion guide', 4*pixels),
            'ImageFromBatch': ('Trim guide and excess frames', .3),
        }
        self.nodes = {str(n):specs.get(v['class_type'],('Prepare inputs', .4)) for n,v in graph.items()}
        self.base=dict(self.nodes)
        self.classes={str(n):v['class_type'] for n,v in graph.items()}
        self.observed={}
        for n,(label,w) in self.base.items():
            self.nodes[n]=(label,w*(learned or {}).get(self.classes[n],1.))
        self.done, self.node, self.value, self.maximum = set(), None, 0, 0
        self.start = self.tick = clock()
        self.last = 0.
        self.label = 'Waiting for ComfyUI'

    def finish(self,n):
        if n not in self.nodes or n in self.done:return
        if n==self.node:
            elapsed=self.clock()-self.start
            if elapsed>.05:self.observed[self.classes[n]]=max(.03,min(60,elapsed/self.base[n][1]))
        self.done.add(n)

    def enter(self, n):
        n = str(n)
        if n not in self.nodes or n in self.done or n == self.node: return
        if self.node: self.finish(self.node)
        self.node, self.start, self.tick = n,self.clock(),self.clock()
        self.value = self.maximum = 0
        self.label = self.nodes[n][0]

    def event(self, event, d):
        if event == 'execution_cached':
            for node in d['nodes']:
                n=str(node)
                if n in self.nodes:self.nodes[n]=(self.nodes[n][0],.01);self.done.add(n)
        elif event == 'executing' and d.get('node') is not None: self.enter(d['node'])
        elif event == 'progress_state':
            for n,s in d.get('nodes', {}).items():
                if s['state']=='finished': self.finish(n)
                elif s['state']=='running': self.step(n,s)
        elif event == 'progress': self.step(d.get('node',self.node),d)
        elif event=='execution_success' or event=='executing' and d.get('node') is None:
            self.finish(self.node);self.node=None;self.done.update(self.nodes);self.label='Indexing output'

    def step(self,n,s):
        self.enter(n)
        if str(n)!=self.node:return
        value,maximum=float(s.get('value',0)),float(s.get('max',0))
        if value>self.value or maximum!=self.maximum:
            self.value,self.maximum,self.tick=value,maximum,self.clock()

    def sample(self):
        work=sum(self.nodes[n][1] for n in self.done)
        label=self.label
        if self.node and self.node not in self.done:
            label,expected=self.nodes[self.node]
            maximum=self.maximum
            sampler=self.classes[self.node] in ('KSampler','SamplerCustomAdvanced')
            if sampler and not self.value and maximum<=1:
                maximum=self.steps
                label+=' · preparing'
            if maximum>0 and (sampler or self.value>0 or maximum>1):
                interval=(self.tick-self.start)/self.value if self.value else expected/maximum
                between=.88*(1-math.exp(-max(0,self.clock()-self.tick)/max(.2,interval)))
                frac=min(.985,(self.value+between)/maximum)
                label+=f' · {int(self.value)}/{int(maximum)}'
            else:
                frac=.84*(1-math.exp(-max(0,self.clock()-self.start)/max(.2,expected)))
            work+=expected*frac
        self.last=max(self.last,min(.99,.99*work/max(.01,sum(w for _,w in self.nodes.values()))))
        return self.last,label
