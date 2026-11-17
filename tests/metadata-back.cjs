const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="390" height="600"><rect width="390" height="600" fill="#446688"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'fixture',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{heartbeat=poll=syncSettings=()=>{};connected=true;drawer(false);window.item={id:'1',type:'image',path:'model-preview/test',width:390,height:600,credit:'Potter',resources:[],parameters:{seed:123},prompt:'A neutral pottery scene. '.repeat(200),negativePrompt:'blur',generationDataAvailable:true,detailVersion:2};api=async()=>({account:'1',item,collections:[]});$('#main').innerHTML='<p>THE ORIGINAL SCREEN</p><div style="height:1900px;background:#334455">Previous feed</div>';$('#workspace').scrollTop=240;CivitaiBrowser.open(item,[item]);});
 await p.locator('.modelPreviewHero img').evaluate(el=>el.decode());await p.waitForTimeout(100);
 await p.locator('.civitaiViewerScroll').evaluate(el=>el.scrollTop=850);await p.waitForTimeout(70);
 const oldTop=await p.locator('#workspace').evaluate(el=>el.scrollTop);
 // Short drag springs back; the real previous workspace (not another feed) slides over.
 await p.mouse.move(30,350);await p.mouse.down();await p.mouse.move(92,352,{steps:5});
 assert(await p.locator('#workspace').evaluate(el=>el.classList.contains('mediaReturnSurface')));
 assert.equal(await p.locator('.civitaiViewer').evaluate(el=>el.getBoundingClientRect().x),0);
 assert.equal(await p.locator('#main').innerText().then(x=>x.startsWith('THE ORIGINAL SCREEN')),true);
 await p.waitForTimeout(250);await p.mouse.up();await p.waitForTimeout(220);assert.equal(await p.locator('.civitaiViewer').count(),1);
 assert.equal(await p.locator('.mediaReturnSurface').count(),0);
 // A committed metadata drag closes to the unchanged prior scroll position.
 await p.mouse.move(30,350);await p.mouse.down();await p.mouse.move(280,355,{steps:8});await p.mouse.up();await p.waitForSelector('.civitaiViewer',{state:'detached'});
 assert.equal(await p.locator('#workspace').evaluate(el=>el.scrollTop),oldTop);assert.equal(await p.locator('.mediaReturnSurface').count(),0);
 assert(!await p.locator('#drawer').evaluate(el=>el.classList.contains('open')));
 assert.deepEqual(errors,[]);console.log('Metadata right-drag: real previous screen overlays stationary viewer, short drag cancels, committed drag restores exact scroll without opening drawer.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
