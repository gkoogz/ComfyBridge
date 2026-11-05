'use strict';
const provenanceMemo=new Map();
function provenanceButton(text,action){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=async()=>{b.disabled=true;try{await action(b);}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
async function provenanceNode(job){
 let saved=provenanceMemo.get(job);
 if(!saved&&db)saved=await new Promise(resolve=>{const r=db.transaction('data').objectStore('data').get('provenance:'+job);r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});
 if(!connected){if(saved)return {...saved,offline:true};throw Error('Connect to the PC to load generation details.');}
 try{const node=await api('studio/provenance/'+job);provenanceMemo.set(job,node);if(db)db.transaction('data','readwrite').objectStore('data').put(node,'provenance:'+job);return node;}
 catch(e){if(saved)return {...saved,offline:true};throw e;}
}
function inputActions(item){
 const out=[];
 if(item.kind==='image'){
  out.push(provenanceButton('Send to i2i',async()=>{
   if(!state.settings.image)throw Error('Wait for image settings to load.');
   let original=library.find(x=>x.id===item.id)||item;if(!original.local)original=await fetchOriginal(item.id);
   const response=await fetch('/local/image/'+item.id+'/'+original.local);if(!response.ok)throw Error('The source image is unavailable.');
   const input=await readStartingImage(await response.blob());setStartingImage('image',input);state.settings.image.sourceMedia=item.id;persist('image');navigate('image');
  }));out.push(makeVideoButton(item));
 }else out.push(extendVideoButton(item));
 return out;
}
async function chainOutput(output){
 let item=library.find(j=>j.id===output.id);
 if(!item&&connected){await syncShelf(true);item=library.find(j=>j.id===output.id);}
 if(!item)throw Error('The original result is no longer available. Its settings and saved inputs can still be inspected.');
 openMedia(item);
}
function detailRows(node){
 const s=node.settings,rows=[['Generation',node.type],['Queued',new Date(node.created*1000).toLocaleString()],['Finished',node.finished?new Date(node.finished*1000).toLocaleString():'Unavailable'],['Time elapsed',node.elapsed==null?'Unavailable':(node.elapsedEstimated?'Approx. ':'')+clockText(node.elapsed)],['Status',node.status],['Model',s.model],['Seed',s.seed],['Resolution',s.width&&s.height?s.width+' × '+s.height:undefined]];
 for(const [key,label] of [['steps','Steps'],['cfg','CFG'],['denoise','Denoise'],['fps','FPS'],['frames',node.type==='Extend video'?'Frames added':'Frames']])if(s[key]!=null)rows.push([label,s[key]]);
 if(s.frames&&s.fps)rows.push([node.type==='Extend video'?'Seconds added':'Seconds generated',(s.frames/s.fps).toFixed(2)]);
 if(node.outputs[0]?.duration)rows.push(['Output duration',node.outputs[0].duration.toFixed(2)+' s']);
 if(s.sound!==undefined)rows.push(['Sound',s.sound?'On':'Off']);
 for(const [key,value] of Object.entries(node.components||{}))rows.push([key.replaceAll('_',' '),value.join(', ')]);
 return rows.filter(r=>r[1]!==undefined).map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>').join('');
}
function generationDetails(host,node){
 host.innerHTML='<div class="lineageHeading"><span class="lineageDot"></span><h3>'+esc(node.type)+'</h3></div><dl class="recipeFacts">'+detailRows(node)+'</dl><h4>Prompt</h4><p class="recipePrompt">'+esc(node.settings.positive||'(Empty prompt)')+'</p>'+(node.settings.negative?'<h4>Negative prompt</h4><p class="recipePrompt">'+esc(node.settings.negative)+'</p>':'')+
  (node.settings.loras?.length?'<h4>LoRAs</h4><ul>'+node.settings.loras.map(l=>'<li>'+esc(l.name)+' · '+esc(l.strength)+(l.enabled===false?' · disabled':'')+'</li>').join('')+'</ul>':'')+'<div class="recipeSources"></div><div class="recipeActions"></div><div class="recipeBranches"></div>';
 if(node.offline)host.prepend(Object.assign(document.createElement('p'),{className:'muted',textContent:'Saved details · reconnect to refresh branches.'}));
 for(const source of node.sources){
  const box=document.createElement('div');box.className='sourceCard';
  const b=provenanceButton(source.role==='mask'?'Input mask':source.kind==='video'?'Source video':'Source image',()=>inspectSource(node,source));
  const img=new Image();img.loading='lazy';img.alt='Saved '+source.role;img.src=source.thumbnail;b.prepend(img);box.append(b);
  if(source.media)box.append(provenanceButton('Open in Library ↗',()=>chainOutput(source.media)));
  if(source.branches?.length){
   const forks=document.createElement('details'),label=document.createElement('summary');label.textContent=source.branches.length+' other uses of this input';forks.append(label);
   for(const child of source.branches)forks.append(provenanceButton('↳ '+child.kind+' · '+new Date(child.created*1000).toLocaleDateString(),async()=>{
    if(child.outputs.length)await chainOutput(child.outputs[0]);else toast('This branch has no finished result yet.');
   }));box.append(forks);
  }
  $('.recipeSources',host).append(box);
 }
 const actions=$('.recipeActions',host);
 actions.append(provenanceButton('↗ Regenerate',b=>restoreGeneration(node.job,b,()=>host.isConnected)));
 for(const output of node.outputs){
  const item=library.find(j=>j.id===output.id)||{...output,source:'available'};
  actions.append(provenanceButton('View result',()=>chainOutput(output)),...inputActions(item));
 }
 const branchBox=$('.recipeBranches',host);
 if(node.branches.length){
  const details=document.createElement('details'),heading=document.createElement('summary'),list=document.createElement('div');list.className='branchList';heading.textContent=node.branches.length+' branch'+(node.branches.length===1?'':'es')+' from this step';details.append(heading,list);branchBox.append(details);
  for(const branch of node.branches)list.append(provenanceButton('↳ '+branch.kind+' · '+new Date(branch.created*1000).toLocaleString()+' · '+branch.status,async()=>{
   if(branch.outputs.length){await chainOutput(branch.outputs[0]);return;}
   const panel=document.createElement('article');panel.className='lineageNode';branchBox.append(panel);generationDetails(panel,await provenanceNode(branch.job));
  }));
 }
 if(!node.provenanceKnown){const note=document.createElement('p');note.className='muted';note.textContent='Older record: source links are shown only where they were recorded.';host.append(note);}
}
function initProvenance(view,item){
 const section=document.createElement('section');section.className='provenance';section.id='provenance';
 section.innerHTML='<button class="detailsHint">⌄ Generation details & origins</button><div class="lineage"></div>';
 $('.mediaHero',view).after(section);$('.detailsHint',section).onclick=()=>section.scrollIntoView({behavior:reduceMotion()?'auto':'smooth',block:'start'});
 const tree=$('.lineage',section),visited=new Set();
 const load=async(job,container,depth=0)=>{
  if(!job){container.textContent='This item has no saved generation record.';return;}
  if(visited.has(job)){container.textContent='↳ Shared origin shown above';return;}
  visited.add(job);container.textContent='Loading generation details…';
  try{
   const node=await provenanceNode(job);if(!section.isConnected)return;
   container.replaceChildren();const card=document.createElement('article');card.className='lineageNode';container.append(card);generationDetails(card,node);
   for(const [i,parent] of node.parents.entries()){
    const edge=document.createElement('div');edge.className='lineageEdge';edge.textContent='↑ '+parent.relation;container.append(edge);
    const next=document.createElement('div');next.className='lineageParent';container.append(next);
    if(i===0&&depth<7)await load(parent.job,next,depth+1);
    else{
     const button=provenanceButton('Show earlier origin',()=>load(parent.job,next,0));next.append(button);
     if(i===0){const watch=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){watch.disconnect();if(section.isConnected)button.click();}},{root:view,rootMargin:'150px'});watch.observe(button);observers.push(watch);}
    }
   }
   if(!node.parents.length){const root=document.createElement('p');root.className='lineageRoot';root.textContent=node.provenanceKnown?'● Starting point': '● Earliest recorded step';container.append(root);}
  }catch(e){container.replaceChildren(document.createTextNode(e.message+' '),provenanceButton('Retry',()=>{visited.delete(job);return load(job,container,depth);}));}
 };
 const observers=[];view.releaseProvenance=()=>observers.forEach(o=>o.disconnect());load(item.job,tree);
}
async function inspectSource(node,source){
 openModal(source.role==='mask'?'Saved input mask':'Original source','<div class="sourceInspection"><p>Loading original…</p></div>');
 const host=$('.sourceInspection'),session=epoch;
 try{
  const response=await fetch(source.url);if(!response.ok)throw Error('The saved source is unavailable. Connect to the PC or check whether the file was moved.');
  const blob=await response.blob();if(!host.isConnected||session!==epoch)return;
  const url=URL.createObjectURL(blob),media=document.createElement(source.kind==='video'?'video':'img');media.src=url;media.alt='Original generation input';
  if(source.kind==='video'){media.controls=true;media.playsInline=true;}
  $('#modal').addEventListener('close',()=>{if(media.pause)media.pause();URL.revokeObjectURL(url);},{once:true});
  const actions=document.createElement('div');actions.className='recipeActions';host.replaceChildren(media,actions);
  actions.append(provenanceButton(window.Desktop?'Save a copy':'Save to camera roll',async()=>{const saved=await local('exportSource',{job:node.job,role:source.role});toast(saved===false?'Save cancelled':'Source saved');}));
  actions.append(provenanceButton('↗ Regenerate',async b=>{await restoreGeneration(node.job,b,()=>host.isConnected);if(host.isConnected)closeModal();}));
  if(source.kind==='image'&&source.role!=='mask')for(const kind of ['image','video'])actions.append(provenanceButton(kind==='image'?'Send to i2i':'Make video',async()=>{
   if(!state.settings[kind])throw Error('Wait for the generator settings to load.');
   const input=await readStartingImage(blob);setStartingImage(kind,input);if(source.media)state.settings[kind].sourceMedia=source.media.id;
   state.settings[kind].sourceOrigin=source.origin||{job:node.job,role:source.role};
   persist(kind);closeModal();navigate(kind);
  }));
  if(source.kind==='video')actions.append(provenanceButton('Extend video',async()=>{
   const recipe=await api('studio/replay/'+node.job);closeModal();activateExtension(recipe.settings.extension);
   if(source.media)state.settings.video.sourceMedia=source.media.id;state.settings.video.sourceOrigin=source.origin||{job:node.job,role:source.role};persist('video');
  }));
 }catch(e){if(host.isConnected)host.textContent=e.message;}
}
