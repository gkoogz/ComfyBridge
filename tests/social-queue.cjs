const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const server=new Map(),receipts=new Map();let online=false,loseReply=true,posts=0,revision=0;
 await p.exposeFunction('socialRPC',async body=>{
  if(!online)throw Error('PC disconnected');
  if(!body)return {account:'1',items:[...server.values()]};
  posts++;const results=[];for(const a of body.actions){const key=a.kind==='follow'?'follow:'+a.creatorId:a.kind==='reaction'?'reaction:'+a.imageId+':'+a.reaction:'collect:'+a.imageId+':'+a.collectionId;
   if(!receipts.has(a.requestId)){server.set(key,{...a,key,revision:++revision,state:'pending'});receipts.set(a.requestId,revision);}
   results.push({requestId:a.requestId,revision:receipts.get(a.requestId),queued:true});
  }if(loseReply){loseReply=false;throw Error('Acknowledgement lost');}return {results};
 });
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'social-test'}),notificationRoute:()=>'',saveSocialQueue:(k,v)=>{localStorage.setItem('native:'+k,v);return true;},loadSocialQueue:k=>localStorage.getItem('native:'+k)||''};});
 async function boot(){await p.goto('https://bridge.test');await p.waitForSelector('#connect');await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;window.calls=[];
  const item={id:'1',creatorId:'7',credit:'Potter',type:'image',width:300,height:600,path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full',reactions:[],stats:{},collections:[],tags:[],resources:[],parameters:{},prompt:'A blue vase.',detailVersion:2,generationDataAvailable:true};
  api=async(route,body)=>{calls.push({route,body});
   if(route==='browse/social')return socialRPC(body);
   if(route==='browse/status')return {account:'1',username:'Example',collections:[{id:4,name:'Ceramics',count:0}],followingIds:['7'],bans:[],learned:0,follows:1,importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:[structuredClone(item)],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:structuredClone(item),collections:[{id:4,name:'Ceramics'}]};
   if(route==='browse/seen')return {account:'1',seen:[]};return {};
  };navigate('browse');
 });await p.waitForSelector('.feedReactions');}
 await boot();const heart=p.locator('.feedReactions [data-feed-react=Like]').first();
 await heart.click();assert.equal(await heart.getAttribute('aria-pressed'),'true');assert.equal(server.size,0);
 await heart.click();assert.equal(await heart.getAttribute('aria-pressed'),'false');await heart.click();
 const local=await p.evaluate(()=>Object.entries(localStorage).find(([k])=>k.endsWith(':social:1')&&!k.startsWith('native:'))?.[1]);
 assert.equal(Object.keys(JSON.parse(local)).length,1);assert.equal(Object.values(JSON.parse(local))[0].payload.selected,true);
 await boot();assert.equal(await heart.getAttribute('aria-pressed'),'true','Restart overlays unsent choice over stale feed');
 await p.locator('.feedCollect').first().click();await p.locator('.feedCollectionChoices input').first().check();await p.locator('.collectionClose').click();
 assert(await p.locator('.feedCollect').first().evaluate(el=>el.classList.contains('bookmarked')));
 await p.locator('.feedAuthor').first().click();await p.waitForSelector('.creatorFollow');await p.locator('.creatorFollow').click();
 await p.waitForFunction(()=>document.querySelector('.creatorFollow')?.textContent==='Follow');
 online=true;await p.evaluate(()=>CivitaiBrowser.launchWarm());
 for(let i=0;i<100&&server.size<3;i++)await p.waitForTimeout(100);
 assert.equal(server.size,3);const firstIds=[...receipts.keys()];await boot();
 // Repeated handoff after lost acknowledgement reuses request IDs.
 for(let i=0;i<100&&posts<2;i++)await p.waitForTimeout(100);
 assert(posts>=2);assert.deepEqual([...receipts.keys()].sort(),firstIds.sort());assert.equal(server.get('follow:7').selected,false);
 assert.equal(await heart.getAttribute('aria-pressed'),'true');
 assert(!await p.evaluate(()=>calls.some(c=>c.route==='browse/action'&&['follow','collect','reaction'].includes(c.body?.kind))));
 for(const row of server.values())row.state='synced';await p.evaluate(()=>CivitaiBrowser.launchWarm());
 await p.waitForFunction(()=>!document.querySelector('#browseSync')||document.querySelector('#browseSync').hidden);
 assert.deepEqual(errors,[]);await p.close();
}console.log('Social queue: instant choices, final-state coalescing, native-backed local persistence, reload overlays, bookmark/follow feedback, lost acknowledgement retries and confirmed sync passed on phone/desktop.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
