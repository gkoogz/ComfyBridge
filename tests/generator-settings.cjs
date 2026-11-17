const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=watchFrames=async()=>{};persist=()=>{};connected=true;queueProtocol=20;imagePreviewProtocol=true;
  catalog={models:['Pottery'],loras:[],samplers:['euler','euler_ancestral','dpmpp_2m'],videoSamplers:['euler','heun'],defaults:{image:{sampler:'euler',clipSkip:2},video:{loras:[]}}};
  for(const kind of ['image','video']){state.settings[kind]={width:512,height:768,frames:40,fps:12,steps:4,cfg:5,denoise:1,scale:0,model:erosModel,positive:'A pottery studio, ',negative:'blur',loras:[],seed:'1',batch:1};state.inputs[kind]={};}
  library=[];jobs=[];queueHistory=[];active=null;state.prompts=[{name:'Light',text:'Soft window light.'}];state.pendingByKind={};window.sent=[];
  api=async(route,body)=>{if(route==='generate'){sent.push(structuredClone(body));return {batch:body.requestId,ids:['new-'+body.kind]};}return {};};navigate('image');
 });
 await p.evaluate(()=>renderBridge());assert(await p.locator('#connect').evaluate(e=>e.classList.contains('stop')));
 assert.equal(await p.locator('[data-prompt-library],.prompttools').count(),0);
 await p.locator('[data-saved-prompts=positive]').click();assert.equal(await p.locator('.savedPromptItem').count(),1);
 await p.locator('[data-insert-saved="0"]').click();assert.equal(await p.evaluate(()=>state.settings.image.positive),'A pottery studio, Soft window light.');
 await p.locator('#savedPromptText').fill('Blue ceramic glaze.');await p.locator('#savePromptText').click();assert.equal(await p.locator('.savedPromptItem').count(),2);
 await p.locator('[data-delete-saved="0"]').click();assert.equal(await p.locator('.savedPromptItem').count(),1);await p.locator('#modalClose').click();
 await p.locator('[data-saved-prompts=negative]').click();await p.locator('[data-insert-saved="0"]').click();assert.equal(await p.evaluate(()=>state.settings.image.negative),'blur, Blue ceramic glaze.');await p.locator('#modalClose').click();
 const settings=p.getByRole('button',{name:'Generation settings',exact:true});if(await settings.getAttribute('aria-expanded')==='false')await settings.click();
 assert.deepEqual(await p.locator('[data-setting=sampler] option').evaluateAll(es=>es.map(e=>e.value)),['euler','euler_ancestral','dpmpp_2m']);
 await p.locator('[data-setting=sampler]').selectOption('euler_ancestral');await p.locator('[data-setting=clipSkip]').fill('3');
 for(const kind of ['image','video']){
  if(kind==='video')await p.evaluate(()=>{navigate('video');state.settings.video.width=768;state.settings.video.height=512;});
  const latest=p.getByRole('button',{name:'Latest result',exact:true});if(await latest.getAttribute('aria-expanded')==='true')await latest.click();
  await p.locator('#play').click();await p.waitForFunction(k=>liveSelection?.id==='new-'+k,kind);
  assert.equal(await latest.getAttribute('aria-expanded'),'true');assert.equal(await p.locator('.inflightThumb').getAttribute('aria-current'),'true');assert(await p.locator('#result .previewBusy').isVisible());
  const ratio=await p.locator('.inflightThumb').evaluate(e=>e.getBoundingClientRect().width/e.getBoundingClientRect().height);assert(Math.abs(ratio-(kind==='image'?2/3:1.5))<.02,String(ratio));
  const hero=await p.locator('.watchGeneration').evaluate(e=>e.getBoundingClientRect().width/e.getBoundingClientRect().height);assert(Math.abs(hero-ratio)<.02);
 }
 assert.equal(await p.evaluate(()=>sent[0].settings.sampler),'euler_ancestral');assert.equal(await p.evaluate(()=>sent[0].settings.clipSkip),3);
 assert.equal(await p.locator('[data-setting=clipSkip]').count(),0);
 assert.deepEqual(errors,[]);console.log('Generator: saved prompt append/save/delete, dynamic sampler choices, clip skip payload, automatic new-job selection and portrait/landscape preview sizing passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
