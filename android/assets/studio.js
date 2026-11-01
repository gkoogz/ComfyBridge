'use strict';
const sections=['image','video','prompts'];
let settingsBusy=false,settingsTimer,nextSettings=0,settingsAgain=false,clockEpoch=-1;
function markEdited(section){
 if(!sections.includes(section))return;
 state.sharedClock??={};
 state.sharedClock[section]={stamp:Math.max(Date.now()+(state.pcSkew||0),(state.sharedClock[section]?.stamp||0)+1),device:info().device};
 clearTimeout(settingsTimer);settingsTimer=setTimeout(syncSettings,1800);
}
function sectionData(key){
 return key==='prompts'?state.prompts:{settings:state.settings[key],inputs:state.inputs[key],presets:state.presets[key]};
}
async function encodeShared(value,session=epoch){
 return mapState(value,async x=>{
  if(typeof x!=='string'||!x.startsWith('data:image/'))return x;
  let hash=knownInputs.get(x);
  if(!hash){
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));
   hash=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
   if(session!==epoch)throw Error('PC connection changed');
   if(!(await api('profile-has/'+hash)).exists){
    if(session!==epoch)throw Error('PC connection changed');
    await api('profile-blob/'+hash,{value:x});
   }
   if(session!==epoch)throw Error('PC connection changed');
   if(knownInputs.size>=8)knownInputs.clear();knownInputs.set(x,hash);
  }
  return {bridgeInput:hash};
 });
}
const decodeShared=value=>mapState(value,async x=>x&&typeof x==='object'&&typeof x.bridgeInput==='string'?(await api('profile-blob/'+x.bridgeInput)).value:x);
async function syncSettings(){
 if(!connected||!profileReady||document.hidden)return;
 if(settingsBusy){settingsAgain=true;return;}
 settingsBusy=true;nextSettings=Date.now()+600000;
 const session=epoch,updates={};
 try{
  if(clockEpoch!==session){
   const before=Date.now(),pc=await api('studio/time');
   if(session!==epoch)return;
   const skew=Math.round(pc-(before+Date.now())/2),delta=skew-(state.pcSkew||0);
   for(const key of sections){
    const clock=state.sharedClock?.[key];
    if(clock?.device===info().device&&state.sharedAck?.[key]!==clock.stamp)clock.stamp+=delta;
   }
   state.pcSkew=skew;clockEpoch=session;
  }
  const clocks=structuredClone(state.sharedClock||{});
  for(const key of sections){
   if(key!=='prompts'&&!state.settings[key])continue;
   const clock=clocks[key];
   if(!clock||clock.device===info().device&&state.sharedAck?.[key]!==clock.stamp){
    updates[key]={stamp:clock?.stamp||1,value:await encodeShared(structuredClone(sectionData(key)))};
   }
  }
  if(session!==epoch)return;
  const remote=await api('studio/settings',updates);
  let redraw=false;
  for(const key of sections){
   const incoming=remote[key],local=state.sharedClock?.[key];
   if(!incoming||session!==epoch||(local?.stamp||0)!==(clocks[key]?.stamp||0))continue;
   if(local&&local.stamp===incoming.stamp&&local.device===incoming.device){
    (state.sharedAck??={})[key]=incoming.stamp;continue;
   }
   const data=await decodeShared(incoming.value);
   if(session!==epoch||(state.sharedClock?.[key]?.stamp||0)!==(clocks[key]?.stamp||0))continue;
   if(key==='prompts')state.prompts=data;
   else{state.settings[key]=data.settings;state.inputs[key]=data.inputs;state.presets[key]=data.presets;}
   (state.sharedClock??={})[key]={stamp:incoming.stamp,device:incoming.device};
   (state.sharedAck??={})[key]=incoming.stamp;redraw||=(page===key||key==='prompts')&&['image','video'].includes(page);
  }
  persist(null);
  if(redraw&&!$('#modal').open)renderGenerator();
 }catch(e){nextSettings=Date.now()+30000;profileMessage('Sync pending · '+e.message);}
 finally{settingsBusy=false;if(settingsAgain){settingsAgain=false;clearTimeout(settingsTimer);settingsTimer=setTimeout(syncSettings,200);}}
}

let queueHistory=[],historyOffset=0,historyFailure='';
const liveStatus=s=>['running','pending','cancelling','submitting'].includes(s);
function clockText(seconds){
 seconds=Math.max(0,Math.floor(seconds));
 const min=Math.floor(seconds/60),sec=String(seconds%60).padStart(2,'0');
 return min>=60?Math.floor(min/60)+':'+String(min%60).padStart(2,'0')+':'+sec:min+':'+sec;
}
function elapsed(job){
 if(!job?.started)return liveStatus(job?.status)?'':'Time unavailable';
 const end=job.ended||(liveStatus(job.status)?(Date.now()/1000+historyOffset):null);
 return end===null?'Time unavailable':(job.observed===2?'≈ ':job.observed?'≥ ':'')+clockText(end-job.started);
}
function updateTimers(){
 $$('.jobElapsed').forEach(el=>{const j=queueHistory.find(row=>row.id===el.dataset.clock);el.textContent=elapsed(j);});
 const span=$('#activeTimer');if(span)span.textContent=elapsed(queueHistory.find(j=>j.id===active));
}
setInterval(()=>{if(!document.hidden&&$('#queueList'))updateTimers();},1000);
function renderQueue(){
 const box=$('#queueList');if(!box)return;
 const items=queueHistory.length?queueHistory:jobs.filter(j=>liveStatus(j.status));
 const key=JSON.stringify(items.map(j=>[j.id,j.status,j.media,media(j.media,true),j.ended]));
 if(box.dataset.version===key&&box.dataset.failure===historyFailure){updateTimers();return;}
 const scroll=$('.queueRows',box)?.scrollTop||0;
 box.dataset.version=key;box.dataset.failure=historyFailure;
 box.innerHTML='<section class="card historyCard"><div class="row spread"><strong>PC Queue</strong><small>Last 24 hours</small></div>'+
 (historyFailure?'<small role="status">'+esc(historyFailure)+'</small>':'')+'<div class="queueRows">'+items.map(j=>{
  const active=liveStatus(j.status),label={complete:'Success',cancelled:'Aborted',error:'Fail'}[j.status]||j.status;
  const cover=j.media&&media(j.media,true);
  return '<div class="queueJob">'+(j.media?'<button class="jobThumb" data-output="'+j.media+'" aria-label="Open result in Library">'+(cover?'<img src="'+cover+'" loading="lazy" alt="">':'▦')+'</button>':'<span class="jobThumb">'+(j.kind==='video'?'▷':'▧')+'</span>')+
   '<div class="jobInfo"><b>'+esc(j.kind)+' <small>'+new Date(j.created*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</small></b><small>'+esc(active?j.status:'Finished')+' <span class="jobElapsed" data-clock="'+j.id+'"></span></small></div>'+
   (active&&j.owner===info().device?'<button data-cancel="'+j.batch+'">Cancel batch</button>':'<small class="outcome '+esc(j.status)+'">'+esc(label)+'</small>')+
   '<button class="jobRecall" data-replay="'+j.id+'" aria-label="Load this generation in the editor">↗</button></div>';
 }).join('')+(items.length?'':'<small>No generations in the last 24 hours.</small>')+'</div></section>';
 installFold($('.historyCard',box));
 $('.queueRows',box).scrollTop=scroll;
 $$('[data-cancel]',box).forEach(b=>b.onclick=()=>stopBatch(b.dataset.cancel));
 $$('[data-output]',box).forEach(b=>b.onclick=async()=>{
  if(!library.find(j=>j.id===b.dataset.output))await syncShelf(true);
  const item=library.find(j=>j.id===b.dataset.output);
  if(!item)return toast('The output is no longer available.');
  navigate('library');archived=!!item.archived;renderLibrary();
  const tile=$('.libraryitem[data-media="'+item.id+'"]');
  if(tile){tile.scrollIntoView({block:'center'});tile.click();}else openMedia(item);
 });
 $$('[data-replay]',box).forEach(b=>b.onclick=async()=>{
  b.disabled=true;const origin=page,session=epoch;
  try{
   const {kind,settings,inputs}=await api('studio/replay/'+b.dataset.replay);
   if(inputs.data){const img=await loadImg(inputs.data);inputs.width=img.naturalWidth;inputs.height=img.naturalHeight;}
   if(inputs.mask){
    const mask=await loadImg(inputs.mask),canvas=document.createElement('canvas');
    canvas.width=mask.naturalWidth;canvas.height=mask.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(mask,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<pixels.data.length;i+=4){pixels.data[i+3]=pixels.data[i];pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;}
    ctx.putImageData(pixels,0,0);inputs.mask=canvas.toDataURL('image/png');
   }
   if(page!==origin||session!==epoch)return;
   settings.batch=1;
   if(state.pendingByKind)delete state.pendingByKind[kind];
   if(state.pendingRequest?.kind===kind)delete state.pendingRequest;
   state.settings[kind]=settings;state.inputs[kind]=inputs;persist(kind);navigate(kind);
   toast('Generation settings loaded');
  }catch(e){toast(e.message);}finally{b.disabled=false;}
 });
 updateTimers();
}
async function refreshHistory(){
 try{const h=await api('studio/history');queueHistory=h.jobs;historyOffset=h.now-Date.now()/1000;historyFailure='';}
 catch(e){historyFailure='Queue history unavailable · '+e.message;}
}
