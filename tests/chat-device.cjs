const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.WEBVIEW_CDP||'http://127.0.0.1:9223');
 try{
  const context=browser.contexts()[0],p=context.pages().find(p=>p.url().includes('appassets'));if(!p)throw Error('ComfyBridge WebView is not open');
  const cdp=await context.newCDPSession(p);const errors=[];p.on('pageerror',e=>errors.push(e.message));
  console.log('Phone app',await p.evaluate(()=>({page,connected,paired:info().paired,viewport:[innerWidth,innerHeight],statusInset:getComputedStyle(document.documentElement).getPropertyValue('--status-inset')})));
  if(!await p.evaluate(()=>connected)){await p.evaluate(()=>navigate('bridge'));await p.locator('#connect').click();await p.waitForFunction(()=>connected,{},{timeout:30000});}
  await p.evaluate(()=>navigate('notepad'));await p.waitForSelector('#chatTray');
  await p.waitForFunction(()=>chat.snapshot?.conversation,{},{timeout:30000});
  const notes=await p.evaluate(()=>JSON.stringify(notebook.doc));
  const original=await p.locator('#chatText').inputValue();
  console.log('Shared chat',await p.evaluate(()=>({messages:chat.snapshot.messages.length,busy:chat.snapshot.busy,draftLength:chat.draft.length,error:chatError})));
  await p.evaluate(()=>setChatSnap(1));await p.waitForTimeout(350);
  const h=await p.locator('#chatGrab').boundingBox();
  const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const x=h.x+h.width/2,y=h.y+h.height/2;
  await touch('touchStart',x,y);for(let n=1;n<=8;n++){await touch('touchMove',x,y-n*34);await p.waitForTimeout(25);}await touch('touchEnd');await p.waitForTimeout(350);
  assert.equal(await p.evaluate(()=>chat.snap),2);
  assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
  if(await p.evaluate(()=>$('#chatMessages').scrollHeight>$('#chatMessages').clientHeight+60)){
   await p.evaluate(()=>$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight);
   const area=await p.locator('#chatMessages').boundingBox(),sx=area.x+area.width-20,sy=area.y+area.height-30;
   await touch('touchStart',sx,sy);for(let n=1;n<=10;n++){await touch('touchMove',sx,sy-55*n/10);await p.waitForTimeout(20);}
   assert(await p.evaluate(()=>$('#chatTray').offsetHeight>chatStops()[2]));await touch('touchEnd');await p.waitForTimeout(450);
   assert.equal(await p.evaluate(()=>chat.snap),2);assert(await p.evaluate(()=>Math.abs($('#chatTray').offsetHeight-chatStops()[2])<2));
   console.log('Physical touch: conversation edge pull and spring return passed.');
  }
  const answer=await p.evaluate(()=>[...(chat.snapshot?.messages||[])].reverse().find(m=>m.role==='assistant'&&m.content)?.content);
  if(answer){
   await p.locator('.chatCopy:not([hidden])').first().click();await p.waitForTimeout(400);
   await p.locator('#chatText').click();execFileSync(process.env.LOCALAPPDATA+'/Android/Sdk/platform-tools/adb.exe',['shell','input','keyevent','279']);
   await p.waitForFunction(value=>$('#chatText').value===value,answer,{timeout:10000});
   console.log('Native response copy and Android paste passed.');
  }
  await p.locator('#chatText').fill('A quiet woodland at dawn, mist between the trees.');
  await p.evaluate(()=>$('#chatText').dispatchEvent(new Event('input',{bubbles:true})));
  await p.waitForTimeout(1000);
  assert(await p.evaluate(()=>$('#chatText').value===chat.draft));
  assert(await p.evaluate(()=>$('#addSticky').getBoundingClientRect().bottom<$('#chatTray').getBoundingClientRect().top));
  if(process.env.CHAT_DEVICE_SHOT)await p.screenshot({path:process.env.CHAT_DEVICE_SHOT});
  await p.locator('#chatText').fill(original);await p.evaluate(()=>$('#chatText').dispatchEvent(new Event('input',{bubbles:true})));await p.waitForTimeout(1000);
  await p.evaluate(()=>{$('#chatText').blur();setChatSnap(1);});
  assert.equal(await p.evaluate(()=>JSON.stringify(notebook.doc)),notes);
  assert.deepEqual(errors,[]);
  console.log('Physical phone: connected chat state, touch snap, drawer isolation, composer editing, sticky anchor and unchanged notes passed. Draft restored.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
