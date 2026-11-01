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
            app.power.PerformClick();
            Check(!online && File.Exists(app.offFile),"off persisted");
            string hint;Check(Pairing.Display(out hint)=="—","off invalidates code");
            bool refused=false;try{using(var c=new TcpClient("127.0.0.1",port)){}}catch(SocketException){refused=true;}
            Check(refused,"off closes the actual TLS port");
            app.power.PerformClick();Check(online&&!File.Exists(app.offFile),"on restarts listeners");
            app.monitor.Close();Check(online&&!app.monitor.Visible,"X hides panel and keeps server on");
            app.ShowMonitor();Check(app.monitor.Visible,"reopen panel");
            seen=DateTime.UtcNow;app.RefreshState();Check(app.phone.Text.Contains("Phone connected"),"connected indicator");
            int pct;var j=new Dictionary<string,object>{{"id","test"},{"kind","image"},{"ordinal",1},{"total",4},{"progress",0.47},{"status","running"},{"current_node","KSampler"}};
            var st=new Dictionary<string,object>{{"active","test"},{"jobs",new object[]{j}}};
            app.jobText.Text=JobSummary(st,out pct);app.bar.Value=pct;
            Check(app.jobText.Text.Contains("1/4")&&pct==47,"batch progress");
            if(args.Length==1){using(var bmp=new Bitmap(app.monitor.Width,app.monitor.Height)){app.monitor.DrawToBitmap(bmp,new Rectangle(0,0,bmp.Width,bmp.Height));bmp.Save(args[0]);}}
            typeof(Pairing).GetField("expires",BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,DateTime.UtcNow.AddSeconds(-1));
            Check(Pairing.Display(out hint)=="—","expired code invalidated");
            Pairing.Issue();
            var bad=new Dictionary<string,string>{{"A",new string('0',512)}};
            for(int i=0;i<5;i++){try{Pairing.Exchange("begin",bad,"test","test");throw new Exception("Accepted invalid public value.");}catch(ArgumentException){}}
            try{Pairing.Exchange("begin",bad,"test","test");throw new Exception("Attempt limit missing.");}catch(InvalidOperationException){}
            Check(Pairing.Display(out hint)=="—","attempt limit invalidates code");
            Console.WriteLine("Passed: panel, remote address, power off/on, closed sockets, X to tray, connected indicator, 1/4 progress, code expiry and attempt limit.");
            return 0;
        }finally{app.timer.Stop();app.Server(false,false);app.tray.Dispose();app.monitor.Dispose();app.Dispose();Application.DoEvents();}
    }
}
