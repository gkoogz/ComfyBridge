const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];let avatars=0;
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#527c78"/></svg>';
 await p.route('**/model-preview/**',r=>{if(r.request().url().endsWith('/avatar'))avatars++;return r.fulfill({contentType:'image/svg+xml',body:svg});});
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'social-header'}),notificationRoute:()=>'',openListing:()=>{}});
 async function boot(noAvatar=false){
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(async noAvatar=>{
   heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];
   window.item={id:'1',type:'image',credit:'Ceramic Artist',creatorId:'7',width:300,height:400,path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full',avatarPath:noAvatar?'':'model-preview/browse/1/1/avatar',prompt:'A vase.',negativePrompt:'blur',resources:[],parameters:{},tags:[],stats:{likeCount:10,heartCountAllTime:3,laughCount:2,cryCount:1},reactions:['Heart'],detailVersion:2,generationDataAvailable:true,chosenBy:{kind:'curation',collectionName:'Ceramics',via:{id:'8',name:'Another Curator'}}};
   api=async(route,body)=>{
    calls.push({route,body});
    if(route==='browse/status')return {account:'1',username:'Example',collections:[],followingIds:['8'],bans:[],importState:{complete:true}};
    if(route==='browse/feed')return {account:'1',items:[structuredClone(item)],nextCursor:null};
    if(route.startsWith('browse/detail/'))return {account:'1',item:structuredClone(item),collections:[]};
    return {};
   };
   if(!noAvatar){const c=await caches.open('comfybridge-avatars-v1');for(let i=0;i<300;i++)await c.put('/retired-avatar/'+i,new Response('old'));}
   navigate('browse');
  },noAvatar);
  await p.waitForSelector('.browseTile:visible');
 }
 await boot();
 assert.equal(await p.locator('.feedReactions button').count(),1);
 assert.equal(await p.locator('.feedReactions small').textContent(),'16');
 const like=p.locator('[data-feed-react=Like]');
 assert.equal(await like.getAttribute('aria-pressed'),'false','Only my Like determines the filled state');
 assert.equal(await like.evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
 assert.equal(await like.locator('svg').evaluate(e=>getComputedStyle(e).fill),'none');
 await like.click();assert.equal(await like.getAttribute('aria-pressed'),'true');
 assert.equal(await like.locator('small').textContent(),'17');
 assert.equal(await like.locator('svg').evaluate(e=>getComputedStyle(e).fill),'rgb(255, 255, 255)');
 const queued=await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(':social:')).flatMap(k=>Object.values(JSON.parse(localStorage[k]))).map(r=>r.payload));
 assert.equal(queued.length,1);assert.equal(queued[0].reaction,'Like');
 assert.equal(await p.locator('.discoveryFollow').count(),0);
 assert(await p.locator('.feedDiscovery').evaluate(e=>!!(e.compareDocumentPosition(e.parentElement.querySelector('.feedReactions'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 await p.locator('.browseMedia').first().click();await p.waitForSelector('.civitaiAuthor .creatorAvatar img');
 const follow=p.locator('.viewerFollow');assert(await follow.isVisible());
 assert(await follow.evaluate(e=>e.previousElementSibling.classList.contains('creatorName')&&e.nextElementSibling.hasAttribute('data-creator-feed')));
 await follow.click();await p.waitForFunction(()=>document.querySelector('.viewerFollow').textContent==='Following ✓');
 assert.equal(await follow.getAttribute('aria-pressed'),'true');assert(await follow.evaluate(b=>b.classList.contains('selected')));
 assert(await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(':social:')).flatMap(k=>Object.values(JSON.parse(localStorage[k]))).some(r=>r.payload.kind==='follow'&&r.payload.creatorId==='7'&&r.payload.selected)));
 await p.evaluate(()=>{CivitaiBrowser.close();CivitaiBrowser.open(item,[item]);});
 await p.waitForSelector('.civitaiAuthor');assert.equal(await p.locator('.viewerFollow').textContent(),'Following ✓','Pending follows remain visibly confirmed on reopen');
 const left=await p.locator('.civitaiAuthor').boundingBox(),right=await p.locator('.civitaiReactions').boundingBox();
 if(width>500){assert(Math.abs(left.y+left.height/2-right.y-right.height/2)<2);assert(right.x>left.x+left.width);}
 else{assert(right.y>=left.y+left.height);assert(Math.abs(right.x-left.x)<2,'Wrapped actions align left');}
 assert.equal(await p.locator('.civitaiReactions button').count(),2);
 assert(await p.locator('.civitaiAuthor .creatorAvatar').evaluate(e=>!!(e.compareDocumentPosition(e.parentElement.querySelector('.creatorName'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 assert(await p.locator('[data-creator-profile]').evaluate(e=>!!(e.compareDocumentPosition(e.parentElement.querySelector('.discoveryVia'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'social-header-'+width+'.png')});
 await p.locator('[data-creator-feed]').click();await p.waitForSelector('.subjectHeading .creatorAvatar img');
 assert(await p.locator('.subjectHeading .creatorAvatar').evaluate(e=>e.getBoundingClientRect().right<=e.parentElement.querySelector('h2').getBoundingClientRect().left));
 assert.equal(avatars,1,'Same creator is fetched once across feed/fullscreen/creator page');
 assert.equal(await p.evaluate(async()=> (await (await caches.open('comfybridge-avatars-v1')).keys()).length),300);
 await boot(true);await p.locator('.feedAuthor').first().click();await p.waitForSelector('.subjectHeading .creatorAvatar img');
 assert.equal(avatars,1,'Creator avatar survives reload and missing avatar metadata');
 assert.deepEqual(errors,[]);await p.close();
}console.log('Social header: combined counts, Like-only durable intent, borderless filled thumbs, provenance order, responsive action row, persistent shared avatars and 300-file bound passed.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
