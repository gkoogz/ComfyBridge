const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'prefs-fixture'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  window.rows=[{kind:'creator',id:'7',name:'Zed',base:8},{kind:'tag',id:'12',name:'Ceramics',base:5},{kind:'creator',id:'8',name:'Ada',base:3},{kind:'tag',id:'13',name:'Amber',base:1}];
  const bans=()=>rows.filter(i=>i.banned).map(({kind,id,name})=>({kind,id,name}));
  const item={id:'1',credit:'Zed',creatorId:'7',type:'image',width:300,height:600,tags:[{id:12,name:'Ceramics'}],tagsKnown:true,reactions:[],stats:{},path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full'};
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Example',collections:[{id:4,name:'Pottery',count:1}],followingIds:[],bans:bans(),learned:1,follows:0,importState:{complete:true}};
   if(route==='browse/preferences')return {account:'1',items:rows.map(i=>({...i,weight:i.disabled||i.banned?0:i.base})),bans:bans()};
   if(route==='browse/action'&&body.kind==='preference'){
    if(window.failNext){window.failNext=false;throw Error('Fixture network failure');}
    const row=rows.find(i=>i.id===body.id&&i.kind===body.subject);
    if('disabled'in body)row.disabled=body.disabled;
    if('banned'in body){row.banned=body.banned;if(!body.banned)row.disabled=false;}
    if(body.delta)row.base=Math.max(0,row.base+body.delta);return {ok:true};
   }
   if(route==='browse/feed')return {account:'1',items:bans().length?[]:[structuredClone(item)],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:{...item,detailVersion:2,generationDataAvailable:true,prompt:'A ceramic vase.',resources:[],parameters:{}},collections:[]};
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('.browseTile');await p.locator('#browseImport').click();await p.waitForSelector('.weightRow');
 assert.deepEqual(await p.locator('.weightColumns span').allTextContents(),['Tag/Creator','Weight','Vote','Unweight','Ban']);
 const names=()=>p.locator('#weightActive .weightName').allTextContents();
 assert.deepEqual(await names(),['ZedCreator','CeramicsTag','AdaCreator','AmberTag']);
 await p.locator('[aria-label="Sort feed preferences"]').click();await p.locator('[data-weight-sort=alpha]').click();
 assert.deepEqual(await names(),['AdaCreator','AmberTag','CeramicsTag','ZedCreator']);
 await p.locator('[aria-label="Filter feed preferences"]').click();await p.locator('[data-weight-filter=creator]').click();
 assert.deepEqual(await names(),['AdaCreator','ZedCreator']);
 await p.locator('[aria-label="Filter feed preferences"]').click();await p.locator('[data-weight-filter=both]').click();
 const zed=p.locator('[data-key="creator:7"]');
 await zed.locator('.weightRemove').click();await p.waitForSelector('#weightDisabled [data-key="creator:7"]');
 assert.equal(await zed.locator('strong').textContent(),'0');assert(await zed.locator('[data-adjust="1"]').isDisabled());
 assert.equal(await p.locator('.weightVotes svg').count(),8);
 await p.evaluate(()=>window.failNext=true);await p.locator('[data-key="tag:13"] .weightBan').click();
 await p.waitForFunction(()=>document.querySelector('.preferenceError').textContent.includes('network failure'));
 assert.equal(await p.locator('#weightBanned .weightRow').count(),0);
 await p.locator('[data-key="tag:12"] .weightBan').click();await p.waitForSelector('#weightBanned [data-key="tag:12"]');
 const banned=p.locator('#weightBanned .weightRow');assert.equal(await banned.locator('.weightBan').getAttribute('aria-label'),'Unban');
 assert.equal(await banned.evaluate(el=>getComputedStyle(el).color),'rgb(255, 123, 131)');
 // The number, carets, X and skull remain under the same five columns.
 const heads=await p.locator('.weightColumns span').evaluateAll(es=>es.map(e=>{const b=e.getBoundingClientRect();return b.x+b.width/2;}));
 const cells=await zed.evaluate(e=>[e.querySelector('strong'),e.querySelector('.weightVotes'),e.querySelector('.weightRemove'),e.querySelector('.weightBan')].map(x=>{const b=x.getBoundingClientRect();return b.x+b.width/2;}));
 cells.forEach((x,i)=>assert(Math.abs(x-heads[i+1])<1));
 assert(await p.locator('body').evaluate(e=>e.scrollWidth<=innerWidth));
 await p.waitForTimeout(320);
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'preferences-'+width+'.png')});
 const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('comfybridge-browse-v2:prefs-fixture')));
 assert.equal(saved.status.bans.length,1);assert.equal(saved.feed.length,0);assert.equal(saved.strip.length,0);
 await p.locator('.browseBack').click();assert.equal(await p.locator('.browseTile,.browseThumb').count(),0,'Ban prunes retained pages');
 await p.locator('#browseImport').click();await p.waitForSelector('#weightBanned .weightRow');
 assert.equal(await p.locator('#weightSortLabel').textContent(),'Sort: Alphabetical');
 await p.locator('#weightBanned .weightBan').click();await p.waitForSelector('#weightActive [data-key="tag:12"]');
 await p.locator('#weightDisabled .weightRemove').click();await p.waitForSelector('#weightActive [data-key="creator:7"]');
 await p.locator('[data-key="creator:7"] [data-adjust="1"]').click();await p.waitForFunction(()=>document.querySelector('[data-key="creator:7"] strong').textContent==='9');
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Feed preferences: sort/filter, aligned columns, three sections, held-zero state, ban/unban, failure handling and cached page exclusion passed at mobile/desktop widths.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
