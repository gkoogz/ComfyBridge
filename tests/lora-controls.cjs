const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>'',sliderTick:()=>{}});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=watchFrames=async()=>{};persist=()=>{};connected=true;
   catalog={models:['Pottery'],loras:['Glaze','Lighting'],samplers:['euler','euler_ancestral','dpmpp_2m'],videoSamplers:['euler','heun'],defaults:{image:{sampler:'euler',clipSkip:2},video:{loras:[{name:'turbo',strength:1}]}}};
   for(const kind of ['image','video']){state.settings[kind]={width:512,height:768,frames:40,fps:12,steps:4,cfg:5,denoise:1,scale:0,model:'Pottery',positive:'A pottery studio.',negative:'',loras:[{name:'Glaze',strength:3.25,clipStrength:.8,enabled:false},{name:'Lighting',strength:.12,enabled:true}],seed:'1',batch:1};state.inputs[kind]={};}
   navigate('image');
  });
  const fold=p.getByRole('button',{name:'LoRAs',exact:true});
  if(await fold.getAttribute('aria-expanded')==='false')await fold.click();
  const number=i=>p.locator('input[type=number][data-strength="'+i+'"]'),range=i=>p.locator('input[type=range][data-strength="'+i+'"]');
  assert.equal(await p.locator('[data-lora-name],.loraReorder').count(),0);
  assert.equal(await p.locator('.loraName').first().textContent(),'Glaze');
  assert.equal(await number(0).inputValue(),'3.25');assert.equal(await range(0).inputValue(),'2');
  assert.deepEqual(await p.locator('.loraMarks').first().locator('span').allTextContents(),['−1','0','1']);
  await number(0).fill('-3.125');await number(0).blur();assert.equal(await range(0).inputValue(),'-2');
  async function geometry(){
   const g=await p.locator('.lora').first().evaluate(row=>{
    const r=row.getBoundingClientRect(),x=row.querySelector('.loraRemove').getBoundingClientRect(),n=row.querySelector('input[type=number]').getBoundingClientRect(),a=row.querySelector('.seeListing').getBoundingClientRect(),svg=row.querySelector('.loraRemove svg').getBoundingClientRect();
    return {right:Math.abs(x.right-n.right),gutter:r.right-x.right,aligned:Math.abs(x.top-a.top),center:Math.abs(x.left+x.width/2-svg.left-svg.width/2)+Math.abs(x.top+x.height/2-svg.top-svg.height/2),overflow:row.scrollWidth>row.clientWidth};
   });
   assert(g.right<1,JSON.stringify(g));assert(g.gutter>=40,JSON.stringify(g));assert(g.aligned<1);assert(g.center<1);assert(!g.overflow);
  }
  await geometry();
  if(process.env.LORA_SHOT){await p.locator('.lora').first().scrollIntoViewIfNeeded();await p.screenshot({path:process.env.LORA_SHOT});}
  // Vertical touch on the slider still scrolls; horizontal thumb movement edits strength.
  const cdp=await context.newCDPSession(p);
  async function gesture(x,y,dx,dy){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let n=1;n<=10;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*n/10,y:y+dy*n/10}]});await p.waitForTimeout(16);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(100);}
  async function thumb(){await range(0).scrollIntoViewIfNeeded();return range(0).evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.left+9.5+(e.valueAsNumber+2)/4*(r.width-19),y:r.top+r.height/2};});}
  await number(0).fill('0');await number(0).blur();let t=await thumb();const before=await p.locator('#workspace').evaluate(e=>e.scrollTop);
  await gesture(t.x,t.y,2,-120);assert.equal(await number(0).inputValue(),'0');assert(await p.locator('#workspace').evaluate(e=>e.scrollTop)>before+20);
  t=await thumb();await gesture(t.x,t.y,45,1);assert(+await number(0).inputValue()>.4);
  await p.locator('[data-remove-lora="1"]').click();assert.equal(await p.locator('.lora').count(),1);
  await p.setViewportSize({width:1440,height:900});await geometry();
  await p.evaluate(()=>navigate('video'));if(await fold.getAttribute('aria-expanded')==='false')await fold.click();
  assert(await number(0).isDisabled());assert(await p.locator('[data-remove-lora="0"]').isDisabled());assert.equal(await p.locator('.loraReorder,select[data-lora-name]').count(),0);await geometry();
  assert.deepEqual(errors,[]);console.log('LoRA rows: plain names, no reorder/dropdown, aligned buttons and strength, empty scroll gutter, numeric override, touch scroll/adjust, mandatory locks and desktop layout passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
