const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const p=await context.newPage(),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>'',sliderTick:()=>window.ticks=(window.ticks||0)+1});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=()=>{};persist=()=>{};connected=true;
   catalog={models:['Pottery'],loras:['Glaze','Lighting','Watercolor'],defaults:{video:{loras:[{name:'turbo',strength:1}]}}};
   state.settings.image={width:512,height:768,steps:4,cfg:5,denoise:1,model:'Pottery',positive:'A pottery studio.',negative:'',loras:[{name:'Glaze',strength:3.25,clipStrength:.8,enabled:false},{name:'Lighting',strength:.12,enabled:true},{name:'Watercolor',strength:1,enabled:true}],seed:'1',batch:1};
   navigate('image');
  });
  const fold=p.getByRole('button',{name:'LoRAs',exact:true});
  if(await fold.getAttribute('aria-expanded')==='false')await fold.click();
  const number=i=>p.locator('input[type=number][data-strength="'+i+'"]'),range=i=>p.locator('input[type=range][data-strength="'+i+'"]');
  assert.equal(await range(0).getAttribute('min'),'-2');assert.equal(await range(0).getAttribute('max'),'2');
  assert.equal(await range(0).getAttribute('step'),'.1');assert.equal(await number(0).inputValue(),'3.25');
  assert.equal(await range(0).inputValue(),'2');
  assert.deepEqual(await p.locator('.loraMarks').first().locator('span').allTextContents(),['−1','0','1']);
  await p.locator('[data-move-lora="0"][data-direction="1"]').click();
  assert.deepEqual(await p.evaluate(()=>state.settings.image.loras.slice(0,2)),[{name:'Lighting',strength:.12,enabled:true},{name:'Glaze',strength:3.25,clipStrength:.8,enabled:false}]);
  await number(0).fill('-3.125');await number(0).blur();await p.evaluate(()=>renderLoras());
  assert.equal(await number(0).inputValue(),'-3.125');assert.equal(await range(0).inputValue(),'-2');
  await number(0).fill('.12');await range(0).focus();await range(0).press('ArrowRight');
  assert.equal(await number(0).inputValue(),'0.2');
  await p.locator('[data-remove-lora="1"]').click();
  assert.deepEqual(await p.evaluate(()=>state.settings.image.loras.map(l=>l.name)),['Lighting','Watercolor']);
  async function geometry(){
   const result=await p.locator('.lora').first().evaluate(row=>{
    const r=row.getBoundingClientRect(),s=row.querySelector('input[type=range]').getBoundingClientRect(),a=row.querySelector('.loraActions').getBoundingClientRect(),button=row.querySelector('.loraRemove'),style=getComputedStyle(button);
    return {ratio:s.width/(r.width-parseFloat(getComputedStyle(row).paddingLeft)-parseFloat(getComputedStyle(row).paddingRight)-2),overlap:s.right>a.left,border:style.borderStyle,width:parseFloat(style.borderWidth),overflow:row.scrollWidth>row.clientWidth};
   });
   assert(Math.abs(result.ratio-.6)<.01,JSON.stringify(result));assert(!result.overlap);assert(!result.overflow);assert.equal(result.border,'solid');assert(result.width>=1);
  }
  await geometry();
  // Trusted browser touch events exercise actual scroll-vs-range arbitration.
  const cdp=await context.newCDPSession(p);
  async function gesture(x,y,dx,dy){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let n=1;n<=10;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*n/10,y:y+dy*n/10}]});await p.waitForTimeout(16);}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(100);
  }
  async function thumb(){
   await range(0).scrollIntoViewIfNeeded();
   return range(0).evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.left+9.5+(e.valueAsNumber+2)/4*(r.width-19),y:r.top+r.height/2,left:r.left,width:r.width};});
  }
  await number(0).fill('0');await number(0).blur();let t=await thumb();
  const beforeScroll=await p.locator('#workspace').evaluate(e=>e.scrollTop);
  await gesture(t.x,t.y,2,-120);
  assert.equal(await number(0).inputValue(),'0','Vertical swipe must not edit strength');
  assert(await p.locator('#workspace').evaluate(e=>e.scrollTop)>beforeScroll+20,'Vertical swipe on thumb scrolls workspace');
  t=await thumb();await gesture(t.left+18,t.y,0,0);
  assert.equal(await number(0).inputValue(),'0','Track tap must not jump strength');
  t=await thumb();await gesture(t.x,t.y,45,1);
  assert(+await number(0).inputValue()>.4,'Horizontal thumb drag changes strength');
  assert(Number.isInteger(Math.round(+await number(0).inputValue()*100)/10),'Touch drag snaps to tenths');
  assert(await p.evaluate(()=>ticks)>0,'Touch drag provides haptic feedback');
  assert(!await p.locator('#drawer').evaluate(e=>e.classList.contains('open')),'Slider drag must not open sidebar');
  await p.setViewportSize({width:1440,height:900});await geometry();
  const rail=await range(0).boundingBox();await p.mouse.click(rail.x+rail.width-12,rail.y+rail.height/2);
  assert(+await number(0).inputValue()>1.5,'Mouse track click remains usable');
  if(process.env.LORA_SHOT)await p.screenshot({path:process.env.LORA_SHOT});
  await p.evaluate(()=>{
   state.settings.video={...structuredClone(state.settings.image),model:'standard',frames:40,fps:12,scale:0,loras:[{name:'Lighting',strength:.5,enabled:true},{name:'Watercolor',strength:.8,enabled:true}]};
   navigate('video');
  });
  if(await fold.getAttribute('aria-expanded')==='false')await fold.click();
  assert.equal(await number(0).isDisabled(),true);
  assert.equal(await p.locator('[data-remove-lora="0"]').isDisabled(),true);
  assert.equal(await p.locator('[data-move-lora="1"][data-direction="-1"]').isDisabled(),true);
  await p.locator('[data-move-lora="2"][data-direction="-1"]').click();
  assert.deepEqual(await p.evaluate(()=>state.settings.video.loras.map(l=>l.name)),['turbo','Watercolor','Lighting']);
  assert.equal(await number(0).inputValue(),'1');
  assert.deepEqual(errors,[]);
  console.log('LoRA controls: narrow marked slider, precise override, full-object reorder, mandatory lock, outlined removal, mobile/desktop layout, touch scroll safety and haptics passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
