const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:370,height:740},hasTouch:true});
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
  const emptySource=box('Starting image').locator('.foldHead .foldHint');
  assert.equal(await emptySource.textContent(),'No starting image');
  await emptySource.click();
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
  assert(await p.evaluate(()=>{
   const work=$('#workspace').getBoundingClientRect();
   return ['#result','#carousel'].every(id=>{
    const r=$(id).getBoundingClientRect();
    return Math.abs(r.left-work.left)<1&&Math.abs(r.right-work.right)<1;
   })&&getComputedStyle($('#latestPanel')).borderRadius===getComputedStyle($('[aria-controls="fold-image-generation-settings"]').closest('.card')).borderRadius;
  }));
  await fold('Latest result').click();
  assert.equal(await p.locator('#latestPanel .foldHint').textContent(),'No results yet');
  await fold('Positive prompt').click();
  assert(await p.locator('[data-expand=positive]').isHidden());
  const longPrompt=box('Positive prompt').locator('.foldPrompt');
  assert.equal(await longPrompt.textContent(),'New line\n'.repeat(18).trimEnd());
  assert(await longPrompt.evaluate(el=>el.clientHeight>3*parseFloat(getComputedStyle(el).lineHeight)));
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
  await p.route('**/local/**',r=>{
   const landscape=/(image|video)1\//.test(r.request().url());
   const [w,h]=landscape?[48,32]:[32,48];
   return r.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="teal"/></svg>`});
  });
  await p.evaluate(()=>{
   for(const kind of ['image','video'])for(let i=0;i<25;i++)library.push({kind,id:kind+i,local:'hash',duration:67+i,created:100-i,archived:i===2});
   renderResults();
  });
  const thumbs=p.locator('#latestPanel .foldRecent img');
  const foldedIds=()=>p.locator('.foldRecent [data-media]').evaluateAll(items=>items.map(item=>item.dataset.media));
  const expandedIds=()=>p.locator('#carousel [data-media]').evaluateAll(items=>items.map(item=>item.dataset.media));
  assert.equal(await thumbs.count(),20);
  assert.deepEqual(await foldedIds(),await expandedIds());
  assert.equal(await p.locator('.foldRecent small').count(),0);
  assert.match(await thumbs.nth(2).getAttribute('src'),/image3/);
  async function assertThumbnailRatios(list){
   for(let i=0;i<2;i++){
    const size=await list.nth(i).evaluate(async img=>{
     await img.decode();
     const rect=img.getBoundingClientRect(),tile=img.closest('.thumb')?.getBoundingClientRect();
     return {ratio:img.naturalWidth/img.naturalHeight,rendered:rect.width/rect.height,
      contained:!tile||(rect.left>=tile.left&&rect.right<=tile.right+.5&&rect.top>=tile.top&&rect.bottom<=tile.bottom+.5)};
    });
    assert(Math.abs(size.ratio-size.rendered)<.02,JSON.stringify(size));
    assert(size.contained,'Carousel flex sizing must not clip an intrinsically sized thumbnail');
   }
  }
  await assertThumbnailRatios(thumbs);
  const collapsed=p.locator('#latestPanel .foldSummary');
  await collapsed.scrollIntoViewIfNeeded();
  const row=await collapsed.boundingBox();
  assert((await thumbs.first().boundingBox()).height>38);
  const cdp=await p.context().newCDPSession(p);
  async function swipe(x,dx){
   const y=row.y+20,dispatch=(type,touchPoints)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints});
   await dispatch('touchStart',[{x,y}]);
   for(let i=1;i<=10;i++)await dispatch('touchMove',[{x:x+dx*i/10,y}]);
   await dispatch('touchEnd',[]);
  }
  await swipe(row.x+290,-205);
  await p.waitForFunction(()=>$('#latestPanel .foldSummary').scrollLeft>100);
  // Stretch beyond the first item and check that the gesture stays in the row.
  await swipe(row.x+45,235);
  await p.waitForFunction(()=>$('#latestPanel .foldSummary').scrollLeft<20);
  assert(await p.locator('#drawer').evaluate(el=>el.inert));
  assert.equal(await fold('Latest result').getAttribute('aria-expanded'),'false');
  await collapsed.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  assert(await thumbs.last().evaluate(el=>el.getBoundingClientRect().right<=el.closest('.foldSummary').getBoundingClientRect().right+1));
  await p.evaluate(()=>{library[19].local='cached';renderCarousel();});
  assert(await collapsed.evaluate(el=>el.scrollLeft>100));
  await fold('Latest result').click();
  await assertThumbnailRatios(p.locator('#carousel .thumb img'));
  const tile=await p.locator('#carousel .thumb').first().evaluate(el=>({
   width:el.offsetWidth,radius:parseFloat(getComputedStyle(el).borderRadius),gap:parseFloat(getComputedStyle(el.closest('#carousel')).gap)
  }));
  assert(tile.radius<10&&tile.gap<9);
  await p.evaluate(()=>navigate('video'));
  await fold('Canvas & model').click();
  assert.match(await box('Canvas & model').locator('.foldSummary').textContent(),/0.92 s · 24 FPS/);
  await fold('Latest result').click();
  assert.equal(await thumbs.count(),20);
  assert.deepEqual(await foldedIds(),await expandedIds());
  assert.deepEqual((await p.locator('.foldRecent small').allTextContents()).slice(0,3),['1:07','1:08','1:10']);
  await assertThumbnailRatios(thumbs);
  console.log('Prompt sizing, card alignment, portrait/landscape thumbnails, full carousel parity, swipe scrolling and video timing passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
