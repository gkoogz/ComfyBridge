const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 p.setDefaultTimeout(15000);
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.request().url().endsWith('/full')?r.fulfill({path:process.env.FEED_VIDEO_FIXTURE||path.join(__dirname,'fixtures/feed-video.mp4'),contentType:'video/mp4'}):r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="teal"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,fingerprint:'video'}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  window.fixture=id=>({id:String(id),type:'video',credit:'Test creator '+id,creatorId:String(id+50),width:400,height:300,path:`model-preview/browse/1/${id}/thumb`,fullPath:`model-preview/browse/1/${id}/full`,tags:[],resources:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true,prompt:'A teal test frame.'});
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Tester',collections:[],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:body.channel==='mix'?Array.from({length:8},(_,i)=>fixture(i+1)):[],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:fixture(Number(route.split('/').pop())),collections:[]};return {};
  };navigate('browse');
 });
 await p.waitForFunction(()=>{const v=document.querySelector('.feedVideo');return v&&!v.paused&&v.currentTime>0;}).catch(async e=>{console.log(await p.evaluate(()=>({page:document.body.dataset.page,video:document.querySelector('.feedVideo')?.outerHTML,cards:document.querySelectorAll('.browseTile').length,errors:document.querySelector('#browseError')?.textContent})),errors);throw e;});console.log('Autoplay',width);
 const first=p.locator('.browseTile').first(),v=first.locator('video');
 assert(await v.evaluate(v=>v.muted&&v.loop&&!v.controls&&v.playsInline));
 assert.match(await first.locator('.browseVideo').textContent(),/^0:0[1-4]$/);
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'feed-video-'+width+'.png')});
 await p.evaluate(()=>document.querySelector('#modal').showModal());await p.waitForFunction(()=>document.querySelector('.feedVideo').paused);await p.evaluate(()=>document.querySelector('#modal').close());await p.waitForFunction(()=>!document.querySelector('.feedVideo').paused);
 const toggle=first.locator('.feedVideoToggle');
 await p.waitForFunction(()=>getComputedStyle(document.querySelector('.feedVideoGlyph')).opacity==='0');
 const box=await first.locator('.browseMedia').boundingBox(),target=await toggle.boundingBox();
 assert(Math.abs(target.width-box.width*.3)<1&&target.width===target.height);
 assert(Math.abs(target.x+target.width/2-box.x-box.width/2)<1);
 assert.equal(await toggle.evaluate(e=>getComputedStyle(e.querySelector('span')).transitionDelay),'1.5s');
 await toggle.click({position:{x:target.width*.82,y:target.height/2}});
 assert(await v.evaluate(v=>v.paused));assert.equal(await p.locator('.civitaiViewer').count(),0);
 await p.waitForFunction(()=>getComputedStyle(document.querySelector('.feedVideoGlyph')).opacity==='1');
 const media=first.locator('.browseMedia');
 await media.evaluate(e=>e.style.height='60px');
 await p.waitForFunction(()=>Math.abs(document.querySelector('.feedVideoToggle').offsetWidth-54)<1);
 await media.evaluate(e=>e.style.removeProperty('height'));
 await first.locator('.feedSound').click();assert.equal(await v.evaluate(v=>v.muted),false);
 await first.locator('.feedSound').click();assert.equal(await v.evaluate(v=>v.muted),true);
 await p.locator('#workspace').evaluate(w=>w.scrollTop=3000);await p.waitForTimeout(200);await p.locator('#workspace').evaluate(w=>w.scrollTop=0);await p.waitForTimeout(200);
 assert(await v.evaluate(v=>v.paused),'Manual pause survives scrolling away and back');
 await first.locator('.feedVideoToggle').click();await p.waitForFunction(()=>!document.querySelector('.feedVideo').paused);
 await v.evaluate(v=>v.currentTime=v.duration-.15);await p.waitForTimeout(600);assert(await v.evaluate(v=>v.currentTime<2&&!v.paused),'Playback actually loops');
 const outer=await first.locator('.browseMedia').boundingBox();await first.locator('.browseMedia').click({position:{x:Math.min(80,outer.width*.2),y:outer.height/2}});await p.waitForSelector('.civitaiViewer');
 await p.waitForFunction(()=>document.querySelector('.feedVideo').paused);assert.equal(await p.locator('.civitaiViewer video').evaluate(v=>v.controls),false);assert.equal(await p.locator('.civitaiViewer .videoSeek').count(),1,'Solo view has the shared scrub controls');
 await p.evaluate(()=>CivitaiBrowser.close());await p.waitForFunction(()=>!document.querySelector('.feedVideo').paused);
 await p.locator('#workspace').evaluate(w=>w.scrollTop=3000);await p.waitForFunction(()=>document.querySelector('.feedVideo').paused).catch(async e=>{console.log(await p.evaluate(()=>({scroll:document.querySelector('#workspace').scrollTop,height:document.querySelector('#workspace').clientHeight,rect:document.querySelector('.browseTile').getBoundingClientRect().toJSON(),count:document.querySelectorAll('.browseTile').length})));throw e;});
 await p.evaluate(()=>navigate('notepad'));await p.waitForTimeout(100);assert.equal(await p.locator('.feedVideo').count(),0);
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Real video playback passed at phone/desktop widths: muted autoplay, countdown, loop, center controls, outside detail navigation, offscreen/overlay pause, and retained scrub controls.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});


