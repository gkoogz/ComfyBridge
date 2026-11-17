const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};drawer(false);window.phase='available';window.starts=0;window.firstStatus=true;
  window.plan={status:'confirm',confirmation:'test',versionId:'7',title:'Pottery',version:'V1',bytes:1024,filename:'pottery.safetensors'};
  api=async(route,body)=>{
   if(route==='lora-download/status'){if(firstStatus){firstStatus=false;await new Promise(r=>window.releaseStatus=r);}return {'7':{status:phase}};}
   if(route==='lora-download/prepare/7')return new Promise((resolve,reject)=>{window.prepareOK=()=>resolve(plan);window.prepareFail=()=>reject(Error('Listing temporarily unavailable'));});
   if(route==='lora-download/start'){starts++;return new Promise(resolve=>window.startOK=()=>{phase='downloading';resolve({status:phase});});}
   if(route==='model-library')return {items:[]};return {};
  };
  document.querySelector('#main').innerHTML=CivitaiBrowser.resourcesHTML([{name:'Pottery',type:'LORA',versionId:'7'}]);
  CivitaiBrowser.wireResources(document.querySelector('#main'));
 });
 const b=p.locator('[data-civi-download="7"]');
 await b.click();assert.equal(await b.locator('.spinner').count(),1);assert(await b.isDisabled());
 await p.evaluate(()=>releaseStatus());await p.waitForTimeout(60);
 assert.equal(await b.locator('.spinner').count(),1,'Late initial status must not erase preparation feedback');
 await p.evaluate(()=>prepareOK());await p.waitForSelector('[data-reject-download]');
 assert.equal(await p.evaluate(()=>starts),0);
 await p.locator('[data-reject-download]').click();assert(await b.isEnabled());assert.equal(await b.locator('.spinner').count(),0);
 await b.click();await p.evaluate(()=>prepareFail());await p.waitForFunction(()=>document.querySelector('[data-civi-download]').disabled===false);
 assert.match(await p.locator('[data-download-status]').textContent(),/temporarily unavailable/);
 await b.click();assert.equal(await b.locator('.spinner').count(),1);await p.evaluate(()=>prepareOK());
 await p.locator('[data-accept-download]').click();assert.equal(await b.locator('.spinner').count(),1);assert.equal(await b.getAttribute('aria-busy'),'true');
 await p.evaluate(()=>startOK());await p.waitForTimeout(50);assert.equal(await b.locator('.spinner').count(),1);
 await p.evaluate(()=>phase='installed');await p.waitForFunction(()=>document.querySelector('[data-civi-download]').getAttribute('aria-label')==='LoRA already in your library');
 assert.equal(await b.locator('.spinner').count(),0);assert.equal(await b.locator('svg').count(),1);assert(await b.isDisabled());
 assert.deepEqual(errors,[]);console.log('Browse download: immediate preparation/start spinner, stale-status race, confirmation/cancel, error retry and installed check passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
