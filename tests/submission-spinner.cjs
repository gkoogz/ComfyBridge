// Hold submission open while background polls still report an empty queue.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({hasTouch:true});
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>'',watchBatch:()=>{}};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  for(const kind of ['image','video']){
   await p.setViewportSize({width:kind==='image'?320:430,height:740});
   for(const accepted of [true,false]){
    await p.evaluate(kind=>{
     window.poll=window.heartbeat=window.syncSettings=async()=>{};window.persist=()=>{};
     connected=true;queueProtocol=16;jobs=[];active=null;
     state.pendingByKind={};state.inputs[kind]={};
     state.settings[kind]={width:256,height:384,scale:0,steps:4,cfg:1,denoise:1,frames:22,fps:24,
      model:'test',positive:'',negative:'',loras:[],seed:'1',batch:1};
     window.api=(route,body)=>new Promise((resolve,reject)=>{window.requested={route,body};window.accept=resolve;window.fail=reject;});
     navigate(kind);
    },kind);
    const play=p.locator('#play'),batch=p.locator('#batchButton'),spinner=p.locator('#runSpinner'),stop=p.locator('#stopBatch');
    const initial=await play.boundingBox(),batchBox=await batch.boundingBox();
    assert(batchBox.width>=48&&batchBox.height===initial.height);
    // The left edge of the caret segment is part of the target.
    await p.touchscreen.tap(batchBox.x+4,batchBox.y+batchBox.height/2);
    assert.equal(await batch.getAttribute('aria-expanded'),'true');
    assert.deepEqual(await p.locator('#batchMenu button').allTextContents(),['Batch of 2','Batch of 4','Batch of 8','Batch of 16']);
    assert.equal(await p.locator('#batchMenu button svg').count(),4);
    if(accepted){
     await p.locator('[data-batch="4"]').tap();
    }else{
     await p.keyboard.press('Escape');
     assert(await p.locator('#batchMenu').isHidden());
     const before=await play.evaluate(el=>getComputedStyle(el).boxShadow);
     await p.mouse.move(initial.x+initial.width/2,initial.y+initial.height/2);
     await p.mouse.down();
     assert.notEqual(await play.evaluate(el=>getComputedStyle(el).boxShadow),before);
     assert.deepEqual(await play.boundingBox(),initial);
     await p.mouse.up();
    }
    assert.equal(await batch.getAttribute('aria-expanded'),'false');
    assert.equal(await p.evaluate(()=>requested.body.count),accepted?4:1);
    assert(await p.locator('#runSpinner').isVisible());
    assert(await p.locator('#play').isDisabled());
    const spinBox=await spinner.boundingBox();
    assert(spinBox.x>=batchBox.x+batchBox.width);
    assert.deepEqual(await play.boundingBox(),initial);
    await p.evaluate(()=>updateProgress());
    assert(await p.locator('#runSpinner').isVisible());
    await p.evaluate(accepted=>{
     if(accepted){
      jobs=[{id:'queued',kind:page,owner:'one',status:'pending',batch:'batch',created:Date.now()/1000,
       ordinal:1,total:4,queuePosition:1,queueTotal:4}];
      accept({batch:'batch'});
     }else fail(Error('HTTP 400: Rejected'));
    },accepted);
    await p.waitForFunction(()=>!submitting);
    assert.equal(await p.locator('#runSpinner').isVisible(),accepted);
    assert(await p.locator('#play').isEnabled());
    assert(await p.locator('#batchButton').isEnabled());
    await p.evaluate(()=>updateProgress());
    assert.deepEqual(await play.boundingBox(),initial);
    if(accepted){
     assert.equal(await play.innerText(),'Add to queue');
     const stopBox=await stop.boundingBox();
     assert.equal(stopBox.y,initial.y);
     assert.equal(stopBox.height,initial.height);
     const work=await p.locator('#workspace').boundingBox();
     assert(stopBox.x>=spinBox.x+spinBox.width&&stopBox.x+stopBox.width<=work.x+work.width);
     if(process.env.GENERATE_SHOT&&kind==='image')await p.screenshot({path:process.env.GENERATE_SHOT});
    }
   }
  }
  console.log('Stable Generate position, press feedback, batch touch targets, aligned Stop mine and submission spinner passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
