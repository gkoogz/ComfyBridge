const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://desktop.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/local/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#a3f2cc"/></svg>'}));
  await p.route('https://desktop.test/fixture-video.mp4',r=>r.fulfill({path:path.join(__dirname,'fixtures/feed-video.mp4'),contentType:'video/mp4'}));
  await p.addInitScript(()=>{
   window.Desktop=true;window.desktopConfiguration={device:'pc',name:'This PC',paired:true,version:'0.1.0-beta.117'};window.calls=[];
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
  await p.setViewportSize({width:1850,height:900});
  const generatorLeft=(await p.locator('#main').boundingBox()).x;
  const gutter=await p.locator('#noteColumn').boundingBox();
  assert(gutter.x<1850&&gutter.x>generatorLeft+900);
  await p.locator('#noteText').focus();
  await p.waitForFunction(x=>Math.abs(document.querySelector('#noteColumn').getBoundingClientRect().left-x)<2,generatorLeft);
  assert(Math.abs((await p.locator('#chatTray').boundingBox()).x-generatorLeft)<3);
  await p.locator('#noteColumnBack').click();
  await p.waitForFunction(x=>Math.abs(document.querySelector('#main').getBoundingClientRect().left-x)<2,generatorLeft);
  await p.locator('[data-open-notes=positive]').click();
  await p.waitForFunction(()=>noteColumnOpen);
  await p.waitForTimeout(280);
  const edge=await p.locator('#main').boundingBox();
  await p.mouse.click(edge.x+edge.width-12,340);
  await p.waitForFunction(()=>!noteColumnOpen);
  await p.evaluate(()=>$('#workspace').scrollTop=0);
  await p.setViewportSize({width:1440,height:900});
  assert.equal(await p.locator('[data-nav=bridge]').count(),0);
  assert.equal(await p.locator('#appVersion').textContent(),'Beta 117');
  await p.locator('[data-nav=browse]').click();
  assert.equal(await p.locator('#pageTitle').textContent(),'Browse');
  await p.locator('[data-nav=image]').click();
  assert.equal(await p.locator('#queueList').count(),1);
  const positions=await p.evaluate(()=>['desktopBridge','drawer','workspace'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.left,r.right];}));
  assert.equal(positions[0][0],positions[1][0]);assert(positions[0][1]<=positions[1][1]);assert.equal(positions[1][1],positions[2][0]);
  await p.evaluate(()=>{
   queueHistory=Array.from({length:8},(_,i)=>({id:'layout-'+i,kind:'video',status:'complete',created:Date.now()/1000-i,ordinal:1,total:1}));renderQueue();
  });
  for(const height of [900,800,744]){
   await p.setViewportSize({width:1440,height});
   const layout=await p.evaluate(()=>{
    const rail=$('#desktopBridge'),rows=$('#desktopBridge .queueRows'),fourth=rows.children[3],nav=$('#drawer nav');
    rail.scrollTop=rail.scrollHeight;
    return {visible:rows.getBoundingClientRect().height,fourthBottom:fourth.getBoundingClientRect().bottom,
     bottom:rows.getBoundingClientRect().bottom,navTop:nav.getBoundingClientRect().top,navBottom:nav.getBoundingClientRect().bottom};
   });
   assert(layout.visible===208,JSON.stringify({height,...layout}));
   assert(layout.fourthBottom<=layout.bottom+1&&layout.bottom<=layout.navTop,JSON.stringify({height,...layout}));
   assert.equal(layout.navBottom,height);
  }
  await p.setViewportSize({width:1440,height:900});
  await p.locator('#desktopBridge').evaluate(rail=>{rail.scrollTop=0;});
  if(process.env.DESKTOP_SHOT)await p.screenshot({path:process.env.DESKTOP_SHOT});
  await p.locator('#desktopPower').click();await p.waitForFunction(()=>document.querySelector('#desktopPower').getAttribute('aria-pressed')==='true');
  assert((await p.locator('#desktopPhones').textContent()).includes('2 phones'));
  await p.locator('#desktopCivitai').click();
  await p.waitForFunction(()=>calls.some(x=>x.op==='civitaiKey'));
  assert.deepEqual(await p.evaluate(()=>calls.find(x=>x.op==='civitaiKey').args),{});
  await p.locator('[data-nav=video]').click();assert.equal(await p.locator('#queueList').count(),1);
  await p.evaluate(()=>{
   connected=true;queueProtocol=17;active='active';jobs=[{id:'active',kind:'video',batch:'test',owner:'phone',status:'running',progress:.4,created:100,ordinal:1,total:1,queuePosition:1,queueTotal:1}];queueHistory=jobs;updateBridgeActivity();
  });
  assert(await p.locator('#bridgeCommands [data-action=skip]').isEnabled());
  assert(await p.locator('#bridgeCommands [data-action=stop]').isEnabled());
  assert(await p.evaluate(()=>{
   const work=$('#main').getBoundingClientRect();
   return ['#result','#carousel'].every(id=>{
    const r=$(id).getBoundingClientRect();
    return Math.abs(r.left-work.left)<1&&Math.abs(r.right-work.right)<1;
   });
  }));
  await p.route('**/local/image/portrait-result/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"/>'}));
  await p.evaluate(()=>{const item={kind:'image',id:'portrait-result',local:'hash'};library.push(item);mountResult(item);});
  await p.waitForSelector('#result img.original');
  for(const width of [1440,960]){
   await p.setViewportSize({width,height:780});
   const geometry=await p.locator('#result img.original').evaluate(img=>({
    width:img.offsetWidth,height:img.offsetHeight,panel:img.closest('#result').clientWidth,ratio:img.naturalWidth/img.naturalHeight
   }));
   assert.equal(geometry.ratio,2/3);
   assert.equal(geometry.width,geometry.panel);
   assert(Math.abs(geometry.height-geometry.panel/geometry.ratio)<=1,'Desktop portrait fills the panel at its natural ratio');
  }
  await p.setViewportSize({width:1440,height:900});
  await p.locator('#queueList .foldToggle').click();
  assert.equal(await p.locator('#queueList .foldSummary .jobThumb').count(),1);
  assert.equal(await p.locator('#queueList .foldSummary .foldQueueCount').textContent(),'0 in the last 24 hours');
  await p.locator('#queueList .foldToggle').click();
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
  await p.locator('.desktopClose').click();assert(await p.evaluate(()=>calls.some(x=>x.op==='hide')));
  assert(!(await p.evaluate(()=>calls.some(x=>x.op==='quit'))));
  await p.locator('[data-window=collapse]').click();assert(await p.evaluate(()=>calls.some(x=>x.op==='collapse')));
  for(const width of [1440,1100,1024]){
   await p.setViewportSize({width,height:800});
   assert(await p.evaluate(()=>document.body.scrollWidth<=innerWidth));
   const work=await p.locator('#workspace').boundingBox();assert(work.width>=600);
  }
  for(const width of [790,1440,1920]){
   await p.setViewportSize({width,height:825});await p.locator('[data-nav=image]').click();
   for(const kind of ['image','video']){
    await p.locator('[data-nav='+kind+']').click();
    const settings=p.locator('#presetButton');await settings.click();
    const save=p.locator('#savePreset');await save.click({trial:true});
    const head=await p.locator('#workspace>header').boundingBox(),button=await settings.boundingBox();
    assert(head.x+head.width-button.x-button.width<80,'settings near workspace edge');
    assert((await p.locator('#main').boundingBox()).width<=905);
    await settings.click();
   }
  }
  await p.locator('[data-nav=browse]').click();
  await p.evaluate(()=>{
   const section=document.querySelector('.civitaiBrowse');
   section.innerHTML='<div id="browseFeed" class="browseFeed">'+('<article class="browseTile" style="height:180px"></article>'.repeat(24))+'</div>';
  });
  const toggle=p.getByRole('button',{name:'One column',exact:true});
  await toggle.click();const narrow=await p.locator('#browseFeed').boundingBox();assert(narrow.width<=571);
  await p.getByRole('button',{name:'Two columns',exact:true}).click();
  const tiles=p.locator('.browseTile');const a=await tiles.nth(0).boundingBox(),b=await tiles.nth(1).boundingBox();
  assert(a.y===b.y&&b.x>a.x&&b.width<500);
  await p.evaluate(()=>{
   const feed=$('#browseFeed');feed.children[0].style.height='440px';
   for(const card of [...feed.children].slice(1,5))card.style.height='50px';
   const bar=document.createElement('div');bar.id='browseMore';bar.className='browsePuller';bar.innerHTML='<canvas class="browseFluid"></canvas><canvas class="browseFlung"></canvas><div class="browseLoaderSpinner"><i class="spinner"></i><span>Fetching...</span></div>';
   feed.after(bar);BrowseLoader.attach(bar,$('#workspace'),()=>true);
  });
  await p.waitForFunction(()=>$('#browseFeed').children[3].offsetLeft===$('#browseFeed').children[1].offsetLeft);
  const next=await tiles.nth(2).boundingBox();assert.equal(next.x,b.x);assert(Math.abs(next.y-(b.y+55))<1);
  const edges=await p.locator('.desktopDrip').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().top));
  const bottoms=await tiles.evaluateAll(cards=>{const ends=[0,0];for(const card of cards){const col=Number(card.offsetLeft>0);ends[col]=Math.max(ends[col],card.getBoundingClientRect().bottom);}return ends;});
  assert.deepEqual(edges,bottoms);assert.notEqual(edges[0],edges[1]);assert(!(await p.locator('#browseMore>.browseLoaderSpinner').isVisible()));
  await p.emulateMedia({reducedMotion:'reduce'});
  await p.locator('#workspace').evaluate(el=>el.scrollTop=el.scrollHeight);
  const waves=p.locator('.desktopDrip .browseFluid');
  const sample=()=>waves.evaluateAll(canvases=>canvases.map(canvas=>canvas.toDataURL()));
  await p.waitForFunction(()=>document.querySelectorAll('.desktopDrip.fluidRunning').length===2);
  const stills=await sample();
  await p.waitForFunction(stills=>[...document.querySelectorAll('.desktopDrip .browseFluid')].every((canvas,i)=>canvas.toDataURL()!==stills[i]),stills);
  await p.locator('#workspace').evaluate(el=>el.scrollTop=0);
  await p.waitForFunction(()=>!document.querySelector('.desktopDrip.fluidRunning'));
  await p.emulateMedia({reducedMotion:'no-preference'});
  await tiles.first().evaluate(card=>{
   card.innerHTML='<button class="browseMedia"></button><span class="browseVideo"></span><button class="feedCollect"></button>';
   FeedVideo.attach(card,async()=>'/fixture-video.mp4','/fixture-video.mp4');
  });
  const playing=()=>p.waitForFunction(()=>{const v=document.querySelector('.feedVideo');return v&&!v.paused&&v.currentTime>0;},null,{timeout:5000});
  await playing();
  for(const width of [620,790]){
   await p.setViewportSize({width,height:825});
   assert((await p.locator('#workspace').boundingBox()).width>=width-65,'Narrow desktop leaves room for the content');
   const togglePanel=p.getByRole('button',{name:'Show bridge panel',exact:true});await togglePanel.click();
   assert(await p.locator('#desktopPower').isVisible());await p.waitForFunction(()=>document.querySelector('.feedVideo').paused);
   if(width===620)await p.keyboard.press('Escape');else await p.mouse.click(width-20,250);
   await playing();
  }
  await p.setViewportSize({width:1920,height:825});
  await p.evaluate(()=>{
   const strip=document.createElement('div');strip.className='browseCarousel';
   for(let i=0;i<20;i++){const button=document.createElement('button');button.className='browseMedia';button.textContent='Photo '+(i+1);button.style.flex='0 0 110px';strip.append(button);}
   strip.onclick=()=>{strip.dataset.clicked='yes';};$('#browseFeed').before(strip);
  });
  const strip=p.locator('.browseCarousel'),start=await strip.locator('button').nth(3).boundingBox();
  await p.mouse.move(start.x+30,start.y+10);await p.mouse.down();await p.mouse.move(start.x-150,start.y+10,{steps:8});await p.mouse.up();
  assert(await strip.evaluate(el=>el.scrollLeft>=150&&!el.dataset.clicked),'Mouse drag scrolls without opening media');
  await strip.locator('button').nth(4).click();assert.equal(await strip.getAttribute('data-clicked'),'yes');
  await p.locator('#workspace').evaluate(el=>el.scrollTop=190);
  const at=await p.locator('#workspace').evaluate(el=>el.scrollTop);
  const openMedia=()=>p.evaluate(()=>{
   const item={id:'sample',width:320,height:480,type:'image',credit:'Studio',tags:[],resources:[],reactions:[],stats:{},path:'',prompt:'A vase'};
   CivitaiBrowser.open(item,[item]);
  });
  await openMedia();
  const pane=p.locator('.civitaiViewer');await p.waitForTimeout(220);
  const rect=await pane.boundingBox();assert(rect.width<710&&rect.x>900);
  const x=await pane.locator('.civitaiClose').boundingBox();assert(x.x-rect.x<20);
  const portrait=pane.locator('.imagePicture img');
  await portrait.evaluate(async img=>{img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480"><rect width="320" height="480" fill="teal"/></svg>');await img.decode();});
  const author=await pane.locator('.civitaiAuthor').boundingBox(),hero=await pane.locator('.modelPreviewHero').boundingBox();
  assert(hero.height>=rect.height-1&&author.y+author.height<=rect.y+rect.height+1,'Portrait and artist row fill the media pane');
  const picture=await portrait.boundingBox();assert(Math.abs(picture.width/picture.height-2/3)<.002&&picture.height>=rect.height-author.height-34);
  await pane.getByRole('button',{name:'View image full screen',exact:true}).click();
  const full=await p.locator('.desktopLightbox').boundingBox();assert(full.x===0&&full.width===p.viewportSize().width);
  assert(await p.evaluate(()=>calls.some(c=>c.op==='imageFullscreen'&&c.args.on)));
  await p.getByRole('button',{name:'Exit full screen',exact:true}).click();await p.locator('.desktopLightbox').waitFor({state:'detached'});
  await p.mouse.click(rect.x-50,200);await pane.waitFor({state:'detached'});
  await openMedia();await p.waitForTimeout(220);
  await p.mouse.move(rect.x+140,185);await p.mouse.down();await p.mouse.move(rect.x+340,189,{steps:10});await p.mouse.up();
  await pane.waitFor({state:'detached'});assert.equal(await p.locator('#workspace').evaluate(el=>el.scrollTop),at);
  assert.deepEqual(errors,[]);
  console.log('Desktop layout, queue, native commands, compact navigation, autoplay, mouse carousel and media pane passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
