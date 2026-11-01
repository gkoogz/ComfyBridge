"""Integration tests with an isolated store and simulated ComfyUI; no GPU work."""
import asyncio
import base64
import copy
import io
import logging
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

from aiohttp import web, ClientSession
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

TEMP = tempfile.TemporaryDirectory()
os.environ['COMFYBRIDGE_DATA'] = TEMP.name
Path(TEMP.name, 'token.txt').write_text('integration-test-key')
import worker as w


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
        self.assertEqual(len(w.rows("SELECT * FROM jobs WHERE status='cancelled'")),3)

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

    async def test_validation_rejects_missing_video_input_and_path_escape(self):
        video=copy.deepcopy(w.WF.defaults()['video'])
        with self.assertRaises(ValueError):w.WF.build('video',video,'ComfyBridge/test')
        with self.assertRaises(ValueError):w.checked_upload('../../worker.py')
        self.settings['width']=0;r,d=await self.submit();self.assertEqual(r.status,400)
        self.assertEqual(w.rows('SELECT * FROM jobs'),[])

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
