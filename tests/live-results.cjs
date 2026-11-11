const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/local/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="96"><rect width="64" height="96" fill="#678"/></svg>'}));
  await p.route('**/thumb/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="96"/>'}));
  await p.route('**/local/thumb/new-video/**',r=>r.fulfill({status:404}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  for(const kind of ['image','video']){
   await p.evaluate(kind=>{
    leaveLivePreview();heartbeat=poll=syncSettings=syncShelf=watchFrames=async()=>{};persist=notice=()=>{};
    connected=true;imagePreviewProtocol=true;queueProtocol=19;window.calls=[];window.finishDownload=null;
    for(const k of ['image','video'])state.settings[k]={width:64,height:96,frames:22,fps:24,steps:4,scale:0,cfg:1,denoise:1,loras:[],seed:'1',batch:1,model:'fixture',positive:'A ceramic bowl.',negative:'',exactFrames:true};
    state.inputs={image:{},video:{}};state.pendingByKind={};
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=kind==='image'?16:96;
    canvas.getContext('2d').fillRect(0,0,64,canvas.height);window.frame1=canvas.toDataURL();
    canvas.getContext('2d').fillStyle='red';canvas.getContext('2d').fillRect(0,0,64,canvas.height);window.frame2=canvas.toDataURL();
    canvas.height=96;window.sourceImage=canvas.toDataURL();
    library=[{id:'old-'+kind,job:'old-job-'+kind,kind,local:'old',created:1}];
    active=null;jobs=[{id:'live-'+kind,kind,status:'pending',owner:'one',created:2,queuePosition:1,queueTotal:1}];queueHistory=jobs;
    fetchOriginal=id=>new Promise(resolve=>window.finishDownload=()=>resolve({...library.find(x=>x.id===id),local:'complete'}));
    api=async route=>{
     calls.push(route);
     if(route.startsWith('studio/replay/'))return {kind:'video',settings:{...state.settings.video,seed:'123456789',upload:'ComfyBridge/source.png',finalFrame:'ComfyBridge/end.png'},inputs:{data:sourceImage,finalFrame:{data:sourceImage}}};
     return {};
    };
    navigate(kind);renderGenerator();
   },kind);
   const tile=p.locator('.inflightThumb');assert(await tile.isEnabled());
   await tile.click();assert.equal(await tile.getAttribute('aria-current'),'true');
   assert(await p.locator('#result .previewBusy').isVisible());assert(await p.locator('#result .watchPixels').isHidden());
   await p.evaluate(kind=>{active='live-'+kind;jobs[0].status='running';frames.set(active,{revision:1,url:frame1});paintFrame(active);updateProgress();},kind);
   await p.locator('#result .watchPixels').evaluate(img=>img.decode());
   const center=await p.evaluate(()=>{
    const a=$('#result .watchPixels').getBoundingClientRect(),s=$('#result .previewBusy .spinner').getBoundingClientRect();
    return [a.x+a.width/2-s.x-s.width/2,a.y+a.height/2-s.y-s.height/2,a.width];
   });
   assert(Math.abs(center[0])<1&&Math.abs(center[1])<1,JSON.stringify(center));assert.equal(center[2],390);
   await p.evaluate(()=>{frames.set(active,{revision:2,url:frame2});paintFrame(active);});
   assert.equal(await p.locator('#result .watchPixels').getAttribute('src'),await p.evaluate(()=>frame2));
   await p.locator('#carousel [data-media]').click();assert.equal(await p.locator('#result .asset').getAttribute('data-id'),'old-'+kind);
   await tile.click();assert.equal(await tile.getAttribute('aria-current'),'true');
   await p.evaluate(kind=>{
    jobs[0].status='complete';active=null;library.unshift({id:'new-'+kind,job:'live-'+kind,kind,created:3});renderResults();
   },kind);
   await p.waitForFunction(()=>!!finishDownload);
   assert(await p.locator('#result .previewBusy').isVisible());assert.equal(await p.locator('#result .watchPixels').getAttribute('src'),await p.evaluate(()=>frame2));
   assert.equal(await p.locator('#carousel [aria-current=true]').getAttribute('data-media'),'new-'+kind);
   await p.evaluate(()=>finishDownload());
   await p.waitForFunction(kind=>$('#result .asset')?.dataset.id==='new-'+kind&&liveSelection===null,kind);
   assert.equal(await p.locator('#result .previewBusy').count(),0);
   if(kind==='video'){
    assert(await p.locator('#result video').isVisible());assert(await p.locator('#result .regenerate').isVisible());
    assert.match(await p.locator('#result video').getAttribute('poster'),/^data:image\/jpeg/);
    assert(await p.getByRole('button',{name:'Extend video',exact:true}).isVisible());
    await p.locator('#result .regenerate').click();
    await p.waitForFunction(()=>state.settings.video.seed==='123456789');
    assert.equal(await p.locator('[data-setting=seed]').inputValue(),'123456789');
    assert(await p.evaluate(()=>!!state.inputs.video.finalFrame.data));
    assert.deepEqual(await p.evaluate(()=>calls),['studio/replay/live-video']);
   }
   // A late download must not replace a different thumbnail selected meanwhile.
   await p.evaluate(kind=>{
    leaveLivePreview();jobs=[{id:'late-'+kind,kind,status:'running',owner:'one',created:4}];active=jobs[0].id;queueHistory=jobs;
    frames.set(active,{revision:1,url:frame1});selectLiveGeneration(active);
    jobs[0].status='complete';library.unshift({id:'late-output-'+kind,job:active,kind,created:4});active=null;renderResults();
   },kind);
   await p.waitForFunction(()=>liveSelection?.busy&&!!finishDownload);
   await p.locator('#carousel [data-media="old-'+kind+'"]').click();await p.evaluate(()=>finishDownload());
   await p.waitForFunction(kind=>!!library.find(x=>x.id==='late-output-'+kind)?.local,kind);
   assert.equal(await p.locator('#result .asset').getAttribute('data-id'),'old-'+kind);
   await p.evaluate(kind=>{
    jobs=[{id:'failed-'+kind,kind,status:'running',owner:'one',created:5}];active=jobs[0].id;queueHistory=jobs;
    frames.set(active,{revision:1,url:frame1});selectLiveGeneration(active);
    jobs[0].status='error';active=null;updateProgress();
   },kind);
   assert(await p.locator('#result .previewBusy').isHidden());assert.match(await p.locator('.watchCaption').textContent(),/Generation failed/);
  }
  await p.evaluate(()=>{
   leaveLivePreview();jobs=[{id:'other-kind',kind:'image',status:'running',created:1},{id:'waiting-video',kind:'video',status:'pending',created:2}];
   queueHistory=jobs;active='other-kind';frames.set(active,{revision:1,url:frame1});navigate('video');renderCarousel();
  });
  await p.locator('.inflightThumb').click();assert(await p.locator('#result .watchPixels').isHidden());assert(await p.locator('#result .previewBusy').isVisible());
  assert.match(await p.locator('.watchCaption').textContent(),/Queued/);
  assert.deepEqual(errors,[]);
  console.log('Live image/video results: clickable queued/running items, full-width previews, centered spinner, live updates, download handoff, selection races and exact video regeneration passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
