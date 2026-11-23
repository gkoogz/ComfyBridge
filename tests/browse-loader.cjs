const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{const browser=await chromium.launch();try{
 for(const width of [390,1400]){
  const p=await browser.newPage({viewport:{width,height:650},hasTouch:width===390}),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  const source=fs.readFileSync(path.join(__dirname,'../android/assets/browse.js'),'utf8');
  const puller=source.split(/\r?\n/).find(line=>line.includes('function pullerHTML('));
  const markup=vm.runInNewContext(puller+'\npullerHTML()');
  await p.setContent('<style>body{margin:0;--mint:#a3f2cc;--muted:#9fb5a9;background:#0b1014}#workspace{height:650px;overflow:auto}.preceding{height:450px;background:#222a2c}.civitaiBrowse{padding:0!important}@keyframes spin{to{transform:rotate(360deg)}}</style><div id="workspace"><section class="civitaiBrowse"><div class="preceding"></div>'+markup+'</section></div>');
  await p.addStyleTag({path:path.join(__dirname,'../android/assets/browse.css')});
  await p.addScriptTag({path:path.join(__dirname,'../android/assets/browse-loader.js')});
  await p.evaluate(()=>{window.allowed=true;BrowseLoader.attach(document.querySelector('#browseMore'),document.querySelector('#workspace'),()=>allowed);});
  await p.locator('#workspace').evaluate(w=>w.scrollTop=w.scrollHeight);
  await p.waitForSelector('#browseMore.fluidRunning');await p.waitForTimeout(100);
  const geometry=()=>p.evaluate(()=>{const wave=document.querySelector('.browseFluid').getBoundingClientRect(),above=document.querySelector('.preceding').getBoundingClientRect(),spin=document.querySelector('.browseLoaderSpinner').getBoundingClientRect();return {edge:wave.top,gap:wave.top-above.bottom,spinner:spin.top,center:spin.top+spin.height/2};});
  const initial=await geometry();assert(Math.abs(initial.gap)<1);assert(Math.abs(initial.center-(650+initial.edge)/2)<2,'Spinner centers in the available area');
  const sparkCount=()=>p.locator('.browseFlung').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<data.length;i+=4)if(data[i])n++;return n;});
  const x=width/2,y=550;
  if(width===390){
   const cdp=await p.context().newCDPSession(p);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(const dy of [20,50,90,140])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-dy}]});
   await p.waitForTimeout(80);assert.equal(await sparkCount(),0,'No sparkles during upward drag');
   const pulled=await geometry();assert(pulled.edge<initial.edge-10);assert(Math.abs(pulled.gap)<1);assert(Math.abs(initial.spinner-pulled.spinner)<2,'Wave tug must not tug spinner');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  }else{
   await p.mouse.move(x,y);await p.mouse.wheel(0,150);await p.waitForTimeout(60);
   assert.equal(await sparkCount(),0);assert((await geometry()).edge<initial.edge-10);
  }
  await p.waitForTimeout(500);assert(await sparkCount()>0,'Rebound emits visible sparse sparkles');
  await p.waitForTimeout(1400);assert.equal(await sparkCount(),0,'Effects expire');assert(Math.abs((await geometry()).edge-initial.edge)<1);
  await p.locator('#workspace').evaluate(w=>w.scrollTop-=70);await p.waitForTimeout(100);assert(Math.abs((await geometry()).spinner-initial.spinner-35)<2,'Spinner follows the midpoint without a spring');
  await p.locator('.preceding').evaluate(el=>el.style.height='510px');await p.locator('#workspace').evaluate(w=>w.scrollTop=0);await p.waitForTimeout(220);assert((await geometry()).spinner>=650,'Under 150px available: spinner stows below screen');
  await p.locator('.preceding').evaluate(el=>el.style.height='470px');await p.waitForTimeout(220);assert(Math.abs((await geometry()).center-560)<2,'Over 150px: spinner returns to midpoint');
  const snapshot=()=>p.locator('.browseFluid').evaluate(c=>c.toDataURL());
  const before=await snapshot();await p.waitForTimeout(140);assert.notEqual(await snapshot(),before,'Visible fluid animates');
  await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(80);const reduced=await snapshot();await p.waitForTimeout(150);assert.equal(await snapshot(),reduced,'Reduced motion is static');
  await p.emulateMedia({reducedMotion:'no-preference'});await p.waitForTimeout(80);
  await p.evaluate(()=>{allowed=false;document.body.classList.add('viewer');});await p.waitForTimeout(80);const obscured=await snapshot();await p.waitForTimeout(150);assert.equal(await snapshot(),obscured,'Obscured loader stops');
  await p.evaluate(()=>{allowed=true;document.body.classList.remove('viewer');});await p.waitForTimeout(80);
  await p.locator('.preceding').evaluate(el=>el.style.height='2000px');await p.locator('#workspace').evaluate(w=>w.scrollTop=0);await p.waitForTimeout(100);const offscreen=await snapshot();await p.waitForTimeout(150);assert.equal(await snapshot(),offscreen,'Offscreen loader stops');
  await p.evaluate(()=>BrowseLoader.stop());assert.equal(await p.locator('#browseMore.fluidRunning').count(),0);
  assert.deepEqual(errors,[]);await p.close();
 }
 console.log('Liquid loader: touch/wheel rebound, attached waves, midpoint spinner and 150px stowing, sparse settling sparks, reduced motion and offscreen/overlay disposal passed on phone/desktop.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
