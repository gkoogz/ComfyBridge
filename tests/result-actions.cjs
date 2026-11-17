const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route(/\/(local|thumb)\//,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="96"/>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=watchFrames=syncShelf=async()=>{};persist=()=>{};connected=true;queueProtocol=20;
  for(const kind of ['image','video']){state.settings[kind]={width:64,height:96,frames:40,fps:12,steps:4,cfg:5,denoise:1,scale:0,model:'fixture',positive:'A pottery studio.',negative:'',loras:[],seed:'1',batch:1};state.inputs[kind]={};}
  window.calls=[];window.local=async(op,args)=>{calls.push({op,args});return true;};
  restoreGeneration=async id=>calls.push({op:'regenerate',id});
  readStartingImage=async()=>({data:'data:image/png;base64,fixture',width:64,height:96});
  window.fetch=async()=>({ok:true,blob:async()=>new Blob()});
  api=async(route,body)=>{calls.push({route,body});if(route.startsWith('extension/'))return{clip:{id:'clip',width:64,height:96,fps:12,frames:40,revision:'r'}};return{};};
  activateExtension=()=>calls.push({op:'extend'});
  library=[{id:'image',job:'image-job',kind:'image',local:'hash',source:'available'},{id:'video',job:'video-job',kind:'video',local:'hash',source:'available'}];
  navigate('image');mountAsset=()=>{};window.showResult=kind=>{page=kind;$('#result').replaceChildren();mountResult(library.find(i=>i.kind===kind));};showResult('image');
 });
 for(const width of [390,320,1440]){
  await p.setViewportSize({width,height:844});
  for(const kind of ['image','video']){
   await p.evaluate(kind=>showResult(kind),kind);await p.waitForTimeout(40);
   const g=await p.locator('#result').evaluate(box=>{const row=box.querySelector('.resultActions'),buttons=[...row.querySelectorAll('button')],last=buttons.at(-1).getBoundingClientRect();return{right:box.getBoundingClientRect().right,last:last.right,tops:buttons.map(b=>b.getBoundingClientRect().top),radius:buttons.map(b=>getComputedStyle(b).borderRadius),width:row.clientWidth};});
   assert(Math.abs(g.right-g.last)<1,JSON.stringify(g));assert.equal(new Set(g.tops).size,1);assert.equal(new Set(g.radius).size,1);
   await p.getByRole('button',{name:'Save to camera roll',exact:true}).click();
   await p.locator('#result .regenerate').click();
  }
 }
 await p.evaluate(()=>showResult('image'));await p.getByRole('button',{name:'Send to i2i',exact:true}).click();
 assert.equal(await p.evaluate(()=>state.settings.image.sourceMedia),'image');
 await p.evaluate(()=>showResult('video'));await p.getByRole('button',{name:'Extend video',exact:true}).click();
 assert(await p.evaluate(()=>calls.some(c=>c.op==='extend')));
 const calls=await p.evaluate(()=>window.calls);assert(calls.some(c=>c.op==='export'&&c.args.id==='image'));assert(calls.some(c=>c.op==='export'&&c.args.id==='video'));assert(calls.some(c=>c.op==='regenerate'&&c.id==='image-job'));assert(calls.some(c=>c.op==='regenerate'&&c.id==='video-job'));
 await p.evaluate(()=>{window.Desktop={};showResult('image');});await p.getByRole('button',{name:'Open file location',exact:true}).click();assert(await p.evaluate(()=>calls.some(c=>c.op==='reveal'&&c.args.id==='image')));
 assert.deepEqual(errors,[]);console.log('Latest Result: flush right at 320/390/1440 widths, one row, shared Library export, image/video regenerate, i2i, extend, desktop reveal and matching corners passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
