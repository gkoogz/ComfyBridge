const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];
  const cdp=await p.context().newCDPSession(p);
  async function touchDrag(x,y,dx,dy){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let n=1;n<=12;n++){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*n/12,y:y+dy*n/12}]});
   }
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  p.on('pageerror',error=>errors.push(error.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',r=>{
   const wide=r.request().url().includes('/2/');
   if(wide&&r.request().url().endsWith('/full'))return r.fulfill({path:path.join(__dirname,'fixtures/feed-video.mp4'),contentType:'video/mp4'});
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
     return {items:[{...sample(1),prompt:'',negativePrompt:'',resources:[],parameters:{}},{...sample(2),type:'video',duration:4}],nextCursor:'empty'};
    }
    if(route.startsWith('model-gallery-detail/')){galleryRequests.push(route);return sample(1);}
    if(route.startsWith('browse/detail/'))throw Error('HTTP 400: This media is no longer available to your account.');
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
  await p.locator('.modelSample').first().click();await p.waitForSelector('.civitaiViewer');
  await p.locator('.civitaiViewer .modelPreviewHero img').evaluate(image=>image.decode());
  assert.equal(await p.locator('.modelPreviewPeek').count(),0);assert.equal(await p.locator('.civitaiClose').count(),1);
  await p.waitForFunction(()=>document.querySelector('.modelPreviewPrompt')?.textContent.includes('<script>'));
  assert(await p.evaluate(()=>galleryRequests.some(route=>route.startsWith('model-gallery-detail/'))));
  assert.equal(await p.evaluate(()=>window.bad),undefined);
  await p.locator('[data-copy-prompt="prompt"]').click();assert.match(await p.evaluate(()=>copied),/ceramic bowl/);
  assert.match(await p.locator('.modelPreviewResources').textContent(),/Pottery glaze.*0.6/s);
  await p.locator('[data-origin]').click();assert.equal(await p.evaluate(()=>opened),'https://civitai.red/images/1');
  assert.equal(await p.locator('.civitaiActionError').textContent(),'');
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=120);
  await touchDrag(170,405,0,-220);
  assert(await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop)>240,'A vertical gesture starting on the image scrolls into metadata');
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=120);
  await touchDrag(60,362,265,0);
  await p.waitForSelector('.civitaiViewer',{state:'detached'});
  assert.equal(await p.locator('.civitaiViewer').count(),0);assert(await p.locator('#modal').evaluate(x=>x.open));
  await p.locator('.modelSample').nth(1).click();
  await p.waitForFunction(()=>document.querySelector('.civitaiViewer video')?.readyState>=2);
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=120);
  const toggle=p.locator('.civitaiViewer .videoToggle');
  await toggle.tap();await p.waitForFunction(()=>!document.querySelector('.civitaiViewer video')?.paused);
  const hit=await toggle.boundingBox(),centerY=hit.y+hit.height/2;
  await touchDrag(hit.x+hit.width/2,centerY,0,-220);
  assert(await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop)>240,'Dragging from the video play region scrolls');
  assert(await p.locator('.civitaiViewer video').evaluate(video=>!video.paused),'A scroll does not pause playback');
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=120);
  await p.waitForFunction(()=>{
   const r=document.querySelector('.civitaiViewer .videoToggle').getBoundingClientRect();
   return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.classList.contains('videoToggle');
  });
  const resetHit=await toggle.boundingBox();
  await touchDrag(resetHit.x+resetHit.width/2,resetHit.y+resetHit.height/2,-175,0);
  await p.waitForSelector('.civitaiViewer',{state:'detached'});
  await strip.evaluate(x=>x.scrollLeft=x.scrollWidth);
  await p.waitForFunction(()=>galleryRequests.some(x=>x.includes('cursor=second')));
  await p.waitForFunction(()=>document.querySelectorAll('.modelSample').length===3);
  assert.equal(await p.locator('[data-sample-more]').count(),0);assert.match(await p.locator('.modelSampleCaption').textContent(),/End of available/);
  // Returning from the full image leaves the same live carousel and scroll position.
  await p.locator('.modelSample').last().scrollIntoViewIfNeeded();
  await p.waitForTimeout(120);
  const before=await strip.evaluate(x=>x.scrollLeft);
  await p.locator('.modelSample').last().click();await p.waitForSelector('.civitaiViewer');
  await p.locator('.modelPreviewHero img').evaluate(el=>el.decode());await p.waitForTimeout(150);
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=el.scrollHeight);await p.waitForTimeout(60);
  const meta=await p.locator('.modelPreviewDetails').boundingBox(),y=Math.max(80,Math.min(800,meta.y+40));
  await p.mouse.move(24,y);await p.mouse.down();await p.mouse.move(280,y+3,{steps:7});
  assert(await p.locator('#modal').evaluate(el=>el.classList.contains('mediaReturnSurface')),'Original listing slides over metadata');
  await p.mouse.up();await p.waitForSelector('.civitaiViewer',{state:'detached'});
  assert(await p.locator('#modal').evaluate(el=>el.open),'Listing reopens as modal after committed swipe');
  assert(Math.abs(await strip.evaluate(x=>x.scrollLeft)-before)<2);
  await p.locator('#modalClose').click();assert.equal(await p.locator('#modal').evaluate(x=>x.open),false);
  assert.deepEqual(errors,[]);
  console.log('Model gallery: image and video touch scroll and toss, listing metadata fallback, source links, cursor loading, and carousel return position passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
