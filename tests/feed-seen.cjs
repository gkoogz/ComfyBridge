const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 let releaseImage;const imageGate=new Promise(resolve=>releaseImage=resolve);
 let releaseSecond;const secondGate=new Promise(resolve=>releaseSecond=resolve);
 await p.route('**/model-preview/**',async r=>{
  if(r.request().url().includes('/101/'))await imageGate;
  if(r.request().url().includes('/102/'))await secondGate;
  await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'});
 });
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'seen-fixture'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.seenCalls=[];window.generation=0;window.holdRefresh=false;window.failSeen=false;
  window.post=id=>({id:String(id),type:'image',credit:'Potter '+id,creatorId:String(Number(id)+20),width:300,height:600,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,detailVersion:2,generationDataAvailable:true,prompt:'A ceramic vase.',resources:[],tags:[],stats:{},reactions:[]});
  const status={account:'1',username:'Potter',collections:[],followingIds:[],bans:[],importState:{complete:true}};
  localStorage.setItem('comfybridge-browse-v2:seen-fixture',JSON.stringify({account:'1',status,channel:'reactions',exposureVersion:1,strip:[],feed:Array.from({length:10},(_,i)=>post(i+1)),details:[]}));
  api=async(route,body)=>{
   seenCalls.push({route,body});
   if(route==='browse/status')return status;
   if(route==='browse/seen'){
    if(failSeen&&body.viewed)throw Error('Offline');
    return {account:'1',seen:(body.candidates||[]).filter(id=>['1','9','10'].includes(id))};
   }
   if(route==='browse/feed'){
    if(body.channel!=='mix')return {account:'1',items:[post(1)],nextCursor:null};
    if(holdRefresh)await new Promise(resolve=>window.releaseFresh=resolve);
    generation++;return {account:'1',items:Array.from({length:12},(_,i)=>post(generation*100+i+1)),nextCursor:'cursor-'+generation};
   }
   if(route.startsWith('browse/detail/'))return {account:'1',item:post(route.split('/').pop()),collections:[]};
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('#browseFeed .browseTile');
 await p.waitForFunction(()=>seenCalls.some(c=>c.route==='browse/seen'&&c.body.candidates));
 await p.waitForFunction(()=>seenCalls.some(c=>c.route==='browse/feed'&&c.body.channel==='mix'));
 const original=await p.evaluate(()=>{window.topTile=document.querySelector('#browseFeed .browseTile');return {top:topTile.getBoundingClientRect().top,scroll:document.querySelector('#workspace').scrollTop};});
 assert(await p.locator('#browseFeed .browseTile').evaluateAll(es=>es.some(e=>e.browseItem.id==='9')),'Old tile remains while replacement image is unavailable');
 releaseImage();
 await p.waitForFunction(()=>!Array.from(document.querySelectorAll('#browseFeed .browseTile')).some(e=>e.browseItem.id==='9'));
 assert(await p.evaluate(()=>topTile===document.querySelector('#browseFeed .browseTile')),'Visible cached tile is untouched');
 assert.equal(await p.evaluate(()=>topTile.getBoundingClientRect().top),original.top);
 assert.equal(await p.locator('#workspace').evaluate(e=>e.scrollTop),original.scroll);
 // If the user reaches a tile during download, cancel that swap and keep its media.
 await p.locator('#browseFeed .browseTile').evaluateAll(es=>es.find(e=>e.browseItem.id==='10').scrollIntoView());
 releaseSecond();await p.waitForFunction(()=>Array.from(document.querySelectorAll('#browseFeed .browseTile')).some(e=>e.browseItem.id==='112'));
 assert(await p.locator('#browseFeed .browseTile').evaluateAll(es=>es.some(e=>e.browseItem.id==='10')),'Do not replace a tile that entered the viewport safety area');
 // Offscreen items are not marked viewed; an actual visible post is retained offline.
 await p.evaluate(()=>{failSeen=true;});
 const target=p.locator('#browseFeed .browseTile').nth(1);
 await target.scrollIntoViewIfNeeded();const id=await target.evaluate(e=>e.browseItem.id);
 await p.waitForFunction(id=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:seen-fixture:seen:1')||'{}').pending?.includes(id),id);
 const pending=await p.evaluate(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:seen-fixture:seen:1')));
 assert(!pending.seen.includes('112'),'Unseen prefetched posts must remain unviewed');
 // Refresh keeps usable cached tiles until a replacement is ready; exclusions still apply.
 await p.evaluate(()=>{holdRefresh=true;document.querySelector('#browseRefresh').click();});
 await p.waitForFunction(()=>!!window.releaseFresh);
 assert((await p.locator('#browseFeed .browseTile').count())>0,'Pending refresh must not blank the saved feed');
 const refreshCall=await p.evaluate(()=>seenCalls.filter(c=>c.route==='browse/feed'&&c.body.channel==='mix').at(-1));
 assert(refreshCall.body.refresh);assert(refreshCall.body.seen.includes(id));
 await p.evaluate(()=>{holdRefresh=false;releaseFresh();});
 await p.waitForSelector('#browseFeed .browseTile');
 assert(await p.locator('#browseFeed .browseTile').evaluateAll(es=>es.every(e=>Number(e.browseItem.id)>200)));
 // Explicit collections are allowed to show a viewed image.
 assert.equal(await p.locator('.browseThumb').first().evaluate(e=>e.browseItem.id),'1');
 assert.deepEqual(errors,[]);await p.close();
}console.log('Seen feed: cross-device stale cache replacement after decoding, viewport stability, actual-view tracking, offline persistence, fresh refresh and collection revisits passed at phone/desktop widths.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
