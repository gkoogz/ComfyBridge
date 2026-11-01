'use strict';
let profileReady=false, profileBusy=false, profileDirty=false, profileTimer, profileList=[], profileStatus='', freshPhone=true, profileLoad=0, retryProfiles=0;
const knownInputs=new Map();
function info(){return JSON.parse(Native.configuration());}
async function mapState(x,fn){if(x&&typeof x==='object'){const y=await fn(x);if(y!==x)return y;
 if(Array.isArray(x))return Promise.all(x.map(v=>mapState(v,fn)));
 const out={};for(const k of Object.keys(x))out[k]=await mapState(x[k],fn);return out;}
 return fn(x);}
function backupState(){const {settings,presets,prompts,inputs}=state;return {settings,presets,prompts,inputs};}
function profileMessage(text){profileStatus=text;if(document.querySelector('#backupStatus'))document.querySelector('#backupStatus').textContent=text;}
function scheduleBackup(){profileDirty=true;clearTimeout(profileTimer);if(profileReady&&connected)profileTimer=setTimeout(flushProfile,1000);}
async function flushProfile(){if(profileBusy||!profileReady||!connected||!profileDirty||!Object.keys(state.settings).length)return;profileBusy=true;profileDirty=false;const id=epoch;
 try{profileMessage('Saving settings…');const copy=await encodeShared(structuredClone(backupState()),id);
  if(id!==epoch)throw Error('Connection changed');await api('profile',{name:info().name,state:copy});profileMessage('Saved on PC · '+new Date().toLocaleTimeString());
 }catch(e){profileDirty=true;profileMessage('Backup pending: '+e.message);}
 finally{profileBusy=false;if(profileDirty&&connected&&profileReady)profileTimer=setTimeout(flushProfile,5000);}
}
async function restoreProfile(device,id=epoch){
 const saved=await api('profile/'+device);const restored=await mapState(saved,async x=>x&&typeof x==='object'&&typeof x.bridgeInput==='string'?(await api('profile-blob/'+x.bridgeInput)).value:x);
 if(id!==epoch||!connected)throw Error('Disconnected before restore');
 if(!restored.settings||!restored.inputs||!restored.presets||!Array.isArray(restored.prompts))throw Error('Incomplete PC backup');
 Object.assign(state,restored);if(!freshPhone)sections.forEach(markEdited);persist(null);render();profileMessage('Restored from PC');
}
async function startProfiles(id){if(profileLoad===id)return;profileLoad=id;profileReady=false;knownInputs.clear();try{
 const list=await api('profiles');if(id!==epoch||!connected)return;profileList=list;
 if(freshPhone&&list.length)await restoreProfile(list[0].device,id);
 if(id!==epoch||!connected)return;freshPhone=false;profileReady=true;
 if(page==='bridge')renderBridge();scheduleBackup();syncSettings();syncNotes();
 }catch(e){retryProfiles=Date.now()+15000;profileMessage('PC backup unavailable: '+e.message);}finally{if(profileLoad===id)profileLoad=0;}}
function profileControls(){if(!connected)return;
 const settings=document.createElement('button');settings.id='bridgeOptions';settings.textContent='Backups & notifications  ›';document.querySelector('#main').append(settings);
 settings.onclick=()=>{
 openModal('Backups & notifications','<section class="card"><h2>PC settings backup</h2><p id="backupStatus"></p><button id="backupNow">Save now</button> <button id="restoreFrom">Restore from a phone…</button> <button id="alerts">Generation notifications</button></section>');
 profileMessage(profileStatus||'Checking PC backups…');
 document.querySelector('#backupNow').onclick=async()=>{if(!profileReady)await startProfiles(epoch);profileDirty=true;await flushProfile();};
 document.querySelector('#alerts').onclick=()=>Native.enableAlerts();
 document.querySelector('#restoreFrom').onclick=async()=>{try{const list=await api('profiles');if(!list.length)return toast('No PC backups yet.');
  openModal('Restore settings','<section class="card"><p>Replace settings on this phone with a saved copy. The source phone’s backup stays on the PC.</p><select id="fromProfile">'+list.map(p=>'<option value="'+esc(p.device)+'">'+esc(p.name)+' · '+p.device.slice(0,6)+' · '+esc(new Date(p.modified*1000).toLocaleString())+'</option>').join('')+'</select><button id="applyRestore">Restore selected settings</button></section>');
  document.querySelector('#applyRestore').onclick=async()=>{try{await restoreProfile(document.querySelector('#fromProfile').value);closeModal();toast('Settings restored');}catch(e){toast(e.message);}};
 }catch(e){toast(e.message);}};
 };
}
