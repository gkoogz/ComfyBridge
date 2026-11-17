const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  catalog={models:['studio.safetensors',kreaModel],loras:['ceramic.safetensors','krea2_ink.safetensors'],samplers:['euler','euler_ancestral'],defaults:{image:{model:'studio.safetensors'},video:{loras:[]}},listings:[
   {id:'a',kind:'checkpoints',name:'studio.safetensors',baseModel:'SDXL',images:[]},
   {id:'b',kind:'loras',name:'ceramic.safetensors',baseModel:'SDXL',images:[]},
   {id:'c',kind:'loras',name:'krea2_ink.safetensors',baseModel:'Krea 2',images:[]},
   {id:'d',kind:'embeddings',name:'pottery.safetensors',baseModel:'SDXL',images:[]}]};
  state.settings.image={width:1024,height:1536,model:'studio.safetensors',positive:'A bowl (embedding:pottery:1.2)',negative:'blur',loras:[{name:'ceramic.safetensors',strength:.7}],steps:24,cfg:6,clipSkip:2,sampler:'euler_ancestral',seed:'777',denoise:.5,batch:2};
  state.inputs.image={data:'data:image/png;base64,saved-source',width:1024,height:1536};
  window.original=structuredClone({settings:state.settings.image,inputs:state.inputs.image});
  api=async route=>route==='model-library'?{items:catalog.listings,nsfwHidden:false}:{};navigate('image');
 });
 await p.locator('[data-setting=model]').selectOption('krea2_turbo_bf16.safetensors');
 assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),'');
 assert.equal(await p.locator('textarea[data-setting=negative]').count(),0);
 assert.equal(await p.locator('[data-embeddings]').count(),0);
 assert.equal(await p.locator('[data-setting=clipSkip]').count(),0);
 assert.equal(await p.locator('[data-setting=steps]').count(),0);
 assert.match(await p.locator('.kreaSettings').innerText(),/8 steps/);
 assert.deepEqual(await p.evaluate(()=>state.inputs.image),{});
 assert.equal(await p.evaluate(()=>state.settings.image.loras.length),0);
 await p.locator('textarea[data-setting=positive]').fill('An ink drawing of a teapot.');
 if(!await p.locator('#addLora').isVisible())await p.getByRole('button',{name:'LoRAs',exact:true}).click();await p.locator('#addLora').click();await p.waitForSelector('.modelCard');
 assert.equal(await p.locator('.modelCard').count(),1);assert.match(await p.locator('.modelCard').innerText(),/krea2_ink/);
 await p.locator('[data-model-add]').click();await p.locator('#modalClose').click();
 await p.locator('[data-setting=model]').selectOption('studio.safetensors');
 assert.deepEqual(await p.evaluate(()=>({settings:state.settings.image,inputs:state.inputs.image})),await p.evaluate(()=>original));
 if(!await p.locator('#addLora').isVisible())await p.getByRole('button',{name:'LoRAs',exact:true}).click();await p.locator('#addLora').click();await p.waitForSelector('.modelCard');assert.equal(await p.locator('.modelCard').count(),1);assert.match(await p.locator('.modelCard').innerText(),/ceramic/);
 await p.locator('#modalClose').click();
 await p.locator('[data-setting=model]').selectOption('krea2_turbo_bf16.safetensors');
 assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),'An ink drawing of a teapot.');
 assert.equal(await p.evaluate(()=>state.settings.image.loras[0].name),'krea2_ink.safetensors');
 assert(await p.evaluate(()=>backupState().imageFamilies.sdxl.settings.positive.includes('embedding:pottery')));
 // Model family slots prevent a proposal in one editor from appearing in the other.
 await p.evaluate(()=>{quickSlots['image:positive']={phase:'editing',text:'Keep the blue glaze'};});
 assert.equal(await p.evaluate(()=>quickSlots[quickSlot('image','positive')]),undefined);
 await p.waitForTimeout(200);await p.reload();await p.waitForSelector('#connect');
 assert.equal(await p.evaluate(()=>state.settings.image.model),'krea2_turbo_bf16.safetensors');
 assert.equal(await p.evaluate(()=>state.imageFamilies.sdxl.settings.positive),'A bowl (embedding:pottery:1.2)');
 await p.evaluate(()=>{state.imageFamilies.sdxl.settings.seed='1';state.settings.image.seed='1';acceptSubmission({kind:'image',count:2,requestId:'late',settings:{model:'studio.safetensors',seed:'1',increment:true}},{batch:'late'});});
 assert.equal(await p.evaluate(()=>state.settings.image.seed),'1','Late SDXL receipt must not increment the active Krea seed');
 assert.equal(await p.evaluate(()=>state.imageFamilies.sdxl.settings.seed),'3');
 await p.evaluate(()=>{heartbeat=poll=syncSettings=()=>{};connected=true;catalog={models:['studio.safetensors',kreaModel],loras:[],listings:[]};navigate('image');});
 await p.setViewportSize({width:1440,height:1000});
 assert(await p.locator('.kreaSettings').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 assert.deepEqual(errors,[]);console.log('Krea: independent settings/inputs, browser isolation, fixed defaults, quick-edit separation, backup and relaunch passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
