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
[assembly: System.Reflection.AssemblyFileVersion("0.1.0.48")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.1.0-beta.48")]

partial class Bridge : ApplicationContext {
    static readonly string Home = AppDomain.CurrentDomain.BaseDirectory;
    static string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ComfyBridge");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 80000000 };
    static string token, python;
    static System.Net.Sockets.TcpListener server;
    static System.Net.Sockets.TcpListener tlsServer;
    static X509Certificate2 certificate;
    static string fingerprint;
    static Process worker;
    static int relays;
    static DateTime nextWorkerCheck=DateTime.MinValue;
    static SemaphoreSlim starting = new SemaphoreSlim(1,1);
    static readonly Dictionary<string,DateTime> phones=new Dictionary<string,DateTime>();
    static readonly Dictionary<string,DateTime> watchers=new Dictionary<string,DateTime>();
    static void Expire(Dictionary<string,DateTime> source){var stale=new List<string>();foreach(var p in source)if((DateTime.UtcNow-p.Value).TotalSeconds>=20)stale.Add(p.Key);foreach(string id in stale)source.Remove(id);}
    static int PhoneCount(){lock(phones){Expire(phones);Expire(watchers);var ids=new HashSet<string>(phones.Keys);ids.UnionWith(watchers.Keys);return ids.Count;}}
    static PerformanceCounter cpu;
    static PerformanceCounter[] vram;
    static DateTime sampled = DateTime.MinValue;
    static string metrics = "{}";
    static SemaphoreSlim connections = new SemaphoreSlim(24,24);
    EventWaitHandle panelSignal;
    bool trimmed;
    NotifyIcon tray;
    Form monitor;
    System.Windows.Forms.Timer timer;

    [StructLayout(LayoutKind.Sequential)] class MemoryStatus {
        public uint length = (uint)Marshal.SizeOf(typeof(MemoryStatus)); public uint load;
        public ulong totalPhysical, availablePhysical, totalPage, availablePage, totalVirtual, availableVirtual, availableExtended;
    }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In,Out] MemoryStatus m);
    [DllImport("psapi.dll")] static extern bool EmptyWorkingSet(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
    static void PrivateSocket(System.Net.Sockets.Socket s){
        // A worker can outlive this tray. An inherited handle keeps the Windows port
        // bound even after TcpListener.Stop() closes the tray's copy.
        if(!SetHandleInformation(s.Handle,1,0))throw new System.ComponentModel.Win32Exception();
    }

    [STAThread] static void Main(string[] args) {
        bool fresh;
        using(var mutex = new Mutex(true,"Local\\ComfyBridgeTray",out fresh)) {
            if(!fresh){try{using(var signal=EventWaitHandle.OpenExisting("Local\\ComfyBridgeOpenPanel"))signal.Set();}catch(WaitHandleCannotBeOpenedException){}return;}
            Application.EnableVisualStyles();
            ServicePointManager.DefaultConnectionLimit=24;
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
            var app=new Bridge();app.CheckForRelease();if(Array.IndexOf(args,"--panel")>=0)app.ShowMonitor();Application.Run(app);
        }
    }
    Bridge() {
        tray=new NotifyIcon { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath), Visible=true, Text="Comfy Bridge · waiting for phone" };
        var menu=new ContextMenuStrip();
        menu.Items.Add("Open ComfyBridge",null,(s,e)=>ShowMonitor());
        menu.Items.Add("Open logs",null,(s,e)=>Process.Start("explorer.exe",Data));
        menu.Items.Add("Quit bridge (queued jobs finish)",null,(s,e)=>{Server(false,false);tray.Visible=false;Application.ExitThread();});
        tray.ContextMenuStrip=menu;tray.MouseClick+=(s,e)=>{if(e.Button==MouseButtons.Left)ShowMonitor();};
        try{Server(!File.Exists(offFile),false);}catch(Exception ex){MessageBox.Show("Could not start the bridge: "+ex.Message);}
        timer=new System.Windows.Forms.Timer {Interval=5000};
        timer.Tick+=(s,e)=>{
            bool connected=online&&PhoneCount()>0;
            RefreshState();RefreshJobs();
            if(!connected && !expanded && (worker==null || worker.HasExited)) { lock(Json){
                if(cpu!=null){cpu.Dispose();cpu=null;}
                if(vram!=null){foreach(var c in vram)c.Dispose();vram=null;}
                if(!trimmed) {GC.Collect();EmptyWorkingSet(Process.GetCurrentProcess().Handle);trimmed=true;}
            }}
            else trimmed=false;
        };timer.Start();
        var dispatch=new Control();var handle=dispatch.Handle;
        panelSignal=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\ComfyBridgeOpenPanel");
        ThreadPool.RegisterWaitForSingleObject(panelSignal,(s,t)=>{if(!dispatch.IsDisposed)dispatch.BeginInvoke((Action)(()=>{ShowMonitor();CheckForRelease();}));},null,Timeout.Infinite,false);
    }
    static async Task Listen(System.Net.Sockets.TcpListener listener,bool encrypted) {
        while(true) {
            try {var client=await listener.AcceptTcpClientAsync();try{PrivateSocket(client.Client);}catch{client.Close();continue;}if(!connections.Wait(0)){client.Close();continue;}lock(sockets){if(!online || (listener!=server && listener!=tlsServer)){client.Close();connections.Release();continue;}sockets.Add(client);}var ignored=Task.Run(async ()=>{try{await Handle(client,encrypted);}finally{lock(sockets)sockets.Remove(client);connections.Release();}});}
            catch(System.Net.Sockets.SocketException){if(!online||(listener!=server && listener!=tlsServer))break;Thread.Sleep(200);}
            catch(ObjectDisposedException){break;}catch(InvalidOperationException){break;}
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
        if(extra!=null)foreach(string name in new[]{"Content-Range","Accept-Ranges","X-Preview-Revision"})if(extra[name]!=null)h.Append(name+": "+extra[name]+"\r\n");
        h.Append("\r\n");byte[] bytes=Encoding.ASCII.GetBytes(h.ToString());await stream.WriteAsync(bytes,0,bytes.Length);
    }
    static async Task Wake() {
        await starting.WaitAsync();
        try {
            await PrepareWorker();
            Interlocked.Increment(ref relays);
        } finally {starting.Release();}
    }
    static async Task PrepareWorker() {
            // Serve compatible endpoints on the old worker until its bridge jobs drain.
            // The GPU process has a separate lifetime and is never stopped by the handoff.
            try {using(var c=new System.Net.Sockets.TcpClient()){await c.ConnectAsync("127.0.0.1",18766);}
                if(worker!=null&&!worker.HasExited || DateTime.UtcNow<nextWorkerCheck)return;
                nextWorkerCheck=DateTime.UtcNow.AddSeconds(3);
                var monitor=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await MonitorJson());
                object build;object list;
                if(monitor.TryGetValue("build",out build)&&Convert.ToString(build)==Application.ProductVersion&&Convert.ToInt32(monitor["protocol"])>=15)return;
                if(!monitor.TryGetValue("jobs",out list)||((System.Collections.ICollection)list).Count!=0||Volatile.Read(ref relays)>0)return;
                var info=new ProcessStartInfo(python,"\""+Path.Combine(Home,"handoff.py")+"\""){WorkingDirectory=Home,UseShellExecute=false,CreateNoWindow=true};
                using(var handoff=Process.Start(info)){
                    await Task.Run((Action)handoff.WaitForExit);
                    if(handoff.ExitCode!=0)return;
                }
            }catch(System.Net.Sockets.SocketException){}
            catch(WebException e){if(e.Status!=WebExceptionStatus.ConnectFailure&&e.Status!=WebExceptionStatus.ConnectionClosed)throw;}
            if(worker==null || worker.HasExited) {
                worker=Process.Start(new ProcessStartInfo(python,"\""+Path.Combine(Home,"worker.py")+"\""){WorkingDirectory=Home,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden});
            }
            for(int i=0;i<80;i++) {
                try {using(var c=new System.Net.Sockets.TcpClient()){await c.ConnectAsync("127.0.0.1",18766);return;}}catch(System.Net.Sockets.SocketException){}
                await Task.Delay(100);
            }
            throw new Exception("Bridge worker could not start.");
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
            if(!online)return;
            string pathOnly=first[1];
            if(pathOnly=="/api/pair/begin" || pathOnly=="/api/pair/finish"){
                int count;string size;
                if(!encrypted||first[0]!="POST"||headers.ContainsKey("Transfer-Encoding")||!headers.TryGetValue("Content-Length",out size)||!int.TryParse(size,out count)||count<1||count>2048){await Reply(stream,400,"{}");return;}
                var data=new byte[count];for(int pos=0;pos<count;){int read=stream.Read(data,pos,count-pos);if(read<=0)return;pos+=read;}
                var ser=new JavaScriptSerializer();object result;int http=200;
                try{var d=ser.Deserialize<Dictionary<string,string>>(Encoding.UTF8.GetString(data));result=Pairing.Exchange(pathOnly.Substring(10),d,fingerprint,token);}
                catch(InvalidOperationException ex){result=new {error=ex.Message};http=409;}
                catch(ArgumentException ex){result=new {error=ex.Message};http=403;}
                await Reply(stream,http,ser.Serialize(result));return;
            }
            string auth;headers.TryGetValue("Authorization",out auth);
            if(!Equal(auth,"Bearer "+token)){await Reply(stream,401,"{\"error\":\"This phone is not paired. Open the PC panel and pair again.\"}");return;}
            string raw=first[1],path=raw.Split('?')[0];
            if(!path.StartsWith("/api/",StringComparison.Ordinal) || raw.Contains("..") || raw.Contains("\\")){await Reply(stream,404,"{}");return;}
            string device;Guid guid;bool identified=headers.TryGetValue("X-Bridge-Device",out device)&&Guid.TryParse(device,out guid);
            if(!identified)device=((IPEndPoint)client.Client.RemoteEndPoint).Address.ToString();
            if(path=="/api/disconnect"){lock(phones){phones.Remove(device);watchers.Remove(device);}await Reply(stream,200,"{}");return;}
            if(path=="/api/ping"){if(device!=desktopDevice){lock(phones)phones[device]=DateTime.UtcNow;}await Reply(stream,200,"{\"ok\":true,\"name\":\"Comfy Bridge\"}");return;}
            if(identified&&device!=desktopDevice&&path.StartsWith("/api/batch/")){lock(phones)watchers[device]=DateTime.UtcNow;}
            if(path=="/api/metrics"){await Reply(stream,200,Metrics());return;}
            string lengthText;long length=0;
            bool videoUpload=path=="/api/upload-video";
            long limit=(videoUpload?512L:55L)*1024*1024;
            if(headers.ContainsKey("Transfer-Encoding") || (headers.TryGetValue("Content-Length",out lengthText) && (!long.TryParse(lengthText,out length) || length<0 || length>limit))){await Reply(stream,413,"{\"error\":\"Invalid upload length\"}");return;}
            if(path.StartsWith("/api/studio/")){
                if(path.StartsWith("/api/studio/desktop-")){await Reply(stream,403,"{}");return;}
                if(!identified){await Reply(stream,403,"{\"error\":\"A paired phone is required.\"}");return;}
                await ReplyStudio(stream,path.Substring(12),device,length);return;
            }
            if(path=="/api/generate"&&first[0]=="POST"){
                var chatReply=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await StudioRequest("desktop-chat-yield","panel",""));
                if(Convert.ToInt32(chatReply["code"])!=200){await Reply(stream,503,new JavaScriptSerializer().Serialize(chatReply["data"]));return;}
            }
            await Wake();
            try {
            var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:18766"+raw);
            req.KeepAlive=false;
            req.Method=first[0];req.Headers["Authorization"]="Bearer "+token;req.Timeout=240000;req.ReadWriteTimeout=240000;req.Proxy=null;
            if(identified)req.Headers["X-Bridge-Device"]=device;
            string range;
            if(headers.TryGetValue("Range",out range)) {
                string[] halves=range.Replace("bytes=","").Split('-');long start,end;
                if(long.TryParse(halves[0],out start)){if(halves.Length>1 && long.TryParse(halves[1],out end))req.AddRange(start,end);else req.AddRange(start);}
            }
            if(first[0]=="POST") {
                req.ContentType=videoUpload?"application/octet-stream":"application/json";req.ContentLength=length;
                if(videoUpload){req.AllowWriteStreamBuffering=false;req.Timeout=900000;req.ReadWriteTimeout=900000;}
                using(var output=await req.GetRequestStreamAsync()) {
                    byte[] buffer=new byte[65536];long remaining=length;
                    while(remaining>0){int n=stream.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));if(n<=0)throw new IOException("Incomplete request");await output.WriteAsync(buffer,0,n);remaining-=n;}
                }
            }
            HttpWebResponse upstream;
            try {upstream=(HttpWebResponse)await req.GetResponseAsync();}
            catch(WebException ex){if(ex.Response==null)throw;upstream=(HttpWebResponse)ex.Response;}
            using(upstream){
                if(upstream.StatusCode==HttpStatusCode.OK && first[0]=="GET" &&
                   (path=="/api/status" || path=="/api/monitor" || path.StartsWith("/api/batch/"))){
                    using(var reader=new StreamReader(upstream.GetResponseStream())){
                        string body=await QueueResponse(await reader.ReadToEndAsync(),path.StartsWith("/api/batch/"));
                        await Reply(stream,200,body);return;
                    }
                }
                if(path=="/api/media-index" && first[0]=="GET" && upstream.StatusCode==HttpStatusCode.NotFound){
                    // A prior worker may still be rendering. Leave it running; read its index separately.
                    using(var p=Process.Start(new ProcessStartInfo(python,"\""+Path.Combine(Home,"media_index.py")+"\""){WorkingDirectory=Home,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true})){
                        string index=await p.StandardOutput.ReadToEndAsync();p.WaitForExit();
                        if(p.ExitCode!=0)throw new IOException("Could not read the PC media index.");
                        await Reply(stream,200,index);return;
                    }
                }
                await Headers(stream,(int)upstream.StatusCode,upstream.ContentType,upstream.ContentLength,upstream.Headers);
                using(var input=upstream.GetResponseStream())await input.CopyToAsync(stream);
            }
            }finally{Interlocked.Decrement(ref relays);}
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
