const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:370,height:740}});
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   window.poll=window.heartbeat=window.syncSettings=async()=>{};window.persist=()=>{};
   for(const kind of ['image','video']){
    state.settings[kind]={width:256,height:384,scale:0,steps:4,cfg:1,denoise:1,frames:22,fps:24,
     model:'test',positive:'Long prompt. '.repeat(80),negative:'Avoid these. '.repeat(60),loras:[],seed:'1',batch:1};
   }
  });
  for(const kind of ['image','video']){
   await p.evaluate(kind=>navigate(kind),kind);
   for(const key of ['positive','negative']){
    const field=p.locator('textarea[data-setting='+key+']'),toggle=p.locator('[data-prompt-height='+key+']');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await field.evaluate(el=>el.offsetHeight),118);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert(await field.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    await toggle.click();
    assert.equal(await field.evaluate(el=>el.offsetHeight),118);
    await field.fill('New line\n'.repeat(18));
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert(await field.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    assert.equal(await field.evaluate(el=>getComputedStyle(el).resize),'vertical');
    await p.evaluate(()=>renderGenerator());
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   }
   await p.evaluate(()=>navigate('library'));
   await p.evaluate(kind=>navigate(kind),kind);
   assert.equal(await p.locator('[data-prompt-height=positive]').getAttribute('aria-expanded'),'false');
   assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),'New line\n'.repeat(18));
  }
  const fold=name=>p.getByRole('button',{name,exact:true});
  const box=name=>p.locator('#main > .foldPanel').filter({has:fold(name)});
  await p.evaluate(()=>navigate('image'));
  await fold('Starting image').click();
  assert.match(await box('Starting image').locator('.foldSummary').textContent(),/No starting image/);
  await box('Starting image').locator('.foldSummary').click();
  assert(await p.locator('#upload').isVisible());
  await p.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;
   state.inputs.image={data:canvas.toDataURL(),width:96,height:64};
   state.settings.image.loras=[{name:'Clay Texture',strength:.65,enabled:true}];
   renderGenerator();
  });
  await fold('Starting image').click();
  assert.equal(await box('Starting image').locator('.foldSummary img').count(),1);
  assert.match(await box('Starting image').locator('.foldSummary').textContent(),/96 × 64/);
  await fold('Canvas & model').click();
  assert.match(await box('Canvas & model').locator('.foldSummary').textContent(),/256 × 384test/);
  assert(await p.locator('[data-setting=model]').isHidden());
  assert.match(await box('LoRAs').locator('.foldSummary').textContent(),/Clay Texture0.65/);
  assert(await p.locator('#addLora').isHidden());
  await box('LoRAs').locator('.foldSummary').click();
  assert(await p.locator('#addLora').isVisible());
  await fold('LoRAs').click();
  await fold('Generation settings').click();
  assert.match(await box('Generation settings').locator('.foldSummary').textContent(),/4 steps · CFG 1 · Denoise 1 · Seed 1/);
  const settingsX=(await fold('Generation settings').boundingBox()).x;
  const latestX=(await fold('Latest result').boundingBox()).x;
  assert(Math.abs(settingsX-latestX)<=1);
  await fold('Latest result').click();
  assert.equal(await p.locator('#latestPanel .foldSummary').textContent(),'No results yet');
  await fold('Positive prompt').click();
  assert(await p.locator('[data-expand=positive]').isHidden());
  assert.match(await box('Positive prompt').locator('.foldSummary').textContent(),/New line/);
  if(process.env.FOLDS_SHOT)await p.screenshot({path:process.env.FOLDS_SHOT,fullPage:true});
  await box('Positive prompt').locator('.foldSummary').click();
  await p.locator('[data-expand=positive]').click();
  assert.equal(await p.locator('#modalClose svg').count(),1);
  assert((await p.locator('#modalClose').boundingBox()).width>=44);
  await p.locator('#fullPrompt').fill('A bowl <glazed> in sunlight');
  await p.getByRole('button',{name:'Back to generator'}).click();
  await p.waitForFunction(()=>document.querySelector('textarea[data-setting=positive]').value==='A bowl <glazed> in sunlight');
  assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),'A bowl <glazed> in sunlight');
  await fold('Positive prompt').click();
  assert.equal(await box('Positive prompt').locator('.foldSummary').textContent(),'A bowl <glazed> in sunlight');
  assert.equal(await box('Positive prompt').locator('.foldSummary glazed').count(),0);
  console.log('Prompt sizing, read-only fold previews, heading alignment, and expanded prompt Back passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
