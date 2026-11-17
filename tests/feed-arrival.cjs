const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];let releaseFirst;
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',async r=>{
  if(r.request().url().endsWith('/1/thumb'))await new Promise(resolve=>releaseFirst=resolve);
  await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#527c78"/></svg>'});
 });
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'arrival'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.feedCalls=0;window.arrivals=[];
  window.fixture=id=>({id:String(id),type:'image',credit:'Potter '+id,creatorId:String(id+20),width:400,height:300,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tags:[],resources:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true,prompt:'A ceramic vase.'});
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Potter',collections:[],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/feed'){
    if(body.channel!=='mix')return {account:'1',items:[],nextCursor:null};
    feedCalls++;if(feedCalls>1)await new Promise(resolve=>window.releasePage=resolve);
    return {account:'1',items:feedCalls===1?Array.from({length:12},(_,i)=>fixture(i+1)):[],nextCursor:'next'};
   }
   if(route.startsWith('browse/detail/'))return {account:'1',item:fixture(Number(route.split('/').pop())),collections:[]};
   return {};
  };
  new MutationObserver(records=>{for(const r of records)if(r.target.classList?.contains('cardArriving'))arrivals.push({decoded:r.target.querySelector('img').naturalWidth>0,ghost:!!document.querySelector('.pullGhost')});}).observe(document.querySelector('#main'),{subtree:true,attributes:true,attributeFilter:['class']});
  navigate('browse');
 });
 await p.waitForSelector('.browseTile',{state:'attached'});
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile').length===12&&[...document.querySelectorAll('.browseTile')].slice(1).every(e=>e.cardReady));
 assert.equal(await p.locator('.browseTile:visible').count(),0,'No controls or empty image cards before first image decodes');
 assert.equal(await p.locator('#browseFeed').evaluate(e=>e.offsetHeight),0,'Pending images must not add empty scrolling space');
 assert.equal(await p.locator('#browseMore').evaluate(e=>e.tagName),'DIV');
 assert.equal(await p.locator('#browseMore span').textContent(),'Fetching...');
 assert.equal(await p.evaluate(()=>feedCalls),1,'Hidden pending cards must not trigger unlimited pagination');
 releaseFirst();await p.waitForSelector('.browseTile:visible');
 await p.waitForFunction(()=>!document.querySelector('.cardArriving'));
 assert.equal(await p.locator('.browseTile:visible').count(),12);
 assert(await p.evaluate(()=>arrivals.length>0&&arrivals.every(a=>a.decoded)&&arrivals.some(a=>a.ghost)));
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'feed-ready-'+width+'.png')});
 await p.setViewportSize({width,height:800});await p.waitForTimeout(60);
 await p.locator('#workspace').evaluate(w=>{const more=document.querySelector('#browseMore');w.scrollTop+=more.getBoundingClientRect().top-w.getBoundingClientRect().bottom-w.clientHeight*1.6;});
 await p.waitForTimeout(250);assert.equal(await p.evaluate(()=>feedCalls),1);
 await p.locator('#workspace').evaluate(w=>w.scrollTop+=w.clientHeight*.2);
 await p.waitForFunction(()=>feedCalls===2);
 // Video gestures share image toss/scroll behavior, except its native bottom controls.
 await p.evaluate(()=>{const item={...fixture(99),type:'video'};CivitaiBrowser.open(item,[item]);});
 await p.waitForSelector('.civitaiViewer video');await p.waitForTimeout(100);
 await p.evaluate(()=>{
  const video=document.querySelector('.civitaiViewer video'),r=video.getBoundingClientRect();
  const fire=(type,x,y)=>video.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:9,isPrimary:true,button:0,clientX:x,clientY:y}));
  fire('pointerdown',r.left+r.width/2,r.bottom-20);fire('pointermove',r.left+r.width/2+130,r.bottom-20);fire('pointerup',r.left+r.width/2+130,r.bottom-20);
 });
 assert.equal(await p.locator('.civitaiViewer.tossing').count(),0,'Scrub controls must not start a toss');
 const r=await p.locator('.civitaiViewer video').boundingBox();
 const x=r.x+r.width*.35,y=r.y+r.height*.35;
 await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x,y-90,{steps:5});await p.mouse.up();
 assert.equal(await p.locator('.civitaiViewer').count(),1,'Ordinary upward drag scrolls details');
 await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x+Math.min(width*.65,650),y,{steps:3});await p.mouse.up();
 await p.waitForSelector('.civitaiViewer',{state:'detached'});
 if(width<500){
  await p.evaluate(()=>{const item={...fixture(100),type:'video'};CivitaiBrowser.open(item,[item]);});
  await p.waitForSelector('.civitaiViewer video');await p.waitForTimeout(80);
  const v=await p.locator('.civitaiViewer video').boundingBox(),cdp=await p.context().newCDPSession(p);
  const tx=v.x+70,ty=v.y+v.height*.4;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty}]});
  for(const dx of [40,110,230])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx+dx,y:ty}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await p.waitForSelector('.civitaiViewer',{state:'detached'});await cdp.detach();
 }
 assert.deepEqual(errors,[]);await p.close();
}console.log('Feed arrivals: decoded ordered cards, no empty layout, spinner cover, 1.5 viewport paging, video scroll/toss and scrub exclusion passed on phone/desktop.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
