// Exercise the actual Library footer and generators without submitting a job.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:370,height:740}});
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route('**/thumb/*',r=>r.fulfill({status:204}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  for(const kind of ['image','video']){
   await p.evaluate(kind=>{
    window.poll=window.heartbeat=window.syncSettings=async()=>{};window.persist=()=>{};
    connected=true;const canvas=document.createElement('canvas');canvas.width=64;canvas.height=96;
    const paint=canvas.getContext('2d');paint.fillStyle='white';paint.fillRect(0,0,32,96);
    const source=canvas.toDataURL();window.calls=[];
    window.api=async route=>{
     calls.push(route);
     if(route!=='studio/replay/original-job')throw Error('Unexpected API request');
     return {kind,settings:{width:64,height:96,scale:0,steps:5,cfg:1,denoise:.45,frames:7,exactFrames:true,fps:24,
      model:'test',positive:'saved prompt',negative:'saved negative',loras:[],seed:'18446744073709551615',batch:4},
      inputs:{data:source,...(kind==='image'?{mask:source}:{})}};
    };
    library=[{kind,job:'original-job',id:'item',archived:kind==='video',created:1}];
    navigate('library');archived=kind==='video';renderLibrary();
   },kind);
   await p.locator('.libraryitem').click();await p.getByRole('button',{name:'↗ Regenerate'}).click();
   await p.waitForFunction(kind=>page===kind&&!viewerOpen()&&!!$('#play'),kind);
   const result=await p.evaluate(()=>{
    const input=state.inputs[page];return [page,$('[data-setting=seed]').value,state.settings[page].positive,
     input.width,input.height,!!input.mask,state.settings[page].batch,...calls.filter(route=>!route.startsWith('studio/provenance/'))];
   });
   assert.deepEqual(result,[kind,'18446744073709551615','saved prompt',64,96,kind==='image',1,'studio/replay/original-job']);
  }
  console.log('Image and archived video opened their original editor, seed, source and mask without submitting.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
