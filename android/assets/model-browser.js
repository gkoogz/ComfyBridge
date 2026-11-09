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
 const view={type,only,kind:page,session:epoch};modelBrowser=view;
 openModal(type==='checkpoints'?'Checkpoint Browser':type==='video'?'Video model listing':only?'LoRA listing':'LoRA Browser',
  '<div class="modelBrowser"><input id="modelSearch" type="search" placeholder="Search title, author, filename or activation keyword…" aria-label="Search model listings"><p id="modelStatus" role="status">Loading the PC catalogue…</p><div id="modelCards"></div></div>');
 $('#modelSearch').oninput=()=>paintModelBrowser(view);
 paintModelBrowser(view);
 async function refresh(){
  if(modelBrowser!==view||!$('#modelCards')||!$('#modal').open||epoch!==view.session)return;
  try{
   const result=await api('model-library');
   if(modelBrowser!==view||!$('#modelCards')||epoch!==view.session)return;
   modelListings=result.items||[];if(catalog)catalog.listings=modelListings;
   if(catalog)for(const [key,type] of [['models','checkpoints'],['loras','loras']])catalog[key]=[...new Set([...(catalog[key]||[]),...modelListings.filter(x=>x.kind===type).map(x=>x.name)])];
   $('#modelStatus').textContent=result.scanning?'Indexing new files and caching listing previews…':'Listings cached on your PC · new files checked periodically';
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
 host.innerHTML=items.map((item,index)=>{
  const isCheckpoint=view.type==='checkpoints',isVideo=view.type==='video';
  const selected=isCheckpoint?state.settings[view.kind].model===item.name:!isVideo&&activeLora(view.kind,item.name);
  const images=(item.images||[]).map((image,i)=>'<img loading="lazy" src="/'+esc(image.path)+'" alt="Listing sample '+(i+1)+' for '+esc(item.title)+'" width="240" height="280">').join('');
  return '<article class="modelCard" data-model-index="'+index+'"><div class="modelCardHeading"><div><h2>'+esc(item.title||item.name)+'</h2><small>'+esc([item.version,item.author&&'by '+item.author].filter(Boolean).join(' · '))+'</small></div>'+
   (isCheckpoint?'<label class="modelUse"><input type="checkbox" data-model-use="'+index+'" '+(selected?'checked':'')+'>Use</label>':isVideo?'':'<button class="modelAdd" data-model-add="'+index+'" '+(selected?'disabled':'')+'>'+(selected?'✓ Active':'＋ Add')+'</button>')+'</div>'+
   (images?'<div class="modelSamples">'+images+'</div>':'<div class="modelNoSample">'+esc(item.previewNote||'No listing preview available yet')+'</div>')+
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
  const url=items[+button.dataset.modelSource].sourceUrl;
  if(window.Native?.openListing)Promise.resolve(Native.openListing(url)).catch(e=>toast(e.message));else window.open(url,'_blank','noopener,noreferrer');
 });
}
