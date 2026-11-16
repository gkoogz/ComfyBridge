const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 let imageRequests=0;
 await p.route('**/model-preview/**',r=>{imageRequests++;return r.abort('failed');});
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'startup-test'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(async()=>{
  heartbeat=poll=syncSettings=()=>{};connected=false;window.calls=[];window.failReads=true;
  window.post=id=>({id:String(id),type:'image',credit:'Potter',creatorId:'7',width:300,height:600,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tagsKnown:true,tags:[],stats:{},reactions:[]});
  const feed=Array.from({length:10},(_,i)=>post(i+1)),strip=Array.from({length:20},(_,i)=>post(i+101));
  window.savedStatus={account:'1',username:'Potter',collections:[{id:4,name:'Pottery',count:89}],followingIds:[],bans:[],importState:{complete:true}};
  const cache=await caches.open('comfybridge-browse-v1');
  for(const item of [...feed,...strip])await cache.put('/'+item.path,new Response('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>',{headers:{'Content-Type':'image/svg+xml'}}));
  localStorage.setItem('comfybridge-browse-v2:startup-test',JSON.stringify({account:'1',status:savedStatus,channel:'collection:4',exposureVersion:1,strip,feed,details:[]}));
  localStorage.setItem('comfybridge-browse-v2:startup-test:seen:1',JSON.stringify({seen:feed.map(i=>i.id),pending:[]}));
  window.installAPI=()=>{api=async(route,body)=>{
   calls.push({route,body});
   if(route==='browse/status'){if(failReads)throw Error('HTTP 400: Civitai request failed (HTTP 503). Please retry.');return savedStatus;}
   if(route==='browse/feed')throw Error('HTTP 503: Retry in 5 seconds.');
   if(route==='browse/seen')return {account:'1',seen:[]};
   if(route.startsWith('browse/detail/'))return {account:'1',item:{...post(route.split('/').pop()),detailVersion:2,generationDataAvailable:true,prompt:'A ceramic vase.',resources:[]},collections:[]};
   return {};
  };};installAPI();navigate('browse');
 });
 await p.waitForSelector('.browseTile',{timeout:1500});
 assert.equal(await p.locator('.browseTile').count(),10,'Seen cache must remain as startup fallback');
 assert.equal(await p.locator('.browseThumb').count(),20,'Collection survives offline relaunch');
 await p.waitForFunction(()=>document.querySelector('.browseTile img').naturalWidth>0);
 assert(await p.locator('.browseTile img').first().evaluate(i=>i.src.startsWith('blob:')));
 assert.equal(imageRequests,0,'Startup images come from device storage, not the PC');
 assert.equal(await p.evaluate(()=>calls.length),0,'Offline launch must not wait for any API');
 assert.equal(await p.locator('#browseItemCount').textContent(),'89 items');
 // The PC reconnects while ComfyUI catalogue loading is still busy.
 await p.evaluate(()=>{catalogLoading=true;connection(true);});
 await p.waitForFunction(()=>calls.some(c=>c.route==='browse/status'),null,{timeout:1500});
 assert.equal(await p.locator('.browseTile').count(),10);
 assert(!/HTTP|503|400/.test(await p.locator('#browseError').textContent()));
 assert(!(await p.locator('#browseError').evaluate(e=>e.classList.contains('warning'))));
 await p.evaluate(()=>failReads=false);
 await p.waitForFunction(()=>calls.filter(c=>c.route==='browse/status').length>=2,null,{timeout:8000});
 assert((await p.evaluate(()=>calls.filter(c=>c.route==='browse/status').length))<=3,'Retries must back off');
 // Explicit refresh failure cannot destroy visible items or the durable stash.
 await p.locator('#browseRefresh').click();await p.waitForTimeout(200);
 assert.equal(await p.locator('.browseTile').count(),10);
 assert.equal(await p.locator('.browseThumb').count(),20);
 const stash=await p.evaluate(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:startup-test:stash')));
 assert.equal(stash.feed.length,10);assert.equal(stash.collections['collection:4'].length,20);
 // Simulate the old bug: an empty/oversized main snapshot. The image-backed stash is independent.
 await p.evaluate(()=>{localStorage.removeItem('comfybridge-browse-v2:startup-test');});
 await p.reload();await p.waitForSelector('#connect');
 await p.evaluate(()=>{heartbeat=poll=syncSettings=()=>{};connected=false;api=async()=>{throw Error('No network allowed');};navigate('browse');});
 await p.waitForSelector('.browseTile',{timeout:1500});
 assert.equal(await p.locator('.browseTile').count(),10);assert.equal(await p.locator('.browseThumb').count(),20);
 await p.waitForFunction(()=>document.querySelector('.browseTile img').naturalWidth>0);
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Startup cache: offline/seen fallback, 20 collection previews, decoded local images, immediate reconnect independent of catalogue, quiet 503 retry, failed refresh preservation and independent stash recovery passed on phone/desktop.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
