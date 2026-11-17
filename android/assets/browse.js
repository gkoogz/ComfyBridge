'use strict';
// One account on the paired PC, shared across devices. No Civitai credentials here.
const CivitaiBrowser=(()=>{
 let account='',status=null,feed=[],strip=[],cursor='',stripCursor='',channel='',busy=false,stripBusy=false,session=0,timer,observer,viewer=null,lastStatus=0;
 let view={kind:'mix'}, history=[], feedEnded=false, collectionPopup=null;
 let backLayer=null;
 let headerTop=0,headerTravel=0,headerDirection=0;
 function showBrowseHeader(){document.body.classList.remove('browseHeaderHidden');headerTop=$('#workspace').scrollTop;headerTravel=0;headerDirection=0;}
 function trackBrowseHeader(top){
  const delta=top-headerTop;headerTop=top;
  if(viewer||backLayer||$('#drawer').classList.contains('open'))return;
  if(top<=12){showBrowseHeader();return;}
  const direction=Math.sign(delta);if(!direction)return;
  if(direction!==headerDirection){headerDirection=direction;headerTravel=0;}headerTravel+=Math.abs(delta);
  if(headerTravel>=(direction>0?24:8))document.body.classList.toggle('browseHeaderHidden',direction>0&&top>80);
 }
 // Keep scroll events cheap; admit rendering/maintenance at a settling boundary.
 const scrollWork=new Map();let workFrame=0,workTimer=0,lastScroll=-Infinity,scrollSpeed=0,scrollTopSample=0,scrollCheckFrame=0;
 function scrollMoving(){return typeof page!=='undefined'&&page==='browse'&&performance.now()-lastScroll<(scrollSpeed<.08?48:100);}
 function afterScroll(key,work){scrollWork.set(key,work);scheduleScrollWork();}
 function scheduleScrollWork(){
  if(workFrame||workTimer||document.hidden)return;
  const delay=scrollMoving()?Math.max(8,(scrollSpeed<.08?48:100)-(performance.now()-lastScroll)):0;
  if(delay){workTimer=setTimeout(()=>{workTimer=0;scheduleScrollWork();},delay);return;}
  workFrame=requestAnimationFrame(()=>{
   workFrame=0;if(scrollMoving()){scheduleScrollWork();return;}
   const started=performance.now(),batch=[...scrollWork.entries()];
   for(const [key,work] of batch){
    if(scrollWork.get(key)!==work)continue;scrollWork.delete(key);work();
    if(performance.now()-started>=4)break;
   }
   if(scrollWork.size)scheduleScrollWork();
  });
 }
 function scrollOpportunity(){return new Promise(resolve=>afterScroll(resolve,resolve));}
 function cancelArrivalMotion(){
  document.querySelectorAll('.cardArriving').forEach(el=>el.classList.remove('cardArriving'));
  document.querySelectorAll('.pullGhost').forEach(el=>el.remove());
  document.querySelectorAll('.pullCovered').forEach(el=>el.classList.remove('pullCovered'));
 }
 function clearBackLayer(){if(backLayer){const layer=backLayer;backLayer=null;layer.animation?.cancel();layer.el.remove();}}
 function canSwipeBack(){return !viewer&&!collectionPopup&&!backLayer&&history.length>0;}
 function beginSwipeBack(){
  if(!canSwipeBack())return false;
  const work=$('#workspace'),saved=history.at(-1),rect=work.getBoundingClientRect();
  const el=document.createElement('section');el.className='browseBackLayer';el.setAttribute('aria-hidden','true');el.inert=true;
  Object.assign(el.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
  const head=$('header',work).cloneNode(true);$$('[id]',head).forEach(n=>n.removeAttribute('id'));
  const main=document.createElement('main');main.append(...saved.nodes);el.append(head,main);document.body.append(el);el.scrollTop=saved.scroll;
  backLayer={el,saved,ticket:session,width:rect.width};moveSwipeBack(0);return true;
 }
 function moveSwipeBack(dx){if(backLayer)backLayer.el.style.transform='translateX('+(-backLayer.width+Math.min(dx,backLayer.width))+'px)';}
 function endSwipeBack(commit){
  const layer=backLayer;if(!layer)return;
  const finish=()=>{if(backLayer!==layer)return;clearBackLayer();if(commit&&session===layer.ticket&&history.at(-1)===layer.saved)back();};
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
  layer.animation=layer.el.animate([{transform:layer.el.style.transform},{transform:commit?'translateX(0)':'translateX(-100%)'}],{duration:180,easing:'ease-out',fill:'forwards'});
  layer.animation.onfinish=finish;
 }
 let muted={},refreshing=false,warmTimer,bottomTimer,detailQueue=[],detailRunning=false,cacheScope='',stripResume=false,emptyPages=0,suppressTap=0;
 let feedWaitUntil=0;
 let bankAhead=[],bankChecked=0,bankBusy=false,bankUnsupported=false,fullWarmRunning=false;
 let launchTimer,launchRunning=false,warmRevision=0;
 const mediaFailures=new Map(),mediaControllers=new Map();let fullWindow=[];
 function registerMedia(items){
  if(!window.Native?.registerBrowseMedia)return;
  const urls={};for(const item of items)for(const key of ['thumb','full']){
   const local=key==='thumb'?item.path:item.fullPath,url=item.mediaUrls?.[key];if(local&&url)urls[path(local)]=url;
  }
  Native.registerBrowseMedia(account,JSON.stringify(urls));
 }
 const details=new Map(),detailRequests=new Map(),imageRequests=new Map();
 const socialRevisions=new Map();let followRevision=0,banRevision=0;
 let seenScope='',seenPosts=new Set(),pendingSeen=new Set(),seenTimer,seenSending=false,replacingCache=false,cacheCheckAt=0;
 const exposureTimers=new Map();
 function loadSeen(){
  const key=scope()+':seen:'+account;if(seenScope===key)return;
  seenScope=key;seenPosts=new Set();pendingSeen=new Set();cacheCheckAt=0;
  try{const s=JSON.parse(localStorage.getItem(key)||'{}');seenPosts=new Set(s.seen||[]);pendingSeen=new Set(s.pending||[]);}catch{}
 }
 function saveSeen(){
  try{localStorage.setItem(seenScope,JSON.stringify({seen:[...seenPosts].slice(-30000),pending:[...pendingSeen].slice(-30000)}));}catch{}
 }
 function markSeen(id){
  if(!account)return;loadSeen();id=String(id);if(seenPosts.has(id))return;
  seenPosts.add(id);pendingSeen.add(id);saveSeen();clearTimeout(seenTimer);seenTimer=setTimeout(flushSeen,1200);
 }
 async function flushSeen(){
  if(seenSending||!available()||!pendingSeen.size)return;
  seenSending=true;const bound=account,key=seenScope,ids=[...pendingSeen].slice(0,500);
  try{const r=await api('browse/seen',{account:bound,viewed:ids});if(account===bound&&seenScope===key&&r.account===bound){ids.forEach(id=>pendingSeen.delete(id));saveSeen();}}
  catch{/* Offline views remain queued on this device. */}finally{seenSending=false;if(available()&&pendingSeen.size)seenTimer=setTimeout(flushSeen,15000);}
 }
 function actuallyVisible(el){
  if(!el.isConnected||document.hidden||page!=='browse'||view.kind!=='mix'||viewer)return false;
  const image=$('.browseMedia img',el);if(!image?.complete||!image.naturalWidth)return false;
  const r=el.getBoundingClientRect(),w=$('#workspace').getBoundingClientRect();
  return Math.min(r.bottom,w.bottom)-Math.max(r.top,w.top)>=Math.min(160,r.height*.5)&&r.right>w.left&&r.left<w.right;
 }
 function watchExposure(el){
  clearTimeout(exposureTimers.get(el));exposureTimers.delete(el);
  if(actuallyVisible(el))exposureTimers.set(el,setTimeout(()=>{exposureTimers.delete(el);if(actuallyVisible(el)){markSeen(el.browseItem.id);viewedTiles.unobserve(el);}},800));
 }
 const viewedTiles=new IntersectionObserver(entries=>entries.forEach(({target:el})=>watchExposure(el)),{threshold:[0,.1,.25,.5,1]});
 function farBelow(el){const r=$('#workspace').getBoundingClientRect();return el.isConnected&&el.getBoundingClientRect().top>r.bottom+r.height*2;}
 async function refreshCachedFeed(){
  if(scrollMoving()){afterScroll('cached-feed',refreshCachedFeed);return;}
  if(!available()||view.kind!=='mix'||viewer||refreshing||busy||stripBusy||replacingCache)return;
  const cached=$$('#browseFeed .browseTile[data-restored]');if(!cached.length)return;
  replacingCache=true;const ticket=session,bound=account;
  try{
   if(Date.now()-cacheCheckAt>15000){
    const r=await api('browse/seen',{account:bound,candidates:cached.map(e=>e.browseItem.id).slice(0,500)});
    if(ticket!==session||r.account!==account)return;cacheCheckAt=Date.now();
    for(const id of r.seen||[])seenPosts.add(String(id));saveSeen();
   }
   const stale=cached.filter(el=>seenPosts.has(el.browseItem.id)&&farBelow(el));if(!stale.length)return;
   const r=await feedPage('mix',cursor,feed.map(i=>i.id));if(ticket!==session||r.account!==account)return;
   cursor=r.nextCursor||'';
   const incoming=r.items.filter(i=>!seenPosts.has(i.id)&&!isBanned(i)&&!isMuted(i)&&!feed.some(x=>x.id===i.id));
   const unused=[...incoming];
   for(const item of incoming){
    const el=stale.find(e=>farBelow(e));if(!el||ticket!==session||viewer)break;
    const url=await imageBlob(path(item.path));if(!url)continue;
    const decoded=new Image();decoded.src=url;await decoded.decode();
    await scrollOpportunity();if(ticket!==session||view.kind!=='mix'||viewer||!farBelow(el))break;
    const index=feed.findIndex(i=>i.id===el.browseItem.id);if(index<0)continue;
    const neighbors=feed.slice(Math.max(0,index-9),index).concat(feed.slice(index+1,index+10));
    if(neighbors.some(i=>artistKeys(i).some(k=>artistKeys(item).includes(k))))continue;
    feed[index]=item;viewedTiles.unobserve(el);nearDetails.unobserve(el);el.replaceWith(tile(item));stale.splice(stale.indexOf(el),1);unused.splice(unused.indexOf(item),1);queueDetail(item,true);
   }
   if(ticket===session&&view.kind==='mix'){const spaced=spacedArtists(unused,feed);feed.push(...spaced);paintFeed(spaced);saveSnapshot();warm();}
  }catch{/* Keep the cached image if replacement cannot be fully prepared. */}finally{replacingCache=false;}
 }
 let lastActivity=0,lastActivitySaved=0,suspended=null,pendingCreator=null;
 let personalTags={},personalTagsAt=0,personalTagAccount='';const pendingTagWeights=new Set(),lastTagAdjust=new Map();
 const emoji={Like:'👍',Heart:'❤️',Laugh:'😂',Cry:'😢'};
 const path=p=>'/'+String(p||'').replace(/^\//,'');
 const button=(label,attrs='')=>'<button '+attrs+'>'+label+'</button>';
 const thumbURL=item=>assetCache.get(path(item.path))||(item.cacheAsset&&item.cacheSample&&ModelPreviews.url(item.cacheAsset,item.cacheSample))||path(item.path);
 const imageHTML=(item,full=false)=>item.type==='video'&&full?'<video controls playsinline preload="none" poster="'+esc(thumbURL(item))+'" src="'+esc(assetCache.get(path(item.fullPath))||path(item.fullPath))+'"></video>':'<img width="'+(Number(item.width)||512)+'" height="'+(Number(item.height)||768)+'" loading="lazy" decoding="async" src="'+esc(full&&assetCache.get(path(item.fullPath))||thumbURL(item))+'" alt="Civitai '+(item.type==='video'?'video preview':'image')+'">';
 const ribbonIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
 const thumbIcon='<svg class="thumbIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10H3v11h4zM7 10l5-7c.5-.7 2-.2 2 1v5h5c1.4 0 2.2 1.1 1.9 2.4l-1.5 7.5c-.2 1.2-1.1 2.1-2.4 2.1H7z"/></svg>';
 const copyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h12v13H8zM16 8V3H3v13h5"/></svg>';
 const caretIcon=down=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(down?'M5 8l7 7 7-7':'M5 16l7-7 7 7')+'"/></svg>';
 const refreshIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.343-5.657M18 2v5h-5"/></svg>';
 function following(item){const pending=socialRows().find(r=>r.kind==='follow'&&String(r.creatorId)===String(item.creatorId));if(pending)return pending.selected;return status?.followingIds?status.followingIds.includes(String(item.creatorId)):!!item.following;}
 function reactionLabel(item){const count=Object.keys(emoji).reduce((sum,key)=>sum+reactionCount(item,key),0);return thumbIcon+(count>0?'<small>'+count+'</small>':'');}
 function allItems(){return [...feed,...strip,...history.flatMap(h=>h.feed),...[...details.values()].map(d=>d.result.item),...(viewer?[viewer.item]:[])];}
 function paintSocial(){
  for(const root of [document,...history.flatMap(h=>h.nodes)]){
   $$('.browseTile',root).forEach(el=>{
    const item=el.browseItem;
    $('.feedFollowing',el).hidden=!following(item);
    const via=$('.viaFollowing',el);if(via)via.hidden=!following({creatorId:item.chosenBy?.via?.id});
    $('.feedCollect',el).classList.toggle('bookmarked',membershipIds(item.collections).length>0);
    $$('[data-feed-react]',el).forEach(b=>{b.innerHTML=reactionLabel(item,b.dataset.feedReact);b.setAttribute('aria-pressed',String((item.reactions||[]).includes(b.dataset.feedReact)));});
   });
   $$('[data-follow-creator]',root).forEach(b=>{
    const selected=following({creatorId:b.dataset.followCreator});b.classList.toggle('selected',selected);b.textContent=selected?'Following ✓':'Follow';b.setAttribute('aria-pressed',String(selected));if(b.hasAttribute('data-follow-only'))b.hidden=selected;
   });
  }
  if(viewer){
   const host=viewer.el,item=viewer.item;
   $$('[data-follow-creator]',host).forEach(b=>{const selected=following({creatorId:b.dataset.followCreator});b.textContent=selected?'Following ✓':'Follow';b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));if(b.hasAttribute('data-follow-only'))b.hidden=selected;});
   const via=$('.viaFollowing',host);if(via)via.hidden=!following({creatorId:item.chosenBy?.via?.id});
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
 async function feedPage(selected,position,seen,refresh=false){
  if(selected==='mix'){loadSeen();seen=[...new Set([...seen,...seenPosts])];}
  try{return await api('browse/feed',{channel:selected,cursor:position,seen:seen.slice(-5000),refresh,bank:selected==='mix',requestId:crypto.randomUUID()});}
  catch(error){
   // Compatibility recovery if the PC is still running an older worker.
   if(position&&/feed expired/i.test(error.message))return api('browse/feed',{channel:selected,cursor:'',seen:seen.slice(-5000)});
   throw error;
  }
 }
 function promptHTML(item,state='loading'){
  return '<div class="civitaiPromptBlocks">'+[['prompt','Prompt'],['negativePrompt','Negative prompt']].map(([key,label])=>{
   if(key==='negativePrompt'&&!item[key])return '';
   return '<h2>'+label+'</h2><p class="modelPreviewPrompt"'+(!item[key]&&state==='loading'&&!item.generationDataAvailable?' role="status" aria-busy="true"':'')+'>'+esc(item[key]||(item.generationDataAvailable?'No prompt is available in this media’s generation data.':state==='loading'?'Loading prompt details…':'Could not load prompt details.'))+'</p>'+
    (key==='prompt'&&state==='failed'?button('Retry details','class="retryPromptDetails"'):'')+
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
 const readyImages=new Set();let stashSaveQueued=false,reserveChecked=0,retryTimer,retryAt=0,retryAttempt=0,onlineTask=null;
 const retries=new Set();
 function savedJSON(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
 function uniqueItems(items){const ids=new Set();return items.filter(i=>i?.id&&!ids.has(i.id)&&ids.add(i.id));}
 function artistKeys(i){return [i.creatorId&&String(i.creatorId),i.credit&&'name:'+i.credit.trim().toLocaleLowerCase()].filter(Boolean);}
 function spacedArtists(items,before=[]){
  const out=[],pending=[...items],recent=before.slice(-9).map(artistKeys);
  while(pending.length){
   const index=pending.findIndex(i=>!recent.some(keys=>artistKeys(i).some(k=>keys.includes(k))));
   if(index<0)break;
   const item=pending.splice(index,1)[0];out.push(item);recent.push(artistKeys(item));if(recent.length>9)recent.shift();
  }
  return out;
 }
 function compactItem(item){
  const copy={...item};for(const key of ['prompt','negativePrompt','resources','parameters','detailVersion','generationDataAvailable','restoredFeed','cachedFallback'])delete copy[key];return copy;
 }
 function saveStash(){
  if(scrollMoving()){afterScroll('stash',saveStash);return;}
  if(!account||!status||view.kind!=='mix')return;
  const key=scope()+':stash',previous=savedJSON(key),old=previous?.account===account?previous:null;
  const eligible=i=>!isBanned(i)&&!isMuted(i),cached=i=>readyImages.has(path(i.path));
  const candidates=uniqueItems([...feed.filter(cached),...(old?.feed||[])]).filter(eligible);
  const fresh=candidates.filter(i=>!seenPosts.has(i.id));
  const collections={...(old?.collections||{})};
  if(channel)collections[channel]=uniqueItems([...strip.filter(cached),...(collections[channel]||[])]).filter(i=>!isBanned(i)).slice(0,20).map(compactItem);
  const order=[channel,...Object.keys(collections).filter(c=>c!==channel)].slice(0,3);
  const stash={account,status,channel,muted,feed:uniqueItems([...fresh,...candidates]).slice(0,20).map(compactItem),
   collections:Object.fromEntries(order.map(c=>[c,collections[c]])),saved:Date.now()};
  try{localStorage.setItem(key,JSON.stringify(stash));}catch{/* Keep the previous complete stash if storage is full. */}
 }
 function queueStash(){if(stashSaveQueued)return;stashSaveQueued=true;queueMicrotask(()=>{stashSaveQueued=false;saveStash();});}
 const avatarURLs=new Map(),avatarRequests=new Map(),avatarFailures=new Map();let avatarManifest=null;
 function avatarState(){
  const key=scope()+':avatars:'+account;
  if(avatarManifest?.key!==key){let records={};try{records=JSON.parse(localStorage.getItem(key)||'{}');}catch{}avatarManifest={key,records};}
  return avatarManifest;
 }
 function rememberAvatar(item){
  if(!account||!item?.creatorId)return;
  const state=avatarState(),id=String(item.creatorId),old=state.records[id];
  if(!old&&!item.avatarPath)return;
  if(old&&Date.now()-old.at<60000&&(!item.credit||old.name===item.credit))return;
  state.records[id]={path:old?.path||item.avatarPath,name:item.credit||old?.name||'',at:Date.now()};
  state.records=Object.fromEntries(Object.entries(state.records).sort((a,b)=>b[1].at-a[1].at).slice(0,300));
  try{localStorage.setItem(state.key,JSON.stringify(state.records));}catch{}
 }
 function avatarCacheKey(id){return '/creator-avatar/'+encodeURIComponent(scope()+':'+account)+('/'+encodeURIComponent(id));}
 async function avatarURL(id){
  if(!account||!id)return '';id=String(id);const state=avatarState(),entry=state.records[id],key=avatarCacheKey(id);
  if(avatarURLs.has(key))return avatarURLs.get(key);
  if(avatarRequests.has(key))return avatarRequests.get(key);
  if(Date.now()<(avatarFailures.get(key)||0))return '';
  const work=(async()=>{
   const cache=await caches.open('comfybridge-avatars-v1');let response=await cache.match(key);
   if(!response){
    if(!entry?.path||!connected)return '';
    const fetched=await fetch(path(entry.path));if(!fetched.ok)throw Error('Avatar unavailable');
    const blob=await fetched.blob();if(blob.size>2*1024*1024)throw Error('Avatar too large');
    const test=new Image(),url=URL.createObjectURL(blob);try{test.src=url;await test.decode();}finally{URL.revokeObjectURL(url);}
    response=new Response(blob,{headers:{'Content-Type':blob.type}});await cache.put(key,response.clone());
    const keys=await cache.keys();for(const expired of keys.slice(0,Math.max(0,keys.length-300)))await cache.delete(expired);
   }
   const url=URL.createObjectURL(await response.blob());avatarURLs.set(key,url);
   while(avatarURLs.size>300){const [old,value]=avatarURLs.entries().next().value;avatarURLs.delete(old);URL.revokeObjectURL(value);}
   return url;
  })();avatarRequests.set(key,work);try{return await work;}catch(error){
   avatarFailures.set(key,Date.now()+60000);if(avatarFailures.size>300)avatarFailures.delete(avatarFailures.keys().next().value);throw error;
  }finally{avatarRequests.delete(key);}
 }
 function avatarHTML(item){
  rememberAvatar(item);
  return '<span class="creatorAvatar" data-avatar-creator="'+esc(item.creatorId||'')+'" aria-hidden="true"><span>'+esc((item.credit||'?')[0])+'</span></span>';
 }
 function wireAvatars(root){
  if(!root)return;const bound=account;
  $$('.creatorAvatar',root).forEach(async el=>{try{
   const url=await avatarURL(el.dataset.avatarCreator);if(!url)return;
   const img=new Image();img.alt='';img.src=url;await img.decode();
   if(el.isConnected&&account===bound)el.replaceChildren(img);
  }catch{/* Keep the initials until a cached or valid avatar is available. */}});
 }
 function scope(){
  let config={};try{config=window.Native?JSON.parse(Native.configuration()):{};}catch{}
  return 'comfybridge-browse-v2:'+encodeURIComponent(config.fingerprint||config.host||(window.Desktop?'desktop':'local'));
 }
 function saveSnapshot(){
  if(scrollMoving()){afterScroll('snapshot',saveSnapshot);return;}
  if(!account||!status||view.kind!=='mix')return;
  saveStash();
  try{
   const old=savedJSON(scope()),same=old?.account===account;
   const fallback=same?(old.feed||[]).filter(i=>!isMuted(i)&&!isBanned(i)):[];
   const snapshot={account,status,channel,exposureVersion:1,strip:(strip.length?strip:same&&old.channel===channel?old.strip||[]:[]).filter(i=>!isBanned(i)).slice(0,20),feed:(feed.length?feed:fallback).filter(i=>!isMuted(i)&&!isBanned(i)).slice(-10),muted,
    details:[...details.entries()].filter(([key])=>key.startsWith(account+':')).slice(-100),saved:Date.now()};
   localStorage.setItem(scope(),JSON.stringify(snapshot));
  }catch{/* The separate compact, image-backed stash survives an oversized detail snapshot. */}
 }
 function restoreSnapshot(){
  const key=scope();if(cacheScope===key&&status)return;
  reset();details.clear();muted={};account='';status=null;cacheScope=key;
  try{
   const snapshot=savedJSON(key),saved=savedJSON(key+':stash');const data=snapshot?.account?snapshot:saved;if(!data?.account)return;
   const stash=saved?.account===data.account?saved:null;
   account=data.account;status=data.status;acceptTagWeights({...status,account});channel=data.channel;
   const recovered=(data.details||[]).map(([,entry])=>entry?.result?.item).filter(i=>i?.path?.startsWith('model-preview/browse/'+account+'/'));
   const recoveredStrip=channel?.startsWith('collection:')?recovered.filter(i=>membershipIds(i.collections).includes(channel.split(':')[1])):[];
   strip=uniqueItems([...(stash?.collections?.[channel]||[]),...(data.strip||[]),...recoveredStrip]).filter(i=>!isBanned(i)).slice(0,20);stripResume=true;muted=data.muted||{};
   loadSeen();if(!data.exposureVersion)for(const item of data.feed||[])markSeen(item.id);
   const savedFeed=[...(stash?.feed||[]),...(data.feed||[])];
   const candidates=uniqueItems(savedFeed.length?savedFeed:recovered).filter(i=>!isMuted(i)&&!isBanned(i));
   const unseen=candidates.filter(i=>!seenPosts.has(i.id));
   feed=spacedArtists(unseen.length?unseen:candidates).slice(0,savedFeed.length?10:100).map(i=>({...i,restoredFeed:true,cachedFallback:!unseen.length}));for(const entry of data.details||[])if(entry[1]?.result?.item?.detailVersion===2)details.set(...entry);
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
 async function imageBlob(url,onlyCached=false,prefetch=false){
  if(assetCache.has(url))return assetCache.get(url);
  if(onlyCached){
   const cache=await caches.open('comfybridge-browse-v1'),response=await cache.match(url);if(!response)return '';
   const object=URL.createObjectURL(await response.blob());assetCache.set(url,object);readyImages.add(url);return object;
  }
  if(imageRequests.has(url))return imageRequests.get(url);
  if(prefetch&&Date.now()<(mediaFailures.get(url)||0))return '';
  const work=(async()=>{
   const cache=await caches.open('comfybridge-browse-v1');let r=await cache.match(url);
   if(!r){
    if(onlyCached)return '';
    const controller=new AbortController();mediaControllers.set(url,controller);
    r=await fetch(url,{signal:controller.signal});if(!r.ok)throw Error('Preview unavailable');
    const limit=(url.endsWith('/full')?256:8)*1024*1024;
    if(Number(r.headers.get('Content-Length')||0)>limit){controller.abort();throw Error('Media exceeds cache limit');}
    const blob=await r.blob();if(blob.size>limit)throw Error('Media exceeds cache limit');
    r=new Response(blob,{headers:{'Content-Type':blob.type,'X-Browse-Bytes':String(blob.size)}});await cache.put(url,r.clone());
   }
   const object=URL.createObjectURL(await r.blob());assetCache.set(url,object);readyImages.add(url);queueStash();
   return object;
  })();imageRequests.set(url,work);
  try{return await work;}catch(error){if(prefetch&&error.name!=='AbortError')mediaFailures.set(url,Date.now()+60000);throw error;}finally{imageRequests.delete(url);mediaControllers.delete(url);}
 }
 async function cachedImage(img){
  const url=img.getAttribute('src');if(!url?.startsWith('/model-preview/browse/'))return;
  try{const object=await imageBlob(url);if(object){const ready=new Image();ready.src=object;await ready.decode();if(img.isConnected&&img.getAttribute('src')===url)img.src=object;}}catch{}
 }
 async function trimImages(){
  try{
   const stash=savedJSON(scope()+':stash');
   const protectedURLs=new Set([...strip.slice(0,20),...feed.slice(-10),...(stash?.account===account?[...(stash.feed||[]),...Object.values(stash.collections||{}).flat()]:[])].map(i=>path(i.path)));
   for(const item of fullWindow){protectedURLs.add(path(item.path));protectedURLs.add(path(item.fullPath));}
   if(viewer)protectedURLs.add(path(viewer.item.fullPath));
   const cache=await caches.open('comfybridge-browse-v1'),keys=await cache.keys();let bytes=0,count=0;
   for(const key of [...keys.filter(k=>protectedURLs.has(new URL(k.url).pathname)),...keys.filter(k=>!protectedURLs.has(new URL(k.url).pathname)).reverse()]){
    const r=await cache.match(key);bytes+=Number(r?.headers.get('X-Browse-Bytes')||0);count++;
    if((count>240||bytes>2*1024*1024*1024)&&!protectedURLs.has(new URL(key.url).pathname)){await cache.delete(key);readyImages.delete(new URL(key.url).pathname);}
   }
   for(const [key,value] of assetCache){if(assetCache.size<=120)break;if(protectedURLs.has(key))continue;assetCache.delete(key);URL.revokeObjectURL(value);}
  }catch{}
 }
 function detailKey(id){return account+':'+id;}
 function fetchDetail(item,fresh=false,prefetch=false){
  const key=detailKey(item.id),boundAccount=account,old=details.get(key),revision=socialRevisions.get(key)||0;
  if(!fresh&&old&&(prefetch||old.result.item.socialComplete!==false)&&(old.result.item.detailVersion===2||Date.now()-old.at<60000))return Promise.resolve(old.result);
  if(detailRequests.has(key))return detailRequests.get(key).then(result=>!prefetch&&result.item.socialComplete===false?fetchDetail(item,false,false):result);
  const request=api('browse/detail/'+item.id,prefetch?{prefetch:true}:undefined).then(result=>{
   if(boundAccount&&result.account!==boundAccount)throw Error('Civitai account changed. Refresh Browse.');
   if(boundAccount!==account)throw Error('Civitai account changed. Refresh Browse.');
   if(revision!==(socialRevisions.get(key)||0)){
    // A read begun before a confirmed write must not put old social state back.
    for(const field of ['reactions','stats','collections','following'])if(field in item)result.item[field]=item[field];
   }
   result.item=overlaySocial(result.item);acceptTagWeights(result);
   details.delete(key);details.set(key,{result,at:Date.now()});
   while(details.size>100)details.delete(details.keys().next().value);
   updateItemSocial(item,result.item);return result;
  }).finally(()=>detailRequests.delete(key));
  detailRequests.set(key,request);return request;
 }
 function queueDetail(item,priority=false){
  const old=details.get(detailKey(item?.id));
  if(!item?.id||(old&&(old.result.item.detailVersion===2||Date.now()-old.at<60000))||detailQueue.some(i=>i.id===item.id))return;
  priority?detailQueue.unshift(item):detailQueue.push(item);detailQueue=detailQueue.slice(0,8);runDetails();
 }
 function backgroundAllowed(){return available()&&!syncing&&!filling&&!originalTransfers.size;}
 async function runDetails(){
  if(detailRunning||!backgroundAllowed()||busy||stripBusy)return;
  detailRunning=true;
  try{while(detailQueue.length&&backgroundAllowed()&&!busy&&!stripBusy){
   const item=detailQueue.shift();try{await fetchDetail(item,false,true);}catch{break;}
  }}finally{detailRunning=false;}
 }
 function upcoming(){
  if(viewer){const list=viewer.list||feed,index=Math.max(0,list.findIndex(i=>i.id===viewer.item.id));return list.slice(index);}
  const top=$('#workspace')?.getBoundingClientRect().top||0;
  const tile=$$('#browseFeed .browseTile').find(el=>el.getBoundingClientRect().bottom>top);
  return feed.slice(Math.max(0,tile?feed.findIndex(i=>i.id===tile.browseItem.id):0));
 }
 async function refreshBank(launch=false){
  if((!launch&&(view.kind!=='mix'||!available()))||!connected||document.hidden||bankBusy||bankUnsupported||Date.now()-bankChecked<8000)return;
  bankBusy=true;bankChecked=Date.now();const ticket=session,bound=account;
  try{
   const r=await api('browse/bank',{seen:[...seenPosts].slice(-5000)});
   if(ticket!==session||bound!==account||!r.bank)return;
   if(launch&&page!=='browse'&&r.account!==account){reset();status=null;muted={};details.clear();account=r.account;loadSeen();}
   if(r.account!==account)return;
   bankAhead=(r.items||[]).filter(i=>!isMuted(i)&&!isBanned(i)&&!seenPosts.has(i.id));registerMedia(bankAhead);
   try{localStorage.setItem(scope()+':bank',JSON.stringify({account,items:bankAhead.map(compactItem)}));}catch{}
  }catch(e){if(/HTTP (404|405)/.test(e.message))bankUnsupported=true;}
  finally{bankBusy=false;}
 }
 async function parallelMedia(items,worker){
  const pending=[...items];await Promise.all([0,1].map(async()=>{while(pending.length&&backgroundAllowed())await worker(pending.shift());}));
 }
 function launchWarm(delay=1000){
  socialSoon();
  clearTimeout(launchTimer);launchTimer=setTimeout(async()=>{
   if(!connected||document.hidden)return;
   if(syncing||filling||originalTransfers.size||launchRunning){launchWarm(3000);return;}
   if(page==='browse'){refreshBank().catch(()=>{});warm();launchWarm(10000);return;}
   launchRunning=true;const bound=epoch;
   try{
    await refreshBank(true);if(bound!==epoch||!connected||document.hidden)return;
    fullWindow=bankAhead.slice(0,25);registerMedia(fullWindow);
    const pending=[...fullWindow];
    await Promise.all([0,1].map(async()=>{while(pending.length&&bound===epoch&&connected&&!document.hidden&&!syncing&&!filling&&!originalTransfers.size&&page!=='browse'){
     const item=pending.shift();for(const size of ['path','fullPath']){if(bound!==epoch||document.hidden||syncing||filling||originalTransfers.size)break;try{await imageBlob(path(item[size]),false,true);}catch{}}
    }}));
    await trimImages();
   }finally{launchRunning=false;launchWarm(10000);}
  },delay);
 }
 function pauseMedia(){warmRevision++;for(const c of mediaControllers.values())c.abort();}
 function warm(){
  if(scrollMoving()){afterScroll('warm',warm);return;}
  if(fullWarmRunning&&upcoming()[0]?.id!==fullWindow[0]?.id)pauseMedia();
  clearTimeout(warmTimer);warmTimer=setTimeout(async()=>{
   if(!available()||view.kind==='preferences')return;
   if(scrollMoving()){afterScroll('warm',warm);return;}
   if(!backgroundAllowed()){warmTimer=setTimeout(warm,1000);return;}
   if(fullWarmRunning)return;
   fullWarmRunning=true;const ticket=session,revision=warmRevision;
   try{
    // Metadata lookahead costs no upstream request; selection runs on the PC.
    await refreshBank();if(ticket!==session||!backgroundAllowed())return;
    const next=upcoming(),isMix=view.kind==='mix'&&(!viewer||viewer.list===feed);
    fullWindow=uniqueItems([...next,...(isMix?bankAhead:[])]).filter(i=>!isBanned(i)&&(!isMix||!isMuted(i))).slice(0,isMix?25:12);
    registerMedia([...fullWindow,...strip.slice(0,20)]);
    const fullTask=parallelMedia(fullWindow,async item=>{
     if(ticket!==session||revision!==warmRevision||!backgroundAllowed())return;
     if(fullWindow.indexOf(item)<4)queueDetail(item);
     try{await imageBlob(path(item.path),false,true);}catch{}
     if(ticket!==session||revision!==warmRevision||!backgroundAllowed())return;
     try{await imageBlob(path(item.fullPath),false,true);}catch{}
     if(fullWindow.indexOf(item)<4)queueDetail(item);
    });
    const stripTask=(async()=>{for(const item of strip.slice(0,20)){
     if(ticket!==session||!backgroundAllowed())return;
     try{await imageBlob(path(item.path),false,true);}catch{}
    }})();
    await Promise.all([fullTask,stripTask]);if(backgroundAllowed())await parallelMedia(fullWindow,async item=>{rememberAvatar(item);try{await avatarURL(item.creatorId);}catch{}});await trimImages();saveSnapshot();runDetails();
    // Explicit subfeeds have one page of lookahead, never a metadata bank.
    if(view.kind!=='mix'&&view.kind!=='preferences'&&!viewer&&!feedEnded&&!busy&&!refreshing&&upcoming().length<12&&Date.now()>=feedWaitUntil&&emptyPages<2)loadFeed();
   }finally{fullWarmRunning=false;if(available()&&ticket===session)warmTimer=setTimeout(warm,revision===warmRevision?8000:100);}
  },100);
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
  if(channel===value)return;saveStash();channel=value;
  const stash=savedJSON(scope()+':stash');strip=(stash?.account===account?stash.collections?.[value]||[]:[]).filter(i=>!isBanned(i));stripCursor='';stripBusy=false;stripResume=!!strip.length;
  $('#browseCarousel').replaceChildren();paintStrip(strip);paintCollections();saveSnapshot();loadStrip();
 }
 async function refresh(){
  if(refreshing||view.kind==='preferences')return;refreshing=true;
  $('#browseRefresh')?.classList.add('refreshing');$('#browsePull')?.classList.add('refreshing');
  const ticket=++session;busy=false;stripBusy=false;cursor='';stripCursor='';stripResume=false;feedEnded=false;emptyPages=0;details.clear();detailQueue=[];
  if(view.kind==='mix'){saveSnapshot();flushSeen();}
  // Retain visible/cache content until each replacement request succeeds.
  try{await refreshStatus(true);if(ticket!==session)return;await Promise.all([loadFeed(true),view.kind==='mix'?loadStrip(true):Promise.resolve()]);}
  catch(e){handleReadError(e,'status');}
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
 function reset(){bankAhead=[];bankChecked=0;bankUnsupported=false;fullWindow=[];feed=[];strip=[];cursor='';stripCursor='';channel='';stripResume=false;emptyPages=0;}
 function available(){return page==='browse'&&!document.hidden&&connected;}
 function savedNotice(text=''){
  const el=$('#browseError');if(el){el.classList.remove('warning');el.classList.add('muted');el.textContent=text;}
 }
 function queueRetry(kind,seconds=5){
  retries.add(kind);retryAt=Math.max(retryAt,Date.now()+seconds*1000);clearTimeout(retryTimer);
  retryTimer=setTimeout(()=>{
   if(!available())return;
   const pending=[...retries];retries.clear();retryAt=0;
   if(pending.includes('status'))resumeOnline();
   else {if(pending.includes('feed'))loadFeed();if(pending.includes('strip'))loadStrip();}
  },Math.max(1000,retryAt-Date.now()));
 }
 function handleReadError(error,kind){
  if(/HTTP (429|50[0234])|HTTP 503|paused briefly|could not be reached|timed? ?out|network|connection|failed to fetch/i.test(error.message)){
   const match=error.message.match(/Retry in (\d+) seconds/i),seconds=match?Number(match[1]):Math.min(60,5*2**Math.min(retryAttempt++,4));
   queueRetry(kind,seconds);savedNotice(feed.length||strip.length?'Showing saved items while Browse reconnects.':'Browse is temporarily unavailable. Retrying automatically.');
  }else{const el=$('#browseError');if(el){el.classList.add('warning');el.classList.remove('muted');el.textContent=error.message;}}
 }
 async function resumeOnline(){
  if(!available()||!$('#browseConnected'))return;
  if(onlineTask)return onlineTask;
  const ticket=session;
  onlineTask=(async()=>{
   try{
    await refreshStatus(true);if(ticket!==session||!available())return;
    $('#browseConnected').hidden=false;savedNotice();
    if(!strip.length||stripResume)loadStrip();
    if(!feed.length)loadFeed();
    observeMore();warm();
   }catch(e){if(ticket===session)handleReadError(e,'status');}
  })().finally(()=>{onlineTask=null;});
  return onlineTask;
 }
 function connectionChanged(value){
  if(!value)return;
  setTimeout(()=>{if(available())resumeOnline();},0);
 }
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
  await scrollOpportunity();if(!available())return;
  if(account===s.account&&followTicket!==followRevision&&status?.followingIds){s.followingIds=status.followingIds;s.follows=status.follows;}
  if(account&&account!==s.account){reset();details.clear();detailQueue=[];muted={};close();clearFeed();$('#browseCarousel')?.replaceChildren();}
  if(account===s.account&&banTicket!==banRevision)s.bans=status?.bans||[];
  account=s.account;loadSeen();status=s;paintSocialQueue();socialSoon();acceptTagWeights(s);$('#browseHello').textContent='Hello '+s.username;
  muted=s.timeouts||muted;
  if(!channel||(channel!=='reactions'&&!s.collections.some(c=>'collection:'+c.id===channel)))channel=s.collections.length?'collection:'+s.collections[0].id:'reactions';
  if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem||{}))el.remove();});}
  pruneBanned();paintCollections();paintSocial();saveSnapshot();flushSeen();refreshCachedFeed();refreshBank().catch(()=>{});

 }
 async function render(){
  showBrowseHeader();
  clearBackLayer();
  const stale=activityAge()>=7200000;markActivity();
  if(suspended&&!stale&&suspended.scope===scope()){
   const saved=suspended;suspended=null;$('#main').replaceChildren(...saved.nodes);
   await Promise.resolve();$('#workspace').scrollTop=saved.scroll;
   paintSocial();revealFeedCards($('#browseFeed'));observeMore();schedule();warm();refreshStatus(true).catch(()=>{});openPendingCreator();return;
  }
  suspended=null;if(stale){cursor='';stripCursor='';detailQueue=[];cacheScope='';status=null;close();collectionPopup?.remove();collectionPopup=null;}
  view={kind:'mix'};history=[];feedEnded=false;busy=false;stripBusy=false;
  const ticket=++session;clearTimeout(timer);observer?.disconnect();nearDetails.disconnect();viewedTiles.disconnect();restoreSnapshot();
  $('#main').innerHTML='<section class="civitaiBrowse"><div id="browsePull" role="status" aria-label="Pull to refresh"><i class="spinner"></i></div><p id="browseError" class="warning" role="status"></p><div id="browseConnected" hidden><div class="browseCollectionHeading"><details id="browseSources"><summary><u id="browseSourceLabel">Collection</u>'+caretIcon(true)+'</summary><div class="browseMenu" role="menu">'+button('Collection','data-channel="collection"')+button('Reacted media','data-channel="reactions"')+'</div></details><span id="browseCollectionDot">•</span><details id="browseCollections"><summary aria-label="Choose a media collection"><u id="browseCollectionLabel">Choose collection</u>'+caretIcon(true)+'</summary><div id="browseCollectionMenu" class="browseMenu" role="menu"></div></details><small id="browseItemCount"></small></div><p id="browseEmptyCollections" hidden>No media collections yet. Create one in the collection menu.</p><div id="browseCarousel" class="browseCarousel"></div><div class="browseFeedHeading"><h2>For you</h2><button id="browseImport" aria-label="Edit feed preferences"></button></div><div id="browseFeed" class="browseFeed"></div>'+pullerHTML()+'</div></section>';
  $('#browseRefresh').innerHTML=refreshIcon;$('#browseRefresh').onclick=refresh;
  $('#browseImport').onclick=openPreferences;$('#browseMore').onclick=()=>loadFeed();
  $('#browseCarousel').onscroll=()=>{const el=$('#browseCarousel');if(el.scrollLeft+el.clientWidth>el.scrollWidth-350)loadStrip();};
  // Restore metadata and device files before waiting for the PC or Civitai.
  if(status){
   registerMedia([...strip,...feed]);await Promise.all([...strip,...feed].flatMap(i=>[imageBlob(path(i.path),true).catch(()=>{}),imageBlob(path(i.fullPath),true).catch(()=>{})]));
   if(ticket!==session)return;
   const readyFeed=feed.filter(i=>readyImages.has(path(i.path)));feed=(readyFeed.length?readyFeed:feed).slice(0,10);
   saveStash();
   $('#browseConnected').hidden=false;$('#browseHello').textContent='Hello '+status.username;
   paintCollections();paintFeed(feed.map(overlaySocial));paintStrip(strip.map(overlaySocial));paintSocialQueue();socialSoon();
  }
  if(!connected){savedNotice(feed.length||strip.length?'Showing saved items while connecting…':'Connecting to Browse…');schedule();return;}
  await resumeOnline();if(ticket!==session)return;
  if(stale){await refresh();$('#workspace').scrollTop=0;}
  schedule();openPendingCreator();
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{
  if(page!=='browse')return;
  if(!document.hidden&&activityAge()>=7200000){render();return;}
  if(available())try{if($('#browseConnected')?.hidden){resumeOnline();}else{await refreshStatus();if(!feed.length)loadFeed();if(!strip.length)loadStrip();}}catch(e){handleReadError(e,'status');}
  schedule();
 },15000);}
 function suspend(){
  showBrowseHeader();
  clearBackLayer();
  close();collectionPopup?.remove();collectionPopup=null;
  if(!$('.civitaiBrowse'))return;
  suspended={scope:scope(),scroll:$('#workspace').scrollTop,nodes:[...$('#main').childNodes]};
  observer?.disconnect();clearTimeout(timer);clearTimeout(warmTimer);clearTimeout(retryTimer);for(const c of mediaControllers.values())c.abort();session++;busy=false;stripBusy=false;
 }
 function tile(item,small=false){Object.assign(item,overlaySocial(item));rememberAvatar(item);registerMedia([item]);
  const el=document.createElement('article');
  el.className=small?'browseThumb':'browseTile';el.browseItem=item;nearDetails.observe(el);
  if(!small&&view.kind==='mix'){if(item.restoredFeed)el.dataset.restored='true';viewedTiles.observe(el);}
  el.innerHTML='<button class="browseMedia" aria-label="Open '+esc(item.type)+' by '+esc(item.credit)+'">'+imageHTML(item)+(item.type==='video'?'<span class="browseVideo">▶</span>':'')+'</button>';
  if(!small&&view.kind==='mix')$('.browseMedia img',el)?.addEventListener('load',()=>watchExposure(el));
  $('.browseMedia',el).onclick=()=>open(item,small?strip:feed);
  if(!small){
   const caption=document.createElement('div');
   caption.className='browseCaption';
   caption.innerHTML=button(esc(item.credit||'Creator'),'class="feedAuthor"')+'<span class="feedFollowing" aria-label="Following" '+(following(item)?'':'hidden')+'>✓</span>'+button('<svg viewBox="0 0 24 24"><path d="M9 2h6M12 2v3m6 1 2 2M12 9v5l3 2"/><circle cx="12" cy="14" r="8"/></svg>','class="feedTimeout" aria-label="Silence creator for two hours"')+
    '<div class="feedReactions">'+button(reactionLabel(item),'data-feed-react="Like" aria-label="Like" aria-pressed="'+(item.reactions||[]).includes('Like')+'"')+'</div>'+
    button('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>','class="feedCollect '+(membershipIds(item.collections).length?'bookmarked':'')+'" aria-label="Add to collection"');
   el.append(caption);
   if(item.chosenBy?.kind==='curation'){
    const via=document.createElement('div');via.className='feedDiscovery';via.innerHTML=discoveryHTML(item);caption.insertBefore(via,$('.feedTimeout',caption));wireDiscovery(via,item);
   }
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
  if(small)hydrate(el);else{
   el.classList.add('cardPending');const img=$('.browseMedia img',el);el.cardURL=img.getAttribute('src');img.removeAttribute('src');img.loading='eager';
   queueMicrotask(()=>prepareFeedCard(el));
  }
  return el;
 }
 function reactionCount(item,key){
  return Number(item.stats?.[key.toLowerCase()+'CountAllTime']??item.stats?.[key.toLowerCase()+'Count']??0);
 }
 function saveView(){
  showBrowseHeader();
  observer?.disconnect();
  const main=$('#main');
  history.push({view,feed,cursor,feedEnded,emptyPages,scroll:$('#workspace').scrollTop,nodes:[...main.childNodes]});
  main.replaceChildren();
  session++;busy=false;stripBusy=false;
 }
 function back(){
  showBrowseHeader();
  clearBackLayer();
  if(collectionPopup){collectionPopup.remove();collectionPopup=null;return true;}
  if(!history.length)return false;
  observer?.disconnect();session++;busy=false;stripBusy=false;
  const saved=history.pop();
  view=saved.view;feed=saved.feed;cursor=saved.cursor;feedEnded=saved.feedEnded;emptyPages=saved.emptyPages||0;
  $('#main').replaceChildren(...saved.nodes);
  if(view.kind==='mix'){feed=feed.filter(i=>!isMuted(i));$$('.browseTile').forEach(el=>{if(isMuted(el.browseItem))el.remove();});saveSnapshot();}
  pruneBanned();paintSocial();revealFeedCards($('#browseFeed'));$('#workspace').scrollTop=saved.scroll;
  if(view.kind!=='preferences')observeMore();else paintPreferences();
  return true;
 }
 function feedLead(){return Math.round(($('#workspace')?.clientHeight||innerHeight)*1.5);}
 function observeMore(){
  observer?.disconnect();
  if(!$('#browseMore')||feedEnded)return;
  observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&emptyPages<2)loadFeed();},{root:$('#workspace'),rootMargin:feedLead()+'px 0px'});
  observer.observe($('#browseMore'));pullerMotion.disconnect();pullerMotion.observe($('#browseMore'));
 }
 function openSubject(kind,id,name){
  if(!id)return;
  saveView();
  view={kind,id:String(id),name,filter:'all'};
  feed=[];cursor='';feedEnded=false;emptyPages=0;
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+(kind==='creator'?avatarHTML({creatorId:String(id),credit:name}):'')+'<h2>'+(kind==='creator'?button(esc(name),'class="profileName" aria-label="Open '+esc(name)+' profile"'):esc(name))+'</h2>'+(kind==='creator'?button('Follow','class="creatorFollow" data-follow-creator="'+esc(id)+'"'):'')+'<div class="subjectFilters">'+
   [['image','▧','Images'],['video','▷','Videos'],['all','▦','All media']].map(([value,icon,label])=>button(icon,'data-media-filter="'+value+'" aria-label="'+label+'" title="'+label+'" aria-pressed="'+(value==='all')+'"')).join('')+'</div></div><p id="browseError" class="warning" role="status"></p><div id="browseFeed" class="browseFeed"></div>'+pullerHTML()+'</section>';
  $('.browseBack').onclick=back;wireAvatars($('.subjectHeading'));
  if(kind==='creator'){$('.profileName').onclick=()=>profile(name);$('.creatorFollow').onclick=e=>changeFollow(e.currentTarget,id);paintSocial();}
  $$('[data-media-filter]').forEach(b=>b.onclick=()=>{
   view.filter=b.dataset.mediaFilter;
   $$('[data-media-filter]').forEach(other=>other.setAttribute('aria-pressed',String(other===b)));
   session++;busy=false;feed=[];cursor='';feedEnded=false;emptyPages=0;clearFeed();
   $('#browseMore').hidden=false;loadFeed();observeMore();
  });
  $('#browseMore').onclick=loadFeed;
  $('#workspace').scrollTop=0;loadFeed();observeMore();
 }
 async function openPreferences(){
  saveView();view={kind:'preferences',sort:'weight',filter:'both',search:'',items:[]};
  try{Object.assign(view,JSON.parse(localStorage.getItem(scope()+':preferences:'+account)||'{}'));}catch{}
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="subjectHeading">'+button('‹','class="browseBack" aria-label="Back"')+'<h2>Your feed</h2></div><div class="weightTools">'+
   '<details class="weightMenu"><summary aria-label="Sort feed preferences"><span id="weightSortLabel"></span>'+caretIcon(true)+'</summary><div class="browseMenu">'+button('Weight','data-weight-sort="weight"')+button('Alphabetical','data-weight-sort="alpha"')+'</div></details>'+
   '<details class="weightMenu"><summary aria-label="Filter feed preferences"><span id="weightFilterLabel"></span>'+caretIcon(true)+'</summary><div class="browseMenu">'+button('Both','data-weight-filter="both"')+button('Creators','data-weight-filter="creator"')+button('Tags','data-weight-filter="tag"')+'</div></details></div>'+
   '<div class="weightSearchBox"><input id="weightSearch" type="search" autocomplete="off" placeholder="Search tags or creators…" aria-label="Search feed preferences"></div><p class="preferenceError warning" role="status"></p><div class="weightColumns"><span>Tag/Creator</span><span>Weight</span><span>Vote</span><span>Unweight</span><span>Ban</span></div>'+
   '<div id="weightActive"></div><section class="weightSection"><h3>Unweighted</h3><div id="weightDisabled"></div></section><section class="weightSection bannedSection"><h3>Ban</h3><div id="weightBanned"></div></section></section>';
  $('.browseBack').onclick=back;$('#workspace').scrollTop=0;
  for(const [attribute,key] of [['weight-sort','sort'],['weight-filter','filter']]){
   $$('[data-'+attribute+']').forEach(b=>b.onclick=()=>{view[key]=b.getAttribute('data-'+attribute);b.closest('details').open=false;
    try{localStorage.setItem(scope()+':preferences:'+account,JSON.stringify({sort:view.sort,filter:view.filter}));}catch{}
    paintPreferences();});
  }
  $('#weightSearch').oninput=e=>{view.search=e.target.value;paintPreferences();};
  paintPreferences();
  try{await refreshPreferences();}catch(error){$('.preferenceError').textContent=error.message;}
 }
 async function refreshPreferences(){
  const ticket=session;
  const result=await api('browse/preferences');
  if(ticket!==session||view.kind!=='preferences')return;
  if(result.account!==account){reset();render();return;}
  acceptTagWeights(result);view.items=result.items;status.bans=result.bans||result.items.filter(i=>i.banned).map(i=>({kind:i.kind,id:i.id,name:i.name}));
  pruneBanned();paintPreferences();
 }
 function paintPreferences(){
  const positions=new Map($$('.weightRow').map(row=>[row.dataset.key,row.getBoundingClientRect().top]));
  $('#weightSortLabel').textContent='Sort: '+(view.sort==='alpha'?'Alphabetical':'Weight');
  $('#weightFilterLabel').textContent='Show: '+({both:'Both',creator:'Creators',tag:'Tags'}[view.filter]||'Both');
  for(const id of ['weightActive','weightDisabled','weightBanned'])$('#'+id).replaceChildren();
  const items=[...(view.items||[])].filter(i=>(view.filter==='both'||i.kind===view.filter)&&i.name.toLocaleLowerCase().includes((view.search||'').trim().toLocaleLowerCase())).sort((a,b)=>
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
 async function showCollections(item,boundAccount,knownCollections=status?.collections||[]){
  if(collectionPopup)collectionPopup.remove();
  const popup=document.createElement('div');
  popup.className='feedCollectionShade';collectionPopup=popup;
  popup.innerHTML='<section role="dialog" aria-modal="true" aria-label="Collections"><div class="row spread"><strong>Collections</strong>'+button('×','class="collectionClose" aria-label="Close collections"')+'</div><div class="feedCollectionChoices">Loading…</div><div class="newCollectionAnchor"></div><p class="warning" role="status"></p></section>';
  document.body.append(popup);
  function dismiss(){popup.remove();if(collectionPopup===popup)collectionPopup=null;}
  $('.collectionClose',popup).onclick=dismiss;
  popup.onclick=e=>{if(e.target===popup)dismiss();};
  async function refresh(){
   if(account!==boundAccount)throw Error('Civitai account changed. Reopen this menu.');
   const known=Array.isArray(item.collections),members=membershipIds(item.collections),host=$('.feedCollectionChoices',popup);
   host.innerHTML=(status?.account===boundAccount?status.collections:knownCollections).map(c=>'<label><input type="checkbox" value="'+c.id+'" '+(!known?'disabled ':'')+(members.includes(String(c.id))?'checked':'')+'>'+esc(c.name)+'</label>').join('');
   $$('input',host).forEach(box=>box.onchange=async()=>{
    box.disabled=true;
    try{const result=await action({account:boundAccount,kind:'collect',imageId:item.id,collectionId:box.value,selected:box.checked});const ids=new Set(membershipIds(item.collections));box.checked?ids.add(box.value):ids.delete(box.value);updateItemSocial(item,{collections:result.collections||[...ids].map(collectionId=>({collectionId}))});}
    catch(error){box.checked=!box.checked;$('p.warning',popup).textContent=error.message;}
    finally{box.disabled=false;}
   });
   const anchor=$('.newCollectionAnchor',popup);
   anchor.innerHTML=button('＋ New collection','class="newCollection"');
   $('.newCollection',anchor).onclick=()=>createCollection(anchor,collections=>{knownCollections=collections;return refresh();},boundAccount);
   if(!known){
    const result=await api('browse/memberships/'+item.id);
    if(!popup.isConnected||account!==boundAccount)return;
    if(result.account!==boundAccount)throw Error('Civitai account changed. Reopen this menu.');
    // This lookup only changes memberships, never reactions or other social state.
    updateItemSocial(item,overlaySocial({...item,collections:result.collections}));
    if(Array.isArray(item.collections))return refresh();
   }
  }
  try{await refresh();}catch(error){if(popup.isConnected)$('p.warning',popup).textContent=error.message;}
 }
 function pullerHTML(){return '<div id="browseMore" class="browsePuller" role="status" tabindex="0" aria-label="Load more media"><i class="spinner"></i><span>Pulling..</span></div>';}
 function pendingCards(){const host=$('#browseFeed');return !!(feedBuilds.get(host)?.length||host?.querySelector('.cardPending:not(.cardFailed)'));}
 function paintPuller(){
  const more=$('#browseMore');if(!more)return;
  const failed=!!$('#browseFeed .cardFailed');more.hidden=feedEnded&&!pendingCards()&&!failed;
  more.classList.toggle('pullFailed',failed&&!pendingCards()&&!busy);
  more.querySelector('span').textContent=failed&&!pendingCards()&&!busy?'Media unavailable · tap to retry':'Pulling..';
  more.onclick=()=>{const failed=$$('#browseFeed .cardFailed');if(failed.length)failed.forEach(prepareFeedCard);else loadFeed();};
  more.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();more.click();}};
 }
 const feedBuilds=new WeakMap(),cardLoads=[];let cardLoading=0;
 function clearFeed(){const host=$('#browseFeed');if(host){feedBuilds.delete(host);host.replaceChildren();}}
 function prepareFeedCard(el){
  if(el.preparing||el.cardReady)return;el.preparing=true;el.classList.remove('cardFailed');cardLoads.push(el);drainCardLoads();
 }
 function drainCardLoads(){
  while(cardLoading<2&&cardLoads.length){
   const el=cardLoads.shift();if(!el.isConnected){el.preparing=false;continue;}
   cardLoading++;
   (async()=>{try{
    const img=$('.browseMedia img',el),url=el.cardURL;
    const object=url.startsWith('/model-preview/browse/')?await imageBlob(url):url;
    await scrollOpportunity();
    const decoded=new Image();decoded.src=object;await decoded.decode();
    await scrollOpportunity();img.src=object;await img.decode();el.cardReady=true;
   }catch{el.classList.add('cardFailed');}
   finally{el.preparing=false;cardLoading--;revealFeedCards(el.parentElement);afterScroll('puller',paintPuller);drainCardLoads();}})();
  }
 }
 function revealFeedCards(host){
  if(!host)return;afterScroll(host,()=>commitFeedCards(host));
 }
 function commitFeedCards(host){
  if(!host?.isConnected||host.id!=='browseFeed')return;
  if(feedBuilds.get(host)?.length)scheduleFeedBuild(host);
  const ready=[];for(const el of host.querySelectorAll('.cardPending')){
   if(el.classList.contains('cardFailed'))continue;
   if(!el.cardReady){if(!el.preparing)prepareFeedCard(el);break;}ready.push(el);
  }
  if(!ready.length)return;
  const more=$('#browseMore'),section=host.closest('.civitaiBrowse'),viewport=$('#workspace').getBoundingClientRect();
  const old=more?.getBoundingClientRect(),canAnimate=!viewer&&!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const oldTop=more?.offsetTop,oldHeight=more?.offsetHeight;
  // One write phase, one layout read phase: no write/read loop for every card.
  for(const el of ready)el.classList.remove('cardPending');
  const visible=canAnimate?ready.filter(el=>{const r=el.getBoundingClientRect();return r.bottom>viewport.top&&r.top<viewport.bottom&&r.right>viewport.left&&r.left<viewport.right;}):[];
  let ghost;if(visible.length&&old&&old.bottom>viewport.top&&old.top<viewport.bottom&&!more.hidden&&section&&!section.querySelector('.pullGhost')){
   ghost=more.cloneNode(true);ghost.removeAttribute('id');ghost.removeAttribute('tabindex');ghost.setAttribute('aria-hidden','true');ghost.classList.add('pullGhost','motionVisible');
   ghost.style.top=oldTop+'px';ghost.style.height=oldHeight+'px';section.append(ghost);more.classList.add('pullCovered');
  }
  visible.forEach(el=>el.classList.add('cardArriving'));
  if(visible.length)setTimeout(()=>{ghost?.remove();more?.classList.remove('pullCovered');visible.forEach(el=>el.classList.remove('cardArriving'));},190);
  paintPuller();checkBottom();
 }
 function scheduleFeedBuild(host){afterScroll('feed-build',()=>{
  if(!host?.isConnected)return;const queue=feedBuilds.get(host)||[],fragment=document.createDocumentFragment();
  for(const item of queue.splice(0,3))fragment.append(tile(item));host.append(fragment);
  wireAvatars($('.subjectHeading'));paintPuller();
  if(queue.length)scheduleFeedBuild(host);
 });}
 function paintFeed(items){const host=$('#browseFeed');if(!host)return;
  const queue=feedBuilds.get(host)||[];queue.push(...items);feedBuilds.set(host,queue);scheduleFeedBuild(host);
 }
 new ResizeObserver(()=>{if(typeof page!=='undefined'&&page==='browse'){observeMore();checkBottom();}}).observe(document.querySelector('#workspace'));
 function paintStrip(items){const el=$('#browseCarousel');if(el)items.forEach(i=>el.append(tile(i,true)));}
 async function loadFeed(replace=false){
  replace=replace===true;
  if(!replace&&Date.now()<feedWaitUntil)return;
  if(busy||(!replace&&pendingCards())||feedEnded||!available()||!$('#browseMore'))return;busy=true;const ticket=session;paintPuller();
  try{const r=await feedPage(view.kind==='mix'?'mix':view.kind+':'+view.id+':'+view.filter,cursor,replace?[]:feed.map(i=>i.id),replace);await scrollOpportunity();if(ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   let added=r.items.map(overlaySocial).filter(i=>!isBanned(i)&&!(view.kind==='mix'&&(isMuted(i)||seenPosts.has(i.id)))&&(replace||!feed.some(x=>x.id===i.id)));
   if(view.kind==='mix')added=spacedArtists(added,replace?[]:feed);
   if(replace&&added.length){await imageBlob(path(added[0].path));if(ticket!==session)return;feed=[];clearFeed();}
   feed.push(...added);cursor=r.nextCursor||'';feedEnded=!r.nextCursor;paintFeed(added);saveSnapshot();warm();savedNotice();
   feedWaitUntil=r.limited?Date.now()+1000*Math.max(2,r.retryAfter||0):0;
   emptyPages=added.length?0:(r.limited?2:emptyPages+1);
   if(r.retryAfter){queueRetry('feed',r.retryAfter);if(!added.length)savedNotice('Showing saved items. Refreshing shortly…');}
   else if(r.limited&&!added.length)savedNotice('Still searching for matching media. Load more continues from here.');
   else if(!added.length)$('#browseError').textContent='No new media in this page. Tap Pulling.. to try again or refresh.';
  }catch(e){if(ticket===session){emptyPages=2;handleReadError(e,'feed');}}
  finally{if(ticket===session){busy=false;paintPuller();checkBottom();}}
 }
 function checkBottom(){
  if(!available()||busy||pendingCards()||feedEnded||emptyPages>=2||view.kind==='preferences')return;
  const more=$('#browseMore'),workspace=$('#workspace');
  if(more&&!more.hidden&&more.getBoundingClientRect().top<workspace.getBoundingClientRect().bottom+feedLead()){
   clearTimeout(bottomTimer);bottomTimer=setTimeout(()=>{
    const current=$('#browseMore');if(current&&current.getBoundingClientRect().top<workspace.getBoundingClientRect().bottom+feedLead()&&emptyPages<2)loadFeed();
   },Math.max(120,feedWaitUntil-Date.now()));
  }
 }
 const scrollHost=document.querySelector('#workspace');
 scrollHost.addEventListener('scroll',()=>{
  if(page!=='browse')return;
  const now=performance.now(),top=scrollHost.scrollTop;scrollSpeed=Math.abs(top-scrollTopSample)/Math.max(1,now-lastScroll);lastScroll=now;scrollTopSample=top;
  trackBrowseHeader(top);
  cancelArrivalMotion();
  if(!scrollCheckFrame)scrollCheckFrame=requestAnimationFrame(()=>{scrollCheckFrame=0;checkBottom();});
  afterScroll('scroll-maintenance',()=>{warm();refreshCachedFeed();});
 },{passive:true});
 scrollHost.addEventListener('scrollend',()=>{lastScroll=-Infinity;scrollSpeed=0;clearTimeout(workTimer);workTimer=0;scheduleScrollWork();},{passive:true});
 document.querySelector('#browseTop').onclick=()=>{showBrowseHeader();scrollHost.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
 document.querySelector('#workspace > header').addEventListener('focusin',showBrowseHeader);
 const pullerMotion=new IntersectionObserver(entries=>entries.forEach(e=>e.target.classList.toggle('motionVisible',e.isIntersecting)),{root:scrollHost});
 async function loadStrip(replace=false){
  replace=replace===true;
  if(stripBusy||!available()||(!replace&&!stripResume&&strip.length&&!stripCursor))return;stripBusy=true;const chosen=channel,ticket=session;
  try{const r=await feedPage(chosen,stripCursor,replace?[]:strip.map(i=>i.id));if(chosen!==channel||ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   const added=r.items.map(overlaySocial).filter(i=>!isBanned(i)&&(replace||!strip.some(x=>x.id===i.id)));
   if(replace&&added.length){await imageBlob(path(added[0].path));if(chosen!==channel||ticket!==session)return;strip=[];$('#browseCarousel').replaceChildren();}
   strip.push(...added);stripCursor=r.nextCursor||'';stripResume=stripResume&&!added.length&&!!stripCursor;paintStrip(added);paintCollections();saveSnapshot();warm();
   if(r.retryAfter)queueRetry('strip',r.retryAfter);
   if(!strip.length)$('#browseCarousel').innerHTML='<p class="muted">No accessible media here yet.</p>';
  }catch(e){if(ticket===session)handleReadError(e,'strip');}
  finally{if(chosen===channel&&ticket===session){stripBusy=false;if((strip.length<20||stripResume)&&stripCursor&&!retries.has('strip'))setTimeout(()=>loadStrip(),0);}}
 }
 // Durable local handoff plus the PC's account-wide desired-state outbox.
 let socialTimer,socialPumping=false,remoteSocial=[],remoteSocialAccount='',socialPaintKey='';const socialLocalCache=new Map();
 function socialKey(a=account){return scope()+':social:'+a;}
 function socialLocal(a=account){
  const key=socialKey(a);try{if(!socialLocalCache.has(key))socialLocalCache.set(key,window.Native?.loadSocialQueue?.(key)||localStorage.getItem(key)||'{}');return JSON.parse(socialLocalCache.get(key));}catch{return {};}
 }
 function saveSocial(rows,a=account){
  const key=socialKey(a),value=JSON.stringify(rows);let saved=false;
  if(socialLocalCache.get(key)===value)return;
  try{localStorage.setItem(key,value);saved=true;}catch{}
  if(window.Native?.saveSocialQueue){if(!Native.saveSocialQueue(key,value))throw Error('Could not save your change on this device.');saved=true;}
  if(!saved)throw Error('Device storage is full. Your change could not be saved.');socialLocalCache.set(key,value);
 }
 function socialChoiceKey(p){return p.kind==='follow'?'follow:'+p.creatorId:p.kind==='reaction'?'reaction:'+p.imageId+':'+p.reaction:'collect:'+p.imageId+':'+p.collectionId;}
 function socialRows(){
  const rows=new Map((remoteSocialAccount===account?remoteSocial:[]).filter(r=>r.state!=='synced').map(r=>[r.key,r]));
  for(const [key,value] of Object.entries(socialLocal()))rows.set(key,{...value.payload,key,error:value.error||''});
  return [...rows.values()];
 }
 function overlaySocial(item){
  const out={...item},reactions=[...(item.reactions||[])],members=[...(item.collections||[])],stats={...(item.stats||{})};
  for(const row of socialRows()){
   if(row.kind==='follow'&&String(row.creatorId)===String(item.creatorId))out.following=row.selected;
   if(String(row.imageId)!==String(item.id))continue;
   if(row.kind==='reaction'){
    const before=reactions.includes(row.reaction),idx=reactions.indexOf(row.reaction);if(idx>=0)reactions.splice(idx,1);if(row.selected)reactions.push(row.reaction);
    const key=row.reaction.toLowerCase()+'CountAllTime';stats[key]=Math.max(0,reactionCount({...item,stats},row.reaction)+Number(row.selected)-Number(before));out.reactions=reactions;out.stats=stats;
   }
   if(row.kind==='collect'){
    const idx=members.findIndex(c=>String(c.collectionId)===String(row.collectionId));if(idx>=0)members.splice(idx,1);if(row.selected)members.push({collectionId:row.collectionId});out.collections=members;
   }
  }
  return out;
 }
 function paintSocialQueue(){
  for(const item of allItems())Object.assign(item,overlaySocial(item));
  if(status?.account===account){const ids=new Set((status.followingIds||[]).map(String));for(const r of socialRows())if(r.kind==='follow')r.selected?ids.add(String(r.creatorId)):ids.delete(String(r.creatorId));status.followingIds=[...ids];status.follows=ids.size;}
  paintSocial();
  paintSyncIndicator();
 }
 let syncCount=0,syncAccount='',syncDoneTimer;
 function paintSyncIndicator(){
  const el=$('#browseSync'),rows=socialRows(),count=rows.length;
  if(syncAccount!==account){clearTimeout(syncDoneTimer);syncCount=0;syncAccount=account;el.hidden=true;el.classList.remove('synced');}
  if(count){
   clearTimeout(syncDoneTimer);el.hidden=false;el.classList.remove('synced');$('span',el).textContent=count;
   const retry=rows.some(r=>r.error||Date.now()/1000-r.firstAt>600);
   el.setAttribute('aria-label',count+' changes saved'+(retry?', waiting to retry sync':', awaiting sync'));el.title=el.getAttribute('aria-label');
  }else if(syncCount){
   el.hidden=false;el.classList.add('synced');$('span',el).textContent='✓';el.setAttribute('aria-label','Changes synced');el.title='Changes synced';
   clearTimeout(syncDoneTimer);syncDoneTimer=setTimeout(()=>{el.hidden=true;el.classList.remove('synced');},1400);
  }
  syncCount=count;
 }
 function socialSoon(delay=100){clearTimeout(socialTimer);socialTimer=setTimeout(pumpSocial,delay);}
 function queueSocial(data){
  const a=data.account||account;if(!a||a!==account)throw Error('Open Browse to confirm your account first.');
  const rows=socialLocal(a),key=socialChoiceKey(data),old=rows[key];
  const clientKey=scope()+':social-client';let client;
  try{client=JSON.parse(window.Native?.loadSocialQueue?.(clientKey)||localStorage.getItem(clientKey)||'null');}catch{}
  client=client||{id:crypto.randomUUID(),seq:0};client.seq++;
  const clientValue=JSON.stringify(client);let clientSaved=false;
  try{localStorage.setItem(clientKey,clientValue);clientSaved=true;}catch{}
  if(window.Native?.saveSocialQueue){clientSaved=Native.saveSocialQueue(clientKey,clientValue);}
  if(!clientSaved)throw Error('Could not save your change on this device.');
  const payload={...data,account:a,clientId:client.id,clientSeq:client.seq,requestId:crypto.randomUUID(),firstAt:old?.payload.firstAt||Date.now()/1000};
  rows[key]={payload};saveSocial(rows,a);socialSoon();
  const item=allItems().find(i=>String(i.id)===String(data.imageId))||{id:data.imageId};
  const result=overlaySocial(item);
  // Handlers paint immediately in this same microtask, without a bridge roundtrip.
  queueMicrotask(paintSocialQueue);
  return {ok:true,queued:true,selected:data.selected,reactions:result.reactions||[],collections:result.collections||[]};
 }
 async function pumpSocial(){
  if(socialPumping)return;
  if(!connected||document.hidden){socialSoon(5000);return;}
  socialPumping=true;
  try{
   const state=await api('browse/social');if(!state.account||!Array.isArray(state.items))return;
   const a=state.account,rows=socialLocal(a),remote=new Map(state.items.map(r=>[r.key,r]));
   for(const [key,entry] of Object.entries(rows))if(entry.ack){const r=remote.get(key);if(!r||(r.revision>=entry.ack&&(r.state==='synced'||r.requestId!==entry.payload.requestId)))delete rows[key];}
   saveSocial(rows,a);
   const sending=Object.values(rows).filter(r=>!r.ack&&Date.now()>=(r.retryAt||0)).slice(0,100);
   if(sending.length){
    const reply=await api('browse/social',{actions:sending.map(r=>r.payload)}),latest=socialLocal(a);
    for(const result of reply.results||[]){
     const entry=Object.values(latest).find(r=>r.payload.requestId===result.requestId);if(!entry)continue;
     if(result.error){entry.error=result.error;entry.retryAt=Date.now()+60000;}
     else if(result.superseded)delete latest[socialChoiceKey(entry.payload)];
     else{entry.ack=result.revision;entry.error='';}
    }
    saveSocial(latest,a);
   }
   if(account===a){remoteSocial=state.items;remoteSocialAccount=a;const key=JSON.stringify([a,state.items,socialLocal(a),state.items.some(r=>r.state!=='synced'&&Date.now()/1000-r.firstAt>600)]);if(key!==socialPaintKey){socialPaintKey=key;afterScroll('social-paint',()=>{paintSocialQueue();saveSnapshot();});}}
  }catch{/* Local choices survive disconnects and are retried when foreground again. */}
  finally{socialPumping=false;socialSoon(5000);}
 }
 async function action(data){
  const key=detailKey(data.imageId);if(data.imageId)socialRevisions.set(key,(socialRevisions.get(key)||0)+1);if(data.kind==='follow')followRevision++;if(data.kind==='preference')banRevision++;
  try{
   if(['reaction','collect','follow'].includes(data.kind)){const result=queueSocial({account,...data});if(data.imageId)details.delete(key);else details.clear();return result;}
   const result=await api('browse/action',{account,...data,requestId:crypto.randomUUID()});
   if(data.imageId)details.delete(key);else if(data.kind==='follow')details.clear();saveSnapshot();return result;
  }finally{if(data.imageId)socialRevisions.set(key,(socialRevisions.get(key)||0)+1);if(data.kind==='follow')followRevision++;if(data.kind==='preference')banRevision++;}
 }
 async function createCollection(parent,onCreated,boundAccount=account){
  const form=document.createElement('form');form.className='browseCollectionForm';form.innerHTML='<label>New private media collection<input name="name" maxlength="30" required placeholder="Collection name"></label><div class="row">'+button('Create','type="submit" class="green"')+button('Cancel','type="button"')+'</div><p role="status"></p>';
  (parent||$('.browseCollectionHeading')).after(form);form.querySelector('input').focus();form.querySelector('[type=button]').onclick=()=>form.remove();
  form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;
   try{const r=await action({account:boundAccount,kind:'create',name:form.querySelector('input').value});if(status?.account===boundAccount)status.collections=r.collections;form.remove();paintCollections();saveSnapshot();toast('Collection created');if(onCreated)await onCreated(r.collections);}
   catch(error){form.querySelector('p').textContent=error.message;}finally{b.disabled=false;}
  };
 }
 function resourcesHTML(resources,chosen={}){return '<ul class="modelPreviewResources civitaiResources">'+[...resources].sort((a,b)=>Number(/checkpoint/i.test(b.type))-Number(/checkpoint/i.test(a.type))).map(r=>{
  const isLora=/lora|locon|lycoris/i.test(r.type),url=r.modelId?'https://civitai.com/models/'+r.modelId+(r.versionId?'?modelVersionId='+r.versionId:''):'';
  return '<li><div class="civitaiResourceRow">'+(url?button(esc(r.name||r.type),'class="resourceName '+(chosen.kind==='lora'&&String(chosen.id)===String(r.versionId)?'chosenSource':'')+'" data-civi-link="'+esc(url)+'"'):'<strong class="resourceName">'+esc(r.name||r.type)+'</strong>')+
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
 function discoveryHTML(item){
  const source=item.chosenBy||{};
  if(source.kind==='lora'){
   const url=source.modelId?'https://civitai.red/models/'+source.modelId+'?modelVersionId='+source.id:'https://civitai.red/models?modelVersionId='+source.id;
   return '<div class="discoverySource">'+button('From '+esc(source.name||'LoRA preview'),'class="chosenSource sourceLora" data-civi-link="'+esc(url)+'" title="Discovered in this LoRA listing; this does not imply the image used it"')+'</div>';
  }
  if(source.kind!=='curation'||!source.via)return '';
  const via=source.via;
  return '<span class="discoveryVia" title="From public collection: '+esc(source.collectionName||'')+'"><span>via</span>'+button(esc(via.name),'class="viaCreator chosenSource" data-via-creator="'+esc(via.id)+'"')+'<span class="viaFollowing" aria-label="Following curator" '+(following({creatorId:via.id})?'':'hidden')+'>✓</span></span>';
 }
 function wireDiscovery(host,item){
  $$('[data-via-creator]',host).forEach(b=>b.onclick=()=>showCreatorFeed({creatorId:b.dataset.viaCreator,credit:item.chosenBy.via.name}));
  $$('[data-follow-creator]',host).forEach(b=>b.onclick=()=>changeFollow(b,b.dataset.followCreator));
  $$('.sourceLora',host).forEach(b=>b.onclick=()=>openModelSource(b.dataset.civiLink));
 }
 function socialHTML(item,collections){
  return '<div class="socialTop"><div class="civitaiAuthor">'+avatarHTML(item)+button(esc(item.credit||'Unknown creator'),'class="creatorName '+(item.chosenBy?.kind==='creator'&&String(item.chosenBy.id)===String(item.creatorId)?'chosenSource':'')+'" data-civi-link="https://civitai.red/user/'+esc(encodeURIComponent(item.credit||''))+'"')+(item.creatorId?button('Follow','class="viewerFollow" data-follow-only data-follow-creator="'+esc(item.creatorId)+'" '+(following(item)?'hidden':''))+button('Feed','data-creator-feed class="creatorFeed"'):'')+button('↗','data-creator-profile class="creatorProfile" aria-label="Open creator profile"')+(item.chosenBy?.kind==='curation'?discoveryHTML(item):'')+'</div><div class="civitaiReactions">'+button(reactionLabel(item),'data-civi-react="Like" aria-label="Like" aria-pressed="'+(item.reactions||[]).includes('Like')+'"')+button(ribbonIcon,'class="viewerCollect '+(membershipIds(item.collections).length?'bookmarked':'')+'" aria-label="Add to collection"')+'</div></div>'+(item.chosenBy?.kind==='lora'?discoveryHTML(item):'')+'<p class="civitaiActionError warning" role="status"></p>';
 }
 function membershipIds(raw){
  if(!raw)return [];
  const list=Array.isArray(raw)?raw:raw.items||raw.collections||[];
  return list.filter(c=>c.collectionId||c.inCollection||c.items?.length||c.collectionItems?.length).map(c=>String(c.collectionId||c.id));
 }
 function showCreatorFeed(item){
  close();if($('#modal')?.open)closeModal();
  if(page==='browse')openSubject(item.subjectKind||'creator',item.creatorId,item.credit);
  else {pendingCreator=item;navigate('browse');}
 }
 function openPendingCreator(){if(pendingCreator){const item=pendingCreator;pendingCreator=null;openSubject(item.subjectKind||'creator',item.creatorId,item.credit);}}
 function wireSocial(host,item,collections){
  wireDiscovery(host,item);wireAvatars(host);
  hydrate(host);$$('[data-civi-link]',host).forEach(b=>b.onclick=()=>openModelSource(b.dataset.civiLink));
  $('[data-creator-feed]',host)?.addEventListener('click',()=>showCreatorFeed(item));
  $('[data-creator-profile]',host)?.addEventListener('click',()=>profile(item.credit));
  const error=$('.civitaiActionError',host),boundAccount=account;
  async function run(b,payload,done){b.disabled=true;error.textContent='';try{const r=await action({...payload,account:boundAccount});if(host.isConnected)done(r);}catch(e){error.textContent=e.message;if(b.type==='checkbox')b.checked=!b.checked;}finally{b.disabled=false;}}
  $('[data-civi-follow]',host)?.addEventListener('click',e=>run(e.currentTarget,{kind:'follow',creatorId:item.creatorId,selected:!following(item)},r=>{updateFollowing(item.creatorId,r.selected);e.target.textContent=r.selected?'Following ✓':'Follow';e.target.classList.toggle('selected',r.selected);}));
  $$('[data-civi-react]',host).forEach(b=>b.onclick=()=>run(b,{kind:'reaction',imageId:item.id,reaction:b.dataset.civiReact,selected:!(item.reactions||[]).includes(b.dataset.civiReact)},r=>{applyReaction(item,r.reactions);$$('[data-civi-react]',host).forEach(x=>{const selected=r.reactions.includes(x.dataset.civiReact);x.innerHTML=reactionLabel(item,x.dataset.civiReact);x.classList.toggle('selected',selected);x.setAttribute('aria-pressed',String(selected));});}));
  $('.viewerCollect',host).onclick=()=>showCollections(item,boundAccount,collections);

 }
 function tagWeight(tag){return personalTagAccount===account&&personalTagsAt?Number(personalTags[String(tag.id)]||0):Number(tag.weight||0);}
 function acceptTagWeights(data){
  if(!data.tagWeights||!data.account)return;
  if(personalTagAccount!==data.account){personalTagAccount=data.account;personalTagsAt=0;personalTags={};lastTagAdjust.clear();}
  if(Number(data.tagWeightsAt||0)>=personalTagsAt){personalTags=data.tagWeights;personalTagsAt=Number(data.tagWeightsAt)||Date.now()/1000;}
  if(status){status.tagWeights=personalTags;status.tagWeightsAt=personalTagsAt;}
  for(const item of allItems())for(const tag of item.tags||[])tag.weight=tagWeight(tag);
  $$('.civitaiTagHost').forEach(host=>{if(host.tagItem)paintTags(host,host.tagItem);});
  saveSnapshot();
  try{const saved=JSON.parse(localStorage.getItem(scope())||'null');if(saved?.account===data.account){saved.status.tagWeights=personalTags;saved.status.tagWeightsAt=personalTagsAt;localStorage.setItem(scope(),JSON.stringify(saved));}}catch{}
 }
 function tagHTML(item,selected=new Set()){
  const chosen=item.chosenBy?.kind==='tags'?item.chosenBy.ids.map(String):[];
  return '<div class="civitaiTags">'+[...(item.tags||[])].sort((a,b)=>tagWeight(b)-tagWeight(a)||a.name.localeCompare(b.name)).map(t=>{
   const weight=tagWeight(t),id=String(t.id),banned=(status?.bans||[]).some(r=>r.kind==='tag'&&String(r.id)===id),busy=pendingTagWeights.has(account+':'+id);
   return '<div class="civitaiTag '+(chosen.includes(id)?'chosenSource':'')+(selected.has(id)?' selectedTag':'')+'" data-weight-tag="'+esc(id)+'">'+
    button(esc(t.name),'class="tagSearch" data-tag-search="'+esc(id)+'" aria-pressed="'+selected.has(id)+'" aria-label="Select tag '+esc(t.name)+'"')+'<small class="personalTagWeight" title="Your weight">'+weight+'</small>'+
    button(caretIcon(false),'class="'+(lastTagAdjust.get(id)===5?'selected':'')+'" data-vote="5" data-tag="'+esc(id)+'" aria-label="Add 5 weight to '+esc(t.name)+'" '+(busy||banned?'disabled':''))+
    button(caretIcon(true),'class="'+(lastTagAdjust.get(id)===-5?'selected':'')+'" data-vote="-5" data-tag="'+esc(id)+'" aria-label="Subtract 5 weight from '+esc(t.name)+'" '+(busy||banned||weight<=0?'disabled':''))+'</div>';
  }).join('')+'</div>';
 }
 function paintTags(host,item){
  if(host.tagItem?.id!==item.id)host.tagSelection=new Set();
  host.tagItem=item;host.tagSelection??=new Set();
  const ids=new Set((item.tags||[]).map(t=>String(t.id)));for(const id of host.tagSelection)if(!ids.has(id))host.tagSelection.delete(id);
  host.classList.toggle('hasTagSelection',host.tagSelection.size>0);
  host.innerHTML='<h2>Tags · your weights</h2>'+tagHTML(item,host.tagSelection)+(host.tagSelection.size?button('Search by tag','class="tagSearchSubmit" aria-label="Search by selected tags"'):'');
  wireTags(host,item);
 }
 function wireTags(host,item){
  const boundAccount=account;
  $$('[data-tag-search]',host).forEach(b=>b.onclick=()=>{const id=b.dataset.tagSearch;host.tagSelection.has(id)?host.tagSelection.delete(id):host.tagSelection.add(id);paintTags(host,item);});
  $('.tagSearchSubmit',host)?.addEventListener('click',()=>{
   const tags=item.tags.filter(t=>host.tagSelection.has(String(t.id))).sort((a,b)=>Number(a.id)-Number(b.id));
   if(tags.length)showCreatorFeed({subjectKind:'tags',creatorId:tags.map(t=>t.id).join(','),credit:tags.map(t=>t.name).join(' + ')});
  });
  $$('[data-vote]',host).forEach(b=>b.onclick=async()=>{
   const key=boundAccount+':'+b.dataset.tag,delta=Number(b.dataset.vote);if(pendingTagWeights.has(key))return;
   pendingTagWeights.add(key);paintTags(host,item);
   try{
    const result=await action({account:boundAccount,kind:'tag-weight',imageId:item.id,tagId:b.dataset.tag,delta});
    if(account!==boundAccount)return;
    acceptTagWeights({account:boundAccount,...result});lastTagAdjust.set(b.dataset.tag,delta);
   }catch(e){toast(e.message);}finally{pendingTagWeights.delete(key);if(account===boundAccount&&host.isConnected)paintTags(host,item);}
  });
 }
 async function enrich(host,image,fresh=false){
  if(!image.id)return;
  let target=$('.civitaiSocial',host);
  if(!target){target=document.createElement('div');target.className='civitaiSocial';$('.modelPreviewDetails',host)?.prepend(target);}
  target.innerHTML=socialHTML(image,status?.collections||[]);wireSocial(target,image,status?.collections||[]);
  function paintPrompt(state){
   const prompts=$('.civitaiPromptBlocks',host);if(!prompts)return;
   prompts.outerHTML=promptHTML(image,state);wirePromptCopies(host,image);
   $('.retryPromptDetails',host)?.addEventListener('click',()=>enrich(host,image,true));
  }
  if(fresh)paintPrompt('loading');
  try{
   const result=await fetchDetail(image,fresh);if(!target.isConnected)return;
   account=result.account;Object.assign(image,result.item);const item=image;
   paintPrompt(item.generationDataAvailable||item.detailVersion===2?'ready':'failed');
   target.innerHTML=socialHTML(item,result.collections);wireSocial(target,item,result.collections);
   const parameters=$('.modelPreviewParameters',host);if(parameters)parameters.innerHTML=Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('');
   const resourceHost=$('.civitaiResourceHost',host);if(resourceHost){resourceHost.innerHTML=resourcesHTML(item.resources,item.chosenBy);wireResources(resourceHost);}
   let tags=$('.civitaiTagHost',host);if(!tags){tags=document.createElement('section');tags.className='civitaiTagHost';$('.modelPreviewDetails',host)?.append(tags);}
   paintTags(tags,item);
  }catch(e){if(target.isConnected){paintPrompt('failed');$('.civitaiActionError',target).textContent=e.message;}}
 }
 function peek(host){host.addEventListener('scroll',()=>host.classList.toggle('pastPeek',host.scrollTop>20),{passive:true});}
 function viewerMotion(v){
  const el=v.el,scroll=$('.civitaiViewerScroll',el),hero=$('.modelPreviewHero',el);
  const media=$('img,video',hero),social=$('.civitaiSocial',el);
  let gap=0,gesture=null,frame=0,closed=false,peekHeight=110,touched=false,tapVisible=false,revealed=false;
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
  const reveal=()=>{if(!touched&&!revealed){revealed=true;align();scroll.scrollTop=peekHeight;align();}};
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
  let suppressVideoClick=0;
  hero.addEventListener('click',e=>{if(video&&Date.now()<suppressVideoClick){e.preventDefault();e.stopPropagation();}},{capture:true});
  hero.addEventListener('dragstart',e=>e.preventDefault());
  hero.addEventListener('pointerdown',e=>{
   if(!e.isPrimary){gesture=null;reset();return;}
   if(e.button!==0||e.target.closest('button'))return;
   const bounds=media.getBoundingClientRect();
   if(video&&e.clientX>=bounds.left&&e.clientX<=bounds.right&&e.clientY>=bounds.bottom-64&&e.clientY<=bounds.bottom)return;
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
   if(video&&g.mode)suppressVideoClick=Date.now()+500;
   if(g.mode==='toss')finishToss(g);
   else if(g.mode==='scroll')coast(g.vy);
   else {tapVisible=!tapVisible;align();}
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
  if(view.kind==='mix'&&list===feed)markSeen(item.id);
  const cached=details.get(detailKey(item.id));if(cached)Object.assign(item,cached.result.item);
  close();const el=document.createElement('section');el.className='civitaiViewer';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','Civitai media details');
  registerMedia([item]);const v={el,item,list};viewer=v;warm();document.body.append(el);document.body.classList.add('civitaiViewerOpen');
  el.innerHTML='<div class="civitaiViewerHead">'+button('×','class="civitaiClose" aria-label="Close media"')+'</div><div class="civitaiViewerScroll modelPreviewViewer"><div class="modelPreviewHero">'+imageHTML(item,true)+'<div class="modelPreviewNavigation">'+button('‹','data-prev aria-label="Previous media"')+button('›','data-next aria-label="Next media"')+'</div></div><div class="modelPreviewDetails"><div class="civitaiSocial">'+socialHTML(item,status?.collections||[])+'</div>'+promptHTML(item)+'<h2>Resources</h2><div class="civitaiResourceHost">'+resourcesHTML(item.resources||[],item.chosenBy)+'</div><dl class="modelPreviewParameters">'+Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('')+'</dl><div class="civitaiTagHost"></div>'+button('Open on Civitai ↗','data-origin')+'</div></div>';
  $('.civitaiClose',el).onclick=close;$('.civitaiClose',el).focus();$('[data-origin]',el).onclick=()=>openModelSource(item.imageUrl);
  wirePromptCopies(el,item);
  const position=list.findIndex(i=>i.id===item.id);$('[data-prev]',el).disabled=position<=0;$('[data-next]',el).disabled=position>=list.length-1;
  $('[data-prev]',el).onclick=()=>open(list[position-1],list);$('[data-next]',el).onclick=()=>open(list[position+1],list);
  const scroll=$('.civitaiViewerScroll',el);peek(scroll);hydrate($('.modelPreviewDetails',el));wireResources(el);v.dispose=viewerMotion(v);detail(v);
  if(item.type!=='video'&&item.fullPath){
   const img=$('.modelPreviewHero img',el);imageBlob(path(item.fullPath)).then(async url=>{if(!url)return;const full=new Image();full.src=url;await full.decode();if(viewer===v&&img.isConnected)img.src=url;}).catch(()=>{/* Keep the visible preview if the full image fails. */});
  }
  if(item.type==='video'&&item.fullPath&&!assetCache.has(path(item.fullPath))){
   imageBlob(path(item.fullPath),true).then(url=>{if(url&&viewer===v){const video=$('.modelPreviewHero video',el);if(video)video.src=url;}}).catch(()=>{});
  }
 }
 async function detail(v){if(viewer===v)await enrich(v.el,v.item);}
 document.addEventListener('click',e=>{
  if(!e.target.closest('#browseCollections,#browseSources'))closeMenus();
  $$('.weightMenu[open]').forEach(menu=>{if(!menu.contains(e.target))menu.open=false;});
 });
 document.addEventListener('click',e=>{if(Date.now()<suppressTap){e.preventDefault();e.stopImmediatePropagation();}},true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(viewer){e.preventDefault();close();}else if(page==='browse'&&back())e.preventDefault();}});
 document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('browseBackgrounded',document.hidden);if(document.hidden)cancelArrivalMotion();else scheduleScrollWork();if(document.hidden){for(const c of mediaControllers.values())c.abort();}if(page==='browse'&&!document.hidden){if(activityAge()>=7200000){render();return;}if(available()){refreshStatus(true).catch(()=>{});warm();}}});
 document.addEventListener('pointerdown',activity,{passive:true});document.addEventListener('keydown',activity,{passive:true});document.addEventListener('wheel',activity,{passive:true});document.addEventListener('touchmove',activity,{passive:true});
 return {render,suspend,connectionChanged,launchWarm,pauseMedia,open,close,back,canSwipeBack,beginSwipeBack,moveSwipeBack,endSwipeBack,isOpen:()=>!!viewer,enrich,peek,resourcesHTML,wireResources,promptHTML,wirePromptCopies};
})();
