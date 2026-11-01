'use strict';
const pixelBudget=768*1152;
const stepLimit=kind=>kind==='image'?50:20;
const limit=(n,min,max)=>Math.min(max,Math.max(min,n));
function aspect(w,h){
 if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1)return '—';
 let a=w,b=h;while(b){const r=a%b;a=b;b=r;}
 return (w/a)+':'+(h/a);
}

function installFold(panel){
 if(!panel||panel.classList.contains('foldPanel'))return;
 const heading=panel.firstElementChild;
 const title=heading.matches('h2')?heading:heading.querySelector('h2,label,strong');
 const name=title.textContent.trim(),key='fold:'+page+':'+name;
 const row=document.createElement('div');row.className='foldHead';
 panel.prepend(row);
 if(title!==heading){for(const child of [...heading.children])if(child!==title)row.append(child);}
 heading.remove();
 const body=document.createElement('div');body.className='foldBody';body.id='fold-'+name.toLowerCase().replace(/[^a-z]+/g,'-');
 while(row.nextSibling)body.append(row.nextSibling);
 panel.append(body);panel.classList.add('foldPanel');
 const toggle=document.createElement('button');toggle.className='foldToggle';toggle.type='button';
 toggle.textContent=name;toggle.setAttribute('aria-controls',body.id);row.prepend(toggle);
 const apply=closed=>{
  body.hidden=closed;toggle.setAttribute('aria-expanded',String(!closed));panel.classList.toggle('folded',closed);
  if(closed)body.querySelector('video')?.pause();
 };
 const saved=localStorage.getItem(key);
 apply(saved===null?['PC Queue','LoRAs'].includes(name):saved==='1');
 toggle.onclick=()=>{const closed=!body.hidden;apply(closed);localStorage.setItem(key,closed?'1':'0');};
 // An Add or Expand action next to a closed heading should still be useful.
 row.addEventListener('click',e=>{if(body.hidden&&e.target.closest('button')!==toggle&&e.target.closest('button')){apply(false);localStorage.setItem(key,'0');}},true);
}

const linkIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 14 4-4m-6 3-1 1a3 3 0 1 0 4 4l3-3a3 3 0 0 0 0-4m2 0 1-1a3 3 0 1 0-4-4l-3 3a3 3 0 0 0 0 4"/></svg>';
function canvasInputs(s){
 return '<div class="canvasFields"><label>Width<input type="number" inputmode="numeric" data-setting="width" min="32" max="8192" step="1" value="'+s.width+'"></label>'+
 '<button id="linkAspect" type="button" aria-label="Lock aspect ratio">'+linkIcon+'</button>'+
 '<label>Height<input type="number" inputmode="numeric" data-setting="height" min="32" max="8192" step="1" value="'+s.height+'"></label></div>'+
 '<div class="ratioLine">Canvas aspect ratio <strong id="canvasRatio"></strong></div>';
}
function bindCanvas(s){
 const w=$('[data-setting="width"]'),h=$('[data-setting="height"]'),link=$('#linkAspect');
 function refresh(){const locked=!!s.aspectLock;
  link.setAttribute('aria-pressed',String(locked));link.setAttribute('aria-label',locked?'Unlock aspect ratio':'Lock aspect ratio');
  $('#canvasRatio').textContent=aspect(s.width,s.height)+(locked?' · Locked':'');
 }
 link.onclick=()=>{s.aspectLock=s.aspectLock?null:[s.width,s.height];refresh();persist();};
 function edit(input,companion,key,other,commit){
  let value=input.valueAsNumber;
  if(!Number.isFinite(value)){if(commit)input.value=s[key];return;}
  let min=32,max=8192,ratio=null;
  if(s.aspectLock){
   const [width,height]=s.aspectLock;ratio=key==='width'?width/height:height/width;
   min=Math.max(min,Math.ceil(32*ratio-1e-8));max=Math.min(max,Math.floor(8192*ratio+1e-8));
  }
  if(!commit&&(value<min||value>max))return;
  value=limit(Math.round(value),min,max);s[key]=value;
  if(commit)input.value=value;
  if(ratio){s[other]=limit(Math.round(value/ratio),32,8192);companion.value=s[other];}
  refresh();persist();
 }
 for(const [input,companion,key,other] of [[w,h,'width','height'],[h,w,'height','width']]){
  input.oninput=()=>edit(input,companion,key,other,false);
  input.onblur=()=>edit(input,companion,key,other,true);
 }
 refresh();
}
function videoSize(inp,pct){
 const side=n=>Math.max(32,Math.round(n*(1+pct/100)/32)*32);
 return [side(inp.width),side(inp.height)];
}
function videoScaleStops(inp,selected){
 const safe=[],over=[];
 for(let pct=-90;pct<=100;pct++){
  const [w,h]=videoSize(inp,pct);
  if(w>8192||h>8192)continue;
  const entries=w*h<=pixelBudget?safe:over,last=entries[entries.length-1];
  if(last&&last.w===w&&last.h===h){if(pct===0)last.pct=0;continue;}
  entries.push({pct,w,h});
 }
 // Reserve most of the travel for usable resolutions. Keep Original and a
 // restored preset selectable even if their pixel count exceeds the budget.
 const stops=safe.map(x=>x.pct);
 const tail=over.slice(0,Math.max(1,Math.ceil(safe.length/8)));
 stops.push(...tail.map(x=>x.pct));
 for(const pct of [0,selected]){
  const [w,h]=videoSize(inp,pct);
  if(Number.isInteger(pct)&&pct>=-90&&pct<=100&&w<=8192&&h<=8192)stops.push(pct);
 }
 return [...new Set(stops)].sort((a,b)=>a-b);
}
function bindVideoScale(s,inp){
 const slider=$('[data-setting="scale"]'),reset=$('#originalScale');
 if(s.extension){slider.disabled=true;reset.disabled=true;$('#scaleBounds').textContent='Resolution and FPS match the source clip.';return;}
 if(!inp.data){slider.disabled=true;reset.disabled=true;$('#scaleBounds').textContent='Choose a starting image to scale.';return;}
 const stops=videoScaleStops(inp,s.scale),index=stops.indexOf(s.scale);
 if(!stops.length){slider.disabled=true;reset.disabled=true;$('#scaleBounds').textContent='Choose a smaller source to fit the model’s maximum dimensions.';return;}
 slider.min=0;slider.max=stops.length-1;slider.step=1;slider.value=Math.max(0,index);
 const red=stops.findIndex(p=>{const [w,h]=videoSize(inp,p);return w*h>pixelBudget;});
 const threshold=red<0?100:limit((red-.5)/Math.max(1,stops.length-1)*100,0,100);
 slider.style.setProperty('--safe-stop',threshold+'%');
 $('#scaleBounds').textContent=stops[0]+'% to '+(stops.at(-1)>0?'+':'')+stops.at(-1)+'%';
 const change=index=>{slider.value=index;s.scale=stops[index];updateVideo(true);persist();};
 slider.oninput=()=>change(+slider.value);
 reset.disabled=!stops.includes(0);
 reset.onclick=()=>change(stops.indexOf(0));
}

function bindSteps(s,maxSteps){
 const typed=$('input[type=number][data-setting=steps]'),range=$('input[type=range][data-setting=steps]');
 typed.oninput=()=>{if(typed.value==='')return;const n=limit(Math.round(typed.valueAsNumber)||1,1,maxSteps);s.steps=n;range.value=n;if(+typed.value!==n)typed.value=n;persist();};
 typed.onblur=()=>{typed.value=s.steps;};
}
let lastTick=-Infinity;
document.addEventListener('input',e=>{
 if(!e.isTrusted||!e.target.matches('#main input[type=range][data-setting],#main input[type=range][data-strength]'))return;
 const now=performance.now();
 if(now-lastTick>=48){lastTick=now;window.Native?.sliderTick?.();}
});
