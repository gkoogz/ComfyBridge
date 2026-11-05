'use strict';
const emptyNote=()=>({text:'',marks:[],next:0});
let notebook={rev:0,edit:null,doc:emptyNote()},noteBusy=false,noteTimer,nextNoteSync=0,noteCursor=null,noteStatus='';
let noteKey='';
async function loadNotes(){
 noteKey='notepad:'+ (info().fingerprint||'local');
 const saved=await new Promise((resolve,reject)=>{const r=db.transaction('data').objectStore('data').get(noteKey);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 notebook=saved||{rev:0,edit:null,doc:emptyNote()};
}
function storeNotes(){
 const tx=db.transaction('data','readwrite');tx.objectStore('data').put(notebook,noteKey);
 tx.onerror=()=>toast(window.Desktop?'PC storage is full. Keep Notepad open until it syncs.':'Phone storage is full. Keep Notepad open until it syncs.');
}
function noteChanged(){
 notebook.edit=crypto.randomUUID();storeNotes();setNoteStatus(window.Desktop?'Saved on this PC':'Saved on this phone');
 clearTimeout(noteTimer);noteTimer=setTimeout(syncNotes,1100);
}
function setNoteStatus(value){noteStatus=value;if($('#noteStatus'))$('#noteStatus').textContent=value;}
async function syncNotes(){
 if(!connected||noteBusy||document.hidden||!db)return;
 noteBusy=true;nextNoteSync=Date.now()+15000;
 let sent=notebook.edit;const session=epoch;
 try{
  const pairedKey='notepad:'+info().fingerprint;
  if(pairedKey!==noteKey){
   const unpaired=noteKey==='notepad:local'?notebook:null;
   await loadNotes();
   if(unpaired?.edit&&!notebook.edit&&!notebook.rev){notebook=unpaired;storeNotes();}
   sent=notebook.edit;
   if(page==='notepad')paintNote(true);
  }
  const response=await api('studio/notes',sent?{base:notebook.rev,edit:sent,doc:structuredClone(notebook.doc)}:undefined);
  if(epoch!==session)return;
  if(notebook.edit!==sent){
   // If an edit happened during a pull, keep its original base revision. A
   // subsequent push can then preserve both versions if the PC also changed.
   if(sent&&!response.conflict)notebook.rev=response.rev;
   storeNotes();nextNoteSync=0;return;
  }
  const changed=response.doc&&JSON.stringify(response.doc)!==JSON.stringify(notebook.doc);
  if(changed)notebook.doc=response.doc;
  notebook.rev=response.rev;notebook.edit=null;storeNotes();
  if(changed&&page==='notepad')paintNote(true);
  setNoteStatus(response.conflict?'Synced · kept both offline drafts':'Synced with PC');
 }catch(e){setNoteStatus(window.Desktop?'Saved locally · sync pending':'Saved on phone · sync pending');nextNoteSync=Date.now()+15000;}
 finally{noteBusy=false;if(notebook.edit&&notebook.edit!==sent){clearTimeout(noteTimer);noteTimer=setTimeout(syncNotes,500);}}
}
const rowAt=(text,pos)=>text.slice(0,pos).split('\n').length-1;
function paddedRows(){
 const doc=notebook.doc,lines=doc.text.split('\n');
 const count=doc.text?lines.length+30:80;
 while(lines.length<count)lines.push('');
 return lines;
}
function paintNote(updateValue){
 const pad=$('#noteText');if(!pad)return;
 const lines=paddedRows(),doc=notebook.doc;
 const mirror=$('#notePaper');
 const blocks=document.createDocumentFragment();
 let row=0;
 const block=(end,cls)=>{
  if(end<=row)return;
  const el=document.createElement('div');el.className=cls;
  el.textContent=lines.slice(row,end).map(s=>s||'\u200b').join('\n');
  blocks.append(el);row=end;
 };
 for(const mark of doc.marks){
  block(Math.min(lines.length,mark.start),'plainBlock');
  block(Math.min(lines.length,mark.end+1),'stickyBlock pastel'+mark.color);
 }
 block(lines.length,'plainBlock');
 mirror.replaceChildren(blocks);
 const value=lines.join('\n');
 if(updateValue&&pad.value!==value){
  const a=pad.selectionStart,b=pad.selectionEnd;pad.value=value;pad.setSelectionRange(Math.min(a,value.length),Math.min(b,value.length));
 }
}
function rememberCursor(){
 const pad=$('#noteText');if(pad&&document.activeElement===pad)noteCursor=[pad.selectionStart,pad.selectionEnd];
}
function clearDecorationBelow(pad){
 const pos=pad.selectionStart;
 if(pos!==pad.selectionEnd||pos===0||pad.value[pos-1]!=='\n')return false;
 const above=rowAt(pad.value,pos)-1,m=notebook.doc.marks.find(m=>m.end===above);
 if(!m)return false;
 notebook.doc.marks=notebook.doc.marks.filter(x=>x!==m);noteChanged();paintNote(true);return true;
}
function updateMarks(before,after,selection){
 let a=0,oldEnd=before.length,newEnd=after.length;
 // Android often edits repeated newlines. Prefer the actual selection if
 // the IME's replacement matches it, otherwise find the changed span.
 if(selection&&before.slice(0,selection[0])===after.slice(0,selection[0])&&
    after.length>=selection[0]+before.length-selection[1]&&after.endsWith(before.slice(selection[1]))){
  a=selection[0];oldEnd=selection[1];newEnd=after.length-(before.length-oldEnd);
 }else{
  while(a<oldEnd&&a<newEnd&&before[a]===after[a])a++;
  while(oldEnd>a&&newEnd>a&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
 }
 const start=rowAt(before,a),stop=rowAt(before,oldEnd),next=rowAt(after,newEnd),shift=next-stop;
 if(!shift&&stop===start)return;
 const marks=[];
 for(const m of notebook.doc.marks){
  if(m.end<start)marks.push(m);
  else if(m.start>stop)marks.push({...m,start:m.start+shift,end:m.end+shift});
  else if(m.start<=start){
   marks.push({...m,end:m.end>stop?m.end+shift:next});
  }else if(m.end>stop){marks.push({...m,start:next+1,end:m.end+shift});}
 }
 notebook.doc.marks=marks;
}
function placeSticky(){
 const pad=$('#noteText'),doc=notebook.doc;
 const selection=noteCursor;
 let first,last;
 if(selection){
  first=rowAt(pad.value,selection[0]);
  last=rowAt(pad.value,Math.max(selection[0],selection[1]-1));
 }else{
  first=doc.text?doc.text.split('\n').length+1:2;last=first;
 }
 const keep=[];
 for(const m of doc.marks){
  if(m.end<first||m.start>last)keep.push(m);
  else{
   if(m.start<first)keep.push({...m,end:first-1});
   if(m.end>last)keep.push({...m,start:last+1});
  }
 }
 const color=doc.next%5;
 doc.marks=[...keep,{start:first,end:last,color}].sort((a,b)=>a.start-b.start);doc.next=(color+1)%5;
 noteChanged();paintNote(true);
 const at=selection?.[0]??paddedRows().slice(0,first).join('\n').length+(first?1:0);
 pad.focus({preventScroll:true});pad.setSelectionRange(at,at);rememberCursor();
}
function renderNotepad(){
 $('#main').innerHTML='<small id="noteStatus"></small><div class="noteCanvas"><div id="notePaper" aria-hidden="true"></div><textarea id="noteText" wrap="soft" aria-label="Notepad" spellcheck="true"></textarea></div><button id="addSticky" class="green">＋ Add sticky</button>';
 const pad=$('#noteText');noteCursor=null;paintNote(true);setNoteStatus(noteStatus||(connected?'Syncing…':window.Desktop?'Saved on this PC':'Saved on this phone'));
 let old=pad.value,selection=null,restoreDelete=false;
 pad.onbeforeinput=e=>{
  old=pad.value;selection=[pad.selectionStart,pad.selectionEnd];
  restoreDelete=false;
  if(e.inputType==='deleteContentBackward'&&clearDecorationBelow(pad)){
   if(e.cancelable)e.preventDefault();else restoreDelete=true;
  }
 };
 pad.onkeydown=e=>{if(e.key==='Backspace'&&clearDecorationBelow(pad))e.preventDefault();};
 pad.oninput=e=>{
  if(restoreDelete){restoreDelete=false;pad.value=old;pad.setSelectionRange(...selection);return;}
  const after=pad.value;updateMarks(old,after,selection);
  notebook.doc.text=after.replace(/\n+$/,'');
  const last=paddedRows().length-1;
  notebook.doc.marks=notebook.doc.marks.filter(m=>m.start<=last).map(m=>({...m,end:Math.min(m.end,last)}));
  noteChanged();paintNote(!e.isComposing);old=pad.value;selection=null;rememberCursor();
 };
 pad.oncompositionend=()=>{paintNote(true);old=pad.value;};
 pad.onselect=pad.onpointerup=pad.onkeyup=pad.onfocus=rememberCursor;
 $('#addSticky').onpointerdown=e=>{rememberCursor();e.preventDefault();};
 $('#addSticky').onclick=placeSticky;
}
