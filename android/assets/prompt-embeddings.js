'use strict';
// Prompt strings remain the durable format. The rich editor is only a view over
// ComfyUI's embedding syntax; no HTML is saved or sent to a model.
const PromptEmbeddings=(()=>{
 const token=/\(embedding:([^\s():]+):(-?\d+(?:\.\d+)?)\)|embedding:([^\s(),:]+)/gu;
 let serial=0;
 function parse(text){const parts=[];let start=0;for(const m of String(text).matchAll(token)){if(m.index>start)parts.push(text.slice(start,m.index));parts.push({name:m[1]||m[3],strength:m[2]===undefined?1:Number(m[2]),id:++serial});start=m.index+m[0].length;}if(start<text.length)parts.push(text.slice(start));return parts;}
 const syntax=p=>typeof p==='string'?p:'(embedding:'+p.name+':'+p.strength.toFixed(1)+')';
 const stringify=parts=>parts.map(syntax).join('');
 const length=n=>n.nodeType===3?n.data.length:n.nodeType===1&&n.hasAttribute('data-embedding')?1:n.nodeName==='BR'?1:[...n.childNodes].reduce((a,c)=>a+length(c),0);
 function position(root,node,offset){let result=0,found=false;function walk(n){if(n===node){result+=n.nodeType===3?offset:[...n.childNodes].slice(0,offset).reduce((a,c)=>a+length(c),0);found=true;return;}if(n.nodeType===1&&n.hasAttribute('data-embedding')){if(n.contains(node)){found=true;return;}result++;return;}if(n.nodeType===3){result+=n.data.length;return;}if(n.nodeName==='BR'){result++;return;}for(const c of n.childNodes){walk(c);if(found)return;}}walk(root);return found?result:length(root);}
 function selection(root){const s=getSelection();if(!s.rangeCount||!root.contains(s.anchorNode)||!root.contains(s.focusNode))return null;const a=position(root,s.anchorNode,s.anchorOffset),b=position(root,s.focusNode,s.focusOffset);return [Math.min(a,b),Math.max(a,b)];}
 function caret(root,offset){const r=document.createRange();let remaining=offset,done=false;function walk(n){if(done)return;if(n.nodeType===3){if(remaining<=n.data.length){r.setStart(n,remaining);done=true;}else remaining-=n.data.length;return;}if(n.nodeType===1&&n.hasAttribute('data-embedding')){if(remaining===0){r.setStartBefore(n);done=true;}else remaining--;return;}for(const c of n.childNodes)walk(c);}walk(root);if(!done){r.selectNodeContents(root);r.collapse(false);}else r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);}
 function read(root){const parts=[];function walk(n){if(n.nodeType===3){parts.push(n.data);return;}if(n.nodeType!==1)return;if(n.hasAttribute('data-embedding')){parts.push({name:n.dataset.embedding,strength:Number(n.dataset.strength),id:Number(n.dataset.tokenId)});return;}if(n.nodeName==='BR'){parts.push('\n');return;}for(const c of n.childNodes)walk(c);}for(const n of root.childNodes)walk(n);return parts;}
 function attach(field){
  if(field._embeddingEditor)return field._embeddingEditor;
  const native=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value'),root=document.createElement('div');
  root.className='embeddingEditor';root.contentEditable='true';root.setAttribute('role','textbox');root.setAttribute('aria-multiline','true');root.setAttribute('aria-label',(field.dataset.setting||'Full')+' prompt');root.spellcheck=true;root.hidden=true;
  if(field.id==='fullPrompt')root.classList.add('fullEmbeddingEditor');field.after(root);
  const editor={field,root,parts:[],bookmark:null,active:false};field._embeddingEditor=editor;
  function notify(){editor.parts=read(root);native.set.call(field,stringify(editor.parts));field.dispatchEvent(new Event('input',{bubbles:true}));}
  function paint(parts,at=null){editor.parts=parts;root.replaceChildren();for(const part of parts){if(typeof part==='string'){root.append(document.createTextNode(part));continue;}
   const chip=document.createElement('span');chip.className='embeddingBlock';chip.contentEditable='false';chip.dataset.embedding=part.name;chip.dataset.strength=part.strength;chip.dataset.tokenId=part.id;
   const title=document.createElement('span');title.className='embeddingName';title.textContent=part.name.replace(/\.(safetensors|pt|bin)$/i,'');title.title='embedding:'+part.name;chip.append(title);
   const value=document.createElement('span');value.className='embeddingStrength';value.textContent=part.strength.toFixed(1);chip.append(value);
   for(const [label,action,svg] of [['Increase strength',.1,'M6 15l6-6 6 6'],['Decrease strength',-.1,'M6 9l6 6 6-6'],['Remove embedding',null,'M6 6l12 12M18 6 6 18']]){const b=document.createElement('button');b.type='button';b.setAttribute('aria-label',label+' '+part.name);b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+svg+'"/></svg>';b.onpointerdown=e=>e.preventDefault();b.onclick=()=>{const current=read(root);const index=current.findIndex(p=>typeof p!=='string'&&p.id===part.id);if(index<0)return;if(action===null)current.splice(index,1);else current[index].strength=Math.round((current[index].strength+action)*10)/10;paint(current);notify();};chip.append(b);}
   root.append(chip);
  }if(!root.lastChild||root.lastChild.nodeType!==3)root.append(document.createTextNode(''));if(at!==null){root.focus({preventScroll:true});caret(root,at);} }
  function display(value){const parts=parse(String(value));if(parts.some(p=>typeof p!=='string')||editor.active){editor.active=true;root.hidden=false;field.hidden=true;field.style.display='none';paint(parts);} }
  Object.defineProperty(field,'value',{configurable:true,get(){return native.get.call(field);},set(value){native.set.call(field,value);display(native.get.call(field));}});
  editor.insert=(name)=>{if(/[\s():,]/u.test(name)){toast('This filename contains prompt delimiters. Rename the embedding file on the PC before inserting it.');return false;}if(!editor.active){editor.bookmark??=[field.value.length,field.value.length];editor.active=true;root.hidden=false;field.hidden=true;field.style.display='none';paint(parse(field.value));}const at=editor.bookmark?.[0]??length(root);replace(at,at,{name,strength:1,id:++serial});return true;};
  function replace(start,end,incoming=''){
   const out=[];let offset=0,inserted=false;
   for(const p of read(root)){const size=typeof p==='string'?p.length:1,next=offset+size;
    if(typeof p!=='string'){if(!inserted&&start<=offset){if(incoming)out.push(incoming);inserted=true;}out.push(p);}
    else{const a=Math.max(0,Math.min(size,start-offset)),b=Math.max(a,Math.min(size,end-offset));if(a)out.push(p.slice(0,a));if(!inserted&&start<=next){if(incoming)out.push(incoming);inserted=true;}if(b<size)out.push(p.slice(b));}
    offset=next;
   }if(!inserted&&incoming)out.push(incoming);
   paint(out,start+(typeof incoming==='string'?incoming.length:1));notify();
  }
  root.addEventListener('beforeinput',e=>{const range=selection(root)||[length(root),length(root)];let [a,b]=range;
   if(e.inputType.startsWith('delete')){e.preventDefault();if(a===b){if(/Backward/.test(e.inputType))a=Math.max(0,a-1);else b=Math.min(length(root),b+1);}replace(a,b);}
   else if(e.inputType==='insertParagraph'||e.inputType==='insertLineBreak'){e.preventDefault();replace(a,b,'\n');}
   else if(e.inputType==='insertText'&&!e.isComposing){e.preventDefault();replace(a,b,e.data||'');}
   else if(e.inputType==='historyUndo'||e.inputType==='historyRedo'){e.preventDefault();}
  });
  root.addEventListener('paste',e=>{e.preventDefault();const [a,b]=selection(root)||[length(root),length(root)];replace(a,b,e.clipboardData.getData('text/plain'));});
  root.addEventListener('drop',e=>e.preventDefault());
  root.addEventListener('cut',e=>{e.preventDefault();const [a,b]=selection(root)||[0,0];copy(e,a,b);replace(a,b);});
  function copy(e,a,b){let at=0,text='';for(const p of read(root)){const n=typeof p==='string'?p.length:1;if(at<b&&at+n>a)text+=typeof p==='string'?p.slice(Math.max(0,a-at),Math.min(n,b-at)):syntax(p);at+=n;}e.clipboardData.setData('text/plain',text);}
  root.addEventListener('copy',e=>{const range=selection(root);if(range){e.preventDefault();copy(e,...range);}});
  root.addEventListener('input',()=>{ // Android/IME fallback for non-cancellable deletion.
   const current=read(root),missing=editor.parts.filter(p=>typeof p!=='string'&&!current.some(c=>typeof c!=='string'&&c.id===p.id));
   if(missing.length){let offset=0;for(const p of editor.parts){if(missing.includes(p)){let i=0,seen=0;for(;i<current.length&&seen<offset;i++)seen+=typeof current[i]==='string'?current[i].length:1;current.splice(i,0,p);}offset+=typeof p==='string'?p.length:1;}paint(current);}notify();
  });
  const remember=()=>{const s=selection(root);if(s)editor.bookmark=s;};root.addEventListener('keyup',remember);root.addEventListener('pointerup',remember);root.addEventListener('focusout',remember);
  field.addEventListener('input',()=>{if(!editor.active)display(field.value);});
  field.addEventListener('select',()=>editor.bookmark=[field.selectionStart,field.selectionEnd]);
  for(const event of ['pointerup','keyup'])field.addEventListener(event,()=>editor.bookmark=[field.selectionStart,field.selectionEnd]);
  display(field.value);return editor;
 }
 function insert(kind,key,item){const s=state.settings[kind],field=page===kind?document.querySelector('textarea.promptEntry[data-setting="'+key+'"]'):null;
  if(field){const editor=attach(field);if(!editor.insert(item.name))return;sizePrompt(field,true);}else{s[key]=(s[key]||'').replace(/\s+$/u,'')+' '+syntax({name:item.name,strength:1});persist(kind);}toast('Embedding inserted into '+key+' prompt');
 }
 return {attach,insert,parse,stringify};
})();
