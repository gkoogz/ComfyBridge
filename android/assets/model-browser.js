'use strict';
let modelListings=[],modelBrowser=null,modelBrowserTimer;
const modelKey=name=>String(name).replaceAll('\\','/').toLowerCase();
function listing(kind,name){return (catalog?.listings||modelListings).find(x=>x.kind===kind&&modelKey(x.name)===modelKey(name));}
function modelLabel(kind,name){const item=listing(kind,name);return item?.title?item.title+(item.version?' · '+item.version:''):name;}
function modelSize(bytes){return bytes?bytes>=1e9?(bytes/1e9).toFixed(2)+' GB':(bytes/1e6).toFixed(1)+' MB':'Size unavailable';}
function activeLora(kind,name){return state.settings[kind].loras.some(l=>modelKey(l.name)===modelKey(name));}
function browserItems(view){
 const names=view.type==='checkpoints'?(catalog?.models||[]):view.type==='video'?(catalog?.videoModels||[]).map(x=>x.model):(catalog?.loras||[]);
 return [...new Set(names)].filter(n=>!view.only||n===view.only).map(name=>listing(view.type==='video'?'diffusion_models':view.type,name)||{name,title:name,kind:view.type,status:'pending',images:[]});
}
async function openModelBrowser(type,only=null){
 if(!connected)return toast('Connect to the PC to browse your models.');
 clearTimeout(modelBrowserTimer);
 try{await ModelPreviews.register(catalog?.listings||modelListings,catalog?.nsfwHidden,catalog?.scanning);}catch{}
 const view={type,only,kind:page,session:epoch,galleries:new Map()};
 view.title=type==='checkpoints'?'Checkpoint Browser':type==='video'?'Video model listing':only?'LoRA listing':'LoRA Browser';
 openModal(view.title,
  '<div class="modelBrowser"><input id="modelSearch" type="search" placeholder="Search title, author, filename or activation keyword…" aria-label="Search model listings"><p id="modelStatus" role="status">Loading the PC catalogue…</p><p id="modelNsfwNote" class="modelNsfwNote" hidden></p><div id="modelCards"></div></div>');
 modelBrowser=view;$('#modal').classList.add('modelBrowserDialog');$('#modalClose').textContent='×';
 view.cancel=e=>{e.preventDefault();if(view.preview)closeModelPreview(view);else closeModal();};$('#modal').addEventListener('cancel',view.cancel);
 $('#modelSearch').oninput=()=>paintModelBrowser(view);
 paintModelBrowser(view);
 async function refresh(){
  if(modelBrowser!==view||!$('#modelCards')||!$('#modal').open||epoch!==view.session)return;
  try{
   const result=await api('model-library');
   if(modelBrowser!==view||!$('#modelCards')||epoch!==view.session)return;
   modelListings=result.items||[];await ModelPreviews.register(modelListings,result.nsfwHidden,result.scanning);if(modelBrowser!==view)return;view.nsfwHidden=result.nsfwHidden!==false;if(catalog){catalog.listings=modelListings;catalog.nsfwHidden=result.nsfwHidden;catalog.scanning=result.scanning;}
   if(catalog)for(const [key,type] of [['models','checkpoints'],['loras','loras']])catalog[key]=[...new Set([...(catalog[key]||[]),...modelListings.filter(x=>x.kind===type).map(x=>x.name)])];
   $('#modelStatus').textContent=result.scanning?'Indexing new files and caching listing previews…':'Previews saved on this device · library downloads take priority';
   paintModelBrowser(view);
   if(result.scanning)modelBrowserTimer=setTimeout(refresh,4000);
  }catch(e){if($('#modelStatus'))$('#modelStatus').textContent='PC catalogue unavailable: '+e.message;}
 }
 await refresh();
}
function paintModelBrowser(view){
 const host=$('#modelCards');if(!host||modelBrowser!==view)return;
 const expanded=new Set($$('details[open]',host).map(x=>x.dataset.modelDetails));
 const query=($('#modelSearch')?.value||'').trim().toLowerCase();
 const items=browserItems(view).filter(x=>[x.title,x.name,x.author,x.version,...(x.keywords||[])].join(' ').toLowerCase().includes(query));
 const note=$('#modelNsfwNote');
 if(note){
  const rejected=(modelListings||[]).map(item=>item.previewWarning).find(Boolean);
  if(rejected){note.hidden=false;note.textContent=rejected;}
  else if(view.nsfwHidden!==false){note.hidden=false;note.textContent='NSFW previews are hidden. On the PC panel, use the gear next to Turn server off and add a Civitai API key. Turn mature content on for that account.';}
  else note.hidden=true;
 }
 host.innerHTML=items.map((item,index)=>{
  const isCheckpoint=view.type==='checkpoints',isVideo=view.type==='video';
  const selected=isCheckpoint?state.settings[view.kind].model===item.name:!isVideo&&activeLora(view.kind,item.name);
  const gallery=modelSampleGallery(view,item);
  const previewNote=item.previewWarning||(view.nsfwHidden!==false?'NSFW previews are hidden. Add a Civitai API key with the gear next to Turn server off on the PC panel.':'');
  const previewHtml='<div class="modelSampleHost" data-sample-gallery="'+esc(gallery.key)+'"></div>'+(previewNote?'<p class="modelNsfwNote">'+esc(previewNote)+'</p>':'');
  return '<article class="modelCard" data-model-index="'+index+'"><div class="modelCardHeading"><div><h2>'+esc(item.title||item.name)+'</h2><small>'+esc([item.version,item.author&&'by '+item.author].filter(Boolean).join(' · '))+'</small></div>'+
   (isCheckpoint?'<label class="modelUse"><input type="checkbox" data-model-use="'+index+'" '+(selected?'checked':'')+'>Use</label>':isVideo?'':'<button class="modelAdd" data-model-add="'+index+'" '+(selected?'disabled':'')+'>'+(selected?'✓ Active':'＋ Add')+'</button>')+'</div>'+
   previewHtml+
   '<div class="modelFacts"><span>'+esc(item.baseModel||'Base model unconfirmed')+'</span><span>'+modelSize(item.bytes)+'</span><span>'+esc(item.match||'Lookup pending')+'</span></div>'+
   ((item.keywords||[]).length?'<div class="modelKeywords"><small>Activation keywords</small><p>'+item.keywords.map(esc).join(' · ')+'</p><button data-model-keywords="'+index+'">Copy keywords</button></div>':'<small class="modelNoKeywords">No verified activation keywords supplied.</small>')+
   (item.description?'<p class="modelExcerpt">'+esc(item.description.slice(0,360))+'</p>':'')+
   '<details data-model-details="'+esc(item.name)+'" '+(expanded.has(item.name)?'open':'')+'><summary>Author description & file details</summary><div class="modelDescription">'+esc(item.description||item.note||'No confirmed online description is available for this file.')+'</div>'+
   (item.versionDescription?'<h3>Version notes</h3><div class="modelDescription">'+esc(item.versionDescription)+'</div>':'')+
   '<dl><dt>Local file</dt><dd>'+esc(item.name)+'</dd><dt>SHA-256</dt><dd>'+esc(item.sha256||'Waiting for first scan')+'</dd></dl>'+
   (item.fileMetadata?'<small>'+esc(Object.values(item.fileMetadata).join(' · '))+'</small>':'')+
   (item.merge?'<details><summary>Local merge recipe</summary><pre>'+esc(item.merge)+'</pre></details>':'')+'</details>'+
   (item.sourceUrl?'<button class="modelSource" data-model-source="'+index+'">Open '+esc(item.source||'original')+' listing ↗</button>':'<small>Source not confirmed · the local file is still selectable</small>')+'</article>';
 }).join('')||'<p class="muted">No matching models.</p>';
 $$('[data-model-use]',host).forEach(button=>button.onchange=()=>{
  const item=items[+button.dataset.modelUse],s=state.settings[view.kind];s.model=item.name;delete s.replayOf;persist(view.kind);
  const select=$('[data-setting="model"]');if(select&&page===view.kind){
   if(![...select.options].some(option=>option.value===item.name))select.add(new Option(modelLabel('checkpoints',item.name),item.name));
   for(const option of select.options)option.textContent=modelLabel('checkpoints',option.value);
   select.value=item.name;
  }
  paintModelBrowser(view);toast('Checkpoint selected');
 });
 $$('[data-model-add]',host).forEach(button=>button.onclick=()=>{
  const item=items[+button.dataset.modelAdd];if(activeLora(view.kind,item.name))return;
  state.settings[view.kind].loras.push({name:item.name,strength:1,enabled:true});persist(view.kind);
  if(page===view.kind)renderLoras();paintModelBrowser(view);toast('LoRA added');
 });
 $$('[data-model-keywords]',host).forEach(button=>button.onclick=async()=>{
  const text=items[+button.dataset.modelKeywords].keywords.join(', ');
  try{if(window.Native?.copyText)await Native.copyText(text);else await navigator.clipboard.writeText(text);toast('Keywords copied');}catch{toast('Could not copy keywords');}
 });
 $$('[data-model-source]',host).forEach(button=>button.onclick=()=>{
  openModelSource(items[+button.dataset.modelSource].sourceUrl);
 });
 wireModelSamples(view);
}

function stopModelBrowser(){
 clearTimeout(modelBrowserTimer);
 if(modelBrowser){modelBrowser.observer?.disconnect();$('#modal')?.removeEventListener('cancel',modelBrowser.cancel);}
 $('#modelPreviewViewer')?.remove();$('#modal')?.classList.remove('modelBrowserDialog','modelPreviewOpen');modelBrowser=null;ModelPreviews.wake();
}
function openModelSource(url){
 try{const u=new URL(url);if(u.protocol!=='https:'||!['civitai.com','civitai.red','huggingface.co'].includes(u.hostname)||u.username||u.password||u.port)return;}catch{return;}
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
function openModelPreview(view,gallery,index,origin){
 view.preview={gallery,index,origin};$('#modal').classList.add('modelPreviewOpen');$('#modalClose').onclick=()=>closeModelPreview(view);
 const viewer=document.createElement('section');viewer.id='modelPreviewViewer';viewer.className='modelPreviewViewer';viewer.setAttribute('aria-label','Listing preview and generation details');$('#modal').append(viewer);
 paintModelPreview(view);if(!gallery.items[index]?.id&&!gallery.started)loadModelSamples(view,gallery,true);viewer.scrollTop=0;$('#modalClose').focus({preventScroll:true});
}
function closeModelPreview(view){
 const origin=view.preview?.origin;view.preview=null;$('#modelPreviewViewer')?.remove();$('#modal').classList.remove('modelPreviewOpen');
 $('#modalTitle').textContent=view.title;$('#modalClose').onclick=closeModal;origin?.focus({preventScroll:true});
}
async function advanceModelPreview(view,delta){
 const preview=view.preview;if(!preview||preview.busy)return;
 preview.busy=true;
 try{
  let target=preview.index+delta;
  for(let attempt=0;target>=preview.gallery.items.length&&moreModelSamples(preview.gallery)&&attempt<3;attempt++){
   await loadModelSamples(view,preview.gallery);if(modelBrowser!==view||view.preview!==preview)return;
  }
  preview.index=Math.max(0,Math.min(target,preview.gallery.items.length-1));paintModelPreview(view);$('#modelPreviewViewer').scrollTop=0;
 }finally{preview.busy=false;}
}
function paintModelPreview(view){
 const preview=view.preview,host=$('#modelPreviewViewer');if(!preview||!host)return;
 const {gallery,index}=preview,image=gallery.items[index];if(!image)return;
 const scroll=host.scrollTop,description=image.prompt||'Generation details · prompt and LoRAs below';
 $('#modalTitle').textContent=gallery.item.title+' · '+(index+1)+'/'+gallery.items.length+(moreModelSamples(gallery)?'＋':'');
 const resources=image.resources||[],loras=resources.filter(x=>/lora|locon|lycoris/i.test(x.type));
 const resourceHtml=resource=>'<li><strong>'+esc(resource.name||resource.type+(resource.versionId?' · version '+resource.versionId:''))+'</strong>'+((resource.weight!==''&&resource.weight!=null)?' <span>Strength '+esc(resource.weight)+'</span>':'')+
  (resource.modelId?'<button data-resource-listing="https://'+(image.imageUrl?.startsWith('https://civitai.red/')?'civitai.red':'civitai.com')+'/models/'+esc(resource.modelId)+(resource.versionId?'?modelVersionId='+esc(resource.versionId):'')+'">Open resource listing ↗</button>':'')+'</li>';
 host.innerHTML='<div class="modelPreviewHero"><img class="modelPreviewImage" src="'+esc(ModelPreviews.url(gallery.item,image,true)||ModelPreviews.url(gallery.item,image))+'" alt="'+esc(gallery.item.title)+' preview '+(index+1)+'">'+
  (image.fullPath?'<span class="modelPreviewLoading"><i class="spinner"></i> Loading full preview…</span>':'')+
  '<div class="modelPreviewNavigation"><button data-sample-prev aria-label="Previous preview" '+(index===0?'disabled':'')+'>‹</button><button data-sample-next aria-label="Next preview" '+(index===gallery.items.length-1&&!moreModelSamples(gallery)?'disabled':'')+'>›</button></div></div>'+
  '<div class="modelPreviewPeek"><strong>Generation details <span>⌄</span></strong><p>'+esc(description)+'</p></div>'+
  '<div class="modelPreviewDetails"><p class="muted">'+esc([image.credit&&'By '+image.credit,image.width&&image.height&&image.width+' × '+image.height,image.created].filter(Boolean).join(' · '))+'</p>'+
  '<div class="row spread"><h2>Prompt</h2>'+(image.prompt?'<button data-copy-sample>Copy prompt</button>':'')+'</div><p class="modelPreviewPrompt">'+esc(image.prompt||'The uploader did not share a prompt for this image.')+'</p>'+
  (image.negativePrompt?'<h2>Negative prompt</h2><p class="modelPreviewPrompt">'+esc(image.negativePrompt)+'</p>':'')+
  '<h2>LoRAs used</h2>'+(loras.length?'<ul class="modelPreviewResources">'+loras.map(resourceHtml).join('')+'</ul>':'<p class="muted">No LoRA information was supplied for this image.</p>')+
  (resources.some(x=>!loras.includes(x))?'<h2>Other resources</h2><ul class="modelPreviewResources">'+resources.filter(x=>!loras.includes(x)).map(resourceHtml).join('')+'</ul>':'')+
  '<dl class="modelPreviewParameters">'+Object.entries(image.parameters||{}).map(([key,value])=>'<dt>'+esc(key)+'</dt><dd>'+esc(value)+'</dd>').join('')+'</dl>'+
  '<div class="modelPreviewLinks">'+(image.imageUrl?'<button data-image-source>Open image on Civitai ↗</button>':'')+(gallery.item.sourceUrl?'<button data-listing-source>Open '+esc(gallery.item.source||'original')+' listing ↗</button>':'')+'</div></div>';
 host.scrollTop=scroll;
 if(image.fullPath){
  const displayed=$('.modelPreviewImage',host),loading=$('.modelPreviewLoading',host);
  ModelPreviews.ensure(gallery.item,[image],true).then(()=>{
   if(displayed.isConnected){displayed.src=ModelPreviews.url(gallery.item,image,true)||displayed.src;loading?.remove();}
  }).catch(()=>{if(loading?.isConnected)loading.textContent='Full preview unavailable · showing device copy';});
 }
 $('[data-sample-prev]',host).onclick=()=>advanceModelPreview(view,-1);$('[data-sample-next]',host).onclick=()=>advanceModelPreview(view,1);
 $('[data-image-source]',host)?.addEventListener('click',()=>openModelSource(image.imageUrl));$('[data-listing-source]',host)?.addEventListener('click',()=>openModelSource(image.listingUrl||gallery.item.sourceUrl));
 $$('[data-resource-listing]',host).forEach(button=>button.onclick=()=>openModelSource(button.dataset.resourceListing));
 $('[data-copy-sample]',host)?.addEventListener('click',async()=>{try{if(window.Native?.copyText)await Native.copyText(image.prompt);else await navigator.clipboard.writeText(image.prompt);toast('Prompt copied');}catch{toast('Could not copy prompt');}});
 const hero=$('.modelPreviewHero',host);let start;
 hero.addEventListener('pointerdown',e=>{if(!e.target.closest('button'))start={x:e.clientX,y:e.clientY};});
 hero.addEventListener('pointerup',e=>{if(!start)return;const dx=e.clientX-start.x,dy=e.clientY-start.y;start=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.4)advanceModelPreview(view,dx<0?1:-1);});
 hero.addEventListener('pointercancel',()=>start=null);
 if(image.id&&image.resources?.some(x=>x.versionId&&(!x.name||!x.modelId))&&!gallery.details.has(image.id)){
  gallery.details.add(image.id);
  api('model-gallery-detail/'+encodeURIComponent(gallery.item.id)+'/'+encodeURIComponent(image.id)).then(result=>{
   if(modelBrowser!==view||!Array.isArray(result.resources))return;
   const current=gallery.items.find(x=>x.id===image.id);if(current)current.resources=result.resources;
   if(view.preview?.gallery===gallery&&gallery.items[view.preview.index]?.id===image.id)paintModelPreview(view);
  }).catch(()=>{});
 }
}
