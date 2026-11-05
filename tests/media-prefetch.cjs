const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'test',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=notice=showShelf=()=>{};
   window.hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
   window.calls=[];window.requests=[];window.transfers=new Map();window.wire=[];window.autoActive=0;window.maxAuto=0;
   window.fixture=(n,local='')=>({id:String(n).padStart(32,'0'),created:n,local,source:'available',kind:n%2?'video':'image',archived:n%3===0,recent:true});
   Native.prefetchEnabled=value=>calls.push({enabled:value});
   local=async(op,args={})=>{
    calls.push({op,id:args.id});
    if(op==='sync')return structuredClone(args.items);
    if(!['prefetch','fetch'].includes(op))throw Error('Unexpected operation: '+op);
    if(op==='prefetch')maxAuto=Math.max(maxAuto,++autoActive);
    try{return await new Promise((resolve,reject)=>transfers.set(args.id,{resolve,reject,op}));}
    finally{transfers.delete(args.id);if(op==='prefetch')autoActive--;}
   };
   api=async route=>{requests.push(route);if(route==='library')return wire;if(route==='media-index')return {version:1,items:wire};throw Error('Unexpected API: '+route);};
   window.finish=(n,error='')=>{const id=fixture(n).id,t=transfers.get(id);if(!t)throw Error('No transfer '+n);error?t.reject(Error(error)):t.resolve({...library.find(j=>j.id===id),local:'verified'});};
   window.reset=()=>{if(transfers.size)throw Error('Unfinished transfers');calls=[];requests=[];wire=[];library=[];inventory='';nextSync=nextInventoryProbe=prefetchAfter=0;prefetchRetry.clear();shelfError='';connected=true;hidden=false;window.Desktop=false;page='bridge';};
   reset();
   // Newest 20 across both media types and archive, not the first 20 missing files.
   wire=Array.from({length:25},(_,i)=>fixture(25-i,[25,23].includes(25-i)?'cached':''));
   syncShelf(true);
  });
  await p.waitForFunction(()=>transfers.has(fixture(24).id));
  assert.equal(await p.evaluate(()=>page),'bridge');
  assert.deepEqual(await p.evaluate(()=>requests),['media-index']);
  // An explicit older item doesn't wait behind an automatic transfer.
  await p.evaluate(()=>{window.manual=fetchOriginal(fixture(1).id);window.shared=fetchOriginal(fixture(24).id);});
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.id===fixture(24).id).length),1);
  assert(await p.evaluate(()=>transfers.get(fixture(1).id).op==='fetch'&&transfers.get(fixture(24).id).op==='prefetch'));
  await p.evaluate(()=>{finish(1);finish(24);});
  for(let n=22;n>=6;n--){await p.waitForFunction(n=>transfers.has(fixture(n).id),n);await p.evaluate(n=>finish(n),n);}
  await p.waitForFunction(()=>!filling);
  assert.equal(await p.evaluate(()=>maxAuto),1);
  assert.deepEqual(await p.evaluate(()=>calls.filter(c=>c.op==='prefetch').map(c=>Number(c.id))),[24,...Array.from({length:17},(_,i)=>22-i)]);
  // A completion is discovered on Notepad, without ever visiting Library.
  await p.evaluate(()=>{wire=structuredClone(library);wire.unshift(fixture(26));page='notepad';nextInventoryProbe=0;checkNewMedia();});
  await p.waitForFunction(()=>transfers.has(fixture(26).id));
  assert.equal(await p.evaluate(()=>page),'notepad');
  await p.evaluate(()=>finish(26));await p.waitForFunction(()=>!filling);
  // New arrivals take priority after the current file; older candidates leave the window.
  await p.evaluate(()=>{reset();setShelf(Array.from({length:21},(_,i)=>fixture(21-i)));fillShelf();});
  await p.waitForFunction(()=>transfers.has(fixture(21).id));
  await p.evaluate(()=>{updateItem(fixture(22));finish(21);});
  await p.waitForFunction(()=>transfers.has(fixture(22).id));
  // Native cancellation on pause is reflected in JS: no next file and no retry delay on resume.
  await p.evaluate(()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));finish(22,'Prefetch paused.');});
  await p.waitForFunction(()=>!filling);
  assert.equal(await p.evaluate(()=>transfers.size),0);
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.enabled!==undefined).at(-1).enabled),false);
  const paused=await p.evaluate(()=>calls.filter(c=>c.op==='prefetch').length);
  await p.evaluate(()=>{fillShelf();nextInventoryProbe=0;checkNewMedia();});
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.op==='prefetch').length),paused);
  await p.evaluate(()=>{hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await p.waitForFunction(()=>transfers.has(fixture(22).id));await p.evaluate(()=>finish(22));
  for(let n=20;n>=3;n--){await p.waitForFunction(n=>transfers.has(fixture(n).id),n);await p.evaluate(n=>finish(n),n);}
  await p.waitForFunction(()=>!filling);
  assert(!await p.evaluate(()=>calls.some(c=>c.op==='prefetch'&&Number(c.id)<3)));
  // Low storage backs off the whole lane; disconnect and Desktop never initiate prefetch.
  await p.evaluate(()=>{reset();setShelf([fixture(2),fixture(1)]);fillShelf();finish(2,'Phone storage is too low. Existing copies were kept.');});
  await p.waitForFunction(()=>!filling);await p.evaluate(()=>fillShelf());
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.op==='prefetch').length),1);
  await p.evaluate(()=>{reset();setShelf([fixture(1)]);connected=false;fillShelf();connected=true;window.Desktop=true;fillShelf();});
  assert.equal(await p.evaluate(()=>transfers.size),0);
  assert.deepEqual(errors,[]);
  console.log('Startup/Bridge and Notepad prefetch, newest-20 bound, cached skips, single automatic lane, explicit priority, deduplication, new-result priority, pause/resume, storage backoff and Desktop bypass passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
