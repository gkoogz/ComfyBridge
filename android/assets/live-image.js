'use strict';

// Keep a decoded preview on the phone until its matching original has decoded.
let imagePreviewProtocol=false, liveSelection=null, frameStream=null, lastCaptured=null;
const frames=new Map();
const liveJob=id=>jobs.find(j=>j.id===id);
const currentImage=()=>{const j=liveJob(active);return j?.kind==='image'&&liveStatus(j.status)?j:null;};
const nextImage=()=>currentImage()||jobs.filter(j=>j.kind==='image'&&liveStatus(j.status))
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
function leaveLiveImage(){
 liveSelection=null;lastCaptured=null;stopFrames();
 for(const frame of frames.values())URL.revokeObjectURL(frame.url);
 frames.clear();
}
function selectLiveImage(id){
 liveSelection={id,skip:false,busy:false,error:''};
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
const showsQueue=()=>['bridge','image','video'].includes(page);
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

function renderLiveImage(box){
 const view=liveSelection;if(page!=='image'||!view)return false;
 const job=liveJob(view.id),history=queueHistory.find(j=>j.id===view.id);
 const status=job?.status||history?.status;
 const output=library.find(j=>j.job===view.id&&j.kind==='image');
 if(status==='cancelled'&&nextImage()&&nextImage().id!==view.id){
  selectLiveImage(nextImage().id);return true;
 }
 if(box.dataset.live!==view.id||!$('.watchImage',box)){
  box.dataset.live=view.id;
  box.innerHTML='<div class="asset watchImage"><img class="watchPixels" alt="Live image preview" hidden><small class="watchCaption" role="status"></small><button class="skipImage" hidden>Skip image</button><button class="retryImage" hidden>Retry download</button></div>';
  $('.watchPixels',box).dataset.frameJob=view.id;
  $('.skipImage',box).onclick=()=>skipImage(view);
  $('.retryImage',box).onclick=()=>{view.error='';renderLiveImage(box);};
 }
 const skip=$('.skipImage',box),retry=$('.retryImage',box);
 skip.hidden=!(connected&&job?.owner===info().device&&job.id===active&&job.status==='running'&&imagePreviewProtocol);
 skip.disabled=view.skip;skip.textContent=view.skip?'Skipping…':'Skip image';
 retry.hidden=!view.error||!output||!connected;
 const label=view.error||(output||status==='complete'?'Downloading original…':
  status==='cancelled'?'Image skipped':status==='error'?'Generation failed':
  view.skip||status==='cancelling'?'Skipping image…':frames.has(view.id)?'Live preview':
  view.id===active?'Waiting for the first preview…':'Queued for generation');
 $('.watchCaption',box).textContent=label;
 paintFrame(view.id);
 const pixels=$('.watchPixels',box);
 if(output&&!frames.has(view.id)&&!pixels.hasAttribute('src')){
  const cover=media(output.id,true);if(cover){pixels.src=cover;pixels.hidden=false;}
 }
 if(output&&!view.busy&&!view.error&&(output.local||connected))finishLiveImage(view,output);
 return true;
}
async function finishLiveImage(view,item){
 view.busy=true;const session=epoch;
 try{
  if(!item.local){
   item=await fetchOriginal(item.id);
   if(session!==epoch)return;
   updateItem(item);
  }
  const img=new Image();img.className='original';img.alt='Generated image';img.src=media(item.id);
  await img.decode();
  if(liveSelection!==view||page!=='image'||session!==epoch)return;
  const box=$('#result');if(!box)return;
  const host=document.createElement('div');host.className='asset';host.dataset.id=item.id;host.dataset.hash=item.local;
  host.append(img);box.replaceChildren(host,makeVideoButton(item));delete box.dataset.live;
  box.dataset.latest=library.find(j=>j.kind==='image'&&!j.archived)?.id||item.id;
  if(lastCaptured===item.job)lastCaptured=null;
  liveSelection=null;pruneFrames();renderCarousel();
 }catch(e){view.error='Could not load the original: '+e.message;}
 finally{view.busy=false;if(liveSelection===view&&view.error&&$('#result'))renderLiveImage($('#result'));}
}
async function skipImage(view){
 if(view.skip||view!==liveSelection)return;
 view.skip=true;renderLiveImage($('#result'));
 try{await api('skip',{id:view.id});}
 catch(e){view.skip=false;toast(e.message);}
 await poll();
 if(liveSelection===view&&$('#result'))renderLiveImage($('#result'));
}
