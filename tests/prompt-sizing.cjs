const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:370,height:740}});
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   window.poll=window.heartbeat=window.syncSettings=async()=>{};window.persist=()=>{};
   for(const kind of ['image','video']){
    state.settings[kind]={width:256,height:384,scale:0,steps:4,cfg:1,denoise:1,frames:22,fps:24,
     model:'test',positive:'Long prompt. '.repeat(80),negative:'Avoid these. '.repeat(60),loras:[],seed:'1',batch:1};
   }
  });
  for(const kind of ['image','video']){
   await p.evaluate(kind=>navigate(kind),kind);
   for(const key of ['positive','negative']){
    const field=p.locator('textarea[data-setting='+key+']'),toggle=p.locator('[data-prompt-height='+key+']');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await field.evaluate(el=>el.offsetHeight),118);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert(await field.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    await toggle.click();
    assert.equal(await field.evaluate(el=>el.offsetHeight),118);
    await field.fill('New line\n'.repeat(18));
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert(await field.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    assert.equal(await field.evaluate(el=>getComputedStyle(el).resize),'vertical');
    await p.evaluate(()=>renderGenerator());
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   }
   await p.evaluate(()=>navigate('library'));
   await p.evaluate(kind=>navigate(kind),kind);
   assert.equal(await p.locator('[data-prompt-height=positive]').getAttribute('aria-expanded'),'false');
   assert.equal(await p.locator('textarea[data-setting=positive]').inputValue(),'New line\n'.repeat(18));
  }
  console.log('Both prompt fields grow, retain resize handles, toggle heights and return reduced after navigation.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
