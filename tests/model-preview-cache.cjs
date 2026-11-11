const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();let release;
 try{
  const context=await browser.newContext(),p=await context.newPage(),requests=[],errors=[];
  let fail='',hold='';
  p.on('pageerror',error=>errors.push(error.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',async route=>{
   const url=new URL(route.request().url()),name=url.pathname.slice(1)+url.search;requests.push(name);
   if(hold&&name.includes(hold)){hold='';await new Promise(resolve=>release=resolve);}
   try{await route.fulfill(name.includes(fail)&&fail?{status:503,body:'Temporarily unavailable'}:
    {contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#638d89"/></svg>'});}catch{}
  });
  await p.route('**/app.js',async r=>{await new Promise(resolve=>setTimeout(resolve,150));await r.fulfill({path:path.join(__dirname,'../android/assets/app.js')});});
  await p.addInitScript(()=>{let ticks=0;const timer=setInterval(()=>{window.dispatchEvent(new Event('resize'));if(++ticks===15)clearInterval(timer);},20);});
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false,fingerprint:'cache-test'}),notificationRoute:()=>''});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  async function setup(){await p.evaluate(async()=>{
   heartbeat=poll=()=>{};connected=false;ModelPreviews.pause();
   window.clock=1000;window.allowed=false;window.looking=false;window.randomIndex=0;
   window.item=(id,version='old')=>({id,kind:id==='b'?'checkpoints':'loras',name:id+'.safetensors',title:'Pottery '+id,
    images:Array.from({length:3},(_,i)=>({id:id+version+i,source:'https://image.civitai.com/'+id+version+i+'.jpg',path:'model-preview/'+id+'/'+i+'?v='+version}))});
   window.extra={id:'extra',source:'https://image.civitai.com/extra.jpg',path:'model-preview/a/extra',fullPath:'model-preview/a/full'};
   window.items=[item('a'),item('b'),item('c')];
   window.cache=new ListingPreviewCache({scope:'fixture',database:'preview-regression',now:()=>clock,random:()=>[0,.5,.999][randomIndex++%3],canDownload:()=>allowed,isViewing:()=>looking});
   await cache.register(items,true,false);
  });}
  await setup();
  const initialAges=await p.evaluate(()=>[...cache.records.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(r=>r.refreshAfter));
  assert(initialAges.every(n=>n>=30*86400000&&n<=120*86400000));assert.equal(new Set(initialAges).size,3);
  await p.evaluate(()=>{window.extraDone=window.fullDone=false;cache.ensure(items[0],[extra]).then(()=>extraDone=true);cache.ensure(items[0],[{...items[0].images[0],fullPath:'model-preview/a/full'}],true).then(()=>fullDone=true);});
  await p.waitForTimeout(80);assert.equal(requests.length,0,'No previews while library lane is busy');
  await p.evaluate(()=>{allowed=true;cache.wake();});
  await p.waitForFunction(()=>[...cache.records.values()].every(r=>r.desired.every(s=>cache.entry(r,s).thumb)));
  assert.equal(requests.length,9,'Extras also wait until catalogue indexing is complete');
  await p.evaluate(()=>cache.register(items,true,true));await p.waitForFunction(()=>extraDone&&fullDone);
  assert.deepEqual(requests.slice(0,9),[0,1,2].flatMap(i=>['a','b','c'].map(id=>'model-preview/'+id+'/'+i+'?v=old')),'All listings get three before any extra');
  assert.equal(requests[9],'model-preview/a/extra');assert.equal(requests[10],'model-preview/a/full');
  assert.equal(await p.evaluate(()=>cache.samples(items[0]).length),3);
  const count=requests.length;
  // Close/reopen the actual browser page: blobs and random ages must survive without network.
  await p.evaluate(()=>cache.close());await p.reload();await p.waitForSelector('#connect');
  await setup();await p.evaluate(async()=>{allowed=true;cache.wake();await cache.ensure(items[0],cache.samples(items[0]));await cache.ensure(items[0],[{...items[0].images[0],fullPath:'model-preview/a/full'}],true);});
  assert.equal(requests.length,count,'Persisted previews must not be downloaded again');
  assert.deepEqual(await p.evaluate(()=>[...cache.records.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(r=>r.refreshAfter)),initialAges);
  assert(await p.evaluate(async()=>{const image=new Image();image.src=cache.url(items[0],cache.samples(items[0])[0]);await image.decode();return image.naturalWidth===240;}));
  // Changed listings remain exactly as cached before their own randomized age.
  await p.evaluate(async()=>{clock+=86400000;items[0]=item('a','new');await cache.register(items);cache.wake();});
  await p.waitForTimeout(100);assert.equal(requests.length,count);
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>s.source.includes('old'))));
  // After age, replacements can stage while viewed, but neither partial success nor failure evicts old images.
  fail='a/2?v=new';
  await p.evaluate(()=>{clock+=31*86400000;looking=true;cache.wake();});
  await p.waitForFunction(()=>cache.error.includes('503'));
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>s.source.includes('old'))));
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>cache.url(items[0],s).startsWith('blob:'))));
  fail='';await p.evaluate(()=>{clock+=31000;cache.wake();});
  await p.waitForFunction(()=>cache.records.get(cache.key(items[0])).desired.every(s=>cache.entry(cache.records.get(cache.key(items[0])),s).thumb));
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>s.source.includes('old'))),'A visible listing keeps its current set');
  const oldKeys=await p.evaluate(()=>cache.records.get(cache.key(items[0])).active);
  const stagedRequests=requests.length;
  await p.evaluate(async()=>{cache.close();cache=new ListingPreviewCache({scope:'fixture',database:'preview-regression',now:()=>clock,canDownload:()=>allowed,isViewing:()=>looking});await cache.ready;await cache.register(items);});
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>s.source.includes('old'))),'Staged refresh survives a device restart without replacing visible previews');
  await p.evaluate(()=>{looking=false;cache.wake();});
  await p.waitForFunction(()=>cache.samples(items[0]).every(s=>s.source.includes('new')));
  assert(await p.evaluate(keys=>keys.every(key=>!cache.entry(cache.records.get(cache.key(items[0])),key)),oldKeys));
  assert.equal(requests.length,stagedRequests,'Promoting an already-downloaded replacement set needs no network');
  assert(await p.evaluate(()=>cache.samples(items[0]).every(s=>cache.url(items[0],s).startsWith('blob:'))));
  await p.evaluate(()=>cache.close());
  // The real app's media transfer hooks preempt a running preview immediately.
  requests.length=0;hold='priority/0';
  await p.evaluate(async()=>{
   window.cache=null;connected=true;window.hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
   profileLoad=0;profileBusy=settingsBusy=syncing=filling=false;library=[];originalTransfers.clear();
   const listing={id:'priority',name:'Priority.safetensors',kind:'loras',images:[0,1,2].map(i=>({source:'https://image.civitai.com/priority'+i,path:'model-preview/priority/'+i}))};
   catalog={listings:[listing]};ModelPreviews.libraryEpoch=-1;await ModelPreviews.start(catalog);
  });
  await p.waitForTimeout(80);assert.equal(requests.length,0,'Startup waits for the library inventory');
  await p.evaluate(()=>{local=async(op,args)=>op==='sync'?[]:new Promise(resolve=>window.finishMedia=()=>resolve({id:args.id,created:1,local:'ok',source:'available'}));});
  await p.evaluate(()=>{ModelPreviews.synced();ModelPreviews.wake();});
  await p.waitForFunction(()=>!!ModelPreviews.store.controller);
  await p.evaluate(()=>{window.mediaDone=false;fetchOriginal('manual').then(()=>mediaDone=true);});
  await p.waitForFunction(()=>!ModelPreviews.store.controller);
  const started=requests.length;await p.waitForTimeout(80);assert.equal(requests.length,started);
  release();
  await p.evaluate(()=>{finishMedia();});
  await p.waitForFunction(()=>ModelPreviews.store.complete());
  assert.equal(await p.evaluate(()=>mediaDone),true);
  assert.equal(requests.filter(x=>x==='model-preview/priority/0').length,2,'Interrupted preview resumes after media');
  // Cached images remain readable while hidden; new downloads pause until foreground.
  await p.evaluate(async()=>{hidden=true;prefetchVisibility();const changed={...catalog.listings[0],name:'Hidden.safetensors'};await ModelPreviews.register([changed]);});
  const paused=requests.length;await p.waitForTimeout(80);assert.equal(requests.length,paused);
  await p.evaluate(()=>{hidden=false;prefetchVisibility();});await p.waitForFunction(()=>ModelPreviews.store.complete());
  assert.deepEqual(errors,[]);
  console.log('Device preview cache: library priority and interruption, three-per-listing fairness, restart reuse, persistent 30–120 day staggering, changed-list retention, failed staging, hidden atomic replacement, blob decoding and foreground-only downloads passed.');
 }finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
