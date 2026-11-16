const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>{
  window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'loading-test'}),notificationRoute:()=>''};
  const decode=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=async function(){
   await decode.call(this);
   if(this.src.endsWith('/full')&&window.holdDecode)await new Promise(resolve=>window.releaseDecode=resolve);
  };
 });
 await p.goto('https://bridge.test');p.setDefaultTimeout(10000);await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.holdDecode=true;window.calls=[];window.detailGates={};
  window.fixture=id=>({id:String(id),type:'image',credit:'Potter',creatorId:'7',width:300,height:600,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,resources:[],tags:[],stats:{},reactions:[]});
  api=async(route,body)=>{
   calls.push(route);
   if(route==='browse/status')return {account:'1',username:'Potter',collections:[],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:[fixture(1)],nextCursor:null};
   if(route.startsWith('browse/detail/'))return await new Promise((resolve,reject)=>detailGates[route.split('/').pop()]={resolve,reject});
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('.browseTile');await p.locator('.browseMedia').first().click();
 await p.waitForFunction(()=>!!window.releaseDecode&&!!window.detailGates['1'],null,{timeout:10000,polling:50}).catch(async e=>{console.log(errors,await p.evaluate(()=>({calls,pending:Object.keys(detailGates),decode:!!window.releaseDecode,hero:document.querySelector('.modelPreviewHero')?.innerHTML})));throw e;});
 assert.equal(await p.locator('.civitaiViewer .modelPreviewPrompt').textContent(),'Loading prompt details…');
 assert.equal(await p.locator('.retryPromptDetails').count(),0);
 await p.evaluate(()=>{
  window.originalImage=document.querySelector('.civitaiViewer .modelPreviewHero img');
  window.srcChanges=[];new MutationObserver(records=>records.forEach(r=>srcChanges.push(originalImage.getAttribute('src')))).observe(originalImage,{attributes:true,attributeFilter:['src']});
 });
 assert(!(await p.locator('.modelPreviewHero img').getAttribute('src')).endsWith('/full'),'Keep preview until full image is decoded');
 await p.evaluate(()=>releaseDecode());await p.waitForFunction(()=>originalImage.src.endsWith('/full'));
 // A late metadata response must not reset a position set by scrolling or accessibility.
 await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=60);
 await p.waitForTimeout(60);
 const before=await p.evaluate(()=>({top:document.querySelector('.civitaiViewerScroll').scrollTop,rect:originalImage.getBoundingClientRect().toJSON(),src:originalImage.src}));
 await p.evaluate(()=>detailGates['1'].resolve({account:'1',item:{...fixture(1),detailVersion:2,generationDataAvailable:true,prompt:'A ceramic vase in warm light.',negativePrompt:'blur',avatarPath:'model-preview/browse/1/1/avatar',parameters:{steps:20}},collections:[]}));
 await p.waitForFunction(()=>document.querySelector('.modelPreviewPrompt').textContent==='A ceramic vase in warm light.');await p.waitForTimeout(80);
 const after=await p.evaluate(()=>({same:originalImage===document.querySelector('.modelPreviewHero img'),top:document.querySelector('.civitaiViewerScroll').scrollTop,rect:originalImage.getBoundingClientRect().toJSON(),src:originalImage.src,changes:srcChanges.length}));
 assert(after.same);assert.equal(after.src,before.src);assert.equal(after.changes,1);assert.equal(after.top,before.top);
 for(const key of ['x','y','width','height'])assert(Math.abs(after.rect[key]-before.rect[key])<1,`Metadata moved media ${key}`);
 await p.locator('.civitaiClose').click();
 const count=await p.evaluate(()=>calls.filter(x=>x==='browse/detail/1').length);
 await p.locator('.browseMedia').first().click();
 assert.equal(await p.locator('.modelPreviewPrompt').first().textContent(),'A ceramic vase in warm light.');
 assert.equal(await p.evaluate(()=>calls.filter(x=>x==='browse/detail/1').length),count,'Reopen must reuse complete details');
 await p.locator('.civitaiClose').click();
 await p.evaluate(()=>{holdDecode=false;const item=fixture(2);CivitaiBrowser.open(item,[item]);});
 await p.waitForFunction(()=>window.detailGates['2']);
 await p.evaluate(()=>detailGates['2'].reject(Error('Temporary network failure')));
 await p.waitForSelector('.retryPromptDetails');assert.equal(await p.locator('.modelPreviewPrompt').textContent(),'Could not load prompt details.');
 await p.locator('.retryPromptDetails').click();
 assert.equal(await p.locator('.modelPreviewPrompt').textContent(),'Loading prompt details…');
 await p.evaluate(()=>detailGates['2'].resolve({account:'1',item:{...fixture(2),detailVersion:2,generationDataAvailable:true,prompt:'',resources:[],parameters:{}},collections:[]}));
 await p.waitForFunction(()=>document.querySelector('.modelPreviewPrompt').textContent.includes('No prompt is available'));
 assert.equal(await p.locator('.retryPromptDetails').count(),0);
 assert.deepEqual(errors,[]);await p.close();
}console.log('Viewer loading: pending/failed/empty states, retry, cached reopen, decoded image handoff and unchanged media/scroll on late metadata passed at mobile/desktop widths.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
