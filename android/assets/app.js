'use strict';
const $ = (s, root=document)=>root.querySelector(s), $$=(s,root=document)=>[...root.querySelectorAll(s)];
const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let db, state={settings:{},presets:{image:[],video:[]},prompts:[],inputs:{image:{},video:{}}}, page='browse', connected=false, connecting=false, catalog=null, library=[], jobs=[], active=null, previewAvailable=false, archived=false, pollBusy=false, presetName='', saveTimer;
const pending=new Map(); let rpcId=0;
window.bridgeResult=(id,ok,value)=>{const p=pending.get(id);if(!p)return;pending.delete(id);ok?p.resolve(value):p.reject(new Error(value));};
async function api(path,body){
 if(window.Native)return new Promise((resolve,reject)=>{let id=++rpcId;pending.set(id,{resolve,reject});Native.request(id,path,body===undefined?'GET':'POST',body===undefined?'':JSON.stringify(body));});
 const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error('HTTP '+r.status+': '+(d.error||r.statusText));return d;
}
const media=(id,thumb=false)=>{const j=library.find(x=>x.id===id);return j?.local?'/local/'+(thumb?'thumb/':'image/')+id+'/'+j.local:thumb&&connected?'/thumb/'+id:'';};
let syncing=false,filling=false,nextSync=0,inventory='',shelfError='';
function local(op,args={}){return new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});Native.localMedia(id,op,JSON.stringify(args));});}
const signature=items=>items.map(j=>j.id+':'+j.archived+':'+(j.rating||0)).sort().join(',');
function showShelf(){if(page==='library'){if(!viewerOpen())renderLibrary();else galleryDirty=true;}else if($('#result'))renderResults();}
function setShelf(items){library=items.filter(j=>j.source!=='missing'||j.local).sort((a,b)=>b.created-a.created||b.id.localeCompare(a.id));showShelf();refreshRatings();notice();}
function updateItem(j){setShelf(library.filter(x=>x.id!==j.id).concat(j));}
const originalTransfers=new Map();
function fetchOriginal(id,prefetch=false){
 const key=epoch+':'+id;
 if(!originalTransfers.has(key)){ModelPreviews.pause();originalTransfers.set(key,local(prefetch?'prefetch':'fetch',{id}).finally(()=>{originalTransfers.delete(key);ModelPreviews.wake();}));}
 return originalTransfers.get(key);
}
async function syncShelf(force=false){
 if(!connected||syncing||(!force&&Date.now()<nextSync))return;
 const session=epoch;syncing=true;ModelPreviews.pause();nextSync=Date.now()+300000;
 try{const index=await api('media-index');if(epoch!==session||!connected)return;
  if(index.items.some(j=>!('rating' in j))){const ratings=await api('studio/ratings');if(epoch!==session||!connected)return;index.items.forEach(j=>j.rating=ratings[j.id]||0);}
  const rows=await local('sync',index);if(epoch!==session)return;
  inventory=signature(index.items);shelfError='';setShelf(rows);ModelPreviews.synced();fillShelf();
 }catch(e){if(epoch===session){shelfError=(window.Desktop?'Could not read the PC library: ':'Could not check phone copies: ')+e.message+(e.message.includes('404')?' Update the Windows bridge to beta 4.':'');nextSync=Date.now()+30000;showShelf();}}
 finally{syncing=false;ModelPreviews.wake();}
}
const prefetchRetry=new Map();let inventoryProbe=false,nextInventoryProbe=0,prefetchAfter=0;
function prefetchVisibility(){window.Native?.prefetchEnabled?.(connected&&!document.hidden);if(document.hidden||!connected)ModelPreviews.pause();else ModelPreviews.wake();}
document.addEventListener('visibilitychange',()=>{prefetchVisibility();if(!document.hidden){nextInventoryProbe=0;fillShelf();}});
async function checkNewMedia(){
 if(window.Desktop||!connected||document.hidden||inventoryProbe||Date.now()<nextInventoryProbe)return;
 inventoryProbe=true;nextInventoryProbe=Date.now()+2500;const session=epoch;
 try{const latest=await api('library');if(session!==epoch||!connected||document.hidden)return;
  if(signature(latest)!==inventory){if(!shelfError||Date.now()>=nextSync)await syncShelf(true);}else fillShelf();
 }catch{/* Connection status and regular inventory checks report persistent failures. */}
 finally{inventoryProbe=false;}
}
async function fillShelf(){
 if(window.Desktop||filling||!connected||document.hidden||Date.now()<prefetchAfter)return;
 prefetchVisibility();filling=true;const session=epoch;let firstError='';
 const eligible=new Set(library.slice(0,20).map(j=>j.id));for(const id of prefetchRetry.keys())if(!eligible.has(id))prefetchRetry.delete(id);
 try{while(connected&&epoch===session&&!document.hidden){
  // Re-evaluate after every file, so a just-finished generation jumps to the front.
  const j=library.slice(0,20).find(j=>!j.local&&j.source==='available'&&(prefetchRetry.get(j.id)||0)<=Date.now());
  if(!j)break;
  try{const saved=await fetchOriginal(j.id,true);if(epoch!==session)break;prefetchRetry.delete(j.id);updateItem(saved);}
  catch(e){if(document.hidden||epoch!==session||/paused/i.test(e.message))break;prefetchRetry.set(j.id,Date.now()+30000);
   firstError=e.message;if(/storage|space/i.test(firstError)){prefetchAfter=Date.now()+30000;break;}
  }
 }}finally{filling=false;ModelPreviews.wake();if(firstError&&epoch===session){shelfError='Recent downloads pending: '+firstError;nextSync=Math.min(nextSync,Date.now()+30000);showShelf();}}
}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),3800);}
function persist(section=page){markEdited(section);scheduleBackup();clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(db){let t=db.transaction('data','readwrite');t.objectStore('data').put(state,'state');t.onerror=()=>toast(window.Desktop?'PC storage is full; settings could not be saved.':'Phone storage is full; settings could not be saved.');}},120);}
async function init(){
 db=await new Promise((resolve,reject)=>{let r=indexedDB.open('comfybridge',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const saved=await new Promise(resolve=>{let r=db.transaction('data').objectStore('data').get('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});freshPhone=!saved;if(saved)state=saved;
 $('#hamburger').onclick=()=>drawer(true);$('#shade').onclick=()=>drawer(false);$$('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
 $('#presetButton').onclick=()=>{let m=$('#presetMenu');if(m.hidden){renderPresets();m.hidden=false;}else m.hidden=true;};
 $('#modalClose').onclick=closeModal;$('#modal').addEventListener('cancel',()=>{if(maskSession)maskSession=null;});
 document.addEventListener('click',e=>{
  if(!e.target.closest('#presetButton,#presetMenu'))$('#presetMenu').hidden=true;
  if(!e.target.closest('#batchButton,#batchMenu'))setBatchMenu(false);
 });
 document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||$('#batchMenu')?.hidden!==false||$('#modal').open)return;
  setBatchMenu(false);$('#batchButton').focus();
 });
 if(window.Native&&JSON.parse(Native.configuration()).paired){try{setShelf(await local('list'));}catch(e){shelfError=e.message;}}
 const version=window.Desktop?info().version:window.Native?.appVersion?.();
 if(version){
  const label=$('#appVersion'),beta=version.match(/-beta\.(\d+)$/i);
  label.textContent=beta?'Beta '+beta[1]:'v'+version;label.title=version;label.hidden=false;
 }
 await loadNotes();await loadChat();await initDesktop();if(!window.Desktop)initBridgeDrawer();render();
 if(!window.Desktop)drawer(true);
 setInterval(heartbeat,2500);document.addEventListener('visibilitychange',()=>{if(!document.hidden){nextProbe=0;nextSync=0;nextSettings=0;heartbeat();if(page==='notepad')syncNotes();}else if(profileDirty)flushProfile();});
 window.openJobAlert=async()=>{const route=window.Native?.notificationRoute();if(!route)return;
  if(!connected&&info().paired&&!connecting&&!wanted){navigate('bridge');await $('#connect').onclick();}
  if(route==='library'){navigate('library');return;}
  if(connected){try{const status=await api('status'),j=status.jobs.find(x=>x.owner===info().device&&['running','pending','submitting','cancelling'].includes(x.status));navigate(j?.kind||'library');}catch(e){toast(e.message);}}
 };window.openJobAlert();
}
function drawer(open){
 const panel=$('#drawer');
 if(window.Desktop){panel.inert=false;return;}
 panel.inert=!open;panel.classList.toggle('open',open);$('#shade').hidden=!open;
 $('#hamburger').setAttribute('aria-expanded',String(open));
 if(open&&connected)poll();
 else if(!showsQueue())stopFrames();
}
function navigate(to){
 if(to==='bridge'){if(window.Desktop)$('#desktopPower').focus();else drawer(true);return;}
 if(window.Desktop)localStorage.setItem('desktopPage',to);
 if(page!==to){if(['image','video'].includes(to))promptExpanded={};leaveLivePreview();}
 if(viewerOpen())closeViewer(true);
 page=to;archived=false;presetName='';drawer(false);render();$('#workspace').scrollTop=0;
 if(connected){poll();if(['image','video'].includes(to))syncSettings();if(to==='notepad')syncNotes();}
}
function paintConnectionStatus(){
 const status=$('#drawerStatus'),working=connecting||wanted;
 status.textContent=connected?(window.Desktop?'Local studio':'PC connected'):connecting?'Connecting…':wanted?'Reconnecting…':'Disconnected';
 status.parentElement.dataset.state=connected?'online':working?'connecting':'offline';
}
function connection(value){connected=value;ModelPreviews.connected(value);prefetchVisibility();paintChatStatus();$$('.dot').forEach(d=>d.classList.toggle('connected',value));$('#statusDot').setAttribute('aria-label',value?'Connected':'Disconnected');paintConnectionStatus();}
function dashboardVisible(){return window.Desktop||$('#drawer').classList.contains('open');}
function render(){
 document.body.dataset.page=page;
 $('#pageTitle').textContent=page[0].toUpperCase()+page.slice(1);$('#presetButton').hidden=!['image','video'].includes(page);$('#presetButton').innerHTML=esc(presetName||'Current settings')+' <span>⌄</span>';
 $$('[data-nav]').forEach(b=>{
  const active=b.dataset.nav===page;b.classList.toggle('active',active);
  if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
 });
 if(page==='browse')$('#main').innerHTML='<p class="subhead">Coming soon.</p>';
 else if(page==='library'){if(!viewerOpen())renderLibrary();else galleryDirty=true;}
 else if(page==='notepad')renderNotepad();else renderGenerator();
 connection(connected);notice();
}
let editPair=false,pairAddress=null,bridgeError="";
let wanted=false,epoch=0,probing=false,nextProbe=0,misses=0,catalogLoading=false,retryCatalogAt=0,workerBuild='',serviceNote='',pollNote='';
function notice(){const el=$('#linkNotice'),n=library.filter(j=>['missing','changed'].includes(j.warning)).length;const review=n?n+' PC file(s) changed or disappeared. Open Library to review your protected phone copies.':'';el.textContent=[wanted&&!connected?(window.Desktop?'Reconnecting to the local bridge. ':'Reconnecting to your PC. ')+bridgeError+' Accepted jobs continue on the PC.':connected?(/after the previous worker goes idle/i.test(serviceNote+' '+pollNote)?'PC connected. The Windows bridge is updating; retrying automatically.':[serviceNote,pollNote].filter(Boolean).join(' ')):'',page==='library'?'':review].filter(Boolean).join(' ');el.hidden=!el.textContent;}
function clearSession(){leaveLivePreview();imagePreviewProtocol=false;
 queueProtocol=0;rollingSkip=false;rollingStopAll=false;queueEtaSeconds=null;jobs=[];active=null;queueHistory=[];historyFailure='';
 ++epoch;profileReady=false;clearTimeout(profileTimer);wanted=false;misses=0;nextProbe=0;catalogLoading=false;retryCatalogAt=0;workerBuild='';serviceNote=pollNote=bridgeError='';connection(false);notice();
}
async function loadCatalog(){
 if(catalogLoading||catalog||!connected)return;
 const id=epoch;catalogLoading=true;serviceNote='PC connected. Loading ComfyUI models…';notice();
 try{const data=await api('catalog');if(id!==epoch)return;
  Object.assign(data.defaults.video,{seconds:10,exactFrames:true,
   frames:Math.max(1,Math.round(data.defaults.video.fps*10))});
  for(const kind of ['image','video'])if(!state.settings[kind])state.settings[kind]=structuredClone(data.defaults[kind]);
  catalog=data;ModelPreviews.start(data);retryCatalogAt=0;persist(null);serviceNote='';if(page==='video')refreshVideoModelField();if(!$('#play')&&['image','video'].includes(page))render();
 }catch(e){if(id!==epoch)return;retryCatalogAt=Date.now()+8000;serviceNote='Model list unavailable: '+e.message;}
 finally{if(id===epoch){catalogLoading=false;renderBridge();notice();}}
}
function reached(){const cameBack=!connected;misses=0;nextProbe=0;bridgeError='';connection(true);
 if(cameBack)renderBridge();
 if(cameBack||!profileReady&&!profileLoad&&Date.now()>=retryProfiles)startProfiles(epoch).finally(()=>{if(connected&&!catalog)loadCatalog();});
 syncShelf(cameBack);checkNewMedia();notice();poll();
}
function unreachable(e){
 queueProtocol=0;
 bridgeError=e.message;
 if(/HTTP 40[13]|verify the PC.s identity/i.test(bridgeError)){
  const reason=bridgeError;clearSession();editPair=true;bridgeError=reason;renderBridge();if(!window.Desktop)drawer(true);else toast(reason);return;
 }
 connection(false);nextProbe=Date.now()+Math.min(20000,2500*2**Math.min(misses++,3));
 renderBridge();notice();
}
async function heartbeat(){
 if(connected&&!document.hidden){ModelPreviews.wake();ModelPreviews.refresh();if(!catalog&&!catalogLoading&&retryCatalogAt&&Date.now()>=retryCatalogAt)loadCatalog();if(Date.now()>=nextSettings)syncSettings();if(page==='notepad'&&Date.now()>=nextNoteSync)syncNotes();}
 if(!wanted||probing||connecting||document.hidden||Date.now()<nextProbe)return;const id=epoch;probing=true;
 try{await api('ping');if(id===epoch)reached();}catch(e){if(id===epoch)unreachable(e);}finally{probing=false;}
}
function machinePulse(label){
 return '<div class="sectionline"><h2>Machine pulse</h2><span class="pill" id="liveLabel">'+label+'</span></div><div class="telemetry">'+
  ['CPU','GPU','RAM','VRAM','SYSTEM COMMIT'].map((name,i)=>`<div class="metric" ${i===4?'style="grid-column:1/-1"':''}><label>${name}</label><strong id="m${i}">—</strong><small id="ms${i}">Waiting for bridge</small><div class="meter"><i id="mb${i}"></i></div></div>`).join('')+'</div>';
}
function initBridgeDrawer(){
 const panel=$('#drawerBridge');
 panel.innerHTML='<div id="pairFieldsHost"></div>'+machinePulse('OFFLINE')+bridgeActivityMarkup();
 profileControls();
 renderBridge();
}
function renderBridge(){
 if(window.Desktop)return;
 const cfg=window.Native?info():{host:'',paired:false};
 const enroll=!wanted&&!connected&&(!cfg.paired||editPair), host=pairAddress??cfg.host??'';
 const codeValue=$('#code')?.value||'';
 const retry=connected&&!catalog&&!catalogLoading&&!!serviceNote;
 const buttonText=connected?'Disconnect':wanted?'Cancel reconnect':enroll?'Pair & connect':'Connect to bridge';
 $('#drawerConnection').innerHTML=`<button class="green connectbutton" id="connect">${buttonText}</button>`;
 $('#pairFieldsHost').innerHTML=(enroll?`<div class="pairFields"><p>Use the address and pairing code shown in the Windows tray panel.</p><label for="host">PC address</label><input id="host" type="url" value="${esc(host)}" placeholder="Address shown in the PC panel" autocapitalize="off" spellcheck="false"><label for="code">Six-digit pairing code</label><input id="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="000000" value="${esc(codeValue)}"></div>`:
  `<p class="pairHost">${esc(cfg.host)}</p>`)+
  `<div id="pairError" role="alert" ${bridgeError?'':'hidden'}>${esc(bridgeError)}</div>`+
  (retry?'<button type="button" id="retryCatalog">Retry loading models</button>':'')+
  (!connected&&cfg.paired?`<button class="textbutton" id="changePair">${editPair?'Use saved pairing':'Pair again or change PC address'}</button>`:'');
 const button=$('#connect'),error=(msg,field)=>{
  bridgeError=msg;$('#pairError').hidden=false;$('#pairError').textContent=msg;
  if(field){field.setAttribute('aria-invalid','true');field.scrollIntoView({block:'nearest'});field.focus();}
 };
 if($('#host'))$('#host').oninput=()=>{pairAddress=$('#host').value;};
 if($('#retryCatalog'))$('#retryCatalog').onclick=loadCatalog;
 if($('#changePair'))$('#changePair').onclick=()=>{clearSession();editPair=!editPair;pairAddress=null;renderBridge();};
 if($('#bridgeOptions'))$('#bridgeOptions').hidden=!connected;
 paintConnectionStatus();
 $('#liveLabel').textContent=connected?'LIVE':'OFFLINE';
 if(!connected)showMetrics(null);
 button.disabled=connecting&&!connected;
 button.onclick=async()=>{
  if(connecting)return;
  if(connected||wanted){const wasConnected=connected;clearSession();renderBridge();if(wasConnected)api('disconnect').catch(()=>{});return;}
  let url,code;
  if(enroll){url=$('#host').value.trim();code=$('#code').value.trim();pairAddress=url;
   if(!url)return error('Enter the PC address shown in the Windows ComfyBridge panel.',$('#host'));
   if(!/^[0-9]{6}$/.test(code))return error('Enter the six-digit pairing code from the PC panel.',$('#code'));
  }
  connecting=true;paintConnectionStatus();bridgeError='';$('#pairError').hidden=true;button.disabled=true;button.textContent=enroll?'Pairing…':'Connecting…';
  const session=++epoch;catalog=null;
  try{
   if(enroll){await new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});Native.pair(id,url,code);});if(session!==epoch)return;editPair=false;pairAddress=null;}
   if(session!==epoch)return;wanted=true;await api('ping');if(session===epoch)reached();
  }catch(e){if(session===epoch){if(wanted)unreachable(e);else bridgeError='Pairing: '+e.message;}}
  finally{connecting=false;renderBridge();}
 };
 updateBridgeActivity();
}
function slider(key,label,min,max,step=1,disabled=false){let s=state.settings[page];return `<div class="field"><label>${label}</label><div class="controlrow"><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" ${disabled?'disabled':''}><input type="number" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" ${disabled?'disabled':''}></div></div>`;}
function renderGenerator(){
 const kind=page,s=state.settings[kind],inp=state.inputs[kind];
 if(!s){$('#main').innerHTML='<div class="empty"><div class="symbol">◉</div><h2>'+(connected?'Waiting for workflow settings':(window.Desktop?'Turn on your server':'Connect your studio first'))+'</h2><p>'+(connected?'The PC is connected. Check the sidebar for model loading status.':(window.Desktop?'Use the power button in the sidebar.':'Workflow defaults and your model library will load from the PC.'))+'</p><button class="green" id="goBridge">Open sidebar</button></div>';$('#goBridge').onclick=()=>navigate('bridge');return;}
 if(kind==='video'&&s.model===erosModel&&s.stepsBeforeCharacter!=null&&hasCharacterReference(s,inp)){
  // Beta 68 kept Eros in the editor but temporarily used the stock reference steps.
  s.steps=s.stepsBeforeCharacter;delete s.stepsBeforeCharacter;delete s.videoModelBeforeCharacter;
 }
 const maxSteps=s.replayOf?Math.max(stepLimit(kind),Number(s.steps)||1):stepLimit(kind);
 s.steps=limit(Math.round(Number(s.steps))||1,1,maxSteps);
 const ext=kind==='video'&&s.extension;
 const textVideo=kind==='video'&&!inp.data&&!ext;
 if(kind==='video'&&!ext&&!s.exactFrames)s.frames=5+17*Math.max(0,Math.ceil((s.frames-5)/17));
 if(textVideo)[s.width,s.height]=videoSize(s,0);
 if(!inp.data)s.denoise=1;
 $('#main').innerHTML=`<div class="gentoolbar">${generationControls(s.batch)}<div class="progressrow" id="progressRow" hidden><img class="preview" id="livePreview" alt="Generation preview"><div class="progress"><i id="progressFill"></i><span id="progressText"></span></div></div><div class="statusmessage" id="jobMessage"></div></div><div id="genError"></div>${window.Desktop?'':'<div id="generatorQueue"></div>'}<div class="row spread modeRow"><p class="eyebrow">${kind==='image'?'A STILL, A STORY':'VIDEO STUDIO'}</p><span class="pill" id="mode">${kind==='video'&&hasCharacterReference(s,inp)?(ext?'EXTEND WITH CHARACTER':'CHARACTER → VIDEO'):ext?(inp.finalFrame?.data||s.finalFrame?'EXTEND → FINAL FRAME':'EXTEND VIDEO'):textVideo?(inp.finalFrame?.data||s.finalFrame?'TEXT → FINAL FRAME':'TEXT → VIDEO'):kind==='video'?(inp.finalFrame?.data||s.finalFrame?'FIRST → FINAL FRAME':'IMAGE → VIDEO'):inp.mask?'INPAINT':inp.data?'IMAGE → IMAGE':'TEXT → IMAGE'}</span></div>${kind==='video'?videoFrameFields(s,inp)+characterReferenceField(s,inp):imageSourceField(inp)}<section class="card"><h2>Canvas & model</h2>${kind==='image'?canvasInputs(s):`${textVideo?canvasInputs(s,32)+'<div class="field scaleField"><label for="textVideoResolution">Resolution</label><div id="resolutionInfo"></div><input id="textVideoResolution" class="scaleRange" type="range" aria-label="Video resolution"><small>Red starts above 768 × 1152 pixels.</small></div>' :`<div class="field scaleField"><div class="row spread"><label for="videoScale">Scale from source</label><strong id="scaleValue"></strong></div><div id="resolutionInfo"></div><input id="videoScale" class="scaleRange" type="range" data-setting="scale" step="1"><div class="row spread"><small id="scaleBounds"></small><button type="button" id="originalScale" class="textbutton">Original · 0%</button></div></div>`}<div class="field"><div class="row spread"><label for="videoSeconds">${ext?'Time to add':'Video length'}</label><strong id="secondsValue"></strong></div><input id="videoSeconds" type="range" min="1" max="20" step="0.25"></div><div class="grid2 field"><div><label>${ext?'Frames to add':'Frames'}</label><input type="number" data-setting="frames" min="1" max="${ext?3570:3592}" value="${s.frames}"></div><div><label>FPS</label><input type="number" data-setting="fps" step="any" ${ext?'disabled':''} min="1" max="120" value="${s.fps}"></div></div><div id="durationInfo" aria-label="Video duration"></div><label class="togglelabel soundToggle"><input type="checkbox" id="videoSound" ${s.sound!==false?'checked':''}><span><strong>Include sound</strong><small>${ext?'Off saves a silent copy of the entire extension.':'Generate a soundtrack with the video.'}</small></span></label>`}<div class="field"><label>${kind==='video'?'Video model':'Checkpoint'}</label>${kind==='video'?`<div id="videoModelControls">${videoModelField(s)}</div>`:`<div class="checkpointPicker"><select data-setting="model">${[...new Set([s.model,...(catalog?.models||[])])].map(m=>`<option value="${esc(m)}" ${m===s.model?'selected':''}>${esc(modelLabel('checkpoints',m))}</option>`).join('')}</select><button type="button" id="checkpointBrowser">Checkpoint Browser</button></div>`}</div></section><section class="card"><div class="row spread"><h2>LoRAs</h2><button id="addLora" class="textbutton">＋ Add</button></div><div id="loras"></div></section>${promptField('positive','Positive prompt')}${promptField('negative','Negative prompt')}<section class="card"><h2>Generation settings</h2>${slider('steps','Steps',1,maxSteps)}${kind==='image'?slider('cfg','CFG',0,20,.1)+slider('denoise','Denoise'+(!inp.data?' · locked for text to image':''),0,1,.01,!inp.data):''}<div class="field"><label>Seed</label><input type="text" inputmode="numeric" data-setting="seed" value="${esc(s.seed)}"></div><div class="seedActions"><button id="randomSeed" type="button" class="seedRandom">Randomize</button><label class="togglelabel"><input type="checkbox" id="increment" ${s.increment?'checked':''}>Increment seed after each generation</label></div></section><section class="card" id="latestPanel"><div class="sectionline"><h2>Latest result</h2><button id="toLibrary" class="textbutton">Library ↗</button></div><div class="resultbox" id="result"></div><div class="carousel" id="carousel"></div></section>`;
 $('#upload').onchange=e=>loadStartingMedia(e.target);$('#clearUpload').onclick=()=>{state.inputs[kind]=kind==='video'?videoReferenceInputs(inp):{};delete s.extension;delete s.sourceMedia;delete s.sourceOrigin;delete s.replayOf;s.upload=null;s.mask=null;s.scale=0;if(kind==='video'&&s.textCanvas)Object.assign(s,s.textCanvas);if(kind==='image'){s.width=1024;s.height=1536;s.denoise=1;if(s.aspectLock)s.aspectLock=[s.width,s.height];}persist();renderGenerator();};
 if($('#maskButton'))$('#maskButton').onclick=openMask;if($('#clearMask'))$('#clearMask').onclick=()=>{delete inp.mask;delete s.mask;persist();renderGenerator();};
 if(kind==='video'){
  for(const [key,upload,clear] of videoReferenceFields){
   $(upload).onchange=e=>loadVideoReference(key,e.target.files[0]);
   $(clear).onclick=()=>clearVideoReference(key);
  }
 }
 if(kind==='video')$('#videoSound').onchange=e=>{s.sound=e.target.checked;persist(kind);};
 $('#increment').onchange=e=>{s.increment=e.target.checked;persist();};
 $$('[data-setting]').forEach(el=>el.oninput=()=>{let key=el.dataset.setting;s[key]=['model','seed'].includes(key)?el.value:Number(el.value);$$(`[data-setting="${key}"]`).forEach(other=>{if(other!==el)other.value=el.value;});if(kind==='video'&&['frames','fps'].includes(key))updateVideo(false);persist();});
 $('#batchButton').onclick=()=>setBatchMenu($('#batchMenu').hidden);$$('[data-batch]').forEach(el=>el.onclick=()=>{s.batch=+el.dataset.batch;$('#batchLabel').textContent=s.batch+' in batch';setBatchMenu(false);persist();generate();});
 $('#play').onclick=generate;$('#toLibrary').onclick=()=>navigate('library');$('#addLora').onclick=()=>openModelBrowser('loras');if($('#checkpointBrowser'))$('#checkpointBrowser').onclick=()=>openModelBrowser('checkpoints');
 if(kind==='video')bindVideoModelButtons();
 renderLoras();wirePrompts();bindSteps(s,maxSteps);
 if(kind==='image')bindCanvas(s);else if(textVideo)bindCanvas(s,32);else{bindVideoScale(s,inp);updateVideo(false);}
 if(kind==='video')bindVideoTime(s);
 $$('#main > section.card').forEach(panel=>installFold(panel,generatorPanelSummary));
 bindPromptSizing();
 renderResults();updateProgress();
}
const foldDimensions=value=>value?.width&&value?.height?value.width+' × '+value.height:'';
function foldMedia(label,thumbnail,detail){
 return '<div class="foldMedia">'+(thumbnail?'<img class="foldThumb" src="'+esc(thumbnail)+'" draggable="false" alt="">':'')+
  '<span>'+ (label?'<strong>'+esc(label)+'</strong>':'')+'<small>'+esc(detail)+'</small></span></div>';
}
function generatorPanelSummary(name){
 const s=state.settings[page],input=state.inputs[page];
 if(name==='Starting image'){
  if(!input.data&&!s.upload)return {hint:'No starting image'};
  return foldMedia('',input.data,input.data?[foldDimensions(input),input.mask?'Mask applied':''].filter(Boolean).join(' · '):'Saved on PC');
 }
 if(name==='First / last frame'){
  const ext=s.extension,first=ext||input;
  const last=input.finalFrame;
  if(!ext&&!input.data&&!s.upload&&!last?.data&&!s.finalFrame)return {hint:'No frames attached'};
  return '<div class="foldFrames">'+foldMedia(ext?'Source clip':'First frame',ext?media(ext.id,true):input.data,
   (ext||input.data?foldDimensions(first):'')||(s.upload?'Saved on PC':'No image'))+
   foldMedia('Last frame',last?.data,foldDimensions(last)||(s.finalFrame?'Saved on PC':last?.data?'Image attached':'No image'))+'</div>';
 }
 if(name==='Stable Character reference'){
  const reference=input.characterReference;
  if(!reference?.data&&!s.characterReference)return {hint:'No character image'};
  return foldMedia('',videoReferenceImage(reference),foldDimensions(reference)||(s.characterReference?'Saved on PC':'Image attached'));
 }
 if(name==='Canvas & model'){
  let model=s.model?modelLabel('checkpoints',s.model):'No model selected';
  if(page==='video'){
   if(hasCharacterReference(s,input)&&s.model!==erosModel)model='MiniMax H3 · Ref2VA';
   else model=catalog?.videoModels?.find(p=>p.model===s.model)?.label||(s.model===erosModel?'10Eros Max · Beta 7':model);
  }
  const timing=page==='video'&&s.fps>0?'<span> · '+esc(Number((videoFrameCount(s)/s.fps).toFixed(2)))+' s'+(s.extension?' to add':'')+' · '+esc(s.fps)+' FPS</span>':'';
  return '<strong>'+esc(foldDimensions(s))+'</strong>'+timing+'<div class="foldModel">'+esc(model)+'</div>';
 }
 if(name==='LoRAs'){
  if(page==='video'&&hasCharacterReference(s,input)&&s.model!==erosModel)return 'Stock Ref2VA uses its base weights.';
  return s.loras.map(l=>'<div class="foldLora'+(l.enabled===false?' inactive':'')+'"><span>'+esc(modelLabel('loras',l.name))+
   '</span><span>'+esc(l.strength)+'</span></div>').join('')||{hint:'No LoRAs'};
 }
 if(name==='Positive prompt'||name==='Negative prompt'){
  const prompt=s[name==='Positive prompt'?'positive':'negative']?.trimEnd();
  return prompt?'<p class="foldPrompt">'+esc(prompt)+'</p>':{hint:'No prompt'};
 }
 if(name==='Generation settings'){
  return esc([s.steps+' steps',...(page==='image'?['CFG '+s.cfg,'Denoise '+s.denoise]:[]),'Seed '+s.seed].join(' · '));
 }
 if(name==='Latest result')return latestResultSummary();
 return '';
}
function imageSourceField(input){
 return `<section class="card">
  <div class="row spread"><h2>Starting image</h2><small>Optional</small></div>
  <div class="upload">${input.data?'<img src="'+esc(input.data)+'" alt="Starting image">':
   '<div><strong>＋</strong><span>Choose an image</span><br><small>'+(window.Desktop?'Browse files on your PC':'Tap to browse your phone')+'</small></div>'}
   <input type="file" id="upload" accept="image/*" aria-label="Choose starting media">
  </div>
  <div class="uploadtools">
   ${input.data?'<div class="sourceDims"><strong>'+input.width+' × '+input.height+'</strong><small>Source · '+aspect(input.width,input.height)+'</small></div>':'<small>Leave empty for text to image</small>'}
   <div><button id="maskButton" ${input.data?'':'disabled'}>${input.mask?'Edit mask':'◌ Apply mask'}</button>
    <button id="clearUpload" class="danger" ${input.data?'':'disabled'}>Clear ×</button></div>
  </div>
  ${input.mask?'<button id="clearMask" class="textbutton danger">Reset mask</button>':''}
  ${input.data&&(input.width>1256||input.height>1256)?'<div class="warning">ⓘ Large source image · above 1256 × 1256.</div>':''}
 </section>`;
}
const ref2vaModel = 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors';
const videoReferenceFields = [
 ['finalFrame', '#uploadFinal', '#clearFinalFrame'],
 ['characterReference', '#uploadCharacter', '#clearCharacterReference']
];
function videoReferenceInputs(input){
 const {finalFrame,characterReference}=input||{};
 return {...(finalFrame&&{finalFrame}),...(characterReference&&{characterReference})};
}
function hasCharacterReference(settings,input=state.inputs.video){
 return !!(settings?.characterReference||input?.characterReference?.data);
}
function characterVideoProfile(model){
 return model===erosModel?catalog?.characterVideo?.eros:catalog?.characterVideo;
}
function videoFrameFields(settings,input){
 const ext=settings.extension;
 const first=ext?extensionSource(ext):input.data?'<img src="'+esc(input.data)+'" alt="First frame">':
  '<div><strong>＋</strong><span>Photo or video</span></div>';
 return '<section class="card videoFramesCard"><h2>First / last frame</h2><div class="videoFrameGrid">'+
  '<div class="videoFrame"><strong>'+(ext?'Source clip':'First frame')+'</strong><div class="upload videoFrameUpload">'+first+
  '<input type="file" id="upload" accept="image/*,video/*" aria-label="Choose first frame or source video"></div>'+
  '<div class="videoFrameTools">'+videoReferenceDimensions(input)+
  '<button type="button" id="clearUpload" class="danger" '+(!ext&&!input.data?'disabled':'')+'>Clear</button></div></div>'+
  '<div class="videoFrame finalFrameCard"><strong>Last frame</strong>'+
  videoReferencePicker({value:input.finalFrame,saved:settings.finalFrame,upload:'uploadFinal',clear:'clearFinalFrame',
   label:'Last frame',choose:'Choose image',compact:true})+'</div></div></section>';
}
function videoReferenceDimensions(value){
 return value?.width&&value?.height?'<div class="sourceDims"><strong>'+value.width+' × '+value.height+
  '</strong><small>'+aspect(value.width,value.height)+'</small></div>':'';
}
function videoReferenceImage(value){
 return value?.data||(value?.job?'/source/'+encodeURIComponent(value.job)+'/characterReference-thumb':'');
}
function videoReferencePicker({value,saved,upload,clear,label,choose,compact=false}){
 const picture=videoReferenceImage(value);
 const preview=picture?'<img src="'+esc(picture)+'" alt="'+esc(label)+'">':
  '<div><strong>＋</strong><span>'+(saved?'Saved on PC':choose)+'</span></div>';
 return '<div class="upload '+(compact?'videoFrameUpload':'characterReferenceUpload')+'">'+preview+
  '<input type="file" id="'+upload+'" accept="image/*" aria-label="Choose '+esc(label.toLowerCase())+'"></div>'+
  '<div class="videoFrameTools">'+videoReferenceDimensions(value)+
  '<button type="button" id="'+clear+'" class="danger" '+(!value?.data&&!saved?'disabled':'')+'>Clear</button></div>';
}
function characterReferenceField(settings,input){
 return '<section class="card characterReferenceCard"><h2>Stable Character reference</h2>'+
  videoReferencePicker({value:input.characterReference,saved:settings.characterReference,upload:'uploadCharacter',
   clear:'clearCharacterReference',label:'Character reference',choose:'Choose character image'})+
  '<small>Carries this image into each extension.</small></section>';
}
function beginCharacterReference(settings){
 if(settings.model===erosModel)return;
 settings.stepsBeforeCharacter=settings.steps;
 settings.steps=catalog?.characterVideo?.steps||20;
}
function dropCharacterReference(settings){
 delete state.inputs.video.characterReference;
 delete settings.characterReference;
 delete settings.characterReferenceOrigin;
 if(settings.model===ref2vaModel)settings.model=settings.videoModelBeforeCharacter||catalog?.defaults?.video?.model;
 if(settings.stepsBeforeCharacter!=null)settings.steps=settings.stepsBeforeCharacter;
 delete settings.stepsBeforeCharacter;
 delete settings.videoModelBeforeCharacter;
}
async function loadVideoReference(key,file){
 if(!file)return;
 const session=epoch,settings=state.settings.video;
 try{
  const image=await readStartingImage(file);
  await resolvePendingSubmission('video');
  if(page!=='video'||epoch!==session||settings!==state.settings.video)return;
  if(key==='characterReference'&&!hasCharacterReference(settings))beginCharacterReference(settings);
  state.inputs.video[key]=image;
  delete settings[key];delete settings[key+'Media'];delete settings[key+'Origin'];delete settings.replayOf;
  persist('video');renderGenerator();
 }catch(error){toast(error.message);}
}
async function clearVideoReference(key){
 const session=epoch,settings=state.settings.video;
 try{
  await resolvePendingSubmission('video');
  if(page!=='video'||epoch!==session||settings!==state.settings.video)return;
  if(key==='characterReference')dropCharacterReference(settings);
  else{delete state.inputs.video[key];delete settings[key];delete settings[key+'Media'];delete settings[key+'Origin'];}
  delete settings.replayOf;
  persist('video');renderGenerator();
 }catch(error){toast(error.message);}
}
function promptField(key,label){return `<section class="card"><div class="promptlabel"><label>${label}</label><button data-expand="${key}" class="textbutton" aria-label="Expand ${label}">⛶</button></div><div class="prompttools"><select data-prompt-library="${key}"><option value="">Saved prompts…</option>${state.prompts.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select><button data-save-prompt="${key}" aria-label="Save prompt">＋</button><button data-delete-prompt="${key}" class="danger" aria-label="Delete selected prompt">×</button></div><textarea class="promptEntry" rows="5" data-setting="${key}" placeholder="${key==='negative'?'What should the model avoid?':'Describe your idea…'}">${esc(state.settings[page][key]??'')}</textarea><div class="promptActions"><span class="quickActions" data-quick-actions="${key}"></span><button type="button" class="textbutton promptChat" data-chat-prompt="${key}">Chat about this ↗</button><button type="button" class="textbutton promptHeight" data-prompt-height="${key}" aria-expanded="false" aria-label="Show all ${label}">⌄</button></div><div class="quickPanel" data-quick-panel="${key}"></div>${page==='video'&&key==='negative'?'<small>Optional. Adding text uses extra sampling time. Leave blank for the standard H3 workflow.</small>':''}</section>`;}
function wirePrompts(){
 bindQuickEdits();
 $$('[data-chat-prompt]').forEach(b=>b.onclick=()=>chatAboutPrompt(b.dataset.chatPrompt));
 $$('textarea[data-setting]').forEach(el=>el.oninput=()=>{state.settings[page][el.dataset.setting]=el.value;persist();});
 $$('[data-expand]').forEach(b=>b.onclick=()=>openPrompt(b.dataset.expand));
 $$('[data-save-prompt]').forEach(b=>b.onclick=async()=>{let name=await askName('Save prompt');if(!name)return;state.prompts.push({name,text:state.settings[page][b.dataset.savePrompt]});persist('prompts');renderGenerator();});
 $$('[data-prompt-library]').forEach(el=>el.onchange=()=>{if(el.value==='')return;let key=el.dataset.promptLibrary;state.settings[page][key]=state.prompts[+el.value].text;$(`textarea[data-setting="${key}"]`).value=state.settings[page][key];sizePrompt($(`textarea[data-setting="${key}"]`),true);persist();});
 $$('[data-delete-prompt]').forEach(b=>b.onclick=()=>{let sel=$(`[data-prompt-library="${b.dataset.deletePrompt}"]`);if(sel.value==='')return toast('Choose a saved prompt first.');state.prompts.splice(+sel.value,1);persist('prompts');renderGenerator();});
}
const erosModel='10Eros_Max_h3_8stepTURBO_beta7_int8HQ.safetensors';
function openPrompt(key){
 const kind=page,settings=state.settings[kind];
 openModal(key==='positive'?'Positive prompt':'Negative prompt','<textarea id="fullPrompt"></textarea>','<button class="green" id="applyPrompt">Done</button>');
 const back=$('#modalClose'),editor=$('#fullPrompt');
 back.setAttribute('aria-label','Back to generator');
 editor.value=settings[key]||'';
 editor.oninput=()=>{settings[key]=editor.value;persist(kind);};
 $('#applyPrompt').onclick=closeModal;
 $('#modal').addEventListener('close',()=>{if(page===kind)renderGenerator();},{once:true});
}
function videoModelField(s){
 if(hasCharacterReference(s)){
  const reference=catalog?.characterVideo;
  if(!reference)return '<small class="warning">Stable Character reference requires the updated Windows bridge.</small>';
  const eros=s.model===erosModel;
  const profiles=[reference.eros||{model:erosModel,label:'10Eros Max · Beta 7',missing:['updated Windows bridge']},
   {...reference,label:'MiniMax H3 · Ref2VA'}];
  const selected=eros?profiles[0]:profiles[1];
  const detail=selected.missing.length?'Needs on PC: '+selected.missing.join(', '):
   eros?'Character reference · built-in 8-step Turbo':'Character reference · stock Ref2VA';
  return '<div id="videoModel" role="group" aria-label="Video model">'+profiles.map(p=>
   '<button type="button" value="'+esc(p.model)+'" aria-pressed="'+(p===selected)+'" '+(p.missing.length?'aria-disabled="true"':'')+'>'+
   esc(p.label)+'</button>').join('')+'</div><small>'+esc(detail)+'</small>'+
   (eros?'<button type="button" id="videoModelListing" class="seeListing">See Listing</button>':'');
 }
 const profiles=catalog?.videoModels;
 if(!profiles)return '<input readonly aria-label="Video model" value="'+esc(s.model)+'">';
 const options=profiles.map(p=>'<button type="button" value="'+esc(p.model)+'" aria-pressed="'+(p.model===s.model)+'" '+
  (p.missing.length?'aria-disabled="true"':'')+'>'+
  esc(p.label)+(p.missing.length?' · unavailable':'')+'</button>').join('');
 const profile=profiles.find(p=>p.model===s.model);
 const detail=profile?.missing.length?'Missing on PC: '+profile.missing.join(', '):
  profile?.builtinTurbo?'Built-in 8-step Turbo · H3 VAE + Qwen encoder':'4-step Turbo LoRA · H3 VAE + Qwen encoder';
 return '<div id="videoModel" role="group" aria-label="Video model">'+options+'</div><small>'+esc(detail)+'</small><button type="button" id="videoModelListing" class="seeListing">See Listing</button>';
}
function bindVideoModelButtons(){
 $$('#videoModel button').forEach(button=>{button.onclick=()=>switchVideoModel(button.value);});if($('#videoModelListing'))$('#videoModelListing').onclick=()=>openModelBrowser('video',state.settings.video.model);
}
function refreshVideoModelField(){
 const host=$('#videoModelControls');if(!host)return;
 host.innerHTML=videoModelField(state.settings.video);bindVideoModelButtons();
 host.closest('section')?.refreshFoldSummary?.();
}
async function switchVideoModel(model){
 const s=state.settings.video,session=epoch,original=s.model;
 try{await resolvePendingSubmission('video');}catch(e){toast(e.message);return;}
 if(page!=='video'||epoch!==session||s!==state.settings.video||original!==s.model)return;
 if(hasCharacterReference(s)){
  const profile=characterVideoProfile(model);
  if(!profile||profile.missing.length){toast('Needs on PC: '+(profile?.missing.join(', ')||'updated Windows bridge'));return;}
  if((original===erosModel)===(model===erosModel))return;
  if(model===ref2vaModel){
   s.videoModelBeforeCharacter=original;
   s.stepsBeforeCharacter=s.steps;
  }
  s.steps=model===erosModel&&s.videoModelBeforeCharacter===erosModel
   ?s.stepsBeforeCharacter??profile.steps:profile.steps;
  s.model=model;delete s.replayOf;
  if(model===erosModel){delete s.stepsBeforeCharacter;delete s.videoModelBeforeCharacter;}
  persist('video');renderGenerator();return;
 }
 let profile=catalog?.videoModels?.find(p=>p.model===model);
 if(!profile)return;
 if(profile.missing.length&&connected){
  try{
   const latest=await api('catalog');
   if(page!=='video'||epoch!==session||s!==state.settings.video||original!==s.model)return;
   catalog=latest;refreshVideoModelField();
   profile=catalog.videoModels.find(p=>p.model===model);
  }catch(e){toast(e.message);return;}
 }
 if(!profile||profile.missing.length){toast('Missing on PC: '+(profile?.missing.join(', ')||model));return;}
 if(original===model)return;
 s.model=model;s.steps=profile.steps;delete s.replayOf;
 const fixed=catalog.defaults.video.loras[0];
 s.loras=s.loras.filter(l=>l.name!==fixed.name);
 if(!profile.builtinTurbo)s.loras.unshift({...fixed});
 persist('video');renderGenerator();
}
function renderLoras(){
 if(page==='video'&&hasCharacterReference(state.settings.video)&&state.settings.video.model!==erosModel){
  $('#loras').innerHTML='<small>Stock Ref2VA uses its base weights.</small>';
  $('#addLora').disabled=true;
  return;
 }
 $('#addLora').disabled=false;
 const list=state.settings[page].loras;
 if(page==='video'&&state.settings.video.model===erosModel){
  const stock=catalog?.defaults?.video?.loras?.[0]?.name;
  for(let i=list.length-1;i>=0;i--){
   if(list[i].name===stock)list.splice(i,1);else delete list[i].locked;
  }
 }
 if(page==='video'&&state.settings.video.model!==erosModel){
  const fixed=catalog?.defaults?.video?.loras?.[0];
  if(fixed&&list[0]?.name!==fixed.name)list.unshift({...fixed,locked:true,enabled:true});
  else if(list[0]){
   const strength=state.settings.video.replayOf?list[0].strength:(fixed?.strength??1);
   Object.assign(list[0],fixed,{locked:true,enabled:true,strength});
  }
 }
 $('#loras').innerHTML=list.length?list.map((l,i)=>`<div class="lora" data-lora="${i}" role="group" aria-label="${esc(modelLabel('loras',l.name))}">
 <div class="row loraHeader"><input type="checkbox" data-enable="${i}" ${l.enabled?'checked':''} ${l.locked?'disabled':''} aria-label="Enable LoRA">${l.locked?`<span class="lockedname">▣ ${esc(modelLabel('loras',l.name))}</span>`:`<select data-lora-name="${i}">${[...new Set([l.name,...(catalog?.loras||[])])].map(n=>`<option value="${esc(n)}" ${n===l.name?'selected':''} ${list.some((x,j)=>j!==i&&modelKey(x.name)===modelKey(n))?'disabled':''}>${esc(modelLabel('loras',n))}</option>`).join('')}</select>`}<button type="button" data-see-lora="${i}" class="seeListing">See Listing</button></div>
 <div class="loraSlider"><div class="loraMarks" aria-hidden="true">${[-1,0,1].map(n=>`<span style="left:${(n+2)/4*100}%">${n===-1?'−1':n}</span>`).join('')}</div><input type="range" data-strength="${i}" ${l.locked?'disabled':''} min="-2" max="2" step=".1" value="${esc(l.strength)}" aria-label="LoRA strength" title="Drag the handle to adjust strength"></div>
 <div class="loraNumber"><input type="number" data-strength="${i}" ${l.locked?'disabled':''} min="-20" max="20" step="any" value="${esc(l.strength)}" aria-label="LoRA strength" title="Precise strength; may exceed the slider range"></div>
 <div class="loraActions"><button type="button" data-remove-lora="${i}" class="loraRemove danger" ${l.locked?'disabled':''} aria-label="Remove LoRA"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button><div class="loraReorder" role="group" aria-label="Reorder LoRA"><button type="button" data-move-lora="${i}" data-direction="-1" ${l.locked||i===0||list[i-1]?.locked?'disabled':''} aria-label="Move LoRA up"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5"/></svg></button><button type="button" class="loraGrip" data-drag-lora="${i}" ${l.locked?'disabled':''} aria-label="Drag to reorder LoRA" title="Drag to reorder"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12"/></svg></button><button type="button" data-move-lora="${i}" data-direction="1" ${l.locked||i===list.length-1||list[i+1]?.locked?'disabled':''} aria-label="Move LoRA down"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button></div></div>
 ${l.locked?'<small class="loraNote">Required turbo LoRA · fixed strength</small>':''}</div>`).join(''):page==='video'&&state.settings.video.model===erosModel?'<small>Eros Turbo is built in. Add optional LoRAs here.</small>':'<small>No LoRAs added.</small>';
 $$('[data-see-lora]').forEach(b=>b.onclick=()=>openModelBrowser('loras',list[+b.dataset.seeLora].name));
 $$('[data-enable]').forEach(e=>e.onchange=()=>{list[+e.dataset.enable].enabled=e.checked;persist();});$$('[data-lora-name]').forEach(e=>e.onchange=()=>{list[+e.dataset.loraName].name=e.value;persist();});
 $$('[data-remove-lora]').forEach(button=>button.onclick=()=>{const i=+button.dataset.removeLora;if(list[i].locked)return;list.splice(i,1);persist();renderLoras();});
 $$('[data-move-lora]').forEach(button=>button.onclick=()=>{
  const from=+button.dataset.moveLora,to=from+Number(button.dataset.direction);
  if(!list[to]||list[from].locked||list[to].locked)return;
  [list[from],list[to]]=[list[to],list[from]];persist();renderLoras();
  $('#loras [data-move-lora="'+to+'"][data-direction="'+button.dataset.direction+'"]').focus({preventScroll:true});
 });
 bindLoraReorder(list);
 $$('[data-strength]').forEach(el=>{
  const i=Number(el.dataset.strength);
  el.oninput=()=>{
   if(list[i].locked||!Number.isFinite(el.valueAsNumber))return;
   const value=el.type==='range'?limit(Math.round(el.valueAsNumber*10)/10,-2,2):limit(el.valueAsNumber,-20,20);
   list[i].strength=value;delete list[i].clipStrength;
   $$('[data-strength="'+i+'"]').forEach(peer=>{if(peer!==el)peer.value=value;if(peer.type==='range')peer.setAttribute('aria-valuetext',String(value));});persist();
  };
  if(el.type==='range'){el.setAttribute('aria-valuetext',String(list[i].strength));bindLoraTouch(el);}
  if(el.type==='number')el.onblur=()=>{el.value=list[i].strength;};
 });
}
async function loadStartingMedia(field){
 const file=field.files[0];
 if(!file)return;
 const video=file.type.startsWith('video/')||(!file.type&&window.Native?.pickedVideo?.());
 if(page!=='video'||!video)return loadImage(file);
 if(!connected||queueProtocol<11){toast('Connect to Windows beta 20 to import a video.');field.value='';return;}
 try{await resolvePendingSubmission('video');}catch(e){toast(e.message);field.value='';return;}
 const session=epoch;
 const play=$('#play'),batch=$('#batchButton');
 field.disabled=play.disabled=batch.disabled=true;
 const status=document.createElement('p');
 status.setAttribute('role','status');status.textContent='Uploading and preparing the source video…';
 field.closest('.upload').after(status);
 try{
  const source=window.Desktop?await (async()=>{const r=await fetch('/api/upload-video',{method:'POST',body:file});const value=await r.json();if(!r.ok)throw Error(value.error||'Video import failed');return value;})():await new Promise((resolve,reject)=>{
   const id=++rpcId;pending.set(id,{resolve,reject});Native.importVideo(id,file.size);
  });
  if(field.isConnected&&session===epoch)activateExtension(source);
 }catch(e){if(field.isConnected)toast(e.message);}
 finally{status.remove();field.value='';field.disabled=play.disabled=batch.disabled=false;}
}
async function loadImage(file){
 if(!file)return;const kind=page;
 try{
  const input=await readStartingImage(file);
  if(page!==kind)return;
  setStartingImage(kind,input);
  renderGenerator();
 }catch(e){toast(e.message);}
}
async function readStartingImage(blob){
 const data=await new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(reader.result);
  reader.onerror=()=>reject(reader.error);
  reader.readAsDataURL(blob);
 });
 const img=await loadImg(data);
 const width=img.naturalWidth,height=img.naturalHeight;
 if(width*height>40000000)throw new Error('Please choose an image under 40 megapixels.');
 return {data,width,height};
}
function setStartingImage(kind,input){
 const s=state.settings[kind];
 if(kind==='video')rememberTextCanvas(s);
 state.inputs[kind]=kind==='video'?{...input,...videoReferenceInputs(state.inputs.video)}:input;delete s.extension;delete s.sourceMedia;delete s.sourceOrigin;delete s.replayOf;
 s.upload=null;s.mask=null;s.scale=0;
 s.width=input.width;s.height=input.height;
 if(kind==='video')[s.width,s.height]=videoSize(input,0);
 else{
  s.denoise=.75;
  if(s.aspectLock)s.aspectLock=[s.width,s.height];
 }
 persist(kind);
}
function loadImg(data){return new Promise((resolve,reject)=>{let i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('That image could not be opened.'));i.src=data;});}
function rememberTextCanvas(s){
 if(!s.extension&&!state.inputs.video.data)s.textCanvas={width:s.width,height:s.height,aspectLock:s.aspectLock?.slice()||null};
}
function extensionSource(ext){
 const poster=media(ext.id,true);
 return '<div id="extensionSource">'+(poster?'<img alt="Source video" src="'+esc(poster)+'">':'')+
  '<b>Extend this clip</b><small>'+duration(ext.frames/ext.fps)+' · '+ext.width+' × '+ext.height+' · '+ext.fps+' FPS</small></div>';
}
function bindVideoTime(s){
 const slider=$('#videoSeconds'),frames=$('[data-setting="frames"]'),fps=$('[data-setting="fps"]');
 function bySeconds(seconds){
  const wanted=Math.round(seconds*s.fps);
  s.frames=limit(wanted,1,s.extension?3570:3592);
  s.seconds=wanted===s.frames?seconds:s.frames/s.fps;s.exactFrames=true;
  frames.value=s.frames;updateVideo(false);persist();
 }
 slider.oninput=()=>bySeconds(slider.valueAsNumber);
 fps.oninput=()=>{
  const rate=fps.valueAsNumber;
  if(!Number.isFinite(rate)||rate<1||rate>120)return;
  const seconds=s.seconds??s.frames/s.fps;
  s.fps=rate;bySeconds(seconds);
 };
 fps.onblur=()=>{fps.value=s.fps;};
 frames.oninput=()=>{
  const count=frames.valueAsNumber;
  if(!Number.isInteger(count)||count<1||count>Number(frames.max))return;
  s.frames=count;s.exactFrames=true;s.seconds=count/s.fps;updateVideo(false);persist();
 };
 frames.onblur=()=>{frames.value=s.frames;};
}
function videoFrameCount(s){return s.extension||s.exactFrames?s.frames:5+17*Math.max(0,Math.ceil((s.frames-5)/17));}
function updateVideo(rescale){
 const s=state.settings.video,inp=state.inputs.video;
 if(rescale&&inp.data)[s.width,s.height]=videoSize(inp,s.scale);
 const high=s.width*s.height>pixelBudget,pct=(s.scale>0?'+':'')+s.scale+'%';
 if($('#videoScale')){
  $('#scaleValue').textContent=pct;
  $('#videoScale').setAttribute('aria-valuetext',pct+' · '+s.width+' by '+s.height);
 }
 $('#resolutionInfo').innerHTML='<strong>'+s.width+' × '+s.height+'</strong><small>'+aspect(s.width,s.height)+' · '+(s.width*s.height/1e6).toFixed(2)+' MP'+(high?' · Above pixel budget':'')+'</small>';
 $('#resolutionInfo').classList.toggle('overBudget',high);
 const seconds=s.seconds??s.frames/s.fps;
 $('#videoSeconds').value=seconds;
 $('#secondsValue').textContent=Number(seconds.toFixed(2))+' s'+(seconds<1||seconds>20?' · custom':'');
 const frames=videoFrameCount(s);
 const valid=s.frames>=(s.extension||s.exactFrames?1:5)&&s.fps>=1;
 $('#durationInfo').innerHTML='<small>Duration</small><strong>'+(valid?(frames/s.fps).toFixed(2)+' s':'—')+'</strong><span>'+frames+' actual frames ÷ '+s.fps+' FPS'+(s.frames>300?' · Above 300 frames':'')+'</span>';
 if(s.extension){
  $('#durationInfo small').textContent='Duration to add';
  $('#durationInfo span').textContent=valid?s.frames+' new frames · '+((s.extension.frames+s.frames)/s.fps).toFixed(2)+' s joined':'Choose the number of frames to add.';
 }
 $('#durationInfo').classList.toggle('overBudget',s.frames>300);
 $('[data-setting="frames"]').style.borderColor=s.frames>300?'var(--red)':'';
}
function renderPresets(){let list=state.presets[page];$('#presetMenu').innerHTML=list.map((p,i)=>`<div class="row"><button class="name" data-load-preset="${i}">${esc(p.name)}</button><button class="icon" data-rename-preset="${i}" aria-label="Rename preset">✎</button><button class="icon danger" data-delete-preset="${i}" aria-label="Delete preset">×</button></div>`).join('')+'<button class="textbutton" id="savePreset">＋ Save current</button>';
 $$('[data-load-preset]').forEach(b=>b.onclick=()=>{let p=list[+b.dataset.loadPreset];state.settings[page]=structuredClone(p.settings);state.inputs[page]=structuredClone(p.input);presetName=p.name;persist();$('#presetMenu').hidden=true;render();});
 $$('[data-rename-preset]').forEach(b=>b.onclick=async()=>{let p=list[+b.dataset.renamePreset];let name=await askName('Rename preset',p.name);if(name){p.name=name;persist();renderPresets();}});
 $$('[data-delete-preset]').forEach(b=>b.onclick=()=>{list.splice(+b.dataset.deletePreset,1);persist();renderPresets();});
 $('#savePreset').onclick=async()=>{const kind=page;let name=await askName('Save settings preset');if(!name)return;list.push({name,settings:structuredClone(state.settings[kind]),input:structuredClone(state.inputs[kind])});presetName=name;persist();$('#presetMenu').hidden=true;render();};
}
function askName(title,value=''){return new Promise(resolve=>{openModal(title,'<label>Name</label><input id="newName" maxlength="100">','<button class="green" id="nameDone">Save</button>');$('#newName').value=value;$('#newName').focus();$('#nameDone').onclick=()=>{let n=$('#newName').value.trim();if(!n)return;closeModal();resolve(n);};$('#modalClose').onclick=()=>{closeModal();resolve(null);};});}
function openModal(title,body,actions=''){if(typeof stopModelBrowser==='function')stopModelBrowser();$('#modalClose').innerHTML=backChevron;$('#modalClose').setAttribute('aria-label','Back');$('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#modalActions').innerHTML=actions;$('#modalClose').onclick=closeModal;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){if(typeof stopModelBrowser==='function')stopModelBrowser();$('#modal').close();$('#modalBody').innerHTML='';maskSession=null;}
let maskSession=null;
async function openMask(){
 const inp=state.inputs.image,img=await loadImg(inp.data);openModal('Paint the area to regenerate',`<div class="masktools"><label>Brush</label><input id="brush" type="range" min="3" max="160" value="35"><select id="maskColor" style="width:100px"><option value="white">White</option><option value="green">Green</option></select><button id="resetDraw" class="danger">Reset</button></div><div class="maskstage"><img id="maskPhoto" src="${inp.data}"><canvas id="maskCanvas"></canvas></div>`,'<button id="discardMask">Discard</button><button class="green" id="applyMask">Apply</button>');
 const canvas=$('#maskCanvas'),ctx=canvas.getContext('2d');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;if(inp.mask){const old=await loadImg(inp.mask);ctx.drawImage(old,0,0);}maskSession={dirty:!!inp.mask};
 let drawing=false,last=null;function point(e){let r=canvas.getBoundingClientRect();return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height];}
 function draw(e){if(!drawing)return;const p=point(e);ctx.strokeStyle='white';ctx.fillStyle='white';ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=Number($('#brush').value)*canvas.width/canvas.getBoundingClientRect().width;ctx.beginPath();ctx.moveTo(...(last||p));ctx.lineTo(...p);ctx.stroke();if(!last){ctx.beginPath();ctx.arc(p[0],p[1],ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}last=p;maskSession.dirty=true;}
 canvas.onpointerdown=e=>{e.preventDefault();drawing=true;canvas.setPointerCapture(e.pointerId);draw(e);};canvas.onpointermove=draw;canvas.onpointerup=canvas.onpointercancel=()=>{drawing=false;last=null;};
 $('#maskColor').onchange=e=>canvas.classList.toggle('greenmask',e.target.value==='green');$('#resetDraw').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);maskSession.dirty=false;};$('#discardMask').onclick=closeModal;
 $('#applyMask').onclick=()=>{if(maskSession.dirty){inp.mask=canvas.toDataURL('image/png');}else delete inp.mask;state.settings.image.mask=null;persist();closeModal();renderGenerator();};
}
let submitting=false;
function pendingSubmission(kind){return state.pendingByKind?.[kind]||(state.pendingRequest?.kind===kind?state.pendingRequest:null);}
function acceptSubmission(payload,accepted){
 const kind=payload.kind,s=state.settings[kind];
 if(state.pendingByKind?.[kind]?.requestId===payload.requestId)delete state.pendingByKind[kind];
 if(state.pendingRequest?.requestId===payload.requestId)delete state.pendingRequest;
 s.batch=1;
 if(payload.settings.increment&&String(s.seed)===String(payload.settings.seed))s.seed=((BigInt(s.seed)+BigInt(payload.count))%(2n**64n)).toString();
 persist(kind);Native.watchBatch?.(accepted.batch);
}
async function resolvePendingSubmission(kind){
 if(submitting)throw Error('The current submission is still being sent. Please try again when it finishes.');
 const payload=pendingSubmission(kind);if(!payload)return;
 const session=epoch;submitting=true;
 try{
  // A lost HTTP reply is not a rejected batch. Reconcile first, including jobs
  // which have finished; retry with the exact original idempotency key if absent.
  const receipt=await api('batch/'+payload.requestId);
  if(session!==epoch)throw Error('PC connection changed; the saved submission is kept.');
  const accepted=receipt.jobs?.length?{batch:payload.requestId}:await api('generate',payload);
  if(session!==epoch)throw Error('PC connection changed; the saved submission is kept.');
  acceptSubmission(payload,accepted);
 }catch(e){throw Error('Could not confirm the previous batch: '+e.message+'. Its saved request is kept for retry.');}
 finally{submitting=false;}
}
async function stopBatch(batch){try{await api('stop',{batch});toast('Stopping this batch');await poll();}catch(e){toast(e.message);}}
async function generate(){
 if(!connected)return toast(window.Desktop?'Turn the server on in the sidebar first.':'Connect to your PC first.');if(submitting)return;
 const kind=page,s=state.settings[kind],inp=structuredClone(state.inputs[kind]),snapshot=structuredClone(s),count=s.batch||1;
 snapshot.provenanceVersion=1;
 snapshot.steps=limit(Math.round(Number(snapshot.steps))||1,1,s.replayOf?Math.max(stepLimit(kind),s.steps):stepLimit(kind));
 state.pendingByKind??={};if(state.pendingRequest){state.pendingByKind[state.pendingRequest.kind]=state.pendingRequest;delete state.pendingRequest;}
 let payload=state.pendingByKind[kind];
 const character=kind==='video'&&hasCharacterReference(snapshot,inp);
 if(!payload&&character&&queueProtocol<20)return toast('Stable Character reference requires the updated Windows bridge.');
 if(kind==='video'&&(inp.finalFrame?.data||snapshot.finalFrame)&&queueProtocol<19)return toast('Final frame needs Windows beta 61. Update the PC bridge before generating.');
 if(kind==='video'&&(snapshot.negative||'').trim()&&queueProtocol<15)return toast('Update Windows to beta 24 for video negative prompts.');
 if(kind==='video'){snapshot.sound=s.sound!==false;if(queueProtocol<14)return toast('Video sound needs Windows beta 23. If the PC just updated, its active queue will finish first.');}
 if(kind==='video'&&snapshot.exactFrames&&!snapshot.extension&&queueProtocol<11)return toast('Update Windows to beta 20 for exact video length.');
 if(kind==='video'&&snapshot.model===erosModel&&queueProtocol<12)return toast('Selecting Eros Max needs Windows beta 21.');
 if(snapshot.extension&&queueProtocol<9)return toast('Extend needs the new Windows worker. If you just updated, let the previous queue finish and reconnect after 90 seconds.');
 if(!payload&&kind==='video'&&!inp.data&&!snapshot.extension){
  if(queueProtocol<10)return toast('Text to video needs Windows beta 19. If you just updated, let the previous worker finish its queue.');
  snapshot.upload=null;snapshot.mask=null;
 }
 submitting=true;$('#play').disabled=true;$('#batchButton').disabled=true;$('#runSpinner').hidden=false;
 try{
  if(!payload&&character){
   const eros=snapshot.model===erosModel;
   const current=characterVideoProfile(snapshot.model);
   if(!current||current.missing.length)catalog=await api('catalog');
   const profile=characterVideoProfile(snapshot.model);
   if(!profile||profile.missing.length){
    if(page===kind)refreshVideoModelField();
    const missing=profile?.missing.join(', ')||'the updated Windows bridge';
    throw Error('Stable Character reference needs '+missing+'.');
   }
   if(!eros){
    if(snapshot.model!==ref2vaModel)snapshot.videoModelBeforeCharacter=snapshot.model;
    snapshot.model=profile.model;
    snapshot.loras=[];
   }
  }
  if(!payload){
   if(inp.data&&!snapshot.upload)snapshot.upload=(await api('upload',{data:inp.data})).name;
   if(inp.mask&&!snapshot.mask)snapshot.mask=(await api('upload',{data:inp.mask})).name;
   if(kind==='video'&&inp.finalFrame?.data&&!snapshot.finalFrame)snapshot.finalFrame=(await api('upload',{data:inp.finalFrame.data})).name;
   if(kind==='video'&&inp.finalFrame?.data===state.inputs.video.finalFrame?.data)s.finalFrame=snapshot.finalFrame;
   if(character&&inp.characterReference?.data&&!snapshot.characterReference){
    snapshot.characterReference=(await api('upload',{data:inp.characterReference.data})).name;
    if(inp.characterReference.data===state.inputs.video.characterReference?.data)s.characterReference=snapshot.characterReference;
   }
   if(inp.data===state.inputs[kind].data&&inp.mask===state.inputs[kind].mask){s.upload=snapshot.upload;s.mask=snapshot.mask;}
   payload={kind,count,settings:snapshot,requestId:crypto.randomUUID()};state.pendingByKind[kind]=payload;persist(kind);
  }
  const accepted=await api('generate',payload);acceptSubmission(payload,accepted);
  toast('Added '+payload.count+' to the PC queue');if(page===kind){const seed=$('[data-setting="seed"]');if(seed)seed.value=s.seed;}await poll();
 }catch(e){if(/^HTTP (400|401|403|413)/.test(e.message)){delete state.pendingByKind[kind];persist();}if($('#genError'))$('#genError').textContent=e.message;toast(e.message);}
 finally{
  submitting=false;
  if($('#play')){
   $('#play').disabled=false;
   $('#batchButton').disabled=false;
   $('#runSpinner').hidden=!queueProgress().job;
  }
 }
}
async function poll(){
 if(!connected||pollBusy||document.hidden)return;const id=epoch,view=page;pollBusy=true;
 const current=()=>id===epoch&&connected&&page===view;
 const dashboard=dashboardVisible();
 let metricsError='';
 const metrics=dashboard?api('metrics').then(m=>{if(current())showMetrics(m);}).catch(e=>{metricsError='PC telemetry unavailable: '+e.message;}):null;
 try{
  if(dashboard||['image','video'].includes(view)){const [status,latest]=await Promise.all([api('status'),window.Desktop?api('library'):null]);if(!current())return;
   if(status){
    const build=status.build||String(status.protocol);if(workerBuild&&workerBuild!==build){catalog=null;loadCatalog();}workerBuild=build;
    jobs=status.jobs;active=status.active;previewAvailable=status.preview;queueProtocol=status.protocol;imagePreviewProtocol=queueProtocol>=7;queueEtaSeconds=status.queueEtaSeconds??null;
    if(dashboard)updateBridgeActivity();
    await refreshHistory();if(!current())return;
   }
   if(latest&&signature(latest)!==inventory&&(!shelfError||Date.now()>=nextSync))syncShelf(true);
   if(dashboard)updateBridgeActivity();if($('#play'))updateProgress();
  }
  if(current())pollNote='';
 }catch(e){if(current()){pollNote='Generation or library status unavailable: '+e.message;if(dashboard){queueProtocol=0;updateBridgeActivity(true);}}}
 finally{await metrics;if(current()&&metricsError)pollNote=[pollNote,metricsError].filter(Boolean).join(' ');pollBusy=false;notice();}
}
function showMetrics(m){const gb=v=>(v/1073741824).toFixed(1);const vals=m?[[m.cpu==null?'—':m.cpu.toFixed(0)+'%',m.cpuWatts==null?'Power unavailable':m.cpuWatts.toFixed(1)+' W',m.cpu],[m.gpu==null?'—':m.gpu.toFixed(0)+'%',m.gpuWatts==null?'HWiNFO unavailable':m.gpuWatts.toFixed(0)+' W',m.gpu],[gb(m.ramUsed)+' GB','of '+gb(m.ramTotal)+' GB',m.ramUsed/m.ramTotal*100],[m.vramUsed==null?'—':gb(m.vramUsed)+' GB','of '+gb(m.vramTotal)+' GB',m.vramUsed/m.vramTotal*100],[gb(m.commitUsed)+' GB','of '+gb(m.commitTotal)+' GB committed',m.commitUsed/m.commitTotal*100]]:Array.from({length:5},()=>['—','Waiting for bridge',0]);vals.forEach((v,i)=>{if($('#m'+i)){$('#m'+i).textContent=v[0];$('#ms'+i).textContent=v[1];$('#mb'+i).style.width=Math.max(0,Math.min(100,v[2]||0))+'%';}});}
function updateProgress(){if(!$('#play'))return;
 const {pending:pendingJobs,job:j,running,pct,label}=queueProgress();
 const mine=pendingJobs.find(job=>job.kind===page&&job.owner===info().device);
 $('#playLabel').textContent=pendingJobs.length?'Add to queue':'Generate';$('#play').disabled=submitting;$('#batchButton').disabled=submitting;$('#stopBatch').hidden=!mine;$('#stopBatch').onclick=()=>mine&&stopBatch(mine.batch);
 $('#runSpinner').hidden=!submitting&&!j;$('#progressRow').hidden=!j;
 renderQueue($('#generatorQueue'));
 if(j){
  $('#progressFill').style.width=pct+'%';
  $('#progressText').textContent=label;
  $('#jobMessage').textContent=(j.kind===page?'':j.kind+' · ')+(j.current_node||(running?'Preparing workflow':'Waiting in PC queue'));
  const timer=document.createElement('span');timer.id='generatorTimer';
  timer.textContent=queueTiming();$('#jobMessage').append(' ',timer);
  const mini=$('#livePreview');
  if(imagePreviewProtocol){
   bindFrame(mini,running?j.id:null);
  }else{
   delete mini.dataset.frameJob;mini.hidden=!previewAvailable||!running;
   if(!mini.hidden)mini.src='/preview?t='+Date.now();
  }
  $('#batchLabel').textContent=j.total>1?j.total+' in batch':'Single generation';
 }
 else{const last=jobs.find(j=>j.kind===page);$('#jobMessage').textContent=last?.status==='complete'?'Generation complete':last?.status==='error'?'Generation failed — details below':'';if(last?.status==='error')$('#genError').innerHTML='<div class="errorbox">'+esc(last.error)+'</div>';}
 if(['image','video'].includes(page)){
  if(!liveSelection&&currentGeneration(page)&&!library.some(x=>x.kind===page&&!x.archived))liveSelection={id:active,kind:page};
  if(liveSelection)renderLiveGeneration($('#result'));
 }
 renderCarousel();
}
function refreshCarouselSelection(){
 const box=$('#result');if(!box)return;
 const live=box.querySelector('.watchGeneration')?box.dataset.live:null;
 const selected=live?null:box.querySelector('.asset')?.dataset.id;
 $$('#carousel .thumb').forEach(tile=>{
  const current=tile.classList.contains('inflightThumb')?!!live&&tile.dataset.liveJob===live:live?library.find(x=>x.id===tile.dataset.media)?.job===live:!!selected&&tile.dataset.media===selected;
  tile.setAttribute('aria-current',String(current));
 });
}
const recentResults=()=>library.filter(x=>x.kind===page&&!x.archived);
function latestResultSummary(){
 const items=recentResults(),selected=$('#result .asset')?.dataset.id;
 const live=liveSelection?.kind===page&&liveJob(liveSelection.id);
 const activePreview=liveStatus(live?.status);
 const first=items.find(item=>item.id===selected)||items[0];
 const completed=activePreview?items.slice(0,9):first?[first,...items.filter(item=>item!==first).slice(0,9)]:[];
 const thumbs=completed.map(item=>{
  const src=media(item.id,true);
  const time=item.kind==='video'&&item.duration>0?'<small>'+esc(duration(item.duration))+'</small>':'';
  return '<div class="foldResult">'+(src?'<img class="foldThumb" src="'+esc(src)+'" loading="lazy" draggable="false" alt="Generated '+item.kind+'">':'<span class="foldThumb" aria-label="Thumbnail unavailable"></span>')+time+'</div>';
 });
 if(activePreview){
  const preview=frames.get(live.id)?.url;
  thumbs.unshift('<div class="foldResult foldLive" aria-label="Generation in progress"><img class="foldThumb" data-frame-job="'+esc(live.id)+'" '+(preview?'src="'+esc(preview)+'"':'hidden')+' alt=""><i class="spinner" aria-hidden="true"></i></div>');
 }
 return thumbs.length?'<div class="foldRecent">'+thumbs.join('')+'</div>':{hint:'No results yet'};
}
function renderCarousel(){
 const carousel=$('#carousel');if(!carousel)return;
 $('#latestPanel')?.refreshFoldSummary?.();
 const items=recentResults().slice(0,20);
 if(!carousel.querySelector('.recentStrip'))carousel.innerHTML='<div class="recentStrip"></div>';
 const strip=carousel.querySelector('.recentStrip');
 const key=JSON.stringify(items.map(x=>[x.id,media(x.id,true),x.duration]));
 if(strip.dataset.key!==key){
  strip.dataset.key=key;
  strip.innerHTML=items.map(x=>`<button class="thumb" data-media="${x.id}"><img src="${media(x.id,true)}" alt="Generated ${x.kind}">${x.kind==='video'?'<span>▶ '+duration(x.duration)+'</span>':''}</button>`).join('');
  wireMedia(carousel);
 }
 const live=nextGeneration(page);
 const pending=!!live;
 let tile=carousel.querySelector('.inflightThumb');
 if(!pending){tile?.remove();}
 else{
  if(!tile){tile=document.createElement('button');tile.className='thumb inflightThumb';tile.innerHTML='<img hidden alt=""><i class="spinner"></i>';carousel.prepend(tile);}
  const image=tile.querySelector('img');
  tile.disabled=false;tile.dataset.liveJob=live.id;tile.setAttribute('aria-label','View live '+live.kind+' preview');
  tile.onclick=()=>selectLiveGeneration(live.id);
  if(imagePreviewProtocol){
   bindFrame(image,live.id);
  }else{
   delete image.dataset.frameJob;image.hidden=!previewAvailable||!jobs.some(j=>j.id===active&&j.kind===page);
   if(!image.hidden)image.src='/preview?t='+Date.now();
  }
 }
 refreshCarouselSelection();pruneFrames();
}
function duration(n){return Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');}
const warningText={changed:'The PC file changed. Your original phone copy is protected.',missing:'The PC file was deleted. Your phone copy is still here.',older:'Outside the newest 100. You can keep this copy, save it to the camera roll, or remove it from the app.'};
init().catch(e=>{$('#main').innerHTML='<div class="errorbox">'+(window.Desktop?'Desktop storage could not be opened: ':'Phone storage could not be opened: ')+esc(e.message)+'</div>';});
