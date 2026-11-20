const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch();try{for(const width of [390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width===390}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 p.setDefaultTimeout(10000);await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route(/\/(local|model-preview)\//,r=>{
  const url=r.request().url();if(url.includes('/local/video/')||url.endsWith('/full')){const data=fs.readFileSync(path.join(__dirname,'fixtures/feed-video.mp4')),range=r.request().headers().range?.match(/bytes=(\d+)-(\d*)/);if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):data.length-1;return r.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`},body:data.subarray(start,end+1)});}return r.fulfill({contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:data});}
  const [w,h]=url.includes('portrait')?[100,200]:[400,300];return r.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="teal"/></svg>`});
 });
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=syncShelf=()=>{};persist=()=>{};connected=true;api=async()=>({});
  for(const kind of ['image','video'])state.settings[kind]={width:400,height:300,scale:0,steps:4,cfg:1,denoise:1,frames:96,fps:24,loras:[],seed:'1',batch:1,model:'test',positive:'',negative:''};
  library=[{id:'video',kind:'video',local:'file',created:1,duration:4,width:400,height:300},...Array.from({length:14},(_,i)=>({id:(i%2?'landscape':'portrait')+i,kind:'image',local:'file',created:2+i}))];
  jobs=[];queueHistory=[];navigate('image');
 });
 for(const kind of ['image','video']){
  await p.evaluate(kind=>navigate(kind),kind);
  const gap=await p.evaluate(()=>{const a=$('#presetButton').getBoundingClientRect(),b=$('#statusDot').getBoundingClientRect();return b.left-a.right;});assert(gap>=0&&gap<20,'Current settings sits directly beside right-hand status dot');
 }
 await p.evaluate(()=>navigate('library'));await p.locator('.libraryitem img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())));
 assert(await p.locator('.libraryitem img').evaluateAll(imgs=>imgs.every(img=>{const a=img.parentElement.getBoundingClientRect();return Math.abs(a.width/a.height-img.naturalWidth/img.naturalHeight)<.02;})),'Library tile boxes match each source aspect ratio');
 for(const surface of ['library','browse']){
  await p.evaluate(surface=>{if(surface==='library')openMedia(library[0]);else{closeViewer(true);CivitaiBrowser.open({id:'neutral',type:'video',credit:'Test creator',width:400,height:300,duration:4,path:'model-preview/browse/1/neutral/thumb',fullPath:'model-preview/browse/1/neutral/full',tags:[],resources:[],stats:{},reactions:[],detailVersion:2,generationDataAvailable:true},[]);}},surface);
  const root=surface==='library'?'#viewer':'.civitaiViewer',video=p.locator(root+' video'),button=p.locator(root+' .videoToggle'),seek=p.locator(root+' .videoSeek');
  await button.click();await p.waitForFunction(root=>{const v=document.querySelector(root+' video');return v&&!v.paused&&v.currentTime>.1;},root);
  assert.equal(await video.evaluate(v=>v.controls),false);assert.equal(await p.locator(root+' .transportPlay').count(),0);
  const rect=await video.boundingBox();await video.click({position:{x:rect.width*.3,y:rect.height*.2}});assert.equal(await video.evaluate(v=>v.paused),false,'Outer video tap does not pause');
  const hit=await button.boundingBox();
  assert(Math.abs(hit.width-Math.min(rect.width*.3,rect.height*.9))<1,'Full screen target scales to the video');
  const glyph=button.locator('.videoPlayPauseGlyph');
  assert.equal(await glyph.evaluate(el=>getComputedStyle(el).transitionDelay),'1.5s');
  await p.waitForFunction(root=>getComputedStyle(document.querySelector(root+' .videoPlayPauseGlyph')).opacity==='0',root);
  const tapTarget={position:{x:hit.width*.82,y:hit.height/2}};
  if(width===390)await button.tap(tapTarget);else await button.click(tapTarget);
  assert.equal(await video.evaluate(v=>v.paused),true);assert.equal(await button.getAttribute('aria-label'),'Play video');
  const box=await seek.boundingBox();await seek.click({position:{x:box.width*.25,y:8}});await p.waitForFunction(root=>Math.abs(document.querySelector(root+' video').currentTime-1)<.15,root);
  if(width===390){
   const cdp=await p.context().newCDPSession(p),r=await seek.boundingBox();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+r.width*.25,y:r.y+8}]});
   for(const fraction of [.4,.55,.7])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:r.x+r.width*fraction,y:r.y+8}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
   await p.waitForFunction(root=>Math.abs(document.querySelector(root+' video').currentTime-2.8)<.15,root);
   assert.equal(await p.locator('.civitaiViewer.tossing').count(),0,'Touch scrub must not toss the viewer');
  }
  await seek.press('End');await p.waitForFunction(root=>document.querySelector(root+' video').currentTime>3.9,root);
  const geometry=await p.locator(root+' .unifiedVideo').evaluate(el=>{
   const v=el.querySelector('video').getBoundingClientRect(),bar=el.querySelector('.videoTrack').getBoundingClientRect(),now=el.querySelector('.videoCurrent').getBoundingClientRect(),total=el.querySelector('.videoTotal').getBoundingClientRect(),slash=el.querySelector('.videoSlash').getBoundingClientRect(),button=el.querySelector('.videoToggle').getBoundingClientRect();
   return {gap:bar.top-v.bottom,width:bar.width,shell:el.clientWidth,collision:now.right>slash.left||slash.right>total.left,slash:!el.querySelector('.videoSlash').hidden,circle:Math.abs(button.width-button.height),center:Math.abs(button.top+button.height/2-v.top-v.height/2),background:getComputedStyle(el.querySelector('.videoTimeline')).backgroundImage};
  });
  assert(Math.abs(geometry.gap)<1&&geometry.width===geometry.shell);assert(geometry.slash&&!geometry.collision);assert(geometry.circle<1&&geometry.center<1);assert.equal(geometry.background,'none');
  if(process.env.MEDIA_SHOTS)await p.waitForTimeout(150);
  if(process.env.MEDIA_SHOTS)await p.screenshot({path:path.join(process.env.MEDIA_SHOTS,`player-${surface}-${width}.png`)});
  await seek.press('Home');assert.equal(await p.locator(root+' .videoSlash').isVisible(),false);
  if(surface==='library')await p.evaluate(()=>closeViewer(true));else await p.evaluate(()=>CivitaiBrowser.close());
 }
 assert.deepEqual(errors,[]);await p.close();
 }console.log('Shared real-video player: matching controls, center-only play/pause, seeking, collision-safe labels, flush full-width track, proportional library tiles and right-aligned settings passed at phone/desktop widths.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
