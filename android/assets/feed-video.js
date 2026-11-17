/* Visible feed playback. Uses Browse's existing byte cache; no metadata polling. */
const FeedVideo=(()=>{
 const records=new Set(),states=new WeakMap();let observer,scheduled=false;
 const svg=body=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+body+'</svg>';
 const pauseIcon=svg('<path d="M8 5v14M16 5v14"/>'),playIcon=svg('<path d="m9 5 10 7-10 7z"/>');
 const speaker=muted=>svg('<path d="M11 4 6 8H3v8h3l5 4z"/>'+(muted?'<path d="M21 3 3 21"/>':'<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'));
 function allowed(){return !document.hidden&&document.body.dataset.page==='browse'&&!document.body.classList.contains('civitaiViewerOpen')&&!document.querySelector('#drawer.open,#modal[open]');}
 function paint(r){
  const playing=!r.video.paused;r.toggle.innerHTML=playing?pauseIcon:playIcon;r.toggle.setAttribute('aria-label',playing?'Pause video':'Play video');
  r.sound.innerHTML=speaker(r.video.muted);r.sound.setAttribute('aria-label',r.video.muted?'Unmute video':'Mute video');r.sound.setAttribute('aria-pressed',String(!r.video.muted));
  const seconds=Math.max(0,Math.ceil(r.video.duration-r.video.currentTime));r.badge.textContent=Number.isFinite(seconds)?Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'–:––';
 }
 function eligible(r){return allowed()&&r.visible&&r.card.isConnected&&!r.card.classList.contains('cardPending');}
 function release(r){clearTimeout(r.releaseTimer);r.releaseTimer=0;r.position=r.video.currentTime||r.position||0;r.video.removeAttribute('src');r.video.load();r.video.classList.remove('ready');}
 async function update(r){
  if(!eligible(r)){r.video.pause();if(!r.releaseTimer&&r.video.getAttribute('src'))r.releaseTimer=setTimeout(()=>release(r),30000);return;}
  clearTimeout(r.releaseTimer);r.releaseTimer=0;if(r.userPaused){r.video.pause();return;}
  if(!r.video.getAttribute('src')){
   if(r.loading)return;r.loading=true;r.toggle.classList.add('loading');
   try{const url=await r.source();if(eligible(r)){r.video.src=url||r.fallback;r.video.load();}}
   catch{r.failed=true;}finally{r.loading=false;r.toggle.classList.remove('loading');}
  }
  if(eligible(r)&&!r.userPaused&&r.video.getAttribute('src')&&r.video.paused)try{await r.video.play();}catch{paint(r);}
 }
 function refresh(){
  scheduled=false;
  for(const r of records){
   if(!r.card.isConnected){r.video.pause();observer.unobserve(r.card);records.delete(r);release(r);continue;}
   update(r);
  }
  // History restores the same DOM nodes, preserving manual pause and mute choices.
  document.querySelectorAll('.browseTile.hasFeedVideo').forEach(card=>{const r=states.get(card);if(r&&!records.has(r)){r.visible=false;records.add(r);observer.observe(card);}});
 }
 function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(refresh);}}
 function init(){if(observer)return;
  observer=new IntersectionObserver(entries=>{for(const e of entries){const r=states.get(e.target);if(!r)continue;const h=Math.min(e.boundingClientRect.height,e.rootBounds?.height||innerHeight);r.visible=e.isIntersecting&&e.intersectionRect.height>=Math.min(100,h*.3);update(r);}},{root:document.querySelector('#workspace'),threshold:[0,.1,.25,.5,.75,1]});
  new MutationObserver(changes=>{if(changes.some(c=>c.type==='attributes'||[...c.addedNodes,...c.removedNodes].some(n=>n.nodeType===1&&(n.matches?.('.browseTile,.civitaiViewer,.civitaiBrowse')||n.querySelector?.('.hasFeedVideo')))))schedule();}).observe(document.querySelector('#main'),{childList:true,subtree:true});
  const gates=new MutationObserver(schedule);gates.observe(document.body,{attributes:true,attributeFilter:['class','data-page']});
  for(const el of document.querySelectorAll('#drawer,#modal'))gates.observe(el,{attributes:true,attributeFilter:['class','hidden','open']});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){for(const r of records)r.video.pause();}else schedule();});
 }
 function attach(card,source,fallback){init();card.classList.add('hasFeedVideo');
  const media=card.querySelector('.browseMedia'),video=document.createElement('video');video.className='feedVideo';video.muted=true;video.defaultMuted=true;video.loop=true;video.playsInline=true;video.preload='none';video.setAttribute('aria-hidden','true');media.prepend(video);
  const toggle=document.createElement('button');toggle.type='button';toggle.className='feedVideoToggle';card.append(toggle);
  const collect=card.querySelector('.feedCollect'),stack=document.createElement('div');stack.className='feedCollectStack';collect.replaceWith(stack);stack.append(collect);
  const sound=document.createElement('button');sound.type='button';sound.className='feedSound';stack.prepend(sound);
  const r={card,video,toggle,sound,badge:card.querySelector('.browseVideo'),source,fallback,visible:false,userPaused:false};states.set(card,r);records.add(r);
  toggle.onclick=e=>{e.stopPropagation();r.userPaused=!video.paused;if(r.userPaused)video.pause();else{r.failed=false;update(r);}paint(r);};
  sound.onclick=e=>{e.stopPropagation();video.muted=!video.muted;if(!video.muted)for(const other of records)if(other!==r){other.video.muted=true;paint(other);}paint(r);};
  for(const event of ['play','pause','timeupdate','durationchange','loadedmetadata'])video.addEventListener(event,()=>paint(r));
  video.addEventListener('loadedmetadata',()=>{if(r.position&&Number.isFinite(video.duration)){video.currentTime=Math.min(r.position,video.duration);r.position=0;}});
  video.addEventListener('loadeddata',()=>{video.classList.add('ready');paint(r);});
  video.addEventListener('error',()=>{video.classList.remove('ready');paint(r);});
  paint(r);observer.observe(card);
 }
 return {attach,refresh:schedule};
})();
