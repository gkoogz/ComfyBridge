const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'test',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=syncNotes=()=>{};connected=true;profileReady=false;
   window.commands=[];window.remote={conversation:'one',revision:0,draft:'',draft_revision:0,draft_device:'test',messages:[],status:'idle',active:null,busy:false,detail:''};
   api=async(route,body)=>{
    commands.push({route,body});
    if(route==='studio/chat/state')return structuredClone(remote);
    if(route==='studio/chat/draft'){remote.draft=body.text;remote.draft_revision++;remote.revision++;return structuredClone(remote);}
    if(route==='studio/chat/send'){
     remote.messages.push({id:body.id,role:'user',content:body.text,status:'complete'},{id:'answer',role:'assistant',content:'',status:'loading'});
     remote.active='answer';remote.busy=true;remote.status='loading';remote.draft='';remote.draft_revision++;remote.revision++;return structuredClone(remote);
    }
    if(route==='studio/chat/reset'){remote.messages=[];remote.active=null;remote.busy=false;remote.status='idle';remote.conversation='two';remote.draft='';remote.revision++;return structuredClone(remote);}
    throw Error('Unexpected route '+route);
   };
   for(const kind of ['image','video'])state.settings[kind]={width:1024,height:1536,frames:240,fps:24,steps:4,loras:[],seed:'5',batch:1,model:'fixture',positive:'A mountain valley at sunrise.\nSoft mist and natural colors.',negative:'blurry, low contrast',cfg:5,denoise:1};
   notebook.doc={text:'Keep these notes and stickies.',marks:[{start:0,end:0,color:0}],next:1};
   navigate('image');
  });
  assert.equal(await p.locator('[data-chat-prompt]').count(),2);
  await p.locator('[data-chat-prompt=positive]').click();await p.waitForSelector('#chatText');
  assert.equal(await p.evaluate(()=>page),'notepad');
  assert.equal(await p.locator('#chatText').inputValue(),'A mountain valley at sunrise.\nSoft mist and natural colors.');
  assert.equal(await p.evaluate(()=>chat.snap),1);
  assert.equal(await p.locator('#desktopChatModel').count(),0);
  assert(!await p.evaluate(()=>commands.some(c=>c.route.endsWith('/send'))));
  // The composer grows up to its cap, then owns its own scrolling.
  await p.locator('#chatText').fill(Array(60).fill('A long line of notes about a landscape.').join('\n'));
  const dimensions=await p.evaluate(()=>({field:$('#chatText').clientHeight,screen:innerHeight,scroll:$('#chatText').scrollHeight}));
  assert(dimensions.field<=dimensions.screen*.5+1&&dimensions.scroll>dimensions.field);
  await p.locator('#chatText').fill('Suggest a concise landscape prompt.');
  await p.locator('#chatSend').click();await p.waitForSelector('.chatDots:not([hidden])');
  assert.equal(await p.evaluate(()=>chat.snap),2);
  assert.equal(await p.locator('#chatText').inputValue(),'');
  assert.deepEqual(await p.locator('[data-chat-id]').evaluateAll(nodes=>nodes.map(n=>n.classList.contains('assistant')?'assistant':'user')),['assistant','user']);
  assert(await p.evaluate(()=>$('#addSticky').getBoundingClientRect().bottom<$('#chatTray').getBoundingClientRect().top));
  await p.evaluate(()=>{remote.messages[1].content='Sunrise over a mountain valley, soft mist, warm rim light and natural colors.';remote.messages[1].status='responding';remote.revision++;receiveChat(structuredClone(remote));});
  await p.waitForFunction(()=>$('.assistant .chatWords').textContent.length>0);
  await p.waitForFunction(()=>$('.assistant .chatWords').textContent===remote.messages[1].content);
  await p.evaluate(()=>{remote.messages[1].status='complete';remote.active=null;remote.status='idle';remote.busy=false;remote.revision++;receiveChat(structuredClone(remote));});
  assert(await p.locator('.chatCopy').isVisible());
  // Four magnetic positions, smooth handle drag, and no accidental sidebar gesture.
  await p.evaluate(()=>setChatSnap(0));await p.waitForTimeout(300);assert.equal(await p.locator('#chatGrab').getAttribute('aria-valuenow'),'0');
  assert(await p.evaluate(()=>$('#chatTray').offsetHeight===28));
  await p.locator('#chatGrab').click();await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>chat.snap),1);
  const handle=await p.locator('#chatGrab').boundingBox();await p.mouse.move(handle.x+100,handle.y+10);await p.mouse.down();await p.mouse.move(handle.x+100,handle.y-270,{steps:15});await p.mouse.up();await p.waitForTimeout(300);
  assert.equal(await p.evaluate(()=>chat.snap),2);assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
  // The empty conversation surface drags too. A long conversation scrolls instead,
  // and an edge pull moves with resistance before springing back to its snap.
  let surface=await p.locator('#chatMessages').boundingBox();
  await p.mouse.move(surface.x+20,surface.y+surface.height-35);await p.mouse.down();await p.mouse.move(surface.x+20,surface.y+surface.height-265,{steps:12});await p.mouse.up();await p.waitForTimeout(450);
  assert.equal(await p.evaluate(()=>chat.snap),3);
  await p.evaluate(()=>{setChatSnap(2);window.shortReply=remote.messages[1].content;remote.messages[1].content=Array(60).fill('A longer conversation line.').join('\n');remote.revision++;chatShown.set('answer',remote.messages[1].content);receiveChat(structuredClone(remote));});await p.waitForTimeout(350);
  surface=await p.locator('#chatMessages').boundingBox();
  const touchSession=await p.context().newCDPSession(p),touch=async(type,x,y)=>touchSession.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const tx=surface.x+surface.width-20,ty=surface.y+surface.height-25;
  await touch('touchStart',tx,ty);for(let n=1;n<=18;n++){await touch('touchMove',tx,ty-(surface.height-50)*n/18);await p.waitForTimeout(12);}await touch('touchEnd');await p.waitForTimeout(900);
  assert(await p.evaluate(()=>$('#chatMessages').scrollTop>50));assert.equal(await p.evaluate(()=>chat.snap),2);
  await p.evaluate(()=>$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight);
  await touch('touchStart',tx,ty);for(let n=1;n<=10;n++){await touch('touchMove',tx,ty-55*n/10);await p.waitForTimeout(12);}
  assert(await p.evaluate(()=>$('#chatTray').offsetHeight>chatStops()[2]));await touch('touchEnd');await p.waitForTimeout(450);
  assert.equal(await p.evaluate(()=>chat.snap),2);assert(await p.evaluate(()=>Math.abs($('#chatTray').offsetHeight-chatStops()[2])<2));
  await p.evaluate(()=>{remote.messages[1].content=shortReply;remote.revision++;chatShown.set('answer',shortReply);receiveChat(structuredClone(remote));$('#chatMessages').scrollTop=0;});
  await p.locator('#chatGrab').focus();await p.keyboard.press('End');await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>chat.snap),3);
  assert(await p.evaluate(()=>$('#chatTray').getBoundingClientRect().top>=$('header').getBoundingClientRect().bottom+60));
  if(process.env.CHAT_SHOT)await p.screenshot({path:process.env.CHAT_SHOT});
  // Reset requires confirmation, only clears the active chat, and leaves Notepad intact.
  await p.locator('#chatNew').click();assert.equal(await p.locator('#modalTitle').textContent(),'New chat');
  assert.equal(await p.evaluate(()=>remote.messages.length),2);await p.locator('#keepChat').click();
  await p.locator('#chatNew').click();await p.locator('#resetChat').click();await p.waitForFunction(()=>!remote.messages.length);
  assert.equal(await p.evaluate(()=>notebook.doc.text),'Keep these notes and stickies.');
  assert.equal(await p.evaluate(()=>notebook.doc.marks.length),1);
  // An older response cannot roll back a reset, and a conflict keeps the local draft.
  await p.evaluate(()=>{const revision=chat.snapshot.revision;receiveChat({...remote,conversation:'old',revision:revision-1});});
  assert.equal(await p.evaluate(()=>chat.snapshot.conversation),'two');
  await p.locator('#chatText').fill('Persistent unsent idea');await p.evaluate(()=>{chat.conflict=true;receiveChat({...remote,revision:remote.revision+1,draft:'Other phone draft',draftConflict:true});});
  assert.equal(await p.locator('#chatText').inputValue(),'Persistent unsent idea');
  await p.evaluate(()=>{connected=false;storeChat();});await p.reload();await p.waitForSelector('#connect');
  assert.equal(await p.evaluate(()=>chat.draft),'Persistent unsent idea');
  assert.deepEqual(errors,[]);
  console.log('Prompt handoff, persistent draft, growth cap, newest-first bubbles, streaming reveal, four snap positions, sticky anchoring, reset confirmation, note preservation, stale responses and draft conflicts passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
