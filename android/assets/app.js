'use strict';
const $ = (s, root=document)=>root.querySelector(s), $$=(s,root=document)=>[...root.querySelectorAll(s)];
const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let db, state={settings:{},presets:{image:[],video:[]},prompts:[],inputs:{image:{},video:{}}}, page='bridge', connected=false, connecting=false, catalog=null, library=[], jobs=[], active=null, previewAvailable=false, archived=false, pollBusy=false, presetName='', saveTimer;
const pending=new Map(); let rpcId=0;
window.bridgeResult=(id,ok,value)=>{const p=pending.get(id);if(!p)return;pending.delete(id);ok?p.resolve(value):p.reject(new Error(value));};
async function api(path,body){
 if(window.Native)return new Promise((resolve,reject)=>{let id=++rpcId;pending.set(id,{resolve,reject});Native.request(id,path,body===undefined?'GET':'POST',body===undefined?'':JSON.stringify(body));});
 const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error('HTTP '+r.status+': '+(d.error||r.statusText));return d;
}
const media=(id,thumb=false)=>{const j=library.find(x=>x.id===id);return j?.local?'/local/'+(thumb?'thumb/':'image/')+id+'/'+j.local:thumb&&connected?'/thumb/'+id:'';};
let syncing=false,filling=false,nextSync=0,inventory='',shelfError='';
function local(op,args={}){return new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});Native.localMedia(id,op,JSON.stringify(args));});}
const signature=items=>items.map(j=>j.id+':'+j.archived).sort().join(',');
function showShelf(){if(page==='library')renderLibrary();else if($('#result'))renderResults();}
function setShelf(items){library=items.filter(j=>j.source!=='missing'||j.local).sort((a,b)=>b.created-a.created||b.id.localeCompare(a.id));showShelf();notice();}
function updateItem(j){setShelf(library.filter(x=>x.id!==j.id).concat(j));}
async function syncShelf(force=false){
 if(!connected||syncing||(!force&&Date.now()<nextSync))return;
 const session=epoch;syncing=true;nextSync=Date.now()+300000;
 try{const index=await api('media-index');if(epoch!==session||!connected)return;const rows=await local('sync',index);if(epoch!==session)return;
  inventory=signature(index.items);shelfError='';setShelf(rows);fillShelf();
 }catch(e){if(epoch===session){shelfError='Could not check phone copies: '+e.message+(e.message.includes('404')?' Update the Windows bridge to beta 4.':'');nextSync=Date.now()+30000;showShelf();}}
 finally{syncing=false;}
}
async function fillShelf(){
 if(filling)return;filling=true;const session=epoch;let firstError='';
 try{for(const j of library.filter(j=>j.recent&&!j.local&&j.source==='available')){
  if(!connected||epoch!==session||document.hidden)break;
  try{const saved=await local('fetch',{id:j.id});if(epoch!==session)break;updateItem(saved);}
  catch(e){firstError=e.message;if(/storage|space/i.test(firstError))break;}
 }}finally{filling=false;if(firstError&&epoch===session){shelfError='Some phone copies are pending: '+firstError;nextSync=Math.min(nextSync,Date.now()+30000);showShelf();}}
}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),3800);}
function persist(){scheduleBackup();clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(db){let t=db.transaction('data','readwrite');t.objectStore('data').put(state,'state');t.onerror=()=>toast('Phone storage is full; settings could not be saved.');}},120);}
async function init(){
 db=await new Promise((resolve,reject)=>{let r=indexedDB.open('comfybridge',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const saved=await new Promise(resolve=>{let r=db.transaction('data').objectStore('data').get('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});freshPhone=!saved;if(saved)state=saved;
 $('#hamburger').onclick=()=>drawer(true);$('#shade').onclick=()=>drawer(false);$$('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
 $('#presetButton').onclick=()=>{let m=$('#presetMenu');if(m.hidden){renderPresets();m.hidden=false;}else m.hidden=true;};
 $('#modalClose').onclick=closeModal;$('#modal').addEventListener('cancel',()=>{if(maskSession)maskSession=null;});
 document.addEventListener('click',e=>{if(!e.target.closest('#presetButton,#presetMenu'))$('#presetMenu').hidden=true;});
 if(window.Native&&JSON.parse(Native.configuration()).paired){try{setShelf(await local('list'));}catch(e){shelfError=e.message;}}
 render();setInterval(heartbeat,2500);document.addEventListener('visibilitychange',()=>{if(!document.hidden){nextProbe=0;nextSync=0;heartbeat();}else if(profileDirty)flushProfile();});
 window.openJobAlert=async()=>{const route=window.Native?.notificationRoute();if(!route)return;
  if(!connected&&info().paired&&!connecting&&!wanted){navigate('bridge');await $('#connect').onclick();}
  if(route==='library'){navigate('library');return;}
  if(connected){try{const status=await api('status'),j=status.jobs.find(x=>x.owner===info().device&&['running','pending','submitting','cancelling'].includes(x.status));navigate(j?.kind||'library');}catch(e){toast(e.message);}}
 };window.openJobAlert();
}
function drawer(open){$('#drawer').classList.toggle('open',open);$('#shade').hidden=!open;}
function navigate(to){page=to;archived=false;presetName='';drawer(false);render();window.scrollTo(0,0);if(connected)poll();}
function connection(value){connected=value;$$('.dot').forEach(d=>d.classList.toggle('connected',value));$('#statusDot').setAttribute('aria-label',value?'Connected':'Disconnected');$('#drawerStatus').textContent=value?'PC connected':'Disconnected';}
function render(){
 $('#pageTitle').textContent=page[0].toUpperCase()+page.slice(1);$('#presetButton').hidden=!['image','video'].includes(page);$('#presetButton').innerHTML=esc(presetName||'Current settings')+' <span>⌄</span>';
 $$('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===page));
 if(page==='bridge')renderBridge();else if(page==='library')renderLibrary();else renderGenerator();connection(connected);
}
const pcIcon='<svg viewBox="0 0 64 64"><rect x="7" y="10" width="50" height="34" rx="5"/><path d="M23 54h18M32 44v10M17 34l8-9 8 6 13-13"/></svg>';
let editPair=false,pairAddress=null,bridgeError="";
let wanted=false,epoch=0,probing=false,nextProbe=0,misses=0,catalogLoading=false,serviceNote='',pollNote='';
function notice(){const el=$('#linkNotice'),n=library.filter(j=>['missing','changed'].includes(j.warning)).length;const review=n?n+' PC file(s) changed or disappeared. Open Library to review your protected phone copies.':'';el.textContent=[wanted&&!connected?'Reconnecting to your PC. '+bridgeError+' Accepted jobs continue on the PC.':connected?[serviceNote,pollNote].filter(Boolean).join(' '):'',review].filter(Boolean).join(' ');el.hidden=!el.textContent;}
function clearSession(){
 ++epoch;profileReady=false;clearTimeout(profileTimer);wanted=false;misses=0;nextProbe=0;catalogLoading=false;serviceNote=pollNote=bridgeError='';connection(false);notice();
}
async function loadCatalog(){
 if(catalogLoading||catalog||!connected)return;
 const id=epoch;catalogLoading=true;serviceNote='PC connected. Loading ComfyUI models…';notice();
 try{const data=await api('catalog');if(id!==epoch)return;
  for(const kind of ['image','video'])if(!state.settings[kind])state.settings[kind]=structuredClone(data.defaults[kind]);
  catalog=data;persist();serviceNote='';if(page==='bridge'||!$('#play')&&['image','video'].includes(page))render();
 }catch(e){if(id!==epoch)return;serviceNote='Model list unavailable: '+e.message;}
 finally{if(id===epoch){catalogLoading=false;if(!catalog&&page==='bridge')renderBridge();notice();}}
}
function reached(){const cameBack=!connected;misses=0;nextProbe=0;bridgeError='';connection(true);
 if(cameBack&&page==='bridge')renderBridge();
 if(cameBack||!profileReady&&!profileLoad&&Date.now()>=retryProfiles)startProfiles(epoch).finally(()=>{if(connected&&!catalog)loadCatalog();});
 syncShelf(cameBack);notice();poll();
}
function unreachable(e){
 bridgeError=e.message;
 if(/HTTP 40[13]|verify the PC.s identity/i.test(bridgeError)){
  const reason=bridgeError;clearSession();editPair=true;bridgeError=reason;if(page==='bridge')renderBridge();else toast(reason);return;
 }
 connection(false);nextProbe=Date.now()+Math.min(20000,2500*2**Math.min(misses++,3));
 if(page==='bridge')renderBridge();notice();
}
async function heartbeat(){
 if(!wanted||probing||connecting||document.hidden||Date.now()<nextProbe)return;const id=epoch;probing=true;
 try{await api('ping');if(id===epoch)reached();}catch(e){if(id===epoch)unreachable(e);}finally{probing=false;}
}
function renderBridge(){
 const cfg=window.Native?JSON.parse(Native.configuration()):{host:'',paired:false};
 const enroll=!wanted&&!connected&&(!cfg.paired||editPair), host=pairAddress??cfg.host;
 const fields=enroll?`<div class="pairFields"><p>On your PC, click the ComfyBridge cube by the Windows clock. Keep its panel open while you pair.</p><label for="host">1 · PC address</label><input id="host" type="url" value="${esc(host)}" placeholder="Address shown in the PC panel" autocapitalize="off" spellcheck="false"><label for="code">2 · Six-digit pairing code</label><input id="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="000000"><small>After pairing, this phone remembers your PC.</small></div>`:`<p class="pairHost">${esc(cfg.host)}</p>`;
 $('#main').innerHTML=`<section class="pairCard"><div class="orb ${connected?'connected':''}" id="orb">${connected?'<span class="pairCheck">✓</span>':pcIcon}</div><h1 id="connectTitle">${connected?'PC connected':enroll?'Pair your phone':'Connect to your PC'}</h1>${fields}<div id="pairError" role="alert" ${bridgeError?'':'hidden'}>${esc(bridgeError)}</div><button class="green connectbutton" id="connect">${connected?'Disconnect':enroll?'Pair & connect':'Connect to bridge'}</button>${!connected&&cfg.paired?`<button class="textbutton" id="changePair">${editPair?'Use saved pairing':'Pair again or change PC address'}</button>`:''}</section><div id="destinations" class="grid2 pathcards" ${connected?'':'hidden'}><button data-open="image"><span class="largeicon">▧</span><strong>Create an image ↗</strong><small>Text, image or mask</small></button><button data-open="video"><span class="largeicon">▷</span><strong>Create a video ↗</strong><small>Bring an image to life</small></button></div><div class="sectionline"><h2>Machine pulse</h2><span class="pill" id="liveLabel">${connected?'LIVE':'OFFLINE'}</span></div><div class="telemetry">${['CPU','GPU','RAM','VRAM','SYSTEM COMMIT'].map((m,i)=>`<div class="metric" ${i===4?'style="grid-column:1/-1"':''}><label>${m}</label><strong id="m${i}">—</strong><small id="ms${i}">Waiting for bridge</small><div class="meter"><i id="mb${i}"></i></div></div>`).join('')}</div>`;
 const error=(msg,field)=>{bridgeError=msg;$('#pairError').hidden=false;$('#pairError').textContent=msg;if(field){field.setAttribute('aria-invalid','true');field.focus();}};
 if($('#host'))$('#host').oninput=()=>{pairAddress=$('#host').value;};
 if(wanted&&!connected){$('#connectTitle').textContent='Reconnecting…';$('#connect').textContent='Cancel reconnect';$('#orb').classList.add('connecting');$('#pairError').hidden=true;}
 if(connected&&!catalog&&!catalogLoading&&serviceNote){const retry=document.createElement('button');retry.textContent='Retry loading models';retry.onclick=()=>loadCatalog();$('#connect').after(retry);}
 if($('#changePair'))$('#changePair').onclick=()=>{clearSession();editPair=!editPair;pairAddress=null;renderBridge();};
 $('#connect').onclick=async()=>{
  if(connecting)return;
  if(connected||wanted){const wasConnected=connected;clearSession();renderBridge();if(wasConnected)api('disconnect').catch(()=>{});return;}
  let url,code;
  if(enroll){url=$('#host').value.trim();code=$('#code').value.trim();pairAddress=url;
   if(!url)return error('Enter the PC address shown in the Windows ComfyBridge panel.',$('#host'));
   if(!/^[0-9]{6}$/.test(code))return error('Enter the six-digit pairing code from the PC panel.',$('#code'));
  }
  connecting=true;bridgeError='';$('#pairError').hidden=true;$('#connect').disabled=true;$('#orb').classList.add('connecting');$('#connect').textContent=enroll?'Pairing…':'Connecting…';
  let id=++epoch;catalog=null;
  try{
   if(enroll){await new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});Native.pair(id,url,code);});if(id!==epoch)return;editPair=false;pairAddress=null;catalog=null;}
   if(id!==epoch)return;wanted=true;await api('ping');if(id===epoch)reached();
  }catch(e){if(id!==epoch)return;if(wanted)unreachable(e);else{bridgeError='Pairing: '+e.message;if(page==='bridge')renderBridge();}}finally{connecting=false;}
 };
 profileControls();$$('[data-open]').forEach(b=>b.onclick=()=>navigate(b.dataset.open));
}
function slider(key,label,min,max,step=1,disabled=false){let s=state.settings[page];return `<div class="field"><label>${label}</label><div class="controlrow"><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" ${disabled?'disabled':''}><input type="number" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" ${disabled?'disabled':''}></div></div>`;}
function renderGenerator(){
 const kind=page,s=state.settings[kind],inp=state.inputs[kind];
 if(!s){$('#main').innerHTML='<div class="empty"><div class="symbol">◉</div><h2>'+(connected?'Waiting for workflow settings':'Connect your studio first')+'</h2><p>'+(connected?'The PC is connected. Check Bridge for model loading status.':'Workflow defaults and your model library will load from the PC.')+'</p><button class="green" id="goBridge">Open Bridge</button></div>';$('#goBridge').onclick=()=>navigate('bridge');return;}
 if(!inp.data)s.denoise=1;
 $('#main').innerHTML=`<div class="gentoolbar"><div class="row spread"><div class="row"><span id="runSpinner" class="spinner" hidden></span><div class="playwrap"><button id="play" class="green">▶ Generate</button><button id="batchButton" class="green" aria-label="Choose batch">⌄</button><div class="pop" id="batchMenu" hidden>${[2,4,8,16].map(n=>`<button data-batch="${n}" style="display:block;width:100%">Batch of ${n}</button>`).join('')}</div></div></div><button id="stopBatch" class="stop" hidden>■ Stop mine</button><span class="batchlabel" id="batchLabel">${s.batch>1?s.batch+' in batch':'Single generation'}</span></div><div class="progressrow" id="progressRow" hidden><img class="preview" id="livePreview" alt="Generation preview"><div class="progress"><i id="progressFill"></i><span id="progressText"></span></div></div><div class="statusmessage" id="jobMessage"></div></div><div id="genError"></div><div id="queueList"></div><div class="row spread" style="margin-bottom:17px"><p class="eyebrow">${kind==='image'?'A STILL, A STORY':'FROM STILL TO MOTION'}</p><span class="pill" id="mode">${kind==='video'?'IMAGE → VIDEO':inp.mask?'INPAINT':inp.data?'IMAGE → IMAGE':'TEXT → IMAGE'}</span></div><section class="card"><div class="row spread"><h2>Starting image</h2><small>${kind==='video'?'Required':'Optional'}</small></div><div class="upload">${inp.data?`<img src="${inp.data}" alt="Starting image">`:'<div><strong>＋</strong><span>Choose an image</span><br><small>Tap to browse your phone</small></div>'}<input type="file" id="upload" accept="image/*" aria-label="Choose starting image"></div><div class="uploadtools"><small>${inp.data?inp.width+' × '+inp.height:kind==='image'?'Leave empty for text to image':'The first frame of your video'}</small><div>${kind==='image'?'<button id="maskButton" '+(!inp.data?'disabled':'')+'>'+(inp.mask?'Edit mask':'◌ Apply mask')+'</button>':''} <button id="clearUpload" class="danger" ${!inp.data?'disabled':''}>Clear ×</button></div></div>${inp.mask?'<button id="clearMask" class="textbutton danger">Reset mask</button>':''}${kind==='image'&&inp.data&&(inp.width>1256||inp.height>1256)?'<div class="warning">ⓘ Large source image · above 1256 × 1256.</div>':''}</section><section class="card"><h2>Canvas & model</h2>${kind==='image'?`<div class="grid2 field"><div><label>Width</label><input type="number" data-setting="width" value="${s.width}" min="32" max="8192" step="8"></div><div><label>Height</label><input type="number" data-setting="height" value="${s.height}" min="32" max="8192" step="8"></div></div>`:`<div class="field"><div class="row spread"><label>Scale from source</label><strong id="scaleValue">${s.scale>0?'+':''}${s.scale}%</strong></div><input class="scaleRange" type="range" data-setting="scale" min="-90" max="100" step="1" value="${s.scale}"><div class="row spread"><small>−90%</small><small>Original · 0</small><small>+100%</small></div><p id="resolutionInfo" class="footnote"></p></div><div class="grid2 field"><div><label>Length · frames</label><input type="number" data-setting="frames" min="5" max="3592" value="${s.frames}"></div><div><label>FPS</label><input type="number" data-setting="fps" min="1" max="120" value="${s.fps}"></div></div><div id="durationInfo" class="footnote"></div>`}<div class="field"><label>${kind==='video'?'Model · locked to workflow':'Checkpoint'}</label>${kind==='video'?`<input readonly value="${esc(s.model)}">`:`<select data-setting="model">${(catalog?.models||[s.model]).map(m=>`<option ${m===s.model?'selected':''}>${esc(m)}</option>`).join('')}</select>`}</div></section><section class="card"><div class="row spread"><h2>LoRAs</h2><button id="addLora" class="textbutton">＋ Add</button></div><div id="loras"></div></section>${promptField('positive','Positive prompt')}${kind==='image'?promptField('negative','Negative prompt'):''}<section class="card"><h2>Generation settings</h2>${slider('steps','Steps',1,100)}${kind==='image'?slider('cfg','CFG',0,20,.1)+slider('denoise','Denoise'+(!inp.data?' · locked for text to image':''),0,1,.01,!inp.data):''}<div class="field"><label>Seed</label><input type="text" inputmode="numeric" data-setting="seed" value="${esc(s.seed)}"></div><label class="togglelabel"><input type="checkbox" id="increment" ${s.increment?'checked':''}>Increment seed after each generation</label></section><div class="sectionline"><h2>Latest result</h2><button id="toLibrary" class="textbutton">Library ↗</button></div><div class="resultbox" id="result"></div><div class="carousel" id="carousel"></div>`;
 $('#upload').onchange=e=>loadImage(e.target.files[0]);$('#clearUpload').onclick=()=>{state.inputs[kind]={};s.upload=null;s.mask=null;if(kind==='image'){s.width=1024;s.height=1536;s.denoise=1;}persist();renderGenerator();};
 if($('#maskButton'))$('#maskButton').onclick=openMask;if($('#clearMask'))$('#clearMask').onclick=()=>{delete inp.mask;delete s.mask;persist();renderGenerator();};
 $('#increment').onchange=e=>{s.increment=e.target.checked;persist();};
 $$('[data-setting]').forEach(el=>el.oninput=()=>{let key=el.dataset.setting;s[key]=['model','seed'].includes(key)?el.value:Number(el.value);$$(`[data-setting="${key}"]`).forEach(other=>{if(other!==el)other.value=el.value;});if(kind==='video'&&['scale','frames','fps'].includes(key))updateVideo();persist();});
 $('#batchButton').onclick=()=>$('#batchMenu').hidden=!$('#batchMenu').hidden;$$('[data-batch]').forEach(el=>el.onclick=()=>{s.batch=+el.dataset.batch;$('#batchLabel').textContent=s.batch+' in batch';$('#batchMenu').hidden=true;persist();generate();});
 $('#play').onclick=generate;$('#toLibrary').onclick=()=>navigate('library');$('#addLora').onclick=()=>{if(!catalog?.loras?.length)return toast('Connect to load your LoRAs.');s.loras.push({name:catalog.loras[0],strength:1,enabled:true});renderLoras();persist();};
 renderLoras();wirePrompts();if(kind==='video')updateVideo();renderResults();updateProgress();
}
function promptField(key,label){return `<section class="card"><div class="promptlabel"><label>${label}</label><button data-expand="${key}" class="textbutton" aria-label="Expand ${label}">⛶</button></div><div class="prompttools"><select data-prompt-library="${key}"><option value="">Saved prompts…</option>${state.prompts.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select><button data-save-prompt="${key}" aria-label="Save prompt">＋</button><button data-delete-prompt="${key}" class="danger" aria-label="Delete selected prompt">×</button></div><textarea data-setting="${key}" placeholder="Describe your idea…">${esc(state.settings[page][key])}</textarea></section>`;}
function wirePrompts(){
 $$('textarea[data-setting]').forEach(el=>el.oninput=()=>{state.settings[page][el.dataset.setting]=el.value;persist();});
 $$('[data-expand]').forEach(b=>b.onclick=()=>{let k=b.dataset.expand,kind=page;openModal(k==='positive'?'Positive prompt':'Negative prompt','<textarea id="fullPrompt"></textarea>','<button class="green" id="applyPrompt">Done</button>');$('#fullPrompt').value=state.settings[kind][k];$('#fullPrompt').oninput=()=>{state.settings[kind][k]=$('#fullPrompt').value;persist();};$('#applyPrompt').onclick=()=>{closeModal();renderGenerator();};});
 $$('[data-save-prompt]').forEach(b=>b.onclick=async()=>{let name=await askName('Save prompt');if(!name)return;state.prompts.push({name,text:state.settings[page][b.dataset.savePrompt]});persist();renderGenerator();});
 $$('[data-prompt-library]').forEach(el=>el.onchange=()=>{if(el.value==='')return;let key=el.dataset.promptLibrary;state.settings[page][key]=state.prompts[+el.value].text;$(`textarea[data-setting="${key}"]`).value=state.settings[page][key];persist();});
 $$('[data-delete-prompt]').forEach(b=>b.onclick=()=>{let sel=$(`[data-prompt-library="${b.dataset.deletePrompt}"]`);if(sel.value==='')return toast('Choose a saved prompt first.');state.prompts.splice(+sel.value,1);persist();renderGenerator();});
}
function renderLoras(){
 const list=state.settings[page].loras;
 $('#loras').innerHTML=list.length?list.map((l,i)=>`<div class="lora" data-lora="${i}"><div class="row"><input type="checkbox" data-enable="${i}" ${l.enabled?'checked':''} ${l.locked?'disabled':''} aria-label="Enable LoRA">${l.locked?`<span class="lockedname">▣ ${esc(l.name)}</span>`:`<select data-lora-name="${i}">${[...new Set([l.name,...(catalog?.loras||[])])].map(n=>`<option ${n===l.name?'selected':''}>${esc(n)}</option>`).join('')}</select><button data-remove-lora="${i}" class="icon danger" aria-label="Remove LoRA">×</button>`}</div><div class="controlrow"><input type="range" data-strength="${i}" min="-5" max="5" step=".01" value="${l.strength}" aria-label="LoRA strength"><input type="number" data-strength="${i}" min="-20" max="20" step=".01" value="${l.strength}" aria-label="LoRA strength"></div>${l.locked?'<small>Required turbo LoRA · always enabled</small>':''}</div>`).join(''):'<small>No LoRAs added.</small>';
 $$('[data-enable]').forEach(e=>e.onchange=()=>{list[+e.dataset.enable].enabled=e.checked;persist();});$$('[data-lora-name]').forEach(e=>e.onchange=()=>{list[+e.dataset.loraName].name=e.value;persist();});
 $$('[data-remove-lora]').forEach(e=>e.onclick=()=>{list.splice(+e.dataset.removeLora,1);persist();renderLoras();});$$('[data-strength]').forEach(e=>e.oninput=()=>{let i=+e.dataset.strength;list[i].strength=Number(e.value);delete list[i].clipStrength;$$(`[data-strength="${i}"]`).forEach(o=>{if(o!==e)o.value=e.value;});persist();});
}
async function loadImage(file){
 if(!file)return;const kind=page;
 try{const data=await new Promise((resolve,reject)=>{let r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);});const img=await loadImg(data);if(img.naturalWidth*img.naturalHeight>40000000)throw new Error('Please choose an image under 40 megapixels.');state.inputs[kind]={data,width:img.naturalWidth,height:img.naturalHeight};let s=state.settings[kind];s.upload=null;s.mask=null;s.width=img.naturalWidth;s.height=img.naturalHeight;s.scale=0;if(kind==='image')s.denoise=.75;persist();renderGenerator();}catch(e){toast(e.message);}
}
function loadImg(data){return new Promise((resolve,reject)=>{let i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('That image could not be opened.'));i.src=data;});}
function updateVideo(){let s=state.settings.video,inp=state.inputs.video;if(inp.data){s.width=Math.max(32,Math.round(inp.width*(1+s.scale/100)/32)*32);s.height=Math.max(32,Math.round(inp.height*(1+s.scale/100)/32)*32);}
 $('#scaleValue').textContent=(s.scale>0?'+':'')+s.scale+'%';const high=s.width*s.height>768*1152;$('#resolutionInfo').textContent=`${s.width} × ${s.height} · ${(s.width*s.height/1e6).toFixed(2)} MP${high?' · Above 768 × 1152 pixel budget':''} · Rounded to model’s 32px grid`;
 $('#resolutionInfo').className=high?'warning':'footnote';const maxScale=inp.width?((Math.sqrt((768*1152)/(inp.width*inp.height))-1)*100):0;const pos=Math.max(0,Math.min(100,(maxScale+90)/190*100));$('[data-setting="scale"]').style.setProperty('background',`linear-gradient(90deg,#315c47 0%,#9ae5bc ${pos}%,#ff777d ${pos}%,#ff777d 100%)`,'important');
 const frames=5+17*Math.max(0,Math.ceil((s.frames-5)/17));$('#durationInfo').textContent=`${frames} actual frames ÷ ${s.fps} FPS = ${(frames/s.fps).toFixed(2)} seconds${s.frames>300?' · Above 300 frames':''}. H3 uses 17k+5 frame lengths.`;$('#durationInfo').className=s.frames>300?'warning':'footnote';$('[data-setting="frames"]').style.borderColor=s.frames>300?'var(--red)':'';persist();
}
function renderPresets(){let list=state.presets[page];$('#presetMenu').innerHTML=list.map((p,i)=>`<div class="row"><button class="name" data-load-preset="${i}">${esc(p.name)}</button><button class="icon" data-rename-preset="${i}" aria-label="Rename preset">✎</button><button class="icon danger" data-delete-preset="${i}" aria-label="Delete preset">×</button></div>`).join('')+'<button class="textbutton" id="savePreset">＋ Save current</button>';
 $$('[data-load-preset]').forEach(b=>b.onclick=()=>{let p=list[+b.dataset.loadPreset];state.settings[page]=structuredClone(p.settings);state.inputs[page]=structuredClone(p.input);presetName=p.name;persist();$('#presetMenu').hidden=true;render();});
 $$('[data-rename-preset]').forEach(b=>b.onclick=async()=>{let p=list[+b.dataset.renamePreset];let name=await askName('Rename preset',p.name);if(name){p.name=name;persist();renderPresets();}});
 $$('[data-delete-preset]').forEach(b=>b.onclick=()=>{list.splice(+b.dataset.deletePreset,1);persist();renderPresets();});
 $('#savePreset').onclick=async()=>{const kind=page;let name=await askName('Save settings preset');if(!name)return;list.push({name,settings:structuredClone(state.settings[kind]),input:structuredClone(state.inputs[kind])});presetName=name;persist();$('#presetMenu').hidden=true;render();};
}
function askName(title,value=''){return new Promise(resolve=>{openModal(title,'<label>Name</label><input id="newName" maxlength="100">','<button class="green" id="nameDone">Save</button>');$('#newName').value=value;$('#newName').focus();$('#nameDone').onclick=()=>{let n=$('#newName').value.trim();if(!n)return;closeModal();resolve(n);};$('#modalClose').onclick=()=>{closeModal();resolve(null);};});}
function openModal(title,body,actions=''){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#modalActions').innerHTML=actions;$('#modalClose').onclick=closeModal;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){$('#modal').close();$('#modalBody').innerHTML='';maskSession=null;}
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
async function stopBatch(batch){try{await api('stop',{batch});toast('Stopping this batch');await poll();}catch(e){toast(e.message);}}
async function generate(){
 if(!connected)return toast('Connect to your PC first.');if(submitting)return;
 const kind=page,s=state.settings[kind],inp=structuredClone(state.inputs[kind]),snapshot=structuredClone(s),count=s.batch||1;
 state.pendingByKind??={};if(state.pendingRequest){state.pendingByKind[state.pendingRequest.kind]=state.pendingRequest;delete state.pendingRequest;}
 let payload=state.pendingByKind[kind];
 if(!payload&&kind==='video'&&!inp.data)return toast('Choose a starting image first.');
 submitting=true;$('#play').disabled=true;
 try{
  if(!payload){
   if(inp.data&&!snapshot.upload)snapshot.upload=(await api('upload',{data:inp.data})).name;
   if(inp.mask&&!snapshot.mask)snapshot.mask=(await api('upload',{data:inp.mask})).name;
   if(inp.data===state.inputs[kind].data&&inp.mask===state.inputs[kind].mask){s.upload=snapshot.upload;s.mask=snapshot.mask;}
   payload={kind,count,settings:snapshot,requestId:crypto.randomUUID()};state.pendingByKind[kind]=payload;persist();
  }
  const accepted=await api('generate',payload);delete state.pendingByKind[kind];s.batch=1;
  if(payload.settings.increment&&String(s.seed)===String(payload.settings.seed))s.seed=((BigInt(s.seed)+BigInt(payload.count))%(2n**64n)).toString();
  persist();Native.watchBatch(accepted.batch);toast('Added '+payload.count+' to the PC queue');if(page===kind){const seed=$('[data-setting="seed"]');if(seed)seed.value=s.seed;}await poll();
 }catch(e){if(/^HTTP (400|401|403|413)/.test(e.message)){delete state.pendingByKind[kind];persist();}if($('#genError'))$('#genError').textContent=e.message;toast(e.message);}
 finally{submitting=false;if($('#play'))$('#play').disabled=false;}
}
async function poll(){
 if(!connected||pollBusy||document.hidden)return;const id=epoch,view=page;pollBusy=true;
 const current=()=>id===epoch&&connected&&page===view;
 try{
  if(view==='bridge'){const m=await api('metrics');if(current())showMetrics(m);}
  else{const status=view==='library'?null:await api('status');const latest=await api('library');if(!current())return;
   if(status){jobs=status.jobs;active=status.active;previewAvailable=status.preview;}
   if(signature(latest)!==inventory&&(!shelfError||Date.now()>=nextSync))syncShelf(true);
   if(view!=='library'&&$('#play'))updateProgress();
  }
  if(current())pollNote='';
 }catch(e){if(current())pollNote=(view==='bridge'?'PC telemetry unavailable: ':'Generation or library status unavailable: ')+e.message;}
 finally{pollBusy=false;notice();}
}
function showMetrics(m){const gb=v=>(v/1073741824).toFixed(1);let vals=[[m.cpu==null?'—':m.cpu.toFixed(0)+'%',m.cpuWatts==null?'Power unavailable':m.cpuWatts.toFixed(1)+' W',m.cpu],[m.gpu==null?'—':m.gpu.toFixed(0)+'%',m.gpuWatts==null?'HWiNFO unavailable':m.gpuWatts.toFixed(0)+' W',m.gpu],[gb(m.ramUsed)+' GB','of '+gb(m.ramTotal)+' GB',m.ramUsed/m.ramTotal*100],[m.vramUsed==null?'—':gb(m.vramUsed)+' GB','of '+gb(m.vramTotal)+' GB',m.vramUsed/m.vramTotal*100],[gb(m.commitUsed)+' GB','of '+gb(m.commitTotal)+' GB committed',m.commitUsed/m.commitTotal*100]];vals.forEach((v,i)=>{if($('#m'+i)){$('#m'+i).textContent=v[0];$('#ms'+i).textContent=v[1];$('#mb'+i).style.width=Math.max(0,Math.min(100,v[2]||0))+'%';}});}
function updateProgress(){if(!$('#play'))return;const me=info().device,pendingJobs=jobs.filter(j=>['pending','running','submitting','cancelling'].includes(j.status)).sort((a,b)=>a.created-b.created||a.ordinal-b.ordinal);
 const same=pendingJobs.filter(j=>j.kind===page),j=same.find(j=>j.id===active)||same[0],mine=same.find(j=>j.owner===me);
 $('#play').textContent=pendingJobs.length?'▶ Add to queue':'▶ Generate';$('#play').disabled=submitting;$('#batchButton').disabled=submitting;$('#stopBatch').hidden=!mine;$('#stopBatch').onclick=()=>mine&&stopBatch(mine.batch);
 $('#runSpinner').hidden=!j;$('#progressRow').hidden=!j;
 const list=$('#queueList'),batches=[...new Set(pendingJobs.map(j=>j.batch))];
 list.innerHTML=batches.length?'<section class="card"><strong>PC queue · '+pendingJobs.length+' remaining</strong>'+batches.map(batch=>{const x=pendingJobs.find(j=>j.batch===batch),own=x.owner===me;return '<div class="row spread"><small>'+esc(x.kind)+' · '+(own?'This phone':'Other phone')+' · '+x.ordinal+'/'+x.total+' · '+esc(x.status)+'</small>'+(own?'<button data-stop="'+x.batch+'">Cancel batch</button>':'')+'</div>';}).join('')+'</section>':'';
 $$('[data-stop]',list).forEach(b=>b.onclick=()=>stopBatch(b.dataset.stop));
 if(j){const pct=Math.min(j.status==='complete'?100:99,Math.round(j.progress*100));$('#progressFill').style.width=pct+'%';$('#progressText').textContent=j.ordinal+'/'+j.total+' · '+(j.id===active?pct+'%':'Queued');$('#jobMessage').textContent=j.current_node||(j.id===active?'Preparing workflow':'Waiting in PC queue');$('#livePreview').hidden=!previewAvailable||j.id!==active;if(previewAvailable&&j.id===active)$('#livePreview').src='/preview?t='+Date.now();$('#batchLabel').textContent=j.total>1?j.total+' in batch':'Single generation';}
 else{const last=jobs.find(j=>j.kind===page);$('#jobMessage').textContent=last?.status==='complete'?'Generation complete':last?.status==='error'?'Generation failed — details below':'';if(last?.status==='error')$('#genError').innerHTML='<div class="errorbox">'+esc(last.error)+'</div>';}
 renderCarousel();
}
function renderResults(){const items=library.filter(x=>x.kind===page&&!x.archived),j=items[0],box=$('#result');if(!box)return;
 if(j){box.innerHTML='<button id="latestOpen" class="mediaPoster"><img alt="Latest result" src="'+media(j.id,j.kind==='video'||!j.local)+'">'+(j.kind==='video'?'<span>▶ Play video</span>':'')+'</button>';$('#latestOpen').onclick=()=>openMedia(j);}
 else box.innerHTML='<div><p>✧</p><small>Your next idea will appear here.</small></div>';renderCarousel();
}
function renderCarousel(){if(!$('#carousel'))return;let items=library.filter(x=>x.kind===page&&!x.archived).slice(0,20);let running=jobs.some(j=>j.kind===page&&['running','pending','submitting'].includes(j.status));$('#carousel').innerHTML=(running?'<div class="thumb">'+(previewAvailable?'<img src="/preview?t='+Date.now()+'" alt="Generating">':'')+'<i class="spinner"></i></div>':'')+items.map(x=>`<button class="thumb" data-media="${x.id}"><img src="${media(x.id,true)}" alt="Generated ${x.kind}">${x.kind==='video'?'<span>▶ '+duration(x.duration)+'</span>':''}</button>`).join('');wireMedia($('#carousel'));}
function duration(n){return Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');}
const warningText={changed:'The PC file changed. Your original phone copy is protected.',missing:'The PC file was deleted. Your phone copy is still here.',older:'Outside the newest 100. You can keep this copy, save it to the camera roll, or remove it from the app.'};
function renderLibrary(){const items=library.filter(x=>!!x.archived===archived), review=library.filter(x=>x.warning),recent=library.filter(x=>x.recent&&x.source==='available');$('#main').innerHTML=`<button id="archiveLink" class="textbutton">${archived?'‹ Library':'Archive ›'}</button><div class="sectionline"><div><p class="eyebrow">YOUR PRIVATE COLLECTION</p><h1>${archived?'Archive':'Library'}</h1></div><small>${items.length} items</small></div>
 <section class="card"><strong>${recent.filter(j=>j.local).length} / ${recent.length} recent items on phone</strong><p>Newest 100 images and videos combined. ${connected?'Checks the PC every 5 minutes while open.':'Offline · saved items still open.'}</p>${shelfError?'<p class="warning">'+esc(shelfError)+'</p>':''}<button id="checkShelf" ${connected?'':'disabled'}>Check now</button></section>
 ${review.length?'<section class="card"><h2>Phone copies to review</h2>'+review.map(j=>'<button class="reviewItem" data-media="'+j.id+'">'+esc(j.kind)+' · '+esc(new Date(j.created*1000).toLocaleString())+'<small>'+esc(warningText[j.warning])+'</small></button>').join('')+'</section>':''}
 <div class="librarygrid">${items.map(j=>`<button class="libraryitem" data-media="${j.id}">${media(j.id,true)?'<img src="'+media(j.id,true)+'" loading="lazy" alt="'+esc(j.kind)+'">':'<span>On PC</span>'}${j.kind==='video'?'<span class="videoBadge">▶ '+duration(j.duration)+'</span>':''}<small class="copyBadge">${j.warning?'Review':j.local?'On phone':'PC only'}</small></button>`).join('')}</div>${items.length?'':'<p>No items here yet.</p>'}`;
 $('#archiveLink').onclick=()=>{archived=!archived;renderLibrary();};$('#checkShelf').onclick=()=>syncShelf(true);wireMedia($('#main'));}
function wireMedia(root){$$('[data-media]',root).forEach(b=>b.onclick=()=>openMedia(library.find(i=>i.id===b.dataset.media),!b.classList.contains('reviewItem')));}
async function openMedia(item,autoPlay=true){if(!item)return;const id=item.id;
 openModal(item.kind==='video'?'Video · '+duration(item.duration):'Image','<section class="card" id="mediaDetails"><p id="transfer">Preparing phone copy…</p></section>');
 const body=$('#mediaDetails'),current=()=>$('#modal').open&&$('#mediaDetails')===body;
 try{
  if(!item.local){if(!connected)throw new Error('This item is only on the PC. Connect to download it.');$('#transfer').textContent='Downloading the complete '+item.kind+' ('+((item.size||0)/1048576).toFixed(1)+' MB)…';item=await local('fetch',{id});updateItem(item);}
  if(!current())return;
  const msg=item.warning?warningText[item.warning]:'';
  body.innerHTML=(msg?'<p class="warning">'+esc(msg)+'</p>':'')+(item.kind==='video'?'<button class="mediaPoster" id="playLocal"><img src="'+media(id,true)+'"><span>▶ Play phone copy</span></button>':'<img class="fullmedia" src="'+media(id)+'">')+
  '<div class="mediaActions"><button id="saveMedia">Save to camera roll</button><button id="archiveMedia" '+(!connected||item.source==='missing'?'disabled':'')+'>'+(item.archived?'Unarchive':'Archive')+'</button>'+
  (item.warning==='changed'?'<button id="resolveMedia" '+(!connected?'disabled':'')+'>Replace with PC version…</button>':item.warning?'<button id="resolveMedia">Remove phone copy…</button>':'')+'</div><p id="mediaMessage" role="status"></p>';
  const message=t=>{if(current())$('#mediaMessage').textContent=t;};
  $('#saveMedia').onclick=async e=>{e.target.disabled=true;try{await local('export',{id});message('Saved to DCIM/ComfyBridge in your camera roll.');}catch(err){message(err.message);}finally{e.target.disabled=false;}};
  $('#archiveMedia').onclick=async()=>{try{await api('archive',{id,archived:!item.archived});closeModal();await syncShelf(true);}catch(e){message(e.message);}};
  if($('#resolveMedia'))$('#resolveMedia').onclick=()=>{message('Save to the camera roll first if you want a permanent copy. Only this app’s private copy will be removed.');const b=$('#resolveMedia');b.textContent=item.warning==='changed'?'Confirm replacement':'Confirm removal';b.onclick=async()=>{b.disabled=true;try{const j=await local(item.warning==='changed'?'replace':'drop',{id,local:item.local,sha256:item.sha256});updateItem(j);closeModal();}catch(e){message(e.message);b.disabled=false;}};};
  if(item.kind==='video'){$('#playLocal').onclick=()=>local('play',{id}).catch(e=>message(e.message));if(autoPlay&&(!msg||item.warning==='older'))await local('play',{id});}
 }catch(e){if(current()){body.textContent=e.message;const retry=document.createElement('button');retry.textContent='Try again';retry.onclick=()=>openMedia(library.find(x=>x.id===id)||item);body.appendChild(retry);}}
}
init().catch(e=>{$('#main').innerHTML='<div class="errorbox">Phone storage could not be opened: '+esc(e.message)+'</div>';});
