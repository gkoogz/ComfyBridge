const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch();try{for(const width of [320,390,1400]){
 const p=await browser.newPage({viewport:{width,height:900},hasTouch:width<500}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#527c78"/></svg>'}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({paired:false,device:'metadata'}),notificationRoute:()=>'',copyText:t=>window.copied=t});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{
  heartbeat=poll=syncSettings=()=>{};connected=true;
  window.fixture={id:'1',creatorId:'7',credit:'Clay Studio',chosenBy:{kind:'creator',id:'7'},type:'image',width:400,height:300,path:'model-preview/browse/1/1/thumb',fullPath:'model-preview/browse/1/1/full',prompt:'A handmade ceramic vase in a sunlit studio.',negativePrompt:'blur, artifacts',detailVersion:2,generationDataAvailable:true,resources:[{name:'Ceramic Model',type:'Checkpoint',version:'Version 3',modelId:'10',versionId:'20'},...Array.from({length:4},(_,i)=>({name:'Glaze texture '+(i+1),type:'LORA',modelId:String(i+30),versionId:String(i+40),version:'v2.0',weight:.5+i*.1}))],parameters:{Seed:'123456789012345',Steps:24,Sampler:'Euler',CFG:7,Size:'768 × 1024',Clip:2},tags:[{id:1,name:'ceramics',weight:10},{id:2,name:'handcrafted',weight:5},{id:3,name:'soft lighting',weight:5}],collections:[],stats:{},reactions:[]};
  api=async(route,body)=>{
   if(route==='browse/status')return {account:'1',username:'Example',collections:[{id:4,name:'Ceramic inspiration',count:3},{id:5,name:'Color studies',count:2}],followingIds:[],bans:[],importState:{complete:true}};
   if(route==='browse/feed')return {account:'1',items:[structuredClone(fixture)],nextCursor:null};
   if(route.startsWith('browse/detail/'))return {account:'1',item:structuredClone(fixture)};
   if(route==='lora-download/status')return {};
   return {};
  };navigate('browse');
 });
 await p.waitForSelector('.browseTile:visible');await p.locator('.browseTile .browseMedia').click();await p.waitForSelector('.civitaiTag');
 await p.locator('.modelPreviewDetails').evaluate(el=>el.closest('.modelPreviewViewer').scrollTop=el.offsetTop);
 await p.waitForTimeout(120);
 const dimensions=await p.evaluate(()=>{
  const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
  return {name:rect('.creatorName.chosenSource'),follow:rect('.viewerFollow'),copy:rect('.promptCopy'),title:rect('.civitaiPromptHeading h2'),vote:rect('[data-vote]'),resource:rect('.civitaiResources li:nth-child(2)'),params:[...document.querySelectorAll('.modelParameter')].map(el=>el.getBoundingClientRect().toJSON()),overflow:document.querySelector('.modelPreviewDetails').scrollWidth>document.querySelector('.modelPreviewDetails').clientWidth};
 });
 assert.equal(dimensions.name.height,dimensions.follow.height);assert(Math.abs(dimensions.name.y-dimensions.follow.y)<1);
 assert.deepEqual(await p.locator('.modelPreviewDetails h2').allTextContents(),['Positive prompt','Negative prompt','Resources','Tags with algorithm weight']);
 assert(await p.locator('.modelPreviewDetails h2').evaluateAll(hs=>hs.every(h=>parseFloat(getComputedStyle(h).paddingLeft)===9)));
 assert(Math.abs(dimensions.copy.y+dimensions.copy.height/2-dimensions.title.y-dimensions.title.height/2)<1);
 assert.equal(dimensions.vote.height,34);assert.equal(dimensions.vote.width,32);assert(dimensions.resource.height<70);
 assert.equal(dimensions.params[0].y,dimensions.params[1].y);assert(dimensions.params[1].x>dimensions.params[0].x);assert(!dimensions.overflow);
 assert.equal(await p.locator('.resourceMeta').nth(1).textContent(),'v2.0·Strength 0.5');
 await p.locator('[data-copy-prompt=prompt]').click();assert.equal(await p.evaluate(()=>copied),'A handmade ceramic vase in a sunlit studio.');
 await p.locator('[data-copy-prompt=negativePrompt]').click();assert.equal(await p.evaluate(()=>copied),'blur, artifacts');
 assert.equal(await p.locator('.viewerFollow').evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)');
 await p.locator('.viewerFollow').click();assert.equal(await p.locator('.viewerFollow').evaluate(e=>getComputedStyle(e).color),'rgb(163, 242, 204)');
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'metadata-'+width+'.png')});
 await p.locator('.viewerCollect').click();await p.waitForSelector('.feedCollectionChoices label');
 assert(await p.locator('.newCollection').evaluate(e=>e.parentElement.classList.contains('collectionHeading')));
 const choice=await p.locator('.feedCollectionChoices label').first().boundingBox();assert(choice.height>=50);
 await p.locator('.feedCollectionChoices label').first().click({position:{x:choice.width-12,y:25}});assert(await p.locator('.feedCollectionChoices input').first().isChecked(),'Whole shaded row toggles membership');
 // Tap the row edges and text, then drag slightly: the drawer must never capture it.
 const box=p.locator('.feedCollectionChoices input').first();
 for(const [x,y] of [[choice.x+choice.width-3,choice.y+3],[choice.x+60,choice.y+25]]){
  const was=await box.isChecked();if(width<500)await p.touchscreen.tap(x,y);else await p.mouse.click(x,y);
  assert.equal(await box.isChecked(),!was,'A row tap toggles exactly once');
 }
 await p.mouse.move(choice.x+choice.width-35,choice.y+25);await p.mouse.down();await p.mouse.move(choice.x+choice.width-20,choice.y+25,{steps:3});await p.mouse.up();
 assert.equal(await p.locator('#drawer').evaluate(e=>e.classList.contains('open')),false);
 await box.focus();const checked=await box.isChecked();await p.keyboard.press('Space');assert.equal(await box.isChecked(),!checked);
 assert(await p.locator('.feedCollectionShade>section').evaluate(e=>e.scrollWidth<=e.clientWidth));
 if(process.env.BROWSE_SHOTS)await p.screenshot({path:path.join(process.env.BROWSE_SHOTS,'collections-'+width+'.png')});
 assert.deepEqual(errors,[]);await p.close();
}console.log('Compact metadata: shared headers/copy, two-column parameters, dense resources, readable tags with unchanged vote targets, aligned creator/Follow states and full-row collection choices passed at 320/390/1400px.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
