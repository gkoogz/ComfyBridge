// Hold submission open while background polls still report an empty queue.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage();
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>'',watchBatch:()=>{}};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  for(const kind of ['image','video']){
   for(const accepted of [true,false]){
    await p.evaluate(kind=>{
     window.poll=window.heartbeat=window.syncSettings=async()=>{};window.persist=()=>{};
     connected=true;queueProtocol=16;page=kind;jobs=[];active=null;
     state.pendingByKind={};state.inputs[kind]={};
     state.settings[kind]={width:256,height:384,scale:0,steps:4,cfg:1,denoise:1,frames:22,fps:24,
      model:'test',positive:'',negative:'',loras:[],seed:'1',batch:1};
     window.api=()=>new Promise((resolve,reject)=>{window.accept=resolve;window.fail=reject;});
     renderGenerator();
    },kind);
    await p.locator('#play').click();
    assert(await p.locator('#runSpinner').isVisible());
    assert(await p.locator('#play').isDisabled());
    await p.evaluate(()=>updateProgress());
    assert(await p.locator('#runSpinner').isVisible());
    await p.evaluate(accepted=>{
     if(accepted){
      jobs=[{id:'queued',kind:page,owner:'one',status:'pending',batch:'batch',created:1}];
      accept({batch:'batch'});
     }else fail(Error('HTTP 400: Rejected'));
    },accepted);
    await p.waitForFunction(()=>!submitting);
    assert.equal(await p.locator('#runSpinner').isVisible(),accepted);
    assert(await p.locator('#play').isEnabled());
    assert(await p.locator('#batchButton').isEnabled());
   }
  }
  console.log('Image/video submission spinner survives empty-queue polls, continues when queued, clears on rejection.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
