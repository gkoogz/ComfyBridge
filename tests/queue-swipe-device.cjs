// Requires an attached debug WebView, paired PC and more than five queue entries.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.WEBVIEW_CDP||'http://127.0.0.1:9223');
 const ctx=browser.contexts()[0],p=ctx.pages().find(p=>p.url().includes('appassets'));
 const input=await ctx.newCDPSession(p),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function swipe(x,y,dx,dy,mid){
  const touch=(type,at)=>input.send('Input.dispatchTouchEvent',{type,touchPoints:at?[at]:[]});
  await touch('touchStart',{x,y});
  for(let i=1;i<=6;i++){
   await touch('touchMove',{x:x+dx*i/6,y:y+dy*i/6});
   if(i===3&&mid)await mid();
   await sleep(30);
  }
  await sleep(150);await touch('touchEnd');await sleep(320);
 }
 const saved=await p.evaluate(()=>Object.fromEntries(['image','video'].map(k=>[k,localStorage.getItem('fold:'+k+':PC Queue')])));
 try{
  await p.evaluate(()=>navigate('bridge'));
  if(!await p.evaluate(()=>connected||wanted))await p.locator('#connect').click();
  await p.waitForFunction(()=>connected&&queueHistory.length>5,null,{timeout:90000});
  for(const kind of ['bridge','image','video']){
   await p.evaluate(k=>navigate(k),kind);
   if(kind!=='bridge'){
    const toggle=p.locator('.historyCard .foldToggle');
    if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
   }
   const rows=p.locator('.queueRows');
   const pos=await rows.evaluate(el=>{
    if(page!=='bridge')el.scrollIntoView({block:'center'});
    el.scrollTop=0;const r=el.getBoundingClientRect();
    return {x:r.x+60,y:r.top+r.height*.7};
   });
   const outer=await p.evaluate(()=>$('#workspace').scrollTop);
   await swipe(pos.x,pos.y,3,-72);
   assert(await rows.evaluate(el=>el.scrollTop>35));
   assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
   assert(Math.abs(outer-await p.evaluate(()=>$('#workspace').scrollTop))<2);
   const thumb=await rows.evaluate(el=>{
    const r=el.getBoundingClientRect();
    const hit=[...el.querySelectorAll('.jobThumb')].map(t=>t.getBoundingClientRect()).find(b=>b.top>r.top+2&&b.bottom<r.bottom-2);
    return {x:hit.left+hit.width/2,y:hit.top+hit.height/2,scroll:el.scrollTop};
   });
   await swipe(thumb.x,thumb.y,180,4,async()=>{
    const left=await p.locator('#drawer').evaluate(e=>e.getBoundingClientRect().left);
    assert(left<0&&left> -265,'drawer should track the finger midway');
   });
   assert(await p.evaluate(()=>$('#drawer').classList.contains('open')&&!viewerOpen()));
   assert.equal(await p.evaluate(()=>page),kind);
   assert(Math.abs(await rows.evaluate(e=>e.scrollTop)-thumb.scroll)<2);
   await swipe(205,270,-165,2);
   assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
   console.log(kind+': queue swipes scroll vertically, open and stow the sidebar, and keep the original row position.');
  }
 }finally{
  await p.evaluate(s=>{for(const [k,v] of Object.entries(s)){const key='fold:'+k+':PC Queue';if(v===null)localStorage.removeItem(key);else localStorage.setItem(key,v);}drawer(false);navigate('bridge');},saved);
  await browser.close();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
