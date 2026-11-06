const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/local/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200" fill="green"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'test',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=syncNotes=syncShelf=()=>{};connected=true;initProvenance=()=>{};notice=()=>{};
  const canvas=document.createElement('canvas');canvas.width=100;canvas.height=200;window.cover=canvas.toDataURL();
  library=[{id:'one',job:'j1',kind:'image',local:'h1',created:3,rating:0},{id:'two',job:'j2',kind:'video',local:'h2',created:2,rating:0},{id:'three',job:'j3',kind:'image',local:'h3',created:1,rating:0}];
  window.calls=[];api=async(route,body)=>{calls.push({route,body});if(route==='studio/rating')return body;throw Error(route);};
  page='library';render();openMedia(library[1]);
 });
 await p.waitForSelector('.bigPlay');await p.waitForTimeout(400);
 assert((await p.locator('#workspace').boundingBox()).x<=-389,'Collection starts off-screen');
 assert.equal(await p.locator('.viewerTop .mediaRating button').count(),5);
 await p.locator('.viewerTop [data-rating="4"]').click();
 assert.equal(await p.locator('.mediaRating [aria-pressed=true]').count(),1);
 assert.equal(await p.evaluate(()=>library[1].rating),4);
 await p.locator('.viewerTop [data-rating="4"]').click();assert.equal(await p.locator('.mediaRating [aria-pressed=true]').count(),0);
 const geometry=await p.evaluate(()=>{
  const v=$('#viewer video');Object.defineProperty(v,'videoWidth',{value:100,configurable:true});Object.defineProperty(v,'videoHeight',{value:300,configurable:true});v.dispatchEvent(new Event('loadedmetadata'));
  const a=$('.transport').getBoundingClientRect(),b=$('.transportPlay').getBoundingClientRect(),c=$('.bigPlay').getBoundingClientRect(),r=v.getBoundingClientRect();
  const h=Math.min(r.height,r.width*3),w=h/3;
  return {circle:Math.abs(b.width-b.height),big:Math.abs(c.width-c.height),left:a.left,expectedLeft:r.left+(r.width-w)/2,bottom:a.bottom,expectedBottom:r.top+(r.height+h)/2};
 });
 if(process.env.MEDIA_SHOT)await p.screenshot({path:process.env.MEDIA_SHOT});
 assert(geometry.circle<1&&geometry.big<1);assert(Math.abs(geometry.left-geometry.expectedLeft)<2);assert(Math.abs(geometry.bottom-geometry.expectedBottom)<2);
 assert.equal(await p.locator('.viewerNavigation').count(),0);
 await p.locator('#viewer video').click({position:{x:375,y:250}});assert.equal(await p.locator('#viewer').getAttribute('data-id'),'three');
 await p.locator('#viewer .original').click({position:{x:15,y:250}});assert.equal(await p.locator('#viewer').getAttribute('data-id'),'two');
 await p.mouse.move(65,300);await p.mouse.down();await p.mouse.move(225,300,{steps:12});
 const during=await p.evaluate(()=>({view:$('#viewer').getBoundingClientRect().left,library:$('#workspace').getBoundingClientRect().left}));
 assert.equal(during.view,0);assert(during.library<0&&during.library>-390);
 await p.mouse.up();await p.waitForTimeout(300);assert(await p.locator('#viewer').isHidden());
 await p.evaluate(()=>{page='video';$('#main').innerHTML='<div id="result"></div>';mountResult(library[1]);});
 assert.equal(await p.locator('#result .mediaRating button').count(),5);
 await p.locator('#result [data-rating="5"]').click();assert.equal(await p.evaluate(()=>library[1].rating),5);
 assert.deepEqual(errors,[]);console.log('Ratings, clear selection, both surfaces, player geometry, edge-tap paging without chevrons and stationary-media back swipe passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
