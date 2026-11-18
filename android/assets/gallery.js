'use strict';
let galleryDirty=false, viewerClosing=false, originTile=null;
const viewerOpen=()=>!$('#viewer').hidden;
const reduceMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
// Release the browser's temporary playback handle when a route or result is replaced.
// The verified file in the phone library is unaffected.
const playbackHandles=new Map(),assetObservers=new Map();
new MutationObserver(()=>{
 for(const [host,observer] of assetObservers)if(!host.isConnected){observer.disconnect();assetObservers.delete(host);}
 for(const [v,url] of playbackHandles)if(!v.isConnected){v.pause();v.removeAttribute('src');v.load();URL.revokeObjectURL(url);playbackHandles.delete(v);}
}).observe(document.body,{childList:true,subtree:true});
function renderLibrary(){
 const items=library.filter(j=>!!j.archived===archived),review=library.filter(j=>j.warning);
 const main=$('#main');
 if(!$('.librarygrid',main))main.innerHTML='<div class="collectionTools"><button id="archiveLink"></button><small></small><button id="shelfInfo" aria-label="Phone copies and sync status"></button></div><div class="librarygrid"></div>';
 $('#archiveLink').innerHTML=archived?backChevron+'Library':'Archive ›';
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
   tile.className='libraryitem';if(j.width>0&&j.height>0)tile.style.setProperty('--thumb-ratio',j.width/j.height);tile.dataset.media=j.id;tile.setAttribute('aria-label','Open '+j.kind);
   const key=JSON.stringify([media(j.id,true),j.warning,j.duration]);
   if(tile.dataset.content!==key){tile.dataset.content=key;tile.innerHTML=(media(j.id,true)?'<img loading="lazy" alt="" src="'+media(j.id,true)+'">':'<small>On PC</small>')+(j.kind==='video'?'<span class="videoBadge">▶ '+duration(j.duration)+'</span>':'')+(j.warning?'<small class="copyBadge">Review</small>':'');}
   const preview=$('img',tile);if(preview){const ratio=()=>{if(preview.naturalWidth&&preview.naturalHeight)tile.style.setProperty('--thumb-ratio',preview.naturalWidth/preview.naturalHeight);};preview.onload=ratio;if(preview.complete)ratio();}
   if(tile!==grid.children[i])grid.insertBefore(tile,grid.children[i]||null);
  }
  old.forEach(t=>t.remove());
  if(!items.length)grid.innerHTML='<p class="galleryEmpty">'+(archived?'No archived items.':(window.Desktop?'Your generations will appear here.':'Your phone generations will appear here.'))+'</p>';
  if(anchor&&anchor.isConnected)w.scrollTop+=anchor.getBoundingClientRect().top-top;
  grid.dataset.version=version;grid.dataset.archive=String(archived);
 }
 $('#archiveLink').onclick=()=>{archived=!archived;renderLibrary();$('#workspace').scrollTop=0;};
 $('#shelfInfo').onclick=()=>{
  const recent=library.slice(0,20).filter(j=>j.source==='available');
  openModal('Phone copies','<section class="card"><strong>'+recent.filter(j=>j.local).length+' / '+recent.length+' newest items on phone</strong><p>Missing files among the newest 20 images and videos download automatically while the app is open, on every screen. Older items download when opened. '+(connected?'PC files are checked for changes every five minutes.':'Offline · downloaded items still open.')+' Existing copies stay until you choose to remove them.</p>'+(shelfError?'<p class="warning">'+esc(shelfError)+'</p>':'')+'<button id="checkShelf" '+(connected?'':'disabled')+'>Check now</button></section>'+review.map(j=>'<button class="reviewItem" data-media="'+j.id+'">'+esc(j.kind)+' · '+esc(new Date(j.created*1000).toLocaleDateString())+'<small>'+esc(warningText[j.warning])+'</small></button>').join(''));
  $('#checkShelf').onclick=async()=>{await syncShelf(true);closeModal();toast(shelfError||'Phone copies checked');};wireMedia($('#modalBody'));
 };
 wireMedia(main);
}
function wireMedia(root){$$('[data-media]',root).forEach(b=>b.onclick=()=>{
 const item=library.find(x=>x.id===b.dataset.media);if(!item)return;
 if(root.id==='carousel'){liveSelection=null;delete $('#result').dataset.live;$('#result').dataset.latest=library.find(x=>x.kind===page&&!x.archived)?.id||item.id;mountResult(item);refreshCarouselSelection();pruneFrames();return;}
 if($('#modal').open)closeModal();originTile=b;openMedia(item);
});}

function ratingButtons(item){
 const group=document.createElement('div');group.className='mediaRating';group.dataset.ratingId=item.id;group.setAttribute('aria-label','Favorite');
 for(const n of [5]){
  const b=document.createElement('button');b.type='button';b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';b.dataset.rating=n;b.setAttribute('aria-label','Add to favorites');
  b.onclick=async()=>{
   if(!connected){toast('Connect to the PC to save a favorite.');return;}
   group.querySelectorAll('button').forEach(x=>x.disabled=true);
   try{
    const current=library.find(x=>x.id===item.id)||item;
    const saved=await api('studio/rating',{id:item.id,rating:current.rating>=4?0:n});
    updateItem({...current,rating:saved.rating});refreshRatings();
    await syncShelf(true);
   }catch(e){toast(e.message);}finally{group.querySelectorAll('button').forEach(x=>x.disabled=false);}
  };group.append(b);
 }
 return group;
}
function refreshRatings(){
 $$('.mediaRating').forEach(group=>{
  const value=library.find(x=>x.id===group.dataset.ratingId)?.rating||0;
  $$('button',group).forEach(b=>{b.setAttribute('aria-pressed',String(value>=4));b.setAttribute('aria-label',value>=4?'Remove from favorites':'Add to favorites');});
 });
}
const backChevron='<svg class="backChevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
function pageMedia(direction){
 const current=library.find(x=>x.id===$('#viewer').dataset.id);
 const items=library.filter(x=>!!x.archived===!!current?.archived),index=items.findIndex(x=>x.id===$('#viewer').dataset.id);
 const next=items[index+direction];if(index<0||!next)return;
 openMedia(next);
}
function mediaTap(event,toggle){
 if(viewerOpen()&&event.currentTarget.closest('#viewer')){
  const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width;
  if(x<.22){pageMedia(-1);return;}if(x>.78){pageMedia(1);return;}
 }
 toggle();
}

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
   if(!response.ok)throw Error(window.Desktop?'Could not read the original image file.':'Could not read the original image from the phone.');
   const input=await readStartingImage(await response.blob());
   if(session!==epoch||!button.isConnected||viewerClosing)return;
   setStartingImage('video',input);state.settings.video.sourceMedia=item.id;persist('video');
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
   await resolvePendingSubmission('video');
   if(item.warning==='changed'||item.source==='missing')throw Error('Resolve the source file warning before extending this clip.');
   let source;
   try{source=await api((queueProtocol>=9?'':'studio/')+'extension/'+item.id);}
   catch(error){if(/Unknown workspace request|HTTP 404/.test(error.message))throw Error('Install Windows beta 18 to extend videos.');throw error;}
   if(session!==epoch||!button.isConnected||viewerClosing)return;
   activateExtension(source);state.settings.video.sourceMedia=item.id;persist('video');
  }catch(e){if(button.isConnected)toast(e.message);}
  finally{button.disabled=false;button.textContent='Extend video';}
 };
 return button;
}

function regenerateButton(item){
 const button=document.createElement('button');button.type='button';button.className='regenerate';button.textContent='↗ Regenerate';
 button.disabled=!item.job;
 button.onclick=()=>restoreGeneration((library.find(entry=>entry.id===item.id)||item).job,button,()=>button.isConnected);
 return button;
}

function activateExtension(source){
 const settings=state.settings.video;

 if(!settings)throw Error('Wait for the PC to load your video settings.');
 const {characterReference, ...clip}=source;
 const wasUsingReference=hasCharacterReference(settings);
 const input=videoReferenceInputs(state.inputs.video);
 // Follow the selected library branch, even when its saved reference was cleared.
 if(characterReference){
  if(!wasUsingReference)beginCharacterReference(settings);
  settings.characterReference=characterReference.name;
  settings.characterReferenceOrigin=characterReference.origin;
  input.characterReference={job:characterReference.job};
 }else if(settings.extension&&settings.extension.id!==clip.id&&!clip.id.startsWith('upload-')){
  dropCharacterReference(settings);
  delete input.characterReference;
 }
 delete settings.sourceMedia;delete settings.sourceOrigin;delete settings.replayOf;
 rememberTextCanvas(settings);
 Object.assign(settings,{extension:clip,upload:null,mask:null,scale:0,width:clip.width,height:clip.height,
  fps:clip.fps,seconds:10,exactFrames:true,frames:Math.max(1,Math.round(clip.fps*10))});
 state.inputs.video=input;
 persist('video');navigate('video');
 const panel=$('#extensionSource').closest('.foldPanel');
 if(panel.classList.contains('folded'))$('.foldToggle',panel).click();
 panel.scrollIntoView({block:'nearest'});
}

// Both surfaces use the same player. Only verified, complete originals are playable.
function mountAsset(host,item,isViewer,posterOverride=null){
 assetObservers.get(host)?.disconnect();assetObservers.delete(host);
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
     host.replaceChildren(original);original.onclick=e=>mediaTap(e,toggleChrome);
    }
    return;
   }
   const videoPoster=posterOverride||media(id,true);
   host.classList.add('videoAsset');
   host.innerHTML='<video playsinline preload="metadata" poster="'+esc(videoPoster)+'" aria-label="Generated video"></video>';
   const video=$('video',host);
   const prepare=async()=>{
    if(window.Desktop){if(!video.src)video.src='/local/video/'+id+'/'+item.local;}
    else if(!playbackHandles.has(video)){
     // Complete local blobs remain reliably seekable in Android's intercepted WebView.
     const response=await fetch('/local/video/'+id+'/'+item.local);
     if(!response.ok)throw Error('Could not open this phone copy.');
     const blob=await response.blob();if(!video.isConnected)return;
     if(!blob.size)throw Error('The phone copy is empty.');
     const url=URL.createObjectURL(blob);playbackHandles.set(video,url);video.src=url;
    }
   };
   const player=VideoPlayer.mount(video,{duration:item.duration,width:item.width,height:item.height,prepare,
    bounds:()=>({width:host.clientWidth,height:isViewer?host.clientHeight:Infinity}),error:e=>toast(e.message)});
   video.onclick=e=>mediaTap(e,toggleChrome);
   video.onerror=()=>{if(host.isConnected)toast(window.Desktop?'Windows could not decode this video. Use Open file location to play it in another app.':'Android could not decode this video. Your phone copy is still available to save.');};
   if(play)await player.playPause();
  }catch(e){if(host.isConnected){msg(e.message);const retry=document.createElement('button');retry.className='assetRetry';retry.textContent='Try again';retry.onclick=()=>load(true,play);host.append(retry);}}
 }
 load(isViewer||item.kind==='image'&&(connected||!!item.local));
}
const resultIcon=(path)=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+path+'"/></svg>';
function compactMediaAction(button,label,icon){button.setAttribute('aria-label',label);button.title=label;button.innerHTML=icon;button.classList.add('compactMediaAction');return button;}
function saveMediaButton(item,message=toast){
 const button=provenanceButton(window.Desktop?'Save a copy':'Save to camera roll',async()=>{
  const current=library.find(x=>x.id===item.id)||item;
  if(!current.local)throw Error(window.Desktop?'The original file is not available.':'Wait for the phone copy to finish downloading.');
  const saved=await local('export',{id:item.id});
  message(saved===false?'Save cancelled.':window.Desktop?'Copy saved.':'Saved to DCIM/ComfyBridge in your camera roll.');
 });button.classList.add('saveMediaAction');return button;
}
function archiveMediaButton(item,after=()=>{},message=toast){
 const button=provenanceButton(item.archived?'Unarchive':'Archive',async()=>{
  const current=library.find(x=>x.id===item.id)||item;
  await api('archive',{id:item.id,archived:!current.archived});updateItem({...current,archived:!current.archived});after();await syncShelf(true);
 });button.disabled=!connected||item.source==='missing';button.classList.add('archiveMediaAction');return button;
}
function revealMediaButton(item,message=toast){return provenanceButton('Open file location',async()=>{try{await local('reveal',{id:item.id});}catch(e){message(e.message);}});}
function resultActions(item,pending=false){
 const actions=document.createElement('div');actions.className='resultActions';
 const group=document.createElement('div');group.className='resultActionGroup';actions.append(group);
 const inputs=inputActions(item);
 if(item.kind==='image'){
  inputs[0].textContent='i2i';inputs[0].setAttribute('aria-label','Send to i2i');inputs[0].title='Send to image to image';
  group.append(inputs[1],inputs[0],inputs[2]);
 }else group.append(...inputs);
 group.append(regenerateButton(item));
 group.append(compactMediaAction(saveMediaButton(item),window.Desktop?'Save a copy':'Save to camera roll',resultIcon('M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5')));
 group.append(compactMediaAction(archiveMediaButton(item,()=>{if(!liveSelection)renderResults();}),item.archived?'Unarchive':'Archive',resultIcon('M4 8h16v13H4zM3 3h18v5H3zM9 12h6')));
 if(window.Desktop)group.append(compactMediaAction(revealMediaButton(item),'Open file location',resultIcon('M3 6h7l2 3h9v11H3zM16 3h5v5m0-5-7 7')));
 group.append(ratingButtons(item));
 if(pending){actions.dataset.pending='true';$$('button',actions).forEach(b=>b.disabled=true);}
 // Start at the right edge on narrow displays; the strip can be swiped to reach every action.
 requestAnimationFrame(()=>{if(actions.isConnected)actions.scrollLeft=actions.scrollWidth;});
 return actions;
}
function mountResult(j,posterOverride=null){
 const box=$('#result');if(!box)return;
 let host=$('.asset',box);
 if(host&&host.dataset.id===j.id&&host.dataset.hash===(j.local||'')){refreshRatings();return;}
 box.replaceChildren();host=document.createElement('div');host.dataset.id=j.id;host.dataset.hash=j.local||'';box.append(host);mountAsset(host,j,false,posterOverride);
 host.after(resultActions(j));refreshRatings();
}
function renderResults(){
 const box=$('#result');if(!box)return;
 const items=recentResults(),first=items[0];
 if(['image','video'].includes(page)&&!liveSelection){
  if(!first&&currentGeneration(page))liveSelection={id:active,kind:page};
  else if(first&&!first.local&&frames.has(first.job))liveSelection={id:first.job,kind:page};
 }
 if(renderLiveGeneration(box)){renderCarousel();return;}
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
 view.releaseFooter?.();view.releaseProvenance?.();$('video',view)?.pause();
 view.className='';view.hidden=false;work.inert=true;work.classList.add('behind');galleryDirty=false;
 view.scrollTop=0;
 view.innerHTML='<div class="mediaHero"><div class="asset"></div><div class="viewerTop"><button id="viewerBack" aria-label="Back to collection">'+backChevron+'</button><div><b>'+esc(item.kind==='video'?'Video':'Image')+'</b><small>'+esc(new Date(item.created*1000).toLocaleString())+'</small></div></div><div class="viewerFoot"><div id="mediaWarning"></div><div class="viewerActions"><button id="saveMedia">↓　Save to camera roll</button><button id="archiveMedia">'+(item.archived?'Unarchive':'Archive')+'</button></div><div id="mediaMessage" role="status"></div></div></div>';
 $('.viewerTop',view).append(ratingButtons(item));refreshRatings();
 const current=()=>library.find(x=>x.id===item.id)||item;
 const stillHere=()=>viewerOpen()&&$('#viewerBack')===back;
 const back=$('#viewerBack');
 const footerSize=new ResizeObserver(()=>{if(stillHere())view.style.setProperty('--action-height',$('.viewerFoot',view).offsetHeight+'px');});
 footerSize.observe($('.viewerFoot',view));view.releaseFooter=()=>footerSize.disconnect();
 const msg=t=>{if(stillHere())$('#mediaMessage').textContent=t;};view.dataset.id=item.id;
 $('#viewerBack').onclick=()=>closeViewer();$('#viewerBack').focus({preventScroll:true});
 const archive=archiveMediaButton(item,()=>{if(stillHere())closeViewer();},msg);archive.id='archiveMedia';$('#archiveMedia').replaceWith(archive);
 const save=saveMediaButton(item,msg);save.id='saveMedia';$('#saveMedia').replaceWith(save);
 if(window.Desktop){const reveal=revealMediaButton(item,msg);reveal.id='revealMedia';$('.viewerActions',view).append(reveal);}
 $('#saveMedia').after(...inputActions(item));
 const regenerate=document.createElement('button');
 regenerate.type='button';regenerate.textContent='↗ Regenerate';
 regenerate.onclick=()=>restoreGeneration(current().job,regenerate,()=>stillHere()&&!viewerClosing);
 $('.viewerActions',view).append(regenerate);
 if(item.warning){const w=$('#mediaWarning');w.textContent=warningText[item.warning]+' ';const b=document.createElement('button');w.append(b);const replace=item.warning==='changed';b.textContent=replace?'Replace…':'Remove copy…';b.disabled=replace&&!connected;b.onclick=()=>{msg('Save to the camera roll first if you want to keep this version.');b.textContent=replace?'Confirm replacement':'Confirm removal';b.onclick=async()=>{b.disabled=true;try{const j=await local(replace?'replace':'drop',{id:item.id,local:item.local,sha256:item.sha256});updateItem(j);if(stillHere())closeViewer();}catch(e){msg(e.message);b.disabled=false;}};};}
 mountAsset($('.asset',view),item,true);initProvenance(view,item);
}
function closeViewer(immediate=false){
 const view=$('#viewer'),work=$('#workspace');if(view.hidden||viewerClosing)return;viewerClosing=true;
 const finish=()=>{view.releaseFooter?.();view.releaseProvenance?.();view.hidden=true;view.replaceChildren();view.className='';view.style.transform='';work.style.transform='';work.classList.remove('behind');work.inert=false;viewerClosing=false;
 if(galleryDirty&&page==='library')renderLibrary();galleryDirty=false;if(originTile?.isConnected)originTile.focus({preventScroll:true});originTile=null;};
 $('video',view)?.pause();if(window.Desktop||immediate||reduceMotion()){finish();return;}
 const from=work.getBoundingClientRect().left;
 const opts={duration:Math.max(65,180*(-from/innerWidth)),easing:'ease-out',fill:'forwards'};
 const anim=work.animate([{transform:getComputedStyle(work).transform},{transform:'translateX(0)'}],opts);
 anim.onfinish=()=>{finish();anim.cancel();};
}
function bridgeBack(){
 if(typeof CivitaiBrowser!=='undefined'&&CivitaiBrowser.isOpen()){CivitaiBrowser.close();return;}
 if(page==='browse'&&typeof CivitaiBrowser!=='undefined'&&CivitaiBrowser.back())return;
 if($('#modal').open){$('#modalClose').click();return;}
 if(viewerOpen()){closeViewer();return;}
 if($('#drawer').classList.contains('open')){drawer(false);return;}
 if(!$('#presetMenu').hidden){$('#presetMenu').hidden=true;return;}
 if($('#batchMenu')?.hidden===false){setBatchMenu(false);return;}
 if(noteColumnOpen){setNoteColumn(false,true);return;}
 if(page==='library'&&archived){archived=false;renderLibrary();return;}
 drawer(true);
}

// A vertical scroll or a control drag stays owned by its original surface.
let drag=null,swallowUntil=0;
document.addEventListener('pointerdown',e=>{
 swallowUntil=0;
 if(window.Desktop)return;
 const note=e.target.closest('#noteText, textarea.promptEntry');
 const noteSwipe=note&&e.pointerType!=='mouse'&&note.selectionStart===note.selectionEnd;
 if(!e.isPrimary||e.button!==0||viewerClosing||(!noteSwipe&&e.target.closest('input,textarea,select,canvas,.loraSlider,.browseCarousel,.civitaiViewer,.feedCollectionShade,#carousel,.resultActions,#latestPanel .foldSummary,#chatGrab,[contenteditable]')))return;
 if(e.target.closest('.chatWords')&&window.getSelection()?.type==='Range')return;
 const type=$('#modal').open?'modal':viewerOpen()?'viewer':$('#drawer').classList.contains('open')?'closeDrawer':page==='library'&&archived?'archive':page==='browse'&&typeof CivitaiBrowser!=='undefined'&&CivitaiBrowser.canSwipeBack()?'browseBack':noteColumnOpen?'fromNotes':$('#noteColumn')?'generatorSwipe':'drawer';
 if(type)drag={id:e.pointerId,type,x:e.clientX,y:e.clientY,t:performance.now(),dx:0,active:false,note:noteSwipe?note:null,queue:e.target.closest('.historyCard')};
});
document.addEventListener('pointermove',e=>{
 if(!drag||drag.id!==e.pointerId)return;
 const d=drag,closingDrawer=d.type==='closeDrawer';
 const travel=e.clientX-d.x,dy=e.clientY-d.y;
 if(d.type==='generatorSwipe'&&Math.abs(travel)>=8)d.type=travel<0?'toNotes':'drawer';
 const dx=closingDrawer||d.type==='toNotes'?-travel:travel;
 if(!d.active){
  if(d.note&&(performance.now()-d.t>450||d.note.selectionStart!==d.note.selectionEnd)){drag=null;return;}
  if(Math.abs(dx)<8&&Math.abs(dy)<8)return;
  if(dx<0||Math.abs(dy)>Math.abs(dx)*1.2){drag=null;return;}
  if(dx<Math.abs(dy)*1.2)return;
  if(d.type==='browseBack'&&!CivitaiBrowser.beginSwipeBack()){drag=null;return;}
  d.active=true;document.body.classList.add('dragging');
  // After horizontal intent is clear, keep receiving the gesture as the
  // drawer covers the row. Ordinary taps and vertical scrolling stay native.
  if(d.type==='toNotes'||d.type==='fromNotes')$('#noteColumn').setPointerCapture(e.pointerId);
  else if(d.queue||d.note||d.type==='browseBack')$('#workspace').setPointerCapture(e.pointerId);
  if(d.note)d.note.blur();
  if(d.type==='viewer')$('#viewer').setPointerCapture(e.pointerId);
 }
 d.dx=Math.max(0,Math.min(dx,innerWidth));if(d.type==='viewer'){$('#viewer').style.transform='';$('#workspace').style.transform='translateX('+(-1+d.dx/innerWidth)*100+'%)';}
 if(d.type==='toNotes'||d.type==='fromNotes')document.body.style.setProperty('--note-offset',(d.type==='toNotes'?-d.dx:-innerWidth+d.dx)+'px');
 if(d.type==='browseBack')CivitaiBrowser.moveSwipeBack(d.dx);
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
 else if(d.type==='toNotes'||d.type==='fromNotes'){document.body.style.removeProperty('--note-offset');setNoteColumn(d.type==='toNotes'?commit:!commit);}
 else if(d.type==='browseBack')CivitaiBrowser.endSwipeBack(commit);
 else if(commit)bridgeBack();
}
document.addEventListener('pointerup',endDrag);document.addEventListener('pointercancel',endDrag);
document.addEventListener('click',e=>{if(performance.now()<swallowUntil){e.stopImmediatePropagation();e.preventDefault();}},true);
