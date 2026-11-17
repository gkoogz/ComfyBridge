// Exercise the phone UI in isolation. No bridge or generation requests leave this browser.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const context=await browser.newContext({viewport:{width:460,height:956}});
  await context.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await context.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>'',appVersion:()=> '0.1.0-beta.114'};});
  const page=await context.newPage();await page.goto('https://bridge.test');await page.waitForSelector('#connect');
  assert.equal(await page.locator('#appVersion').textContent(),'Beta 114');
  assert.deepEqual(await page.locator('#drawer nav button').allTextContents(),['◉Browse','▧Image','▷Video','▦Library','✎Notepad']);
  assert.equal(await page.locator('#destinations').count(),0);
  await page.locator('[data-nav=browse]').click();
  assert.equal(await page.locator('#pageTitle').textContent(),'Browse');
  assert(await page.locator('#drawer').evaluate(el=>el.inert));
  await page.locator('#hamburger').click();
  assert.equal(await page.locator('.connectionBadge').getAttribute('data-state'),'offline');
  await page.locator('#connect').click();
  assert(await page.locator('#pairError').isVisible());
  assert.equal(await page.locator('#host').getAttribute('aria-invalid'),'true');
  await page.evaluate(()=>{
   window.poll=async()=>{};window.commands=[];
   window.api=async(route,data)=>{
    if(route==='browse/status')return {account:'fixture',username:'Example',collections:[],bans:[],followingIds:[],importState:{complete:true}};
    if(route==='browse/feed')return {account:'fixture',items:[],nextCursor:null};
    if(route.startsWith('browse/'))return {account:'fixture',seen:[]};
    commands.push({route,data});return {};
   };
   bridgeError='';connection(true);queueProtocol=8;active='video1';
   jobs=[{id:active,batch:'batch1',kind:'video',owner:'one',status:'running',progress:.37,created:Date.now()/1000,queuePosition:2,queueTotal:6,current_node:'Sampling frames'}];
   queueHistory=[...jobs,...Array.from({length:15},(_,i)=>({id:'done'+i,kind:'image',created:1000+i,status:'complete',owner:'one',ended:1200+i}))];
   renderBridge();
  });
  assert.equal(await page.locator('#bridgeActivity .progress span').innerText(),'Queue 2/6 · 37%');
  assert.equal(await page.locator('.connectionBadge').getAttribute('data-state'),'online');
  await page.locator('#bridgeOptions').click();
  assert.equal(await page.locator('#modalTitle').textContent(),'Backups & notifications');
  assert.equal(await page.locator('#modalClose .backChevron path').getAttribute('d'),'M15 5l-7 7 7 7');
  await page.getByRole('button',{name:'Back',exact:true}).click();
  assert(await page.locator('#modal').isHidden());
  if(process.env.DRAWER_SHOT)await page.screenshot({path:process.env.DRAWER_SHOT,animations:'disabled'});
  await page.locator('[data-action=skip]').click();await page.locator('[data-action=stop]').click();
  assert.deepEqual(await page.evaluate(()=>commands),[{route:'skip',data:{id:'video1'}},{route:'stop',data:{batch:'batch1'}}]);
  await page.evaluate(()=>{jobs[0].owner='two';updateBridgeActivity();});
  assert(await page.locator('[data-action=stop]').isDisabled());
  assert(await page.locator('[data-action=skip]').isDisabled());
  assert((await page.locator('#bridgeStage').innerText()).includes('Other phone'));
  await page.evaluate(()=>{jobs[0].owner='one';queueProtocol=7;updateBridgeActivity()});
  assert(await page.locator('[data-action=skip]').isDisabled());
  assert(await page.locator('[data-action=stop]').isEnabled());
  await page.evaluate(()=>{rollingSkip=true;updateBridgeActivity()});
  await page.locator('[data-action=skip]').click();
  assert.deepEqual(await page.evaluate(()=>commands.at(-1)),{route:'studio/rolling-skip',data:{id:'video1'}});
  await page.evaluate(()=>{
   queueProtocol=17;queueEtaSeconds=420;jobs[0].etaSeconds=120;jobs[0].owner='two';
   queueHistory[0].started=Date.now()/1000-60;updateBridgeActivity();
  });
  assert((await page.locator('#bridgeActivity .progress span').innerText()).includes('ETA ≈ 2:00'));
  assert((await page.locator('#activeTimer').innerText()).includes('Elapsed 1:00 · Total ETA ≈ 7:00'));
  assert(await page.locator('[data-action=stop]').isDisabled());
  await page.locator('[data-action=all]').click();
  assert.deepEqual(await page.evaluate(()=>commands.at(-1)),{route:'stop-all',data:{}});
  await page.evaluate(()=>{queueProtocol=16;rollingStopAll=true;updateBridgeActivity();});
  await page.locator('[data-action=all]').click();
  assert.deepEqual(await page.evaluate(()=>commands.at(-1)),{route:'studio/stop-all',data:{}});
  for(const [width,height] of [[460,956],[360,640],[844,390]]){
   await page.setViewportSize({width,height});
   const size=await page.evaluate(()=>{
    const rows=$('#queueList .queueRows'),outer=$('#drawerBridge');
    rows.scrollTop=84;outer.scrollTop=outer.scrollHeight;
    return {list:rows.clientHeight,scroll:rows.scrollTop,queueBottom:rows.getBoundingClientRect().bottom,
     nav:$('#drawer nav').getBoundingClientRect().toJSON(),navRows:$$('#drawer nav button').map(b=>b.getBoundingClientRect().top),connect:$('#connect').getBoundingClientRect().bottom,
     controlsTop:outer.getBoundingClientRect().top};
   });
   assert(size.scroll>0&&size.list>=52);
   assert(size.connect<=size.controlsTop&&size.queueBottom<=size.nav.top);
   assert(Math.abs(size.nav.bottom-height)<2);
   assert(size.navRows.every((top,i)=>i===0||top>size.navRows[i-1]));
  }
  await page.evaluate(()=>{connected=false;renderBridge();});assert(await page.locator('[data-action=stop]').isDisabled());assert(await page.locator('[data-action=skip]').isDisabled());assert(await page.locator('[data-action=all]').isDisabled());
  console.log('Progress, Skip and Stop targets, ownership and independent scrolling passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
