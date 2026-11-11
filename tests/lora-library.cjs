const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  p.on('pageerror',error=>errors.push(error.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#638d89"/></svg>'}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(async()=>{
   heartbeat=poll=syncSettings=()=>{};persist=section=>window.saved=section;connected=true;window.calls=[];window.transfers={};
   window.items=[['checkpoints','Pottery','Pottery Studio',10],['loras','Glaze','Ceramic Glaze',11],['loras','Light','Warm Light',22]].map(([kind,name,title,versionId],i)=>({id:String(i).repeat(32),kind,name:name+'.safetensors',title,version:'v2',versionId,modelId:8,source:'Civitai',sourceUrl:'https://civitai.com/models/8',keywords:[' ceramic glaze, ',' warm light '],baseModel:'SDXL',images:[0,1,2].map(n=>({id:String(100+i*3+n),source:'https://image.civitai.com/'+i+n,path:'model-preview/'+i+'/'+n,width:240,height:360,resources:[{name:'Ceramic Glaze',type:'lora',versionId:'11',modelId:'8',weight:.6},{name:'New Pottery Detail',type:'lora',versionId:'99',modelId:'9',weight:.8}],prompt:'A ceramic bowl.'}))}));
   catalog={models:['Pottery.safetensors'],loras:['Glaze.safetensors','Light.safetensors'],listings:items,defaults:{video:{loras:[{name:'turbo',strength:1,locked:true}]}},videoModels:[]};
   state.settings.image={width:512,height:768,steps:4,cfg:5,denoise:1,model:'Pottery.safetensors',positive:'A bowl, ',negative:'blur',loras:[{name:'Glaze.safetensors',strength:.6,enabled:true}],seed:'1',batch:1};
   state.settings.video={...structuredClone(state.settings.image),model:'Video model',frames:40,fps:12,scale:0,positive:'A turning bowl, '};
   api=async(route,body)=>{
    calls.push({route,body});
    if(route==='model-library')return {items,nsfwHidden:false,scanning:false};
    if(route==='model-library/archive'){const item=items.find(i=>i.id===body.id);item.archived=body.archived;return body;}
    if(route==='lora-download/status')return Object.fromEntries(body.versions.map(v=>[v,v==='11'?{status:'installed',name:'Glaze.safetensors'}:transfers[v]||{status:'available'}]));
    if(route==='lora-download/prepare/99')return {status:'confirm',confirmation:'confirmed-plan',versionId:'99',title:'New Pottery Detail',version:'v3',baseModel:'SDXL',bytes:131072,filename:'NewPottery.safetensors',destination:'E:\\ComfyUI-Zluda\\models\\loras'};
    if(route==='lora-download/start'){if(body.confirmation!=='confirmed-plan')throw Error('Missing confirmation');return transfers['99']={status:'downloading',received:0,total:131072};}
    return {};
   };
   ModelPreviews.synced();await ModelPreviews.start(catalog);navigate('image');
  });
  await p.locator('#checkpointBrowser').click();await p.waitForSelector('[data-model-insert]');
  for(const prompt of ['', 'A bowl', 'A bowl, ', 'A bowl,, \n']){
   await p.evaluate(text=>state.settings.image.positive=text,prompt);await p.locator('[data-model-insert]').click();
   const expected=(prompt.trim()? 'A bowl, ':'')+'ceramic glaze, warm light';
   assert.equal(await p.evaluate(()=>state.settings.image.positive),expected);assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),expected);
   assert.equal(await p.evaluate(()=>saved),'image');
  }
  await p.locator('#modalClose').click();await p.locator('#addLora').click();await p.waitForSelector('#modelArchiveLink');
  assert.equal(await p.locator('.modelCard').count(),2);
  await p.locator('.modelCard').filter({has:p.getByRole('heading',{name:'Warm Light',exact:true})}).getByRole('button',{name:'Archive',exact:true}).click();
  assert.equal(await p.locator('.modelCard').count(),1);
  assert.deepEqual(await p.evaluate(()=>state.settings.image.loras),[{name:'Glaze.safetensors',strength:.6,enabled:true}]);
  await p.locator('#modelArchiveLink').click();assert.match(await p.locator('#modalTitle').textContent(),/Archive/);
  assert.equal(await p.locator('.modelCard').count(),1);assert.match(await p.locator('.modelCard h2').textContent(),/Warm Light/);
  await p.getByRole('button',{name:'Unarchive',exact:true}).click();assert.equal(await p.locator('.modelCard').count(),0);
  await p.locator('#modelArchiveLink').click();assert.equal(await p.locator('.modelCard').count(),2);
  await p.locator('#modalClose').click();await p.evaluate(()=>navigate('video'));await p.locator('#addLora').click();await p.waitForSelector('[data-model-insert]');
  await p.locator('[data-model-insert]').first().click();assert.equal(await p.evaluate(()=>state.settings.video.positive),'A turning bowl, ceramic glaze, warm light');assert.equal(await p.evaluate(()=>saved),'video');
  await p.locator('#modalClose').click();await p.evaluate(()=>navigate('image'));await p.locator('[data-see-lora]').first().click();await p.waitForSelector('.modelSample');
  await p.locator('.modelSample').first().click();await p.waitForSelector('#modelPreviewViewer');
  const existing=p.locator('[data-resource-download="11"]'),download=p.locator('[data-resource-download="99"]');
  await p.waitForFunction(()=>document.querySelector('[data-resource-download="99"]')?.disabled===false);
  assert.equal(await existing.isDisabled(),true);assert.equal(await existing.getAttribute('aria-label'),'LoRA already in your library');
  const geometry=await download.boundingBox();assert(geometry.width>=36&&geometry.height>=36);
  await download.click();await p.waitForSelector('.resourceDownloadConfirm');
  assert.match(await p.locator('.resourceDownloadConfirm').innerText(),/New Pottery Detail.*SDXL.*0\.1 MB/s);
  assert(!await p.evaluate(()=>calls.some(c=>c.route==='lora-download/start')),'No transfer before confirmation');
  await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await p.locator('.resourceDownloadConfirm').count(),0);
  await download.click();await p.waitForSelector('.resourceDownloadConfirm');await p.getByRole('button',{name:'Download to PC',exact:true}).click();
  assert.equal(await download.isDisabled(),true);assert.equal(await download.locator('.spinner').count(),1);
  await p.evaluate(()=>{transfers['99']={status:'installed',name:'NewPottery.safetensors'};items.push({id:'f'.repeat(32),kind:'loras',name:'NewPottery.safetensors',title:'New Pottery Detail',versionId:99,images:[]});});
  await p.waitForFunction(()=>document.querySelector('[data-resource-download="99"]')?.getAttribute('aria-label')==='LoRA already in your library');
  assert.equal(await download.locator('.spinner').count(),0);assert.equal(await download.locator('svg').count(),1);
  assert(await p.evaluate(()=>catalog.loras.includes('NewPottery.safetensors')));
  assert(!await p.evaluate(()=>state.settings.image.loras.some(l=>l.name==='NewPottery.safetensors')),'Downloading does not silently enable the new LoRA');
  if(process.env.LORA_LIBRARY_SHOT)await p.screenshot({path:process.env.LORA_LIBRARY_SHOT});
  assert.deepEqual(errors,[]);
  console.log('LoRA library: clean keyword insertion in Image/Video, archive/unarchive navigation, unchanged active LoRAs, installed pre-check, download confirmation/cancel, spinner/check states and new catalogue availability passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
