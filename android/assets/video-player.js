/* Shared Library/Browse player. Only the center button toggles playback. */
const VideoPlayer=(()=>{
 const players=new Map();
 const icon=playing=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+(playing?'<path d="M8 5v14M16 5v14"/>':'<path d="m9 5 10 7-10 7z"/>')+'</svg>';
 const time=value=>{value=Math.max(0,Math.floor(Number(value)||0));return Math.floor(value/60)+':'+String(value%60).padStart(2,'0');};
 function mount(video,options={}){
  video.controls=false;video.playsInline=true;
  const shell=document.createElement('div');shell.className='unifiedVideo';
  shell.innerHTML='<div class="videoPicture"><button type="button" class="videoToggle bigPlay" aria-label="Play video"></button></div><div class="videoTimeline transport"><div class="videoTrack"><i></i><b></b></div><input class="videoSeek" type="range" min="0" max="1" value="0" step="any" aria-label="Video position"><div class="videoTimes"><strong class="videoCurrent">0:00</strong><span class="videoSlash" hidden>/</span><span class="videoTotal">0:00</span></div></div>';
  video.before(shell);const picture=shell.querySelector('.videoPicture');picture.prepend(video);
  const toggle=shell.querySelector('.videoToggle'),seek=shell.querySelector('input'),line=shell.querySelector('.videoTrack'),current=shell.querySelector('.videoCurrent'),total=shell.querySelector('.videoTotal'),slash=shell.querySelector('.videoSlash');
  let preparing=null,pendingSeek=null,disposed=false,posterWidth=options.width||0,posterHeight=options.height||0;
  const end=()=>Number.isFinite(video.duration)&&video.duration>0?video.duration:Number(options.duration)||0;
  function tick(){
   const duration=end(),position=pendingSeek??video.currentTime,progress=duration?Math.max(0,Math.min(1,position/duration)):0;
   seek.max=duration||1;seek.value=position;seek.disabled=!duration;
   seek.setAttribute('aria-valuetext',time(position)+' of '+time(duration));
   line.style.setProperty('--video-progress',(progress*100)+'%');
   current.textContent=time(position);total.textContent=time(duration);
   const width=shell.clientWidth,target=progress*width-current.offsetWidth/2;
   const limit=Math.max(0,width-total.offsetWidth-current.offsetWidth-34);
   current.style.left=Math.max(0,Math.min(target,limit))+'px';
   slash.hidden=target<limit;slash.style.right=(total.offsetWidth+16)+'px';
   toggle.innerHTML=icon(!video.paused);toggle.setAttribute('aria-label',video.paused?'Play video':'Pause video');
  }
  function refresh(){
   const bounds=options.bounds?.()||{width:shell.parentElement.clientWidth,height:Infinity};
   const w=video.videoWidth||posterWidth||16,h=video.videoHeight||posterHeight||9;
   const scale=Math.min(bounds.width/w,Math.max(1,bounds.height-54)/h);
   const width=w*scale,height=h*scale;shell.style.width=bounds.width+'px';picture.style.width=width+'px';picture.style.height=height+'px';tick();
   return {width,height,totalHeight:height+54};
  }
  async function prepare(){
   if(!preparing){toggle.disabled=true;toggle.classList.add('preparing');preparing=Promise.resolve().then(()=>options.prepare?.()).finally(()=>{preparing=null;toggle.disabled=false;toggle.classList.remove('preparing');});}
   return preparing;
  }
  async function playPause(){
   if(!video.paused){video.pause();tick();return;}
   try{await prepare();if(!disposed&&video.isConnected)await video.play();}catch(e){options.error?.(e);}finally{tick();}
  }
  toggle.onclick=e=>{e.stopPropagation();playPause();};
  toggle.addEventListener('pointerdown',e=>e.stopPropagation());
  const timeline=shell.querySelector('.videoTimeline');
  timeline.addEventListener('pointerdown',e=>e.stopPropagation());timeline.addEventListener('click',e=>e.stopPropagation());
  function applySeek(){if(pendingSeek!==null&&Number.isFinite(video.duration)){video.currentTime=Math.min(pendingSeek,video.duration);pendingSeek=null;}tick();}
  seek.oninput=async()=>{pendingSeek=Number(seek.value);tick();try{await prepare();if(!disposed)applySeek();}catch(e){pendingSeek=null;options.error?.(e);tick();}};
  const point=e=>{const rect=seek.getBoundingClientRect();seek.value=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*end();seek.oninput();};
  seek.onpointerdown=e=>{if(e.button!==0||seek.disabled)return;e.preventDefault();e.stopPropagation();seek.focus({preventScroll:true});seek.setPointerCapture(e.pointerId);point(e);};
  seek.onpointermove=e=>{if(seek.hasPointerCapture(e.pointerId))point(e);};
  seek.onpointerup=e=>{if(seek.hasPointerCapture(e.pointerId)){point(e);seek.releasePointerCapture(e.pointerId);}};
  const metadata=()=>{refresh();applySeek();};
  for(const event of ['timeupdate','play','pause','ended','durationchange'])video.addEventListener(event,tick);
  video.addEventListener('loadedmetadata',metadata);
  const observer=new ResizeObserver(refresh);observer.observe(shell.parentElement);
  const poster=new Image();poster.onload=()=>{if(disposed)return;posterWidth=poster.naturalWidth;posterHeight=poster.naturalHeight;refresh();video.dispatchEvent(new Event('playergeometry'));};if(video.poster)poster.src=video.poster;
  const api={shell,refresh,playPause,dispose(){if(disposed)return;disposed=true;video.pause();observer.disconnect();poster.onload=null;for(const event of ['timeupdate','play','pause','ended','durationchange'])video.removeEventListener(event,tick);video.removeEventListener('loadedmetadata',metadata);players.delete(video);}};
  players.set(video,api);video.sharedPlayer=api;refresh();return api;
 }
 new MutationObserver(()=>{for(const [video,player] of players)if(!video.isConnected)player.dispose();}).observe(document.body,{childList:true,subtree:true});
 return {mount};
})();
