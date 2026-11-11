using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

class DesktopTests {
    [STAThread] static void Main(string[] args){Bridge.ExerciseDesktop(args);}
}
partial class Bridge {
    static async Task Until(Func<Task<bool>> ready,string name){
        var limit=DateTime.UtcNow.AddSeconds(20);
        while(!await ready()){if(DateTime.UtcNow>limit)throw new Exception("Timed out: "+name);await Task.Delay(100);}
    }
    internal static void ExerciseDesktop(string[] args){
        Application.EnableVisualStyles();
        Environment.SetEnvironmentVariable("LOCALAPPDATA",Path.Combine(Home,"fixture"));
        Data=Path.Combine(Home,"fixture","ComfyBridge");Directory.CreateDirectory(Data);
        token="isolated-desktop-test";python=args[0];loopbackPort=tlsPort=0;
        File.WriteAllText(Path.Combine(Data,"server-off"),"off");
        var app=new Bridge();app.ShowMonitor();
        app.Server(true,false);
        loopbackPort=((System.Net.IPEndPoint)server.LocalEndpoint).Port;
        tlsPort=((System.Net.IPEndPoint)tlsServer.LocalEndpoint).Port;
        app.Server(false,false);
        app.monitor.Text="ComfyBridge Desktop Test";
        app.monitor.Shown+=(s,e)=>{};
        bool inspect=args.Length>1&&args[1]=="--inspect";
        var kick=new Timer{Interval=100};
        kick.Tick+=async(s,e)=>{
            kick.Stop();
            try{
                app.ExpandDesktop();
                await Until(async()=>app.desktop!=null&&app.desktop.CoreWebView2!=null&&await app.desktop.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#desktopPower')")=="true","desktop startup");
                var web=app.desktop.CoreWebView2;
                await Until(async()=>await web.ExecuteScriptAsync("document.querySelector('#desktopChatModel').options.length===2")=="true","installed local chat models");
                if(app.chatModels.Items.Count!=2)throw new Exception("Compact panel chat models missing");
                await web.ExecuteScriptAsync("document.querySelector('#desktopChatModel').value='fixture-two.gguf';document.querySelector('#desktopChatModel').dispatchEvent(new Event('change'));");
                await Until(async()=>Convert.ToString((await ChatControl("models",""))["selected"])=="fixture-two.gguf","chat model selection persisted");
                if(await web.ExecuteScriptAsync("document.querySelector('#desktopServerState').textContent.includes('off')")!="true")throw new Exception("Server off UI missing");
                await web.ExecuteScriptAsync("heartbeat=async()=>{};document.querySelector('#desktopPower').click();");
                await Until(async()=>online&&await web.ExecuteScriptAsync("document.querySelector('#desktopPower').getAttribute('aria-pressed')==='true'")=="true","power on");
                await web.ExecuteScriptAsync("window.powerCheck=null;api('ping').then(()=>window.powerCheck=true,e=>window.powerCheck=e.message);");
                await Until(async()=>await web.ExecuteScriptAsync("window.powerCheck!==null")=="true","power on listener");
                if(await web.ExecuteScriptAsync("window.powerCheck")!="true"||PhoneCount()!=0)throw new Exception("Desktop power or identity failed");
                await web.ExecuteScriptAsync(@"window.sourceTest=null;(async()=>{try{
                    const meta=await api('studio/provenance/11111111-1111-4111-8111-111111111111');
                    if(meta.settings.positive!=='Fixture prompt')throw Error('Metadata RPC failed');
                    const r=await fetch('/source/11111111-1111-4111-8111-111111111111/upload');
                    if(!r.ok)throw Error('Source fetch failed');const blob=await r.blob();const url=URL.createObjectURL(blob);
                    const image=new Image();image.src=url;await image.decode();URL.revokeObjectURL(url);
                    if(image.naturalWidth!==32)throw Error('Original image dimensions changed');window.sourceTest=true;
                }catch(e){window.sourceTest=e.message;}})();");
                await Until(async()=>await web.ExecuteScriptAsync("window.sourceTest!==null")=="true","source inspection");
                if(await web.ExecuteScriptAsync("window.sourceTest")!="true")throw new Exception(await web.ExecuteScriptAsync("window.sourceTest"));
                await web.ExecuteScriptAsync("document.querySelector('#desktopPower').click();");
                await Until(async()=>!online&&await web.ExecuteScriptAsync("document.querySelector('#desktopPower').getAttribute('aria-pressed')==='false'")=="true","power off");
                await web.ExecuteScriptAsync(@"window.fixtureResult=null;(async()=>{
                    try{
                        const url='/local/video/3f59770998574a8c80c18ed7d02b5389/hash';
                        const r=await fetch(url,{headers:{Range:'bytes=10-29'}});
                        if(r.status!==206||(await r.arrayBuffer()).byteLength!==20)throw Error('Range response failed');
                        const video=document.createElement('video');video.muted=true;document.body.append(video);video.src=url;
                        await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(Error('Video decode failed'));});
                        video.currentTime=1;
                        await new Promise(resolve=>video.onseeked=resolve);
                        await video.play();video.pause();video.remove();
                        window.fixtureResult='passed';
                    }catch(e){window.fixtureResult=e.message;}
                })();");
                await Until(async()=>await web.ExecuteScriptAsync("window.fixtureResult!==null")=="true","video streaming");
                var result=await web.ExecuteScriptAsync("window.fixtureResult");
                if(result!="\"passed\"")throw new Exception("Media test: "+result);
                await web.ExecuteScriptAsync(@"window.devicePreviewResult=null;(async()=>{
                    const originalFetch=window.fetch;
                    try{
                        const scope='native-smoke-'+Date.now();localStorage.setItem('previewSmokeScope',scope);
                        const item={id:'native',kind:'loras',name:'Pottery',images:[0,1,2].map(i=>({source:'fixture-'+i,path:'model-preview/native/'+i}))};
                        localStorage.setItem('previewSmokeItem',JSON.stringify(item));
                        window.fetch=(url,options)=>originalFetch(String(url).startsWith('/model-preview/native/')?'/source/11111111-1111-4111-8111-111111111111/upload':url,options);
                        const cache=new ListingPreviewCache({scope,canDownload:()=>true});
                        await cache.register([item]);await cache.ensure(item,item.images);
                        if(cache.samples(item).length!==3)throw Error('Native preview cache incomplete');
                        const image=new Image();image.src=cache.url(item,item.images[0]);await image.decode();
                        if(image.naturalWidth!==32)throw Error('Native preview blob decode failed');
                        cache.close();window.devicePreviewResult=true;
                    }catch(e){window.devicePreviewResult=e.message;}finally{window.fetch=originalFetch;}
                })();");
                await Until(async()=>await web.ExecuteScriptAsync("window.devicePreviewResult!==null")=="true","device preview cache");
                if(await web.ExecuteScriptAsync("window.devicePreviewResult")!="true")throw new Exception(await web.ExecuteScriptAsync("window.devicePreviewResult"));
                var processId=web.BrowserProcessId;
                app.CollapseDesktop();
                await Until(()=>Task.FromResult(!app.expanded&&app.desktop==null&&app.compactPanel.Visible),"collapse");
                await Until(()=>Task.FromResult(!System.Diagnostics.Process.GetProcessesByName("msedgewebview2").Any(p=>p.Id==processId)),"browser process release");
                app.ExpandDesktop();
                await Until(async()=>app.desktop!=null&&app.desktop.CoreWebView2!=null&&await app.desktop.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#desktopPower')")=="true","reopen");
                await app.desktop.CoreWebView2.ExecuteScriptAsync(@"window.previewReopen=null;(async()=>{try{
                    const item=JSON.parse(localStorage.getItem('previewSmokeItem'));
                    const cache=new ListingPreviewCache({scope:localStorage.getItem('previewSmokeScope'),canDownload:()=>false});
                    await cache.ready;await cache.register([item]);await cache.ensure(item,item.images);
                    const image=new Image();image.src=cache.url(item,item.images[1]);await image.decode();
                    window.previewReopen=cache.samples(item).length===3&&image.naturalWidth===32;cache.close();
                }catch(e){window.previewReopen=e.message;}})();");
                await Until(async()=>await app.desktop.CoreWebView2.ExecuteScriptAsync("window.previewReopen!==null")=="true","preview cache after browser restart");
                if(await app.desktop.CoreWebView2.ExecuteScriptAsync("window.previewReopen")!="true")throw new Exception(await app.desktop.CoreWebView2.ExecuteScriptAsync("window.previewReopen"));
                await app.desktop.CoreWebView2.ExecuteScriptAsync("setTimeout(()=>document.querySelector('.desktopClose').click(),100)");
                await Until(()=>Task.FromResult(app.desktop==null&&!app.expanded&&!app.monitor.Visible),"X hides studio");
                app.ShowMonitor();app.Server(true,false);
                app.monitor.Close();
                if(app.monitor.IsDisposed||app.monitor.Visible||!app.tray.Visible||!online)throw new Exception("Window close must hide and keep server running");
                app.ShowMonitor();
                var close=app.compactPanel.Controls.Cast<Control>().SelectMany(c=>c.Controls.Cast<Control>()).OfType<Button>().First(b=>b.Text=="×");
                close.PerformClick();
                if(app.monitor.Visible||!app.tray.Visible||!online)throw new Exception("Compact X stopped bridge");
                if(!app.tray.ContextMenuStrip.Items.Cast<ToolStripItem>().Any(i=>i.Text.StartsWith("Close ComfyBridge")))throw new Exception("Tray Close missing");
                app.Server(false,false);
                Console.WriteLine("Native WebView device preview blobs and offline restart cache, chat model selectors and persistence, power on/off, authenticated ping, identity, local range playback, seeking, collapse, browser process release, reopen and hide passed.");
                Environment.ExitCode=0;
                if(inspect){
                    app.ShowMonitor();app.ExpandDesktop();
                    await Until(async()=>app.desktop!=null&&app.desktop.CoreWebView2!=null&&await app.desktop.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#desktopPower')")=="true","inspection window");
                    await app.desktop.CoreWebView2.ExecuteScriptAsync(@"for(const kind of ['image','video'])state.settings[kind]={width:1024,height:1536,steps:8,cfg:5,denoise:1,frames:240,fps:24,seconds:10,exactFrames:true,model:'Demo model',positive:'A paper boat on a quiet lake.',negative:'',loras:[],seed:'42',batch:1};render();");
                    app.monitor.Show();app.monitor.Activate();
                    Console.WriteLine("Inspection visible="+app.monitor.Visible+" bounds="+app.monitor.Bounds+" state="+app.monitor.WindowState);
                }
            }catch(Exception error){Console.Error.WriteLine(error);Environment.ExitCode=1;}
            finally{if(!inspect||Environment.ExitCode!=0){app.ReleaseDesktop();app.Server(false,false);app.tray.Visible=false;app.timer.Stop();CloseStudio();app.monitor.Dispose();Application.ExitThread();}}
        };kick.Start();Application.Run(app);
    }
}
