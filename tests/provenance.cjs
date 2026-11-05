const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
(async()=>{
 const assets=path.join(__dirname,'../android/assets');
 const html=fs.readFileSync(path.join(assets,'index.html'),'utf8'),java=fs.readFileSync(path.join(__dirname,'../android/java/com/comfybridge/app/MainActivity.java'),'utf8');
 for(const [,file] of html.matchAll(/(?:src|href)="([^"/]+\.(?:js|css))"/g))assert(java.includes('"/'+file+'"'),'Android must serve '+file);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(assets,new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await p.route(/\/(local|source|thumb)\//,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#366655"/></svg>'}));
  await p.addInitScript(()=>{window.Native={configuration:()=>JSON.stringify({device:'one',paired:false}),notificationRoute:()=>''};});
  await p.goto('https://bridge.test');await p.waitForSelector('#connect');
  await p.evaluate(()=>{
   heartbeat=poll=syncSettings=async()=>{};persist=()=>{};connected=true;
   window.commands=[];window.local=async(op,args)=>{commands.push({op,args});return true;};
   for(const kind of ['image','video'])state.settings[kind]={width:120,height:160,frames:240,fps:24,steps:4,loras:[],seed:'5',batch:1};
   library=[{id:'current',job:'child',kind:'image',local:'hash',created:100,source:'available'},{id:'origin',job:'root',kind:'image',local:'hash',created:50,source:'available',archived:true}];
   const make=(job,type,parents=[])=>({job,kind:'image',type,created:50,finished:100,elapsed:50,status:'complete',settings:{positive:job==='root'?'The original prompt':'The edited prompt',seed:'42',width:120,height:160},outputs:library.filter(x=>x.job===job),sources:[],parents,branches:[],provenanceKnown:true});
   window.nodes={root:make('root','Text to image'),child:make('child','Image to image',[{job:'root',relation:'Source image'}])};
   nodes.root.branches=[{job:'child',kind:'image',created:100,status:'complete',outputs:[library[0]]},{job:'pending',kind:'video',created:101,status:'pending',outputs:[]}];
   nodes.child.sources=[{role:'upload',kind:'image',url:'/source/child/upload',thumbnail:'/source/child/upload-thumb',media:library[1]}];
   api=async route=>{commands.push({route});if(route.startsWith('studio/provenance/'))return nodes[route.split('/').at(-1)];throw Error('Unexpected mutation');};
   navigate('library');openMedia(library[0]);
  });
  await p.waitForFunction(()=>document.querySelectorAll('.lineageNode').length===2);
  const layout=await p.evaluate(()=>{const row=$('.viewerActions'),hint=$('.detailsHint').getBoundingClientRect();return {tops:[...row.children].map(b=>b.offsetTop),hintTop:hint.top,viewport:innerHeight,scroll:$('#viewer').scrollHeight};});
  assert.equal(new Set(layout.tops).size,1);assert(layout.hintTop<layout.viewport&&layout.hintTop>layout.viewport-45);assert(layout.scroll>844);
  if(process.env.PROVENANCE_SHOT){await p.screenshot({path:process.env.PROVENANCE_SHOT+'-viewer.png'});await p.locator('.detailsHint').click();await p.waitForTimeout(250);await p.screenshot({path:process.env.PROVENANCE_SHOT+'-details.png'});}
  await p.locator('.detailsHint').click();await p.locator('.sourceCard button').first().click();
  await p.waitForSelector('.sourceInspection img');await p.getByRole('button',{name:'Save to camera roll',exact:true}).last().click();
  assert(await p.evaluate(()=>commands.some(c=>c.op==='exportSource'&&c.args.job==='child')));
  await p.locator('#modalClose').click();
  assert.equal(await p.locator('.recipePrompt').last().textContent(),'The original prompt');
  await p.locator('.recipeBranches summary').click();await p.locator('.branchList button').first().click();
  await p.waitForFunction(()=>$('#viewer').dataset.id==='current'&&$('.lineageNode'));
  await p.locator('.viewerActions').getByRole('button',{name:'Send to i2i',exact:true}).click();
  await p.waitForFunction(()=>page==='image'&&!viewerOpen());
  assert.equal(await p.evaluate(()=>state.settings.image.sourceMedia),'current');
  assert(await p.evaluate(()=>!commands.some(c=>c.route==='generate')));
  assert.deepEqual(errors,[]);
  console.log('One-row actions, details peek, ancestral prompts, branching, original source inspection/export and i2i provenance passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
