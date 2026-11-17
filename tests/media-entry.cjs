const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.request().url().includes('/2/full')?r.fulfill({path:path.join(__dirname,'fixtures/feed-video.mp4'),contentType:'video/mp4'}):r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="teal"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=syncShelf=()=>{};connected=true;
  window.fixture=id=>({id:String(id),type:id===2?'video':'image',credit:'Creator '+id,creatorId:String(50+id),width:400,height:300,duration:4,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tags:[],resources:[],reactions:[],stats:{},detailVersion:2,generationDataAvailable:true});
  api=async(route,body)=>route==='browse/status'?{account:'1',username:'Tester',collections:[],followingIds:[],bans:[],importState:{complete:true}}:route==='browse/feed'?{account:'1',items:body.channel==='mix'?[fixture(1),fixture(2),fixture(3)]:[],nextCursor:null}:route.startsWith('browse/detail/')?{account:'1',item:fixture(Number(route.split('/').pop()))}:{};
  navigate('browse');
 });
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile:not(.cardPending)').length===3);
 for(const index of [0,1]){
  const card=p.locator('.browseTile').nth(index);await card.scrollIntoViewIfNeeded();
  if(index===1)await p.waitForFunction(()=>{const v=document.querySelector('.feedVideo');return v&&v.readyState>=2&&!v.paused;});
  await card.evaluate(card=>{window.originalMedia=card.querySelector('video')||card.querySelector('img');window.sourceRect=originalMedia.getBoundingClientRect().toJSON();window.entryTime=originalMedia.currentTime||0;window.entryURL=originalMedia.currentSrc;window.savedScroll=document.querySelector('#workspace').scrollTop;card.querySelector('.browseMedia').click();});
  await p.waitForFunction(()=>document.querySelector('.civitaiViewer.entering .videoPicture,.civitaiViewer.entering .imagePicture img')?.getAnimations().length>0);
  const start=await p.evaluate(()=>{const target=document.querySelector('.civitaiViewer .videoPicture,.civitaiViewer .imagePicture img'),animation=target.getAnimations()[0];animation.pause();animation.currentTime=0;const r=target.getBoundingClientRect();return {same:document.querySelector('.civitaiViewer img,.civitaiViewer video')===originalMedia,rect:r.toJSON(),source:sourceRect};});
  assert(start.same,'The original media element moves into the sheet');for(const key of ['x','y','width','height'])assert(Math.abs(start.rect[key]-start.source[key])<1,'First animation frame matches feed '+key);
  if(index===1){
   assert(await card.locator('video').evaluate(v=>v!==originalMedia&&v.paused&&v.currentSrc===entryURL),'Feed retains a separate paused video using the same bytes');
   assert(await p.evaluate(()=>!originalMedia.paused&&originalMedia.currentTime>=entryTime),'Moved video continues playing');
  }else assert(await card.locator('img').evaluate(img=>img!==originalMedia&&img.src),'Feed keeps its image copy');
  await p.evaluate(()=>document.querySelector('.civitaiViewer .videoPicture,.civitaiViewer .imagePicture img').getAnimations()[0].finish());
  await p.waitForSelector('.civitaiViewer:not(.entering)');
  if(index===1){
   const centers=await p.evaluate(()=>{const a=document.querySelector('.civitaiViewer .videoToggle').getBoundingClientRect();return [...document.querySelectorAll('.civitaiViewer .modelPreviewNavigation button')].map(b=>{const r=b.getBoundingClientRect();return Math.abs(a.y+a.height/2-r.y-r.height/2);});});assert(centers.every(x=>x<1));
   await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=0);await p.waitForSelector('.civitaiViewer.mediaOnly');await p.waitForTimeout(200);
   const hidden=await p.locator('.civitaiViewer .modelPreviewNavigation button').evaluateAll(bs=>bs.map(b=>({opacity:getComputedStyle(b).opacity,x:new DOMMatrix(getComputedStyle(b).transform).m41})));assert(hidden[0].opacity==='0'&&hidden[0].x<0&&hidden[1].opacity==='0'&&hidden[1].x>0);
   const v=await p.locator('.civitaiViewer video').boundingBox();await p.mouse.click(v.x+v.width*.3,v.y+v.height*.25);await p.waitForSelector('.civitaiViewer:not(.mediaOnly)');
  }
  const media=p.locator('.civitaiViewer .imagePicture img,.civitaiViewer video'),r=await media.boundingBox(),dx=Math.min(width*.7,650);
  await p.mouse.move(r.x+r.width*.2,r.y+r.height*.25);await p.mouse.down();await p.mouse.move(r.x+r.width*.2+dx,r.y+r.height*.25,{steps:3});await p.mouse.up();await p.waitForSelector('.civitaiViewer',{state:'detached'});
  assert.equal(await p.locator('#workspace').evaluate(w=>w.scrollTop),await p.evaluate(()=>savedScroll));assert(await card.isVisible());
 }
 assert.equal(await p.locator('.browseFluid').evaluate(c=>getComputedStyle(c).opacity),'0.8');assert.deepEqual(errors,[]);await p.close();
 }console.log('Media entry: same DOM media, exact starting geometry, uninterrupted video with paused feed copy, toss return, caret stowing/alignment and 80% drips passed at phone/desktop widths.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
