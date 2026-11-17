const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route(/\/(local|thumb)\//,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768"/>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=watchFrames=syncShelf=async()=>{};persist=()=>{};connected=true;queueProtocol=20;imagePreviewProtocol=true;
  catalog={remacriSupported:true,models:['Pottery'],loras:[],samplers:['euler'],defaults:{image:{sampler:'euler',clipSkip:2}}};
  state.settings.image={width:512,height:768,steps:20,cfg:5,denoise:.75,scale:0,model:'Pottery',positive:'Blue pottery',negative:'blur',loras:[],seed:'123',increment:true,batch:4};
  state.inputs.image={data:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"/>',width:1024,height:1536,mask:'mask-fixture'};
  library=[];jobs=[];queueHistory=[];active=null;state.pendingByKind={};window.sent=[];window.uploads=[];window.messages=[];toast=t=>messages.push(t);
  api=async(route,body)=>{if(route==='upload'){uploads.push(body.data);return {name:'ComfyBridge/test.png'};}if(route==='generate'){sent.push(structuredClone(body));return {batch:body.requestId,ids:['new-upscale']};}return {};};navigate('image');
 });
 for(const width of [320,390,1440]){
  await p.setViewportSize({width,height:844});
  await p.evaluate(()=>{const panel=$('#upload').closest('.foldPanel');if(panel.classList.contains('folded'))$('.foldToggle',panel).click();});
  const layout=await p.evaluate(()=>{const a=$('#maskButton').getBoundingClientRect(),u=$('#upscaleRemacri').getBoundingClientRect(),c=$('#clearUpload').getBoundingClientRect(),d=$('.imageSourceInfo').getBoundingClientRect();return{a:a.top,u:u.top,c:c.top,right:c.right,infoRight:d.right,infoTop:d.top,bottom:c.bottom,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.equal(layout.a,layout.u);assert.equal(layout.a,layout.c);assert(Math.abs(layout.right-layout.infoRight)<1);assert(layout.infoTop>=layout.bottom);assert(!layout.overflow);
 }
 await p.locator('#upscaleRemacri').click();
 const s=await p.evaluate(()=>({sent,uploads,settings:state.settings.image,selection:liveSelection,mask:state.inputs.image.mask}));
 assert.equal(s.sent.length,1);assert.equal(s.sent[0].count,1);assert.equal(s.sent[0].settings.operation,'remacri4x');assert.equal(s.sent[0].settings.width,4096);assert.equal(s.sent[0].settings.height,6144);
 assert.equal(s.uploads.length,1);assert.equal(s.settings.model,'Pottery');assert.equal(s.settings.positive,'Blue pottery');assert.equal(s.settings.seed,'123');assert.equal(s.mask,'mask-fixture');assert.equal(s.selection.width,4096);
 await p.evaluate(()=>{state.inputs.image.width=4096;state.inputs.image.height=6144;});await p.locator('#upscaleRemacri').click();assert.equal(await p.evaluate(()=>sent.length),1);assert.match(await p.evaluate(()=>messages.at(-1)),/40 megapixels/);
 await p.evaluate(()=>{
  readStartingImage=async()=>({data:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',width:512,height:768});fetch=async()=>({ok:true,blob:async()=>new Blob()});
  const item={id:'fixture',job:'fixture-job',kind:'image',local:'hash'};library=[item];window.testItem=item;
  $('#main').append(resultActions(item,true));
 });
 assert(await p.getByRole('button',{name:'Upscale',exact:true}).last().isDisabled());
 await p.evaluate(()=>{$$('.resultActions').forEach(e=>e.remove());$('#main').append(...inputActions(testItem));});
 await p.getByRole('button',{name:'Upscale',exact:true}).click();assert.equal(await p.evaluate(()=>page),'image');assert.equal(await p.evaluate(()=>state.inputs.image.width),512);assert.equal(await p.evaluate(()=>state.settings.image.sourceMedia),'fixture');
 assert.deepEqual(errors,[]);console.log('Remacri UI passed: 320/390/1440 layout, single durable submission, original settings/mask retained, size guard, pending action disabled and image handoff.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

