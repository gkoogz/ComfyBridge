/* Approved Browse loader: local canvas drawing only; no network or background work. */
'use strict';
const BrowseLoader=(()=>{
 let current=null;
 function attach(host,workspace,allowed){
  if(current?.host===host){current.refresh();return;}
  current?.dispose();current=null;if(!host)return;
  current=create(host,workspace,allowed);
 }
 function stop(){current?.dispose();current=null;}
 function refresh(){current?.refresh();}
 function create(host,workspace,allowed){
  const section=host.closest('.civitaiBrowse'),canvas=host.querySelector('.browseFluid'),flung=host.querySelector('.browseFlung'),spinner=host.querySelector('.browseLoaderSpinner');
  const ctx=canvas.getContext('2d'),fx=flung.getContext('2d'),state={reach:24,speed:1.5};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),listeners=[];
  let width=500,tick=0,frame=0,lastFrame=0,running=false,disposed=false,visible=false,layout=true;
  let sparks=[],stir=0,gesture=null,pull=0,edgeOffset=0,rebound=null,wheelTimer=0,mouseId=null;
  const on=(el,name,fn,options)=>{el.addEventListener(name,fn,options);listeners.push(()=>el.removeEventListener(name,fn,options));};
  const atBottom=()=>workspace.scrollHeight-workspace.clientHeight-workspace.scrollTop<3;
  const usable=()=>!disposed&&host.isConnected&&!host.hidden&&!host.classList.contains('pullFailed')&&!host.classList.contains('pullCovered')&&!document.hidden&&allowed();
  function size(){
   width=host.clientWidth;if(!width)return;
   host.style.setProperty('--loader-height',Math.max(180,workspace.clientHeight-64)+'px');
   const dpr=Math.min(devicePixelRatio||1,1.5);
   canvas.width=Math.round(width*dpr);canvas.height=Math.round(112*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
   flung.width=Math.round(width*dpr);flung.height=Math.round(200*dpr);fx.setTransform(dpr,0,0,dpr,0,0);
   layout=true;if(!running)draw();
  }
  function position(){
   const rect=host.getBoundingClientRect(),view=workspace.getBoundingClientRect();
   // The waves live at the content edge. Only this spinner follows the viewport.
   const top=Math.max(65,Math.min(host.clientHeight-82+edgeOffset,view.bottom-rect.top-82-edgeOffset*.3));
   spinner.style.top=top+'px';layout=false;
  }
  function clearPull(){
   gesture=null;pull=0;edgeOffset=0;rebound=null;clearTimeout(wheelTimer);
   section?.style.removeProperty('translate');layout=true;
  }
  function refresh(){
   if(disposed)return;layout=true;
   const next=usable()&&visible&&!reduced.matches;
   host.classList.toggle('fluidRunning',next);running=next;
   if(!next){cancelAnimationFrame(frame);frame=0;lastFrame=0;clearPull();sparks=[];fx.clearRect(0,0,width,200);if(usable()&&visible){position();draw();}}
   else if(!frame)frame=requestAnimationFrame(animate);
  }
  function tug(distance){
   if(!running||!atBottom())return;rebound=null;
   const delta=distance-pull;pull=Math.max(0,distance);edgeOffset=38*(1-Math.exp(-pull/110));
   stir=Math.min(4,stir+Math.abs(delta)*.035);section.style.translate='0 '+(-edgeOffset)+'px';layout=true;
  }
  function release(cancel=false){
   gesture=null;if(mouseId!==null){if(workspace.hasPointerCapture(mouseId))workspace.releasePointerCapture(mouseId);mouseId=null;}
   if(!edgeOffset){pull=0;return;}
   rebound={start:performance.now(),from:edgeOffset,distance:pull,emitted:cancel};pull=0;
  }
  function animate(now){
   frame=0;if(!running||!usable()){refresh();return;}
   if(!lastFrame)lastFrame=now;
   if(now-lastFrame>=33){
    const dt=Math.min(now-lastFrame,80)/1000;lastFrame=now;tick+=dt*state.speed;
    if(rebound){const progress=Math.min(1,(now-rebound.start)/480);edgeOffset=rebound.from*Math.pow(1-progress,3)*Math.cos(progress*Math.PI*.7);section.style.translate='0 '+(-edgeOffset)+'px';layout=true;
     if(progress>=.67&&!rebound.emitted){rebound.emitted=true;if(rebound.distance>18)sprinkle(rebound.distance);}
     if(progress===1){rebound=null;edgeOffset=0;section.style.removeProperty('translate');}
    }
    if(layout)position();advanceDroplets(dt);drawSparkles(dt);draw();
   }
   frame=requestAnimationFrame(animate);
  }
  const interactive=target=>target.closest('button,summary,input,textarea,select,a,video,.browseCarousel');
  on(workspace,'touchstart',e=>{
   if(!running||!atBottom()||e.touches.length!==1||interactive(e.target))return;
   gesture={x:e.touches[0].clientX,y:e.touches[0].clientY,claimed:false};
  },{passive:true});
  on(workspace,'touchmove',e=>{
   if(!gesture)return;if(e.touches.length!==1){release(true);return;}
   const dx=e.touches[0].clientX-gesture.x,dy=gesture.y-e.touches[0].clientY;
   if(!gesture.claimed&&(Math.abs(dx)>Math.abs(dy)||dy<0)){gesture=null;return;}
   if(dy<6&&!gesture.claimed)return;
   if(!atBottom()){release(true);return;}gesture.claimed=true;e.preventDefault();tug(dy);
  },{passive:false});
  on(workspace,'touchend',()=>release());on(workspace,'touchcancel',()=>release(true));
  on(workspace,'wheel',e=>{if(!running||!atBottom()||e.deltaY<=0||Math.abs(e.deltaX)>Math.abs(e.deltaY)||interactive(e.target))return;e.preventDefault();tug(pull+e.deltaY*(e.deltaMode===1?16:1));clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>release(),140);},{passive:false});
  on(workspace,'pointerdown',e=>{if(e.pointerType!=='mouse'||e.button!==0||!running||!atBottom()||!host.contains(e.target))return;gesture={x:e.clientX,y:e.clientY,claimed:false};mouseId=e.pointerId;});
  on(workspace,'pointermove',e=>{if(e.pointerId!==mouseId||!gesture)return;const dy=gesture.y-e.clientY,dx=e.clientX-gesture.x;if(!gesture.claimed&&Math.abs(dx)>Math.abs(dy)){release(true);return;}if(dy<6&&!gesture.claimed)return;gesture.claimed=true;workspace.setPointerCapture(e.pointerId);e.preventDefault();tug(dy);});
  on(workspace,'pointerup',e=>{if(e.pointerId===mouseId)release();});on(workspace,'pointercancel',e=>{if(e.pointerId===mouseId)release(true);});
  on(host,'click',e=>{if(rebound||edgeOffset>0){e.preventDefault();e.stopImmediatePropagation();}},true);
  let lastScroll=workspace.scrollTop;
  on(workspace,'scroll',()=>{const delta=workspace.scrollTop-lastScroll;lastScroll=workspace.scrollTop;layout=true;if(running)stir=Math.min(4,stir+Math.abs(delta)*.015);},{passive:true});
  on(document,'visibilitychange',refresh);on(reduced,'change',refresh);
  const visibility=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;refresh();},{root:workspace});visibility.observe(host);
  const resize=new ResizeObserver(()=>{size();refresh();});resize.observe(workspace);resize.observe(host);
  const mutation=new MutationObserver(refresh);mutation.observe(host,{attributes:true,attributeFilter:['hidden','class']});mutation.observe(document.body,{attributes:true,attributeFilter:['class','data-page']});
  function sprinkle(distance){
   if(!running||!atBottom())return;
   const ceiling=canvas.getBoundingClientRect().top-host.getBoundingClientRect().top;
   if(ceiling>host.clientHeight||ceiling< -90)return;
   const count=Math.min(11,7+Math.floor(distance/60)),points=surface(tick*.65);
   for(let i=0;i<count&&sparks.length<24;i++){
    const life=1+Math.random()*.4,x=width*(.12+Math.random()*.76),edge=points[Math.min(points.length-1,Math.round((x+4)/3))][1];
    sparks.push({x,y:ceiling+edge+2,vx:(Math.random()-.5)*12,vy:14+Math.random()*12,life,maxLife:life,size:1+Math.random()*.5,gold:Math.random()<.6,angle:Math.random()*6.28});
   }
   let offset=0;for(const d of droplets)if(d.fall===null&&d.age>.6){d.releaseIn=.08+offset+Math.random()*.07;offset+=.15;}
  }
  function drawSparkles(dt){
   fx.clearRect(0,0,flung.clientWidth,flung.clientHeight);stir*=Math.exp(-dt*4.5);
   sparks=sparks.filter(p=>p.life>0);
   for(const p of sparks){p.life-=dt;p.vy+=40*dt;p.vx*=Math.exp(-dt*.65);p.x+=p.vx*dt;p.y+=p.vy*dt;p.angle+=dt*.5;
    const alpha=Math.max(0,p.life/p.maxLife);fx.save();fx.translate(p.x,p.y);fx.rotate(p.angle);fx.globalAlpha=alpha*.52;fx.fillStyle=p.gold?'#f3cf73':'#ffffff';
    const s=p.size*(.7+.3*alpha);fx.beginPath();fx.moveTo(0,-s*2.3);fx.lineTo(s*.45,-s*.45);fx.lineTo(s*2.3,0);fx.lineTo(s*.45,s*.45);fx.lineTo(0,s*2.3);fx.lineTo(-s*.45,s*.45);fx.lineTo(-s*2.3,0);fx.lineTo(-s*.45,-s*.45);fx.closePath();fx.fill();fx.restore();
   }
  }
  const bumps=[{x:.05,p:.3},{x:.23,p:2.4},{x:.44,p:4.5},{x:.64,p:1.2},{x:.83,p:3.4},{x:1.02,p:5.3}];
  let dropletClock=0,lastBirth=-2;
  const droplets=[.23,.64,.84].map((u,i)=>({u,age:i===0?.6:-i*1.15,wait:2.8+Math.random()*1.7,fall:null,releaseIn:null,x:0,y:0,gold:i===2}));
  function dropletEdge(d){const pts=d.gold?surface(-tick*.65*.8+2.2,.075,.94):surface(tick*.65);const x=width*d.u;return {x,y:pts[Math.min(pts.length-1,Math.round((x+4)/3))][1]};}
  function detach(d){const edge=dropletEdge(d);d.x=edge.x;d.y=edge.y+dropShape(d).length;d.fall=0;d.releaseIn=null;}
  function advanceDroplets(dt){dropletClock+=dt;for(const d of droplets){const oldAge=d.age;d.age+=dt;if(oldAge<0&&d.age>=0){if(dropletClock-lastBirth<.65){d.age=-.15;continue;}lastBirth=dropletClock;}if(d.fall===null){if(d.releaseIn!==null)d.releaseIn-=dt;if(d.age>=d.wait||(d.releaseIn!==null&&d.releaseIn<=0))detach(d);}else{d.fall+=dt;if(d.fall>1.25){d.fall=null;d.age=-.6-Math.random()*1.8;d.wait=2.8+Math.random()*1.7;d.u=Math.max(.1,Math.min(.9,d.u+(Math.random()-.5)*.06));}}}}
  function dropShape(d){const grow=Math.min(1,Math.max(0,d.age)/1.4),stretch=d.releaseIn!==null?.85:Math.max(0,1-(d.wait-d.age)/.65);return {base:5+7*grow,bulge:.7+3.4*grow,neck:2.4-1.7*stretch,length:2+10*grow+4*stretch};}
  // Match the wave's clockwise winding so overlapping roots add liquid rather than subtract holes.
  function attachedOutline(d,points,close){const {base,bulge,neck,length}=dropShape(d),x=width*d.u;const at=v=>points[Math.max(0,Math.min(points.length-1,Math.round((v+4)/3)))][1];const y=at(x),left=at(x-base),right=at(x+base);ctx.moveTo(x+base,right);ctx.bezierCurveTo(x+base*.45,right,x+neck,y+length*.36,x+neck,y+length*.58);ctx.bezierCurveTo(x+bulge*1.7,y+length*.8,x+bulge*1.25,y+length+5,x,y+length+5);ctx.bezierCurveTo(x-bulge*1.25,y+length+5,x-bulge*1.7,y+length*.8,x-neck,y+length*.58);ctx.bezierCurveTo(x-neck,y+length*.36,x-base*.45,left,x-base,left);if(close)ctx.closePath();}
  function joinDrops(points,gold){for(const d of droplets)if(d.gold===gold&&d.age>=0&&d.fall===null)attachedOutline(d,points,true);}
  function surface(t,shift=0,depth=1){
   const points=[];
   for(let x=-4;x<=width+4;x+=3){
    let y=5+2*Math.sin(x/61+t)+1.5*Math.sin(x/27-t*.7)+stir*(.5+.5*Math.sin(x/35+t*9));
    for(const b of bumps){
     const phase=t*.7+b.p,c=width*(b.x+shift)+Math.sin(t*.36+b.p)*16;
     const spread=width*(.042+.012*Math.sin(phase+.8));
     const swell=.5+.5*Math.sin(phase);
     const dx=(x-c)/spread;
     y+=state.reach*depth*(.28+.72*swell)*Math.exp(-dx*dx*.64);
     const shoulder=(x-c-spread*.8*Math.cos(phase*.7))/(spread*.55);
     y+=state.reach*depth*.23*(.55+.45*Math.sin(phase+1.6))*Math.exp(-shoulder*shoulder);
    }
    points.push([x,y]);
   }
   return points;
  }
  function trace(points){ctx.beginPath();ctx.moveTo(-4,0);ctx.lineTo(width+4,0);for(let i=points.length-1;i>=0;i--)ctx.lineTo(...points[i]);ctx.closePath();}
  function rim(points,color,gold=false){const active=droplets.filter(d=>d.gold===gold&&d.age>=0&&d.fall===null);ctx.beginPath();let gap=true;for(const [x,y] of points){if(active.some(d=>Math.abs(x-width*d.u)<dropShape(d).base)){gap=true;continue;}gap?ctx.moveTo(x,y-.6):ctx.lineTo(x,y-.6);gap=false;}for(const d of active)attachedOutline(d,points,false);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.stroke();}
  function draw(){
   ctx.clearRect(0,0,width,112);
   const t=tick*.65,points=surface(t),goldPoints=surface(-t*.8+2.2,.075,.94);
   // The amber layer moves independently behind the translucent white surface.
   trace(goldPoints);joinDrops(goldPoints,true);
   const gold=ctx.createLinearGradient(0,0,0,state.reach+8);gold.addColorStop(0,'#b28c42');gold.addColorStop(.45,'#dfb967');gold.addColorStop(1,'#f7dc94');ctx.fillStyle=gold;ctx.fill();rim(goldPoints,'#ffe8b3b3',true);
   trace(points);joinDrops(points,false);
   const fluid=ctx.createLinearGradient(0,0,0,state.reach+10);fluid.addColorStop(0,'#d9d9d8d9');fluid.addColorStop(.38,'#f2f1eee0');fluid.addColorStop(1,'#ffffffed');ctx.fillStyle=fluid;ctx.fill();
   ctx.save();ctx.clip();
   for(const b of [bumps[1],bumps[4]]){
    const x=width*b.x+Math.sin(t*.3+b.p)*23,y=10+Math.sin(t*.6+b.p)*5;
    const glow=ctx.createRadialGradient(x,y,1,x,y,52);glow.addColorStop(0,'#efd18788');glow.addColorStop(1,'#e9cc8200');ctx.fillStyle=glow;ctx.fillRect(x-54,0,108,90);
   }
   // Small mint reflections echo the interface without replacing the gold and white layers.
   for(const b of [bumps[0],bumps[3]]){
    const x=width*b.x+Math.sin(t*.34+b.p)*20,y=8+Math.sin(t*.5+b.p)*4;
    const mint=ctx.createRadialGradient(x,y,2,x,y,60);mint.addColorStop(0,'#a3f2cc99');mint.addColorStop(.5,'#a3f2cc42');mint.addColorStop(1,'#a3f2cc00');ctx.fillStyle=mint;ctx.fillRect(x-62,0,124,90);
   }
   ctx.restore();
   rim(points,'#ffffffb3');
   // Droplets swell on narrow necks, linger, then release on rebound or timeout.
   for(const d of droplets){
    if(d.age<0||d.fall===null)continue;
    const attached=d.fall===null,grow=attached?Math.min(1,d.age/1.1):1,edge=attached?dropletEdge(d):d;
    const c=edge.x,y=attached?edge.y+3+6*grow:d.y+16*d.fall+38*d.fall*d.fall,bulge=1.5+2.4*grow;
    ctx.globalAlpha=attached?.8:Math.max(0,1-d.fall/1.25)*.85;ctx.fillStyle=d.gold?'#e9cf89':'#fffefa';ctx.beginPath();
    ctx.moveTo(c-1,attached?edge.y-1:y-5);ctx.bezierCurveTo(c-1,y-2,c-bulge-1,y-1,c-bulge,y+3);ctx.bezierCurveTo(c-bulge,y+8,c+bulge,y+8,c+bulge,y+3);ctx.bezierCurveTo(c+bulge+1,y-1,c+1,y-2,c+1,attached?edge.y-1:y-5);ctx.closePath();ctx.fill();ctx.globalAlpha=1;
   }
  }

  size();refresh();
  return {host,refresh,dispose(){disposed=true;running=false;cancelAnimationFrame(frame);clearPull();listeners.forEach(off=>off());visibility.disconnect();resize.disconnect();mutation.disconnect();host.classList.remove('fluidRunning');}};
 }
 return {attach,stop,refresh};
})();
