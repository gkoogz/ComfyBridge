using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Comfy Bridge")]
[assembly: System.Reflection.AssemblyDescription("Phone to ComfyUI bridge")]
[assembly: System.Reflection.AssemblyVersion("0.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.1.0.4")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.1.0-beta.1")]

class Bridge : ApplicationContext {
    static readonly string Home = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ComfyBridge");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 80000000 };
    static string token, python;
    static System.Net.Sockets.TcpListener server;
    static System.Net.Sockets.TcpListener tlsServer;
    static X509Certificate2 certificate;
    static string fingerprint;
    static Process worker;
    static SemaphoreSlim starting = new SemaphoreSlim(1,1);
    static DateTime seen = DateTime.MinValue;
    static PerformanceCounter cpu;
    static PerformanceCounter[] vram;
    static DateTime sampled = DateTime.MinValue;
    static string metrics = "{}";
    static SemaphoreSlim connections = new SemaphoreSlim(24,24);
    bool trimmed;
    NotifyIcon tray;
    Form monitor;
    TextBox status;
    System.Windows.Forms.Timer timer;

    [StructLayout(LayoutKind.Sequential)] class MemoryStatus {
        public uint length = (uint)Marshal.SizeOf(typeof(MemoryStatus)); public uint load;
        public ulong totalPhysical, availablePhysical, totalPage, availablePage, totalVirtual, availableVirtual, availableExtended;
    }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In,Out] MemoryStatus m);
    [DllImport("psapi.dll")] static extern bool EmptyWorkingSet(IntPtr h);

    [STAThread] static void Main() {
        bool fresh;
        using(var mutex = new Mutex(true,"Local\\ComfyBridgeTray",out fresh)) {
            if(!fresh) return;
            Application.EnableVisualStyles();
            Directory.CreateDirectory(Data);
            var key = Path.Combine(Data,"token.txt");
            if(!File.Exists(key)) { byte[] b=new byte[32]; using(var r=RandomNumberGenerator.Create()) r.GetBytes(b); File.WriteAllText(key,Convert.ToBase64String(b)); }
            token=File.ReadAllText(key).Trim();
            string certPath=Path.Combine(Data,"bridge.pfx");
            if(!File.Exists(certPath)) {
                using(var rsa=RSA.Create(2048)) {
                    var request=new CertificateRequest("CN=Comfy Bridge",rsa,HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1);
                    request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature,false));
                    using(var cert=request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1),DateTimeOffset.UtcNow.AddYears(5)))
                        File.WriteAllBytes(certPath,cert.Export(X509ContentType.Pfx,token));
                }
            }
            certificate=new X509Certificate2(certPath,token,X509KeyStorageFlags.UserKeySet);
            using(var sha=SHA256.Create())fingerprint=BitConverter.ToString(sha.ComputeHash(certificate.RawData)).Replace("-","");
            File.WriteAllText(Path.Combine(Data,"fingerprint.txt"),fingerprint);
            var cfg=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Home,"config.json")));
            python=Path.Combine((string)cfg["comfyRoot"],"venv\\Scripts\\python.exe");
            Application.Run(new Bridge());
        }
    }
    Bridge() {
        tray=new NotifyIcon { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath), Visible=true, Text="Comfy Bridge · waiting for phone" };
        var menu=new ContextMenuStrip();
        menu.Items.Add("Monitor & pairing", null, (s,e)=>ShowMonitor());
        menu.Items.Add("Copy pairing key", null, (s,e)=>Clipboard.SetText(token));
        menu.Items.Add("Copy certificate fingerprint", null, (s,e)=>Clipboard.SetText(fingerprint));
        menu.Items.Add("Open logs", null, (s,e)=>Process.Start("explorer.exe",Data));
        menu.Items.Add("Close bridge (queued jobs finish)", null, (s,e)=>{server.Stop();tlsServer.Stop();tray.Visible=false;Application.Exit();});
        tray.ContextMenuStrip=menu;tray.DoubleClick+=(s,e)=>ShowMonitor();
        server=new System.Net.Sockets.TcpListener(IPAddress.Loopback,18765);
        tlsServer=new System.Net.Sockets.TcpListener(IPAddress.Any,18764);
        try {server.Start();tlsServer.Start();} catch(Exception ex) {MessageBox.Show("Bridge listeners could not start. Ports 18764 and 18765 must be available.\n"+ex.Message);tray.Dispose();Environment.Exit(1);}
        Task.Run(()=>Listen(server,false));Task.Run(()=>Listen(tlsServer,true));
        timer=new System.Windows.Forms.Timer {Interval=5000};
        timer.Tick+=async (s,e)=>{
            bool connected=(DateTime.UtcNow-seen).TotalSeconds<20;
            tray.Text=connected?"Comfy Bridge · phone connected":"Comfy Bridge · waiting for phone";
            if(monitor!=null && !monitor.IsDisposed && monitor.Visible) {
                string jobs="Worker asleep · no bridge generation";
                if(worker!=null && !worker.HasExited) {
                    try {using(var c=new WebClient()){c.Headers["Authorization"]="Bearer "+token;jobs=await c.DownloadStringTaskAsync("http://127.0.0.1:18766/api/status");}}catch(Exception ex){jobs=ex.Message;}
                }
                status.Text="PHONE: "+(connected?"Connected":"Disconnected")+"\r\n\r\nADDRESSES\r\n"+Addresses()+"\r\n\r\nPAIRING KEY (Copy key in tray menu)\r\n"+token+"\r\n\r\nCERTIFICATE FINGERPRINT\r\n"+fingerprint+"\r\n\r\nJOBS\r\n"+jobs;
            }
            if(!connected && (worker==null || worker.HasExited)) {
                if(cpu!=null){cpu.Dispose();cpu=null;}
                if(vram!=null){foreach(var c in vram)c.Dispose();vram=null;}
                if(!trimmed) {GC.Collect();EmptyWorkingSet(Process.GetCurrentProcess().Handle);trimmed=true;}
            }
            else trimmed=false;
        };timer.Start();
    }
    void ShowMonitor() {
        if(monitor!=null && !monitor.IsDisposed){monitor.Show();monitor.Activate();return;}
        monitor=new Form {Text="Comfy Bridge · Monitor & pairing",Icon=tray.Icon,Width=720,Height=570,BackColor=Color.FromArgb(17,22,29)};
        status=new TextBox {Dock=DockStyle.Fill,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,BackColor=Color.FromArgb(17,22,29),ForeColor=Color.FromArgb(220,233,227),Font=new Font("Consolas",10),Text="ADDRESSES\r\n"+Addresses()+"\r\n\r\nPAIRING KEY\r\n"+token+"\r\n\r\nCERTIFICATE FINGERPRINT\r\n"+fingerprint};
        monitor.Controls.Add(status);monitor.Show();
    }
    static string Addresses() {
        var lines=new List<string>();
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces())
            if(nic.OperationalStatus==OperationalStatus.Up)
                foreach(var ip in nic.GetIPProperties().UnicastAddresses)
                    if(ip.Address.AddressFamily==System.Net.Sockets.AddressFamily.InterNetwork)
                        lines.Add(nic.Name+": https://"+ip.Address+":18764");
        return string.Join("\r\n",lines);
    }
    static async Task Listen(System.Net.Sockets.TcpListener listener,bool encrypted) {
        while(true) {
            try {var client=await listener.AcceptTcpClientAsync();if(!connections.Wait(0)){client.Close();continue;}var ignored=Task.Run(async ()=>{try{await Handle(client,encrypted);}finally{connections.Release();}});}
            catch(System.Net.Sockets.SocketException){break;}catch(ObjectDisposedException){break;}
        }
    }
    static bool Equal(string a,string b) {
        if(a==null || a.Length!=b.Length)return false;
        int diff=0;for(int i=0;i<a.Length;i++)diff|=a[i]^b[i];return diff==0;
    }
    static async Task Reply(Stream stream,int code,string body) {
        byte[] bytes=Encoding.UTF8.GetBytes(body);
        await Headers(stream,code,"application/json",bytes.Length,null);
        await stream.WriteAsync(bytes,0,bytes.Length);
    }
    static async Task Headers(Stream stream,int code,string type,long length,WebHeaderCollection extra) {
        var h=new StringBuilder("HTTP/1.1 "+code+" "+((HttpStatusCode)code).ToString()+"\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: "+type+"\r\n");
        if(length>=0)h.Append("Content-Length: "+length+"\r\n");
        if(extra!=null)foreach(string name in new[]{"Content-Range","Accept-Ranges"})if(extra[name]!=null)h.Append(name+": "+extra[name]+"\r\n");
        h.Append("\r\n");byte[] bytes=Encoding.ASCII.GetBytes(h.ToString());await stream.WriteAsync(bytes,0,bytes.Length);
    }
    static async Task Wake() {
        await starting.WaitAsync();
        try {
            // An earlier tray instance may have left its worker finishing jobs.
            try {using(var c=new System.Net.Sockets.TcpClient()){await c.ConnectAsync("127.0.0.1",18766);return;}}catch(System.Net.Sockets.SocketException){}
            if(worker==null || worker.HasExited) {
                worker=Process.Start(new ProcessStartInfo(python,"\""+Path.Combine(Home,"worker.py")+"\""){WorkingDirectory=Home,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden});
            }
            for(int i=0;i<80;i++) {
                try {using(var c=new System.Net.Sockets.TcpClient()){await c.ConnectAsync("127.0.0.1",18766);return;}}catch(System.Net.Sockets.SocketException){}
                await Task.Delay(100);
            }
            throw new Exception("Bridge worker could not start.");
        } finally {starting.Release();}
    }
    static async Task Handle(System.Net.Sockets.TcpClient client,bool encrypted) {
      using(client)using(Stream stream=encrypted?(Stream)new SslStream(client.GetStream(),false):client.GetStream()) {
        try {
            stream.ReadTimeout=15000;stream.WriteTimeout=240000;
            if(encrypted)((SslStream)stream).AuthenticateAsServer(certificate,false,SslProtocols.Tls12,false);
            var header=new List<byte>();int next;
            while((next=stream.ReadByte())!=-1) {
                header.Add((byte)next);int n=header.Count;
                if(n>16384){await Reply(stream,431,"{}");return;}
                if(n>=4 && header[n-4]==13 && header[n-3]==10 && header[n-2]==13 && header[n-1]==10)break;
            }
            if(header.Count==0)return;
            string[] lines=Encoding.ASCII.GetString(header.ToArray()).Split(new[]{"\r\n"},StringSplitOptions.None);
            string[] first=lines[0].Split(' ');
            if(first.Length!=3 || (first[0]!="GET" && first[0]!="POST" && first[0]!="HEAD")){await Reply(stream,400,"{}");return;}
            var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            for(int i=1;i<lines.Length;i++){int colon=lines[i].IndexOf(':');if(colon>0)headers[lines[i].Substring(0,colon)]=lines[i].Substring(colon+1).Trim();}
            string auth;headers.TryGetValue("Authorization",out auth);
            if(!Equal(auth,"Bearer "+token)){await Reply(stream,401,"{\"error\":\"Pairing key required\"}");return;}
            string raw=first[1],path=raw.Split('?')[0];
            if(!path.StartsWith("/api/",StringComparison.Ordinal) || raw.Contains("..") || raw.Contains("\\")){await Reply(stream,404,"{}");return;}
            seen=DateTime.UtcNow;
            if(path=="/api/ping"){await Reply(stream,200,"{\"ok\":true,\"name\":\"Comfy Bridge\"}");return;}
            if(path=="/api/metrics"){await Reply(stream,200,Metrics());return;}
            string lengthText;long length=0;
            if(headers.ContainsKey("Transfer-Encoding") || (headers.TryGetValue("Content-Length",out lengthText) && (!long.TryParse(lengthText,out length) || length<0 || length>55L*1024*1024))){await Reply(stream,413,"{\"error\":\"Invalid upload length\"}");return;}
            await Wake();
            var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:18766"+raw);
            req.Method=first[0];req.Headers["Authorization"]="Bearer "+token;req.Timeout=240000;req.ReadWriteTimeout=240000;req.Proxy=null;
            string range;
            if(headers.TryGetValue("Range",out range)) {
                string[] halves=range.Replace("bytes=","").Split('-');long start,end;
                if(long.TryParse(halves[0],out start)){if(halves.Length>1 && long.TryParse(halves[1],out end))req.AddRange(start,end);else req.AddRange(start);}
            }
            if(first[0]=="POST") {
                req.ContentType="application/json";req.ContentLength=length;
                using(var output=await req.GetRequestStreamAsync()) {
                    byte[] buffer=new byte[65536];long remaining=length;
                    while(remaining>0){int n=stream.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));if(n<=0)throw new IOException("Incomplete request");await output.WriteAsync(buffer,0,n);remaining-=n;}
                }
            }
            HttpWebResponse upstream;
            try {upstream=(HttpWebResponse)await req.GetResponseAsync();}
            catch(WebException ex){if(ex.Response==null)throw;upstream=(HttpWebResponse)ex.Response;}
            using(upstream){await Headers(stream,(int)upstream.StatusCode,upstream.ContentType,upstream.ContentLength,upstream.Headers);
                using(var input=upstream.GetResponseStream())await input.CopyToAsync(stream);
            }
        }catch(Exception ex){try{Reply(stream,503,Json.Serialize(new {error=ex.Message})).GetAwaiter().GetResult();}catch{}}
      }
    }
    static object Sensor(RegistryKey key,string name) {
        double v;return key!=null && double.TryParse(Convert.ToString(key.GetValue(name)),NumberStyles.Float,CultureInfo.InvariantCulture,out v)?(object)v:null;
    }
    static string Metrics() {
        lock(Json) {
            if((DateTime.UtcNow-sampled).TotalSeconds<2)return metrics;
            if(cpu==null){cpu=new PerformanceCounter("Processor","% Processor Time","_Total");cpu.NextValue();}
            var mem=new MemoryStatus();GlobalMemoryStatusEx(mem);
            object dedicated=null;
            try {
                if(vram==null){var list=new List<PerformanceCounter>();foreach(var instance in new PerformanceCounterCategory("GPU Adapter Memory").GetInstanceNames())list.Add(new PerformanceCounter("GPU Adapter Memory","Dedicated Usage",instance));vram=list.ToArray();}
                double sum=0;foreach(var c in vram)sum+=c.NextValue();dedicated=sum;
            }catch{dedicated=null;}
            using(var key=Registry.CurrentUser.OpenSubKey("SOFTWARE\\HWiNFO64\\VSB")) {
                metrics=Json.Serialize(new {cpu=cpu.NextValue(),cpuWatts=Sensor(key,"ValueRaw2"),gpu=Sensor(key,"ValueRaw9"),gpuWatts=Sensor(key,"ValueRaw4"),
                    ramUsed=mem.totalPhysical-mem.availablePhysical,ramTotal=mem.totalPhysical,
                    commitUsed=mem.totalPage-mem.availablePage,commitTotal=mem.totalPage,vramUsed=dedicated,vramTotal=21474836480L,
                    sensorSource="HWiNFO VSB / Windows counters",timestamp=DateTime.UtcNow.ToString("o")});
            }
            sampled=DateTime.UtcNow;return metrics;
        }
    }
}
