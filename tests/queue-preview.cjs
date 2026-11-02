// Isolated phone UI: frames arrive asynchronously while the queue advances.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:360,height:740}});
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/thumb/output',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>'}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   window.poll=window.heartbeat=window.syncSettings=async()=>{};
   const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3;
   const blob=()=>new Promise(resolve=>canvas.toBlob(resolve));
   window.deliver=null;window.requests=[];
   window.fetch=(url,{signal})=>new Promise((resolve,reject)=>{
    requests.push(url);signal.addEventListener('abort',()=>reject(Error('Aborted')),{once:true});
    window.deliver=async rev=>{window.deliver=null;resolve(new Response(await blob(),{headers:{'X-Preview-Revision':String(rev)}}));};
   });
   state.settings.video={width:256,height:384,frames:22,fps:12,steps:4,loras:[],seed:'1',batch:1};
   connected=true;queueProtocol=15;imagePreviewProtocol=true;page='video';active='first';
   jobs=['running','pending','complete'].map((status,i)=>({id:['first','next','old'][i],kind:'video',status,created:100+i,owner:'two',progress:0}));
   queueHistory=jobs;renderGenerator();updateProgress();
  });
  const rows=p.locator('.queueJob');
  const rings=()=>rows.locator('.jobSpinner').count();
  assert.equal(await rings(),2);assert.equal(await rows.nth(1).locator('img').count(),0);
  assert.equal(await rows.nth(0).locator('.jobSpinner').evaluate(el=>getComputedStyle(el).animationPlayState),'running');
  for(const rev of [1,2]){
   await p.waitForFunction(()=>!!window.deliver);await p.evaluate(n=>deliver(n),rev);
   await p.waitForFunction(n=>{const img=$('.queuePreview'),head=$('#livePreview');return frames.get('first')?.revision===n&&img?.naturalWidth===4&&!img.hidden&&head.src===img.src;},rev);
  }
  assert.deepEqual(await p.evaluate(()=>requests),['/preview/first?after=-1','/preview/first?after=1','/preview/first?after=2']);
  await p.evaluate(()=>{jobs[0].status='complete';jobs[0].media='output';active='next';jobs[1].status='running';updateProgress();});
  assert.equal(await rings(),1);assert.equal(await rows.nth(0).locator('[data-output]').count(),1);
  assert(await rows.nth(1).locator('img').isHidden());assert(await p.locator('#livePreview').isHidden());
  await p.evaluate(()=>{page='bridge';renderBridge();});await p.evaluate(()=>deliver(3));
  await p.waitForFunction(()=>$('.queuePreview')?.naturalWidth===4&&$('.queuePreview').dataset.frameJob==='next');
  await p.evaluate(()=>{jobs[1].status='error';active=null;updateBridgeActivity();});
  assert.equal(await rings(),0);assert.equal(await rows.locator('.queuePreview').count(),0);
  console.log('Shared video frames, pending spinners, job handoff, Bridge queue and terminal states passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
