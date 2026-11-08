const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://desktop.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/local/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#a3f2cc"/></svg>'}));
  await p.addInitScript(()=>{
   window.Desktop=true;window.desktopConfiguration={device:'pc',name:'This PC',paired:true};window.calls=[];
   const listeners=[];let on=false;
   const config=()=>({online:on,phones:on?2:0,code:on?'123456':'—',hint:on?'Enter this code on your phone.':'Turn the server on to pair a phone.',addresses:['https://example.test:18764'],address:'https://example.test:18764'});
   window.chrome??={};window.chrome.webview={addEventListener:(name,fn)=>listeners.push(fn),postMessage:msg=>{
    calls.push(msg);let value;
    if(msg.op==='power')on=msg.args.on;
    if(['status','power','code','address'].includes(msg.op))value=config();
    else if(msg.op==='local')value=msg.args.action==='list'?[]:true;
    else value={};
    setTimeout(()=>listeners.forEach(fn=>fn({data:{id:msg.id,ok:true,value}})),1);
   }};
  });
  await p.goto('https://desktop.test');await p.waitForSelector('#desktopPower');
  await p.waitForFunction(()=>db&&document.body.dataset.page==='image');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=async()=>{};persist=()=>{};
   for(const kind of ['image','video'])state.settings[kind]={width:512,height:768,steps:4,cfg:1,denoise:1,frames:240,fps:24,seconds:10,exactFrames:true,model:'Test model',positive:'A paper boat on a quiet lake.',negative:'',loras:[],seed:'1',batch:1};
   render();
  });
  assert.equal(await p.locator('[data-nav=bridge]').count(),0);
  assert.equal(await p.locator('#queueList').count(),1);
  const positions=await p.evaluate(()=>['desktopBridge','drawer','workspace'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.left,r.right];}));
  assert.equal(positions[0][1],positions[1][0]);assert.equal(positions[1][1],positions[2][0]);
  await p.evaluate(()=>{
   queueHistory=Array.from({length:8},(_,i)=>({id:'layout-'+i,kind:'video',status:'complete',created:Date.now()/1000-i,ordinal:1,total:1}));renderQueue();
  });
  for(const height of [900,800,744]){
   await p.setViewportSize({width:1440,height});
   const layout=await p.evaluate(()=>{
    const rail=$('#desktopBridge'),rows=$('#desktopBridge .queueRows'),fifth=rows.children[4];
    return {railScroll:rail.scrollHeight-rail.clientHeight,visible:rows.getBoundingClientRect().height,
     fifthBottom:fifth.getBoundingClientRect().bottom,bottom:rows.getBoundingClientRect().bottom,screen:innerHeight,children:[...rail.children].map(n=>[n.className||n.id,Math.round(n.getBoundingClientRect().height)])};
   });
   assert(layout.visible>=260,JSON.stringify({height,...layout}));
   assert(layout.fifthBottom<=layout.bottom+1&&layout.bottom<=height,JSON.stringify({height,...layout}));
   assert(layout.railScroll<=1,JSON.stringify({height,...layout}));
  }
  await p.setViewportSize({width:1440,height:900});
  if(process.env.DESKTOP_SHOT)await p.screenshot({path:process.env.DESKTOP_SHOT});
  await p.locator('#desktopPower').click();await p.waitForFunction(()=>document.querySelector('#desktopPower').getAttribute('aria-pressed')==='true');
  assert((await p.locator('#desktopPhones').textContent()).includes('2 phones'));
  await p.locator('[data-nav=video]').click();assert.equal(await p.locator('#queueList').count(),1);
  await p.evaluate(()=>{
   connected=true;queueProtocol=17;active='active';jobs=[{id:'active',kind:'video',batch:'test',owner:'phone',status:'running',progress:.4,created:100,ordinal:1,total:1,queuePosition:1,queueTotal:1}];queueHistory=jobs;updateBridgeActivity();
  });
  assert(await p.locator('#bridgeCommands [data-action=skip]').isEnabled());
  assert(await p.locator('#bridgeCommands [data-action=stop]').isEnabled());
  await p.evaluate(()=>{
   queueHistory=[{id:'saved-video',kind:'video',owner:'other-phone',status:'error',created:100,checkpointAvailable:true}];
   renderQueue();window.resumedCheckpoint=null;window.savedApi=api;
   api=async(path,body)=>{if(path.startsWith('resume-checkpoint/')){window.resumedCheckpoint=path;return {ok:true};}return savedApi(path,body);};
  });
  await p.locator('[data-resume-checkpoint]').click();
  assert.equal(await p.evaluate(()=>resumedCheckpoint),'resume-checkpoint/saved-video');
  await p.evaluate(()=>{library=[{id:'fixture',job:'job',local:'hash',kind:'image',created:100,source:'available',archived:false}];navigate('library');});
  await p.locator('.libraryitem').click();
  await p.waitForFunction(()=>$('#viewer .original')?.naturalWidth>0);
  assert(await p.evaluate(()=>Number(getComputedStyle($('#workspace')).zIndex)<Number(getComputedStyle($('#viewer')).zIndex)),'Library must be painted below the opened media viewer');
  assert.equal(await p.locator('#viewer').getAttribute('data-id'),'fixture');
  await p.locator('#revealMedia').click();
  assert(await p.evaluate(()=>calls.some(x=>x.op==='local'&&x.args.action==='reveal'&&x.args.value.id==='fixture')));
  assert.equal(await p.locator('#saveMedia').textContent(),'Save a copy');
  await p.locator('#viewerBack').click();assert(await p.locator('#viewer').isHidden());
  await p.locator('[data-nav=notepad]').click();assert.equal(await p.locator('#queueList').count(),1);
  await p.locator('[data-window=collapse]').click();assert(await p.evaluate(()=>calls.some(x=>x.op==='collapse')));
  for(const width of [1440,1100,1024]){
   await p.setViewportSize({width,height:800});
   assert(await p.evaluate(()=>document.body.scrollWidth<=innerWidth));
   const work=await p.locator('#workspace').boundingBox();assert(work.width>=600);
  }
  assert.deepEqual(errors,[]);
  console.log('Desktop layout, always-visible queue, native commands, Library reveal, route changes and small-screen sizing passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
