'use strict';
// One account on the paired PC, shared across devices. No Civitai credentials here.
const CivitaiBrowser=(()=>{
 let account='',status=null,feed=[],strip=[],cursor='',stripCursor='',channel='',busy=false,stripBusy=false,session=0,timer,observer,viewer=null,lastStatus=0;
 let view={kind:'mix'}, history=[], feedEnded=false, collectionPopup=null;
 let muted={},refreshing=false,warmTimer,bottomTimer,detailQueue=[],detailRunning=false,cacheScope='',stripResume=false,emptyPages=0,suppressTap=0;
 const details=new Map(),detailRequests=new Map(),imageRequests=new Map();
 const socialRevisions=new Map();let followRevision=0,banRevision=0;
 let lastActivity=0,lastActivitySaved=0,suspended=null,pendingCreator=null;
 const emoji={Like:'👍',Heart:'❤️',Laugh:'😂',Cry:'😢'};
 const path=p=>'/'+String(p||'').replace(/^\//,'');
 const button=(label,attrs='')=>'<button '+attrs+'>'+label+'</button>';
 const thumbURL=item=>assetCache.get(path(item.path))||(item.cacheAsset&&item.cacheSample&&ModelPreviews.url(item.cacheAsset,item.cacheSample))||path(item.path);
 const imageHTML=(item,full=false)=>item.type==='video'&&full?'<video controls playsinline preload="none" poster="'+esc(thumbURL(item))+'" src="'+esc(path(item.fullPath))+'"></video>':'<img width="'+(Number(item.width)||512)+'" height="'+(Number(item.height)||768)+'" loading="lazy" decoding="async" src="'+esc(thumbURL(item))+'" alt="Civitai '+(item.type==='video'?'video preview':'image')+'">';
 const ribbonIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
 const copyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h12v13H8zM16 8V3H3v13h5"/></svg>';
 const caretIcon=down=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(down?'M5 8l7 7 7-7':'M5 16l7-7 7 7')+'"/></svg>';
 const refreshIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.343-5.657M18 2v5h-5"/></svg>';
 function following(item){return status?.followingIds?status.followingIds.includes(String(item.creatorId)):!!item.following;}
 function reactionLabel(item,key){const count=reactionCount(item,key);return '<span class="reactionEmoji">'+emoji[key]+'</span>'+(count>0?'<small>'+count+'</small>':'');}
 function allItems(){return [...feed,...strip,...history.flatMap(h=>h.feed),...[...details.values()].map(d=>d.result.item),...(viewer?[viewer.item]:[])];}
 function paintSocial(){
  for(const root of [document,...history.flatMap(h=>h.nodes)]){
   $$('.browseTile',root).forEach(el=>{
    const item=el.browseItem;
    $('.feedFollowing',el).hidden=!following(item);
    $('.feedCollect',el).classList.toggle('bookmarked',membershipIds(item.collections).length>0);
    $$('[data-feed-react]',el).forEach(b=>{b.innerHTML=reactionLabel(item,b.dataset.feedReact);b.setAttribute('aria-pressed',String((item.reactions||[]).includes(b.dataset.feedReact)));});
   });
   $$('[data-follow-creator]',root).forEach(b=>{
    const selected=following({creatorId:b.dataset.followCreator});b.classList.toggle('selected',selected);b.textContent=selected?'Following ✓':'Follow';b.setAttribute('aria-pressed',String(selected));
   });
  }
  if(viewer){
   const host=viewer.el,item=viewer.item;
   $('.viewerCollect',host)?.classList.toggle('bookmarked',membershipIds(item.collections).length>0);
   $$('[data-civi-react]',host).forEach(b=>{b.innerHTML=reactionLabel(item,b.dataset.civiReact);b.setAttribute('aria-pressed',String((item.reactions||[]).includes(b.dataset.civiReact)));b.classList.toggle('selected',(item.reactions||[]).includes(b.dataset.civiReact));});
  }
 }
 function updateItemSocial(item,values){
  for(const peer of allItems())if(peer.id===item.id)Object.assign(peer,values);
  Object.assign(item,values);paintSocial();saveSnapshot();
 }
 function applyReaction(item,reactions){
  const stats={...item.stats};for(const key of Object.keys(emoji)){
   stats[key.toLowerCase()+'CountAllTime']=Math.max(0,reactionCount(item,key)+Number(reactions.includes(key))-Number((item.reactions||[]).includes(key)));
  }
  updateItemSocial(item,{stats,reactions});
 }
 function updateFollowing(uid,selected){
  uid=String(uid);if(status){const ids=new Set((status.followingIds||[]).map(String));selected?ids.add(uid):ids.delete(uid);status.followingIds=[...ids];status.follows=ids.size;}
  for(const item of allItems())if(String(item.creatorId)===uid)item.following=selected;
  paintSocial();saveSnapshot();
 }
 async function changeFollow(b,uid){
  const selected=following({creatorId:String(uid)}),boundAccount=account;b.disabled=true;
  try{const result=await action({account:boundAccount,kind:'follow',creatorId:uid,selected:!selected});if(account===boundAccount)updateFollowing(uid,result.selected);}
  catch(error){toast(error.message);}finally{b.disabled=false;}
 }
 function profile(name){
  const url='https://civitai.red/user/'+encodeURIComponent(name);
  if(window.Native?.openProfile)Promise.resolve(Native.openProfile(url)).catch(e=>toast(e.message));else openModelSource(url);
 }
 function activityAge(){
  if(!lastActivity)try{lastActivity=Number(localStorage.getItem(scope()+':activity'))||Date.now();}catch{lastActivity=Date.now();}
  return Date.now()-lastActivity;
 }
 function markActivity(){
  lastActivity=Date.now();if(lastActivity-lastActivitySaved>1000){lastActivitySaved=lastActivity;try{localStorage.setItem(scope()+':activity',String(lastActivity));}catch{}}
 }
 function activity(){
  if(page!=='browse'||document.hidden)return;
  if(activityAge()>=7200000){close();render();return;}
  markActivity();
 }
 async function feedPage(selected,position,seen){
  try{return await api('browse/feed',{channel:selected,cursor:position,seen:seen.slice(-5000)});}
  catch(error){
   // Compatibility recovery if the PC is still running an older worker.
   if(position&&/feed expired/i.test(error.message))return api('browse/feed',{channel:selected,cursor:'',seen:seen.slice(-5000)});
   throw error;
  }
 }
 function promptHTML(item){
  return '<div class="civitaiPromptBlocks">'+[['prompt','Prompt'],['negativePrompt','Negative prompt']].map(([key,label])=>{
   if(key==='negativePrompt'&&!item[key])return '';
   return '<h2>'+label+'</h2><p class="modelPreviewPrompt">'+esc(item[key]||(item.generationDataAvailable?'No prompt is available in this media’s generation data.':'Prompt details unavailable. Reopen to retry.'))+'</p>'+
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
   account=data.account;status=data.status;channel=data.channel;strip=(data.strip||[]).filter(i=>!isBanned(i));stripResume=true;muted=data.muted||{};
   feed=(data.feed||[]).filter(i=>!isMuted(i)&&!isBanned(i));for(const entry of data.details||[])if(entry[1]?.result?.item?.detailVersion===2)details.set(...entry);
  }catch{/* A damaged snapshot is replaced after the next successful fetch. */}
 }
 function isBanned(item){
  const bans=status?.bans||[];
  return bans.some(rule=>rule.kind==='creator'?
   String(item.creatorId||'')===String(rule.id)||rule.name&&rule.name.toLowerCase()===String(item.credit||'').toLowerCase():
   !item.tagsKnown||(item.tags||[]).some(t=>String(t.id)===String(rule.id)||rule.name&&rule.name.toLowerCase()===String(t.name||'').toLowerCase()));
 }
 function pruneBanned(){
  feed=feed.filter(i=>!isBanned(i));strip=strip.filter(i=>!isBanned(i));
  for(const saved of history)saved.feed=saved.feed.filter(i=>!isBanned(i));
  for(const root of [document,...history.flatMap(h=>h.nodes),...(suspended?.nodes||[])]){
   $$('.browseTile,.browseThumb',root).forEach(el=>{if(isBanned(el.browseItem||{}))el.remove();});
  }
  if(viewer&&isBanned(viewer.item))close();
  paintCollections();saveSnapshot();
  if(view.kind!=='mix')try{
   const saved=JSON.parse(localStorage.getItem(scope())||'null');
   if(saved?.account===account){saved.status.bans=status?.bans||[];saved.feed=(saved.feed||[]).filter(i=>!isBanned(i));saved.strip=(saved.strip||[]).filter(i=>!isBanned(i));localStorage.setItem(scope(),JSON.stringify(saved));}
  }catch{}
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
  const key=detailKey(item.id),boundAccount=account,old=details.get(key),revision=socialRevisions.get(key)||0;
  if(!fresh&&old&&(old.result.item.detailVersion===2||Date.now()-old.at<60000))return Promise.resolve(old.result);
  if(detailRequests.has(key))return detailRequests.get(key);
  const request=api('browse/detail/'+item.id).then(result=>{
   if(boundAccount&&result.account!==boundAccount)throw Error('Civitai account changed. Refresh Browse.');
   if(boundAccount!==account)throw Error('Civitai account changed. Refresh Browse.');
   if(revision!==(socialRevisions.get(key)||0)){
    // A read begun before a confirmed write must not put old social state back.
    for(const field of ['reactions','stats','collections','following'])if(field in item)result.item[field]=item[field];
   }
   details.delete(key);details.set(key,{result,at:Date.now()});
   while(details.size>100)details.delete(details.keys().next().value);
   updateItemSocial(item,result.item);return result;
  }).finally(()=>detailRequests.delete(key));
  detailRequests.set(key,request);return request;
 }
 function queueDetail(item,priority=false){
  const old=details.get(detailKey(item?.id));
  if(!item?.id||(old&&(old.result.item.detailVersion===2||Date.now()-old.at<60000))||detailQueue.some(i=>i.id===item.id))return;
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
  if(!available()||(!force&&Date.now()-lastStatus<14000))return;lastStatus=Date.now();
  let s;const followTicket=followRevision,banTicket=banRevision;
  try{s=await api('browse/status',{cursors:[cursor,stripCursor,...history.map(h=>h.cursor)].filter(Boolean),activityAge:activityAge()/1000});}
  catch(error){if(!/HTTP (404|405)/.test(error.message))throw error;s=await api('browse/status');}
  if(!available())return;
  if(account===s.account&&followTicket!==followRevision&&status?.followingIds){s.followingIds=status.followingIds;s.follows=status.follows;}
  if(account&&account!==s.account){reset();details.clear();detailQueue=[];muted={};close();$('#browseFeed')?.replaceChildren();$('#browseCarousel')?.replaceChildren();}
  if(account===s.account&&banTicket!==banRevision)s.bans=status?.bans||[];
  account=s.account;status=s;$('#browseHello').textContent='Hello '+s.username;
  muted=s.timeouts||muted;
  if(!channel||(channel!=='reactions'&&!s.collections.some(c=>'collection:'+c.id===channel)))channel=s.collections.length?'collection:'+s.collections[0].id:'reactions';
  if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem||{}))el.remove();});}
  pruneBanned();paintCollections();paintSocial();saveSnapshot();

 }
 async function render(){
  const stale=activityAge()>=7200000;markActivity();
  if(suspended&&!stale&&suspended.scope===scope()){
   const saved=suspended;suspended=null;$('#main').replaceChildren(...saved.nodes);
   await Promise.resolve();$('#workspace').scrollTop=saved.scroll;
   paintSocial();observeMore();schedule();warm();refreshStatus(true).catch(()=>{});openPendingCreator();return;
  }
  suspended=null;if(stale){cursor='';stripCursor='';detailQueue=[];cacheScope='';status=null;close();collectionPopup?.remove();collectionPopup=null;}
  view={kind:'mix'};history=[];feedEnded=false;busy=false;stripBusy=false;
  const ticket=++session;clearTimeout(timer);observer?.disconnect();nearDetails.disconnect();restoreSnapshot();
  $('#main').innerHTML='<section class="civitaiBrowse"><div id="browsePull" role="status" aria-label="Pull to refresh"><i class="spinner"></i></div><p id="browseError" class="warning" role="status"></p><div id="browseConnected" hidden><div class="browseCollectionHeading"><details id="browseSources"><summary><u id="browseSourceLabel">Collection</u>'+caretIcon(true)+'</summary><div class="browseMenu" role="menu">'+button('Collection','data-channel="collection"')+button('Reacted media','data-channel="reactions"')+'</div></details><span id="browseCollectionDot">•</span><details id="browseCollections"><summary aria-label="Choose a media collection"><u id="browseCollectionLabel">Choose collection</u>'+caretIcon(true)+'</summary><div id="browseCollectionMenu" class="browseMenu" role="menu"></div></details><small id="browseItemCount"></small></div><p id="browseEmptyCollections" hidden>No media collections yet. Create one in the collection menu.</p><div id="browseCarousel" class="browseCarousel"></div><div class="browseFeedHeading"><h2>For you</h2><button id="browseImport" aria-label="Edit feed preferences"></button></div><div id="browseFeed" class="browseFeed"></div>'+button('Load more','id="browseMore"')+'</div></section>';
  $('#browseRefresh').innerHTML=refreshIcon;$('#browseRefresh').onclick=refresh;
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
   if(stale){await refresh();$('#workspace').scrollTop=0;}else {observeMore();warm();if(stripResume)loadStrip();}
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  schedule();openPendingCreator();
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{
  if(page!=='browse')return;
  if(!document.hidden&&activityAge()>=7200000){render();return;}
  if(available())try{if($('#browseConnected')?.hidden){render();return;}await refreshStatus();}catch(e){if($('#browseError'))$('#browseError').textContent=e.message;}
  schedule();
 },15000);}
 function suspend(){
  close();collectionPopup?.remove();collectionPopup=null;
  if(!$('.civitaiBrowse'))return;
  suspended={scope:scope(),scroll:$('#workspace').scrollTop,nodes:[...$('#main').childNodes]};
  observer?.disconnect();clearTimeout(timer);clearTimeout(warmTimer);session++;busy=false;stripBusy=false;
 }
 function tile(item,small=false){
  const el=document.createElement('article');
  el.className=small?'browseThumb':'browseTile';el.browseItem=item;nearDetails.observe(el);
  el.innerHTML='<button class="browseMedia" aria-label="Open '+esc(item.type)+' by '+esc(item.credit)+'">'+imageHTML(item)+(item.type==='video'?'<span class="browseVideo">▶</span>':'')+'</button>';
  $('.browseMedia',el).onclick=()=>open(item,small?strip:feed);
  if(!small){
   const caption=document.createElement('div');
   caption.className='browseCaption';
   caption.innerHTML=button(esc(item.credit||'Creator'),'class="feedAuthor"')+'<span class="feedFollowing" aria-label="Following" '+(following(item)?'':'hidden')+'>✓</span>'+button('<svg viewBox="0 0 24 24"><path d="M9 2h6M12 2v3m6 1 2 2M12 9v5l3 2"/><circle cx="12" cy="14" r="8"/></svg>','class="feedTimeout" aria-label="Silence creator for two hours"')+
    '<div class="feedReactions">'+Object.entries(emoji).map(([key,value])=>button(reactionLabel(item,key),'data-feed-react="'+key+'" aria-label="'+key+'" aria-pressed="'+(item.reactions||[]).includes(key)+'"')).join('')+'</div>'+
    button('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>','class="feedCollect '+(membershipIds(item.collections).length?'bookmarked':'')+'" aria-label="Add to collection"');
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
    const reaction=b.dataset.feedReact, selected=(item.reactions||[]).includes(reaction);
    b.disabled=true;
    try{
     const result=await action({account:boundAccount,kind:'reaction',imageId:item.id,reaction,selected:!selected});
     applyReaction(item,result.reactions);
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
  history.push({view,feed,cursor,feedEnded,emptyPages,scroll:$('#workspace').scrollTop,nodes:[...main.childNodes]});
  main.replaceChildren();
  session++;busy=false;stripBusy=false;
 }
 function back(){
  if(collectionPopup){collectionPopup.remove();collectionPopup=null;return true;}
  if(!history.length)return false;
  observer?.disconnect();session++;busy=false;stripBusy=false;
  const saved=history.pop();
  view=saved.view;feed=saved.feed;cursor=saved.cursor;feedEnded=saved.feedEnded;emptyPages=saved.emptyPages||0;
  $('#main').replaceChildren(...saved.nodes);
  if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem))el.remove();});saveSnapshot();}
  pruneBanned();paintSocial();$('#workspace').scrollTop=saved.scroll;
  if(view.kind!=='preferences')observeMore();else paintPreferences();
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
  feed=[];cursor='';feedEnded=false;emptyPages=0;
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+'<h2>'+(kind==='creator'?button(esc(name),'class="profileName" aria-label="Open '+esc(name)+' profile"'):esc(name))+'</h2>'+(kind==='creator'?button('Follow','class="creatorFollow" data-follow-creator="'+esc(id)+'"'):'')+'<div class="subjectFilters">'+
   [['image','▧','Images'],['video','▷','Videos'],['all','▦','All media']].map(([value,icon,label])=>button(icon,'data-media-filter="'+value+'" aria-label="'+label+'" title="'+label+'" aria-pressed="'+(value==='all')+'"')).join('')+'</div></div><p id="browseError" class="warning" role="status"></p><div id="browseFeed" class="browseFeed"></div>'+button('Load more','id="browseMore"')+'</section>';
  $('.browseBack').onclick=back;
  if(kind==='creator'){$('.profileName').onclick=()=>profile(name);$('.creatorFollow').onclick=e=>changeFollow(e.currentTarget,id);paintSocial();}
  $$('[data-media-filter]').forEach(b=>b.onclick=()=>{
   view.filter=b.dataset.mediaFilter;
   $$('[data-media-filter]').forEach(other=>other.setAttribute('aria-pressed',String(other===b)));
   session++;busy=false;feed=[];cursor='';feedEnded=false;emptyPages=0;$('#browseFeed').replaceChildren();
   $('#browseMore').hidden=false;loadFeed();observeMore();
  });
  $('#browseMore').onclick=loadFeed;
  $('#workspace').scrollTop=0;loadFeed();observeMore();
 }
 async function openPreferences(){
  saveView();view={kind:'preferences',sort:'weight',filter:'both',items:[]};
  try{Object.assign(view,JSON.parse(localStorage.getItem(scope()+':preferences:'+account)||'{}'));}catch{}
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+'<h2>Your feed</h2></div><div class="weightTools">'+
   '<details class="weightMenu"><summary aria-label="Sort feed preferences"><span id="weightSortLabel"></span>'+caretIcon(true)+'</summary><div class="browseMenu">'+button('Weight','data-weight-sort="weight"')+button('Alphabetical','data-weight-sort="alpha"')+'</div></details>'+
   '<details class="weightMenu"><summary aria-label="Filter feed preferences"><span id="weightFilterLabel"></span>'+caretIcon(true)+'</summary><div class="browseMenu">'+button('Both','data-weight-filter="both"')+button('Creators','data-weight-filter="creator"')+button('Tags','data-weight-filter="tag"')+'</div></details></div>'+
   '<p class="preferenceError warning" role="status"></p><div class="weightColumns"><span>Tag/Creator</span><span>Weight</span><span>Vote</span><span>Unweight</span><span>Ban</span></div>'+
   '<div id="weightActive"></div><section class="weightSection"><h3>Unweighted</h3><div id="weightDisabled"></div></section><section class="weightSection bannedSection"><h3>Ban</h3><div id="weightBanned"></div></section></section>';
  $('.browseBack').onclick=back;$('#workspace').scrollTop=0;
  for(const [attribute,key] of [['weight-sort','sort'],['weight-filter','filter']]){
   $$('[data-'+attribute+']').forEach(b=>b.onclick=()=>{view[key]=b.getAttribute('data-'+attribute);b.closest('details').open=false;
    try{localStorage.setItem(scope()+':preferences:'+account,JSON.stringify({sort:view.sort,filter:view.filter}));}catch{}
    paintPreferences();});
  }
  paintPreferences();
  try{await refreshPreferences();}catch(error){$('.preferenceError').textContent=error.message;}
 }
 async function refreshPreferences(){
  const ticket=session;
  const result=await api('browse/preferences');
  if(ticket!==session||view.kind!=='preferences')return;
  if(result.account!==account){reset();render();return;}
  view.items=result.items;status.bans=result.bans||result.items.filter(i=>i.banned).map(i=>({kind:i.kind,id:i.id,name:i.name}));
  pruneBanned();paintPreferences();
 }
 function paintPreferences(){
  const positions=new Map($$('.weightRow').map(row=>[row.dataset.key,row.getBoundingClientRect().top]));
  $('#weightSortLabel').textContent='Sort: '+(view.sort==='alpha'?'Alphabetical':'Weight');
  $('#weightFilterLabel').textContent='Show: '+({both:'Both',creator:'Creators',tag:'Tags'}[view.filter]||'Both');
  for(const id of ['weightActive','weightDisabled','weightBanned'])$('#'+id).replaceChildren();
  const items=[...(view.items||[])].filter(i=>view.filter==='both'||i.kind===view.filter).sort((a,b)=>
   (view.sort==='alpha'?0:b.weight-a.weight)||a.name.localeCompare(b.name,undefined,{sensitivity:'base',numeric:true})||a.kind.localeCompare(b.kind));
  for(const item of items){
   const row=document.createElement('div');
   row.className='weightRow'+(item.banned?' banned':item.disabled?' disabled':'');row.dataset.key=item.kind+':'+item.id;
   row.innerHTML=button(esc(item.name)+'<small>'+esc(item.kind==='creator'?'Creator':'Tag')+'</small>','class="weightName"')+'<strong>'+((item.disabled||item.banned)?0:item.weight)+'</strong>'+
    '<div class="weightVotes">'+button(caretIcon(false),'data-adjust="1" aria-label="Increase weight"')+button(caretIcon(true),'data-adjust="-1" aria-label="Decrease weight"')+'</div>'+
    button(item.disabled?'↶':'×','class="weightRemove" aria-label="'+(item.disabled?'Restore weight':'Unweight')+'" title="'+(item.disabled?'Restore weight':'Hold weight at zero')+'"')+
    button(item.banned?'↶':'💀','class="weightBan" aria-label="'+(item.banned?'Unban':'Ban')+'" title="'+(item.banned?'Unban':'Hide matching media throughout Browse')+'"');
   $('.weightName',row).onclick=()=>openSubject(item.kind,item.id,item.name);
   async function change(values){
    const boundView=view,boundAccount=account;
    $$('button',row).forEach(b=>b.disabled=true);$('.preferenceError').textContent='';
    try{
     await action({account:boundAccount,kind:'preference',subject:item.kind,id:item.id,...values});
     // Apply the confirmed state even if the following refresh temporarily fails.
     if(account!==boundAccount)return;
     Object.assign(item,values);if(values.banned===false)item.disabled=false;
     status.bans=boundView.items.filter(i=>i.banned).map(i=>({kind:i.kind,id:i.id,name:i.name}));pruneBanned();
     if(view===boundView){paintPreferences();await refreshPreferences();}
    }catch(error){if(view.kind==='preferences'){$('.preferenceError').textContent=error.message;paintPreferences();}}
   }
   $$('[data-adjust]',row).forEach(b=>{b.disabled=item.disabled||item.banned;b.onclick=()=>change({delta:Number(b.dataset.adjust)});});
   $('.weightRemove',row).disabled=!!item.banned;
   $('.weightRemove',row).onclick=()=>change({disabled:!item.disabled});
   $('.weightBan',row).onclick=()=>change({banned:!item.banned});
   $(item.banned?'#weightBanned':item.disabled?'#weightDisabled':'#weightActive').append(row);
  }
  for(const [id,label] of [['weightActive','No matching weighted items.'],['weightDisabled','No unweighted items.'],['weightBanned','No banned items.']]){
   if(!$('#'+id).children.length)$('#'+id).innerHTML='<p class="weightEmpty">'+label+'</p>';
  }
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
    try{await action({account:boundAccount,kind:'collect',imageId:item.id,collectionId:box.value,selected:box.checked});const ids=new Set(membershipIds(item.collections));box.checked?ids.add(box.value):ids.delete(box.value);updateItemSocial(item,{collections:[...ids].map(collectionId=>({collectionId}))});}
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
  try{const r=await feedPage(view.kind==='mix'?'mix':view.kind+':'+view.id+':'+view.filter,cursor,replace?[]:feed.map(i=>i.id));if(ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   if(replace){feed=[];$('#browseFeed').replaceChildren();}
   const added=r.items.filter(i=>!isBanned(i)&&!(view.kind==='mix'&&isMuted(i))&&!feed.some(x=>x.id===i.id));feed.push(...added);cursor=r.nextCursor||'';feedEnded=!r.nextCursor;paintFeed(added);saveSnapshot();warm();$('#browseError').textContent='';
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
  try{const r=await feedPage(chosen,stripCursor,replace?[]:strip.map(i=>i.id));if(chosen!==channel||ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   if(replace){strip=[];$('#browseCarousel').replaceChildren();}
   const added=r.items.filter(i=>!isBanned(i)&&!strip.some(x=>x.id===i.id));strip.push(...added);stripCursor=r.nextCursor||'';stripResume=stripResume&&!added.length&&!!stripCursor;paintStrip(added);paintCollections();saveSnapshot();warm();
   if(!strip.length)$('#browseCarousel').innerHTML='<p class="muted">No accessible media here yet.</p>';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{if(chosen===channel&&ticket===session){stripBusy=false;if((strip.length<20||stripResume)&&stripCursor)setTimeout(()=>loadStrip(),0);}}
 }
 async function action(data){
  const key=detailKey(data.imageId);if(data.imageId)socialRevisions.set(key,(socialRevisions.get(key)||0)+1);if(data.kind==='follow')followRevision++;if(data.kind==='preference')banRevision++;
  try{
   const result=await api('browse/action',{account,...data,requestId:crypto.randomUUID()});
   if(data.imageId)details.delete(key);else if(data.kind==='follow')details.clear();saveSnapshot();return result;
  }finally{if(data.imageId)socialRevisions.set(key,(socialRevisions.get(key)||0)+1);if(data.kind==='follow')followRevision++;if(data.kind==='preference')banRevision++;}
 }
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
  const followed=following(item);
  return '<div class="civitaiAuthor">'+(item.avatarPath?'<img src="'+esc(path(item.avatarPath))+'" alt="">':'<span class="avatarPlaceholder">'+esc((item.credit||'?')[0])+'</span>')+button(esc(item.credit||'Unknown creator'),'class="creatorName" data-civi-link="https://civitai.red/user/'+esc(encodeURIComponent(item.credit||''))+'"')+(item.creatorId?button('Feed','data-creator-feed class="creatorFeed"'):'')+button('↗','data-creator-profile class="creatorProfile" aria-label="Open creator profile"')+'</div><div class="civitaiReactions">'+Object.entries(emoji).map(([key,value])=>button(reactionLabel(item,key),'data-civi-react="'+key+'" aria-label="'+key+'" aria-pressed="'+(item.reactions||[]).includes(key)+'" class="'+((item.reactions||[]).includes(key)?'selected':'')+'"')).join('')+button(ribbonIcon,'class="viewerCollect '+(membershipIds(item.collections).length?'bookmarked':'')+'" aria-label="Add to collection"')+'</div><p class="civitaiActionError warning" role="status"></p>';

 }
 function membershipIds(raw){
  if(!raw)return [];
  const list=Array.isArray(raw)?raw:raw.items||raw.collections||[];
  return list.filter(c=>c.collectionId||c.inCollection||c.items?.length||c.collectionItems?.length).map(c=>String(c.collectionId||c.id));
 }
 function showCreatorFeed(item){
  close();if($('#modal')?.open)closeModal();
  if(page==='browse')openSubject('creator',item.creatorId,item.credit);
  else {pendingCreator=item;navigate('browse');}
 }
 function openPendingCreator(){if(pendingCreator){const item=pendingCreator;pendingCreator=null;openSubject('creator',item.creatorId,item.credit);}}
 function wireSocial(host,item,collections){
  hydrate(host);$$('[data-civi-link]',host).forEach(b=>b.onclick=()=>openModelSource(b.dataset.civiLink));
  $('[data-creator-feed]',host)?.addEventListener('click',()=>showCreatorFeed(item));
  $('[data-creator-profile]',host)?.addEventListener('click',()=>profile(item.credit));
  const error=$('.civitaiActionError',host),boundAccount=account;
  async function run(b,payload,done){b.disabled=true;error.textContent='';try{const r=await action({...payload,account:boundAccount});if(host.isConnected)done(r);}catch(e){error.textContent=e.message;if(b.type==='checkbox')b.checked=!b.checked;}finally{b.disabled=false;}}
  $('[data-civi-follow]',host)?.addEventListener('click',e=>run(e.currentTarget,{kind:'follow',creatorId:item.creatorId,selected:!following(item)},r=>{updateFollowing(item.creatorId,r.selected);e.target.textContent=r.selected?'Following ✓':'Follow';e.target.classList.toggle('selected',r.selected);}));
  $$('[data-civi-react]',host).forEach(b=>b.onclick=()=>run(b,{kind:'reaction',imageId:item.id,reaction:b.dataset.civiReact,selected:!(item.reactions||[]).includes(b.dataset.civiReact)},r=>{applyReaction(item,r.reactions);$$('[data-civi-react]',host).forEach(x=>{const selected=r.reactions.includes(x.dataset.civiReact);x.innerHTML=reactionLabel(item,x.dataset.civiReact);x.classList.toggle('selected',selected);x.setAttribute('aria-pressed',String(selected));});}));
  $('.viewerCollect',host).onclick=()=>showCollections(item,boundAccount);

 }
 function tagHTML(tags){return '<div class="civitaiTags">'+tags.map(t=>'<div class="civitaiTag"><span>'+esc(t.name)+'</span><small>'+esc(t.score??'')+'</small>'+button(caretIcon(false),'class="'+(t.vote===1?'selected':'')+'" data-vote="1" data-tag="'+t.id+'" aria-label="Upvote '+esc(t.name)+'"')+button(caretIcon(true),'class="'+(t.vote===-1?'selected':'')+'" data-vote="-1" data-tag="'+t.id+'" aria-label="Downvote '+esc(t.name)+'"')+'</div>').join('')+'</div>';}
 function wireTags(host,item){const boundAccount=account;$$('[data-vote]',host).forEach(b=>b.onclick=async()=>{b.disabled=true;try{const was=b.classList.contains('selected');await action({account:boundAccount,kind:'vote',imageId:item.id,tagId:b.dataset.tag,vote:b.classList.contains('selected')?0:Number(b.dataset.vote)});$$('[data-tag="'+b.dataset.tag+'"]',host).forEach(x=>x.classList.toggle('selected',x===b&&!was));}catch(e){toast(e.message);}finally{b.disabled=false;}});}
 async function enrich(host,image){
  if(!image.id)return;
  let target=$('.civitaiSocial',host);
  if(!target){target=document.createElement('div');target.className='civitaiSocial';$('.modelPreviewDetails',host)?.prepend(target);}
  target.innerHTML=socialHTML(image,status?.collections||[]);wireSocial(target,image,status?.collections||[]);
  try{
   const result=await fetchDetail(image);if(!target.isConnected)return;
   account=result.account;const item=result.item;Object.assign(image,item);
   const prompts=$('.civitaiPromptBlocks',host);if(prompts){prompts.outerHTML=promptHTML(item);wirePromptCopies(host,item);}
   target.innerHTML=socialHTML(item,result.collections);wireSocial(target,item,result.collections);
   const parameters=$('.modelPreviewParameters',host);if(parameters)parameters.innerHTML=Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('');
   const resourceHost=$('.civitaiResourceHost',host);if(resourceHost){resourceHost.innerHTML=resourcesHTML(item.resources);wireResources(resourceHost);}
   let tags=$('.civitaiTagHost',host);if(!tags){tags=document.createElement('section');tags.className='civitaiTagHost';$('.modelPreviewDetails',host)?.append(tags);}
   tags.innerHTML='<h2>Tags</h2>'+tagHTML(item.tags||[]);wireTags(tags,item);
  }catch(e){if(target.isConnected)$('.civitaiActionError',target).textContent=e.message;}
 }
 function peek(host){host.addEventListener('scroll',()=>host.classList.toggle('pastPeek',host.scrollTop>20),{passive:true});}
 function viewerMotion(v){
  const el=v.el,scroll=$('.civitaiViewerScroll',el),hero=$('.modelPreviewHero',el);
  const media=$('img,video',hero),social=$('.civitaiSocial',el);
  let gap=0,gesture=null,frame=0,closed=false,peekHeight=110,touched=false,tapVisible=false;
  const video=v.item.type==='video';hero.classList.toggle('isVideo',video);
  function align(){
   const width=media.naturalWidth||media.videoWidth||v.item.width;
   const height=media.naturalHeight||media.videoHeight||v.item.height;
   const author=$('.civitaiAuthor',social),reactions=$('.civitaiReactions',social);
   if(author&&reactions)peekHeight=reactions.offsetTop+reactions.offsetHeight-social.offsetTop+16;
   const visible=Math.min(scroll.scrollTop,peekHeight),gutter=video?44:0;
   const mediaHeight=Math.max(160,hero.clientHeight-visible-gutter);
   media.style.height=mediaHeight+'px';
   const renderedHeight=width&&height?Math.min(mediaHeight,hero.clientWidth*height/width):mediaHeight;
   gap=peekHeight+Math.max(0,(mediaHeight-renderedHeight)/2)+gutter;
   hero.style.transform='translateY('+Math.min(scroll.scrollTop,gap)+'px)';
   el.classList.toggle('mediaOnly',scroll.scrollTop<=1&&!tapVisible);
  }
  const resize=new ResizeObserver(align);
  resize.observe(hero);resize.observe(social);
  const reveal=()=>{if(!touched){align();scroll.scrollTop=peekHeight;align();}};
  const socialResize=new ResizeObserver(reveal);socialResize.observe(social);
  scroll.addEventListener('pointerdown',()=>{touched=true;},{passive:true});
  scroll.addEventListener('wheel',()=>{touched=true;},{passive:true});
  requestAnimationFrame(reveal);
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
  if(video)media.addEventListener('click',()=>{tapVisible=!tapVisible;align();});
  hero.addEventListener('dragstart',e=>e.preventDefault());
  hero.addEventListener('pointerdown',e=>{
   if(!e.isPrimary){gesture=null;reset();return;}
   if(e.button!==0||e.target.closest('button,video')||video)return;
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
   else {tapVisible=!tapVisible;align();}
   if(hero.hasPointerCapture(e.pointerId))hero.releasePointerCapture(e.pointerId);
  });
  hero.addEventListener('pointercancel',()=>{gesture=null;reset();});
  return ()=>{
   closed=true;cancelAnimationFrame(frame);resize.disconnect();socialResize.disconnect();
   media.removeEventListener('load',align);media.removeEventListener('loadedmetadata',align);
   scroll.removeEventListener('scroll',align);
  };
 }

 function close(){if(viewer){viewer.dispose?.();viewer.el.remove();viewer=null;}document.body.classList.remove('civitaiViewerOpen');}
 function open(item,list){
  const cached=details.get(detailKey(item.id));if(cached)Object.assign(item,cached.result.item);
  close();const el=document.createElement('section');el.className='civitaiViewer';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','Civitai media details');
  const v={el,item,list};viewer=v;document.body.append(el);document.body.classList.add('civitaiViewerOpen');
  el.innerHTML='<div class="civitaiViewerHead">'+button('×','class="civitaiClose" aria-label="Close media"')+'</div><div class="civitaiViewerScroll modelPreviewViewer"><div class="modelPreviewHero">'+imageHTML(item,true)+'<div class="modelPreviewNavigation">'+button('‹','data-prev aria-label="Previous media"')+button('›','data-next aria-label="Next media"')+'</div></div><div class="modelPreviewDetails"><div class="civitaiSocial">'+socialHTML(item,status?.collections||[])+'</div>'+promptHTML(item)+'<h2>Resources</h2><div class="civitaiResourceHost">'+resourcesHTML(item.resources||[])+'</div><dl class="modelPreviewParameters">'+Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('')+'</dl><div class="civitaiTagHost"></div>'+button('Open on Civitai ↗','data-origin')+'</div></div>';
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
  $$('.weightMenu[open]').forEach(menu=>{if(!menu.contains(e.target))menu.open=false;});
 });
 document.addEventListener('click',e=>{if(Date.now()<suppressTap){e.preventDefault();e.stopImmediatePropagation();}},true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(viewer){e.preventDefault();close();}else if(page==='browse'&&back())e.preventDefault();}});
 document.addEventListener('visibilitychange',()=>{if(page==='browse'&&!document.hidden){if(activityAge()>=7200000){render();return;}if(available()){refreshStatus(true).catch(()=>{});warm();}}});
 document.addEventListener('pointerdown',activity,{passive:true});document.addEventListener('keydown',activity,{passive:true});document.addEventListener('wheel',activity,{passive:true});document.addEventListener('touchmove',activity,{passive:true});
 return {render,suspend,open,close,back,isOpen:()=>!!viewer,enrich,peek,resourcesHTML,wireResources,promptHTML,wirePromptCopies};
})();
