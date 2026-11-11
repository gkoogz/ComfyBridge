const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  const data=await p.evaluate(()=>{
   const c=document.createElement('canvas');c.width=96;c.height=64;c.getContext('2d').fillRect(0,0,96,64);return c.toDataURL('image/png');
  });
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=async()=>{};persist=()=>{};connected=true;queueProtocol=19;
   for(const kind of ['image','video'])state.settings[kind]={width:64,height:96,scale:0,steps:8,cfg:1,denoise:1,frames:180,fps:18,seconds:10,exactFrames:true,sound:false,
    model:erosModel,positive:'A ceramic bowl rotates.',negative:'',loras:[],seed:'31',batch:1,increment:false};
   state.inputs={image:{},video:{}};catalog={models:[erosModel],loras:[],defaults:{video:{loras:[]}}};window.calls=[];
   api=async(route,body)=>{
    calls.push({route,body});if(route==='upload')return {name:'ComfyBridge/final.png'};
    if(route==='generate')return {batch:body.requestId,ids:['job']};return {};
   };
   navigate('video');
  });
  assert(await p.locator('#uploadFinal').isVisible());assert.equal(await p.locator('#uploadFinal').getAttribute('accept'),'image/*');
  await p.locator('#uploadFinal').setInputFiles({name:'final.png',mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});
  await p.waitForSelector('.finalFrameCard img');
  assert.deepEqual(await p.evaluate(()=>[state.settings.video.width,state.settings.video.height]),[64,96]);
  assert.equal(await p.locator('.finalFrameCard .sourceDims strong').textContent(),'96 × 64');
  assert.match(await p.locator('#mode').textContent(),/FINAL FRAME/);
  await p.locator('#presetButton').click();await p.locator('#savePreset').click();await p.locator('#newName').fill('With final frame');await p.locator('#nameDone').click();
  assert.equal(await p.evaluate(()=>state.presets.video[0].input.finalFrame.width),96);
  await p.locator('#clearFinalFrame').click();await p.waitForFunction(()=>!state.inputs.video.finalFrame);
  assert.equal(await p.locator('.finalFrameCard img').count(),0);
  await p.locator('#presetButton').click();await p.locator('[data-load-preset="0"]').click();await p.waitForSelector('.finalFrameCard img');
  await p.evaluate(()=>setStartingImage('video',{data:state.inputs.video.finalFrame.data,width:64,height:96}));
  await p.evaluate(()=>renderGenerator());
  await p.locator('#clearUpload').click();assert(await p.evaluate(()=>!!state.inputs.video.finalFrame));
  await p.locator('#play').click();await p.waitForFunction(()=>calls.some(c=>c.route==='generate'));
  const submitted=await p.evaluate(()=>calls.find(c=>c.route==='generate').body);
  assert.equal(submitted.settings.finalFrame,'ComfyBridge/final.png');assert.equal(submitted.settings.upload,null);
  assert.equal(submitted.settings.frames,180);assert.equal(submitted.settings.seed,'31');
  assert.equal(await p.evaluate(()=>backupState().inputs.video.finalFrame.width),96);
  await p.locator('#clearFinalFrame').click();await p.waitForFunction(()=>!state.settings.video.finalFrame);
  await p.evaluate(()=>{calls=[];});await p.locator('#play').click();await p.waitForFunction(()=>calls.some(c=>c.route==='generate'));
  assert.equal(await p.evaluate(()=>calls.find(c=>c.route==='generate').body.settings.finalFrame),undefined);
  await p.evaluate(()=>navigate('image'));assert.equal(await p.locator('#uploadFinal').count(),0);
  assert.deepEqual(errors,[]);
  console.log('Final frame: optional image field, unchanged canvas, independent clear, preset/backup persistence, exact submission and video-only visibility passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
