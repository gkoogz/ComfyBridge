// Use a debug WebView with the bridge disconnected. No generation or PC writes.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.WEBVIEW_CDP||'http://127.0.0.1:9223');
 const p=browser.contexts()[0].pages().find(p=>p.url().includes('appassets'));
 const ev=(fn,arg)=>p.evaluate(fn,arg);
 const check=(name,value)=>{assert.ok(value,name);console.log(name);};
 const storage=await ev(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('fold:'))));
 try{
  await p.waitForSelector('#main #connect');
  await ev(()=>{
   if(connected||wanted)throw Error('Disconnect before running the generator UI test');
   window.persist=()=>{};
   for(const k of Object.keys(localStorage))if(k.startsWith('fold:'))localStorage.removeItem(k);
   const image={width:1024,height:1536,seed:'123',steps:100,cfg:4,denoise:1,batch:1,positive:'',negative:'',model:'test',loras:[{name:'extra',strength:.5,enabled:true}]};
   state.settings={image,video:{...structuredClone(image),frames:40,fps:12,scale:0,loras:[{name:'turbo',locked:true,enabled:true,strength:1}]}};
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=96;
   const src={data:canvas.toDataURL(),width:1024,height:1536};
   state.inputs={image:structuredClone(src),video:structuredClone(src)};jobs=[];queueHistory=[];library=[];navigate('image');
  });
  const fold=name=>p.getByRole('button',{name,exact:true});
  check('All eight Image panels fold',await p.locator('.foldToggle').count()===8);
  check('Wider prompts with compact gutters',await ev(()=>$('textarea[data-setting=positive]').getBoundingClientRect().width>=innerWidth-38));
  check('Starting image dimensions and ratio visible',await p.locator('.sourceDims').innerText().then(t=>t.includes('1024 × 1536')&&t.includes('2:3')));
  await p.locator('#linkAspect').click();
  const width=p.locator('[data-setting=width]'),height=p.locator('[data-setting=height]');
  await width.fill('768');check('Width scales locked height',await height.inputValue()==='1152');
  await height.fill('960');check('Height scales locked width',await width.inputValue()==='640');
  await width.fill('641');await width.blur();await height.fill('960');check('Rounding does not drift',await width.inputValue()==='640');
  await p.locator('#linkAspect').click();await height.fill('900');await height.blur();
  check('Unlocked dimension stays independent',await width.inputValue()==='640');
  check('Current aspect ratio updates',await p.locator('#canvasRatio').innerText()==='32:45');
  await p.locator('#linkAspect').click();
  await ev(async()=>{
   const source=document.createElement('canvas');source.width=800;source.height=600;
   const blob=await new Promise(done=>source.toBlob(done));
   await loadImage(new File([blob],'fixture.png',{type:'image/png'}));
  });
  await width.fill('400');
  check('A new source resets a linked canvas to its actual ratio',await height.inputValue()==='300');
  await fold('LoRAs').click();const precise=p.locator('input[type=number][data-strength="0"]'),slider=p.locator('input[type=range][data-strength="0"]');
  await precise.fill('0.12');await precise.blur();
  check('Typed LoRA precision is retained',await ev(()=>state.settings.image.loras[0].strength===.12));
  await slider.focus();await slider.press('ArrowRight');
  check('Slider snaps to tenths',await precise.inputValue()==='0.2');
  await fold('LoRAs').click();
  await fold('Positive prompt').click();await ev(()=>renderGenerator());
  check('Fold state survives redraw',await fold('Positive prompt').getAttribute('aria-expanded')==='false');
  check('Image drafts and slider allow 50 steps',await ev(()=>state.settings.image.steps===50&&$('[data-setting=steps]').max==='50'));
  const steps=p.locator('input[type=number][data-setting=steps]');await steps.fill('85');await steps.blur();
  check('Typed image steps capped at 50',await steps.inputValue()==='50');
  await ev(()=>navigate('video'));check('Seven Video panels fold',await p.locator('.foldToggle').count()===7);
  check('Video drafts and slider stay capped at 20',await ev(()=>state.settings.video.steps===20&&$('[data-setting=steps]').max==='20'));
  await steps.fill('50');await steps.blur();check('Typed video steps capped at 20',await steps.inputValue()==='20');
  check('Fold choices are separate by generator',await fold('Positive prompt').getAttribute('aria-expanded')==='true');
  const track=p.locator('#videoScale');check('Most of scale is under budget',await track.evaluate(e=>parseFloat(e.style.getPropertyValue('--safe-stop'))>=80));
  await track.focus();await track.press('Home');
  check('Scale updates actual rounded resolution and ratio',await ev(()=>{const s=state.settings.video;return $('#resolutionInfo').innerText.includes(s.width+' × '+s.height)&&$('#resolutionInfo').innerText.includes(aspect(s.width,s.height))&&s.width%32===0&&s.height%32===0;}));
  await p.locator('#originalScale').click();
  check('Original dimensions remain available',await p.locator('#resolutionInfo').innerText().then(t=>t.includes('1024 × 1536')&&t.includes('Above pixel budget')));
  check('Actual video duration is emphasized',await p.locator('#durationInfo strong').innerText()==='4.67 s');
  check('Duration calculation is visible',await p.locator('#durationInfo span').innerText()==='56 actual frames ÷ 12 FPS');
  await fold('LoRAs').click();check('Mandatory video strength stays locked',await p.locator('[data-strength="0"]').first().isDisabled());
  await fold('Latest result').click();check('Latest result can be collapsed',await p.locator('#result').isHidden());
 }finally{
  await ev(saved=>{for(const k of Object.keys(localStorage))if(k.startsWith('fold:'))localStorage.removeItem(k);for(const [k,v] of Object.entries(saved))localStorage.setItem(k,v);},storage);
  await p.reload();await browser.close();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
