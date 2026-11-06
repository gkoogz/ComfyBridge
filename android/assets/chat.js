'use strict';
let chat={snapshot:null,draft:'',edit:null,source:'',snap:1,send:null},chatKey='',chatBusy=false,chatSubmitting=false,chatDraftTimer,chatNext=0,chatError='';
let chatComposerCollapsed=false;
const chatShown=new Map();let chatAnimation=0,chatDragging=false,chatTimingAt=performance.now();
async function loadChat(){
 const key='chat:'+(info().fingerprint||'local');if(key===chatKey)return;
 const unsaved=chatKey==='chat:local'&&chat.edit?chat:null;
 chatKey=key;
 const saved=await new Promise(resolve=>{const r=db.transaction('data').objectStore('data').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});
 chat=saved||{snapshot:null,draft:'',edit:null,source:'',snap:1,send:null};
 if(unsaved&&!chat.draft){chat.draft=unsaved.draft;chat.edit=unsaved.edit;chat.source=unsaved.source;}
 chatShown.clear();chatNext=0;if($('#chatText'))$('#chatText').value=chat.draft;
}
function storeChat(){if(!db)return;const tx=db.transaction('data','readwrite');tx.objectStore('data').put(chat,chatKey);tx.onerror=()=>{chatError='Could not save the chat on this device.';paintChatStatus();};}
function chatChanged(){chat.edit=crypto.randomUUID();chat.send=null;chat.conflict=false;storeChat();clearTimeout(chatDraftTimer);chatDraftTimer=setTimeout(()=>syncChat(true),700);}
function receiveChat(data,sentEdit=null){
 if(data.unchanged)return;
 if(chat.snapshot&&data.revision<chat.snapshot.revision)return;
 const before=chat.snapshot;
 const restarted=before?.conversation&&before.conversation!==data.conversation;
 if(restarted){
  if(chat.draft&&!chat.edit)chat.edit=crypto.randomUUID();
  chat.conflict=false;
  if(chat.send)chat.send={...chat.send,conversation:data.conversation};
 }
 chat.snapshot=data;chatTimingAt=performance.now();
 if(chat.send&&data.messages?.some(m=>m.id===chat.send.id)){
  if(chat.draft===chat.send.text){chat.draft='';chat.edit=null;}
  chat.send=null;
 }
 if(!chat.edit||(sentEdit&&sentEdit===chat.edit&&!data.draftConflict)){
  chat.draft=data.draft||'';chat.edit=null;
  if($('#chatText')&&$('#chatText').value!==chat.draft)$('#chatText').value=chat.draft;
 }
 if(data.draftConflict){chat.conflict=true;chatError='Another device edited the draft. Your text is kept here; sending uses your text.';}
 else if(restarted){chatError='';}
 storeChat();paintChat();
}
async function syncChat(force=false){
 if(!connected||document.hidden||chatBusy||chatSubmitting&&!force||!db||!force&&Date.now()<chatNext)return;
 chatBusy=true;const session=epoch;let sent=null;
 try{
  await loadChat();if(epoch!==session)return;
  const initial=await api('studio/chat/state',{after:chat.snapshot?.revision});if(epoch!==session)return;receiveChat(initial);
  sent=chat.conflict?null:chat.edit;
  const data=sent?await api('studio/chat/draft',{conversation:chat.snapshot.conversation,base:chat.snapshot.draft_revision,edit:sent,text:chat.draft}):await api('studio/chat/state',{after:chat.snapshot?.revision});
  if(epoch!==session)return;
  chatError='';receiveChat(data,sent);
 }catch(e){if(epoch===session){chatError=e.message;paintChatStatus();}}
 finally{chatBusy=false;chatNext=Date.now()+(chat.snapshot?.busy?400:3000);paintChatStatus();}
}
function chatViewport(){const v=window.visualViewport;return {height:v?.height||innerHeight,bottom:Math.max(0,innerHeight-(v?.height||innerHeight)-(v?.offsetTop||0))};}
function chatStops(){
 const v=chatViewport(),compose=$('#chatComposer');
 const dock=Math.min(v.height*.65,(compose?.offsetHeight||58)+($('#chatStatus')?.offsetHeight||21)+35);
 const header=$('header')?.getBoundingClientRect().bottom||52;
 const roof=Math.min(v.height*.9,Math.max(dock,v.height-header-62));
 return [28,dock,Math.max(dock,Math.min(v.height*.5,roof)),Math.max(dock,roof)];
}
function sizeChat(){
 const tray=$('#chatTray'),field=$('#chatText');if(!tray||!field||chatDragging)return;
 const v=chatViewport();tray.style.setProperty('--chat-viewport',v.height+'px');tray.style.bottom=v.bottom+'px';
 const style=getComputedStyle(field),tenLines=10*parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);
 const expandedCap=Math.min(v.height*.4,chat.snap<=1?v.height*.4:Math.max(60,v.height*(chat.snap===2?.5:.9)-156));
 const cap=chatComposerCollapsed?Math.min(tenLines,expandedCap):expandedCap;
 field.style.height='0px';field.style.height=Math.min(Math.max(46,field.scrollHeight),cap)+'px';field.style.overflowY=field.scrollHeight>cap?'auto':'hidden';
 const height=chatStops()[chat.snap];tray.style.height=height+'px';
 tray.classList.toggle('nested',chat.snap===0);tray.classList.toggle('docked',chat.snap===1);
 $('#chatGrab').setAttribute('aria-valuenow',chat.snap);
 const sticky=$('#addSticky');if(sticky)sticky.style.bottom=(v.bottom+height+9)+'px';
 $('#main')?.style.setProperty('--chat-clearance',(height+70)+'px');
}
function collapseChatComposer(){
 if(chatComposerCollapsed)return;
 chatComposerCollapsed=true;$('#chatText')?.blur();sizeChat();
}
function expandChatComposer(){
 if(!chatComposerCollapsed)return;
 chatComposerCollapsed=false;sizeChat();
}
function setChatSnap(value){chat.snap=Math.max(0,Math.min(3,value));storeChat();if(!chat.snap)$('#chatText')?.blur();sizeChat();}
function paintChatStatus(){
 const el=$('#chatStatus');if(!el)return;
 el.textContent=chatError||(!connected?'Offline · draft saved here':chat.snapshot?.detail||'Private chat · runs on your PC');
 el.classList.toggle('chatFailure',!!chatError||chat.snapshot?.status==='error');
 $('#chatSend').disabled=chatSubmitting||!!chat.snapshot?.busy||!connected||!chat.draft.trim();
 $('#chatSend').classList.toggle('sending',chatSubmitting);$('#chatSend').setAttribute('aria-label',chatSubmitting?'Sending message':'Send message');
 sizeChat();
}
function preserveChatScroll(update){const list=$('#chatMessages');if(!list)return;const old=list.scrollHeight,atTop=list.scrollTop<24;update();if(!atTop)list.scrollTop+=list.scrollHeight-old;}
function animateChatText(){
 if(chatAnimation)return;
 const frame=()=>{
  chatAnimation=0;if(page!=='notepad'||document.hidden)return;
  let pending=false;
  preserveChatScroll(()=>{
   for(const item of chatDisplayMessages(chat.snapshot?.messages||[])){
    if(item.role!=='assistant')continue;
    const node=$('[data-chat-id="'+item.id+'"] .chatWords');if(!node)continue;
    let shown=chatShown.get(item.id)||'',full=item.content||'';
    if(!full.startsWith(shown)){shown='';chatShown.set(item.id,shown);node.textContent='';}
    if(shown.length<full.length){const count=reduceMotion()?full.length:Math.min(120,Math.max(3,Math.ceil((full.length-shown.length)/5)));shown=full.slice(0,shown.length+count);pending||=shown.length<full.length;chatShown.set(item.id,shown);node.textContent=shown;}
   }
  });
  if(pending)chatAnimation=setTimeout(frame,35);
 };
 chatAnimation=setTimeout(frame,25);
}
function paintChatTimers(){
 const delta=Math.max(0,(performance.now()-chatTimingAt)/1000);
 for(const item of chatDisplayMessages(chat.snapshot?.messages||[])){
  if(item.role!=='assistant')continue;
  const timer=$('[data-chat-id="'+item.id+'"] .chatElapsed');if(!timer)continue;
  const known=typeof item.elapsedSeconds==='number'&&Number.isFinite(item.elapsedSeconds);
  const seconds=known?Math.floor(Math.max(0,item.elapsedSeconds+(item.elapsedRunning?delta:0))):null;
  timer.textContent=seconds===null?'—':Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  timer.title=seconds===null?'Duration was not recorded for this earlier reply':item.elapsedRunning?'Elapsed including waiting, loading and generating':'Total reply time including waiting and loading';
  timer.setAttribute('aria-label',seconds===null?'Reply duration unavailable':timer.textContent+' elapsed');
 }
}
function paintChat(){
 if(!$('#chatTray'))return;
 const list=$('#chatMessages'),items=chatDisplayMessages(chat.snapshot?.messages||[]).reverse();
 preserveChatScroll(()=>{
  const old=new Map($$('[data-chat-id]',list).map(n=>[n.dataset.chatId,n]));
  $('.chatEmpty',list)?.remove();
  for(const [index,item] of items.entries()){
   let bubble=old.get(item.id);old.delete(item.id);
   if(!bubble){bubble=document.createElement('article');bubble.dataset.chatId=item.id;bubble.className='chatMessage '+item.role;
    const words=document.createElement('div');words.className='chatWords';bubble.append(words);
    if(item.role==='assistant'){
     const dots=document.createElement('div');dots.className='chatDots';dots.setAttribute('aria-label','Waiting for a reply');dots.innerHTML='<i></i><i></i><i></i>';bubble.append(dots);
     const copy=document.createElement('button');copy.className='chatCopy';copy.title=item.prompt?'Copy prompt':'Copy response';copy.setAttribute('aria-label',copy.title);copy.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 5V3H3v13h2"/></svg>';
     copy.onclick=async()=>{const current=chatDisplayMessages(chat.snapshot.messages).find(m=>m.id===item.id);try{const text=current?.content||'';if(window.Native?.copyText)await Native.copyText(text);else await navigator.clipboard.writeText(text);toast('Response copied');}catch{toast('Could not copy. You can select the response text.');}};const footer=document.createElement('div');footer.className='chatMessageFooter';footer.append(copy);
     const elapsed=document.createElement('span');elapsed.className='chatElapsed';footer.append(elapsed);bubble.append(footer);
    }else $('.chatWords',bubble).textContent=item.content;
   }
   if(bubble!==list.children[index])list.insertBefore(bubble,list.children[index]||null);
   if(item.role==='assistant'){
    const copy=$('.chatCopy',bubble);copy.title=item.prompt?'Copy prompt':'Copy response';copy.setAttribute('aria-label',copy.title);
    const waiting=['queued','waiting','loading','responding'].includes(item.status)&&!item.content;
    $('.chatDots',bubble).hidden=!waiting;$('.chatCopy',bubble).hidden=!item.content;
    bubble.classList.toggle('chatInterrupted',item.status==='error');
    if(!chatShown.has(item.id)&&item.status==='complete')chatShown.set(item.id,item.content);
    $('.chatWords',bubble).textContent=chatShown.get(item.id)||'';
   }
  }
  old.forEach(n=>{chatShown.delete(n.dataset.chatId);n.remove();});
  if(!items.length)list.innerHTML='<p class="chatEmpty">Talk through an idea, refine a prompt, or ask a question.<br>Your current conversation is shared with your devices.</p>';
 });
 animateChatText();paintChatTimers();paintChatStatus();sizeChat();
}
async function sendChat(){
 if(chatSubmitting||!connected||!chat.draft.trim()||chat.snapshot?.busy)return;
 chatSubmitting=true;chatError='';paintChatStatus();setChatSnap(Math.max(2,chat.snap));
 const session=epoch,text=chat.draft,edit=chat.edit,origin=$('#chatText')?.getBoundingClientRect();
 try{
  while(chatBusy){await new Promise(resolve=>setTimeout(resolve,50));if(epoch!==session)return;}
  await syncChat(true);
  if(!chat.snapshot)throw Error('Connect to the PC to start local chat.');
  if(epoch!==session)return;
  chat.send??={id:crypto.randomUUID(),text,conversation:chat.snapshot.conversation};storeChat();
  let response;
  for(let attempt=0;attempt<2;attempt++){
   try{response=await api('studio/chat/send',{...chat.send,source:chat.source,draft_revision:chat.snapshot.draft===text?chat.snapshot.draft_revision:-1});break;}
   catch(error){
    if(attempt||!error.message.includes('chat was restarted'))throw error;
    const fresh=await api('studio/chat/state');if(epoch!==session)return;
    receiveChat(fresh);chat.send={...chat.send,conversation:fresh.conversation};storeChat();
   }
  }
  if(epoch!==session)return;
  if(chat.draft===text&&(chat.edit===edit||!chat.edit)){chat.draft='';chat.edit=null;chat.source='';$('#chatText')&&($('#chatText').value='');}
  chat.send=null;receiveChat(response);chatNext=0;
  const bubble=$('[data-chat-id="'+response.messages.findLast(m=>m.role==='user')?.id+'"]');
  if(bubble&&!reduceMotion()){const target=bubble.getBoundingClientRect();bubble.animate([{opacity:.25,transform:'translate('+(origin?origin.left-target.left:0)+'px,'+(origin?origin.top-target.top:-28)+'px)'},{opacity:1,transform:'translate(0,0)'}],{duration:320,easing:'cubic-bezier(.2,.8,.2,1)'});}
 }catch(e){chatError=e.message;storeChat();}
 finally{chatSubmitting=false;paintChatStatus();sizeChat();}
}
function confirmNewChat(){
 openModal('New chat','<p>Clear the current conversation and start again? This also clears it on your other devices.</p>','<button id="keepChat">Cancel</button><button id="resetChat" class="danger">Start new chat</button>');
 $('#keepChat').onclick=closeModal;
 $('#resetChat').onclick=async()=>{
  const button=$('#resetChat');button.disabled=true;
  try{
   if(!connected)throw Error('Connect to the PC to restart the shared conversation.');
   if(!chat.snapshot)receiveChat(await api('studio/chat/state'));
   const response=await api('studio/chat/reset',{conversation:chat.snapshot.conversation});
   chat.edit=null;chat.send=null;chat.source='';chatError='';chatShown.clear();receiveChat(response);closeModal();
  }catch(e){toast(e.message);button.disabled=false;}
 };
}
function bindChatSurfaceDrag(tray){
 const list=$('#chatMessages');let gesture=null,inertia=0,suppressUntil=0;
 const stop=()=>{cancelAnimationFrame(inertia);inertia=0;};
 const rubber=height=>{const stops=chatStops(),low=stops[0],high=stops[3];return height<low?low-18*(1-Math.exp((height-low)/70)):height>high?high+32*(1-Math.exp((high-height)/110)):height;};
 const moveTray=height=>{chatDragging=true;tray.classList.add('draggingChat');tray.style.height=rubber(height)+'px';$('#addSticky').style.bottom=(chatViewport().bottom+rubber(height)+9)+'px';};
 const coast=velocity=>{
  let previous=performance.now();
  const frame=now=>{if(!list.isConnected||page!=='notepad')return;const dt=Math.min(32,now-previous);previous=now;const before=list.scrollTop;list.scrollTop-=velocity*dt;velocity*=Math.pow(.92,dt/16);if(Math.abs(velocity)>.025&&Math.abs(list.scrollTop-before)>.1)inertia=requestAnimationFrame(frame);};
  inertia=requestAnimationFrame(frame);
 };
 tray.addEventListener('pointerdown',e=>{
  if(!e.isPrimary||e.button!==0||e.target.closest('#chatGrab,input,textarea,button,select,a')||window.getSelection()?.type==='Range')return;
  // Mouse users can still select response text normally; touch keeps long-press selection.
  if(e.pointerType==='mouse'&&e.target.closest('.chatWords'))return;
  stop();gesture={id:e.pointerId,x:e.clientX,y:e.clientY,last:e.clientY,time:performance.now(),height:tray.offsetHeight,startHeight:tray.offsetHeight,snap:chat.snap,list:!!e.target.closest('#chatMessages'),axis:null,drag:false,edge:false,velocity:0};
 });
 tray.addEventListener('pointermove',e=>{
  const g=gesture;if(!g||g.id!==e.pointerId)return;
  if(window.getSelection()?.type==='Range'){gesture=null;return;}
  const dx=e.clientX-g.x,dy=e.clientY-g.y;
  if(!g.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<7)return;g.axis=Math.abs(dy)>Math.abs(dx)?'y':'x';if(g.axis==='y')tray.setPointerCapture(e.pointerId);}
  if(g.axis!=='y')return;
  if(g.list)collapseChatComposer();
  e.preventDefault();e.stopPropagation();
  const now=performance.now(),step=e.clientY-g.last,dt=Math.max(8,now-g.time);g.velocity=g.velocity*.35+step/dt*.65;g.last=e.clientY;g.time=now;
  const limit=Math.max(0,list.scrollHeight-list.clientHeight);
  if(!g.drag&&g.list&&limit>1){
   const wanted=list.scrollTop-step,next=Math.max(0,Math.min(limit,wanted));list.scrollTop=next;
   const excess=next-wanted;if(Math.abs(excess)<.5)return;
   g.drag=true;g.edge=true;g.height-=excess*.38;
  }else{g.drag=true;g.height-=step*(g.edge?.38:1);}
  moveTray(g.height);
 });
 const finish=(e,cancelled=false)=>{
  const g=gesture;if(!g||g.id!==e.pointerId)return;gesture=null;
  if(g.axis!=='y')return;
  suppressUntil=performance.now()+350;
  if(g.drag){
   chatDragging=false;tray.classList.remove('draggingChat');tray.classList.add('springChat');
   const stops=chatStops();let snap=cancelled?g.snap:stops.reduce((best,h,i)=>Math.abs(h-g.height)<Math.abs(stops[best]-g.height)?i:best,0);
   if(g.edge&&Math.abs(g.height-g.startHeight)<48)snap=g.snap;
   else if(!cancelled&&!g.edge&&Math.abs(g.velocity)>.55)snap=Math.max(0,Math.min(3,g.snap+(g.velocity<0?1:-1)));
   setChatSnap(snap);setTimeout(()=>tray.classList.remove('springChat'),430);
  }else if(!cancelled&&Math.abs(g.velocity)>.05)coast(g.velocity);
 };
 tray.addEventListener('pointerup',e=>finish(e));tray.addEventListener('pointercancel',e=>finish(e,true));
 tray.addEventListener('click',e=>{if(performance.now()<suppressUntil){e.preventDefault();e.stopPropagation();}},true);
}
function mountChat(){
 $('#chatTray')?.remove();
 const tray=document.createElement('section');tray.id='chatTray';tray.setAttribute('aria-label','Local AI chat');
 tray.innerHTML='<button id="chatGrab" role="slider" aria-label="Chat tray height" aria-valuemin="0" aria-valuemax="3" aria-valuenow="1"><span></span></button><div id="chatComposer"><textarea id="chatText" rows="1" maxlength="24000" placeholder="Chat about a prompt or idea…" aria-label="Message local AI"></textarea><div class="chatComposerButtons"><button id="chatNew" aria-label="New chat" title="New chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/></svg></button><button id="chatSend" aria-label="Send message"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></span></button></div></div><small id="chatStatus" role="status"></small><div id="chatMessages" aria-label="Conversation, newest messages first"></div>';
 $('#workspace').append(tray);$('#chatText').value=chat.draft;
 $('#chatText').onpointerdown=expandChatComposer;$('#chatText').onfocus=expandChatComposer;
 $('#chatMessages').addEventListener('wheel',e=>{if(Math.abs(e.deltaY)>0)collapseChatComposer();},{passive:true});
 $('#chatText').oninput=()=>{chat.draft=$('#chatText').value;chatChanged();sizeChat();paintChatStatus();};
 $('#chatText').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendChat();}};
 $('#chatSend').onclick=sendChat;$('#chatNew').onclick=confirmNewChat;
 const grab=$('#chatGrab');let gesture=null,suppress=false;
 grab.onpointerdown=e=>{if(e.button!==0)return;e.stopPropagation();gesture={id:e.pointerId,y:e.clientY,height:tray.offsetHeight,time:performance.now()};chatDragging=true;tray.classList.add('draggingChat');grab.setPointerCapture(e.pointerId);};
 grab.onpointermove=e=>{if(!gesture||gesture.id!==e.pointerId)return;e.preventDefault();const height=Math.max(28,Math.min(chatViewport().height*.94,gesture.height+gesture.y-e.clientY));tray.style.height=height+'px';$('#addSticky').style.bottom=(chatViewport().bottom+height+9)+'px';};
 const finish=e=>{if(!gesture||gesture.id!==e.pointerId)return;const moved=gesture.y-e.clientY,velocity=moved/Math.max(1,performance.now()-gesture.time);let snap=chatStops().reduce((best,h,i,a)=>Math.abs(h-tray.offsetHeight)<Math.abs(a[best]-tray.offsetHeight)?i:best,0);if(Math.abs(moved)>30&&Math.abs(velocity)>.45)snap=Math.max(0,Math.min(3,chat.snap+(moved>0?1:-1)));suppress=Math.abs(moved)>5;gesture=null;chatDragging=false;tray.classList.remove('draggingChat');setChatSnap(snap);};
 grab.onpointerup=finish;grab.onpointercancel=()=>{gesture=null;chatDragging=false;tray.classList.remove('draggingChat');sizeChat();};
 grab.onclick=()=>{if(suppress){suppress=false;return;}setChatSnap(chat.snap===3?1:chat.snap+1);};
 grab.onkeydown=e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();setChatSnap(e.key==='Home'?0:e.key==='End'?3:chat.snap+(e.key==='ArrowUp'?1:-1));}};
 bindChatSurfaceDrag(tray);paintChat();syncChat(true);
}
async function chatAboutPrompt(key){
 const text=$('textarea[data-setting="'+key+'"]')?.value??state.settings[page]?.[key]??'',source=page+' '+key;
 await loadChat();chatComposerCollapsed=false;chat.draft=text;chat.source=source;chat.snap=1;chatChanged();navigate('notepad');
 $('#chatText').focus({preventScroll:true});$('#chatText').setSelectionRange(text.length,text.length);sizeChat();
}
window.addEventListener('resize',sizeChat);window.visualViewport?.addEventListener('resize',sizeChat);window.visualViewport?.addEventListener('scroll',sizeChat);
setInterval(()=>{if(page==='notepad'&&!document.hidden){syncChat();animateChatText();paintChatTimers();}},400);
