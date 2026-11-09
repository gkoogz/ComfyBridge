const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="250"><rect width="200" height="250" fill="#638d89"/><circle cx="100" cy="125" r="55" fill="#e1c9a8"/></svg>'}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>'',copyText:text=>window.copied=text,openListing:url=>window.opened=url});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=()=>{};persist=()=>{};connected=true;
   window.items=[['checkpoints','raw-a.safetensors','Ceramic Realism'],['checkpoints','raw-b.safetensors','Watercolor Studio'],['loras','raw-lora.safetensors','Ceramic Detail'],['loras','second.safetensors','Warm Lighting']].map(([kind,name,title],i)=>({id:String(i),kind,name,title,version:'v2',author:'Studio Artist',bytes:456000000,sha256:'a'.repeat(64),baseModel:'SDXL',keywords:['ceramic glaze'],description:'Author description with useful details.\nSecond paragraph. <script>should stay text</script>',source:'Civitai',sourceUrl:'https://civitai.com/models/123',match:'Exact SHA-256 file match',images:[0,1,2].map(n=>({path:'model-preview/'+i+'/'+n}))}));
   catalog={models:['raw-a.safetensors','raw-b.safetensors'],loras:['raw-lora.safetensors','second.safetensors'],listings:items};
   state.settings.image={width:512,height:768,steps:4,cfg:5,denoise:1,model:'raw-a.safetensors',positive:'A pottery studio.',negative:'',loras:[{name:'raw-lora.safetensors',strength:1,enabled:true}],seed:'1',batch:1};
   api=async route=>{if(route==='model-library')return {items,scanning:false};return {};};
   navigate('image');
  });
  await p.locator('#checkpointBrowser').click();await p.waitForSelector('.modelCard');
  assert.equal(await p.locator('.modelCard').count(),2);assert.equal(await p.locator('.modelSamples img').count(),6);
  assert.match(await p.locator('#modelNsfwNote').textContent(),/NSFW previews are hidden/);
  assert.equal(await p.locator('.modelCard .modelNsfwNote').count(),2);
  await p.locator('.modelSamples img').first().evaluate(img=>img.decode());
  assert.equal(await p.locator('.modelCard details[open]').count(),0);
  await p.locator('.modelCard summary').first().click();assert(await p.locator('.modelDescription').first().isVisible());
  await p.locator('[data-model-use]').nth(1).check();
  assert.equal(await p.evaluate(()=>state.settings.image.model),'raw-b.safetensors');assert.equal(await p.locator('[data-model-use]:checked').count(),1);
  await p.locator('#modelSearch').fill('Watercolor');assert.equal(await p.locator('.modelCard').count(),1);
  await p.locator('[data-model-source]').click();assert.equal(await p.evaluate(()=>opened),'https://civitai.com/models/123');
  await p.locator('[data-model-keywords]').click();assert.equal(await p.evaluate(()=>copied),'ceramic glaze');
  if(process.env.MODEL_SHOT)await p.screenshot({path:process.env.MODEL_SHOT});
  assert(await p.evaluate(()=>document.querySelector('#modalBody').scrollWidth<=document.querySelector('#modalBody').clientWidth));
  await p.locator('#modalClose').click();await p.locator('#addLora').click();
  await p.waitForSelector('.modelAdd');assert.equal(await p.locator('.modelAdd:disabled').count(),1);
  await p.locator('.modelAdd:not(:disabled)').click();assert.equal(await p.evaluate(()=>state.settings.image.loras.length),2);
  assert.equal(await p.locator('.modelAdd:disabled').count(),2);
  await p.locator('#modalClose').click();await p.locator('[data-see-lora]').first().click();
  assert.equal(await p.locator('.modelCard').count(),1);assert.match(await p.locator('.modelCard h2').textContent(),/Ceramic Detail/);
  assert.equal(await p.locator('[data-setting=model]').inputValue(),'raw-b.safetensors');
  await p.locator('#modalClose').click();
  await p.evaluate(()=>{api=async route=>{if(route==='model-library')return {items,scanning:false,nsfwHidden:false};return {};};});
  await p.locator('#checkpointBrowser').click();
  await p.waitForFunction(()=>document.querySelector('#modelNsfwNote')?.hidden===true);
  assert.equal(await p.locator('.modelCard .modelNsfwNote').count(),0);
  assert.deepEqual(errors,[]);console.log('Model browser: proper titles, samples, descriptions, exclusive checkpoint selection, keyword/source actions, LoRA duplicate prevention and See Listing passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
