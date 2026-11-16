const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const fixture=path.join(__dirname,'../local/bank-test/video.mp4');fs.mkdirSync(path.dirname(fixture),{recursive:true});
execFileSync(process.env.FFMPEG||'C:/Program Files/Shotcut/ffmpeg.exe',['-nostdin','-v','error','-y','-f','lavfi','-i','color=c=0x99ddcc:s=160x240:r=12:d=3','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
async function waitCache(p,fn){for(let n=0;n<200;n++){if(await p.evaluate(fn))return;await p.waitForTimeout(100);}throw Error('Cache did not reach its target');}
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[],requests=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>{const url=new URL(r.request().url()).pathname;requests.push(url);return url.endsWith('/2/full')?r.fulfill({path:fixture,contentType:'video/mp4'}):r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#527c78"/></svg>'});});
 await p.addInitScript(()=>{window.registrations=[];window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'bank-test'}),notificationRoute:()=>'',registerBrowseMedia:(account,json)=>registrations.push({account,urls:JSON.parse(json)})};});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;syncing=true;window.calls=[];window.drawn=0;
  window.post=id=>({id:String(id),creatorId:String(id+20),credit:'Artist '+id,type:id===2?'video':'image',width:300,height:600,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,mediaUrls:{thumb:`https://image.civitai.com/test/${id}/thumb`,full:`https://image.civitai.com/test/${id}/full`},tags:[],resources:[],parameters:{},reactions:[],stats:{},prompt:'A blue vase.',detailVersion:2,generationDataAvailable:true});
  api=async(route,body)=>{
   calls.push({route,body});
   if(route==='browse/bank')return {bank:true,account:'1',bankCount:200,items:Array.from({length:25},(_,i)=>post(drawn+i+1))};
   if(route==='browse/status')return {account:'1',username:'Example',collections:[],followingIds:[],bans:[],importState:{complete:true},follows:0,learned:0};
   if(route==='browse/feed'){
    if(body.channel==='mix'){const items=Array.from({length:12},(_,i)=>post(drawn+i+1));drawn+=12;return {account:'1',bank:true,items,nextCursor:'bank'};}
    if(body.channel==='reactions')return {account:'1',items:[],nextCursor:null};
    const n=Number(body.cursor)||0;return {account:'1',items:Array.from({length:12},(_,i)=>post(1001+n+i)),nextCursor:String(n+12)};
   }
   if(route.startsWith('browse/detail/'))return {account:'1',item:post(Number(route.split('/').pop())),collections:[]};
   if(route==='browse/seen')return {account:'1',seen:[]};return {};
  };navigate('image');CivitaiBrowser.launchWarm();
 });
 await p.waitForTimeout(1300);assert.equal(requests.length,0,'Library sync takes priority over Browse launch downloads');
 await p.evaluate(()=>{syncing=false;CivitaiBrowser.launchWarm();});
 await waitCache(p,async()=>{const c=await caches.open('comfybridge-browse-v1');return (await c.keys()).filter(k=>k.url.endsWith('/full')).length===25;});
 assert.equal(await p.evaluate(()=>page),'image','Warming must not navigate to Browse');
 assert.equal(new Set(requests.filter(u=>u.endsWith('/full'))).size,25,JSON.stringify({width,requests,state:await p.evaluate(async()=>({calls,keys:(await(await caches.open('comfybridge-browse-v1')).keys()).map(k=>k.url),registrations}))}));
 assert(await p.evaluate(()=>registrations.some(r=>r.account==='1'&&Object.keys(r.urls).length===50)));
 const before=requests.filter(u=>u.endsWith('/full')).length;
 await p.evaluate(()=>navigate('browse'));await p.waitForSelector('.browseTile');
 assert(await p.evaluate(()=>calls.some(c=>c.route==='browse/feed'&&c.body.channel==='mix'&&c.body.bank===true)));
 await p.locator('.browseTile .browseMedia').nth(1).click();await p.waitForSelector('.modelPreviewHero video');
 const video=p.locator('.modelPreviewHero video');assert((await video.getAttribute('src')).startsWith('blob:'));
 await video.evaluate(v=>{v.load();});await p.waitForFunction(()=>document.querySelector('.modelPreviewHero video').readyState>=1);
 await video.evaluate(v=>{v.currentTime=1;});await p.waitForFunction(()=>Math.abs(document.querySelector('.modelPreviewHero video').currentTime-1)<.1);
 assert.equal(requests.filter(u=>u.endsWith('/2/full')).length,1,'Cached video playback and seeking must not redownload');
 await p.evaluate(()=>CivitaiBrowser.close());await p.locator('.feedAuthor').first().click();await p.waitForSelector('.subjectHeading');
 await waitCache(p,async()=>{const c=await caches.open('comfybridge-browse-v1');return (await c.keys()).filter(k=>/\/10\d\d\/full$/.test(k.url)).length===12;});
 assert.equal(new Set(requests.filter(u=>/\/10\d\d\/full$/.test(u))).size,12,'A subfeed warms only its next 12 media');
 assert.deepEqual(errors,[]);await p.close();
}console.log('Browse bank: launch before Browse, library priority, exactly 25 originals, direct-CDN registration, cached video seeking, and 12-original subfeed window passed on phone/desktop.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
