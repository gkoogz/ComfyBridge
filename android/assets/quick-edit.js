'use strict';
let quickSlots={},quickStoreKey='',quickLoading=null,quickPolling=false;
const quickSlot=(kind,key)=>kind+':'+key;
function quickStore(){
 if(!db||!quickStoreKey)return;
 const tx=db.transaction('data','readwrite');tx.objectStore('data').put(quickSlots,quickStoreKey);
 tx.onerror=()=>toast('Could not save the quick edit on this device.');
}
async function loadQuickEdits(){
 const key='quick-edit:'+(info().fingerprint||info().address||'local');
 if(key===quickStoreKey){if(quickLoading)await quickLoading;return;}
 quickStoreKey=key;quickSlots={};
 quickLoading=new Promise(resolve=>{
  const request=db.transaction('data').objectStore('data').get(key);
  request.onsuccess=()=>{if(quickStoreKey===key){quickSlots=request.result||{};for(const q of Object.values(quickSlots)){delete q.sending;if(q.phase==='proposed')q.restored=true;}}resolve();};request.onerror=()=>resolve();
 });
 await quickLoading;quickLoading=null;
}
function quickClock(seconds){seconds=Math.max(0,Math.floor(seconds));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
function paintQuickTimers(){
 $$('[data-quick-clock]').forEach(el=>{const q=quickSlots[el.dataset.quickClock];if(q)el.textContent=quickClock(q.elapsedBase!=null?q.elapsedBase+(Date.now()-q.receivedAt)/1000:(Date.now()-q.started)/1000);});
}
function rejectUnchangedQuick(q){
 const original=String(q?.original||''),result=String(q?.result||'');
 const words=text=>(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]).join(' ');
 const formatting=/punctuat|comma|period|exclamation|question.mark|semicolon|colon|dash|parenthes|bracket|indent|bold|italic|capitaliz|capitalis|lowercase|uppercase|letter case|hyphen|apostroph|quot|format|spac|line.break|newline|markdown/i.test(q?.text||'');
 if(q?.phase==='proposed' && (result.trim().replace(/\s+/g,' ')===original.trim().replace(/\s+/g,' ')||(!formatting&&words(result)===words(original)))){
  q.phase='error';q.result='';q.detail='The model returned unchanged or formatting-only text without applying an edit. Nothing was changed. Review your instructions and retry.';quickStore();
 }
}
function paintQuickEdit(kind,key){
 if(page!==kind)return;
 const host=$('[data-quick-panel="'+key+'"]'),actions=$('[data-quick-actions="'+key+'"]'),chatButton=$('[data-chat-prompt="'+key+'"]');
 if(!host||!actions)return;
 const slot=quickSlot(kind,key),q=quickSlots[slot];
 rejectUnchangedQuick(q);
 chatButton.hidden=!!q;
 const version=JSON.stringify([q?.phase,q?.id,q?.result,q?.detail,q?.warning,q?.restored,q?.finishedAt]);
 if(host.dataset.version===version){paintQuickTimers();return;}
 host.dataset.version=version;
 const button=(action,label)=>'<button type="button" class="quickButton" data-quick-action="'+action+'">'+label+'</button>';
 if(!q){actions.innerHTML=button('open','Quick edit');host.innerHTML='';}
 else if(q.phase==='editing'){
  actions.innerHTML=button('submit','Submit Quick edit')+button('discard','Cancel quick edit');
  host.innerHTML='<textarea class="quickInstructions" rows="5" aria-label="Quick edit instructions for '+key+' prompt" placeholder="Describe the changes you want…" maxlength="8000">'+esc(q.text)+'</textarea>';
  const field=$('textarea',host);field.oninput=()=>{q.text=field.value;field.style.height='118px';field.style.height=Math.max(118,field.scrollHeight+2)+'px';quickStore();};
 }else if(q.phase==='working'){
  actions.innerHTML='<span class="quickThinking" role="status"><i class="spinner"></i><span>Quick edit · <time data-quick-clock="'+slot+'"></time></span></span>';
  host.innerHTML='<div class="quickSubmitted" tabindex="0">'+esc(q.text)+'</div><small class="quickDetail" role="status">'+esc(q.detail||'Preparing quick edit…')+'</small>';
 }else if(q.phase==='proposed'){
  actions.innerHTML=button('retry','Edit instructions');
  const when=q.finishedAt||(q.started&&q.elapsedBase!=null?q.started+q.elapsedBase*1000:null);
  const date=when?new Date(when).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'time unavailable';
  host.innerHTML='<small class="quickProvenance">'+(q.restored?'Saved proposal':'Completed')+' · '+esc(date)+(q.restored?' · restored from this device':'')+'</small><div class="row spread quickProposalHeading" ><strong>Proposed edit</strong><div class="row">'+button('use','Use edited prompt ↗')+button('discard','Discard ×')+'</div></div><div class="quickProposed" tabindex="0">'+esc(q.result)+'</div>';
  if(state.settings[kind][key]!==q.original)host.insertAdjacentHTML('beforeend','<small>The prompt above changed while this edit was being prepared. Use edited prompt will replace it.</small>');
 }else{
  actions.innerHTML=button('retry','Retry quick edit')+button('discard','Discard ×');
  host.innerHTML='<div class="quickSubmitted" tabindex="0">'+esc(q.text)+'</div><small class="danger" role="alert">'+esc(q.detail||'Quick edit failed. Your original prompt is unchanged.')+'</small>';
 }
 for(const b of [...$$('[data-quick-action]',actions),...$$('[data-quick-action]',host)])b.onclick=()=>quickAction(kind,key,b.dataset.quickAction);
 paintQuickTimers();
}
async function quickAction(kind,key,action){
 const slot=quickSlot(kind,key),q=quickSlots[slot];
 rejectUnchangedQuick(q);
 if(action==='open')quickSlots[slot]={phase:'editing',text:''};
 else if(action==='submit'){
  if(!connected)return toast('Connect to the PC to use Quick edit.');
  if(!q?.text.trim())return toast('Describe how you want to change the prompt.');
  Object.assign(q,{phase:'working',id:crypto.randomUUID(),original:state.settings[kind][key]||'',source:kind+' '+key,started:Date.now(),detail:'Submitting quick edit…',accepted:false});
  quickStore();paintQuickEdit(kind,key);await sendQuick(q,kind,key);return;
 }else if(action==='use'&&q?.phase==='proposed'){
  state.settings[kind][key]=q.result;delete state.settings[kind].replayOf;persist(kind);
  const field=$('textarea.promptEntry[data-setting="'+key+'"]');
  if(page===kind&&field){field.value=q.result;sizePrompt(field,true);field.classList.remove('quickApplied');void field.offsetWidth;field.classList.add('quickApplied');setTimeout(()=>field.classList.remove('quickApplied'),1300);}
  discardQuick(q);delete quickSlots[slot];
 }else if(action==='discard'){
  if(q?.id)discardQuick(q);delete quickSlots[slot];
 }else if(action==='retry'){
  discardQuick(q);quickSlots[slot]={phase:'editing',text:q.text};
 }
 quickStore();paintQuickEdit(kind,key);
 if(action==='open'||action==='retry')$('[data-quick-panel="'+key+'"] textarea')?.focus();
}
function discardQuick(q){if(q?.id&&connected)api('studio/chat/quick-discard',{id:q.id}).catch(()=>{});}
function receiveQuick(q,data){
 const mismatch=data.id!==q.id||['source','prompt','instructions'].some(key=>key in data&&data[key]!==({source:q.source,prompt:q.original,instructions:q.text}[key]));
 if(mismatch){q.phase='error';q.detail='The PC returned a response for a different edit. Your prompt is unchanged; retry to create a new request.';return;}
 q.accepted=true;q.detail=data.detail||({queued:'Waiting for the local model…',waiting:'Waiting for the GPU…',loading:'Loading the local model…',responding:'Editing your prompt…'}[data.status]||'');
 q.elapsedBase=data.elapsedSeconds||0;q.receivedAt=Date.now();
 if(data.status==='complete'){q.phase='proposed';q.result=data.result;q.finishedAt=data.finished?data.finished*1000:Date.now();q.restored=false;rejectUnchangedQuick(q);}
 else if(['error','missing','discarded'].includes(data.status)){q.phase='error';q.detail=data.detail||'This edit is no longer available. Retry to submit it again.';}
}
async function sendQuick(q,kind,key){
 if(q.sending)return;q.sending=true;const scope=quickStoreKey;
 try{
  const data=await api('studio/chat/quick-submit',{id:q.id,source:q.source,prompt:q.original,instructions:q.text});
  if(scope!==quickStoreKey||quickSlots[quickSlot(kind,key)]!==q)return;receiveQuick(q,data);
 }catch(e){if(scope===quickStoreKey){q.detail=e.message;if(/HTTP 4\d\d/.test(e.message))q.phase='error';}}
 finally{delete q.sending;if(scope===quickStoreKey){quickStore();paintQuickEdit(kind,key);}}
}
async function syncQuickEdits(){
 if(!connected||document.hidden||quickPolling||!db)return;quickPolling=true;
 try{
  await loadQuickEdits();const scope=quickStoreKey;
  for(const [slot,q] of Object.entries(quickSlots)){
   if(q.phase!=='working'||q.sending)continue;
   const [kind,key]=slot.split(':');
   try{
    const data=await api('studio/chat/quick-state',{id:q.id});
    if(scope!==quickStoreKey)return;
    if(quickSlots[slot]!==q)continue;
    if(data.status==='missing'&&!q.accepted)await sendQuick(q,kind,key);else receiveQuick(q,data);
   }catch(e){if(scope===quickStoreKey)q.detail=e.message;}
   if(scope===quickStoreKey){quickStore();paintQuickEdit(kind,key);}
  }
 }finally{quickPolling=false;}
}
function bindQuickEdits(){
 const kind=page;
 loadQuickEdits().then(()=>{for(const key of ['positive','negative'])paintQuickEdit(kind,key);}).catch(e=>toast(e.message));
 const random=$('#randomSeed');if(random)random.onclick=()=>{
  const bits=crypto.getRandomValues(new Uint32Array(2));let seed=((BigInt(bits[0])<<32n)|BigInt(bits[1])).toString();
  if(seed===String(state.settings[kind].seed))seed=((BigInt(seed)+1n)%(2n**64n)).toString();
  state.settings[kind].seed=seed;delete state.settings[kind].replayOf;
  $('[data-setting="seed"]').value=seed;persist(kind);
 };
}
setInterval(()=>{if(!document.hidden)paintQuickTimers();},250);
setInterval(()=>syncQuickEdits(),1000);
