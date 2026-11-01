const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{const b=await chromium.connectOverCDP(process.env.WEBVIEW_CDP || 'http://127.0.0.1:9223');try{
 const ctx=b.contexts()[0],p=ctx.pages().find(p=>p.url().includes('appassets')),cdp=await ctx.newCDPSession(p);
 p.on('pageerror',e=>console.error('PAGE ERROR',e.message));
 const ev=(fn,arg)=>p.evaluate(fn,arg),check=(name,result)=>{console.log(name,result);assert.ok(result,name);};
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function drag(a,z,y,during){
  const touch=(type,x)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:x==null?[]:[{x,y}]});
  await touch('touchStart',a);for(let i=1;i<=5;i++){await touch('touchMove',a+(z-a)*i/5);await wait(25);if(i===3&&during)await during();}
  await touch('touchEnd');await wait(360);
 }
 await ev(()=>navigate('bridge'));await wait(250);
 console.log('Device fixtures',await ev(()=>({viewport:[innerWidth,innerHeight],items:library.length,images:library.filter(j=>j.kind==='image'&&j.local).length,videos:library.filter(j=>j.kind==='video'&&j.local).length,paired:info().paired})));
 check('Initial Bridge fits',await ev(()=>$('#workspace').scrollHeight===$('#workspace').clientHeight));
 if(!await ev(()=>connected)){await p.locator('#connect').click();await p.waitForFunction(()=>connected,{},{timeout:25000});}
 await p.waitForFunction(()=>!!catalog,{},{timeout:90000});
 check('Bridge fits when connected',await ev(()=>$('#workspace').scrollHeight===$('#workspace').clientHeight));
 await p.locator('[data-open="video"]').click();await wait(300);
 await ev(()=>navigate('library'));await wait(200);
 const kind=async k=>{await ev(k=>{let j=library.find(x=>x.kind===k&&x.local);if(!j)throw Error('No local '+k);archived=!!j.archived;renderLibrary();const tile=$('[data-media="'+j.id+'"]');tile.scrollIntoView({block:'nearest'});window.testGrid=$('.librarygrid');window.testScroll=$('#workspace').scrollTop;tile.click();},k);};
 console.log('grid',await ev(()=>{const g=$('.librarygrid').getBoundingClientRect();return [g.x,g.right,g.top,innerWidth]}));
 check('tiles at first/last pixel',await ev(()=>{const g=$('.librarygrid').getBoundingClientRect();return g.x===0&&Math.abs(g.right-innerWidth)<0.51&&g.top<=105;}));
 await kind('image');await p.waitForFunction(()=>$('#viewer .original')?.naturalWidth>0);check('image fitted',await ev(()=>getComputedStyle($('#viewer .original')).objectFit==='contain'&&$('#viewer .original').clientWidth===innerWidth));
 await drag(35,Math.round(await ev(()=>innerWidth*.85)),325,async()=>{check('both mounted pages follow finger',await ev(()=>$('#viewer').getBoundingClientRect().x>0&&$('#workspace').getBoundingClientRect().x<0&&$('#workspace').getBoundingClientRect().right>0));});
 check('back preserves grid and scroll',await ev(()=>!viewerOpen()&&window.testGrid===$('.librarygrid')&&window.testScroll===$('#workspace').scrollTop));
 await kind('video');await p.locator('#viewer .bigPlay').click();
 await p.waitForFunction(()=>$('#viewer video')?.currentTime>.12,{},{timeout:10000});
 check('inline video advances, actions hide',await ev(()=>$('#viewer').classList.contains('quiet')&&$('#viewer video').currentTime>0&&!document.fullscreenElement));
 await ev(()=>{const v=$('#viewer video');v.pause();v.currentTime=v.duration*.55;});await wait(300);
 check('seek works and actions return',await ev(()=>{const v=$('#viewer video');return Math.abs(v.currentTime/v.duration-.55)<.08&&!$('#viewer').classList.contains('quiet');}));
 await ev(()=>bridgeBack());await wait(360);
 await ev(()=>{archived=false;renderLibrary()});await drag(40,260,330);
 check('swipe opens root drawer',await ev(()=>$('#drawer').classList.contains('open')));
 await ev(()=>{drawer(false);navigate('video');});await wait(220);
 const z=await ev(()=>{const r=$('#result').getBoundingClientRect();return {x:r.x,right:r.right,width:innerWidth,video:!!$('#result video')}});
 console.log('latest video',z);check('edge-to-edge Latest',Math.abs(z.x)<0.51&&Math.abs(z.right-z.width)<0.51);
 if(z.video){await ev(()=>$('#result').scrollIntoView());await p.locator('#result .bigPlay').click();await p.waitForFunction(()=>$('#result video')?.currentTime>.1);check('Latest plays across refresh',await ev(()=>{const v=$('#result video');renderResults();return $('#result video')===v&&v.currentTime>0&&!viewerOpen();}));}
 await ev(()=>navigate('image'));check('image Latest flush',await ev(()=>{const r=$('#result').getBoundingClientRect();return Math.abs(r.x)<0.51&&Math.abs(r.right-innerWidth)<0.51;}));
 await ev(()=>navigate('bridge'));
 }finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1;});
