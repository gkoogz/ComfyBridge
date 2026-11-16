'use strict';
// One account on the paired PC, shared across devices. No Civitai credentials here.
const CivitaiBrowser=(()=>{
 let account='',status=null,feed=[],strip=[],cursor='',stripCursor='',channel='',busy=false,stripBusy=false,session=0,timer,observer,viewer=null,lastStatus=0;
 let view={kind:'mix'}, history=[], feedEnded=false, collectionPopup=null;
 const emoji={Like:'👍',Heart:'❤️',Laugh:'😂',Cry:'😢'};
 const path=p=>'/'+String(p||'').replace(/^\//,'');
 const button=(label,attrs='')=>'<button '+attrs+'>'+label+'</button>';
 const thumbURL=item=>item.cacheAsset&&item.cacheSample&&ModelPreviews.url(item.cacheAsset,item.cacheSample)||path(item.path);
 const imageHTML=(item,full=false)=>item.type==='video'&&full?'<video controls playsinline preload="none" poster="'+esc(thumbURL(item))+'" src="'+esc(path(item.fullPath))+'"></video>':'<img loading="lazy" decoding="async" src="'+esc(thumbURL(item))+'" alt="Civitai '+(item.type==='video'?'video preview':'image')+'">';
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
 async function cachedImage(img){
  // Reuse bounded persistent previews on this device; account is part of each URL.
  const url=img.getAttribute('src');if(!url?.startsWith('/model-preview/browse/'))return;
  try{
   if(assetCache.has(url)){img.src=assetCache.get(url);return;}
   const cache=await caches.open('comfybridge-browse-v1');let r=await cache.match(url);
   if(!r){r=await fetch(url);if(!r.ok)return;const blob=await r.blob();if(blob.size>8*1024*1024)return;r=new Response(blob,{headers:{'Content-Type':blob.type,'X-Browse-Bytes':String(blob.size)}});await cache.put(url,r.clone());
    const keys=await cache.keys();let bytes=0;for(let i=keys.length-1;i>=0;i--){const hit=await cache.match(keys[i]);bytes+=Number(hit?.headers.get('X-Browse-Bytes')||0);if(keys.length-i>180||bytes>96*1024*1024)await cache.delete(keys[i]);}
   }
   const object=URL.createObjectURL(await r.blob());assetCache.set(url,object);if(img.isConnected)img.src=object;
   if(assetCache.size>200){const [key,value]=assetCache.entries().next().value;URL.revokeObjectURL(value);assetCache.delete(key);}
  }catch{/* Native WebViews may not expose CacheStorage; HTTP preview remains usable. */}
 }
 const imagesNear=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){imagesNear.unobserve(e.target);cachedImage(e.target);}}),{rootMargin:'250px'});
 function hydrate(root){root.querySelectorAll('img').forEach(img=>{img.addEventListener('error',()=>{img.classList.add('failed');img.alt='Preview unavailable · tap to retry';},{once:true});imagesNear.observe(img);});}
 function reset(){feed=[];strip=[];cursor='';stripCursor='';channel='';}
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
  if(account&&account!==s.account){reset();close();$('#browseFeed')?.replaceChildren();$('#browseCarousel')?.replaceChildren();}
  account=s.account;status=s;$('#browseHello').textContent='Hello '+s.username;
  const choices=s.collections.map(c=>({value:'collection:'+c.id,label:c.name+' · '+c.count}));
  choices.push({value:'reactions',label:'Reacted media'});
  if(!choices.some(c=>c.value===channel))channel=choices[0].value;
  $('#browseCollectionLabel').textContent=choices.find(c=>c.value===channel).label;
  const menu=$('#browseCollectionMenu');
  menu.innerHTML=choices.map(c=>button(esc(c.label),'type="button" role="menuitemradio" aria-checked="'+(c.value===channel)+'" data-channel="'+esc(c.value)+'"')).join('');
  $$('[data-channel]',menu).forEach(b=>b.onclick=()=>{
   channel=b.dataset.channel;
   $('#browseCollectionLabel').textContent=b.textContent;
   $('#browseCollections').open=false;
   strip=[];stripCursor='';$('#browseCarousel').replaceChildren();loadStrip();
  });
  $('#browseEmptyCollections').hidden=s.collections.length>0;paintStatus();
 }
 async function render(){
  view={kind:'mix'};history=[];feedEnded=false;busy=false;stripBusy=false;
  const ticket=++session;clearTimeout(timer);observer?.disconnect();
  $('#main').innerHTML='<section class="civitaiBrowse"><p id="browseError" class="warning" role="status"></p><div id="browseConnected" hidden><div class="browseCollectionHeading"><details id="browseCollections"><summary aria-label="Choose a media collection"><span id="browseCollectionLabel">Collections</span><span aria-hidden="true">⌄</span></summary><div id="browseCollectionMenu" role="menu"></div></details>'+button('＋','id="browseCreate" aria-label="Create a collection"')+button('↻','id="browseRefresh" aria-label="Refresh your feed"')+'</div><p id="browseEmptyCollections" hidden>No media collections yet. Create one with ＋.</p><div id="browseCarousel" class="browseCarousel"></div><div class="browseFeedHeading"><h2>For you</h2><button id="browseImport" aria-label="Edit feed preferences"></button></div><div id="browseFeed"></div>'+button('Load more','id="browseMore"')+'</div></section>';
  $('#browseFeed').className='browseFeed';

  $('#browseRefresh').onclick=()=>{reset();render();};
  if(!connected){$('#browseError').textContent='Connect to your PC using the sidebar to browse Civitai.';schedule();return;}
  try{
   await refreshStatus(true);if(ticket!==session)return;
   $('#browseConnected').hidden=false;
   $('#browseCreate').onclick=()=>createCollection();
   $('#browseCarousel').onscroll=()=>{const el=$('#browseCarousel');if(el.scrollLeft+el.clientWidth>el.scrollWidth-350)loadStrip();};
   $('#browseImport').onclick=openPreferences;
   $('#browseMore').onclick=()=>loadFeed();
   paintFeed(feed);paintStrip(strip);
   if(!strip.length)loadStrip();if(!feed.length)loadFeed();
   observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))loadFeed();},{rootMargin:'350px'});observer.observe($('#browseMore'));
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
  el.className=small?'browseThumb':'browseTile';
  el.innerHTML='<button class="browseMedia" aria-label="Open '+esc(item.type)+' by '+esc(item.credit)+'">'+imageHTML(item)+(item.type==='video'?'<span class="browseVideo">▶</span>':'')+'</button>';
  $('.browseMedia',el).onclick=()=>open(item,small?strip:feed);
  if(!small){
   const caption=document.createElement('div');
   caption.className='browseCaption';
   caption.innerHTML=button(esc(item.credit||'Creator'),'class="feedAuthor"')+
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
  $('#workspace').scrollTop=saved.scroll;
  if(view.kind!=='preferences')observeMore();
  return true;
 }
 function observeMore(){
  observer?.disconnect();
  if(!$('#browseMore')||feedEnded)return;
  observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))loadFeed();},{rootMargin:'350px'});
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
   const result=await api('browse/detail/'+item.id);
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
 async function loadFeed(){
  if(busy||feedEnded||!available()||!$('#browseMore'))return;busy=true;const ticket=session;$('#browseMore').innerHTML='<i class="spinner"></i> Finding inspiration…';
  try{const r=await api('browse/feed',{channel:view.kind==='mix'?'mix':view.kind+':'+view.id+':'+view.filter,cursor});if(ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   const added=r.items.filter(i=>!feed.some(x=>x.id===i.id));feed.push(...added);cursor=r.nextCursor||'';feedEnded=!r.nextCursor;paintFeed(added);$('#browseError').textContent='';
   if(!added.length)$('#browseError').textContent='No new media in this page. Try Load more or refresh.';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{if(ticket===session){busy=false;if($('#browseMore')){$('#browseMore').textContent='Load more';$('#browseMore').hidden=feedEnded;}}}
 }
 async function loadStrip(){
  if(stripBusy||!available()||(strip.length&&!stripCursor))return;stripBusy=true;const chosen=channel,ticket=session;
  try{const r=await api('browse/feed',{channel:chosen,cursor:stripCursor});if(chosen!==channel||ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   const added=r.items.filter(i=>!strip.some(x=>x.id===i.id));strip.push(...added);stripCursor=r.nextCursor||'';paintStrip(added);
   if(!strip.length)$('#browseCarousel').innerHTML='<p class="muted">No accessible media here yet.</p>';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{stripBusy=false;}
 }
 async function action(data){return api('browse/action',{account,...data,requestId:crypto.randomUUID()});}
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
   const result=await api('browse/detail/'+image.id);if(!target.isConnected)return;
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
  if(!e.target.closest('#browseCollections')){const menu=$('#browseCollections');if(menu)menu.open=false;}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(viewer){e.preventDefault();close();}else if(page==='browse'&&back())e.preventDefault();}});
 document.addEventListener('visibilitychange',()=>{if(available())refreshStatus(true).catch(()=>{});});
 return {render,open,close,back,isOpen:()=>!!viewer,enrich,peek,resourcesHTML,wireResources,promptHTML,wirePromptCopies};
})();
