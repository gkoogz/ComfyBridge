'use strict';
// Persistent device storage, separate from generated media and its retention rules.
// Images are committed before their manifest. Refresh never evicts a live gallery.
class ListingPreviewCache {
 constructor(options={}){
  this.options=options;this.now=options.now||Date.now;this.random=options.random||Math.random;
  this.records=new Map();this.urls=new Map();this.manifest=new Set();this.requests=new Map();
  this.allowMature=true;this.inventoryComplete=true;this.timer=null;this.running=false;this.controller=null;this.closed=false;this.error='';
  this.ready=this.open(options.database||'comfybridge-listing-previews').then(async()=>{
   const all=await this.read('listings');
   for(const record of all)if(record.scope===options.scope){this.records.set(record.key,record);await this.hydrate(record);}
  }).catch(error=>{this.error='Device preview storage unavailable: '+error.message;throw error;});
 }
 key(item){return (this.options.scope||'local')+'|'+item.kind+':'+item.name;}
 imageKey(sample){return sample.source||sample.id||sample.path;}
 visible(sample){return this.allowMature||!sample.mature;}
 open(name){return new Promise((resolve,reject)=>{
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>{request.result.createObjectStore('listings',{keyPath:'key'});request.result.createObjectStore('images');};
  request.onsuccess=()=>{this.db=request.result;resolve();};request.onerror=()=>reject(request.error);
 });}
 read(store,key){return new Promise((resolve,reject)=>{
  const request=this.db.transaction(store).objectStore(store)[key===undefined?'getAll':'get'](key);
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });}
 write(store,value,key){return new Promise((resolve,reject)=>{
  const tx=this.db.transaction(store,'readwrite'),object=tx.objectStore(store);
  key===undefined?object.put(value):object.put(value,key);
  tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||Error('Preview could not be saved.'));
 });}
 async save(record){await this.write('listings',record);}
 entry(record,sample){const key=typeof sample==='string'?sample:this.imageKey(sample);return record.entries.find(entry=>entry.key===key);}
 async hydrate(record,keys=record.active){
  for(const key of keys){const entry=this.entry(record,key);if(!entry?.thumb||this.urls.has(entry.thumb))continue;
   const blob=await this.read('images',entry.thumb);
   if(blob)this.urls.set(entry.thumb,URL.createObjectURL(blob));else delete entry.thumb;
  }
 }
 async register(items,allowMature=this.allowMature,inventoryComplete=true){
  await this.ready;this.pause();this.allowMature=allowMature;this.inventoryComplete=inventoryComplete;this.manifest=new Set();
  for(const item of items){
   if(!['checkpoints','loras','diffusion_models'].includes(item.kind))continue;
   const key=this.key(item);this.manifest.add(key);
   let record=this.records.get(key);
   if(!record){record={key,scope:this.options.scope,item,active:[],desired:[],entries:[],pages:[],installedAt:0,
    refreshAfter:30*86400000+Math.floor(this.random()*90*86400000)};this.records.set(key,record);}
   record.item=item;record.desired=(item.images||[]).filter(s=>s.path&&this.visible(s)).slice(0,3);
   for(const sample of record.desired)this.remember(record,sample);
  }
  // Publish the complete inventory before any asynchronous work can run the queue.
  for(const key of this.manifest){const record=this.records.get(key);await this.save(record);await this.install(record);}
  this.changed();this.wake();
 }
 remember(record,sample){
  let entry=this.entry(record,sample);
  if(!entry){entry={key:this.imageKey(sample),sample:{...sample}};record.entries.push(entry);}
  else entry.sample={...entry.sample,...sample};
  return entry;
 }
 wanted(record){
  const changed=record.active.join('\n')!==record.desired.map(s=>this.imageKey(s)).join('\n');
  return !record.installedAt||changed&&this.now()-record.installedAt>=record.refreshAfter
   ?record.desired:record.active.map(key=>this.entry(record,key)?.sample).filter(Boolean);
 }
 async install(record){
  const desired=record.desired.filter(s=>this.visible(s));
  if(!desired.length)return;
  await this.hydrate(record,desired.map(sample=>this.imageKey(sample)));
  const complete=desired.every(sample=>this.entry(record,sample)?.thumb);
  if(!record.installedAt){
   record.active=desired.filter(sample=>this.entry(record,sample)?.thumb).map(s=>this.imageKey(s));
   if(complete)record.installedAt=this.now();await this.save(record);return;
  }
  if(record.active.join('\n')===desired.map(s=>this.imageKey(s)).join('\n')||!complete||
   this.now()-record.installedAt<record.refreshAfter||this.options.isViewing?.(record.item))return;
  const keep=new Set(desired.map(s=>this.imageKey(s))),old=record.entries.filter(entry=>!keep.has(entry.key));
  // One transaction swaps the whole set and removes retired blobs, after all replacements exist.
  const previous={active:record.active,entries:record.entries,pages:record.pages,installedAt:record.installedAt,refreshAfter:record.refreshAfter};
  record.active=[...keep];record.entries=record.entries.filter(entry=>keep.has(entry.key));record.pages=[];
  record.installedAt=this.now();record.refreshAfter=30*86400000+Math.floor(this.random()*90*86400000);
  try{await new Promise((resolve,reject)=>{
   const tx=this.db.transaction(['listings','images'],'readwrite');tx.objectStore('listings').put(record);
   for(const entry of old)for(const key of [entry.thumb,entry.full])if(key)tx.objectStore('images').delete(key);
   tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
  });}catch(error){Object.assign(record,previous);throw error;}
  for(const [id,request] of this.requests)if(request.record===record&&!keep.has(request.entry.key)){
   this.requests.delete(id);for(const waiter of request.waiters)waiter.reject(Error('Listing previews were refreshed.'));
  }
  for(const entry of old)for(const key of [entry.thumb,entry.full])if(this.urls.has(key)){URL.revokeObjectURL(this.urls.get(key));this.urls.delete(key);}
  this.changed();
 }
 samples(item){const record=this.records.get(this.key(item));return record?record.active.map(key=>this.entry(record,key)?.sample).filter(s=>s&&this.visible(s)):[];}
 url(item,sample,full=false){const entry=this.entry(this.records.get(this.key(item))||{entries:[]},sample);return this.visible(sample)?this.urls.get(entry?.[full?'full':'thumb'])||'':'';}
 complete(){
  return this.inventoryComplete&&[...this.manifest].every(key=>{const record=this.records.get(key);return this.wanted(record).every(s=>this.entry(record,s)?.thumb);});
 }
 async page(item,cursor,loader){
  await this.ready;const record=this.records.get(this.key(item));if(!record)throw Error('Listing catalogue is still loading.');
  const cached=record.pages.find(p=>p.cursor===cursor);
  if(cached)return {...cached.result,items:cached.result.items.filter(s=>this.visible(s))};
  const result=await loader();
  record.pages.push({cursor,result});for(const sample of result.items||[])this.remember(record,sample);
  if(!record.desired.length&&!record.installedAt)record.desired=(result.items||[]).filter(s=>this.visible(s)).slice(0,3);
  await this.save(record);this.wake();return result;
 }
 async ensure(item,samples,full=false){
  await this.ready;const record=this.records.get(this.key(item));if(!record)throw Error('Listing catalogue is still loading.');
  return Promise.all(samples.filter(s=>this.visible(s)).map(async sample=>{
   const entry=this.remember(record,sample),field=full?'full':'thumb';
   if(entry[field]){
    if(!this.urls.has(entry[field])){const blob=await this.read('images',entry[field]);if(blob)this.urls.set(entry[field],URL.createObjectURL(blob));else delete entry[field];}
    if(entry[field])return entry.sample;
   }
   const key=record.key+'|'+entry.key+'|'+field;
   let request=this.requests.get(key);
   if(!request){request={record,entry,field,waiters:[]};this.requests.set(key,request);}
   const promise=new Promise((resolve,reject)=>request.waiters.push({resolve,reject}));this.wake();return promise;
  }));
 }
 next(){
  // Round-robin the first three: no fourth image or full-size image passes this barrier.
  for(let index=0;index<3;index++)for(const key of this.manifest){
   const record=this.records.get(key),sample=this.wanted(record)[index];if(!sample)continue;
   const entry=this.remember(record,sample);
   if(!entry.thumb&&(!entry.retry||entry.retry<=this.now()))return {record,entry,field:'thumb'};
  }
  if(!this.complete())return null;
  for(const request of this.requests.values())if(!request.entry[request.field]&&(!request.entry.retry||request.entry.retry<=this.now()))return request;
  return null;
 }
 wake(delay=0){if(this.closed)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.pump(),delay);}
 pause(){clearTimeout(this.timer);this.controller?.abort();}
 changed(){this.options.changed?.();}
 async pump(){
  if(this.closed)return;if(this.running){this.queued=true;return;}this.running=true;
  try{
   await this.ready;
   for(const record of this.records.values())await this.install(record);
   while(!this.closed&&this.options.canDownload()){
    const task=this.next();if(!task)break;
    const {record,entry,field}=task;this.controller=new AbortController();
    try{
     const path=field==='full'?entry.sample.fullPath:entry.sample.path;
     if(!/^model-preview\/[a-zA-Z0-9/?=&_.%+-]+$/.test(path||''))throw Error('Invalid listing preview path.');
     const response=await fetch('/'+path,{signal:this.controller.signal,cache:'no-store'});
     if(!response.ok)throw Error('Preview unavailable (HTTP '+response.status+').');
     const blob=await response.blob();if(!blob.size||blob.size>(field==='full'?20:8)*1024*1024)throw Error('Preview exceeds device download limit.');
     const decoded=new Image(),temporary=URL.createObjectURL(blob);let width,height;
     try{decoded.src=temporary;await decoded.decode();width=decoded.naturalWidth;height=decoded.naturalHeight;}
     finally{URL.revokeObjectURL(temporary);decoded.src='';}
     if(!width||!height||width*height>40000000)throw Error('Invalid preview dimensions.');
     if(this.controller.signal.aborted)throw new DOMException('Preview paused.','AbortError');
     const key=record.key+'|'+entry.key+'|'+field;
     await this.write('images',blob,key);entry[field]=key;delete entry.retry;
     entry.sample.width||=width;entry.sample.height||=height;
     this.urls.set(key,URL.createObjectURL(blob));
     try{await this.save(record);}catch(error){delete entry[field];URL.revokeObjectURL(this.urls.get(key));this.urls.delete(key);throw error;}
     await this.install(record);
     for(const [id,request] of this.requests)if(request.record===record&&request.entry===entry&&request.field===field){
      this.requests.delete(id);for(const waiter of request.waiters)waiter.resolve(entry.sample);
     }
     this.error='';this.changed();
    }catch(error){
     if(error.name==='AbortError'||!this.options.canDownload())break;
     entry.retry=this.now()+30000;this.error=error.message;
     for(const [id,request] of this.requests)if(request.record===record&&request.entry===entry&&request.field===field){
      this.requests.delete(id);for(const waiter of request.waiters)waiter.reject(error);
     }
     this.changed();this.wake(30000);
    }finally{this.controller=null;}
   }
  }catch(error){this.error=error.message;this.changed();}
  finally{this.running=false;if(this.queued){this.queued=false;this.wake();}}
 }
 close(){this.closed=true;this.pause();for(const request of this.requests.values())for(const waiter of request.waiters)waiter.reject(Error('PC connection changed.'));
  this.requests.clear();for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();this.db?.close();}
}

// This lane cannot start until the current library inventory has synced. A new
// media transfer aborts an in-flight preview and retains every completed file.
const ModelPreviews={
 store:null,scope:'',libraryEpoch:-1,refreshEpoch:-1,refreshTimer:null,nextRefresh:0,
 async cache(){
  const config=window.Native?JSON.parse(Native.configuration()):{},scope=config.fingerprint||config.host||(window.Desktop?'desktop':'local');
  if(!this.store||this.scope!==scope){this.store?.close();this.scope=scope;this.store=new ListingPreviewCache({scope,
   canDownload:()=>connected&&!document.hidden&&window.Native?.listingPreviewsAllowed?.()!==false&&this.libraryEpoch===epoch&&!syncing&&!filling&&!originalTransfers.size&&!catalogLoading&&!profileBusy&&!profileLoad&&!(profileReady&&profileDirty)&&!settingsBusy,
   isViewing:item=>!!modelBrowser&&$('#modal').open&&browserItems(modelBrowser).some(x=>x.kind===item.kind&&x.name===item.name),
   changed:()=>{if(typeof modelPreviewCacheChanged==='function')modelPreviewCacheChanged();}});}
  await this.store.ready;return this.store;
 },
 async register(items,nsfwHidden,scanning=false){const store=await this.cache();await store.register(items,nsfwHidden!==true,!scanning);return store;},
 async start(data){
  try{await this.register(data.listings||[],data.nsfwHidden,data.scanning);this.wake();}catch{/* Browsing reports a storage failure without preventing generation. */}
 },
 synced(){this.libraryEpoch=epoch;this.wake();},
 wake(){this.store?.wake();},
 pause(){this.store?.pause();},
 connected(value){if(!value){this.libraryEpoch=-1;this.pause();}else this.wake();},
 samples(item){return this.store?.samples(item)||[];},url(item,sample,full=false){return this.store?.url(item,sample,full)||'';},
 async ensure(item,samples,full=false){return (await this.cache()).ensure(item,samples,full);},
 async page(item,cursor){return (await this.cache()).page(item,cursor,()=>api('model-gallery/'+encodeURIComponent(item.id)+(cursor?'?cursor='+encodeURIComponent(cursor):'')));},
 async refresh(){
  if(Date.now()<this.nextRefresh||!connected||document.hidden||window.Native?.listingPreviewsAllowed?.()===false||!catalog||this.libraryEpoch!==epoch||syncing||filling||originalTransfers.size||profileBusy||profileLoad||settingsBusy)return;
  if(this.refreshEpoch===epoch)return;this.refreshEpoch=epoch;
  try{const session=epoch,result=await api('model-library');if(session!==epoch)return;
   catalog.listings=modelListings=result.items||[];catalog.nsfwHidden=result.nsfwHidden;catalog.scanning=result.scanning;await this.register(modelListings,result.nsfwHidden,result.scanning);
   if(result.scanning){clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>{this.refreshEpoch=-1;this.refresh();},30000);}
  }catch{this.refreshEpoch=-1;this.nextRefresh=Date.now()+30000;}
 }
};
window.ModelPreviews=ModelPreviews;
