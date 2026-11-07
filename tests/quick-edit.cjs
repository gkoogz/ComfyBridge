const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'test',fingerprint:'fixture',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=syncNotes=syncChat=()=>{};connected=true;profileReady=false;persist=()=>{};
   window.commands=[];window.edits={};window.finishEdits=false;
   api=async(route,body)=>{
    commands.push({route,body});
    if(route==='studio/chat/quick-submit'){
     edits[body.id]??={...body,status:'waiting',detail:'Waiting for GPU',elapsedSeconds:3};return {...edits[body.id]};
    }
    if(route==='studio/chat/quick-state')return edits[body.id]?{...edits[body.id],...(finishEdits?{status:'complete',result:'A blue bowl.\nSoft light.'}:{})}:{status:'missing'};
    if(route==='studio/chat/quick-discard'){delete edits[body.id];return {status:'discarded'};}
    return {};
   };
   for(const kind of ['image','video'])state.settings[kind]={width:512,height:768,frames:240,fps:24,steps:4,loras:[],seed:'5',batch:1,model:'fixture',positive:'An orange bowl.',negative:'blurry, low contrast',cfg:5,denoise:1};
   navigate('image');
  });
  await p.waitForSelector('[data-quick-action=open]');
  const field=p.locator('textarea.promptEntry[data-setting=positive]'),panel=p.locator('[data-quick-panel=positive]'),actions=p.locator('[data-quick-actions=positive]');
  const before=await p.locator('[data-setting=seed]').inputValue();await p.locator('#randomSeed').click();
  const seed=await p.locator('[data-setting=seed]').inputValue();assert.notEqual(seed,before);assert(BigInt(seed)>=0n&&BigInt(seed)<2n**64n);
  await actions.locator('[data-quick-action=open]').click();assert(await p.locator('[data-chat-prompt=positive]').isHidden());
  await panel.locator('textarea').fill('Discard these instructions.');await actions.locator('[data-quick-action=discard]').click();
  assert.equal(await panel.locator('textarea').count(),0);assert(await p.locator('[data-chat-prompt=positive]').isVisible());
  await actions.locator('[data-quick-action=open]').click();assert.equal(await panel.locator('textarea').inputValue(),'');
  await panel.locator('textarea').fill('Make the bowl blue.');await actions.locator('[data-quick-action=submit]').click();
  await p.waitForSelector('.quickSubmitted');
  assert.equal(await panel.locator('textarea').count(),0);assert.equal(await actions.locator('button').count(),0);
  assert(await actions.locator('.spinner').isVisible());assert.match(await actions.locator('time').textContent(),/^\d+:\d{2}$/);
  assert.equal(await panel.locator('.quickSubmitted').textContent(),'Make the bowl blue.');assert.equal(await field.inputValue(),'An orange bowl.');
  if(process.env.QUICK_SHOTS){await panel.scrollIntoViewIfNeeded();await p.screenshot({path:path.join(process.env.QUICK_SHOTS,'quick-edit-waiting.png')});}
  assert(await p.evaluate(()=>commands.some(x=>x.route.endsWith('quick-submit')&&x.body.prompt==='An orange bowl.'&&x.body.instructions==='Make the bowl blue.'&&x.body.source==='image positive')));
  // Navigation/rerender must preserve the pending edit and its original prompt snapshot.
  await p.evaluate(()=>{navigate('video');navigate('image');});await p.waitForSelector('.quickSubmitted');
  await field.fill('Changed while waiting.');
  await p.evaluate(async()=>{finishEdits=true;await syncQuickEdits();});await p.waitForSelector('.quickProposed');
  assert.equal(await field.inputValue(),'Changed while waiting.');assert((await panel.textContent()).includes('prompt above changed'));
  if(process.env.QUICK_SHOTS){await panel.scrollIntoViewIfNeeded();await p.screenshot({path:path.join(process.env.QUICK_SHOTS,'quick-edit-proposed.png')});}
  await panel.locator('[data-quick-action=use]').click();
  assert.equal(await field.inputValue(),'A blue bowl.\nSoft light.');assert(await field.evaluate(e=>e.classList.contains('quickApplied')));
  assert(await p.locator('[data-chat-prompt=positive]').isVisible());assert.equal(await panel.locator('.quickProposed').count(),0);
  // All four prompt panels have their own requests. Discard never replaces original text.
  for(const kind of ['image','video'])for(const key of ['positive','negative']){
   await p.evaluate(kind=>navigate(kind),kind);await p.waitForSelector('[data-quick-action=open]');
   const a=p.locator('[data-quick-actions='+key+']'),h=p.locator('[data-quick-panel='+key+']'),f=p.locator('textarea.promptEntry[data-setting='+key+']');
   const old=await f.inputValue();await a.locator('[data-quick-action=open]').click();await h.locator('textarea').fill('Change the color.');await a.locator('[data-quick-action=submit]').click();
   await p.evaluate(()=>syncQuickEdits());await p.waitForSelector('[data-quick-panel='+key+'] .quickProposed');
   await h.locator('[data-quick-action=discard]').click();assert.equal(await f.inputValue(),old);
  }
  // Waiting survives a reload in the local persistent store.
  await p.evaluate(()=>finishEdits=false);
  await p.locator('[data-quick-actions=positive] [data-quick-action=open]').click();
  await p.locator('[data-quick-panel=positive] textarea').fill('Persistent instructions.');
  await p.locator('[data-quick-actions=positive] [data-quick-action=submit]').click();
  await p.waitForTimeout(100);await p.evaluate(()=>{connected=false;quickStore();});await p.reload();await p.waitForSelector('#connect');
  await p.evaluate(async()=>{await loadQuickEdits();});
  assert.equal(await p.evaluate(()=>quickSlots['video:positive'].text),'Persistent instructions.');
  assert.equal(await p.evaluate(()=>quickSlots['video:positive'].phase),'working');
  assert.deepEqual(errors,[]);
  console.log('Seed range, four prompt panels, cancel, frozen submission, timer, separate payload, navigation, proposal acceptance/discard and reload persistence passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
