const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'discovery-test'}),notificationRoute:()=>'',openListing:url=>window.opened=url});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];
  window.post=(id,creator=Number(id)+20)=>({id:String(id),type:'image',credit:'Artist '+creator,creatorId:String(creator),width:300,height:600,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,prompt:'A ceramic vase.',negativePrompt:'blur',resources:[],parameters:{},tags:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true});
  window.posts=[{...post(1),chosenBy:{kind:'lora',id:'100',name:'Ceramic glaze',modelId:50}},
   {...post(2),chosenBy:{kind:'curation',collectionId:90,collectionName:'Public ceramics',via:{id:'7',name:'Curator'}}},
   post(3,21),...Array.from({length:10},(_,i)=>post(i+4,i+30))];
  api=async(route,body)=>{
   calls.push({route,body});
   if(route==='browse/status')return {account:'1',username:'Example',collections:[],followingIds:['7'],bans:[],learned:12,follows:1,importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:posts,nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:Object.fromEntries(Object.entries(posts.find(i=>i.id===route.split('/').pop())).filter(([k])=>k!=='chosenBy')),collections:[]};
   if(route==='browse/action'&&body.kind==='follow')return {ok:true,selected:body.selected};
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('.feedDiscovery');
 const creators=await p.locator('.browseTile').evaluateAll(els=>els.map(e=>e.browseItem.creatorId));
 for(let i=0;i<creators.length;i++)assert(!creators.slice(Math.max(0,i-9),i).includes(creators[i]),'Cache/feed ordering must keep artist spacing');
 assert.equal(await p.locator('.feedDiscovery .viaCreator').textContent(),'Curator');
 assert(await p.locator('.feedDiscovery .viaFollowing').isVisible());
 await p.locator('.feedDiscovery .discoveryFollow').click();
 assert.equal(await p.locator('.feedDiscovery .discoveryFollow').textContent(),'Following ✓');
 assert(await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(':social:')).flatMap(k=>Object.values(JSON.parse(localStorage[k]))).some(r=>r.payload?.creatorId==='22'&&r.payload.selected===true)));
 await p.locator('.browseTile .browseMedia').first().click();await p.waitForSelector('.sourceLora.chosenSource');
 assert.equal(await p.locator('.sourceLora').textContent(),'From Ceramic glaze');
 assert.equal(await p.locator('.sourceLora').evaluate(e=>getComputedStyle(e).color),'rgb(255, 219, 115)');
 await p.locator('.sourceLora').click();assert.equal(await p.evaluate(()=>window.opened),'https://civitai.red/models/50?modelVersionId=100');
 await p.evaluate(()=>CivitaiBrowser.close());
 await p.locator('.browseTile .browseMedia').nth(1).click();await p.waitForSelector('.civitaiSocial .viaCreator');
 assert.equal(await p.locator('.civitaiSocial .discoveryFollow').textContent(),'Following ✓');
 assert.match(await p.locator('.civitaiSocial .discoveryVia').getAttribute('title'),/Public ceramics/);
 await p.locator('.civitaiSocial .viaCreator').click();await p.waitForSelector('.subjectHeading');
 assert(await p.evaluate(()=>calls.some(c=>c.route==='browse/feed'&&c.body.channel==='creator:7:all')));
 assert.deepEqual(errors,[]);
 await p.close();
}console.log('Discovery: artist spacing, yellow LoRA provenance, public collection attribution, follow state and curator navigation passed on phone/desktop widths.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
