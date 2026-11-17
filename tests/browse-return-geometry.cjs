const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="teal"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'return'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  window.fixture=id=>({id:String(id),type:'image',credit:'Artist '+id,creatorId:String(id+50),width:400,height:500,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tags:[],resources:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true,prompt:'Test.'});
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Tester',collections:[],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:body.channel==='mix'?Array.from({length:8},(_,i)=>fixture(i+1)):body.channel.startsWith('creator:')?[fixture(99)]:[],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:fixture(Number(route.split('/').pop())),collections:[]};return {};
  };navigate('browse');
 });
 await p.waitForFunction(()=>document.querySelectorAll('.browseTile:not(.cardPending)').length===8);
 const third=p.locator('.browseTile').nth(2);await third.locator('.feedAuthor').scrollIntoViewIfNeeded();await p.waitForTimeout(250);
 const measure=()=>p.evaluate(()=>[...document.querySelectorAll('#main .browseTile')].map(el=>{const r=el.getBoundingClientRect();return {id:el.browseItem.id,y:r.y,width:r.width,height:r.height};}));
 const before=await measure();await third.locator('.feedAuthor').click();await p.waitForSelector('.subjectHeading');
 await p.waitForSelector('#browseMore.pullEnded');assert.equal(await p.locator('#browseMore span').textContent(),'You have reached the end :)');
 assert.equal(await p.locator('#browseMore .spinner').isVisible(),false);
 await p.evaluate(()=>{CivitaiBrowser.beginSwipeBack();CivitaiBrowser.moveSwipeBack(innerWidth*.7);});
 const incoming=await p.evaluate(()=>[...document.querySelectorAll('.browseBackMain .browseTile')].map(el=>{const r=el.getBoundingClientRect();return {id:el.browseItem.id,y:r.y,width:r.width,height:r.height};}));
 assert.equal(incoming.length,before.length);
 incoming.forEach((a,i)=>{const b=before[i];assert.equal(a.id,b.id);for(const k of ['y','width','height'])assert(Math.abs(a[k]-b[k])<2,`Incoming ${a.id} ${k}: ${a[k]} vs ${b[k]}`);});
 await p.evaluate(()=>CivitaiBrowser.endSwipeBack(true));await p.waitForSelector('.browseBackLayer',{state:'detached'});
 const after=await measure();after.forEach((a,i)=>{for(const k of ['y','width','height'])assert(Math.abs(a[k]-incoming[i][k])<2,`Settled geometry changed ${k}`);});
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Deep-feed swipe preview and settled media geometry match at phone/desktop widths; genuine ends show friendly text without spinner.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
