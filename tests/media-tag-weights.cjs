const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'tag-fixture'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];window.tagWeights={12:3,13:10,14:0};window.weightStamp=100;
  const weights=()=>({tagWeights:structuredClone(tagWeights),tagWeightsAt:weightStamp});
  const item=n=>({id:String(n),credit:'Potter',creatorId:'7',type:'image',width:300,height:600,tags:[{id:12,name:'Ceramics',score:500},{id:13,name:'Blue',score:1},{id:14,name:'Glaze',score:10000}],tagsKnown:true,reactions:[],stats:{},path:`model-preview/browse/1/${n}/thumb`,fullPath:`model-preview/browse/1/${n}/full`,resources:[],parameters:{},detailVersion:2,generationDataAvailable:true,prompt:'A blue ceramic vase.'});
  api=async(route,body)=>{
   calls.push({route,body});
   if(route==='browse/status')return {account:'1',username:'Example',collections:[{id:4,name:'Pottery',count:1}],followingIds:[],bans:[],learned:1,follows:0,importState:{complete:true},...weights()};
   if(route==='browse/feed')return {account:'1',items:body.channel==='mix'?[{...item(1),chosenBy:{kind:'tags',ids:['12','13']}},{...item(2),chosenBy:{kind:'creator',id:'7'}}]:[{...item(1),chosenBy:body.channel.startsWith('tag:')?{kind:'tags',ids:[body.channel.split(':')[1]]}:{}}],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:item(route.split('/').pop()),collections:[],...weights()};
   if(route==='browse/action'&&body.kind==='tag-weight'){
    if(window.failNext){window.failNext=false;throw Error('Fixture failure');}
    tagWeights[body.tagId]=Math.max(0,(tagWeights[body.tagId]||0)+body.delta);weightStamp++;
    return {ok:true,tagId:body.tagId,weight:tagWeights[body.tagId],...weights()};
   }
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('.browseTile');await p.locator('.browseTile .browseMedia').first().click();await p.waitForSelector('.civitaiTag');
 await p.locator('.civitaiTagHost').scrollIntoViewIfNeeded();
 assert.deepEqual(await p.locator('.tagSearch').allTextContents(),['Blue','Ceramics','Glaze']);
 assert.deepEqual(await p.locator('.personalTagWeight').allTextContents(),['10','3','0']);
 assert.equal(await p.locator('.civitaiTag.chosenSource').count(),2);
 assert.equal(await p.locator('.creatorName.chosenSource').count(),0);
 const tag=id=>p.locator(`[data-weight-tag="${id}"]`);
 await tag(12).locator('[data-vote="-5"]').click();await p.waitForFunction(()=>document.querySelector('[data-weight-tag="12"] small').textContent==='0');
 assert(await tag(12).locator('[data-vote="-5"]').isDisabled());assert(await tag(12).locator('[data-vote="-5"]').evaluate(el=>el.classList.contains('selected')));
 await tag(12).locator('[data-vote="5"]').click();await p.waitForFunction(()=>document.querySelector('[data-weight-tag="12"] small').textContent==='5');
 await p.evaluate(()=>window.failNext=true);await tag(14).locator('[data-vote="5"]').click();await p.waitForTimeout(80);assert.equal(await tag(14).locator('small').textContent(),'0');
 // Even a fresh metadata call with an older weight snapshot cannot undo a confirmed edit.
 await p.evaluate(async()=>{const original=api;api=async(r,b)=>{const result=await original(r,b);if(r==='browse/detail/1'){result.tagWeights={12:3,13:10,14:0};result.tagWeightsAt=100;}return result;};await CivitaiBrowser.enrich(document.querySelector('.civitaiViewer'),document.querySelector('.browseTile').browseItem);api=original;});
 assert.equal(await tag(12).locator('small').textContent(),'5');
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'tag-weights-'+width+'.png')});
 const beforeSearch=await p.evaluate(()=>calls.filter(c=>c.route==='browse/feed').length);
 await tag(12).locator('.tagSearch').click();
 assert.equal(await tag(12).locator('.tagSearch').getAttribute('aria-pressed'),'true');
 assert(await tag(12).evaluate(el=>el.classList.contains('selectedTag')));
 assert.equal(await p.locator('.tagSearchSubmit').count(),1);
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.route==='browse/feed').length),beforeSearch,'Selecting must not search yet');
 await tag(12).locator('.tagSearch').click();assert.equal(await p.locator('.tagSearchSubmit').count(),0);
 assert(await tag(12).evaluate(el=>el.classList.contains('chosenSource')&&!el.classList.contains('selectedTag')));
 await tag(12).locator('.tagSearch').click();await tag(13).locator('.tagSearch').click();
 assert.equal(await p.locator('.selectedTag').count(),2);
 const searchBox=await p.locator('.tagSearchSubmit').boundingBox();assert(searchBox.x<20&&searchBox.y>800&&searchBox.y+searchBox.height<=900);
 const priorScroll=await p.locator('#workspace').evaluate(el=>el.scrollTop);
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'tag-selection-'+width+'.png')});
 await p.locator('.tagSearchSubmit').click();await p.waitForSelector('.subjectFilters');
 assert.equal(await p.locator('.civitaiViewer').count(),0);assert.match(await p.locator('.subjectHeading h2').textContent(),/Ceramics/);
 assert(await p.evaluate(()=>calls.some(c=>c.route==='browse/feed'&&c.body.channel==='tags:12,13:all')));
 await p.locator('.browseBack').click();assert.equal(await p.locator('#workspace').evaluate(el=>el.scrollTop),priorScroll);
 // Same image in a collection has no recommendation highlight despite shared detail cache.
 await p.locator('.browseThumb .browseMedia').first().click();await p.waitForSelector('.civitaiTag');assert.equal(await p.locator('.civitaiTag.chosenSource').count(),0);assert.equal(await p.locator('.tagSearchSubmit').count(),0);
 await p.locator('.civitaiClose').click();
 await p.locator('.browseTile .browseMedia').nth(1).click();await p.waitForSelector('.creatorName.chosenSource');
 assert.equal(await p.locator('.civitaiTag.chosenSource').count(),0);
 assert.equal(await p.locator('.creatorName.chosenSource').evaluate(el=>getComputedStyle(el).color),'rgb(255, 219, 115)');
 await p.evaluate(()=>CivitaiBrowser.close());
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Media tag weights: personal sorting, +/-5, zero clamp, failed writes, stale snapshot protection, multi-tag selection/search and source-specific highlights passed on mobile/desktop.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
