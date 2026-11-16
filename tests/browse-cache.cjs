const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
async function setup(p,options={}){
 await p.evaluate(options=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];window.apiOptions=options;
  api=async(route,body)=>{
   calls.push({route,body});const account=apiOptions.account||'1';
   const item=n=>({detailVersion:2,generationDataAvailable:true,id:String(n),type:'image',credit:'Potter',creatorId:'7',path:`model-preview/browse/${account}/${n}/thumb`,fullPath:`model-preview/browse/${account}/${n}/full`,width:300,height:600,prompt:'A ceramic vase '+n,negativePrompt:'blur',resources:[],tags:[],reactions:[],stats:{},parameters:{}});
   if(route==='browse/status'){
    if(apiOptions.holdStatus)await new Promise(resolve=>window.releaseStatus=resolve);
    return {account,username:'Potter',collections:[{id:4,name:'Ceramics',count:30}],timeouts:{},learned:30,follows:1,importState:{complete:true}};
   }
   if(route==='browse/feed'){
    if(apiOptions.expireNext&&body.cursor){apiOptions.expireNext=false;throw Error('HTTP 400 This feed expired. Refresh Browse.');}
    const start=Number(body.cursor||0),collection=body.channel!=='mix',total=collection?30:36;
    return {account,items:Array.from({length:Math.min(12,total-start)},(_,i)=>item(start+i+(collection?101:1))),nextCursor:start+12<total?String(start+12):null};
   }
   if(route.startsWith('browse/detail/')){await new Promise(r=>setTimeout(r,15));return {account,item:item(Number(route.split('/').pop())),collections:[]};}
   if(route==='browse/action'&&body.kind==='timeout')return {ok:true,creatorId:'7',until:Date.now()/1000+7200};
   return {};
  };navigate('browse');
 },options);
}
(async()=>{
 const browser=await chromium.launch();try{
 const context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'test-PC',device:'one'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');await setup(p);
 await p.waitForFunction(()=>document.querySelectorAll('.browseThumb').length>=20);
 await p.waitForFunction(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:test-PC')||'{}').details?.length>=30);
 const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:test-PC')));
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'browse-top-79.png')});
 assert.equal(saved.strip.length,20);assert.equal(saved.feed.length,10);
 assert.equal(await p.locator('#browseItemCount').textContent(),'30 items');
 assert(await p.locator('#browseRefresh').evaluate(el=>el.parentElement.tagName==='HEADER'&&el.nextElementSibling.id==='presetMenu'));
 assert.equal(await p.locator('.browseTile img').first().getAttribute('width'),'300');
 const cacheHits=await p.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('comfybridge-browse-v2:test-PC')),c=await caches.open('comfybridge-browse-v1');return Promise.all([...s.strip,...s.feed].map(async i=>!!await c.match('/'+i.path)));});
 assert(cacheHits.every(Boolean),'All 20 carousel and 10 feed previews are saved on device');
 const detailsBefore=await p.evaluate(()=>calls.filter(c=>c.route==='browse/detail/1').length);
 await p.locator('.browseTile .browseMedia').first().click();await p.waitForSelector('.civitaiAuthor');
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.route==='browse/detail/1').length),detailsBefore,'Viewer reuses prefetched detail');
 await p.locator('.civitaiClose').click();
 // A pre-fix detail snapshot must be fetched again while image files stay cached.
 await p.evaluate(()=>{const key='comfybridge-browse-v2:test-PC',s=JSON.parse(localStorage.getItem(key));for(const [,entry] of s.details){delete entry.result.item.detailVersion;entry.result.item.prompt='';}localStorage.setItem(key,JSON.stringify(s));});
 // Loading the saved screen must not depend on a status/network response.
 await p.reload();await p.waitForSelector('#connect');await setup(p,{holdStatus:true});
 await p.waitForSelector('.browseTile');assert.equal(await p.locator('.browseThumb').count(),20);
 assert(await p.locator('.browseThumb img').first().evaluate(el=>el.src.startsWith('blob:')));
 assert.equal(await p.locator('.browseTile').count(),10);
 await p.evaluate(()=>{apiOptions.holdStatus=false;releaseStatus();});
 await p.waitForFunction(()=>calls.some(c=>c.route==='browse/feed'&&c.body.channel==='collection:4'));
 await p.waitForFunction(()=>calls.some(c=>c.route==='browse/detail/101'));
 // A restarted worker receives a fresh cursor and carousel can still continue past cached 20.
 await p.locator('#browseCarousel').evaluate(el=>el.scrollLeft=el.scrollWidth);
 await p.waitForFunction(()=>document.querySelectorAll('.browseThumb').length>=24);
 await p.locator('#workspace').evaluate(el=>el.scrollTop=el.scrollHeight);
 await p.waitForFunction(()=>calls.some(c=>c.route==='browse/feed'&&c.body.channel==='mix'));
 // Pull-to-refresh keeps old content until replacement results arrive.
 await p.locator('#workspace').evaluate(el=>el.scrollTop=0);
 const cdp=await context.newCDPSession(p),box=await p.locator('.browseTile .browseMedia').first().boundingBox();
 const x=190,y=Math.max(290,box.y+50);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+150}]});
 await p.waitForFunction(()=>document.querySelector('#browsePull').classList.contains('ready'));
 const count=await p.evaluate(()=>calls.filter(c=>c.route==='browse/status').length);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await p.waitForFunction(n=>calls.filter(c=>c.route==='browse/status').length>n,count);
 await p.waitForTimeout(600);assert.equal(await p.locator('.civitaiViewer').count(),0);
 await p.locator('.feedTimeout').first().click();
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile').length===0);
 assert.match(await p.locator('#toast').textContent(),/2 hours/);
 assert.equal(Object.keys(await p.evaluate(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:test-PC')).muted)).length,1);
 // A different account must not retain cached media or prefetched details.
 await setup(p,{account:'2'});await p.waitForSelector('.browseTile');
 await p.waitForFunction(()=>document.querySelector('.browseTile').browseItem.path.includes('/2/'));
 assert(await p.locator('.browseTile').evaluateAll(els=>els.every(el=>el.browseItem.path.includes('/2/'))));
 // Old workers can still return expiry: recover without leaving the page stuck.
 await p.locator('#workspace').evaluate(el=>el.scrollTop=0);
 await p.evaluate(()=>{apiOptions.expireNext=true;document.querySelector('#browseMore').click();});
 await p.waitForFunction(()=>!apiOptions.expireNext);
 await p.waitForTimeout(150);
 assert(!/feed expired/i.test(await p.locator('#browseError').textContent()));
 await p.evaluate(()=>document.querySelector('#browseMore').click());
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile').length>=24);
 // Resuming before two hours preserves the exact current artist page and position.
 await p.locator('.feedAuthor').first().click();await p.waitForSelector('.subjectFilters');
 await p.locator('#workspace').evaluate(el=>el.scrollTop=100);
 await p.evaluate(()=>{navigate('image');navigate('browse');});
 await p.waitForFunction(()=>document.querySelector('#workspace').scrollTop===100);
 assert.equal(await p.locator('.subjectFilters').count(),1,'Returning from another root screen retains the artist feed');
 await p.evaluate(()=>{window.realNow=Date.now;Date.now=()=>realNow()+3600000;document.dispatchEvent(new Event('visibilitychange'));});
 await p.waitForTimeout(100);assert.equal(await p.locator('.subjectFilters').count(),1);
 assert.equal(await p.locator('#workspace').evaluate(el=>el.scrollTop),100);
 // More than two hours without interaction returns to cached Browse and refreshes.
 await p.evaluate(()=>{Date.now=()=>realNow()+7201000;document.dispatchEvent(new Event('visibilitychange'));});
 await p.waitForSelector('#browseCarousel');
 await p.waitForFunction(()=>document.querySelector('#workspace').scrollTop===0);
 assert.equal(await p.locator('.subjectFilters').count(),0);
 await p.evaluate(()=>Date.now=realNow);
 assert.deepEqual(errors,[]);
 console.log('Browse cache: 20+10 files, startup without network, prefetched details, cursor recovery, automatic paging, pull refresh, timeout and account isolation passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
