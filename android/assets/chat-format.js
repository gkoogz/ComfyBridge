'use strict';
// Display-only formatting: stored conversation and editable user text remain intact.
function chatPlainText(text){
 return String(text||'').replace(/^\s*```[^\n]*\n/gm,'').replace(/```/g,'')
  .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*>\s?/gm,'')
  .replace(/\*\*([^]*?)\*\*/g,'$1').replace(/__([^]*?)__/g,'$1')
  .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g,'$1$2')
  .replace(/`([^`\n]*)`/g,'$1').replace(/`/g,'')
  .replace(/^([ \t]*)\*\s+/gm,'$1• ').trim();
}
function chatParts(content){
 // Also separate older replies with a clearly labelled prompt section.
 let raw=String(content||'');
 if(!raw.includes('<prompt>')){
  raw=raw.replace(/(^|\n)(?:\*\*|#{1,6}\s*)?((?:(?:refined|suggested|revised|final|positive|negative|image|video)\s+)*prompt)\s*:\s*(?:\*\*)?\s*\n([^]*?)(?=\n\s*(?:\*\*[^\n]+:\*\*|#{1,6}\s)|$)/gi,
   (_,lead,label,body)=>lead+'<prompt>'+body+'</prompt>');
 }
 const result=[];let prompt=false,start=0;const tags=/<\/?prompt>/g;let match;
 const add=text=>{text=chatPlainText(text.replace(/<\/?p(?:r(?:o(?:m(?:p(?:t)?)?)?)?)?$/,''));if(text)result.push({content:text,prompt});};
 while((match=tags.exec(raw))){add(raw.slice(start,match.index));prompt=match[0]==='<prompt>';start=tags.lastIndex;}
 add(raw.slice(start));
 return result.length?result:[{content:'',prompt:false}];
}
function chatDisplayMessages(messages){
 return messages.flatMap(item=>item.role!=='assistant'?[item]:chatParts(item.content).map((part,index)=>({...item,...part,id:index?item.id+'-part-'+index:item.id})));
}
if(typeof module!=='undefined')module.exports={chatPlainText,chatParts,chatDisplayMessages};
