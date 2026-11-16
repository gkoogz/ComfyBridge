'use strict';
// One account on the paired PC, shared across devices. No Civitai credentials here.
const CivitaiBrowser=(()=>{
 let account='',status=null,feed=[],strip=[],cursor='',stripCursor='',channel='',busy=false,stripBusy=false,session=0,timer,observer,viewer=null,lastStatus=0;
 const emoji={Like:'👍',Heart:'❤️',Laugh:'😂',Cry:'😢'};
 const path=p=>'/'+String(p||'').replace(/^\//,'');
 const button=(label,attrs='')=>'<button '+attrs+'>'+label+'</button>';
 const thumbURL=item=>item.cacheAsset&&item.cacheSample&&ModelPreviews.url(item.cacheAsset,item.cacheSample)||path(item.path);
 const imageHTML=(item,full=false)=>item.type==='video'&&full?'<video controls playsinline preload="none" poster="'+esc(thumbURL(item))+'" src="'+esc(path(item.fullPath))+'"></video>':'<img loading="lazy" decoding="async" src="'+esc(thumbURL(item))+'" alt="Civitai '+(item.type==='video'?'video preview':'image')+'">';
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
  el.classList.toggle('warning',!!s.error);
 }
 async function refreshStatus(force=false){
  if(!available()||(!force&&Date.now()-lastStatus<14000))return;lastStatus=Date.now();
  const s=await api('browse/status');if(!available())return;
  if(account&&account!==s.account){reset();close();$('#browseFeed')?.replaceChildren();$('#browseCarousel')?.replaceChildren();}
  account=s.account;status=s;$('#browseHello').textContent='Hello '+s.username;
  const select=$('#browseCollections');const old=select.value||channel;
  select.innerHTML=s.collections.map(c=>'<option value="collection:'+c.id+'">'+esc(c.name)+' · '+c.count+'</option>').join('')+'<option value="reactions">Reacted media</option>';
  channel=old&&[...select.options].some(o=>o.value===old)?old:s.collections.length?'collection:'+s.collections[0].id:'reactions';select.value=channel;
  $('#browseEmptyCollections').hidden=s.collections.length>0;paintStatus();
 }
 async function render(){
  const ticket=++session;clearTimeout(timer);observer?.disconnect();
  $('#main').innerHTML='<section class="civitaiBrowse"><div class="browseGreeting"><div><small>CIVITAI · YOUR DISCOVERY SPACE</small><h1 id="browseHello">Your inspiration, connected.</h1></div>'+button('↻','id="browseRefresh" aria-label="Refresh your feed"')+'</div><p id="browseError" class="warning" role="status"></p><div id="browseConnected" hidden><div class="browseCollectionHeading"><select id="browseCollections" aria-label="Choose a media collection"></select>'+button('＋','id="browseCreate" aria-label="Create a collection"')+'</div><p id="browseEmptyCollections" hidden>No media collections yet. Create one with ＋.</p><div id="browseCarousel" class="browseCarousel"></div><div class="browseFeedHeading"><h2>For you</h2><small id="browseImport" role="status"></small></div><div id="browseFeed" class="browseFeed"></div>'+button('Load more','id="browseMore"')+'</div></section>';
  $('#browseRefresh').onclick=()=>{reset();render();};
  if(!connected){$('#browseError').textContent='Connect to your PC using the sidebar to browse Civitai.';schedule();return;}
  try{
   await refreshStatus(true);if(ticket!==session)return;
   $('#browseConnected').hidden=false;
   $('#browseCreate').onclick=()=>createCollection();
   $('#browseCollections').onchange=()=>{channel=$('#browseCollections').value;strip=[];stripCursor='';$('#browseCarousel').replaceChildren();loadStrip();};
   $('#browseCarousel').onscroll=()=>{const el=$('#browseCarousel');if(el.scrollLeft+el.clientWidth>el.scrollWidth-350)loadStrip();};
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
  const el=document.createElement('article');el.className=small?'browseThumb':'browseTile';
  el.innerHTML='<button class="browseMedia" aria-label="Open '+esc(item.type)+' by '+esc(item.credit)+'">'+imageHTML(item)+(item.type==='video'?'<span class="browseVideo">▶ Video</span>':'')+'</button>'+(!small?'<div class="browseCaption"><strong>'+esc(item.credit||'Civitai creator')+'</strong><small>'+esc(item.reason||'')+'</small></div>':'');
  $('.browseMedia',el).onclick=()=>open(item,small?strip:feed);hydrate(el);return el;
 }
 function paintFeed(items){const el=$('#browseFeed');if(el)items.forEach(i=>el.append(tile(i)));}
 function paintStrip(items){const el=$('#browseCarousel');if(el)items.forEach(i=>el.append(tile(i,true)));}
 async function loadFeed(){
  if(busy||!available()||!$('#browseMore'))return;busy=true;const ticket=session;$('#browseMore').innerHTML='<i class="spinner"></i> Finding inspiration…';
  try{const r=await api('browse/feed?'+new URLSearchParams({channel:'mix',cursor}));if(ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   const added=r.items.filter(i=>!feed.some(x=>x.id===i.id));feed.push(...added);cursor=r.nextCursor||'';paintFeed(added);$('#browseError').textContent='';
   if(!added.length)$('#browseError').textContent='No new media in this page. Try Load more or refresh.';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{busy=false;if(ticket===session&&$('#browseMore'))$('#browseMore').textContent='Load more';}
 }
 async function loadStrip(){
  if(stripBusy||!available()||(strip.length&&!stripCursor))return;stripBusy=true;const chosen=channel,ticket=session;
  try{const r=await api('browse/feed?'+new URLSearchParams({channel:chosen,cursor:stripCursor}));if(chosen!==channel||ticket!==session)return;
   if(r.account!==account){reset();render();return;}
   const added=r.items.filter(i=>!strip.some(x=>x.id===i.id));strip.push(...added);stripCursor=r.nextCursor||'';paintStrip(added);
   if(!strip.length)$('#browseCarousel').innerHTML='<p class="muted">No accessible media here yet.</p>';
  }catch(e){if(ticket===session)$('#browseError').textContent=e.message;}
  finally{stripBusy=false;}
 }
 async function action(data){return api('browse/action',{account,...data,requestId:crypto.randomUUID()});}
 async function createCollection(parent){
  const form=document.createElement('form');form.className='browseCollectionForm';form.innerHTML='<label>New private media collection<input name="name" maxlength="30" required placeholder="Collection name"></label><div class="row">'+button('Create','type="submit" class="green"')+button('Cancel','type="button"')+'</div><p role="status"></p>';
  (parent||$('.browseCollectionHeading')).after(form);form.querySelector('input').focus();form.querySelector('[type=button]').onclick=()=>form.remove();
  form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;
   try{const r=await action({kind:'create',name:form.querySelector('input').value});status.collections=r.collections;form.remove();if(page==='browse')await refreshStatus(true);toast('Collection created');if(viewer)await detail(viewer);}
   catch(error){form.querySelector('p').textContent=error.message;}finally{b.disabled=false;}
  };
 }
 function resourcesHTML(resources){return '<ul class="modelPreviewResources civitaiResources">'+resources.map(r=>{
  const isLora=/lora|locon|lycoris/i.test(r.type),url=r.modelId?'https://civitai.com/models/'+r.modelId+(r.versionId?'?modelVersionId='+r.versionId:''):'';
  return '<li><div class="civitaiResourceRow">'+(isLora&&r.versionId?button('＋','class="resourceDownload" data-resource-download="'+esc(r.versionId)+'" data-civi-download="'+esc(r.versionId)+'" aria-label="Download LoRA"'):'')+(url?button(esc(r.name||r.type),'class="resourceName" data-civi-link="'+esc(url)+'"'):'<strong class="resourceName">'+esc(r.name||r.type)+'</strong>')+'<span class="resourceType">'+esc(r.type)+'</span></div>'+(r.version?'<small>'+esc(r.version)+'</small>':'')+((r.weight!==''&&r.weight!=null)?'<small>Strength '+esc(r.weight)+'</small>':'')+'<div data-download-status="'+esc(r.versionId)+'"></div></li>';
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
  const followed=item.following,bookmark=collections.find(c=>c.bookmark),bookmarked=bookmark&&membershipIds(item.collections).includes(String(bookmark.id));
  return '<div class="civitaiAuthor">'+(item.avatarPath?'<img src="'+esc(path(item.avatarPath))+'" alt="">':'<span class="avatarPlaceholder">'+esc((item.credit||'?')[0])+'</span>')+button(esc(item.credit||'Unknown creator'),'class="creatorName" data-civi-link="https://civitai.com/user/'+esc(encodeURIComponent(item.credit||''))+'"')+(item.creatorId?button(followed?'Following ✓':'Follow','data-civi-follow class="'+(followed?'selected':'')+'"'):'')+'</div><div class="civitaiReactions">'+Object.entries(emoji).map(([key,value])=>button(value+' <small>'+esc(item.stats[key.toLowerCase()+'CountAllTime']??item.stats[key.toLowerCase()+'Count']??'')+'</small>','data-civi-react="'+key+'" aria-label="'+key+'" aria-pressed="'+item.reactions.includes(key)+'" class="'+(item.reactions.includes(key)?'selected':'')+'"')).join('')+(bookmark?button(bookmarked?'Bookmarked ✓':'Bookmark','data-civi-bookmark="'+bookmark.id+'" class="'+(bookmarked?'selected':'')+'"'):'')+'</div><details class="civitaiCollect"><summary>Bookmark / add to collection</summary><div class="collectionChoices">'+collections.map(c=>'<label><input type="checkbox" data-civi-collect="'+c.id+'">'+esc(c.name)+'</label>').join('')+'</div>'+button('＋ New collection','data-civi-create')+'</details><p class="civitaiActionError warning" role="status"></p>';
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
  const memberships=membershipIds(item.collections);
  const bookmarkButton=$('[data-civi-bookmark]',host);if(bookmarkButton)bookmarkButton.onclick=()=>{const desired=!bookmarkButton.classList.contains('selected');run(bookmarkButton,{kind:'collect',imageId:item.id,collectionId:bookmarkButton.dataset.civiBookmark,selected:desired},()=>{bookmarkButton.classList.toggle('selected',desired);bookmarkButton.textContent=desired?'Bookmarked ✓':'Bookmark';const cb=$('[data-civi-collect="'+bookmarkButton.dataset.civiBookmark+'"]',host);if(cb)cb.checked=desired;});};
  $$('[data-civi-collect]',host).forEach(b=>{b.checked=memberships.includes(b.dataset.civiCollect);b.onchange=()=>run(b,{kind:'collect',imageId:item.id,collectionId:b.dataset.civiCollect,selected:b.checked},()=>{toast(b.checked?'Saved to collection':'Removed from collection');if(bookmarkButton?.dataset.civiBookmark===b.dataset.civiCollect){bookmarkButton.classList.toggle('selected',b.checked);bookmarkButton.textContent=b.checked?'Bookmarked ✓':'Bookmark';}});});
  $('[data-civi-create]',host).onclick=()=>createCollection($('.civitaiCollect',host));
 }
 function tagHTML(tags){return '<div class="civitaiTags">'+tags.map(t=>'<div class="civitaiTag"><span>'+esc(t.name)+'</span><small>'+esc(t.score??'')+'</small>'+button('↑','class="'+(t.vote===1?'selected':'')+'" data-vote="1" data-tag="'+t.id+'" aria-label="Upvote '+esc(t.name)+'"')+button('↓','class="'+(t.vote===-1?'selected':'')+'" data-vote="-1" data-tag="'+t.id+'" aria-label="Downvote '+esc(t.name)+'"')+'</div>').join('')+'</div>';}
 function wireTags(host,item){const boundAccount=account;$$('[data-vote]',host).forEach(b=>b.onclick=async()=>{b.disabled=true;try{const was=b.classList.contains('selected');await action({account:boundAccount,kind:'vote',imageId:item.id,tagId:b.dataset.tag,vote:b.classList.contains('selected')?0:Number(b.dataset.vote)});$$('[data-tag="'+b.dataset.tag+'"]',host).forEach(x=>x.classList.toggle('selected',x===b&&!was));}catch(e){toast(e.message);}finally{b.disabled=false;}});}
 async function enrich(host,image){
  if(!image.id)return;
  let target=$('.civitaiSocial',host);
  if(!target){target=document.createElement('div');target.className='civitaiSocial';$('.modelPreviewDetails',host)?.prepend(target);}
  target.textContent='Loading creator and interactions…';
  try{
   const result=await api('browse/detail/'+image.id);if(!target.isConnected)return;
   account=result.account;const item=result.item;target.innerHTML=socialHTML(item,result.collections);wireSocial(target,item,result.collections);
   const resourceHost=$('.civitaiResourceHost',host);if(resourceHost){resourceHost.innerHTML=resourcesHTML(item.resources);wireResources(resourceHost);}
   let tags=$('.civitaiTagHost',host);if(!tags){tags=document.createElement('section');tags.className='civitaiTagHost';$('.modelPreviewDetails',host)?.append(tags);}
   tags.innerHTML='<h2>Tags</h2>'+tagHTML(item.tags||[]);wireTags(tags,item);
  }catch(e){if(target.isConnected)target.textContent=e.message;}
 }
 function peek(host){host.addEventListener('scroll',()=>host.classList.toggle('pastPeek',host.scrollTop>20),{passive:true});}
 function close(){if(viewer){viewer.el.remove();viewer=null;}document.body.classList.remove('civitaiViewerOpen');}
 function open(item,list){
  close();const el=document.createElement('section');el.className='civitaiViewer';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','Civitai media details');
  const v={el,item,list};viewer=v;document.body.append(el);document.body.classList.add('civitaiViewerOpen');
  el.innerHTML='<div class="civitaiViewerHead"><strong>Civitai</strong>'+button('×','class="civitaiClose" aria-label="Close media"')+'</div><div class="civitaiViewerScroll modelPreviewViewer"><div class="modelPreviewHero">'+imageHTML(item,true)+'<div class="modelPreviewNavigation">'+button('‹','data-prev aria-label="Previous media"')+button('›','data-next aria-label="Next media"')+'</div></div><div class="modelPreviewPeek"><strong>Prompt & resources <span>⌄</span></strong><p>'+esc(item.prompt||'Scroll for details')+'</p></div><div class="modelPreviewDetails"><div class="civitaiSocial"></div><div class="row spread"><h2>Prompt</h2>'+button('Copy','data-copy')+'</div><p class="modelPreviewPrompt">'+esc(item.prompt||'The uploader did not share a prompt.')+'</p>'+(item.negativePrompt?'<h2>Negative prompt</h2><p class="modelPreviewPrompt">'+esc(item.negativePrompt)+'</p>':'')+'<h2>Resources</h2><div class="civitaiResourceHost">'+resourcesHTML(item.resources||[])+'</div><dl class="modelPreviewParameters">'+Object.entries(item.parameters||{}).map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('')+'</dl><div class="civitaiTagHost"></div>'+button('Open on Civitai ↗','data-origin')+'</div></div>';
  $('.civitaiClose',el).onclick=close;$('.civitaiClose',el).focus();$('[data-origin]',el).onclick=()=>openModelSource(item.imageUrl);
  $('[data-copy]',el).onclick=async()=>{try{if(window.Native?.copyText)await Native.copyText(item.prompt);else await navigator.clipboard.writeText(item.prompt);toast('Prompt copied');}catch{toast('Could not copy prompt');}};
  const position=list.findIndex(i=>i.id===item.id);$('[data-prev]',el).disabled=position<=0;$('[data-next]',el).disabled=position>=list.length-1;
  $('[data-prev]',el).onclick=()=>open(list[position-1],list);$('[data-next]',el).onclick=()=>open(list[position+1],list);
  const scroll=$('.civitaiViewerScroll',el);peek(scroll);hydrate(el);wireResources(el);detail(v);
  if(item.type!=='video'){const img=$('.modelPreviewHero img',el),full=new Image();full.onload=()=>{if(img.isConnected)img.src=full.src;};full.src=path(item.fullPath);}
 }
 async function detail(v){if(viewer===v)await enrich(v.el,v.item);}
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&viewer){e.preventDefault();close();}});
 document.addEventListener('visibilitychange',()=>{if(available())refreshStatus(true).catch(()=>{});});
 return {render,open,close,isOpen:()=>!!viewer,enrich,peek,resourcesHTML,wireResources};
})();
