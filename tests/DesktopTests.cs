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
                if(await web.ExecuteScriptAsync("document.querySelector('#desktopServerState').textContent.includes('off')")!="true")throw new Exception("Server off UI missing");
                await web.ExecuteScriptAsync("heartbeat=async()=>{};document.querySelector('#desktopPower').click();");
                await Until(async()=>online&&await web.ExecuteScriptAsync("document.querySelector('#desktopPower').getAttribute('aria-pressed')==='true'")=="true","power on");
                await web.ExecuteScriptAsync("window.powerCheck=null;api('ping').then(()=>window.powerCheck=true,e=>window.powerCheck=e.message);");
                await Until(async()=>await web.ExecuteScriptAsync("window.powerCheck!==null")=="true","power on listener");
                if(await web.ExecuteScriptAsync("window.powerCheck")!="true"||PhoneCount()!=0)throw new Exception("Desktop power or identity failed");
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
                var processId=web.BrowserProcessId;
                app.CollapseDesktop();
                await Until(()=>Task.FromResult(!app.expanded&&app.desktop==null&&app.compactPanel.Visible),"collapse");
                await Until(()=>Task.FromResult(!System.Diagnostics.Process.GetProcessesByName("msedgewebview2").Any(p=>p.Id==processId)),"browser process release");
                app.ExpandDesktop();
                await Until(async()=>app.desktop!=null&&app.desktop.CoreWebView2!=null&&await app.desktop.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#desktopPower')")=="true","reopen");
                app.HidePanel();if(app.desktop!=null||app.expanded||app.monitor.Visible)throw new Exception("Hide did not release studio");
                Console.WriteLine("Native WebView power on/off, authenticated ping, identity, local range playback, seeking, collapse, browser process release, reopen and hide passed.");
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
