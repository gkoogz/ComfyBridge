const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const paired of [false,true]){
 const p=await browser.newPage({viewport:{width:390,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.addInitScript(paired=>{window.calls=[];window.failPing=true;window.Native={configuration:()=>JSON.stringify({paired,host:paired?'https://saved-pc:15294':'',device:'test'}),notificationRoute:()=>'',localMedia:(id)=>queueMicrotask(()=>bridgeResult(id,true,[])),request:(id,route)=>{calls.push(route);queueMicrotask(()=>bridgeResult(id,route!=='ping'||!failPing,route==='ping'?(failPing?'PC unavailable':{ok:true}):{}));}};},paired);
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 if(!paired){await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>calls.filter(x=>x==='ping').length),0);assert(await p.locator('#drawer').evaluate(e=>e.classList.contains('open')));}
 else {
  await p.waitForFunction(()=>calls.includes('ping')&&!probing);
  assert(await p.evaluate(()=>wanted&&!connected),'Failed launch connection keeps the reconnect loop enabled');
  assert.equal(await p.locator('#drawer').evaluate(e=>e.classList.contains('open')),false,'Saved connection does not force open the sidebar');
  await p.evaluate(async()=>{startProfiles=async()=>{};loadCatalog=poll=syncShelf=checkNewMedia=()=>{};failPing=false;nextProbe=0;await heartbeat();});
  assert(await p.evaluate(()=>connected));
  await p.evaluate(()=>document.querySelector('#connect').click());const count=await p.evaluate(()=>calls.filter(x=>x==='ping').length);
  await p.evaluate(()=>heartbeat());assert.equal(await p.evaluate(()=>calls.filter(x=>x==='ping').length),count,'Explicit disconnect stays disconnected for this session');
 }
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Launch reconnect: saved pairing attempts automatically, offline retries, explicit disconnect respected, new pairing stays manual.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
