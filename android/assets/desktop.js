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
  enableAlerts:()=>toast('Keep the desktop studio open to follow generation progress.')
 };
 document.documentElement.classList.add('desktop');
}
async function initDesktop(){
 if(!window.Desktop)return;
 const powerIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10M6.4 5.5a9 9 0 1 0 11.2 0"/></svg>';
 page=localStorage.getItem('desktopPage')||'image';if(!['image','video','library','notepad'].includes(page))page='image';
 const title=document.createElement('div');title.id='desktopTitle';
 title.innerHTML='<strong>ComfyBridge <small>DESKTOP STUDIO</small></strong><div><button data-window="collapse" title="Collapse to tray panel" aria-label="Collapse to tray panel">↘</button><button data-window="hide" title="Hide to tray" aria-label="Hide to tray">–</button><button data-window="quit" title="Quit ComfyBridge" aria-label="Quit ComfyBridge">×</button></div>';
 document.body.prepend(title);
 title.onpointerdown=e=>{if(e.button===0&&!e.target.closest('button'))desktopCall('drag');};
 title.querySelectorAll('[data-window]').forEach(b=>b.onclick=async()=>{if(profileDirty)await flushProfile();desktopCall(b.dataset.window);});
 const left=document.createElement('aside');left.id='desktopBridge';
 left.innerHTML='<div class="desktopServer"><div class="row spread"><div><strong id="desktopServerState">Checking server…</strong><small id="desktopPhones"></small></div><button id="desktopPower" aria-label="Toggle server power">⏻</button></div><label for="desktopAddress">PC address · enter on your phone</label><div class="row"><select id="desktopAddress"></select><button id="desktopCopy" title="Copy address">Copy</button><button id="desktopEdit" title="Edit remote address">✎</button></div><div class="row spread desktopPairRow"><label>Pairing code</label><strong id="desktopCode">—</strong><button id="desktopNewCode">New code</button></div><small id="desktopPairHint"></small><div id="desktopError" role="alert" hidden></div></div><div class="sectionline"><h2>Machine pulse</h2><span class="pill" id="liveLabel">LOCAL</span></div><div class="telemetry">'+['CPU','GPU','RAM','VRAM','SYSTEM COMMIT'].map((m,i)=>'<div class="metric" '+(i===4?'style="grid-column:1/-1"':'')+'><label>'+m+'</label><strong id="m'+i+'">—</strong><small id="ms'+i+'">Waiting for bridge</small><div class="meter"><i id="mb'+i+'"></i></div></div>').join('')+'</div><section id="bridgeActivity" aria-label="Generation progress"><div class="row spread"><strong>Generation</strong></div><div id="bridgeCommands"></div><div class="progress" role="progressbar" aria-label="Current generation" aria-valuemin="0" aria-valuemax="100"><i></i><span></span></div><div class="bridgeStage"><span id="bridgeStage"></span><span id="activeTimer"></span></div></section><div id="queueList"></div>';
 title.after(left);
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
 $('#drawer').inert=false;$('#drawer').classList.add('open');$('[data-nav=bridge]').remove();
 $('.drawerfoot small').textContent='Made on this PC. Shared with your phones.';
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
 $('#desktopNewCode').onclick=()=>command('code');$('#desktopEdit').onclick=()=>command('address');
 $('#desktopCopy').onclick=()=>command('copy',{address:$('#desktopAddress').value});
 await command('status');setInterval(async()=>{
  if(busy||refreshing||document.hidden)return;refreshing=true;const stamp=revision;
  try{const s=await desktopCall('status');if(stamp===revision)paint(s);}catch{/* A user command reports failures in the panel. */}
  finally{refreshing=false;}
 },2000);
 updateBridgeActivity();
}
