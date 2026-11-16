const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 for(const width of [390,1400]){
  const p=await browser.newPage({viewport:{width,height:900},hasTouch:width===390}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="100%" height="100%" fill="#527c78"/></svg>'}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,device:'one'}),notificationRoute:()=>'',openListing:url=>window.opened=url,copyText:t=>window.copied=t});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];
   const item={id:'1',type:'image',credit:'Potter',creatorId:'7',path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full',avatarPath:'model-preview/browse/1/1/avatar',width:300,height:600,prompt:'A ceramic vase. <script>bad()</script>',resources:[{name:'Glaze',type:'LORA',versionId:'12',modelId:'20'},{name:'Ceramic Model',type:'Checkpoint',versionId:'13',modelId:'21'}],tags:[{id:12,name:'ceramics',score:5}],reactions:['Like'],stats:{likeCount:10},following:false,collections:[{collectionId:4}],parameters:{steps:20},imageUrl:'https://civitai.com/images/1'};
   api=async (route,body)=>{calls.push({route,body});
    if(route==='browse/status')return {account:'1',username:'Potter',collections:[{id:4,name:'Ceramics',count:12,bookmark:true}],learned:14,follows:3,importState:{complete:true}};
    if(route.startsWith('browse/feed'))return {account:'1',items:Array.from({length:6},(_,i)=>({...item,id:String(i+1)})),nextCursor:null};
    if(route.startsWith('browse/detail'))return {account:'1',item,collections:[{id:4,name:'Ceramics',count:12,bookmark:true}]};
    if(route==='browse/action')return {ok:true,selected:body.selected,reactions:['Like','Heart'],vote:body.vote,collections:[{id:4,name:'Ceramics',count:12},{id:5,name:'New',count:0}]};
    if(route==='lora-download/status')return {'12':{status:'installed'}};
    return {};
   };
   navigate('browse');
  });
  await p.waitForSelector('.browseTile');assert.equal(await p.locator('#browseHello').textContent(),'Hello Potter');
  assert.equal(await p.locator('#browseCollections').inputValue(),'collection:4');
  assert(await p.locator('.browseThumb').count()>0);
  if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'browse-'+width+'.png')});
  await p.locator('.browseTile .browseMedia').first().click();await p.waitForSelector('.civitaiAuthor');
  assert.equal(await p.locator('.civitaiResourceHost .resourceType').count(),2);
  await p.waitForFunction(()=>document.querySelector('[data-civi-download]')?.disabled===true);
  const media=await p.locator('.civitaiViewer .modelPreviewHero img').evaluate(el=>getComputedStyle(el).objectFit);assert.equal(media,'contain');
  await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=750);
  await p.waitForFunction(()=>document.querySelector('.civitaiViewerScroll').classList.contains('pastPeek'));
  assert.equal(await p.locator('.civitaiViewer .modelPreviewPrompt').textContent(),'A ceramic vase. <script>bad()</script>');
  if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'browse-detail-'+width+'.png')});
  await p.locator('[data-civi-react="Heart"]').click();assert.equal(await p.locator('[data-civi-react="Heart"]').getAttribute('aria-pressed'),'true');
  await p.locator('[data-civi-follow]').click();assert.equal(await p.locator('[data-civi-follow]').textContent(),'Following ✓');
  await p.locator('[data-civi-bookmark]').click();assert.equal(await p.locator('[data-civi-bookmark]').textContent(),'Bookmark');
  await p.locator('.civitaiCollect summary').click();assert.equal(await p.locator('[data-civi-collect="4"]').isChecked(),false);
  await p.locator('[data-vote="1"]').click();assert(await p.locator('[data-vote="1"]').evaluate(el=>el.classList.contains('selected')));
  const action=await p.evaluate(()=>calls.find(c=>c.body?.kind==='reaction'));assert.equal(action.body.account,'1');assert.match(action.body.requestId,/^[a-f0-9-]{36}$/);
  await p.evaluate(()=>bridgeBack());assert.equal(await p.locator('.civitaiViewer').count(),0);
  assert.deepEqual(errors,[]);await p.close();
 }
 console.log('Browse mobile and desktop: collections, viewer, resource layout, escaping, reactions, follows, votes and close passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
