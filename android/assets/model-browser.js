'use strict';
let modelListings=[],modelBrowser=null,modelBrowserTimer;
function appendModelKeywords(prompt,keywords){
 const text=String(prompt||'').replace(/[,\s]+$/u,''),words=(keywords||[]).map(word=>String(word).replace(/^[,\s]+|[,\s]+$/gu,'')).filter(Boolean).join(', ');
 return words?(text?text+', ':'')+words:text;
}
const modelKey=name=>String(name).replaceAll('\\','/').toLowerCase();
function listing(kind,name){return (catalog?.listings||modelListings).find(x=>x.kind===kind&&modelKey(x.name)===modelKey(name));}
function modelLabel(kind,name){const item=listing(kind,name);return item?.title?item.title+(item.version?' · '+item.version:''):name;}
function modelSize(bytes){return bytes?bytes>=1e9?(bytes/1e9).toFixed(2)+' GB':(bytes/1e6).toFixed(1)+' MB':'Size unavailable';}
function activeLora(kind,name){return state.settings[kind].loras.some(l=>modelKey(l.name)===modelKey(name));}
function embeddingCompatibility(item,kind){
 const family=text=>/sdxl|sd xl|pony|illustrious|noob|animagine/i.test(text)?'SDXL':/sd.?1[. _-]|stable.diffusion.v1/i.test(text)?'SD 1.x':/sd.?2[. _-]/i.test(text)?'SD 2.x':/flux/i.test(text)?'Flux':'';
 if(kind==='image'&&isKrea())return {blocked:true,label:'Textual inversion is not supported by the Krea 2 text encoder'};
 const base=item.baseModel||item.encoderFamily||'',a=family(base),checkpoint=listing('checkpoints',state.settings[kind]?.model),b=family(checkpoint?.baseModel||'');
 if(kind==='video')return {blocked:true,label:(base||'Textual inversion')+' · Not supported by the H3/Eros text encoder'};
 if(a&&b&&a!==b)return {blocked:true,label:base+' · Incompatible with the selected '+b+' checkpoint'};
 if(a&&b)return {blocked:false,label:base+' · Compatible encoder family; follow the author’s base-model guidance'};
 return {blocked:false,label:(base||'Compatibility unconfirmed')+' · '+(a?'Selected checkpoint family unconfirmed':'Check the author’s base model before use')};
}
function browserItems(view){
 if(view.type==='embeddings'){
  const local=(catalog?.listings||modelListings).filter(x=>x.kind==='embeddings');
  return (view.remote?view.remote.map(item=>local.find(x=>String(x.versionId)===String(item.versionId))||item):local).filter(item=>resourceAllowed(item,view.kind)&&!embeddingCompatibility(item,view.kind).blocked);
 }
 const names=view.type==='checkpoints'?(catalog?.models||[]):view.type==='video'?(catalog?.videoModels||[]).map(x=>x.model):(catalog?.loras||[]);
 return [...new Set(names)].filter(n=>!view.only||n===view.only).map(name=>listing(view.type==='video'||(view.type==='checkpoints'&&imageFamily(name)==='krea2')?'diffusion_models':view.type,name)||{name,title:view.type==='checkpoints'?imageModelLabel(name):name,kind:view.type,status:'pending',images:[]}).filter(item=>view.type!=='loras'||resourceAllowed(item,view.kind)).filter(item=>view.type!=='loras'||view.only||!!item.archived===!!view.archived);
}
async function openModelBrowser(type,only=null,promptKey=null){
 if(!connected)return toast('Connect to the PC to browse your models.');
 clearTimeout(modelBrowserTimer);
 try{await ModelPreviews.register(catalog?.listings||modelListings,catalog?.nsfwHidden,catalog?.scanning);}catch{}
 const view={type,only,promptKey,kind:page,session:epoch,archived:false,galleries:new Map()};
 view.title=type==='embeddings'?'Embedding Browser':type==='checkpoints'?'Checkpoint Browser':type==='video'?'Video model listing':only?'LoRA listing':'LoRA Browser';
 openModal(view.title,
  '<div class="modelBrowser">'+(type==='loras'&&!only?'<div class="modelBrowserTools"><button id="modelArchiveLink">Archive ›</button></div>':'')+'<input id="modelSearch" type="search" placeholder="Search title, author, filename or activation keyword…" aria-label="Search model listings"><p id="modelStatus" role="status">Loading the PC catalogue…</p><p id="modelNsfwNote" class="modelNsfwNote" hidden></p><div id="modelCards"></div></div>');
 modelBrowser=view;
 if(type==='embeddings'){
  const tools=document.createElement('div');tools.className='embeddingSearchTools';tools.innerHTML='<button id="embeddingLocal">Installed on PC</button><button id="embeddingFind">Search Civitai</button><button id="embeddingMore" hidden>More results</button>';$('#modelSearch').after(tools);
  $('#modelSearch').placeholder='Filter installed embeddings or search Civitai…';
  $('#embeddingLocal').onclick=()=>{view.remote=null;$('#modelSearch').value='';$('#embeddingMore').hidden=true;paintModelBrowser(view);};
  async function search(more=false){const query=$('#modelSearch').value.trim();if(!query)return toast('Enter a name to search Civitai.');const button=$('#embeddingFind');button.disabled=true;button.innerHTML='<i class="spinner"></i> Searching';
   try{const result=await api('embedding-search?q='+encodeURIComponent(query)+'&cursor='+encodeURIComponent(more?view.nextCursor:''));if(modelBrowser!==view)return;view.remote=more?[...view.remote,...result.items]:result.items;view.remoteQuery=query;view.nextCursor=result.nextCursor;$('#embeddingMore').hidden=!view.nextCursor;await ModelPreviews.register([...(catalog?.listings||modelListings),...view.remote],view.nsfwHidden,false);paintModelBrowser(view);}
   catch(e){toast(e.message);}finally{if(button.isConnected){button.disabled=false;button.textContent='Search Civitai';}}
  }
  $('#embeddingFind').onclick=()=>search();$('#embeddingMore').onclick=()=>search(true);$('#modelSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search();}};
 }
 $('#modal').classList.add('modelBrowserDialog');$('#modalClose').textContent='×';$('#modalClose').setAttribute('aria-label','Close');
 view.cancel=e=>{e.preventDefault();if(view.preview)closeModelPreview(view);else closeModal();};$('#modal').addEventListener('cancel',view.cancel);
 $('#modelSearch').oninput=()=>paintModelBrowser(view);
 $('#modelArchiveLink')?.addEventListener('click',()=>{view.archived=!view.archived;view.title=view.archived?'LoRA Archive':'LoRA Browser';$('#modalTitle').textContent=view.title;$('#modelArchiveLink').innerHTML=view.archived?backChevron+'LoRAs':'Archive ›';$('#modelSearch').value='';paintModelBrowser(view);$('#modalBody').scrollTop=0;});
 paintModelBrowser(view);
 async function refresh(){
  if(modelBrowser!==view||!$('#modelCards')||!$('#modal').open||epoch!==view.session)return;
  try{
   const result=await api('model-library');
   if(modelBrowser!==view||!$('#modelCards')||epoch!==view.session)return;
   const changed=!view.refreshed||JSON.stringify(modelListings)!==JSON.stringify(result.items||[])||view.nsfwHidden!==(result.nsfwHidden!==false)||view.scanning!==result.scanning;
   modelListings=result.items||[];if(changed)await ModelPreviews.register(modelListings,result.nsfwHidden,result.scanning);if(modelBrowser!==view)return;view.nsfwHidden=result.nsfwHidden!==false;view.scanning=result.scanning;view.refreshed=true;if(catalog){catalog.listings=modelListings;catalog.nsfwHidden=result.nsfwHidden;catalog.scanning=result.scanning;}
   if(catalog)for(const [key,type] of [['models','checkpoints'],['loras','loras']])catalog[key]=[...new Set([...(catalog[key]||[]),...modelListings.filter(x=>x.kind===type).map(x=>x.name)])];
   $('#modelStatus').textContent=result.scanning?'Indexing new files and caching listing previews…':'Previews saved on this device · library downloads take priority';
   if(changed)paintModelBrowser(view);
   modelBrowserTimer=setTimeout(refresh,result.scanning?4000:30000);
  }catch(e){if($('#modelStatus'))$('#modelStatus').textContent='PC catalogue unavailable: '+e.message;}
 }
 await refresh();
}
function paintModelBrowser(view){
 const host=$('#modelCards');if(!host||modelBrowser!==view)return;
 const expanded=new Set($$('details[open]',host).map(x=>x.dataset.modelDetails));
 const query=view.remote?'':($('#modelSearch')?.value||'').trim().toLowerCase();
 const items=browserItems(view).filter(x=>[x.title,x.name,x.author,x.version,...(x.keywords||[])].join(' ').toLowerCase().includes(query));
 const note=$('#modelNsfwNote');
 if(note){
  const rejected=(modelListings||[]).map(item=>item.previewWarning).find(Boolean);
  if(rejected){note.hidden=false;note.textContent=rejected;}
  else if(view.nsfwHidden!==false){note.hidden=false;note.textContent='NSFW previews are hidden. On the PC panel, use the gear next to Turn server off and add a Civitai API key. Turn mature content on for that account.';}
  else note.hidden=true;
 }
 host.innerHTML=items.map((item,index)=>{
  const isCheckpoint=view.type==='checkpoints',isVideo=view.type==='video',isEmbedding=view.type==='embeddings';
  const compatibility=isEmbedding?embeddingCompatibility(item,view.kind):null;
  const selected=isCheckpoint?state.settings[view.kind].model===item.name:!isVideo&&!isEmbedding&&activeLora(view.kind,item.name);
  const gallery=modelSampleGallery(view,item);
  const previewNote=item.previewWarning||(view.nsfwHidden!==false?'NSFW previews are hidden. Add a Civitai API key with the gear next to Turn server off on the PC panel.':'');
  const previewHtml='<div class="modelSampleHost" data-sample-gallery="'+esc(gallery.key)+'"></div>'+(previewNote?'<p class="modelNsfwNote">'+esc(previewNote)+'</p>':'');
  return '<article class="modelCard" data-model-index="'+index+'"><div class="modelCardHeading"><div><h2>'+esc(item.title||item.name)+'</h2><small>'+esc([item.version,item.author&&'by '+item.author].filter(Boolean).join(' · '))+'</small></div>'+
   (isCheckpoint?'<label class="modelUse"><input type="checkbox" data-model-use="'+index+'" '+(selected?'checked':'')+'>Use</label>':isVideo||isEmbedding?'':'<div class="modelCardActions"><button class="modelAdd" data-model-add="'+index+'" '+(selected?'disabled':'')+'>'+(selected?'✓ Active':'＋ Add')+'</button><button class="modelArchive" data-model-archive="'+index+'" '+(!item.id?'disabled':'')+'>'+(item.archived?'Unarchive':'Archive')+'</button></div>')+'</div>'+
   (isEmbedding?'<span class="embeddingCompatibility '+(compatibility.blocked?'incompatible':'')+'">'+esc(compatibility.label)+'</span>'+
     (item.kind==='embeddings'?'<div class="embeddingInsertActions"><button data-embedding-insert="'+index+'" data-target="positive" '+(compatibility.blocked?'disabled':'')+'>Insert positive</button><button data-embedding-insert="'+index+'" data-target="negative" '+(compatibility.blocked?'disabled':'')+'>Insert negative</button></div>':'<div class="embeddingDownload">'+CivitaiBrowser.resourcesHTML([{name:item.title,type:'Embedding',modelId:item.modelId,versionId:item.versionId,version:item.version}])+'</div>'):'')+
   previewHtml+
   '<div class="modelFacts"><span>'+esc(item.baseModel||'Base model unconfirmed')+'</span><span>'+modelSize(item.bytes)+'</span><span>'+esc(item.match||'Lookup pending')+'</span></div>'+
   (isEmbedding?'<small class="embeddingHotkey">Prompt token: <code>'+esc('embedding:'+item.name)+'</code></small>':(item.keywords||[]).length?'<div class="modelKeywords"><small>Activation keywords</small><p>'+item.keywords.map(esc).join(' · ')+'</p><button data-model-keywords="'+index+'">Copy keywords</button><button data-model-insert="'+index+'">Insert Keywords</button></div>':'<small class="modelNoKeywords">No verified activation keywords supplied.</small>')+
   (item.description?'<p class="modelExcerpt">'+esc(item.description.slice(0,360))+'</p>':'')+
   '<details data-model-details="'+esc(item.name)+'" '+(expanded.has(item.name)?'open':'')+'><summary>Author description & file details</summary><div class="modelDescription">'+esc(item.description||item.note||'No confirmed online description is available for this file.')+'</div>'+
   (item.versionDescription?'<h3>Version notes</h3><div class="modelDescription">'+esc(item.versionDescription)+'</div>':'')+
   '<dl><dt>Local file</dt><dd>'+esc(item.name)+'</dd><dt>SHA-256</dt><dd>'+esc(item.sha256||'Waiting for first scan')+'</dd></dl>'+
   (item.fileMetadata?'<small>'+esc(Object.values(item.fileMetadata).join(' · '))+'</small>':'')+
   (item.merge?'<details><summary>Local merge recipe</summary><pre>'+esc(item.merge)+'</pre></details>':'')+'</details>'+
   (item.sourceUrl?'<button class="modelSource" data-model-source="'+index+'">Open '+esc(item.source||'original')+' listing ↗</button>':'<small>Source not confirmed · the local file is still selectable</small>')+'</article>';
 }).join('')||'<p class="muted">No matching models.</p>';
 $$('[data-model-use]',host).forEach(button=>button.onchange=()=>{
  const item=items[+button.dataset.modelUse];if(view.kind==='image')selectImageModel(item.name);else{const s=state.settings[view.kind];s.model=item.name;delete s.replayOf;persist(view.kind);}
  const select=$('[data-setting="model"]');if(select&&page===view.kind){
   if(![...select.options].some(option=>option.value===item.name))select.add(new Option(imageModelLabel(item.name),item.name));
   for(const option of select.options)option.textContent=imageModelLabel(option.value);
   select.value=item.name;
  }
  paintModelBrowser(view);toast('Checkpoint selected');
 });
 $$('[data-model-add]',host).forEach(button=>button.onclick=()=>{
  const item=items[+button.dataset.modelAdd];if(activeLora(view.kind,item.name))return;
  state.settings[view.kind].loras.push({name:item.name,strength:1,enabled:true});persist(view.kind);
  if(page===view.kind)renderLoras();paintModelBrowser(view);toast('LoRA added');
 });
 $$('[data-model-archive]',host).forEach(button=>button.onclick=async()=>{const item=items[+button.dataset.modelArchive],archived=!item.archived;button.disabled=true;try{await api('model-library/archive',{id:item.id,archived});item.archived=archived;paintModelBrowser(view);}catch(error){toast(error.message);button.disabled=false;}});
 $$('[data-model-insert]',host).forEach(button=>button.onclick=()=>{const s=state.settings[view.kind],item=items[+button.dataset.modelInsert];s.positive=appendModelKeywords(s.positive,item.keywords);delete s.replayOf;persist(view.kind);const field=$('textarea.promptEntry[data-setting=positive]');if(page===view.kind&&field){field.value=s.positive;sizePrompt(field,promptExpanded.positive===true);}toast('Keywords inserted into the positive prompt');});
 $$('[data-model-keywords]',host).forEach(button=>button.onclick=async()=>{
  const text=items[+button.dataset.modelKeywords].keywords.join(', ');
  try{if(window.Native?.copyText)await Native.copyText(text);else await navigator.clipboard.writeText(text);toast('Keywords copied');}catch{toast('Could not copy keywords');}
 });
 $$('[data-model-source]',host).forEach(button=>button.onclick=()=>{
  openModelSource(items[+button.dataset.modelSource].sourceUrl);
 });
 $$('[data-embedding-insert]',host).forEach(button=>button.onclick=()=>{const item=items[+button.dataset.embeddingInsert];if(!embeddingCompatibility(item,view.kind).blocked)PromptEmbeddings.insert(view.kind,button.dataset.target,item);});
 if(view.type==='embeddings')CivitaiBrowser.wireResources(host);
 wireModelSamples(view);
}

function stopModelBrowser(){
 clearTimeout(modelBrowserTimer);clearTimeout(modelBrowser?.resourceTimer);
 if(modelBrowser){if(modelBrowser.preview)CivitaiBrowser.close(false);modelBrowser.observer?.disconnect();$('#modal')?.removeEventListener('cancel',modelBrowser.cancel);}
 $('#modelPreviewViewer')?.remove();$('#modal')?.classList.remove('modelBrowserDialog','modelPreviewOpen','modelPreviewBehind');modelBrowser=null;ModelPreviews.wake();
}
function openModelSource(url){
 try{const u=new URL(url);if(u.protocol!=='https:'||!['civitai.com','civitai.red','huggingface.co'].includes(u.hostname)||u.username||u.password||u.port)return;if(u.hostname==='civitai.com')u.hostname='civitai.red';url=u.href;}catch{return;}
 if(window.Native?.openListing)Promise.resolve(Native.openListing(url)).catch(e=>toast(e.message));else window.open(url,'_blank','noopener,noreferrer');
}
function modelSampleGallery(view,item){
 const key=item.id||item.kind+':'+item.name;
 if(!view.galleries.has(key))view.galleries.set(key,{key,item,items:ModelPreviews.samples(item),buffer:[],started:false,loading:false,next:'',seen:new Set(),details:new Set(),scroll:0,error:''});
 const gallery=view.galleries.get(key);gallery.item=item;return gallery;
}
function moreModelSamples(gallery){return gallery.buffer.length>0||gallery.next!==null;}
function modelSampleMarkup(gallery){
 return '<div class="modelSamples" aria-label="'+esc(gallery.item.title)+' preview carousel">'+gallery.items.map((image,index)=>
  '<button class="modelSample" data-sample="'+index+'" aria-label="Open preview '+(index+1)+'" style="aspect-ratio:'+((image.width>0&&image.height>0)?image.width+'/'+image.height:'4/5')+'">'+
  '<img loading="lazy" draggable="false" src="'+esc(ModelPreviews.url(gallery.item,image))+'" alt="Listing sample '+(index+1)+' for '+esc(gallery.item.title)+'"'+(image.width&&image.height?' width="'+image.width+'" height="'+image.height+'"':'')+'></button>').join('')+
  ((moreModelSamples(gallery)&&gallery.item.id&&gallery.item.source==='Civitai')?'<button class="modelSampleMore" data-sample-more '+(gallery.loading?'disabled':'')+'>'+(gallery.loading?'<i class="spinner"></i>':'＋')+'<span>'+(gallery.error?'Retry previews':'More previews')+'</span></button>':'')+'</div>'+
  '<div class="modelSampleCaption"><span>'+(gallery.items.length?gallery.items.length+' previews · swipe to browse · tap to open':esc(gallery.item.previewNote||'Preparing previews on this device…'))+'</span><small role="status">'+esc(gallery.error||ModelPreviews.store?.error||(!ModelPreviews.store?.complete()?'Preparing the first previews for your other models…':gallery.started&&!moreModelSamples(gallery)?'End of available previews':''))+'</small></div>';
}
function paintModelSamples(view,gallery){
 const host=$$('[data-sample-gallery]').find(x=>x.dataset.sampleGallery===gallery.key);if(!host)return;
 host.innerHTML=modelSampleMarkup(gallery);
 const strip=$('.modelSamples',host);strip.scrollLeft=gallery.scroll;
 // Restoring scroll position must not be mistaken for a request for more images.
 let restored=false;requestAnimationFrame(()=>{restored=true;});
 strip.addEventListener('scroll',()=>{
  gallery.scroll=strip.scrollLeft;
  if(restored&&strip.scrollLeft>0&&strip.scrollWidth-strip.clientWidth-strip.scrollLeft<120&&!gallery.loading&&!gallery.error)loadModelSamples(view,gallery);
 },{passive:true});
 $$('[data-sample]',host).forEach(button=>button.onclick=()=>openModelPreview(view,gallery,+button.dataset.sample,button));
 $('[data-sample-more]',host)?.addEventListener('click',()=>loadModelSamples(view,gallery));
}
function modelPreviewCacheChanged(){
 const view=modelBrowser;if(!view||!$('#modal').open)return;
 for(const gallery of view.galleries.values()){
  const local=ModelPreviews.samples(gallery.item);
  for(const sample of local)if(!gallery.items.some(x=>(x.source||x.id||x.path)===(sample.source||sample.id||sample.path)))gallery.items.push(sample);
  gallery.items=gallery.items.filter(sample=>ModelPreviews.url(gallery.item,sample));
  paintModelSamples(view,gallery);
 }
}
function wireModelSamples(view){
 view.observer?.disconnect();
 view.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){
  const gallery=view.galleries.get(entry.target.dataset.sampleGallery);
  // The catalogue's first three are warmed globally, never expanded just by visibility.
  if(!gallery.items.length&&!gallery.item.images?.length&&!gallery.started)loadModelSamples(view,gallery);
 }},{root:$('#modalBody'),rootMargin:'100px'});
 for(const gallery of view.galleries.values())paintModelSamples(view,gallery);
 $$('[data-sample-gallery]').forEach(host=>view.observer.observe(host));
}
async function fetchModelSamplePage(view,gallery){
 const cursor=gallery.next;if(cursor===null)return;
 const result=await ModelPreviews.page(gallery.item,cursor);
 if(modelBrowser!==view||view.session!==epoch)return;
 gallery.started=true;gallery.seen.add(cursor);
 for(const sample of result.items||[]){
  const index=gallery.items.findIndex(old=>old.source&&old.source===sample.source||old.id&&old.id===sample.id);
  if(index>=0)gallery.items[index]={...gallery.items[index],...sample};
  else if(!gallery.buffer.some(old=>old.source&&old.source===sample.source||old.id&&old.id===sample.id))gallery.buffer.push(sample);
 }
 gallery.next=result.nextCursor&&!gallery.seen.has(result.nextCursor)?result.nextCursor:null;gallery.error=result.note||'';
}
async function loadModelSamples(view,gallery,metadataOnly=false){
 if(modelBrowser!==view||view.session!==epoch||gallery.loading||!moreModelSamples(gallery))return;
 if(!gallery.item.id||gallery.item.source!=='Civitai'){gallery.started=true;gallery.next=null;paintModelSamples(view,gallery);return;}
 gallery.loading=true;gallery.error='';paintModelSamples(view,gallery);
 try{
  for(let hops=0;!gallery.buffer.length&&gallery.next!==null&&hops<4;hops++){
   await fetchModelSamplePage(view,gallery);if(modelBrowser!==view||view.session!==epoch)return;
   if(gallery.error)break;
  }
  if(!metadataOnly){
   const incoming=gallery.buffer.slice(0,3);
   await ModelPreviews.ensure(gallery.item,incoming);
   if(modelBrowser!==view||view.session!==epoch)return;
   gallery.buffer.splice(0,incoming.length);
   for(const sample of incoming)if(!gallery.items.some(old=>old.source&&old.source===sample.source||old.id&&old.id===sample.id))gallery.items.push(sample);
  }
 }catch(error){gallery.error=/HTTP 404/.test(error.message)?'Update the Windows companion to browse more previews.':error.message;}
 finally{
  gallery.loading=false;
  if(modelBrowser===view){paintModelSamples(view,gallery);if(view.preview?.gallery===gallery)paintModelPreview(view);}
 }
}
function sharedModelSample(gallery,image,index){
 return {...image,id:image.id||'listing-'+gallery.key+'-'+index,type:image.type||'image',cacheAsset:gallery.item,cacheSample:image,
  fullPath:image.fullPath||(/^model-preview\/[a-f0-9]{32}\/[012](?:\?|$)/.test(image.path||'')?image.path.split('?')[0]+'/full':undefined),
  imageUrl:image.imageUrl||(image.id?'https://civitai.red/images/'+image.id:gallery.item.sourceUrl),resources:image.resources||[],parameters:image.parameters||{},reactions:[],collections:[]};
}
function openModelPreview(view,gallery,index,origin){
 const list=gallery.items.map((image,n)=>sharedModelSample(gallery,image,n));
 view.preview={gallery,index,origin};
 // Leave the real listing behind the viewer, outside the native top layer.
 // Both a toss and a metadata swipe reveal its exact retained scroll position.
 $('#modal').close();$('#modal').setAttribute('open','');$('#modal').classList.add('modelPreviewBehind');
 const options={
  previousScreen:()=>$('#modal'),
  onClose:()=>{if(modelBrowser!==view)return;view.preview=null;$('#modal').removeAttribute('open');$('#modal').classList.remove('modelPreviewBehind');$('#modal').showModal();origin?.focus({preventScroll:true});ModelPreviews.wake();},
  more:()=>moreModelSamples(gallery),
  loadMore:async target=>{await loadModelSamples(view,gallery);for(let n=target.length;n<gallery.items.length;n++)target.push(sharedModelSample(gallery,gallery.items[n],n));},
  prepare:async item=>{
   if(!/^[1-9][0-9]*$/.test(String(item.id))&&!gallery.started)await loadModelSamples(view,gallery,true);
   const sample=[...gallery.items,...gallery.buffer].find(x=>x.source===item.source&&x.id);
   if(sample)Object.assign(item,sample);
  }
 };
 CivitaiBrowser.open(list[index],list,null,options);
}
function closeModelPreview(view){if(modelBrowser===view&&view.preview)CivitaiBrowser.close();}
function paintModelPreview(view){/* Shared Browse viewer updates its own metadata in place. */}
