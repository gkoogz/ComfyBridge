const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch();
 try{
  const loader=path.join(__dirname,'../android/assets/browse-loader.js');
  for(const width of [260,393,720]){
   const page=await browser.newPage();
   await page.setContent(`<div id="workspace" style="width:${width}px;height:200px;overflow:auto">
    <div id="loader" style="height:200px"><canvas class="browseFluid"></canvas><canvas class="browseFlung"></canvas></div>
   </div>`);
   await page.evaluate(()=>{
    window.requestAnimationFrame=cb=>{window.nextFrame=cb;return 1;};
    window.cancelAnimationFrame=()=>{window.nextFrame=null;};
    Math.random=()=>.5;
   });
   await page.addScriptTag({path:loader});
   const result=await page.evaluate(async()=>{
    const host=document.querySelector('#loader'),workspace=document.querySelector('#workspace');
    const ctx=host.querySelector('.browseFluid').getContext('2d',{willReadFrequently:true});
    const clear=ctx.clearRect.bind(ctx),fill=ctx.fill.bind(ctx);
    let layer=0,checks=0,holes=0;
    ctx.clearRect=(...args)=>{layer=0;clear(...args);};
    ctx.fill=(...args)=>{
     // Inspect each fill by itself so the other wave and rim cannot hide gaps.
     if(layer===1)clear(0,0,ctx.canvas.width,ctx.canvas.height);
     fill(...args);
     if(layer++>1)return;
     const {width,height}=ctx.canvas;
     if(!width||!height)return;
     const rows=60,pixels=ctx.getImageData(0,0,width,rows).data;
     const visited=new Uint8Array(width*rows),pending=[];
     const visit=i=>{
      if(visited[i]||pixels[4*i+3]>=128)return;
      visited[i]=1;
      pending.push(i);
     };
     for(let x=0;x<width;x++)visit((rows-1)*width+x);
     for(let y=0;y<rows;y++){visit(y*width);visit(y*width+width-1);}
     while(pending.length){
      const i=pending.pop(),x=i%width;
      if(x>0)visit(i-1);
      if(x<width-1)visit(i+1);
      if(i>=width)visit(i-width);
      if(i<width*(rows-1))visit(i+width);
     }
     for(let i=0;i<visited.length;i++)if(!visited[i]&&pixels[4*i+3]===0)holes++;
     checks++;
    };
    const instance=BrowseLoader.metadata(host,workspace);
    for(let i=0;!window.nextFrame&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,10));
    for(let t=40;t<=19000&&window.nextFrame;t+=40){
     const draw=window.nextFrame;window.nextFrame=null;draw(t);
    }
    instance.dispose();
    return {checks,holes};
   });
   assert(result.checks>800,'Both liquid layers were sampled through multiple drop cycles');
   assert.equal(result.holes,0,`Continuous liquid fill at ${width}px`);
   await page.close();
  }
  console.log('Browse loader: continuous liquid at phone and desktop widths.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
