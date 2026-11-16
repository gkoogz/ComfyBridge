'use strict';
// One account on the paired PC, shared across devices. No Civitai credentials here.
const CivitaiBrowser=(()=>{
 let account='',status=null,feed=[],strip=[],cursor='',stripCursor='',channel='',busy=false,stripBusy=false,session=0,timer,observer,viewer=null,lastStatus=0;
 let view={kind:'mix'}, history=[], feedEnded=false, collectionPopup=null;
 let muted={},refreshing=false,warmTimer,bottomTimer,detailQueue=[],detailRunning=false,cacheScope='',stripResume=false,emptyPages=0,suppressTap=0;
 const details=new Map(),detailRequests=new Map(),imageRequests=new Map();
 const emoji={Like:'👍',Heart:'❤️',Laugh:'😂',Cry:'😢'};
 const path=p=>'/'+String(p||'').replace(/^\//,'');
 const button=(label,attrs='')=>'<button '+attrs+'>'+label+'</button>';
 const thumbURL=item=>assetCache.get(path(item.path))||(item.cacheAsset&&item.cacheSample&&ModelPreviews.url(item.cacheAsset,item.cacheSample))||path(item.path);
 const imageHTML=(item,full=false)=>item.type==='video'&&full?'<video controls playsinline preload="none" poster="'+esc(thumbURL(item))+'" src="'+esc(path(item.fullPath))+'"></video>':'<img width="'+(Number(item.width)||512)+'" height="'+(Number(item.height)||768)+'" loading="lazy" decoding="async" src="'+esc(thumbURL(item))+'" alt="Civitai '+(item.type==='video'?'video preview':'image')+'">';
 const ribbonIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
 const copyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h12v13H8zM16 8V3H3v13h5"/></svg>';
 const caretIcon=down=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(down?'M5 8l7 7 7-7':'M5 16l7-7 7 7')+'"/></svg>';
 function promptHTML(item){
  return '<div class="civitaiPromptBlocks">'+[['prompt','Prompt'],['negativePrompt','Negative prompt']].map(([key,label])=>{
   if(key==='negativePrompt'&&!item[key])return '';
   return '<h2>'+label+'</h2><p class="modelPreviewPrompt">'+esc(item[key]||'The uploader did not share a prompt.')+'</p>'+
    (item[key]?button(copyIcon,'class="promptCopy" data-copy-prompt="'+key+'" aria-label="Copy '+label.toLowerCase()+'"'):'');
  }).join('')+'</div>';
 }
 function wirePromptCopies(host,item){
  $$('[data-copy-prompt]',host).forEach(b=>b.onclick=async()=>{
   try{
    const text=item[b.dataset.copyPrompt]||'';
    if(window.Native?.copyText)await Native.copyText(text);else await navigator.clipboard.writeText(text);
    toast('Prompt copied');
   }catch{toast('Could not copy prompt');}
  });
 }
 const assetCache=new Map();
 function scope(){
  let config={};try{config=window.Native?JSON.parse(Native.configuration()):{};}catch{}
  return 'comfybridge-browse-v2:'+encodeURIComponent(config.fingerprint||config.host||(window.Desktop?'desktop':'local'));
 }
 function saveSnapshot(){
  if(!account||!status||view.kind!=='mix')return;
  try{
   const snapshot={account,status,channel,strip:strip.slice(0,20),feed:feed.filter(i=>!isMuted(i)).slice(-10),muted,
    details:[...details.entries()].filter(([key])=>key.startsWith(account+':')).slice(-100),saved:Date.now()};
   localStorage.setItem(scope(),JSON.stringify(snapshot));
  }catch{/* Storage pressure must never prevent browsing. */}
 }
 function restoreSnapshot(){
  const key=scope();if(cacheScope===key&&status)return;
  reset();details.clear();muted={};account='';status=null;cacheScope=key;
  try{
   const data=JSON.parse(localStorage.getItem(key)||'null');if(!data?.account)return;
   account=data.account;status=data.status;channel=data.channel;strip=data.strip||[];stripResume=true;muted=data.muted||{};
   feed=(data.feed||[]).filter(i=>!isMuted(i));for(const entry of data.details||[])details.set(...entry);
  }catch{/* A damaged snapshot is replaced after the next successful fetch. */}
 }
 function isMuted(item){return Object.entries(muted).some(([id,v])=>v.until*1000>Date.now()&&
  (id===String(item.creatorId)||v.name&&v.name.toLowerCase()===String(item.credit||'').toLowerCase()));}
 async function imageBlob(url,onlyCached=false){
  if(assetCache.has(url))return assetCache.get(url);
  if(imageRequests.has(url))return imageRequests.get(url);
  const work=(async()=>{
   const cache=await caches.open('comfybridge-browse-v1');let r=await cache.match(url);
   if(!r){
    if(onlyCached)return '';
    r=await fetch(url);if(!r.ok)throw Error('Preview unavailable');
    const blob=await r.blob();if(blob.size>8*1024*1024)return '';
    r=new Response(blob,{headers:{'Content-Type':blob.type,'X-Browse-Bytes':String(blob.size)}});await cache.put(url,r.clone());
   }
   const object=URL.createObjectURL(await r.blob());assetCache.set(url,object);
   return object;
  })();imageRequests.set(url,work);
  try{return await work;}finally{imageRequests.delete(url);}
 }
 async function cachedImage(img){
  const url=img.getAttribute('src');if(!url?.startsWith('/model-preview/browse/'))return;
  try{const object=await imageBlob(url);if(object&&img.isConnected&&img.getAttribute('src')===url)img.src=object;}catch{}
 }
 async function trimImages(){
  try{
   const protectedURLs=new Set([...strip.slice(0,20),...feed.slice(-10)].map(i=>path(i.path)));
   const cache=await caches.open('comfybridge-browse-v1'),keys=await cache.keys();let bytes=0,count=0;
   for(const key of [...keys.filter(k=>protectedURLs.has(new URL(k.url).pathname)),...keys.filter(k=>!protectedURLs.has(new URL(k.url).pathname)).reverse()]){
    const r=await cache.match(key);bytes+=Number(r?.headers.get('X-Browse-Bytes')||0);count++;
    if((count>180||bytes>96*1024*1024)&&!protectedURLs.has(new URL(key.url).pathname))await cache.delete(key);
   }
   while(assetCache.size>200){const [key,value]=assetCache.entries().next().value;
    assetCache.delete(key);URL.revokeObjectURL(value);}
  }catch{}
 }
 function detailKey(id){return account+':'+id;}
 function fetchDetail(item,fresh=false){
  const key=detailKey(item.id),boundAccount=account,old=details.get(key);
  if(!fresh&&old)return Promise.resolve(old.result);
  if(detailRequests.has(key))return detailRequests.get(key);
  const request=api('browse/detail/'+item.id).then(result=>{
   if(boundAccount&&result.account!==boundAccount)throw Error('Civitai account changed. Refresh Browse.');
   if(boundAccount!==account)throw Error('Civitai account changed. Refresh Browse.');
   details.delete(key);details.set(key,{result,at:Date.now()});
   while(details.size>100)details.delete(details.keys().next().value);
   Object.assign(item,result.item);saveSnapshot();return result;
  }).finally(()=>detailRequests.delete(key));
  detailRequests.set(key,request);return request;
 }
 function queueDetail(item,priority=false){
  if(!item?.id||details.has(detailKey(item.id))||detailQueue.some(i=>i.id===item.id))return;
  priority?detailQueue.unshift(item):detailQueue.push(item);detailQueue=detailQueue.slice(0,60);runDetails();
 }
 function backgroundAllowed(){return available()&&!syncing&&!filling&&!originalTransfers.size;}
 async function runDetails(){
  if(detailRunning||!backgroundAllowed()||busy||stripBusy)return;
  detailRunning=true;
  try{while(detailQueue.length&&backgroundAllowed()&&!busy&&!stripBusy){
   const item=detailQueue.shift();try{await fetchDetail(item);}catch{break;}
  }}finally{detailRunning=false;}
 }
 function warm(){
  clearTimeout(warmTimer);warmTimer=setTimeout(async()=>{
   if(!available())return;
   if(!backgroundAllowed()){warm();return;}
   const ticket=session,items=[...feed.slice(-10),...strip.slice(0,20)];
   for(const item of items){
    if(!backgroundAllowed()||ticket!==session){warm();return;}
    try{await imageBlob(path(item.path));}catch{}
    queueDetail(item);
   }
   await trimImages();saveSnapshot();runDetails();
  },150);
 }
 const nearDetails=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting&&e.target.browseItem)queueDetail(e.target.browseItem,true);}),{rootMargin:'900px'});
 function paintCollections(){
  if(!status||!$('#browseCollectionLabel'))return;
  const reacted=channel==='reactions',choice=status.collections.find(c=>'collection:'+c.id===channel);
  $('#browseSourceLabel').textContent=reacted?'Reacted media':'Collection';
  $('#browseCollections').hidden=reacted;$('#browseCollectionDot').hidden=reacted;
  $('#browseCollectionLabel').textContent=choice?.name||'Choose collection';
  $('#browseItemCount').textContent=(choice?.count??strip.length)+' items';
  $('#browseCollectionMenu').innerHTML=status.collections.map(c=>button(esc(c.name),'role="menuitemradio" aria-checked="'+('collection:'+c.id===channel)+'" data-channel="collection:'+c.id+'"')).join('')+button('＋ New collection','id="browseCreate"');
  $$('[data-channel]').forEach(b=>b.onclick=()=>selectChannel(b.dataset.channel==='collection'?'collection:'+(status.collections[0]?.id||''):b.dataset.channel));
  $('#browseCreate').onclick=()=>{closeMenus();createCollection();};
  $('#browseEmptyCollections').hidden=status.collections.length>0;paintStatus();
 }
 function closeMenus(){$$('#browseCollections,#browseSources').forEach(el=>el.open=false);}
 function selectChannel(value){
  closeMenus();if(value==='collection:'){createCollection();return;}
  if(channel===value)return;channel=value;strip=[];stripCursor='';stripBusy=false;stripResume=false;
  $('#browseCarousel').replaceChildren();paintCollections();saveSnapshot();loadStrip();
 }
 async function refresh(){
  if(refreshing||view.kind==='preferences')return;refreshing=true;
  $('#browseRefresh')?.classList.add('refreshing');$('#browsePull')?.classList.add('refreshing');
  const ticket=++session;busy=false;stripBusy=false;cursor='';stripCursor='';stripResume=false;feedEnded=false;emptyPages=0;details.clear();detailQueue=[];
  // Retain visible/cache content until each replacement request succeeds.
  try{await refreshStatus(true);if(ticket!==session)return;await Promise.all([loadFeed(true),view.kind==='mix'?loadStrip(true):Promise.resolve()]);}
  catch(e){if($('#browseError'))$('#browseError').textContent=e.message;}
  finally{refreshing=false;$('#browseRefresh')?.classList.remove('refreshing');$('#browsePull')?.classList.remove('refreshing');$('#browsePull')?.style.removeProperty('height');}
 }
 function pullToRefresh(){
  const workspace=document.querySelector('#workspace');let gesture=null;
  workspace.addEventListener('touchstart',e=>{
   if(page!=='browse'||view.kind==='preferences'||workspace.scrollTop>0||refreshing||viewer||e.touches.length!==1||e.target.closest('button:not(.browseMedia),summary,input,.browseCarousel'))return;
   gesture={x:e.touches[0].clientX,y:e.touches[0].clientY,amount:0};
  },{passive:true});
  workspace.addEventListener('touchmove',e=>{
   if(!gesture)return;
   const dx=e.touches[0].clientX-gesture.x,dy=e.touches[0].clientY-gesture.y;
   if(Math.abs(dx)>Math.abs(dy)||dy<0){gesture=null;$('#browsePull')?.style.removeProperty('height');return;}
   if(dy<8)return;e.preventDefault();e.stopPropagation();gesture.amount=Math.min(90,dy*.48);suppressTap=Date.now()+500;
   const pull=$('#browsePull');if(pull){pull.style.height=gesture.amount+'px';pull.classList.toggle('ready',gesture.amount>=55);pull.setAttribute('aria-label',gesture.amount>=55?'Release to refresh':'Pull to refresh');}
  },{passive:false});
  const end=e=>{if(!gesture)return;const ready=gesture.amount>=55&&e.type!=='touchcancel';gesture=null;
   if(ready)refresh();else $('#browsePull')?.style.removeProperty('height');};
  workspace.addEventListener('touchend',end);workspace.addEventListener('touchcancel',end);
 }
 pullToRefresh();
 const imagesNear=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){imagesNear.unobserve(e.target);cachedImage(e.target);}}),{rootMargin:'250px'});
 function hydrate(root){root.querySelectorAll('img').forEach(img=>{img.addEventListener('error',()=>{img.classList.add('failed');img.alt='Preview unavailable · tap to retry';},{once:true});imagesNear.observe(img);});}
 function reset(){feed=[];strip=[];cursor='';stripCursor='';channel='';stripResume=false;emptyPages=0;}
 function available(){return page==='browse'&&!document.hidden&&connected;}
 function paintStatus(){
  const el=$('#browseImport');if(!el||!status)return;
  const s=status.importState||{};
  el.textContent=s.error||(!s.complete?(s.label||'Preparing your personal feed')+' · '+(status.learned||0)+' media learned':(status.learned||0)+' media shape your feed · '+status.follows+' followed creators');
  el.textContent+=' ›';el.classList.toggle('warning',!!s.error);
 }
 async function refreshStatus(force=false){
  if(view.kind!=='mix'||!available()||(!force&&Date.now()-lastStatus<14000))return;lastStatus=Date.now();
  const s=await api('browse/status');if(!available())return;
  if(account&&account!==s.account){reset();details.clear();detailQueue=[];muted={};close();$('#browseFeed')?.replaceChildren();$('#browseCarousel')?.replaceChildren();}
  account=s.account;status=s;$('#browseHello').textContent='Hello '+s.username;
  muted=s.timeouts||muted;
  if(!channel||(channel!=='reactions'&&!s.collections.some(c=>'collection:'+c.id===channel)))channel=s.collections.length?'collection:'+s.collections[0].id:'reactions';
  feed=feed.filter(i=>!isMuted(i));
  $$('.browseTile').forEach(el=>{if(isMuted(el.browseItem||{}))el.remove();});
  paintCollections();saveSnapshot();

 }
 async function render(){
  view={kind:'mix'};history=[];feedEnded=false;busy=false;stripBusy=false;
  const ticket=++session;clearTimeout(timer);observer?.disconnect();nearDetails.disconnect();restoreSnapshot();
  $('#main').innerHTML='<section class="civitaiBrowse"><div id="browsePull" role="status" aria-label="Pull to refresh"><i class="spinner"></i></div><p id="browseError" class="warning" role="status"></p><div id="browseConnected" hidden><div class="browseCollectionHeading"><details id="browseSources"><summary><u id="browseSourceLabel">Collection</u>'+caretIcon(true)+'</summary><div class="browseMenu" role="menu">'+button('Collection','data-channel="collection"')+button('Reacted media','data-channel="reactions"')+'</div></details><span id="browseCollectionDot">•</span><details id="browseCollections"><summary aria-label="Choose a media collection"><u id="browseCollectionLabel">Choose collection</u>'+caretIcon(true)+'</summary><div id="browseCollectionMenu" class="browseMenu" role="menu"></div></details><small id="browseItemCount"></small></div><p id="browseEmptyCollections" hidden>No media collections yet. Create one in the collection menu.</p><div id="browseCarousel" class="browseCarousel"></div><div class="browseFeedHeading"><h2>For you</h2><button id="browseImport" aria-label="Edit feed preferences"></button></div><div id="browseFeed" class="browseFeed"></div>'+button('Load more','id="browseMore"')+'</div></section>';
  $('#browseRefresh').onclick=refresh;
  $('#browseImport').onclick=openPreferences;$('#browseMore').onclick=()=>loadFeed();
  $('#browseCarousel').onscroll=()=>{const el=$('#browseCarousel');if(el.scrollLeft+el.clientWidth>el.scrollWidth-350)loadStrip();};
  // Restore metadata and device files before waiting for the PC or Civitai.
  if(status){
   await Promise.all([...strip,...feed].map(i=>imageBlob(path(i.path),true).catch(()=>{})));
   if(ticket!==session)return;
   $('#browseConnected').hidden=false;$('#browseHello').textContent='Hello '+status.username;
   paintCollections();paintFeed(feed);paintStrip(strip);
  }
  if(!connected){$('#browseError').textContent='Showing saved Browse. Connect to your PC to refresh.';schedule();return;}
  try{
   await refreshStatus(true);if(ticket!==session)return;
   $('#browseConnected').hidden=false;
   // Server cursors are intentionally not persisted: a worker can restart.
   if(!strip.length)loadStrip();if(!feed.length)loadFeed();
   observeMore();warm();if(stripResume)loadStrip();
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  schedule();
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{
  if(page!=='browse')return;
  if(available())try{if($('#browseConnected')?.hidden){render();return;}await refreshStatus();}catch(e){if($('#browseError'))$('#browseError').textContent=e.message;}
  schedule();
 },15000);}
 function tile(item,small=false){
  const el=document.createElement('article');
  el.className=small?'browseThumb':'browseTile';el.browseItem=item;nearDetails.observe(el);
  el.innerHTML='<button class="browseMedia" aria-label="Open '+esc(item.type)+' by '+esc(item.credit)+'">'+imageHTML(item)+(item.type==='video'?'<span class="browseVideo">▶</span>':'')+'</button>';
  $('.browseMedia',el).onclick=()=>open(item,small?strip:feed);
  if(!small){
   const caption=document.createElement('div');
   caption.className='browseCaption';
   caption.innerHTML=button(esc(item.credit||'Creator'),'class="feedAuthor"')+button('<svg viewBox="0 0 24 24"><path d="M9 2h6M12 2v3m6 1 2 2M12 9v5l3 2"/><circle cx="12" cy="14" r="8"/></svg>','class="feedTimeout" aria-label="Silence creator for two hours"')+
    '<div class="feedReactions">'+Object.entries(emoji).map(([key,value])=>button(value+' <small>'+reactionCount(item,key)+'</small>','data-feed-react="'+key+'" aria-label="'+key+'" aria-pressed="'+item.reactions.includes(key)+'"')).join('')+'</div>'+
    button('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>','class="feedCollect" aria-label="Add to collection"');
   el.append(caption);
   $('.feedAuthor',caption).onclick=async()=>{
    try{
     if(!item.creatorId){const detail=await api('browse/detail/'+item.id);Object.assign(item,detail.item);}
     openSubject('creator',item.creatorId,item.credit);
    }catch(error){toast(error.message);}
   };
   const boundAccount=account;
   $('.feedTimeout',caption).onclick=async e=>{
    const b=e.currentTarget;b.disabled=true;
    try{
     if(!item.creatorId)Object.assign(item,(await fetchDetail(item)).item);
     const result=await action({account:boundAccount,kind:'timeout',creatorId:item.creatorId,name:item.credit});
     if(account!==boundAccount)return;muted[result.creatorId]={until:result.until,name:item.credit};
     if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem))el.remove();});saveSnapshot();observeMore();}
     toast(item.credit+' silenced in For you for 2 hours');
    }catch(error){toast(error.message);}finally{b.disabled=false;}
   };
   $$('[data-feed-react]',caption).forEach(b=>b.onclick=async()=>{
    const reaction=b.dataset.feedReact, selected=item.reactions.includes(reaction);
    b.disabled=true;
    try{
     const result=await action({account:boundAccount,kind:'reaction',imageId:item.id,reaction,selected:!selected});
     const wasSelected=item.reactions.includes(reaction);
     item.reactions=result.reactions;
     if(wasSelected!==item.reactions.includes(reaction)){
      const count=Math.max(0,reactionCount(item,reaction)+(wasSelected?-1:1));
      item.stats[reaction.toLowerCase()+'CountAllTime']=count;
     }
     b.innerHTML=emoji[reaction]+' <small>'+reactionCount(item,reaction)+'</small>';
     b.setAttribute('aria-pressed',String(item.reactions.includes(reaction)));
    }catch(error){toast(error.message);}finally{b.disabled=false;}
   });
   $('.feedCollect',caption).onclick=()=>showCollections(item,boundAccount);
  }
  hydrate(el);
  return el;
 }
 function reactionCount(item,key){
  return Number(item.stats?.[key.toLowerCase()+'CountAllTime']??item.stats?.[key.toLowerCase()+'Count']??0);
 }
 function saveView(){
  observer?.disconnect();
  const main=$('#main');
  history.push({view,feed,cursor,feedEnded,scroll:$('#workspace').scrollTop,nodes:[...main.childNodes]});
  main.replaceChildren();
  session++;busy=false;stripBusy=false;
 }
 function back(){
  if(collectionPopup){collectionPopup.remove();collectionPopup=null;return true;}
  if(!history.length)return false;
  observer?.disconnect();session++;busy=false;stripBusy=false;
  const saved=history.pop();
  view=saved.view;feed=saved.feed;cursor=saved.cursor;feedEnded=saved.feedEnded;
  $('#main').replaceChildren(...saved.nodes);
  if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem))el.remove();});saveSnapshot();}
  $('#workspace').scrollTop=saved.scroll;
  if(view.kind!=='preferences')observeMore();
  return true;
 }
 function observeMore(){
  observer?.disconnect();
  if(!$('#browseMore')||feedEnded)return;
  observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&emptyPages<2)loadFeed();},{rootMargin:'550px'});
  observer.observe($('#browseMore'));
 }
 function openSubject(kind,id,name){
  if(!id)return;
  saveView();
  view={kind,id:String(id),name,filter:'all'};
  feed=[];cursor='';feedEnded=false;
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+'<h2>'+esc(name)+'</h2><div class="subjectFilters">'+
   [['image','▧','Images'],['video','▷','Videos'],['all','▦','All media']].map(([value,icon,label])=>button(icon,'data-media-filter="'+value+'" aria-label="'+label+'" title="'+label+'" aria-pressed="'+(value==='all')+'"')).join('')+'</div></div><p id="browseError" class="warning" role="status"></p><div id="browseFeed" class="browseFeed"></div>'+button('Load more','id="browseMore"')+'</section>';
  $('.browseBack').onclick=back;
  $$('[data-media-filter]').forEach(b=>b.onclick=()=>{
   view.filter=b.dataset.mediaFilter;
   $$('[data-media-filter]').forEach(other=>other.setAttribute('aria-pressed',String(other===b)));
   session++;busy=false;feed=[];cursor='';feedEnded=false;$('#browseFeed').replaceChildren();
   $('#browseMore').hidden=false;loadFeed();observeMore();
  });
  $('#browseMore').onclick=loadFeed;
  $('#workspace').scrollTop=0;loadFeed();observeMore();
 }
 async function openPreferences(){
  saveView();view={kind:'preferences'};
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+'<h2>Your feed</h2></div><p class="preferenceError warning" role="status"></p><div id="weightActive"></div><div id="weightDisabled"></div></section>';
  $('.browseBack').onclick=back;$('#workspace').scrollTop=0;
  try{await refreshPreferences();}catch(error){$('.preferenceError').textContent=error.message;}
 }
 async function refreshPreferences(){
  const ticket=session;
  const result=await api('browse/preferences');
  if(ticket!==session||view.kind!=='preferences')return;
  if(result.account!==account){reset();render();return;}
  const positions=new Map($$('.weightRow').map(row=>[row.dataset.key,row.getBoundingClientRect().top]));
  $('#weightActive').replaceChildren();$('#weightDisabled').replaceChildren();
  for(const item of result.items){
   const row=document.createElement('div');
   row.className='weightRow'+(item.disabled?' disabled':'');row.dataset.key=item.kind+':'+item.id;
   row.innerHTML=button(esc(item.name),'class="weightName"')+'<small>'+esc(item.kind==='creator'?'Creator':'Tag')+'</small><strong>'+item.weight+'</strong>'+
    button('↑','data-adjust="1" aria-label="Increase weight"')+button('↓','data-adjust="-1" aria-label="Decrease weight"')+
    button(item.disabled?'↶':'×','class="weightRemove" aria-label="'+(item.disabled?'Restore to feed':'Remove from feed')+'"');
   $('.weightName',row).onclick=()=>openSubject(item.kind,item.id,item.name);
   async function change(values){
    $$('button',row).forEach(b=>b.disabled=true);
    try{
     await action({account:result.account,kind:'preference',subject:item.kind,id:item.id,...values});
     await refreshPreferences();
    }catch(error){$('.preferenceError').textContent=error.message;$$('button',row).forEach(b=>b.disabled=false);}
   }
   $$('[data-adjust]',row).forEach(b=>{b.disabled=item.disabled;b.onclick=()=>change({delta:Number(b.dataset.adjust)});});
   $('.weightRemove',row).onclick=()=>change({disabled:!item.disabled});
   $(item.disabled?'#weightDisabled':'#weightActive').append(row);
  }
  if(!result.items.length)$('#weightActive').textContent='Preferences will appear as your Civitai history is imported.';
  for(const row of $$('.weightRow')){
   const old=positions.get(row.dataset.key);
   if(old!=null&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const dy=old-row.getBoundingClientRect().top;
    row.animate([{transform:'translateY('+dy+'px)',opacity:.55},{transform:'translateY(0)',opacity:1}],{duration:260,easing:'ease-out'});
   }
  }
 }
 async function showCollections(item,boundAccount){
  if(collectionPopup)collectionPopup.remove();
  const popup=document.createElement('div');
  popup.className='feedCollectionShade';collectionPopup=popup;
  popup.innerHTML='<section role="dialog" aria-modal="true" aria-label="Collections"><div class="row spread"><strong>Collections</strong>'+button('×','class="collectionClose" aria-label="Close collections"')+'</div><div class="feedCollectionChoices">Loading…</div><div class="newCollectionAnchor"></div><p class="warning" role="status"></p></section>';
  document.body.append(popup);
  function dismiss(){popup.remove();if(collectionPopup===popup)collectionPopup=null;}
  $('.collectionClose',popup).onclick=dismiss;
  popup.onclick=e=>{if(e.target===popup)dismiss();};
  async function refresh(){
   const result=await fetchDetail(item,true);
   if(!popup.isConnected)return;
   if(result.account!==boundAccount)throw Error('Civitai account changed. Reopen this menu.');
   const members=membershipIds(result.item.collections),host=$('.feedCollectionChoices',popup);
   host.innerHTML=result.collections.map(c=>'<label><input type="checkbox" value="'+c.id+'" '+(members.includes(String(c.id))?'checked':'')+'>'+esc(c.name)+'</label>').join('');
   $$('input',host).forEach(box=>box.onchange=async()=>{
    box.disabled=true;
    try{await action({account:boundAccount,kind:'collect',imageId:item.id,collectionId:box.value,selected:box.checked});}
    catch(error){box.checked=!box.checked;$('p.warning',popup).textContent=error.message;}
    finally{box.disabled=false;}
   });
   const anchor=$('.newCollectionAnchor',popup);
   anchor.innerHTML=button('＋ New collection','class="newCollection"');
   $('.newCollection',anchor).onclick=()=>createCollection(anchor,refresh,boundAccount);
  }
  try{await refresh();}catch(error){if(popup.isConnected)$('p.warning',popup).textContent=error.message;}
 }
 function paintFeed(items){const el=$('#browseFeed');if(el)items.forEach(i=>el.append(tile(i)));}
 function paintStrip(items){const el=$('#browseCarousel');if(el)items.forEach(i=>el.append(tile(i,true)));}
 async function loadFeed(replace=false){
  replace=replace===true;
  if(busy||feedEnded||!available()||!$('#browseMore'))return;busy=true;const ticket=session;$('#browseMore').innerHTML='<i class="spinner"></i> Finding inspiration…';
  try{const r=await api('browse/feed',{channel:view.kind==='mix'?'mix':view.kind+':'+view.id+':'+view.filter,cursor});if(ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   if(replace){feed=[];$('#browseFeed').replaceChildren();}
   const added=r.items.filter(i=>!(view.kind==='mix'&&isMuted(i))&&!feed.some(x=>x.id===i.id));feed.push(...added);cursor=r.nextCursor||'';feedEnded=!r.nextCursor;paintFeed(added);saveSnapshot();warm();$('#browseError').textContent='';
   emptyPages=added.length?0:emptyPages+1;
   if(!added.length)$('#browseError').textContent='No new media in this page. Try Load more or refresh.';
  }catch(e){if(ticket===session){emptyPages=2;$('#browseError').textContent=e.message;}}
  finally{if(ticket===session){busy=false;if($('#browseMore')){$('#browseMore').textContent='Load more';$('#browseMore').hidden=feedEnded;}checkBottom();}}
 }
 function checkBottom(){
  if(!available()||busy||feedEnded||emptyPages>=2||view.kind==='preferences')return;
  const more=$('#browseMore'),workspace=$('#workspace');
  if(more&&!more.hidden&&more.getBoundingClientRect().top<workspace.getBoundingClientRect().bottom+550){
   clearTimeout(bottomTimer);bottomTimer=setTimeout(()=>{
    const current=$('#browseMore');if(current&&current.getBoundingClientRect().top<workspace.getBoundingClientRect().bottom+550&&emptyPages<2)loadFeed();
   },120);
  }
 }
 document.querySelector('#workspace').addEventListener('scroll',checkBottom,{passive:true});
 async function loadStrip(replace=false){
  replace=replace===true;
  if(stripBusy||!available()||(!replace&&!stripResume&&strip.length&&!stripCursor))return;stripBusy=true;const chosen=channel,ticket=session;
  try{const r=await api('browse/feed',{channel:chosen,cursor:stripCursor});if(chosen!==channel||ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   if(replace){strip=[];$('#browseCarousel').replaceChildren();}
   const added=r.items.filter(i=>!strip.some(x=>x.id===i.id));strip.push(...added);stripCursor=r.nextCursor||'';stripResume=stripResume&&!added.length&&!!stripCursor;paintStrip(added);paintCollections();saveSnapshot();warm();
   if(!strip.length)$('#browseCarousel').innerHTML='<p class="muted">No accessible media here yet.</p>';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{if(chosen===channel&&ticket===session){stripBusy=false;if((strip.length<20||stripResume)&&stripCursor)setTimeout(()=>loadStrip(),0);}}
 }
 async function action(data){const result=await api('browse/action',{account,...data,requestId:crypto.randomUUID()});if(data.imageId)details.delete(detailKey(data.imageId));else if(data.kind==='follow')details.clear();saveSnapshot();return result;}
 async function createCollection(parent,onCreated,boundAccount=account){
  const form=document.createElement('form');form.className='browseCollectionForm';form.innerHTML='<label>New private media collection<input name="name" maxlength="30" required placeholder="Collection name"></label><div class="row">'+button('Create','type="submit" class="green"')+button('Cancel','type="button"')+'</div><p role="status"></p>';
  (parent||$('.browseCollectionHeading')).after(form);form.querySelector('input').focus();form.querySelector('[type=button]').onclick=()=>form.remove();
  form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;
   try{const r=await action({account:boundAccount,kind:'create',name:form.querySelector('input').value});if(status)status.collections=r.collections;form.remove();if(page==='browse')await refreshStatus(true);toast('Collection created');if(onCreated)await onCreated();if(viewer)await detail(viewer);}
   catch(error){form.querySelector('p').textContent=error.message;}finally{b.disabled=false;}
  };
 }
 function resourcesHTML(resources){return '<ul class="modelPreviewResources civitaiResources">'+[...resources].sort((a,b)=>Number(/checkpoint/i.test(b.type))-Number(/checkpoint/i.test(a.type))).map(r=>{
  const isLora=/lora|locon|lycoris/i.test(r.type),url=r.modelId?'https://civitai.com/models/'+r.modelId+(r.versionId?'?modelVersionId='+r.versionId:''):'';
  return '<li><div class="civitaiResourceRow">'+(url?button(esc(r.name||r.type),'class="resourceName" data-civi-link="'+esc(url)+'"'):'<strong class="resourceName">'+esc(r.name||r.type)+'</strong>')+
   (isLora&&r.versionId?button('＋','class="resourceDownload" data-resource-download="'+esc(r.versionId)+'" data-civi-download="'+esc(r.versionId)+'" aria-label="Download LoRA"'):'')+
   '<span class="resourceType">'+esc(r.type)+'</span></div>'+(r.version?'<small>'+esc(r.version)+'</small>':'')+((r.weight!==''&&r.weight!=null)?'<small>Strength '+esc(r.weight)+'</small>':'')+'<div data-download-status="'+esc(r.versionId)+'"></div></li>';

 }).join('')+'</ul>';}
 async function wireResources(host){
  $$('[data-civi-link]',host).forEach(b=>b.onclick=()=>openModelSource(b.dataset.civiLink));
  const buttons=$$('[data-civi-download]',host);if(!buttons.length)return;
  const versions=buttons.map(b=>b.dataset.civiDownload);
  async function update(){
   if(!host.isConnected||document.hidden)return;
   try{const r=await api('lora-download/status',{versions});let running=false,finished=false;
    for(const b of buttons){const s=(r.items||r.statuses||[]).find?.(x=>String(x.versionId)===b.dataset.civiDownload)||r[b.dataset.civiDownload]||{};
     const installed=s.status==='installed',active=['queued','downloading','verifying'].includes(s.status);running ||= active;finished ||= installed&&b.dataset.wasActive==='true';if(active)b.dataset.wasActive='true';if(installed)delete b.dataset.wasActive;
     b.innerHTML=installed?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4L19 6"/></svg>':active?'<i class="spinner"></i>':'＋';b.disabled=installed||active;b.setAttribute('aria-label',installed?'LoRA already in your library':'Download LoRA');
     if(s.error)$('[data-download-status="'+b.dataset.civiDownload+'"]',host).textContent=s.error;
    }if(finished){const listing=await api('model-library');modelListings=listing.items||[];if(catalog){catalog.listings=modelListings;catalog.loras=[...new Set([...(catalog.loras||[]),...modelListings.filter(i=>i.kind==='loras').map(i=>i.name)])];}await ModelPreviews.register(modelListings,listing.nsfwHidden,listing.scanning);}if(running)setTimeout(update,1800);
   }catch(e){for(const b of buttons)b.title=e.message;}
  }
  buttons.forEach(b=>b.onclick=async()=>{const dest=$('[data-download-status="'+b.dataset.civiDownload+'"]',host);b.disabled=true;
   try{const plan=await api('lora-download/prepare/'+b.dataset.civiDownload);
    if(plan.status!=='confirm'){await update();return;}
    dest.innerHTML='<div class="resourceDownloadConfirm"><strong>'+esc(plan.title)+'</strong><p>'+esc([plan.version,plan.baseModel].filter(Boolean).join(' · '))+' · '+esc(modelSize(plan.bytes))+'</p><small>'+esc(plan.filename||'')+'</small><div class="row">'+button('Download to PC','class="green" data-accept-download')+button('Cancel','data-reject-download')+'</div></div>';
    $('[data-reject-download]',dest).onclick=()=>{dest.replaceChildren();b.disabled=false;};
    $('[data-accept-download]',dest).onclick=async()=>{try{await api('lora-download/start',{confirmation:plan.confirmation});dest.textContent='Downloading on your PC…';await update();}catch(e){dest.textContent=e.message;b.disabled=false;}};
   }catch(e){dest.textContent=e.message;b.disabled=false;}
  });update();
 }
 function socialHTML(item,collections){
  const followed=item.following;
  return '<div class="civitaiAuthor">'+(item.avatarPath?'<img src="'+esc(path(item.avatarPath))+'" alt="">':'<span class="avatarPlaceholder">'+esc((item.credit||'?')[0])+'</span>')+button(esc(item.credit||'Unknown creator'),'class="creatorName" data-civi-link="https://civitai.com/user/'+esc(encodeURIComponent(item.credit||''))+'"')+(item.creatorId?button(followed?'Following ✓':'Follow','data-civi-follow class="'+(followed?'selected':'')+'"'):'')+'</div><div class="civitaiReactions">'+Object.entries(emoji).map(([key,value])=>button('<span class="reactionEmoji">'+value+'</span><small>'+reactionCount(item,key)+'</small>','data-civi-react="'+key+'" aria-label="'+key+'" aria-pressed="'+item.reactions.includes(key)+'" class="'+(item.reactions.includes(key)?'selected':'')+'"')).join('')+button(ribbonIcon,'class="viewerCollect" aria-label="Add to collection"')+'</div><p class="civitaiActionError warning" role="status"></p>';

 }
 function membershipIds(raw){
  if(!raw)return [];
  const list=Array.isArray(raw)?raw:raw.items||raw.collections||[];
  return list.filter(c=>c.collectionId||c.inCollection||c.items?.length||c.collectionItems?.length).map(c=>String(c.collectionId||c.id));
 }
 function wireSocial(host,item,collections){
  hydrate(host);$$('[data-civi-link]',host).forEach(b=>b.onclick=()=>openModelSource(b.dataset.civiLink));
  const error=$('.civitaiActionError',host),boundAccount=account;
  async function run(b,payload,done){b.disabled=true;error.textContent='';try{const r=await action({...payload,account:boundAccount});if(host.isConnected)done(r);}catch(e){error.textContent=e.message;if(b.type==='checkbox')b.checked=!b.checked;}finally{b.disabled=false;}}
  $('[data-civi-follow]',host)?.addEventListener('click',e=>run(e.currentTarget,{kind:'follow',creatorId:item.creatorId,selected:!item.following},r=>{item.following=r.selected;e.target.textContent=r.selected?'Following ✓':'Follow';e.target.classList.toggle('selected',r.selected);}));
  $$('[data-civi-react]',host).forEach(b=>b.onclick=()=>run(b,{kind:'reaction',imageId:item.id,reaction:b.dataset.civiReact,selected:!item.reactions.includes(b.dataset.civiReact)},r=>{item.reactions=r.reactions;$$('[data-civi-react]',host).forEach(x=>{const selected=r.reactions.includes(x.dataset.civiReact);x.classList.toggle('selected',selected);x.setAttribute('aria-pressed',String(selected));});}));
  $('.viewerCollect',host).onclick=()=>showCollections(item,boundAccount);

 }
 function tagHTML(tags){return '<div class="civitaiTags">'+tags.map(t=>'<div class="civitaiTag"><span>'+esc(t.name)+'</span><small>'+esc(t.score??'')+'</small>'+button(caretIcon(false),'class="'+(t.vote===1?'selected':'')+'" data-vote="1" data-tag="'+t.id+'" aria-label="Upvote '+esc(t.name)+'"')+button(caretIcon(true),'class="'+(t.vote===-1?'selected':'')+'" data-vote="-1" data-tag="'+t.id+'" aria-label="Downvote '+esc(t.name)+'"')+'</div>').join('')+'</div>';}
 function wireTags(host,item){const boundAccount=account;$$('[data-vote]',host).forEach(b=>b.onclick=async()=>{b.disabled=true;try{const was=b.classList.contains('selected');await action({account:boundAccount,kind:'vote',imageId:item.id,tagId:b.dataset.tag,vote:b.classList.contains('selected')?0:Number(b.dataset.vote)});$$('[data-tag="'+b.dataset.tag+'"]',host).forEach(x=>x.classList.toggle('selected',x===b&&!was));}catch(e){toast(e.message);}finally{b.disabled=false;}});}
 async function enrich(host,image){
  if(!image.id)return;
  let target=$('.civitaiSocial',host);
  if(!target){target=document.createElement('div');target.className='civitaiSocial';$('.modelPreviewDetails',host)?.prepend(target);}
  target.textContent='Loading creator and interactions…';
  try{
   const result=await fetchDetail(image);if(!target.isConnected)return;
   account=result.account;const item=result.item;Object.assign(image,item);
   const prompts=$('.civitaiPromptBlocks',host);if(prompts){prompts.outerHTML=promptHTML(item);wirePromptCopies(host,item);}
   target.innerHTML=socialHTML(item,result.collections);wireSocial(target,item,result.collections);
   const resourceHost=$('.civitaiResourceHost',host);if(resourceHost){resourceHost.innerHTML=resourcesHTML(item.resources);wireResources(resourceHost);}
   let tags=$('.civitaiTagHost',host);if(!tags){tags=document.createElement('section');tags.className='civitaiTagHost';$('.modelPreviewDetails',host)?.append(tags);}
   tags.innerHTML='<h2>Tags</h2>'+tagHTML(item.tags||[]);wireTags(tags,item);
  }catch(e){if(target.isConnected)target.textContent=e.message;}
 }
 function peek(host){host.addEventListener('scroll',()=>host.classList.toggle('pastPeek',host.scrollTop>20),{passive:true});}
 function viewerMotion(v){
  const el=v.el,scroll=$('.civitaiViewerScroll',el),hero=$('.modelPreviewHero',el);
  const media=$('img,video',hero),peek=$('.modelPreviewPeek',el);
  let gap=0,gesture=null,frame=0,closed=false;
  function align(){
   const width=media.naturalWidth||media.videoWidth||v.item.width;
   const height=media.naturalHeight||media.videoHeight||v.item.height;
   const renderedHeight=width&&height?Math.min(hero.clientHeight,hero.clientWidth*height/width):hero.clientHeight;
   gap=Math.max(0,(hero.clientHeight-renderedHeight)/2)+(peek?.offsetHeight||0);
   hero.style.transform='translateY('+Math.min(scroll.scrollTop,gap)+'px)';
  }
  const resize=new ResizeObserver(align);
  resize.observe(hero);
  media.addEventListener('load',align);
  media.addEventListener('loadedmetadata',align);
  scroll.addEventListener('scroll',align,{passive:true});
  align();
  function reset(){
   scroll.style.transition='transform .22s ease-out';
   scroll.style.transform='';
   el.style.transition='background-color .22s ease-out';
   el.style.setProperty('--viewer-shade','1');
   el.classList.remove('tossing');
  }
  function finishToss(g){
   const distance=Math.hypot(g.dx,g.dy),speed=Math.hypot(g.vx,g.vy);
   const commit=distance>Math.min(innerWidth,innerHeight)*.55||(distance>70&&speed>.9);
   if(!commit){reset();return;}
   const factor=Math.max(innerWidth,innerHeight)*1.4/Math.max(distance,1);
   el.classList.add('tossing');
   scroll.style.transition='transform .2s ease-out';
   scroll.style.transform='translate('+g.dx*factor+'px,'+g.dy*factor+'px) scale(.95)';
   el.style.transition='background-color .2s ease-out';
   el.style.setProperty('--viewer-shade','0');
   setTimeout(()=>{if(viewer===v)close();},210);
  }
  function coast(velocity){
   let last=performance.now();
   function step(now){
    if(closed)return;
    const elapsed=Math.min(32,now-last);last=now;
    const previous=scroll.scrollTop;
    scroll.scrollTop-=velocity*elapsed;
    velocity*=Math.exp(-elapsed/180);
    if(Math.abs(velocity)>.02&&Math.abs(scroll.scrollTop-previous)>.1)frame=requestAnimationFrame(step);
   }
   frame=requestAnimationFrame(step);
  }
  hero.addEventListener('dragstart',e=>e.preventDefault());
  hero.addEventListener('pointerdown',e=>{
   if(!e.isPrimary){gesture=null;reset();return;}
   if(e.button!==0||e.target.closest('button,video'))return;
   cancelAnimationFrame(frame);
   scroll.style.transition='none';el.style.transition='none';
   gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,time:performance.now(),last:performance.now(),top:scroll.scrollTop,mode:'',dx:0,dy:0,vx:0,vy:0};
   hero.setPointerCapture(e.pointerId);
  });
  hero.addEventListener('pointermove',e=>{
   const g=gesture;if(!g||e.pointerId!==g.id)return;
   const now=performance.now(),dt=Math.max(1,now-g.last);
   g.dx=e.clientX-g.x;g.dy=e.clientY-g.y;
   g.vx=(e.clientX-g.lastX)/dt;g.vy=(e.clientY-g.lastY)/dt;
   g.lastX=e.clientX;g.lastY=e.clientY;g.last=now;
   if(!g.mode&&Math.hypot(g.dx,g.dy)>9){
    const held=now-g.time>=220;
    g.mode=held||Math.abs(g.dx)>Math.abs(g.dy)*1.25||(g.dy>0&&g.top<=1)?'toss':'scroll';
   }
   if(g.mode==='scroll'){scroll.scrollTop=g.top-g.dy;return;}
   if(g.mode==='toss'){
    el.classList.add('tossing');
    const progress=Math.min(1,Math.hypot(g.dx,g.dy)/Math.min(innerWidth,innerHeight));
    scroll.style.transform='translate('+g.dx+'px,'+g.dy+'px) scale('+(1-progress*.04)+')';
    el.style.setProperty('--viewer-shade',String(Math.max(0,1-progress*1.5)));
   }
  });
  hero.addEventListener('pointerup',e=>{
   const g=gesture;if(!g||e.pointerId!==g.id)return;gesture=null;
   if(performance.now()-g.last>100){g.vx=0;g.vy=0;}
   if(g.mode==='toss')finishToss(g);
   else if(g.mode==='scroll')coast(g.vy);
   if(hero.hasPointerCapture(e.pointerId))hero.releasePointerCapture(e.pointerId);
  });
  hero.addEventListener('pointercancel',()=>{gesture=null;reset();});
  return ()=>{
   closed=true;cancelAnimationFrame(frame);resize.disconnect();
   media.removeEventListener('load',align);media.removeEventListener('loadedmetadata',align);
   scroll.removeEventListener('scroll',align);
  };
 }

 function close(){if(viewer){viewer.dispose?.();viewer.el.remove();viewer=null;}document.body.classList.remove('civitaiViewerOpen');}
 function open(item,list){
  const cached=details.get(detailKey(item.id));if(cached)Object.assign(item,cached.result.item);
  close();const el=document.createElement('section');el.className='civitaiViewer';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','Civitai media details');
  const v={el,item,list};viewer=v;document.body.append(el);document.body.classList.add('civitaiViewerOpen');
  el.innerHTML='<div class="civitaiViewerHead">'+button('×','class="civitaiClose" aria-label="Close media"')+'</div><div class="civitaiViewerScroll modelPreviewViewer"><div class="modelPreviewHero">'+imageHTML(item,true)+'<div class="modelPreviewNavigation">'+button('‹','data-prev aria-label="Previous media"')+button('›','data-next aria-label="Next media"')+'</div></div><div class="modelPreviewPeek"><strong>Prompt & resources <span>⌄</span></strong><p>'+esc(item.prompt||'Scroll for details')+'</p></div><div class="modelPreviewDetails"><div class="civitaiSocial"></div>'+promptHTML(item)+'<h2>Resources</h2><div class="civitaiResourceHost">'+resourcesHTML(item.resources||[])+'</div><dl class="modelPreviewParameters">'+Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('')+'</dl><div class="civitaiTagHost"></div>'+button('Open on Civitai ↗','data-origin')+'</div></div>';
  $('.civitaiClose',el).onclick=close;$('.civitaiClose',el).focus();$('[data-origin]',el).onclick=()=>openModelSource(item.imageUrl);
  wirePromptCopies(el,item);
  const position=list.findIndex(i=>i.id===item.id);$('[data-prev]',el).disabled=position<=0;$('[data-next]',el).disabled=position>=list.length-1;
  $('[data-prev]',el).onclick=()=>open(list[position-1],list);$('[data-next]',el).onclick=()=>open(list[position+1],list);
  const scroll=$('.civitaiViewerScroll',el);peek(scroll);hydrate(el);wireResources(el);v.dispose=viewerMotion(v);detail(v);
  if(item.type!=='video'){const img=$('.modelPreviewHero img',el),full=new Image();full.onload=()=>{if(img.isConnected)img.src=full.src;};full.src=path(item.fullPath);}
 }
 async function detail(v){if(viewer===v)await enrich(v.el,v.item);}
 document.addEventListener('click',e=>{
  if(!e.target.closest('#browseCollections,#browseSources'))closeMenus();
 });
 document.addEventListener('click',e=>{if(Date.now()<suppressTap){e.preventDefault();e.stopImmediatePropagation();}},true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(viewer){e.preventDefault();close();}else if(page==='browse'&&back())e.preventDefault();}});
 document.addEventListener('visibilitychange',()=>{if(available()){refreshStatus(true).catch(()=>{});warm();}});
 return {render,open,close,back,isOpen:()=>!!viewer,enrich,peek,resourcesHTML,wireResources,promptHTML,wirePromptCopies};
})();
