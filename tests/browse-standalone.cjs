const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:860},hasTouch:true}),errors=[];
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
  await page.route('**/model-preview/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="440"><rect width="300" height="440" fill="teal"/></svg>'}));
  await page.addInitScript(()=>{
   window.hardwarePC=sessionStorage.getItem('pc')!=='off';
   window.calls=[];window.direct=[];
   const initial=[{kind:'tag',id:'12',name:'Ceramics',base:0,offset:10,weight:10,banned:false,disabled:false,revisions:{}},
    {kind:'tag',id:'13',name:'Blue',base:0,offset:4,weight:4,banned:false,disabled:false,revisions:{}}];
   const rows=()=>JSON.parse(sessionStorage.getItem('pc-rows')||JSON.stringify(initial));
   const raw=(id,tag)=>({id,type:'image',width:300,height:440,url:'06c1e11a-6a5b-465c-b014-2e22104488f6',user:{id:id+10,username:'Potter '+id},
    tagIds:tag?[12,13]:[12],tags:tag?[{id:12,name:'Ceramics'},{id:13,name:'Blue'}]:[{id:12,name:'Ceramics'}]});
   const pcItem=()=>BrowseReplica.normalize('1',raw(1,false));
   window.Native={
    configuration:()=>JSON.stringify({paired:false,fingerprint:'AA',device:'one'}),notificationRoute:()=>'',
    loadSocialQueue:key=>localStorage.getItem(key)||'',saveSocialQueue:(key,value)=>{localStorage.setItem(key,value);return true;},
    offlineBrowseReady:a=>sessionStorage.getItem('phone-account')===a,
    offlineBrowseRead:(id,a,op,args)=>{
     direct.push({a,op,args:JSON.parse(args)});
     const result=op==='detail'?{meta:{prompt:'Ceramic jar with carved leaves.'},resources:[]}:{items:[raw(42,false),raw(43,true),raw(44,false)],nextCursor:null};
     queueMicrotask(()=>bridgeResult(id,true,result));
    },
    request:(id,route,method,body)=>queueMicrotask(()=>{
     const data=body?JSON.parse(body):undefined;
     if(!hardwarePC){calls.push({route,data,failed:true});bridgeResult(id,false,'PC disconnected');return;}
     calls.push({route,data});let result={};
     if(route==='ping'){sessionStorage.setItem('phone-account','1');result={ok:true};}
     if(route==='browse/status')result={account:'1',username:'Potter',collections:[{id:4,name:'Ceramics',count:1}],followingIds:[],collectionIndex:{},importState:{complete:true}};
     if(route==='browse/feed')result={account:'1',items:[pcItem()],nextCursor:null};
     if(route==='browse/replica'){
      const items=rows();
      for(const change of data?.changes||[]){
       const row=items.find(i=>i.id===change.id);
       for(const [field,edit] of Object.entries(change.changes))row[field]=edit.value;
       row.weight=row.banned||row.disabled?0:row.offset;
      }
      sessionStorage.setItem('pc-rows',JSON.stringify(items));
      result={account:'1',items,applied:(data?.changes||[]).map(x=>x.requestId)};
     }
     if(route==='browse/seen')result={account:'1',seen:[]};
     if(route==='browse/social'){
      const pending=JSON.parse(sessionStorage.getItem('pc-social')||'[]');
      if(data){
       result={results:data.actions.map(a=>{
        pending.push({...a,key:'reaction:'+a.imageId+':'+a.reaction,state:'synced',revision:1});
        return {requestId:a.requestId,revision:1};
       })};
       sessionStorage.setItem('pc-social',JSON.stringify(pending));
      }else result={account:'1',items:pending};
     }
     if(route.startsWith('browse/detail/'))result={account:'1',item:{...pcItem(),detailVersion:2,generationDataAvailable:true}};
     bridgeResult(id,true,result);
    })
   };
  });
  await page.goto('https://bridge.test');
  await page.evaluate(async()=>{heartbeat=poll=syncSettings=()=>{};await api('ping');connection(true);navigate('browse');});
  await page.waitForFunction(()=>calls.some(c=>c.route==='browse/replica')&&document.querySelector('.browseTile'));
  assert.equal(await page.locator('#browseOfflineSetup').count(),0);
  await page.evaluate(()=>{sessionStorage.setItem('pc','off');hardwarePC=false;connection(false);});
  await page.locator('#browseRefresh').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.browseTile')].some(e=>e.browseItem?.id==='43'));
  const tile=page.locator('.browseTile').filter({hasText:'Potter 43'});
  await tile.locator('.browseMedia').click();
  await page.getByText('Ceramic jar with carved leaves.',{exact:true}).waitFor();
  await page.locator('.civitaiViewer [data-civi-react="Like"]').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-civi-react="Like"]')].some(b=>b.getAttribute('aria-pressed')==='true'));
  await page.locator('.civitaiViewer [data-tag-search="13"]').click();
  await page.locator('.tagBanSubmit').click();
  await page.locator('.civitaiViewer .bannedTag').waitFor();
  await page.locator('.civitaiViewer .civitaiClose').click();
  await page.locator('#browseImport').click();
  await page.locator('.weightRow[data-key="tag:12"] [data-adjust="-1"]').click();
  await page.waitForFunction(()=>document.querySelector('.weightRow[data-key="tag:12"] strong')?.textContent==='9');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.failed&&['browse/action','browse/social','browse/replica'].includes(c.route)).length),0);
  await page.reload();
  await page.evaluate(()=>{heartbeat=poll=syncSettings=()=>{};navigate('browse');});
  await page.getByText(/Standalone Browse/).waitFor();
  await page.locator('#browseImport').click();
  await page.waitForFunction(()=>document.querySelector('.weightRow[data-key="tag:13"].banned')&&document.querySelector('.weightRow[data-key="tag:12"] strong')?.textContent==='9');
  await page.evaluate(()=>{sessionStorage.setItem('pc','on');hardwarePC=true;connection(true);});
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('pc-rows')||'[]').some(r=>r.banned)&&JSON.parse(sessionStorage.getItem('pc-social')||'[]').some(r=>r.imageId==='43'));
  const restored=await page.evaluate(()=>({rows:JSON.parse(sessionStorage.getItem('pc-rows')),actions:JSON.parse(sessionStorage.getItem('pc-social'))}));
  assert.equal(restored.rows.find(r=>r.id==='12').weight,9);
  assert.equal(restored.rows.find(r=>r.id==='13').banned,true);
  assert.equal(restored.actions.length,1);
  assert.equal(restored.actions[0].selected,true);
  assert.equal(restored.actions[0].standalone,true);
  assert.deepEqual(errors,[]);
  console.log('Android Browse view passed direct reads with PC disconnected, app reload, and reconnect replay.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
