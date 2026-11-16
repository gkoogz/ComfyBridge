const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:900},hasTouch:true}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'swipe-fixture'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  const item={id:'1',credit:'Potter',creatorId:'7',type:'image',width:300,height:600,path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full',prompt:'A vase.',detailVersion:2,generationDataAvailable:true,tags:[{id:12,name:'Ceramics'}],resources:[],parameters:{},reactions:[],stats:{}};
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Example',collections:[],followingIds:[],bans:[],importState:{complete:true},tagWeights:{12:5},tagWeightsAt:1};
   if(route==='browse/feed')return {account:'1',items:[{...item}],nextCursor:null};
   if(route==='browse/seen')return {account:'1',seen:[]};
   if(route==='browse/preferences')return {account:'1',items:[{kind:'tag',id:'12',name:'Ceramics',weight:5}],bans:[]};
   if(route.startsWith('browse/detail/'))return {account:'1',item:{...item},collections:[]};
   return {};
  };navigate('browse');
 });
 const input=await p.context().newCDPSession(p);
 async function drag(dx,dy=0,mid=null,cancel=false,y=330){
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:40,y}]});
  for(let i=1;i<=6;i++){
   await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:40+dx*i/6,y:y+dy*i/6}]});
   await p.waitForTimeout(35);if(i===4&&mid)await mid();
  }
  await p.waitForTimeout(200);await input.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await p.waitForTimeout(250);
 }
 await p.waitForSelector('.feedAuthor');await p.locator('.feedAuthor').click();await p.waitForSelector('.subjectHeading');
 await p.evaluate(()=>window.currentFeed=document.querySelector('#browseFeed'));
 await drag(55,0,async()=>{
  assert.equal(await p.locator('.browseBackLayer').count(),1);
  const box=await p.locator('.browseBackLayer').boundingBox();assert(box.x<0&&box.x>-390);
  assert.equal(await p.evaluate(()=>currentFeed.getBoundingClientRect().x),0,'Current screen remains stationary');
  assert(!await p.locator('#drawer').evaluate(e=>e.classList.contains('open')));
 });
 assert.equal(await p.locator('.browseBackLayer').count(),0);assert.equal(await p.locator('.subjectHeading').count(),1,'Short drag cancels');
 await drag(200,0,null,true);assert.equal(await p.locator('.subjectHeading').count(),1,'Pointer cancellation stays in subfeed');
 await drag(0,-160);assert.equal(await p.locator('.browseBackLayer').count(),0);assert.equal(await p.locator('.subjectHeading').count(),1,'Vertical scroll stays native');
 await drag(235);assert.equal(await p.locator('.subjectHeading').count(),0);assert(!await p.locator('#drawer').evaluate(e=>e.classList.contains('open')));
 // Nested tag feed must go back to preferences, then root, preserving original nodes.
 await p.locator('#browseImport').click();await p.waitForSelector('.weightName');
 await p.locator('#weightSearch').fill('Cer');await p.evaluate(()=>window.preferenceInput=document.querySelector('#weightSearch'));
 await p.locator('.weightName').click();await p.waitForSelector('.subjectFilters');await drag(235);
 assert(await p.evaluate(()=>preferenceInput===document.querySelector('#weightSearch')));assert.equal(await p.locator('#weightSearch').inputValue(),'Cer');
 await drag(235);assert.equal(await p.locator('#weightSearch').count(),0);
 await drag(235,0,null,false,700);assert(await p.locator('#drawer').evaluate(e=>e.classList.contains('open')),'Root opens sidebar');
 await p.evaluate(()=>drawer(false));
 await p.locator('.browseThumb .browseMedia').first().click();await p.waitForSelector('.civitaiViewer');
 await drag(50);assert.equal(await p.locator('.browseBackLayer').count(),0);assert(!await p.locator('#drawer').evaluate(e=>e.classList.contains('open')));
 assert.equal(await p.locator('.civitaiViewer').count(),1,'Full-screen media retains its own gesture');
 assert.deepEqual(errors,[]);console.log('Browse touch navigation: previous screen overlays stationary subfeed, cancel/vertical scroll, nested tag history, retained controls, root drawer and full-screen exclusion passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
