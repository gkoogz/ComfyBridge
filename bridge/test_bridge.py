"""Integration tests with an isolated store and simulated ComfyUI; no GPU work."""
import asyncio
import base64
import copy
import hashlib
import io
import logging
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
import atexit

from aiohttp import web, ClientSession
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

TEMP = tempfile.TemporaryDirectory()
os.environ['COMFYBRIDGE_DATA'] = TEMP.name
Path(TEMP.name, 'token.txt').write_text('integration-test-key')
import worker as w
atexit.register(w.DB.close)
atexit.register(logging.shutdown)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        w.DB.execute('DELETE FROM media'); w.DB.execute('DELETE FROM jobs'); w.DB.commit()
        w.ROOT = Path(TEMP.name)/'comfy'; (w.ROOT/'input/ComfyBridge').mkdir(parents=True, exist_ok=True)
        (w.ROOT/'output/ComfyBridge').mkdir(parents=True, exist_ok=True)
        defaults = w.WF.defaults()
        self.settings = copy.deepcopy(defaults['image'])
        self.settings['positive'] = 'A blue ceramic sphere'; self.settings['negative'] = ''
        w.CATALOG = dict(models=[self.settings['model']],loras=[x['name'] for x in self.settings['loras']],defaults=defaults)
        w.STOPPING.clear(); w.ACTIVE=None; w.PREVIEW=None
        self.calls=[]; self.accepted={}; self.history={}; self.complete=True
        self.desktop=['desktop',str(uuid.uuid4()),{},{}]
        async def comfy(path,data=None):
            self.calls.append((path,data))
            if path=='/system_stats':return {}
            if path=='/prompt':
                self.accepted[data['prompt_id']]=data
                if self.complete:
                    if '16' in data['prompt'] and data['prompt']['16']['class_type']=='SaveVideo':
                        filename=data['prompt_id']+'.mp4'
                        args=['-f','lavfi','-i','color=c=blue:s=64x96:r=24']
                        if 'audio' in data['prompt']['15']['inputs']:
                            args+=['-f','lavfi','-i','sine=frequency=440:sample_rate=32000','-c:a','aac']
                        w.extension.ffmpeg(*args,'-t','1','-c:v','libx264',w.ROOT/'output/ComfyBridge'/filename)
                    else:
                        filename=data['prompt_id']+'.png'
                        Image.new('RGB',(48,64),'#58bbcc').save(w.ROOT/'output/ComfyBridge'/filename)
                    self.history[data['prompt_id']]={'status':{'status_str':'success'},'outputs':{'9':{'images':[dict(filename=filename,subfolder='ComfyBridge',type='output')]}}}
                return {'prompt_id':data['prompt_id']}
            if path.startswith('/history/'):
                id=path.split('/')[-1];return {id:self.history[id]} if id in self.history else {}
            if path=='/queue' and data is None:
                return {'queue_running':[self.desktop], 'queue_pending':[[0,k,{},{}] for k in self.accepted if k not in self.history]}
            if path=='/queue' and data:
                for id in data['delete']:self.accepted.pop(id,None)
                return {}
            if path=='/interrupt':return {}
            raise AssertionError(path)
        self.original=w.comfy;w.comfy=comfy
        app=web.Application(middlewares=[w.guard],client_max_size=55*1024*1024)
        app.router.add_route('*','/api/{path:.*}',w.api)
        self.client=TestClient(TestServer(app));await self.client.start_server()
        self.runner=None

    async def asyncTearDown(self):
        if self.runner:
            self.runner.cancel()
            try:await self.runner
            except asyncio.CancelledError:pass
        await self.client.close();w.comfy=self.original

    async def request(self,path,data=None,headers=None):
        h={'Authorization':'Bearer integration-test-key'} if headers is None else headers
        response=await self.client.request('GET' if data is None else 'POST','/api/'+path,json=data,headers=h)
        return response,await response.json()

    async def submit(self,count=1):
        return await self.request('generate',dict(kind='image',count=count,settings=self.settings,requestId=str(uuid.uuid4())))

    async def wait_done(self,count):
        for _ in range(100):
            done=w.rows("SELECT * FROM jobs WHERE status='complete'")
            if len(done)==count:return done
            await asyncio.sleep(.02)
        self.fail(w.rows('SELECT status,error FROM jobs'))

    async def test_auth_and_private_library(self):
        r,d=await self.request('library',headers={});self.assertEqual(r.status,401)
        r,d=await self.request('library');self.assertEqual(d,[])

    async def test_extend_video_end_to_end(self):
        import av
        import numpy as np
        def make_clip(path, colors):
            with av.open(str(path),'w') as out:
                stream=out.add_stream('libx264',rate=18)
                stream.width,stream.height,stream.pix_fmt=64,96,'yuv420p'
                for color in colors:
                    frame=av.VideoFrame.from_ndarray(np.full((96,64,3),color,dtype=np.uint8),format='rgb24')
                    for packet in stream.encode(frame):out.mux(packet)
                for packet in stream.encode():out.mux(packet)
        src=w.ROOT/'output/ComfyBridge/initial.mp4'
        make_clip(src,[(i*10,0,0) for i in range(12)])
        original=src.read_bytes()
        w.DB.execute("INSERT INTO media VALUES('original','old','video',?,'',1,0,0)",(str(src),));w.DB.commit()
        response,source=await self.request('extension/original')
        self.assertEqual((response.status,source['frames'],source['width'],source['fps']),(200,12,64,18))
        s=copy.deepcopy(w.WF.defaults()['video']);s.update(extension=source,frames=7,sound=False)
        w.CATALOG['loras'] += [s['loras'][0]['name']]
        fake=w.comfy
        async def render(path,data=None):
            if path!='/prompt':return await fake(path,data)
            job=data['prompt_id'];graph=data['prompt']
            self.assertEqual(graph['50']['inputs']['image'],['2',0])
            self.assertEqual(graph['9']['inputs']['conditioning'],['50',0])
            self.assertEqual(graph['6']['inputs']['length'],22)
            self.assertEqual(graph['51']['inputs'],dict(image=['14',0],batch_index=5,length=7))
            for i,name in enumerate(w.extension.guide_names(job)):
                with Image.open(w.ROOT/'input'/name) as guide:
                    self.assertAlmostEqual(guide.getpixel((0,0))[0],(i+7)*10,delta=5)
            filename=job+'.mp4'
            make_clip(w.ROOT/'output/ComfyBridge'/filename,[(0,160,0)]*7)
            self.history[job]={'outputs':{'16':{'images':[dict(type='output',subfolder='ComfyBridge',filename=filename)]}}}
            return {}
        w.comfy=render
        response,batch=await self.request('generate',dict(kind='video',count=1,settings=s,requestId=str(uuid.uuid4())))
        self.assertEqual(response.status,200,batch)
        self.runner=asyncio.create_task(w.run_jobs());await self.wait_done(1)
        row=w.DB.execute('SELECT * FROM media WHERE job=?',(batch['ids'][0],)).fetchone()
        self.assertEqual(src.read_bytes(),original)
        self.assertAlmostEqual(row['duration'],19/18)
        with av.open(row['path']) as clip:
            pixels=[frame.to_image().getpixel((0,0)) for frame in clip.decode(video=0)]
        self.assertEqual(len(pixels),19)
        self.assertAlmostEqual(pixels[11][0],110,delta=5)
        self.assertGreater(pixels[12][1],150)
        response,next_source=await self.request('extension/'+row['id'])
        self.assertEqual(next_source['frames'],19)
        s['extension']={**source,'revision':'stale'}
        response,_=await self.request('generate',dict(kind='video',count=1,settings=s,requestId=str(uuid.uuid4())))
        self.assertEqual(response.status,400)

    async def test_panel_monitor_does_not_keep_worker_awake(self):
        await self.submit(4)
        last_phone_request = w.LAST_REQUEST
        r,d = await self.request('monitor')
        self.assertEqual(r.status, 200)
        self.assertEqual([j['ordinal'] for j in d['jobs']], [1,2,3,4])
        self.assertEqual(w.LAST_REQUEST, last_phone_request)
        r,_ = await self.request('monitor', headers={})
        self.assertEqual(r.status, 401)

    async def test_two_phone_queue_and_private_stops(self):
        one,two=str(uuid.uuid4()),str(uuid.uuid4())
        def headers(owner):return {'Authorization':'Bearer integration-test-key','X-Bridge-Device':owner}
        self.complete=False
        async def submit(owner):
            return await self.request('generate',dict(kind='image',count=1,settings=self.settings,requestId=str(uuid.uuid4())),headers(owner))
        _,a=await submit(one);self.runner=asyncio.create_task(w.run_jobs())
        for _ in range(100):
            if self.accepted:break
            await asyncio.sleep(.02)
        _,b=await submit(two);_,c=await submit(one)
        _,jobs=await self.request('status');self.assertEqual(len(jobs['jobs']),3)
        denied=await self.client.post('/api/stop',json={'batch':a['batch']},headers=headers(two))
        self.assertEqual(denied.status,403);await denied.read()
        await self.request('stop',{'batch':b['batch']},headers(two))
        _,batch=await self.request('batch/'+a['batch'],headers=headers(one))
        self.assertEqual(batch['jobs'][0]['status'],'running')
        self.assertEqual(w.rows('SELECT status FROM jobs WHERE batch=?',(c['batch'],))[0]['status'],'pending')

    async def test_queue_position_across_submissions_and_idle_reset(self):
        _,first = await self.submit()
        first_id = first['ids'][0]
        w.update(first_id, status='running')

        async def place(path, job_id, expected, headers=None):
            _, data = await self.request(path, headers=headers)
            job = next(job for job in data['jobs'] if job['id'] == job_id)
            self.assertEqual((job['queuePosition'], job['queueTotal']), expected)

        await place('status', first_id, (1,1))
        _, second = await self.submit()
        await place('monitor', first_id, (1,2))
        await place('batch/'+second['batch'], second['ids'][0], (2,2))

        owner = {'Authorization':'Bearer integration-test-key','X-Bridge-Device':str(uuid.uuid4())}
        video = copy.deepcopy(w.CATALOG['defaults']['video'])
        name = 'ComfyBridge/queue-test.png'
        Image.new('RGB',(64,64)).save(w.ROOT/'input'/name)
        video['upload'] = name
        w.CATALOG['loras'].extend(l['name'] for l in video.get('loras', []))
        request = dict(kind='video', count=2, settings=video, requestId=str(uuid.uuid4()))
        response, third = await self.request('generate', request, owner)
        self.assertEqual(response.status, 200, third)
        await self.request('generate', request, owner)
        await place('batch/'+third['batch'], third['ids'][-1], (4,4), owner)
        w.update(first_id, status='complete')
        await place('monitor', second['ids'][0], (2,4))
        await self.request('stop', {'batch':second['batch']})
        await place('status', third['ids'][0], (2,3))
        for job_id in third['ids']:
            w.update(job_id, status='complete')
        _, fresh = await self.submit()
        await place('monitor', fresh['ids'][0], (1,1))

    def test_mandatory_video_strength_uses_workflow_value(self):
        video=copy.deepcopy(w.CATALOG['defaults']['video'])
        fixed=video['loras'][0]['strength']
        video['upload']='ComfyBridge/source.png'
        video['loras'][0]['strength']=fixed+.5
        video['loras'].append(dict(name='extra',strength=.25,enabled=True))
        graph=w.WF.build('video',video,'ComfyBridge/test')
        self.assertEqual(graph['100']['inputs']['strength_model'],fixed)
        self.assertEqual(graph['101']['inputs']['strength_model'],.25)
        replay=w.WF.build('video',video,'ComfyBridge/test',recorded_video_strength=.8)
        self.assertEqual(replay['100']['inputs']['strength_model'],.8)

    async def test_profiles_remain_separate_and_restorable(self):
        owners=[str(uuid.uuid4()) for _ in range(3)]
        def headers(i):return {'Authorization':'Bearer integration-test-key','X-Bridge-Device':owners[i]}
        original='data:image/png;base64,aGVsbG8=';digest=hashlib.sha256(original.encode()).hexdigest()
        await self.request('profile-blob/'+digest,{'value':original},headers(0))
        for i in range(2):
            profile=dict(settings={'image':{'steps':i+1}},inputs={'image':{'data':{'bridgeInput':digest}}},presets={},prompts=[])
            await self.request('profile',{'state':profile,'name':'Moto'},headers(i))
        for i in range(2):
            _,saved=await self.request('profile/'+owners[i],headers=headers(2))
            self.assertEqual(saved['settings']['image']['steps'],i+1)
            _,blob=await self.request('profile-blob/'+saved['inputs']['image']['data']['bridgeInput'],headers=headers(2))
            self.assertEqual(blob['value'],original)

    def test_estimated_progress_for_both_graphs(self):
        for kind in ('image','video'):
            s=w.WF.defaults()[kind];s['upload']='ComfyBridge/mock.png' if kind=='video' else None
            graph=w.WF.build(kind,s,'test');clock=[0.]
            p=w.Progress(kind,graph,s,lambda:clock[0]);sampler='13' if kind=='video' else '3'
            cold=w.Progress(kind,{sampler:graph[sampler]},s,lambda:clock[0])
            cold.enter(sampler);clock[0]+=3600
            self.assertLess(cold.sample()[0],1/s['steps'])
            self.assertIn('preparing',cold.sample()[1])
            p.event('execution_cached',{'nodes':['4','5']})
            p.event('executing',{'node':sampler});p.step(sampler,{'value':1,'max':4});start=p.sample()[0]
            clock[0]+=10;half=p.sample()[0];self.assertGreater(half,start)
            p.step(sampler,{'value':4,'max':4});after=p.sample()[0]
            p.event('executing',{'node':'14' if kind=='video' else '8'});decode,label=p.sample()
            self.assertGreaterEqual(decode,after);self.assertLess(decode,.99);self.assertIn('Decode',label)
            p.event('execution_success',{})
            value, stage = p.sample()
            self.assertAlmostEqual(value,.99)
            self.assertEqual(stage,'Indexing output')

    async def test_media_manifest_tracks_replacement_deletion_and_archive(self):
        await self.submit();self.runner=asyncio.create_task(w.run_jobs());await self.wait_done(1)
        r,data=await self.request('media-index');self.assertEqual(r.status,200)
        item=data['items'][0];file=Path(w.rows('SELECT path FROM media')[0]['path'])
        self.assertEqual(item['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertNotIn('path',item)
        file.write_bytes(b'different video');await self.request('archive',dict(id=item['id'],archived=True))
        _,data=await self.request('media-index');new=data['items'][0]
        self.assertEqual(new['archived'],1);self.assertEqual(new['size'],15)
        self.assertNotEqual(new['sha256'],item['sha256'])
        file.unlink();_,data=await self.request('media-index')
        self.assertEqual(data['items'][0]['source'],'missing')
        r,_=await self.request('media-index',headers={});self.assertEqual(r.status,401)

    async def test_batch_survives_disconnect_and_increments_seeds(self):
        r,d=await self.submit(4);self.assertEqual(r.status,200)
        w.LAST_REQUEST=0 # no further phone requests while worker completes all four
        self.runner=asyncio.create_task(w.run_jobs());await self.wait_done(4)
        values=[x['prompt']['3']['inputs']['seed'] for x in self.accepted.values()]
        self.assertEqual(values,list(range(int(self.settings['seed']),int(self.settings['seed'])+4)))
        self.assertEqual(len(w.rows('SELECT * FROM media')),4)
        self.assertTrue(all('ComfyBridge/' in x['prompt']['9']['inputs']['filename_prefix'] for x in self.accepted.values()))

    async def test_idempotent_retry(self):
        payload=dict(kind='image',count=4,settings=self.settings,requestId=str(uuid.uuid4()))
        r,a=await self.request('generate',payload);r,b=await self.request('generate',payload)
        self.assertEqual(a,b);self.assertEqual(len(w.rows('SELECT * FROM jobs')),4)

    async def test_cancel_queued_batch_never_interrupts_desktop(self):
        self.complete=False
        r,d=await self.submit(4);self.runner=asyncio.create_task(w.run_jobs())
        for _ in range(50):
            if self.accepted:break
            await asyncio.sleep(.02)
        await self.request('stop',{'batch':d['batch']})
        self.assertFalse(any(path=='/interrupt' for path,data in self.calls))
        deleted=[data['delete'] for path,data in self.calls if path=='/queue' and data]
        self.assertEqual(deleted,[[d['ids'][0]]])
        self.assertEqual(len(w.rows("SELECT * FROM jobs WHERE status='cancelled'")),4)

    async def test_skip_only_previewed_image_and_continue_batch(self):
        await self.check_skip_and_continue('image',self.settings)

    async def test_skip_current_video_and_continue_batch(self):
        video=copy.deepcopy(w.CATALOG['defaults']['video'])
        video['upload']='ComfyBridge/skip-test.png'
        Image.new('RGB',(64,64)).save(w.ROOT/'input'/video['upload'])
        w.CATALOG['loras'].extend(l['name'] for l in video['loras'])
        await self.check_skip_and_continue('video',video)

    async def check_skip_and_continue(self,kind,settings):
        owner={'Authorization':'Bearer integration-test-key','X-Bridge-Device':str(uuid.uuid4())}
        other={**owner,'X-Bridge-Device':str(uuid.uuid4())}
        _,batch=await self.request('generate',dict(requestId=str(uuid.uuid4()),kind=kind,count=2,settings=settings),owner)
        first,second=batch['ids']
        self.complete=False
        simulate=w.comfy
        async def running(path,data=None):
            if path=='/queue' and data is None:
                return dict(queue_running=[[0,first,{},{}]],queue_pending=[])
            if path=='/interrupt':
                self.assertEqual(data,{'prompt_id':first})
                self.history[first]={'status':{'status_str':'error'},'outputs':{}}
                self.complete=True
            return await simulate(path,data)
        w.comfy=running
        self.runner=asyncio.create_task(w.run_jobs())
        for _ in range(100):
            if first in self.accepted:break
            await asyncio.sleep(.02)
        denied=await self.client.post('/api/skip',json={'id':first},headers=other)
        self.assertEqual(denied.status,403);await denied.read()
        stale,_=await self.request('skip',{'id':second},owner)
        self.assertEqual(stale.status,409)
        ok,_=await self.request('skip',{'id':first},owner)
        self.assertEqual(ok.status,200)
        for _ in range(300):
            if w.DB.execute('SELECT status FROM jobs WHERE id=?',(second,)).fetchone()[0]=='complete':break
            await asyncio.sleep(.02)
        self.assertEqual([r['status'] for r in w.rows('SELECT status FROM jobs ORDER BY rowid')],['cancelled','complete'])
        await self.request('skip',{'id':first},owner)
        self.assertEqual([d for path,d in self.calls if path=='/interrupt'],[{'prompt_id':first}])

    async def test_frames_are_versioned_and_scoped(self):
        first,second=str(uuid.uuid4()),str(uuid.uuid4())
        w.ACTIVE=first;w.publish_preview(first,b'one')
        headers={'Authorization':'Bearer integration-test-key'}
        r=await self.client.get('/api/preview/'+first,headers=headers)
        revision=r.headers['X-Preview-Revision'];self.assertEqual(await r.read(),b'one')
        pending=asyncio.create_task(self.client.get('/api/preview/'+first+'?after='+revision,headers=headers))
        await asyncio.sleep(.02)
        w.publish_preview(first,b'two')
        r=await pending;self.assertEqual(await r.read(),b'two')
        w.ACTIVE=second;w.publish_preview(second,b'next job')
        r=await self.client.get('/api/preview/'+first,headers=headers)
        self.assertEqual(r.status,410);await r.read()

    async def test_archive_unarchive_and_range_download(self):
        await self.submit();self.runner=asyncio.create_task(w.run_jobs());await self.wait_done(1)
        r,items=await self.request('library');id=items[0]['id']
        await self.request('archive',{'id':id,'archived':True});r,items=await self.request('library');self.assertEqual(items[0]['archived'],1)
        await self.request('archive',{'id':id,'archived':False});r,items=await self.request('library');self.assertEqual(items[0]['archived'],0)
        r=await self.client.get('/api/media/'+id,headers={'Authorization':'Bearer integration-test-key','Range':'bytes=0-7'})
        self.assertEqual(r.status,206);self.assertEqual(await r.read(),b'\x89PNG\r\n\x1a\n')

    async def test_mask_upload_and_resolution_routing(self):
        img=Image.new('RGBA',(64,96),(0,0,0,0));img.putpixel((20,30),(255,255,255,255));buf=io.BytesIO();img.save(buf,format='PNG')
        r,d=await self.request('upload',{'data':base64.b64encode(buf.getvalue()).decode()});self.assertEqual(r.status,200)
        loaded=Image.open(w.ROOT/'input'/d['name']);self.assertEqual(loaded.getpixel((20,30)),(255,255,255));self.assertEqual(loaded.getpixel((0,0)),(0,0,0))
        settings=dict(self.settings,upload=d['name'],mask=d['name'],width=64,height=96,denoise=.6)
        graph=w.WF.build('image',settings,'ComfyBridge/test')
        self.assertEqual(graph['3']['inputs']['latent_image'],['43',0]);self.assertEqual(graph['3']['inputs']['denoise'],.6)
        self.assertEqual(graph['52']['inputs']['channel'],'red')

    async def test_fixed_seed_batch_and_recovery(self):
        self.settings['increment']=False;await self.submit(2)
        # Simulate a worker restart after the first prompt was accepted by ComfyUI.
        first=w.rows('SELECT * FROM jobs ORDER BY ordinal')[0]
        graph=w.WF.build('image',self.settings,'ComfyBridge/'+first['id'])
        await w.comfy('/prompt',dict(prompt_id=first['id'],prompt=graph))
        w.update(first['id'],status='submitting')
        self.runner=asyncio.create_task(w.run_jobs());await self.wait_done(2)
        submits=[d for p,d in self.calls if p=='/prompt'];self.assertEqual(len(submits),2)
        self.assertEqual(submits[0]['prompt']['3']['inputs']['seed'],submits[1]['prompt']['3']['inputs']['seed'])

    async def test_text_video_uses_no_image_nodes_and_validates_canvas(self):
        video=copy.deepcopy(w.WF.defaults()['video'])
        video.update(width=512,height=768,upload=None)
        graph=w.WF.build('video',video,'ComfyBridge/test')
        self.assertNotIn('first_frame',graph['6']['inputs'])
        self.assertNotIn('LoadImage',{n['class_type'] for n in graph.values()})
        video['width']=513
        with self.assertRaisesRegex(ValueError,'multiples of 32'):w.WF.build('video',video,'ComfyBridge/test')

    async def test_validation_rejects_invalid_resolution_and_path_escape(self):
        with self.assertRaises(ValueError):w.checked_upload('../../worker.py')
        self.settings['width']=0;r,d=await self.submit();self.assertEqual(r.status,400)
        self.assertEqual(w.rows('SELECT * FROM jobs'),[])

    async def test_video_duration_trims_only_the_model_padding(self):
        s=copy.deepcopy(w.WF.defaults()['video'])
        s.update(frames=39,fps=12,exactFrames=True)
        for upload in (None,'ComfyBridge/source.png'):
            s['upload']=upload
            # 39 is on the model grid; 15 frames (1.25 seconds) requires 22 internally.
            s['frames']=39
            self.assertNotIn('51',w.WF.build('video',s,'ComfyBridge/test'))
            s['frames']=15
            graph=w.WF.build('video',s,'ComfyBridge/test')
            self.assertEqual(graph['6']['inputs']['length'],22)
            self.assertEqual(graph['51']['inputs'],dict(image=['14',0],batch_index=0,length=15))
            self.assertEqual(graph['15']['inputs']['images'],['51',0])
            s['frames']=1
            self.assertEqual(w.WF.build('video',s,'ComfyBridge/test')['51']['inputs']['length'],1)

    def test_sound_uses_joint_latent_and_native_frame_clock(self):
        s=w.WF.defaults()['video']
        s.update(frames=15, exactFrames=True, fps=12)
        for model in (s['model'],w.EROS_BETA7):
            s['model']=model
            for upload, ext in ((None,None),('image.png',None),(None,{'id':'source'})):
                s.update(sound=True,upload=upload,extension=ext)
                graph=w.WF.build('video',s,'ComfyBridge/'+str(uuid.uuid4()))
                self.assertEqual(graph['53']['inputs']['samples'],['13',0])
                self.assertEqual(graph['54']['inputs']['duration'],15/24)
                self.assertEqual(graph['54']['inputs']['start_index'],(5 if ext else 0)/24)
                self.assertEqual(graph['15']['inputs']['audio'],['54',0])
                self.assertEqual(graph['15']['inputs']['fps'],24)
                s['sound']=False
                graph=w.WF.build('video',s,'ComfyBridge/'+str(uuid.uuid4()))
                self.assertNotIn('audio',graph['15']['inputs'])
                self.assertNotIn('53',graph)
                self.assertEqual(graph['15']['inputs']['fps'],12)

    def test_extension_sound_at_cut_and_silent_export(self):
        import av
        import numpy as np
        e=w.extension
        folder=Path(TEMP.name)
        def tone(path,freq=None):
            args=['-f','lavfi','-i','color=c=red:s=64x96:r=24']
            if freq:args+=['-f','lavfi','-i',f'sine=frequency={freq}:sample_rate=32000','-c:a','aac']
            e.ffmpeg(*args,'-t','1','-threads','1','-c:v','libx264',path)
        for source_audio in (True,False):
            src=folder/'src.mp4'
            tone(src,440 if source_audio else None)
            # Source playback is 12 FPS. The new second starts as 24 native frames.
            if source_audio: e.finish_sound(src,12)
            else:
                e.ffmpeg('-f','lavfi','-i','color=c=blue:s=64x96:r=12','-t','2','-c:v','libx264',src)
            info=e.describe(src,'src')
            for sound in (True,False):
                dest=folder/'tail.mp4'
                tone(dest,880 if sound else None)
                e.join(src,dest,info,24,folder/'thumb.jpg',lambda:False,sound)
                before=dest.read_bytes()
                e.join(src,dest,info,24,folder/'thumb.jpg',lambda:False,sound)
                self.assertEqual(dest.read_bytes(),before)
                with av.open(str(dest)) as c:
                    self.assertEqual(c.streams.video[0].frames,48)
                    self.assertEqual(c.streams.video[0].average_rate,12)
                    self.assertEqual(bool(c.streams.audio),sound)
                    if not sound:continue
                    a=c.streams.audio[0]
                    self.assertAlmostEqual(float(a.duration*a.time_base),4,places=2)
                    pcm=np.concatenate([f.to_ndarray()[0] for f in c.decode(a)])
                    rate=a.codec_context.sample_rate
                    for second,freq in ((1,440 if source_audio else 0),(3,880)):
                        block=pcm[second*rate:(second+1)*rate]
                        if freq:self.assertAlmostEqual(np.argmax(abs(np.fft.rfft(block))),freq,delta=3)
                        else:self.assertLess(np.max(np.abs(block[:-rate//20])),.001)  # avoid AAC pre-echo at the cut

    def test_negative_video_text_only_changes_guidance_and_keeps_visual_references(self):
        s=w.WF.defaults()['video']
        prefix='ComfyBridge/'+str(uuid.uuid4())
        for model in (s['model'],w.EROS_BETA7):
            s['model']=model
            for upload,extension in ((None,None),('input.png',None),(None,{'id':'source'})):
                s.update(upload=upload,extension=extension)
                s.pop('negative',None)
                original=w.WF.build('video',s,prefix)
                s['negative']=' \n '
                self.assertEqual(original,w.WF.build('video',s,prefix))
                s['negative']='  unwanted reflections  '
                g=w.WF.build('video',s,prefix)
                cond=g['6']['inputs']
                self.assertEqual(g['55']['inputs'],dict(cond,prompt='unwanted reflections'))
                self.assertEqual(g['9']['class_type'],'CFGGuider')
                self.assertEqual(g['9']['inputs'],dict(model=original['9']['inputs']['model'],
                    positive=['50' if extension else '6',0],negative=['56' if extension else '55',0],cfg=2.0))
                if extension:self.assertEqual(g['56']['inputs'],dict(g['50']['inputs'],positive=['55',0]))
                self.assertEqual(g['13']['inputs'],original['13']['inputs'])

    async def test_eros_recipe_selects_weights_and_removes_only_stock_turbo(self):
        video=copy.deepcopy(w.WF.defaults()['video'])
        base=w.WF.build('video',video,'ComfyBridge/test')
        stock=video['loras'][0]['name']
        video.update(model=w.EROS_BETA7,steps=8)
        video['loras'].append(dict(name='user-extra',strength=.12))
        graph=w.WF.build('video',video,'ComfyBridge/test')
        self.assertEqual(graph['5']['inputs']['unet_name'],w.EROS_BETA7)
        self.assertEqual(graph['3'],base['3']);self.assertEqual(graph['4'],base['4'])
        adapters=[n['inputs'] for n in graph.values() if n['class_type']=='LoraLoaderModelOnly']
        self.assertEqual([(l['lora_name'],l['strength_model']) for l in adapters],[('user-extra',.12)])
        self.assertEqual(graph['27']['inputs']['shift_video'],12)
        self.assertEqual(graph['27']['inputs']['shift_audio'],3)
        self.assertEqual(graph['28']['class_type'],'ComfyBridgeErosVSA')
        self.assertEqual(graph['28']['inputs'],dict(model=['27',0],min_tokens=12288))
        self.assertEqual(graph['9']['inputs']['model'],['28',0])
        self.assertEqual(graph['12']['inputs']['model'],['28',0])
        self.assertEqual(graph['12']['inputs']['steps'],8)
        self.assertEqual(base['100']['inputs']['lora_name'],stock)
        self.assertNotIn('28',base)

    async def test_empty_comfy_control_response(self):
        app=web.Application()
        async def empty(request):return web.Response(status=200)
        app.router.add_post('/queue',empty)
        server=TestServer(app);await server.start_server()
        previous_url,previous_session=w.COMFY,w.SESSION
        try:
            w.COMFY=str(server.make_url('')).rstrip('/')
            async with ClientSession() as session:
                w.SESSION=session
                self.assertEqual(await self.original('/queue',{'delete':['our-job']}),{})
        finally:
            w.COMFY,w.SESSION=previous_url,previous_session
            await server.close()


if __name__=='__main__':
    try:unittest.main(verbosity=2)
    finally:
        w.DB.close();logging.shutdown();TEMP.cleanup()
