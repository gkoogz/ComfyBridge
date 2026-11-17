'use strict';
// Loaded on both platforms; host capability is injected only by the Windows app.
if(window.Desktop){
 const callbacks=new Map();let serial=0;
 window.desktopCall=(op,args={})=>new Promise((resolve,reject)=>{
  const id=++serial;callbacks.set(id,{resolve,reject});chrome.webview.postMessage({id,op,args});
 });
 chrome.webview.addEventListener('message',({data})=>{const p=callbacks.get(data.id);if(!p)return;callbacks.delete(data.id);data.ok?p.resolve(data.value):p.reject(Error(data.value));});
 const forward=(id,promise)=>promise.then(value=>window.bridgeResult(id,true,value),error=>window.bridgeResult(id,false,error.message));
 window.Native={
  configuration:()=>JSON.stringify(window.desktopConfiguration),
  request:(id,path,method,body)=>forward(id,desktopCall('request',{path,method,body})),
  localMedia:(id,action,value)=>forward(id,desktopCall('local',{action,value:JSON.parse(value)})),
  notificationRoute:()=>'',watchBatch:()=>{},haptic:()=>{},
  copyText:text=>desktopCall('copyText',{text}),
  openListing:url=>desktopCall('openListing',{url}),
  openProfile:url=>desktopCall('openProfile',{url}),
  enableAlerts:()=>toast('Keep the desktop studio open to follow generation progress.')
 };
 document.documentElement.classList.add('desktop');
}
async function initDesktop(){
 if(!window.Desktop)return;
 const powerIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10M6.4 5.5a9 9 0 1 0 11.2 0"/></svg>';
 page=localStorage.getItem('desktopPage')||'image';if(!['browse','image','video','library','notepad'].includes(page))page='image';
 const title=document.createElement('div');title.id='desktopTitle';
 title.innerHTML='<strong>ComfyBridge <small>DESKTOP STUDIO</small></strong><div><button data-window="collapse" title="Collapse to tray panel" aria-label="Collapse to tray panel">↘</button><button data-window="hide" title="Hide to tray" aria-label="Hide to tray">–</button><button data-window="hide" class="desktopClose" title="Hide to tray" aria-label="Hide to tray">×</button></div>';
 document.body.prepend(title);
 title.onpointerdown=e=>{if(e.button===0&&!e.target.closest('button'))desktopCall('drag');};
 title.querySelectorAll('[data-window]').forEach(b=>b.onclick=async()=>{if(profileDirty)await flushProfile();desktopCall(b.dataset.window);});
 const layout=document.createElement('div');
 layout.id='desktopFeedLayout';layout.setAttribute('role','group');layout.setAttribute('aria-label','Feed columns');
 function selectColumns(value){
  document.documentElement.dataset.feedColumns=value;
  for(const button of layout.children)button.setAttribute('aria-pressed',String(button.value===value));
 }
 for(const count of ['1','2']){
  const button=document.createElement('button');button.type='button';button.value=count;
  button.title=count==='1'?'One column':'Two columns';button.setAttribute('aria-label',button.title);
  button.innerHTML='<i aria-hidden="true"></i>'.repeat(Number(count));
  button.onclick=()=>{selectColumns(count);localStorage.setItem('desktopFeedColumns',count);};
  layout.append(button);
 }
 selectColumns(localStorage.getItem('desktopFeedColumns')==='1'?'1':'2');document.body.append(layout);
 const left=$('#drawerBridge');left.id='desktopBridge';
 left.innerHTML='<div class="desktopServer"><div class="row spread"><div><strong id="desktopServerState">Checking server…</strong><small id="desktopPhones"></small></div><div class="row desktopPowerRow"><button id="desktopCivitai" type="button" aria-label="Civitai preview settings" title="Civitai API key for listing previews">⚙</button><button id="desktopPower" aria-label="Toggle server power">⏻</button></div></div><label for="desktopAddress">PC address · enter on your phone</label><div class="row"><select id="desktopAddress"></select><button id="desktopCopy" title="Copy address">Copy</button><button id="desktopEdit" title="Edit remote address">✎</button></div><div class="row spread desktopPairRow"><label>Pairing code</label><strong id="desktopCode">—</strong><button id="desktopNewCode">New code</button></div><small id="desktopPairHint"></small><div id="desktopError" role="alert" hidden></div></div>'+machinePulse('LOCAL')+bridgeActivityMarkup();
 const chatControls=document.createElement('div');chatControls.className='desktopChatControls';chatControls.innerHTML='<label for="desktopChatModel">Local chat model</label><select id="desktopChatModel" aria-label="Local chat model"></select><small id="desktopChatHint">Checking installed models…</small>';
 $('.desktopServer').append(chatControls);
 let chatLoading=false,chatModelChanged=false;
 const refreshChatModels=async()=>{
  if(chatLoading||document.hidden)return;chatLoading=true;
  try{const data=await desktopCall('chatModels'),select=$('#desktopChatModel');
   const choices=data.models||[],signature=JSON.stringify(choices);
   if(select.dataset.models!==signature){select.replaceChildren(...choices.map(m=>new Option(m.name,m.id)));select.dataset.models=signature;}
   select.value=data.selected||'';select.disabled=!choices.length;
   $('#desktopChatHint').classList.toggle('hasError',chatModelChanged||!choices.length);
   if(!chatModelChanged)$('#desktopChatHint').textContent=choices.length?'Loads on demand · releases memory after replying':'Run Setup-Chat.ps1 on this PC to install a model.';
  }catch(e){$('#desktopChatHint').classList.add('hasError');$('#desktopChatHint').textContent=e.message;}finally{chatLoading=false;}
 };
 $('#desktopChatModel').onchange=async()=>{const select=$('#desktopChatModel');select.disabled=true;
  try{await desktopCall('chatSelect',{id:select.value});chatModelChanged=false;}
  catch(e){chatModelChanged=true;$('#desktopChatHint').textContent=e.message;}
  finally{await refreshChatModels();}
 };
 refreshChatModels();setInterval(refreshChatModels,5000);
 $('#desktopPower').innerHTML=powerIcon;
 initDesktopSidebar();
 initDesktopCarousel();
 let status,busy=false,refreshing=false,revision=0;
 const paint=s=>{
  status=s;$('#desktopServerState').textContent=s.online?'● Server on':'● Server off';$('#desktopServerState').className=s.online?'serverOnline':'serverOffline';
  $('#desktopPhones').textContent=s.phones?s.phones+(s.phones===1?' phone connected':' phones connected'):'No phones connected';
  $('#desktopCode').textContent=s.code;$('#desktopCode').title=s.hint;$('#desktopPairHint').textContent=s.hint;$('#desktopNewCode').disabled=!s.online;
  $('#desktopError').hidden=!s.error;$('#desktopError').textContent=s.error||'';
  $('#desktopPower').classList.toggle('powered',s.online);$('#desktopPower').setAttribute('aria-label',s.online?'Turn server off':'Turn server on');$('#desktopPower').setAttribute('aria-pressed',s.online);
  const select=$('#desktopAddress'),items=JSON.stringify(s.addresses);
  if(select.dataset.items!==items){select.innerHTML=s.addresses.map(a=>'<option>'+esc(a)+'</option>').join('');select.dataset.items=items;select.value=s.address;}
  if(!s.online){wanted=false;if(connected){connection(false);updateBridgeActivity();notice();}}
  else if(!wanted){wanted=true;nextProbe=0;heartbeat();}
 };
 const command=async(op,args={})=>{
  if(busy)return;busy=true;++revision;$('#desktopError').hidden=true;
  $('#desktopPower').disabled=true;
  if(op==='power'){$('#desktopPower').innerHTML='<i class="spinner"></i>';$('#desktopServerState').textContent=args.on?'Starting server…':'Stopping server…';}
  try{const s=await desktopCall(op,args);if(s&&typeof s==='object')paint(s);}
  catch(e){$('#desktopError').hidden=false;$('#desktopError').textContent=e.message;}
  finally{busy=false;$('#desktopPower').disabled=false;$('#desktopPower').innerHTML=powerIcon;}
 };
 $('#desktopPower').onclick=()=>command('power',{on:!status?.online});
 $('#desktopCivitai').onclick=()=>desktopCall('civitaiKey');
 $('#desktopNewCode').onclick=()=>command('code');$('#desktopEdit').onclick=()=>command('address');
 $('#desktopCopy').onclick=()=>command('copy',{address:$('#desktopAddress').value});
 await command('status');setInterval(async()=>{
  if(busy||refreshing||document.hidden)return;refreshing=true;const stamp=revision;
  try{const s=await desktopCall('status');if(stamp===revision)paint(s);}catch{/* A user command reports failures in the panel. */}
  finally{refreshing=false;}
 },2000);
 updateBridgeActivity();
}

function initDesktopSidebar(){
 const panel=$('#drawer'),workspace=$('#workspace'),shade=$('#shade');
 const narrow=matchMedia('(max-width:880px)');
 const toggle=document.createElement('button');toggle.id='desktopPanelToggle';toggle.type='button';
 toggle.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M8 3v14"/></svg>';
 toggle.setAttribute('aria-controls','desktopBridge');panel.prepend(toggle);panel.inert=false;
 for(const item of panel.querySelectorAll('[data-nav]'))item.title=item.lastChild.textContent.trim();
 function setOpen(open){
  // The shared feed pauses behind an open overlay. A persistent desktop rail is not an overlay.
  panel.classList.toggle('open',open);shade.hidden=!open;workspace.inert=open;
  toggle.setAttribute('aria-expanded',String(open));
  toggle.title=open?'Hide bridge panel':'Show bridge panel';toggle.setAttribute('aria-label',toggle.title);
 }
 setOpen(false);toggle.onclick=()=>setOpen(!panel.classList.contains('open'));
 shade.onclick=()=>{setOpen(false);toggle.focus();};
 panel.querySelector('nav').addEventListener('click',e=>{if(e.target.closest('[data-nav]'))setOpen(false);});
 narrow.addEventListener('change',()=>setOpen(false));
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&panel.classList.contains('open')&&!document.querySelector('dialog[open],.civitaiViewer')){
   e.preventDefault();e.stopImmediatePropagation();setOpen(false);toggle.focus();
  }
 },true);
}

function initDesktopCarousel(){
 const main=$('#main');let drag=null,swallowClick=null;
 main.addEventListener('dragstart',e=>{if(e.target.closest('.browseCarousel'))e.preventDefault();});
 main.addEventListener('pointerdown',e=>{
  drag=null;swallowClick=null;
  const strip=e.target.closest('.browseCarousel');
  if(e.pointerType!=='mouse'||e.button!==0||!strip||strip.scrollWidth<=strip.clientWidth)return;
  drag={strip,id:e.pointerId,x:e.clientX,y:e.clientY,left:strip.scrollLeft,active:false};
 });
 main.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  if(!(e.buttons&1)){drag=null;return;}
  const dx=e.clientX-drag.x;
  if(!drag.active){
   if(Math.abs(e.clientY-drag.y)>8&&Math.abs(e.clientY-drag.y)>Math.abs(dx)){drag=null;return;}
   if(Math.abs(dx)<7)return;
   drag.strip.setPointerCapture(e.pointerId);drag.active=true;swallowClick=drag.strip;
   drag.strip.classList.add('desktopDragging');
  }
  drag.strip.scrollLeft=drag.left-dx;e.preventDefault();
 });
 const finish=()=>{drag?.strip.classList.remove('desktopDragging');drag=null;};
 main.addEventListener('pointerup',finish);main.addEventListener('pointercancel',finish);
 main.addEventListener('lostpointercapture',finish);
 main.addEventListener('click',e=>{
  if(e.detail&&swallowClick?.contains(e.target)){e.preventDefault();e.stopPropagation();}
  swallowClick=null;
 },true);
}

// The desktop pane hosts the same media, metadata and actions as the phone viewer.
function desktopMediaPane(view, closeView){
 const pane=view.el,shade=document.createElement('button');
 shade.type='button';shade.className='desktopMediaShade';shade.setAttribute('aria-label','Close media details');
 pane.before(shade);
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 let animation=null,drag=null,closing=false;
 const slide=(from,to,done)=>{
  animation?.cancel();
  if(reduced){done?.();return;}
  animation=pane.animate([{transform:'translateX('+from+')'},{transform:'translateX('+to+')'}],
   {duration:170,easing:'cubic-bezier(.2,.7,.3,1)',fill:'both'});
  animation.onfinish=()=>{animation?.cancel();animation=null;done?.();};
 };
 const dismiss=()=>{
  if(closing)return;closing=true;
  slide(pane.style.transform?'var(--pane-offset)':'0','100%',()=>closeView());
 };
 shade.onclick=dismiss;pane.querySelector('.civitaiClose').onclick=dismiss;
 pane.addEventListener('pointerdown',e=>{
  if(!e.isPrimary||e.button!==0||e.target.closest('button,input,textarea,select,a,.videoTimeline,.promptText')||!getSelection().isCollapsed)return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,active:false};
 });
 pane.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(!drag.active){
   if(Math.abs(dy)>8&&Math.abs(dy)>=dx||!getSelection().isCollapsed){drag=null;return;}
   if(dx<10)return;
   drag.active=true;animation?.cancel();pane.setPointerCapture(e.pointerId);
  }
  pane.style.setProperty('--pane-offset',Math.max(0,dx)+'px');pane.style.transform='translateX(var(--pane-offset))';
  e.preventDefault();
 });
 const finish=e=>{
  if(!drag||drag.id!==e.pointerId)return;
  const active=drag.active;drag=null;if(!active)return;
  if(e.type==='pointerup'&&parseFloat(pane.style.getPropertyValue('--pane-offset'))>Math.min(112,pane.clientWidth*.22)){dismiss();return;}
  const from=pane.style.getPropertyValue('--pane-offset');pane.style.transform='';slide(from,'0');
 };
 pane.addEventListener('pointerup',finish);pane.addEventListener('pointercancel',finish);
 shade.onwheel=e=>e.preventDefault();
 slide('100%','0');
 return ()=>{animation?.cancel();shade.remove();};
}
