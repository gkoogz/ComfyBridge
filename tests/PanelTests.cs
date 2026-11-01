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
        Data=Path.Combine(Path.GetTempPath(),"ComfyBridge-panel-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Data);token="isolated-test";loopbackPort=0;tlsPort=0;
        Application.EnableVisualStyles();
        File.WriteAllText(Path.Combine(Data,"remote-address.txt"),"https://203.0.113.10:15294");
        var app=new Bridge();
        try{
            app.ShowMonitor();Application.DoEvents();
            Check(app.monitor.Visible && online && app.codeLabel.Text.Length==6,"pairing panel opened");
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
            using(var http=new System.Net.WebClient()){http.Proxy=null;http.Headers["Authorization"]="Bearer "+token;
                string baseUrl="http://127.0.0.1:"+loopbackPort+"/api/";
                http.Headers["X-Bridge-Device"]=Guid.NewGuid().ToString();http.DownloadString(baseUrl+"ping");
                http.Headers["X-Bridge-Device"]=Guid.NewGuid().ToString();http.DownloadString(baseUrl+"ping");
                app.RefreshState();Check(app.phone.Text.Contains("2 phones"),"two connected phones");
                http.DownloadString(baseUrl+"disconnect");app.RefreshState();Check(app.phone.Text.Contains("1 phone"),"disconnect only one phone");}
            Check(app.monitor.FormBorderStyle==FormBorderStyle.None&&app.monitor.Region!=null&&Screen.FromControl(app.monitor).WorkingArea.Contains(app.monitor.Bounds),"rounded panel inside working area");
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
            app.monitor.Close();Check(!online&&!app.tray.Visible,"X quits and releases listeners");
            Console.WriteLine("Passed: 20 fixed-port restarts, occupied port recovery, docked and rounded panel, hide and quit, two independent phones, batch progress and pairing limits.");
            return 0;
        }finally{app.timer.Stop();app.Server(false,false);app.tray.Dispose();app.monitor.Dispose();app.Dispose();Application.DoEvents();}
    }
}
