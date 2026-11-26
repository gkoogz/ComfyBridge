'use strict';
const BrowseReplica=(()=>{
 const defaults={offset:0,banned:false,disabled:false};
 const key=i=>i.kind+':'+String(i.id);
 function load(scope,account){
  const name=scope+':replica:'+account;
  try{return {...JSON.parse(window.Native?.loadSocialQueue?.(name)||localStorage.getItem(name)||'{}'),name};}
  catch{return {name};}
 }
 function save(replica){
  const {name,...data}=replica,value=JSON.stringify(data);
  if(window.Native?.saveSocialQueue){
   if(!Native.saveSocialQueue(name,value))throw Error('Could not save Browse changes on this phone.');
  }else localStorage.setItem(name,value);
 }
 function effective(replica){
  const rows=new Map((replica.items||[]).map(r=>[key(r),{...r}]));
  for(const edit of Object.values(replica.changes||{})){
   const row=rows.get(key(edit))||{kind:edit.kind,id:edit.id,name:edit.name,base:0,...defaults};
   for(const [field,change] of Object.entries(edit.changes))row[field]=change.value;
   row.weight=row.banned||row.disabled?0:Math.max(0,(row.base||0)+(row.offset||0));
   rows.set(key(edit),row);
  }
  return [...rows.values()];
 }
 function edit(replica,row,values,autoDisabled=false){
  replica.changes??={};
  const id=key(row),baseline=(replica.items||[]).find(r=>key(r)===id)||defaults;
  const previous=replica.changes[id];
  const changes={...previous?.changes};
  for(const [field,value] of Object.entries(values)){
   changes[field]={base:changes[field]?.base??baseline[field]??defaults[field],revision:changes[field]?.revision??baseline.revisions?.[field]??'',value};
  }
  replica.changes[id]={kind:row.kind,id:String(row.id),name:row.name,requestId:crypto.randomUUID(),changes,autoDisabled:values.disabled!==undefined?autoDisabled:!!previous?.autoDisabled};
 }
 function accept(replica,result,sent=[]){
  const byKey=new Map(result.items.map(row=>[key(row),row]));
  for(const old of sent){
   if(!result.applied?.includes(old.requestId))continue;
   const current=replica.changes?.[key(old)];if(!current)continue;
   if(current.requestId===old.requestId){delete replica.changes[key(old)];continue;}
   const base=byKey.get(key(old));
   // Keep votes entered during the round trip, based on the acknowledged edit.
   for(const [field,change] of Object.entries(current.changes)){
    if(!old.changes[field]||!base)continue;
    if(change.value===old.changes[field].value){delete current.changes[field];continue;}
    if(field==='offset')change.value=base.offset+change.value-old.changes[field].value;
    change.base=base[field]??defaults[field];change.revision=base.revisions?.[field]||'';
   }
   if(!Object.keys(current.changes).length)delete replica.changes[key(old)];
  }
  replica.items=result.items;replica.checked=Date.now();
 }
 const uuidMedia=/^[a-f\d-]{36}$/i,cdnRoot='https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/';
 const cdn=(url,variant)=>uuidMedia.test(url||'')?cdnRoot+url+'/'+variant:(/^https:\/\//.test(url||'')?url:'');
 function normalize(account,image){
  const id=String(image.id||'');if(!/^[1-9][0-9]{0,14}$/.test(id)||!['image','video'].includes(image.type||'image'))return null;
  const type=image.type||'image',user=image.user||{},meta=image.meta||{},prefix='model-preview/browse/'+account+'/'+id+'/';
  const tags=new Map((image.tags||[]).filter(t=>t?.id).map(t=>[String(t.id),{id:String(t.id),name:t.name||'Tag '+t.id}]));
  for(const tag of image.tagIds||[])if(!tags.has(String(tag)))tags.set(String(tag),{id:String(tag),name:'Tag '+tag});
  let thumb=cdn(image.thumbnailUrl||image.thumbnail?.url,'width=640');
  if(!thumb)thumb=cdn(image.url,type==='video'?'anim=false,transcode=true,optimized=true/'+image.url+'.jpeg':'width=640');
  const full=cdn(image.url,type==='video'?'original=true/'+image.url+'.mp4':'original=true');
  if(!thumb||!full)return null;
  const avatar=cdn(user.profilePicture?.url||user.profilePicture||user.image?.url||user.image||user.avatarUrl,'width=96');
  const item={id,type,width:image.width||512,height:image.height||768,credit:String(user.username||image.username||''),
   creatorId:String(user.id||image.userId||''),created:image.createdAt||'',duration:image.metadata?.duration,
   imageUrl:'https://civitai.red/images/'+id,path:prefix+'thumb',fullPath:prefix+'full',mediaUrls:{thumb,full,avatar},avatarPath:avatar?prefix+'avatar':'',
   tags:[...tags.values()],tagsKnown:Array.isArray(image.tags)||Array.isArray(image.tagIds),stats:image.stats||{},
   reactions:(image.reactions||[]).map(r=>r?.reaction||r)};
  return {...item,...generation({meta,resources:[...(meta.civitaiResources||[]),...(meta.resources||[])]}),detailVersion:0,generationDataAvailable:false};
 }
 function generation(data){
  const meta=data.meta||{},parameters={};for(const field of ['seed','steps','cfgScale','sampler','Size','Model','clipSkip','denoise'])if(field in meta)parameters[field]=meta[field];
  return {prompt:String(meta.prompt||''),negativePrompt:String(meta.negativePrompt||''),parameters,
   resources:(data.resources||[]).map(r=>({versionId:String(r.modelVersionId||r.versionId||''),modelId:String(r.modelId||''),
    name:String(r.modelName||r.name||'Resource'),version:String(r.versionName||r.modelVersionName||''),
    type:String(r.modelType||r.type||'Resource'),weight:r.strength??r.weight??''})),detailVersion:2,generationDataAvailable:true};
 }
 const pick=rows=>{
  let roll=Math.random()*rows.reduce((n,r)=>n+r.weight,0);
  return rows.find(r=>(roll-=r.weight)<0)||rows.at(-1);
 };
 function sources(channel,rows,following){
  if(channel==='reactions')return [{filters:{reactions:['Like','Heart','Laugh','Cry']}}];
  const [kind,id,type]=channel.split(':'),types=type&&type!=='all'?{types:[type]}:{};
  if(kind==='collection')return [{filters:{collectionId:Number(id)}}];
  if(kind==='creator')return [{filters:{userId:Number(id),...types}}];
  if(kind==='tag'||kind==='tags'){
   const ids=id.split(',');return [{filters:{tags:ids.map(Number),...types},ids}];
  }
  const valid=rows.filter(r=>!r.banned&&!r.disabled&&r.weight>0),tags=valid.filter(r=>r.kind==='tag');
  const creators=valid.filter(r=>r.kind==='creator');
  const excluded=new Set(rows.filter(r=>r.kind==='creator'&&(r.banned||r.disabled)).map(r=>String(r.id)));
  for(const id of following||[])if(!excluded.has(String(id))&&!creators.some(r=>String(r.id)===String(id)))creators.push({id,weight:1});
  const result=[],used=new Set();
  for(let i=0;i<8&&tags.length>=2;i++){
   const first=pick(tags),second=pick(tags.filter(t=>t!==first)),pair=[first,second].sort((a,b)=>a.id-b.id),ids=pair.map(r=>String(r.id));
   if(used.has(ids.join(',')))continue;used.add(ids.join(','));
   result.push({filters:{tags:ids.map(Number)},ids,chosenBy:{kind:'tags',ids}});
  }
  const creator=pick(creators);if(creator)result.push({filters:{userId:Number(creator.id)},chosenBy:{kind:'creator',id:String(creator.id)}});
  result.push({filters:{}});return result;
 }
 return {load,save,effective,edit,accept,normalize,generation,sources};
})();
