const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'scroll-schedule'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.feedCalls=0;window.animated=[];window.midScrollInsertions=0;window.iconRepaints=0;window.simScrolling=false;
  window.fixture=id=>({id:String(id),type:'image',credit:'Potter '+id,creatorId:String(id+20),width:400,height:300,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tags:[],resources:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true,prompt:'A vase.'});
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Potter',collections:[],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/social')return {account:'1',items:[]};
   if(route==='browse/feed'){
    if(body.channel!=='mix')return {account:'1',items:[],nextCursor:null};
    const page=feedCalls++;if(page)await new Promise(resolve=>window.releasePage=resolve);
    return {account:'1',items:Array.from({length:12},(_,i)=>fixture(page*12+i+1)),nextCursor:'next'};
   }
   if(route.startsWith('browse/detail/'))return {account:'1',item:fixture(Number(route.split('/').pop())),collections:[]};return {};
  };
  document.querySelector('#workspace').addEventListener('scrollend',e=>{if(simScrolling)e.stopImmediatePropagation();},{capture:true});
  new MutationObserver(records=>{for(const r of records){
   if(r.type==='attributes'&&r.target.classList?.contains('cardArriving')){const rect=r.target.getBoundingClientRect(),v=document.querySelector('#workspace').getBoundingClientRect();animated.push({id:r.target.browseItem.id,visible:rect.bottom>v.top&&rect.top<v.bottom});}
   if(r.type==='childList'&&r.target.id==='browseFeed'&&simScrolling)midScrollInsertions+=r.addedNodes.length;
   if(r.type==='childList'&&r.target.matches?.('[data-feed-react]'))iconRepaints++;
  }}).observe(document.querySelector('#main'),{subtree:true,attributes:true,attributeFilter:['class'],childList:true});
  navigate('browse');
 });
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile:not(.cardPending)').length===12);
 assert(await p.evaluate(()=>animated.length>0&&animated.every(a=>a.visible)),'Only visible initial cards may animate');
 await p.locator('#workspace').evaluate(w=>w.scrollTop+=document.querySelector('#browseMore').getBoundingClientRect().top-w.getBoundingClientRect().bottom-w.clientHeight*1.4);
 await p.waitForFunction(()=>!!window.releasePage);
 await p.evaluate(()=>{
  simScrolling=true;window.moving=setInterval(()=>{const w=document.querySelector('#workspace');w.scrollTop+=2;w.dispatchEvent(new Event('scroll'));},16);
 });
 await p.waitForTimeout(70);await p.evaluate(()=>releasePage());await p.waitForTimeout(220);
 assert.equal(await p.locator('.browseTile').count(),12,'New cards wait while scroll velocity remains nonzero');
 assert.equal(await p.evaluate(()=>midScrollInsertions),0);
 await p.evaluate(nativeEnd=>{clearInterval(moving);simScrolling=false;if(nativeEnd)document.querySelector('#workspace').dispatchEvent(new Event('scrollend'));},width===390);
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile').length>12,null,{timeout:300});
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile:not(.cardPending)').length===24,null,{timeout:2000});
 assert(await p.evaluate(()=>animated.every(a=>Number(a.id)<=12)),'The offscreen next page must not animate');
 assert.equal(await p.locator('#browseMore .spinner').evaluate(e=>getComputedStyle(e).animationPlayState),'paused');
 await p.waitForTimeout(200);await p.evaluate(()=>iconRepaints=0);await p.waitForTimeout(5300);
 assert.equal(await p.evaluate(()=>iconRepaints),0,'Unchanged social polling must not rebuild reaction controls');
 assert.deepEqual(errors,[]);await p.close();
}console.log('Scroll scheduling: offscreen animation culling, scroll-stop card admission, bounded next-page reveal, paused hidden spinner and unchanged-poll no-repaint passed on phone/desktop.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
