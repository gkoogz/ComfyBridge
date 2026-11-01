// Exercise the phone UI in isolation. No bridge or generation requests leave this browser.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const context=await browser.newContext({viewport:{width:460,height:956}});
  await context.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await context.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  const page=await context.newPage();await page.goto('https://bridge.test');await page.waitForSelector('#connect');
  await page.evaluate(()=>{
   window.poll=async()=>{};window.commands=[];
   window.api=async(route,data)=>{commands.push({route,data});return {};};
   connected=true;queueProtocol=8;active='video1';
   jobs=[{id:active,batch:'batch1',kind:'video',owner:'one',status:'running',progress:.37,queuePosition:2,queueTotal:6,current_node:'Sampling frames'}];
   queueHistory=[...jobs,...Array.from({length:15},(_,i)=>({id:'done'+i,kind:'image',created:1000+i,status:'complete',owner:'one',ended:1200+i}))];
   renderBridge();
  });
  assert.equal(await page.locator('#bridgeActivity .progress span').innerText(),'Queue 2/6 · 37%');
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
  for(const [width,height] of [[460,956],[360,640],[844,390]]){
   await page.setViewportSize({width,height});
   const size=await page.evaluate(()=>{const rows=$('.queueRows'),outer=$('#workspace');rows.scrollTop=84;return {outer:outer.scrollHeight,viewport:outer.clientHeight,list:rows.clientHeight,scroll:rows.scrollTop,bottom:rows.getBoundingClientRect().bottom};});
   console.log(width,height,size);assert(size.scroll>0&&size.list>=52);
   assert(size.outer<=size.viewport+1);assert(Math.abs(size.bottom-size.viewport)<2);
  }
  await page.evaluate(()=>{connected=false;renderBridge();});assert(await page.locator('[data-action=stop]').isDisabled());assert(await page.locator('[data-action=skip]').isDisabled());
  console.log('Progress, Skip and Stop targets, ownership and independent scrolling passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
