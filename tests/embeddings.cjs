const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><rect width="160" height="240" fill="#527e6e"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(async()=>{heartbeat=poll=syncSettings=()=>{};persist=()=>{};connected=true;
  window.items=[{id:'a'.repeat(32),kind:'embeddings',name:'pottery.safetensors',title:'Pottery',baseModel:'SDXL',images:[0,1,2].map(n=>({path:'model-preview/'+'a'.repeat(32)+'/'+n,width:160,height:240}))},
   {id:'b'.repeat(32),kind:'embeddings',name:'old.pt',title:'Legacy',baseModel:'SD 1.5',images:[]},
   {id:'c'.repeat(32),kind:'checkpoints',name:'studio.safetensors',title:'Studio',baseModel:'SDXL',images:[]}];
  catalog={models:['studio.safetensors'],loras:[],listings:items,defaults:{video:{loras:[]}},videoModels:[]};
  state.settings.image={width:512,height:768,steps:4,cfg:5,denoise:1,model:'studio.safetensors',positive:'Before after',negative:'blur',loras:[],seed:'1'};
  state.settings.video={...structuredClone(state.settings.image),model:'H3',frames:40,fps:12};
  api=async route=>route==='model-library'?{items,nsfwHidden:false}:route.startsWith('embedding-search')?{items:[{id:'d'.repeat(32),kind:'embedding_remote',name:'new.safetensors',title:'New Pottery',baseModel:'SDXL',versionId:99,modelId:9,images:[]}]}:{};
  ModelPreviews.synced();await ModelPreviews.start(catalog);navigate('image');
 });
 const field=p.locator('textarea[data-setting=positive]');
 await field.evaluate(el=>{el.focus();el.setSelectionRange(7,7);el.dispatchEvent(new Event('select'));});
 await p.locator('[data-embeddings=positive]').click();await p.waitForSelector('.modelCard');
 assert.equal(await p.locator('.modelCard').count(),1);
 await p.waitForFunction(()=>document.querySelectorAll('.modelSamples img').length===3,'Embedding previews use the persistent device cache');
 assert.equal(await p.locator('[data-embedding-insert]:disabled').count(),0,'Incompatible SD1 embedding is not offered');
 await p.locator('[data-embedding-insert][data-target=positive]').first().click();
 assert.equal(await p.evaluate(()=>state.settings.image.positive),'Before (embedding:pottery.safetensors:1.0)after');
 await p.locator('#modalClose').click();
 const rich=p.locator('.embeddingEditor').first();await rich.getByRole('button',{name:/Increase strength/}).click();
 assert.match(await p.evaluate(()=>state.settings.image.positive),/:1\.1/);
 if(process.env.EMBEDDING_SHOT)await p.screenshot({path:process.env.EMBEDDING_SHOT});
 await rich.getByRole('button',{name:/Decrease strength/}).click();
 // Ordinary typing on both sides, delete adjacent to token, then whole selection deletion.
 await rich.evaluate(el=>{el.focus();const r=document.createRange();r.setStartAfter(el.querySelector('.embeddingBlock'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});
 await p.keyboard.press('Backspace');assert.equal(await rich.locator('.embeddingBlock').count(),1);
 await p.keyboard.type('left ');assert.match(await p.evaluate(()=>state.settings.image.positive),/left \(embedding:/);
 await rich.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
 await p.keyboard.press('Backspace');assert.equal(await rich.locator('.embeddingBlock').count(),1);assert.equal(await p.evaluate(()=>state.settings.image.positive),'(embedding:pottery.safetensors:1.0)');
 // Android non-cancellable deletion still restores protected chips.
 await rich.evaluate(el=>{el.replaceChildren(document.createTextNode('new text'));el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));});
 assert.equal(await rich.locator('.embeddingBlock').count(),1);
 await p.locator('[data-expand=positive]').click();await p.waitForSelector('.fullEmbeddingEditor .embeddingBlock');
 await p.locator('.fullEmbeddingEditor').getByRole('button',{name:/Increase strength/}).click();
 await p.locator('#applyPrompt').click();await p.waitForFunction(()=>document.querySelector('.embeddingStrength')?.textContent==='1.1');
 assert.match(await p.evaluate(()=>state.settings.image.positive),/:1\.1/,'Fullscreen edits persist');
 await p.locator('.embeddingEditor').first().getByRole('button',{name:/Remove embedding/}).click();
 assert(!await p.evaluate(()=>state.settings.image.positive.includes('embedding:')));
 await p.locator('[data-embeddings=negative]').click();await p.locator('[data-embedding-insert][data-target=negative]').first().click();
 assert.match(await p.evaluate(()=>state.settings.image.negative),/embedding:pottery/);
 await p.locator('#modelSearch').fill('New');await p.locator('#embeddingFind').click();await p.waitForSelector('[data-civi-download="99"]');
 assert.match(await p.locator('.modelCard').innerText(),/New Pottery/);
 await p.locator('#modalClose').click();await p.evaluate(()=>navigate('video'));await p.locator('[data-embeddings=positive]').click();
 assert.equal(await p.locator('[data-embedding-insert]').count(),0,'H3 does not offer incompatible embeddings');
 await p.locator('#modalClose').click();await p.evaluate(()=>navigate('image'));await p.setViewportSize({width:1280,height:900});
 assert(await p.locator('.embeddingEditor').last().evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 assert.deepEqual(errors,[]);console.log('Embeddings: installed/remote browser, compatibility, exact inline insertion, strength, deletion protection, IME fallback, fullscreen persistence and both prompts passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
