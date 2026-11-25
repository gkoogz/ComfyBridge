using System;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Collections.Generic;
using System.Windows.Forms;

class PanelTests {
    [STAThread] static int Main(string[] args) { return Bridge.ExercisePanel(args); }
}
partial class Bridge {
    static void Check(bool ok,string what){if(!ok)throw new Exception("Failed: "+what);}
    internal static int ExercisePanel(string[] args){
        long first,last;
        Check(ParseDesktopRange("bytes=20-39",100,out first,out last)&&first==20&&last==39,"video byte range");
        Check(ParseDesktopRange("bytes=60-",100,out first,out last)&&first==60&&last==99,"video open range");
        Check(ParseDesktopRange("bytes=-12",100,out first,out last)&&first==88&&last==99,"video suffix range");
        Check(!ParseDesktopRange("bytes=100-",100,out first,out last)&&!ParseDesktopRange("bytes=4-1",100,out first,out last),"invalid video range rejected");
        Check(NewerRelease("0.1.0-beta.10","0.1.0-beta.9")&&NewerRelease("0.1.0","0.1.0-rc.2")&&!NewerRelease("0.1.0-beta.9","0.1.0"),"numeric release ordering");
        var package=new PublishedAsset{name=SetupName("0.1.0-beta.10"),state="uploaded",size=3,
            digest="sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"};
        var releases=new[]{
            new PublishedRelease{tag_name="v0.1.0-beta.14",draft=false,assets=new[]{new PublishedAsset{name=SetupName("0.1.0-beta.14"),state="uploaded",size=3}}},
            new PublishedRelease{tag_name="v0.1.0-beta.13",draft=false,assets=new[]{new PublishedAsset{name="ComfyBridge-Windows-0.1.0-beta.13.zip",state="uploaded",size=3}}},
            new PublishedRelease{tag_name="v0.1.0-beta.12",draft=false,assets=new[]{package}},
            new PublishedRelease{tag_name="v0.1.0-beta.11",draft=true,assets=new[]{new PublishedAsset{name=SetupName("0.1.0-beta.11"),state="uploaded",size=3,digest=package.digest}}},
            new PublishedRelease{tag_name="v0.1.0-beta.10",draft=false,assets=new[]{package}}};
        Check(SelectRelease(releases,"0.1.0-beta.9").Version=="0.1.0-beta.10","only offer a matching published installer with a digest");
        using(var output=new MemoryStream()){
            CopyVerifiedSetup(new MemoryStream(new byte[]{97,98,99}),output,package);
            Check(output.Length==3,"valid installer is copied");
        }
        var rejected=false;
        try{CopyVerifiedSetup(new MemoryStream(new byte[]{97,98,98}),new MemoryStream(),package);}
        catch(IOException){rejected=true;}
        Check(rejected,"same-length corrupt installer is rejected");
        Data=Path.Combine(Path.GetTempPath(),"ComfyBridge-panel-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Data);token="isolated-test";loopbackPort=0;tlsPort=0;
        Application.EnableVisualStyles();
        File.WriteAllText(Path.Combine(Data,"remote-address.txt"),"https://203.0.113.10:15294");
        var app=new Bridge();
        try{
            app.ShowMonitor();Application.DoEvents();
            var header=(TableLayoutPanel)((TableLayoutPanel)app.compactPanel).GetControlFromPosition(0,0);
            Check(header.GetControlFromPosition(0,0).Text.Contains(VersionLabel())
                && app.tray.Text.Contains(VersionLabel())
                && app.tray.ContextMenuStrip.Items[1].Text==VersionLabel(),"version is visible in the panel, tooltip and tray menu");
            foreach(Control control in header.Controls){
                Check(control.Height>=TextRenderer.MeasureText(control.Text,control.Font).Height+4,"header text has vertical clearance");
                if(control is Button && control.AccessibleName=="Hide to tray")Check(((Button)control).FlatAppearance.BorderSize==0,"window controls are borderless");
            }
            Check(app.monitor.Visible && online && app.codeLabel.Text.Length==6,"pairing panel opened");
            Check(app.civitaiStatus.Text=="Civitai not connected"&&!app.civitaiStatus.Active,"missing Civitai key shown on panel");
            app.checkKey=key=>System.Threading.Tasks.Task.FromResult(key==new string('a',32));SaveCivitaiKey(new string('b',32));app.RefreshState();Check(!app.civitaiStatus.Active,"unaccepted key stays disconnected");SaveCivitaiKey(new string('a',32));app.RefreshState();Check(app.civitaiStatus.Active&&app.civitaiStatus.Text=="Civitai connected","saved API key indicated");File.Delete(CivitaiKeyFile());app.RefreshState();
            Check(app.civitaiStatus.Parent==app.power.Parent && app.power.Width==app.power.Height && app.power.Right<=app.badge.Parent.Left && app.civitaiStatus.Left>=app.badge.Parent.Right,"power, status and key control align without overlap");
            Check(!Bridge.CivitaiKeySaved() && !Bridge.ValidCivitaiKey("short key") && Bridge.ValidCivitaiKey(new string('a',32)),"civitai key shape");
            Check(app.addressBox.Text=="https://203.0.113.10:15294","remote address shown first");
            int port=((System.Net.IPEndPoint)tlsServer.LocalEndpoint).Port;
            tlsPort=port;loopbackPort=((System.Net.IPEndPoint)server.LocalEndpoint).Port;
            // Launch a long-lived child the way Wake starts the worker, with both ports bound.
            using(var child=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
                "ping.exe","-n 60 127.0.0.1"){UseShellExecute=false,CreateNoWindow=true})){
            try{
            for(int i=0;i<20;i++){
                using(var peer=new TcpClient("127.0.0.1",tlsPort)){
                    app.Server(false,true);
                    app.Server(true,true);
                }
                using(var http=new System.Net.WebClient()){
                    http.Proxy=null;http.Headers["Authorization"]="Bearer "+token;
                    Check(http.DownloadString("http://127.0.0.1:"+loopbackPort+"/api/ping").Contains("true"),"fixed port works after restart");
                }
            }
            }finally{if(!child.HasExited)child.Kill();child.WaitForExit();}}
            app.power.PerformClick();
            Check(!online && File.Exists(app.offFile),"off persisted");
            string hint;Check(Pairing.Display(out hint)=="—","off invalidates code");
            bool refused=false;try{using(var c=new TcpClient("127.0.0.1",port)){}}catch(SocketException){refused=true;}
            Check(refused,"off closes the actual TLS port");
            app.power.PerformClick();Check(online&&!File.Exists(app.offFile),"on restarts listeners");
            app.Server(false,true);
            var conflict=new TcpListener(System.Net.IPAddress.Any,tlsPort);conflict.ExclusiveAddressUse=true;conflict.Start();
            try{app.power.PerformClick();Check(!online && File.Exists(app.offFile) && app.codeHint.Text.Contains(tlsPort.ToString()),"occupied port explained");}
            finally{conflict.Stop();}
            app.power.PerformClick();Check(online,"recovers after port conflict clears");
            app.HidePanel();Check(online&&!app.monitor.Visible,"minimize hides panel and keeps server on");
            app.ShowMonitor();Check(app.monitor.Visible,"reopen panel");
            lock(phones)phones.Clear();
            using(var http=new System.Net.WebClient()){http.Proxy=null;http.Headers["Authorization"]="Bearer "+token;http.Headers["X-Bridge-Device"]=DesktopDevice();
                http.DownloadString("http://127.0.0.1:"+loopbackPort+"/api/ping");Check(PhoneCount()==0,"desktop does not count as a phone");}
            using(var http=new System.Net.WebClient()){http.Proxy=null;http.Headers["Authorization"]="Bearer "+token;
                string baseUrl="http://127.0.0.1:"+loopbackPort+"/api/";
                http.Headers["X-Bridge-Device"]=Guid.NewGuid().ToString();http.DownloadString(baseUrl+"ping");
                http.Headers["X-Bridge-Device"]=Guid.NewGuid().ToString();http.DownloadString(baseUrl+"ping");
                app.RefreshState();Check(app.phone.Text.Contains("2 phones"),"two connected phones");
                http.DownloadString(baseUrl+"disconnect");app.RefreshState();Check(app.phone.Text.Contains("1 phone"),"disconnect only one phone");}
            Check(app.monitor.FormBorderStyle==FormBorderStyle.None&&app.monitor.Region!=null&&Screen.FromControl(app.monitor).WorkingArea.Contains(app.monitor.Bounds),"rounded panel inside working area");
            var window=(BridgeWindow)app.monitor;var corner=new Point(window.ClientSize.Width-3,window.ClientSize.Height-3);
            var initial=window.Bounds;
            foreach(bool studioMode in new[]{false,true}){
                window.EnableGrip(studioMode);
                SendMessage(window.Handle,0x201,(IntPtr)1,(IntPtr)((corner.Y<<16)|corner.X));
                SendMessage(window.Handle,0x200,(IntPtr)1,(IntPtr)(((corner.Y+10)<<16)|(corner.X+20)));
                SendMessage(window.Handle,0x202,IntPtr.Zero,(IntPtr)((corner.Y<<16)|corner.X));
                Check(window.Width==initial.Width+(studioMode?20:0)&&window.Height==initial.Height+(studioMode?10:0),"mouse resize is restricted to studio mode");
            }
            window.Bounds=initial;window.EnableGrip(false);
            int pct;var j=new Dictionary<string,object>{{"id","test"},{"kind","image"},{"ordinal",1},{"total",1},{"queuePosition",2},{"queueTotal",4},{"progress",0.47},{"status","running"},{"current_node","Sample image · 12/32"}};
            var st=new Dictionary<string,object>{{"active","test"},{"jobs",new object[]{j}},{"elapsed","2:17"}};
            app.jobText.Text=JobSummary(st,out pct);app.bar.Value=pct;
            Check(app.jobText.Text.Contains("Queue 2/4")&&pct==47&&app.jobText.Text.Contains("running  2:17"),"shared queue progress and elapsed time");
            if(args.Length==1){using(var bmp=new Bitmap(app.monitor.Width,app.monitor.Height)){app.monitor.DrawToBitmap(bmp,new Rectangle(0,0,bmp.Width,bmp.Height));bmp.Save(args[0]);}}
            typeof(Pairing).GetField("expires",BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,DateTime.UtcNow.AddSeconds(-1));
            Check(Pairing.Display(out hint)=="—","expired code invalidated");
            Pairing.Issue();
            var bad=new Dictionary<string,string>{{"A",new string('0',512)}};
            for(int i=0;i<5;i++){try{Pairing.Exchange("begin",bad,"test","test");throw new Exception("Accepted invalid public value.");}catch(ArgumentException){}}
            try{Pairing.Exchange("begin",bad,"test","test");throw new Exception("Attempt limit missing.");}catch(InvalidOperationException){}
            Check(Pairing.Display(out hint)=="—","attempt limit invalidates code");
            app.monitor.Close();Check(online&&!app.monitor.Visible&&app.tray.Visible,"X hides to tray and keeps the server on");
            Console.WriteLine("Passed: 20 fixed-port restarts, occupied port recovery, docked and rounded panel, hide and quit, two independent phones, batch progress and pairing limits.");
            return 0;
        }finally{app.timer.Stop();app.Server(false,false);app.tray.Dispose();app.monitor.Dispose();app.Dispose();Application.DoEvents();}
    }
}
