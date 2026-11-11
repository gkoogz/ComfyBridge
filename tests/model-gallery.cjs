const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=[];
  p.on('pageerror',error=>errors.push(error.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',r=>{
   const wide=r.request().url().includes('/2/');
   return r.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${wide?600:200}" height="${wide?300:400}"><rect width="100%" height="100%" fill="#638d89"/></svg>`});
  });
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>'',copyText:text=>window.copied=text,openListing:url=>window.opened=url});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(async()=>{
   heartbeat=poll=syncSettings=()=>{};persist=()=>{};connected=true;window.galleryRequests=[];
   const id='a'.repeat(32),item={id,kind:'loras',name:'ceramic.safetensors',title:'Ceramic Detail',source:'Civitai',sourceUrl:'https://civitai.com/models/8',images:[]};
   catalog={models:[],loras:[item.name],listings:[item]};state.settings.image={loras:[],width:512,height:768,steps:4,cfg:5,denoise:1,model:'',positive:'A bowl.',negative:'',seed:'1'};
   const sample=i=>({id:String(i),source:'https://image.civitai.com/'+i+'.png',path:`model-preview/gallery/${id}/${i}/thumb`,fullPath:`model-preview/gallery/${id}/${i}/full`,width:i===2?600:200,height:i===2?300:400,
    prompt:'A ceramic bowl. <script>window.bad=true</script>',negativePrompt:'blur',credit:'Ceramic artist',resources:[{name:'Pottery glaze',type:'lora',weight:'0.6',versionId:'7'}],parameters:{seed:'31',steps:'20'},imageUrl:'https://civitai.com/images/'+i});
   api=async route=>{
    if(route==='model-library')return {items:[item],scanning:false,nsfwHidden:false};
    if(route.startsWith('model-gallery/')){
     galleryRequests.push(route);await new Promise(r=>setTimeout(r,30));
     if(route.includes('cursor=empty'))return {items:[],nextCursor:'second'};
     if(route.includes('cursor=second'))return {items:[sample(2),sample(3)],nextCursor:null};
     return {items:[sample(1),sample(2)],nextCursor:'empty'};
    }
    return {};
   };
   ModelPreviews.synced();await ModelPreviews.start(catalog);navigate('image');openModelBrowser('loras',item.name);
  });
  await p.waitForFunction(()=>document.querySelectorAll('.modelSample').length===2);
  assert.equal(await p.locator('#modalClose').textContent(),'×');
  const close=await p.locator('#modalClose').boundingBox();assert(close.width>=44&&close.x+close.width>=370,JSON.stringify(close));
  const strip=p.locator('.modelSamples');
  const aspect=await p.locator('.modelSample').evaluateAll(items=>items.map(item=>({ratio:getComputedStyle(item).aspectRatio,fit:getComputedStyle(item.querySelector('img')).objectFit})));
  assert.equal(aspect[0].ratio,'200 / 400');assert.equal(aspect[1].ratio,'600 / 300');assert(aspect.every(x=>x.fit==='contain'));
  await p.locator('.modelSample').first().click();await p.waitForSelector('#modelPreviewViewer');
  await p.locator('.modelPreviewImage').evaluate(image=>image.decode());
  const hint=await p.locator('.modelPreviewPeek').boundingBox();assert(hint.y>=66&&hint.y+hint.height<=845,JSON.stringify(hint));
  assert(await p.locator('.modelPreviewPrompt').first().textContent().then(t=>t.includes('<script>')));assert.equal(await p.evaluate(()=>window.bad),undefined);
  await p.locator('[data-copy-sample]').click();assert.match(await p.evaluate(()=>copied),/ceramic bowl/);
  assert.match(await p.locator('.modelPreviewResources').textContent(),/Pottery glaze.*0.6/s);
  await p.locator('[data-image-source]').click();assert.equal(await p.evaluate(()=>opened),'https://civitai.com/images/1');
  await p.locator('[data-listing-source]').click();assert.equal(await p.evaluate(()=>opened),'https://civitai.com/models/8');
  await p.locator('#modalClose').click();assert.equal(await p.locator('#modelPreviewViewer').count(),0);assert(await p.locator('#modal').evaluate(x=>x.open));
  await strip.evaluate(x=>x.scrollLeft=x.scrollWidth);
  await p.waitForFunction(()=>galleryRequests.some(x=>x.includes('cursor=second')));
  await p.waitForFunction(()=>document.querySelectorAll('.modelSample').length===3);
  assert.equal(await p.locator('[data-sample-more]').count(),0);assert.match(await p.locator('.modelSampleCaption').textContent(),/End of available/);
  // Returning from the full image leaves the same live carousel and scroll position.
  const before=await strip.evaluate(x=>x.scrollLeft);
  await p.locator('.modelSample').last().click();await p.waitForSelector('#modelPreviewViewer');
  await p.keyboard.press('Escape');assert.equal(await p.locator('#modelPreviewViewer').count(),0);
  assert(Math.abs(await strip.evaluate(x=>x.scrollLeft)-before)<2);
  await p.locator('#modalClose').click();assert.equal(await p.locator('#modal').evaluate(x=>x.open),false);
  assert.deepEqual(errors,[]);
  console.log('Model gallery: top-right X, aspect ratios, full viewer, prompt and LoRA details, source links, cursor loading through empty pages, deduplication and return position passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
