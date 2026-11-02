'use strict';
let galleryDirty=false, viewerClosing=false, originTile=null;
const viewerOpen=()=>!$('#viewer').hidden;
const reduceMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
// Release the browser's temporary playback handle when a route or result is replaced.
// The verified file in the phone library is unaffected.
const playbackHandles=new Map();
new MutationObserver(()=>{
 for(const [v,url] of playbackHandles)if(!v.isConnected){v.pause();v.removeAttribute('src');v.load();URL.revokeObjectURL(url);playbackHandles.delete(v);}
}).observe(document.body,{childList:true,subtree:true});
function renderLibrary(){
 const items=library.filter(j=>!!j.archived===archived),review=library.filter(j=>j.warning);
 const main=$('#main');
 if(!$('.librarygrid',main))main.innerHTML='<div class="collectionTools"><button id="archiveLink"></button><small></small><button id="shelfInfo" aria-label="Phone copies and sync status"></button></div><div class="librarygrid"></div>';
 $('#archiveLink').textContent=archived?'‹ Library':'Archive ›';
 $('.collectionTools small').textContent=items.length+' '+(items.length===1?'item':'items');
 $('#shelfInfo').textContent=review.length?'Review · '+review.length:shelfError?'Check copies':'Phone copies';
 $('#pageTitle').textContent=archived?'Archive':'Library';
 const grid=$('.librarygrid'),version=JSON.stringify(items.map(j=>[j.id,media(j.id,true),j.warning,j.duration]));
 if(grid.dataset.version!==version||grid.dataset.archive!==String(archived)){
  const sameSection=grid.dataset.archive===String(archived),w=$('#workspace');
  const old=new Map($$('.libraryitem',grid).map(tile=>[tile.dataset.media,tile]));
  const anchor=sameSection&&w.scrollTop>0&&[...old.values()].find(t=>t.getBoundingClientRect().bottom>52);
  const top=anchor&&anchor.getBoundingClientRect().top;
  $('.galleryEmpty',grid)?.remove();
  for(const [i,j] of items.entries()){
   const tile=old.get(j.id)||document.createElement('button');old.delete(j.id);
   tile.className='libraryitem';tile.dataset.media=j.id;tile.setAttribute('aria-label','Open '+j.kind);
   const key=JSON.stringify([media(j.id,true),j.warning,j.duration]);
   if(tile.dataset.content!==key){tile.dataset.content=key;tile.innerHTML=(media(j.id,true)?'<img loading="lazy" alt="" src="'+media(j.id,true)+'">':'<small>On PC</small>')+(j.kind==='video'?'<span class="videoBadge">▶ '+duration(j.duration)+'</span>':'')+(j.warning?'<small class="copyBadge">Review</small>':'');}
   if(tile!==grid.children[i])grid.insertBefore(tile,grid.children[i]||null);
  }
  old.forEach(t=>t.remove());
  if(!items.length)grid.innerHTML='<p class="galleryEmpty">'+(archived?'No archived items.':'Your phone generations will appear here.')+'</p>';
  if(anchor&&anchor.isConnected)w.scrollTop+=anchor.getBoundingClientRect().top-top;
  grid.dataset.version=version;grid.dataset.archive=String(archived);
 }
 $('#archiveLink').onclick=()=>{archived=!archived;renderLibrary();$('#workspace').scrollTop=0;};
 $('#shelfInfo').onclick=()=>{
  const recent=library.filter(j=>j.recent&&j.source==='available');
  openModal('Phone copies','<section class="card"><strong>'+recent.filter(j=>j.local).length+' / '+recent.length+' recent items on phone</strong><p>We keep the newest 100 images and videos together. '+(connected?'The PC is checked every five minutes.':'Offline · downloaded items still open.')+'</p>'+(shelfError?'<p class="warning">'+esc(shelfError)+'</p>':'')+'<button id="checkShelf" '+(connected?'':'disabled')+'>Check now</button></section>'+review.map(j=>'<button class="reviewItem" data-media="'+j.id+'">'+esc(j.kind)+' · '+esc(new Date(j.created*1000).toLocaleDateString())+'<small>'+esc(warningText[j.warning])+'</small></button>').join(''));
  $('#checkShelf').onclick=async()=>{await syncShelf(true);closeModal();toast(shelfError||'Phone copies checked');};wireMedia($('#modalBody'));
 };
 wireMedia(main);
}
function wireMedia(root){$$('[data-media]',root).forEach(b=>b.onclick=()=>{
 const item=library.find(x=>x.id===b.dataset.media);if(!item)return;
 if(root.id==='carousel'){liveSelection=null;delete $('#result').dataset.live;mountResult(item);pruneFrames();return;}
 if($('#modal').open)closeModal();originTile=b;openMedia(item);
});}

function makeVideoButton(item){
 const button=document.createElement('button');
 button.type='button';button.className='makeVideo';button.textContent='Make video';
 button.onclick=async()=>{
  const session=epoch;
  button.disabled=true;button.textContent='Loading image…';
  try{
   if(!state.settings.video)throw Error('Connect to the PC to load your video settings first.');
   let original=library.find(entry=>entry.id===item.id)||item;
   if(!original.local){
    if(!connected)throw Error('Connect to the PC to download this image.');
    original=await fetchOriginal(item.id);
   }
   const response=await fetch('/local/image/'+original.id+'/'+original.local);
   if(!response.ok)throw Error('Could not read the original image from the phone.');
   const input=await readStartingImage(await response.blob());
   if(session!==epoch||!button.isConnected||viewerClosing)return;
   setStartingImage('video',input);
   navigate('video');
   const panel=$('#upload')?.closest('.foldPanel');
   if(panel?.classList.contains('folded'))$('.foldToggle',panel).click();
   panel?.scrollIntoView({block:'nearest'});
  }catch(e){if(button.isConnected)toast(e.message);}
  finally{button.disabled=false;button.textContent='Make video';}
 };
 return button;
}

function extendVideoButton(item){
 const button=document.createElement('button');
 button.type='button';button.className='makeVideo';button.textContent='Extend video';
 button.onclick=async()=>{
  const session=epoch;
  button.disabled=true;button.textContent='Reading clip…';
  try{
   if(!connected)throw Error('Connect to the PC to extend this video.');
   if(state.pendingByKind?.video||state.pendingRequest?.kind==='video')throw Error('Resolve the pending video submission before starting an extension.');
   if(item.warning==='changed'||item.source==='missing')throw Error('Resolve the source file warning before extending this clip.');
   let source;
   try{source=await api((queueProtocol>=9?'':'studio/')+'extension/'+item.id);}
   catch(error){if(/Unknown workspace request|HTTP 404/.test(error.message))throw Error('Install Windows beta 18 to extend videos.');throw error;}
   if(session!==epoch||!button.isConnected||viewerClosing)return;
   activateExtension(source);
  }catch(e){if(button.isConnected)toast(e.message);}
  finally{button.disabled=false;button.textContent='Extend video';}
 };
 return button;
}

function activateExtension(source){
 const settings=state.settings.video;
 if(!settings)throw Error('Wait for the PC to load your video settings.');
 rememberTextCanvas(settings);
 Object.assign(settings,{extension:source,upload:null,mask:null,scale:0,width:source.width,height:source.height,
  fps:source.fps,seconds:3,exactFrames:true,frames:Math.max(1,Math.round(source.fps*3))});
 state.inputs.video={};
 persist('video');navigate('video');
 const panel=$('#extensionSource').closest('.foldPanel');
 if(panel.classList.contains('folded'))$('.foldToggle',panel).click();
 panel.scrollIntoView({block:'nearest'});
}

// Both surfaces use the same player. Only verified, complete originals are playable.
function mountAsset(host,item,isViewer){
 const id=item.id;host.className='asset'+(isViewer?' galleryAsset':'');host.replaceChildren();
 const toggleChrome=()=>{if(isViewer)$('#viewer').classList.toggle('quiet');else host.classList.toggle('quiet');};
 async function load(download=true,play=false){
  const msg=t=>{host.innerHTML='<p class="assetStatus" role="status">'+esc(t)+'</p>';};
  try{
   if(!item.local){
    if(!download){host.innerHTML='<button class="fetchPoster">'+(media(id,true)?'<img src="'+media(id,true)+'" alt="">':'')+'<span>'+(item.kind==='video'?'▶ Play video':'Download image')+'</span></button>';host.firstChild.onclick=()=>load(true,item.kind==='video');return;}
    if(!connected)throw Error('This item is on the PC. Connect to download it.');
    const transfer='Downloading the complete '+item.kind+' ('+((item.size||0)/1048576).toFixed(1)+' MB)…';
    const cover=media(id,true);
    if(item.kind==='image'&&!isViewer&&cover){
     host.innerHTML='<img class="watchPixels" alt="Result preview"><small class="watchCaption"></small>';
     host.firstChild.src=cover;host.lastChild.textContent=transfer;
    }else msg(transfer);
    item=await fetchOriginal(id);host.dataset.hash=item.local;updateItem(item);
   }
   if(!host.isConnected)return;
   if(item.kind==='image'){
    const original=new Image();original.className='original';original.alt='Generated image';original.src=media(id);
    await original.decode();
    if(host.isConnected){
     host.replaceChildren(original);original.onclick=toggleChrome;
     if(!isViewer)host.after(makeVideoButton(item));
    }
    return;
   }
   host.innerHTML='<video playsinline preload="metadata" poster="'+media(id,true)+'" aria-label="Generated video"></video><button class="bigPlay" aria-label="Play video">▶</button><div class="transport"><button class="transportPlay" aria-label="Play">▶</button><input type="range" min="0" max="1" step="any" value="0" aria-label="Video position"><small></small></div>';
   const video=$('video',host),middle=$('.bigPlay',host),btn=$('.transportPlay',host),seek=$('input',host);
   const chrome=on=>(isViewer?$('#viewer'):host).classList.toggle('quiet',!on);
   const tick=()=>{const end=Number.isFinite(video.duration)?video.duration:item.duration||0;seek.max=end||1;seek.value=video.currentTime;$('small',host).textContent=duration(video.currentTime)+' / '+duration(end);};
   let preparing=false;
   const toggle=async()=>{
    if(!video.paused){video.pause();return;}if(preparing)return;preparing=true;
    try{
     if(!playbackHandles.has(video)){
      middle.textContent='…';middle.disabled=true;
      // WebView can stall while seeking larger intercepted MP4 streams. A Blob gives
      // the decoder a seekable local source without base64 or an extra native screen.
      const response=await fetch('/local/video/'+id+'/'+item.local);
      if(!response.ok)throw Error('Could not open this phone copy.');
      const blob=await response.blob();
      if(!video.isConnected)return;
      if(!blob.size)throw Error('The phone copy is empty.');
      const url=URL.createObjectURL(blob);playbackHandles.set(video,url);video.src=url;
     }
     await video.play();
    }catch(e){if(video.isConnected)toast(e.message);}finally{preparing=false;middle.textContent='▶';middle.disabled=false;}
   };
   btn.onclick=middle.onclick=toggle;video.onclick=toggleChrome;seek.oninput=()=>{if(Number.isFinite(video.duration))video.currentTime=Number(seek.value);};
   video.onplay=()=>{middle.hidden=true;btn.textContent='Ⅱ';btn.setAttribute('aria-label','Pause');chrome(false);};
   video.onpause=video.onended=()=>{middle.hidden=false;btn.textContent='▶';btn.setAttribute('aria-label','Play');chrome(true);};
   video.ontimeupdate=video.onloadedmetadata=tick;tick();
   video.onerror=()=>{if(host.isConnected){chrome(true);msg('Android could not decode this video. Your phone copy is still available to save.');}};
   if(play)await toggle();
  }catch(e){if(host.isConnected){msg(e.message);const retry=document.createElement('button');retry.className='assetRetry';retry.textContent='Try again';retry.onclick=()=>load(true,play);host.append(retry);}}
 }
 load(isViewer||item.kind==='image'&&(connected||!!item.local));
}
function mountResult(j){
 const box=$('#result');if(!box)return;
 let host=$('.asset',box);
 if(host&&host.dataset.id===j.id&&host.dataset.hash===(j.local||''))return;
 box.replaceChildren();host=document.createElement('div');host.dataset.id=j.id;host.dataset.hash=j.local||'';box.append(host);mountAsset(host,j,false);
 if(j.kind==='video')host.after(extendVideoButton(j));
}
function renderResults(){
 const box=$('#result');if(!box)return;
 const items=library.filter(x=>x.kind===page&&!x.archived),first=items[0];
 if(page==='image'&&imagePreviewProtocol&&!liveSelection){
  if(!first&&currentImage())liveSelection={id:active};
  else if(first&&!first.local&&frames.has(first.job))liveSelection={id:first.job};
 }
 if(renderLiveImage(box)){renderCarousel();return;}
 if(first){
  const current=items.find(j=>j.id===$('.asset',box)?.dataset.id);
  const playing=$('video',box);
  if(!(current&&playing&&!playing.paused&&box.dataset.latest!==first.id)){
   mountResult(box.dataset.latest===first.id&&current?current:first);box.dataset.latest=first.id;
  }
 }else box.innerHTML='<small>Your next idea will appear here.</small>';
 renderCarousel();
}
function openMedia(item){
 const view=$('#viewer'),work=$('#workspace');if(viewerClosing)return;
 view.className='';view.hidden=false;work.inert=true;work.classList.add('behind');galleryDirty=false;
 view.innerHTML='<div class="asset"></div><div class="viewerTop"><button id="viewerBack" aria-label="Back to collection">‹</button><div><b>'+esc(item.kind==='video'?'Video':'Image')+'</b><small>'+esc(new Date(item.created*1000).toLocaleString())+'</small></div></div><div class="viewerFoot"><div id="mediaWarning"></div><div class="viewerActions"><button id="saveMedia">↓　Save to camera roll</button><button id="archiveMedia">'+(item.archived?'Unarchive':'Archive')+'</button></div><div id="mediaMessage" role="status"></div></div>';
 const current=()=>library.find(x=>x.id===item.id)||item;
 const stillHere=()=>viewerOpen()&&$('#viewerBack')===back;
 const back=$('#viewerBack');
 const footerSize=new ResizeObserver(()=>{if(stillHere())view.style.setProperty('--action-height',$('.viewerFoot',view).offsetHeight+'px');});
 footerSize.observe($('.viewerFoot',view));view.releaseFooter=()=>footerSize.disconnect();
 const msg=t=>{if(stillHere())$('#mediaMessage').textContent=t;};view.dataset.id=item.id;
 $('#viewerBack').onclick=()=>closeViewer();$('#viewerBack').focus({preventScroll:true});
 const archive=$('#archiveMedia');archive.disabled=!connected||item.source==='missing';
 archive.onclick=async()=>{archive.disabled=true;try{await api('archive',{id:item.id,archived:!item.archived});updateItem({...current(),archived:!item.archived});if(stillHere())closeViewer();await syncShelf(true);}catch(e){msg(e.message);archive.disabled=false;}};
 $('#saveMedia').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{if(!current().local)throw Error('Wait for the phone copy to finish downloading.');await local('export',{id:item.id});msg('Saved to DCIM/ComfyBridge in your camera roll.');}catch(err){msg(err.message);}finally{b.disabled=false;}};
 $('#saveMedia').after(item.kind==='image'?makeVideoButton(item):extendVideoButton(item));
 const regenerate=document.createElement('button');
 regenerate.type='button';regenerate.textContent='↗ Regenerate';
 regenerate.onclick=()=>restoreGeneration(current().job,regenerate,()=>stillHere()&&!viewerClosing);
 $('.viewerActions',view).append(regenerate);
 if(item.warning){const w=$('#mediaWarning');w.textContent=warningText[item.warning]+' ';const b=document.createElement('button');w.append(b);const replace=item.warning==='changed';b.textContent=replace?'Replace…':'Remove copy…';b.disabled=replace&&!connected;b.onclick=()=>{msg('Save to the camera roll first if you want to keep this version.');b.textContent=replace?'Confirm replacement':'Confirm removal';b.onclick=async()=>{b.disabled=true;try{const j=await local(replace?'replace':'drop',{id:item.id,local:item.local,sha256:item.sha256});updateItem(j);if(stillHere())closeViewer();}catch(e){msg(e.message);b.disabled=false;}};};}
 mountAsset($('.asset',view),item,true);
}
function closeViewer(immediate=false){
 const view=$('#viewer'),work=$('#workspace');if(view.hidden||viewerClosing)return;viewerClosing=true;
 const finish=()=>{view.releaseFooter?.();view.hidden=true;view.replaceChildren();view.className='';view.style.transform='';work.style.transform='';work.classList.remove('behind');work.inert=false;viewerClosing=false;
 if(galleryDirty&&page==='library')renderLibrary();galleryDirty=false;if(originTile?.isConnected)originTile.focus({preventScroll:true});originTile=null;};
 $('video',view)?.pause();if(immediate||reduceMotion()){finish();return;}
 const from=view.getBoundingClientRect().left;
 const opts={duration:Math.max(65,180*(1-from/innerWidth)),easing:'ease-out',fill:'forwards'};
 work.animate([{transform:getComputedStyle(work).transform},{transform:'translateX(0)'}],opts).onfinish=e=>e.target.cancel();
 const anim=view.animate([{transform:'translateX('+from+'px)'},{transform:'translateX(100%)'}],opts);anim.onfinish=()=>{finish();anim.cancel();};
}
function bridgeBack(){
 if($('#modal').open){$('#modalClose').click();return;}
 if(viewerOpen()){closeViewer();return;}
 if($('#drawer').classList.contains('open')){drawer(false);return;}
 if(!$('#presetMenu').hidden){$('#presetMenu').hidden=true;return;}
 if($('#batchMenu')&&!$('#batchMenu').hidden){$('#batchMenu').hidden=true;return;}
 if(page==='library'&&archived){archived=false;renderLibrary();return;}
 if(page!=='bridge')navigate('bridge');
}
function outgoingBridge(){
 if(reduceMotion())return null;
 const old=$('#main').cloneNode(true);old.removeAttribute('id');old.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));old.inert=true;old.className='departing';old.setAttribute('aria-hidden','true');old.style.top=$('#main').getBoundingClientRect().top+'px';document.body.append(old);return old;
}
function enterGenerator(old){
 const options={duration:200,easing:'cubic-bezier(.22,.75,.25,1)'};
 old.animate([{transform:'translateX(0)'},{transform:'translateX(-100vw)'}],options).onfinish=()=>old.remove();
 $('#main').animate([{transform:'translateX(100vw)'},{transform:'translateX(0)'}],options);
}

// A vertical scroll or a control drag stays owned by its original surface.
let drag=null,swallowUntil=0;
document.addEventListener('pointerdown',e=>{
 swallowUntil=0;
 if(!e.isPrimary||e.button!==0||viewerClosing||e.target.closest('input,textarea,select,canvas,#carousel,[contenteditable]'))return;
 const type=$('#modal').open?'modal':viewerOpen()?'viewer':$('#drawer').classList.contains('open')?'closeDrawer':page==='library'&&archived?'archive':'drawer';
 if(type)drag={id:e.pointerId,type,x:e.clientX,y:e.clientY,t:performance.now(),dx:0,active:false,queue:e.target.closest('.historyCard')};
});
document.addEventListener('pointermove',e=>{
 if(!drag||drag.id!==e.pointerId)return;
 const d=drag,closingDrawer=d.type==='closeDrawer';
 const dx=closingDrawer?d.x-e.clientX:e.clientX-d.x,dy=e.clientY-d.y;
 if(!d.active){
  if(Math.abs(dx)<8&&Math.abs(dy)<8)return;
  if(dx<0||Math.abs(dy)>Math.abs(dx)*1.2){drag=null;return;}
  if(dx<Math.abs(dy)*1.2)return;
  d.active=true;document.body.classList.add('dragging');
  // After horizontal intent is clear, keep receiving the gesture as the
  // drawer covers the row. Ordinary taps and vertical scrolling stay native.
  if(d.queue)$('#workspace').setPointerCapture(e.pointerId);
 }
 d.dx=Math.max(0,Math.min(dx,innerWidth));if(d.type==='viewer'){$('#viewer').style.transform='translateX('+d.dx+'px)';$('#workspace').style.transform='translateX('+(-1+d.dx/innerWidth)*100+'%)';}
 if(d.type==='drawer'||closingDrawer){
  const panel=$('#drawer'),width=panel.offsetWidth,travel=Math.min(width,d.dx);
  const visible=closingDrawer?width-travel:travel;
  panel.style.transform='translateX('+(visible-width)+'px)';
  $('#shade').hidden=false;
  $('#shade').style.opacity=visible/width;
 }
});
function endDrag(e){
 if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;if(!d.active)return;
 swallowUntil=performance.now()+320;
 const commit=e.type!=='pointercancel'&&(d.dx>Math.min(125,innerWidth*.30)||(d.dx>35&&d.dx/Math.max(1,performance.now()-d.t)>.42));
 document.body.classList.remove('dragging');
 if(d.type==='drawer'||d.type==='closeDrawer'){
  $('#drawer').style.transform='';
  $('#shade').style.opacity='';
  drawer(d.type==='closeDrawer'?!commit:commit);
 }
 else if(d.type==='viewer'){if(commit)closeViewer();else{$('#viewer').style.transform='';$('#workspace').style.transform='';}}
 else if(commit)bridgeBack();
}
document.addEventListener('pointerup',endDrag);document.addEventListener('pointercancel',endDrag);
document.addEventListener('click',e=>{if(performance.now()<swallowUntil){e.stopImmediatePropagation();e.preventDefault();}},true);
