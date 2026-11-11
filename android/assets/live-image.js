'use strict';

// Keep a decoded generation preview visible until its finished media is ready.
let imagePreviewProtocol=false, liveSelection=null, frameStream=null, lastCaptured=null;
const frames=new Map();
const liveJob=id=>jobs.find(j=>j.id===id);
const currentGeneration=(kind=page)=>{const j=liveJob(active);return j?.kind===kind&&liveStatus(j.status)?j:null;};
const nextGeneration=(kind=page)=>currentGeneration(kind)||jobs.filter(j=>j.kind===kind&&liveStatus(j.status))
 .sort((a,b)=>a.queuePosition-b.queuePosition||a.created-b.created)[0];
function stopFrames(){
 if(frameStream)frameStream.controller.abort();
 frameStream=null;
}
function pruneFrames(){
 for(const [id,frame] of frames)if(id!==active&&id!==liveSelection?.id&&id!==lastCaptured){
  URL.revokeObjectURL(frame.url);frames.delete(id);
 }
}
function leaveLivePreview(){
 liveSelection=null;lastCaptured=null;stopFrames();
 for(const frame of frames.values())URL.revokeObjectURL(frame.url);
 frames.clear();
}
function selectLiveGeneration(id){
 liveSelection={id,kind:liveJob(id)?.kind||queueHistory.find(j=>j.id===id)?.kind||page,skip:false,busy:false,error:''};
 renderResults();
}
function paintFrame(id){
 const frame=frames.get(id);if(!frame)return;
 for(const el of $$('[data-frame-job]')){
  if(el.dataset.frameJob===id&&el.src!==frame.url){el.src=frame.url;el.hidden=false;}
 }
 if(id===liveSelection?.id&&liveJob(id)?.status==='running'&&!liveSelection.skip&&!liveSelection.busy&&!liveSelection.error){
  const caption=$('.watchCaption');if(caption)caption.textContent='Live preview';
 }
}
function bindFrame(el,id){
 if(el.dataset.frameJob!==id){
  el.removeAttribute('src');el.hidden=true;
  if(id)el.dataset.frameJob=id;else delete el.dataset.frameJob;
 }
 if(id)paintFrame(id);
}
const showsQueue=()=>window.Desktop||['bridge','image','video'].includes(page);
async function watchFrames(){
 const job=liveJob(active);
 if(!showsQueue()||!connected||document.hidden||!imagePreviewProtocol||job?.status!=='running'){
  stopFrames();return;
 }
 if(frameStream?.id===job.id)return;
 stopFrames();
 const stream={id:job.id,controller:new AbortController()};frameStream=stream;
 try{
  while(frameStream===stream&&connected&&showsQueue()&&!document.hidden){
   const after=frames.get(job.id)?.revision??-1;
   const response=await fetch('/preview/'+job.id+'?after='+after,{signal:stream.controller.signal,cache:'no-store'});
   if(frameStream!==stream)break;
   if(response.status===204)continue;
   if(!response.ok)break;
   const rev=response.headers.get('X-Preview-Revision');
   if(rev===null)break;
   const url=URL.createObjectURL(await response.blob()),img=new Image();img.src=url;
   try{await img.decode();}catch{URL.revokeObjectURL(url);break;}
   if(frameStream!==stream||active!==job.id||!showsQueue()){URL.revokeObjectURL(url);break;}
   const old=frames.get(job.id);
   frames.set(job.id,{revision:Number(rev),url});lastCaptured=job.id;paintFrame(job.id);pruneFrames();
   if(old)URL.revokeObjectURL(old.url);
  }
 }catch{/* A subsequent foreground status poll reconnects the stream. */}
 finally{if(frameStream===stream)frameStream=null;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopFrames();else watchFrames();});

function renderLiveGeneration(box){
 const view=liveSelection;if(!box||!view||!['image','video'].includes(page))return false;
 const job=liveJob(view.id),history=queueHistory.find(j=>j.id===view.id);
 const kind=view.kind||job?.kind||history?.kind||page;if(kind!==page)return false;
 const status=job?.status||history?.status;
 const output=library.find(j=>j.job===view.id&&j.kind===kind);
 if(status==='cancelled'&&nextGeneration(kind)&&nextGeneration(kind).id!==view.id){
  selectLiveGeneration(nextGeneration(kind).id);return true;
 }
 if(box.dataset.live!==view.id||!$('.watchGeneration',box)){
  box.dataset.live=view.id;
  box.innerHTML='<div class="asset watchGeneration"><img class="watchPixels" alt="Live '+kind+' preview" hidden><span class="previewBusy" role="status" aria-label="Generation in progress"><i class="spinner" aria-hidden="true"></i></span><small class="watchCaption" role="status"></small><button class="skipImage" hidden>Skip '+kind+'</button><button class="retryImage" hidden>Retry download</button></div>';
  $('.watchPixels',box).dataset.frameJob=view.id;
  $('.skipImage',box).onclick=()=>skipLiveGeneration(view);
  $('.retryImage',box).onclick=()=>{view.error='';renderLiveGeneration(box);};
 }
 const skip=$('.skipImage',box),retry=$('.retryImage',box);
 skip.hidden=!(connected&&(window.Desktop||job?.owner===info().device)&&job?.id===active&&job.status==='running'&&imagePreviewProtocol);
 skip.disabled=view.skip;skip.textContent=view.skip?'Skipping…':'Skip '+kind;
 retry.hidden=!view.error||!output||!connected;
 const label=view.error||(output||status==='complete'?'Downloading original…':
  status==='cancelled'?'Generation skipped':status==='error'?'Generation failed':
  view.skip||status==='cancelling'?'Skipping '+kind+'…':frames.has(view.id)?'Live preview':
  view.id===active?'Waiting for the first preview…':'Queued for generation');
 $('.watchCaption',box).textContent=label;
 $('.previewBusy',box).hidden=!!view.error||status==='cancelled'||status==='error';
 paintFrame(view.id);
 const pixels=$('.watchPixels',box);
 if(!imagePreviewProtocol&&view.id===active&&previewAvailable){pixels.src='/preview?t='+Date.now();pixels.hidden=false;}
 if(output&&!frames.has(view.id)&&!pixels.hasAttribute('src')){
  const cover=media(output.id,true);if(cover){pixels.src=cover;pixels.hidden=false;}
 }
 if(output&&!view.busy&&!view.error&&(output.local||connected))finishLiveGeneration(view,output);
 return true;
}
async function finishLiveGeneration(view,item){
 view.busy=true;const session=epoch;
 try{
  if(!item.local){
   item=await fetchOriginal(item.id);
   if(session!==epoch)return;
   updateItem(item);
  }
  let img,poster;
  if(item.kind==='image'){
   img=new Image();img.className='original';img.alt='Generated image';img.src=media(item.id);await img.decode();
  }else{
   poster=media(item.id,true);const cover=new Image();cover.src=poster;
   try{await cover.decode();}catch{
    const frame=frames.get(view.id);
    if(frame){const fallback=new Image();fallback.src=frame.url;await fallback.decode();
     const canvas=document.createElement('canvas');canvas.width=fallback.naturalWidth;canvas.height=fallback.naturalHeight;
     canvas.getContext('2d').drawImage(fallback,0,0);poster=canvas.toDataURL('image/jpeg',.85);
    }
   }
  }
  if(liveSelection!==view||page!==item.kind||session!==epoch)return;
  const box=$('#result');if(!box)return;
  if(item.kind==='image'){
   const host=document.createElement('div');host.className='asset';host.dataset.id=item.id;host.dataset.hash=item.local;
   host.append(img);const actions=document.createElement('div');actions.className='resultActions';actions.append(makeVideoButton(item),ratingButtons(item));box.replaceChildren(host,actions);refreshRatings();
  }else mountResult(item,poster);
  delete box.dataset.live;
  box.dataset.latest=library.find(j=>j.kind===item.kind&&!j.archived)?.id||item.id;
  if(lastCaptured===item.job)lastCaptured=null;
  liveSelection=null;pruneFrames();renderCarousel();
 }catch(e){view.error='Could not load the original: '+e.message;}
 finally{view.busy=false;if(liveSelection===view&&view.error&&$('#result'))renderLiveGeneration($('#result'));}
}
async function skipLiveGeneration(view){
 if(view.skip||view!==liveSelection)return;
 view.skip=true;renderLiveGeneration($('#result'));
 try{await api('skip',{id:view.id});}
 catch(e){view.skip=false;toast(e.message);}
 await poll();
 if(liveSelection===view&&$('#result'))renderLiveGeneration($('#result'));
}
