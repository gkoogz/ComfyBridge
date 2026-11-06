const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const b=await chromium.launch();try{
 const p=await b.newPage({viewport:{width:390,height:844},hasTouch:true});
 await p.route('https://bridge.test/**',r=>r.fulfill({path:path.join(__dirname,'../android/assets',new URL(r.request().url()).pathname.slice(1)||'index.html')}));
 await p.addInitScript(()=>window.Native={configuration:()=>JSON.stringify({device:'test',paired:false}),notificationRoute:()=>''});
 await p.goto('https://bridge.test');await p.waitForSelector('#connect');
 await p.evaluate(()=>{heartbeat=poll=syncSettings=syncNotes=()=>{};notebook.doc={text:'Keep these notes and selections.',marks:[],next:0};navigate('notepad');setChatSnap(1);$('#noteText').setSelectionRange(0,0);});
 const c=await p.context().newCDPSession(p);
 async function swipe(dx,dy){await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:40,y:180}]});for(let n=1;n<=8;n++){await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:40+dx*n/8,y:180+dy*n/8}]});await p.waitForTimeout(15);}await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(250);}
 await swipe(210,0);assert(await p.evaluate(()=>$('#drawer').classList.contains('open')));
 assert.equal(await p.evaluate(()=>notebook.doc.text),'Keep these notes and selections.');
 await p.evaluate(()=>{drawer(false);$('#noteText').setSelectionRange(0,5);});await swipe(210,0);
 assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
 await p.evaluate(()=>$('#noteText').setSelectionRange(0,0));await swipe(0,-90);
 assert(!await p.evaluate(()=>$('#drawer').classList.contains('open')));
 console.log('Touch swipe opens Notepad sidebar; selection, vertical scrolling and note text are preserved.');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
