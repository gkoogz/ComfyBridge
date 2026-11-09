using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

partial class Bridge {
    const string DesktopOrigin="https://desktop.comfybridge.local";
    static string desktopDevice;
    Control compactPanel;
    WebView2 desktop;
    bool expanded;
    System.Windows.Forms.Timer expansion;
    Rectangle compactBounds;
    static JavaScriptSerializer DesktopJson(){return new JavaScriptSerializer{MaxJsonLength=100000000};}
    static string DesktopDevice(){
        if(desktopDevice==null){
            string file=Path.Combine(Data,"desktop-id.txt");Guid id;
            desktopDevice=File.Exists(file)&&Guid.TryParse(File.ReadAllText(file),out id)?id.ToString():Guid.NewGuid().ToString();
            File.WriteAllText(file,desktopDevice);
        }
        return desktopDevice;
    }
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,int msg,IntPtr w,IntPtr l);
    void AnimatePanel(Rectangle target,Action done){
        if(expansion!=null){expansion.Stop();expansion.Dispose();}
        var start=monitor.Bounds;var clock=Stopwatch.StartNew();
        expansion=new System.Windows.Forms.Timer{Interval=15};
        expansion.Tick+=(s,e)=>{
            double t=Math.Min(1,clock.Elapsed.TotalMilliseconds/220),p=1-Math.Pow(1-t,3);
            monitor.Bounds=new Rectangle(start.X+(int)((target.X-start.X)*p),start.Y+(int)((target.Y-start.Y)*p),start.Width+(int)((target.Width-start.Width)*p),start.Height+(int)((target.Height-start.Height)*p));
            if(t>=1){expansion.Stop();expansion.Dispose();expansion=null;done();}
        };expansion.Start();
    }
    void ExpandDesktop(){
        if(expanded)return;expanded=true;compactBounds=monitor.Bounds;
        monitor.TopMost=false;monitor.ShowInTaskbar=true;compactPanel.Visible=false;
        var area=Screen.FromControl(monitor).WorkingArea;
        int w=Math.Min(1480,area.Width-24),h=Math.Min(960,area.Height-24);
        var target=new Rectangle(area.Left+(area.Width-w)/2,area.Top+(area.Height-h)/2,w,h);
        AnimatePanel(target,()=>{if(expanded)OpenDesktop();});
    }
    void CollapseDesktop(){
        if(!expanded)return;expanded=false;ReleaseDesktop();
        monitor.TopMost=true;monitor.ShowInTaskbar=false;
        AnimatePanel(compactBounds,()=>{compactPanel.Visible=true;DockPanel();RefreshState();});
    }
    void ReleaseDesktop(){
        if(desktop!=null){var old=desktop;desktop=null;old.Dispose();}
    }
    async void OpenDesktop(){
        var view=new WebView2{Dock=DockStyle.Fill,DefaultBackgroundColor=Ink};desktop=view;monitor.Controls.Add(view);view.BringToFront();
        try{
            var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Data,"desktop-webview"));
            if(desktop!=view||view.IsDisposed)return;
            await view.EnsureCoreWebView2Async(env);
            if(desktop!=view||view.IsDisposed)return;
            var web=view.CoreWebView2;
            web.Settings.AreDefaultContextMenusEnabled=false;web.Settings.AreDevToolsEnabled=false;web.Settings.IsStatusBarEnabled=false;
            web.Settings.AreHostObjectsAllowed=false;
            web.PermissionRequested+=(s,e)=>e.State=CoreWebView2PermissionState.Deny;
            web.NewWindowRequested+=(s,e)=>e.Handled=true;
            web.NavigationStarting+=(s,e)=>{if(e.Uri!=DesktopOrigin+"/index.html")e.Cancel=true;};
            web.FrameNavigationStarting+=(s,e)=>e.Cancel=true;
            web.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
            web.WebResourceRequested+=(s,e)=>DesktopResource(view,e);
            web.WebMessageReceived+=(s,e)=>DesktopMessage(view,e);
            var cfg=DesktopJson().Serialize(new{device=DesktopDevice(),name="This PC",paired=true,host="This PC",fingerprint="desktop-local"});
            await web.AddScriptToExecuteOnDocumentCreatedAsync("window.Desktop=true;window.desktopConfiguration="+cfg+";");
            web.Navigate(DesktopOrigin+"/index.html");
        }catch(Exception ex){
            if(desktop!=view)return;
            CollapseDesktop();
            MessageBox.Show(monitor,"Could not open the desktop studio. Install or repair Microsoft Edge WebView2 Runtime if it is missing.\n\n"+ex.Message,"ComfyBridge",MessageBoxButtons.OK,MessageBoxIcon.Error);
        }
    }
    object DesktopStatus(){
        string hint,code=Pairing.Display(out hint);
        return new{online=online,phones=PhoneCount(),code=code,hint=online?hint:"Turn the server on to pair a phone.",error=powerError,addresses=addressBox.Items.Cast<object>().Select(x=>x.ToString()).ToArray(),address=addressBox.Text};
    }
    async void DesktopMessage(WebView2 view,CoreWebView2WebMessageReceivedEventArgs e){
        if(desktop!=view||e.Source!=DesktopOrigin+"/index.html")return;
        int id=0;bool ok=true;object result=null;
        try{
            var msg=DesktopJson().Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);
            id=Convert.ToInt32(msg["id"]);string op=Convert.ToString(msg["op"]);
            var args=msg.ContainsKey("args")?(Dictionary<string,object>)msg["args"]:new Dictionary<string,object>();
            switch(op){
            case "request":result=await DesktopApi(Convert.ToString(args["path"]),Convert.ToString(args["method"]),Convert.ToString(args["body"]));break;
            case "local":result=await DesktopMedia(Convert.ToString(args["action"]),(Dictionary<string,object>)args["value"]);break;
            case "status":result=DesktopStatus();break;
            case "chatModels":result=await ChatControl("models","");break;
            case "chatSelect":result=await ChatControl("select",DesktopJson().Serialize(args));break;
            case "power":Server(Convert.ToBoolean(args["on"]),true);result=DesktopStatus();break;
            case "code":if(online)Pairing.Issue();RefreshState();result=DesktopStatus();break;
            case "address":SetRemote();result=DesktopStatus();break;
            case "copy":if(addressBox.Items.Contains(Convert.ToString(args["address"])))Clipboard.SetText(Convert.ToString(args["address"]));result=true;break;
            case "copyText":{string text=Convert.ToString(args["text"]);if(text.Length>1000000)throw new IOException("Text is too long to copy.");if(text.Length>0)Clipboard.SetText(text);result=true;break;}
            case "collapse":CollapseDesktop();return;
            case "hide":HidePanel();return;
            case "quit":HidePanel();return; // Legacy desktop assets: X also hides.
            case "drag":ReleaseCapture();SendMessage(monitor.Handle,0xA1,(IntPtr)2,IntPtr.Zero);return;
            default:throw new InvalidOperationException("Unknown desktop command.");
            }
        }catch(Exception ex){ok=false;result=ex.Message;}
        if(desktop==view&&!view.IsDisposed)view.CoreWebView2.PostWebMessageAsJson(DesktopJson().Serialize(new{id=id,ok=ok,value=result}));
    }
    static string SafeApiPath(string path){
        if(String.IsNullOrEmpty(path)||path.Contains("..")||path.Contains("\\")||path.Contains(":")||path.StartsWith("/")||path.Contains("#")||path.Any(c=>Char.IsControl(c)))throw new InvalidOperationException("Invalid bridge route.");
        return path;
    }
    static async Task<object> DesktopApi(string path,string method,string body){
        SafeApiPath(path);
        if(!online)throw new InvalidOperationException("The server is off. Turn it on in the left column.");
        string owner=DesktopDevice();
        // The local PC operator can manage all phones' jobs. This privilege is
        // never available through the authenticated phone HTTP interface.
        if(method=="POST"&&(path=="stop"||path=="skip"||path=="studio/rolling-skip")){
            var input=DesktopJson().Deserialize<Dictionary<string,object>>(body);
            var status=(Dictionary<string,object>)await DesktopApi("status","GET","");
            var key=path=="stop"?"batch":"id";
            var job=((IEnumerable)status["jobs"]).Cast<Dictionary<string,object>>().FirstOrDefault(j=>Convert.ToString(j[key])==Convert.ToString(input[key])&&LiveJob(j));
            if(job==null)throw new InvalidOperationException("That generation has already finished.");
            owner=Convert.ToString(job["owner"]);
        }
        var request=DesktopRequest(path,method,owner);
        if(method=="POST"){
            byte[] bytes=Encoding.UTF8.GetBytes(body);request.ContentType="application/json";request.ContentLength=bytes.Length;
            using(var stream=await request.GetRequestStreamAsync())await stream.WriteAsync(bytes,0,bytes.Length);
        }
        using(var response=await DesktopResponse(request))using(var reader=new StreamReader(response.GetResponseStream())){
            var text=await reader.ReadToEndAsync();var value=DesktopJson().DeserializeObject(text);
            if((int)response.StatusCode>=400){var error=value as Dictionary<string,object>;throw new IOException("HTTP "+(int)response.StatusCode+": "+(error!=null&&error.ContainsKey("error")?error["error"]:response.StatusDescription));}
            return value;
        }
    }
    static HttpWebRequest DesktopRequest(string path,string method,string owner=null){
        SafeApiPath(path);var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+loopbackPort+"/api/"+path);
        req.Proxy=null;req.KeepAlive=false;req.Method=method;req.Headers["Authorization"]="Bearer "+token;req.Headers["X-Bridge-Device"]=owner??DesktopDevice();req.Timeout=900000;req.ReadWriteTimeout=900000;return req;
    }
    static async Task<HttpWebResponse> DesktopResponse(HttpWebRequest request){
        try{return (HttpWebResponse)await request.GetResponseAsync();}catch(WebException ex){if(ex.Response==null)throw;return (HttpWebResponse)ex.Response;}
    }
    static async Task<string> DesktopFile(string id,bool thumb){
        Guid parsed;if(!Guid.TryParse(id,out parsed))throw new IOException("Invalid library item.");
        var reply=DesktopJson().Deserialize<Dictionary<string,object>>(await StudioRequest("desktop-file",DesktopDevice(),DesktopJson().Serialize(new{id=id,thumbnail=thumb})));
        var data=(Dictionary<string,object>)reply["data"];
        if(Convert.ToInt32(reply["code"])!=200)throw new IOException(Convert.ToString(data["error"]));
        return Convert.ToString(data["path"]);
    }
    async Task<object> DesktopMedia(string op,Dictionary<string,object> args){
        if(op=="list")return new object[0];
        if(op=="sync"){
            var rows=((IEnumerable)args["items"]).Cast<Dictionary<string,object>>().Where(x=>Convert.ToString(x["source"])=="available").ToArray();
            foreach(var row in rows){row["local"]=row["sha256"];row["recent"]=false;}
            return rows;
        }
        string path=op=="exportSource"?await DesktopSource(Convert.ToString(args["job"]),Convert.ToString(args["role"])):await DesktopFile(Convert.ToString(args["id"]),false);
        if(op=="fetch"){
            var manifest=(Dictionary<string,object>)await DesktopApi("media-index","GET","");
            var row=((IEnumerable)manifest["items"]).Cast<Dictionary<string,object>>().FirstOrDefault(x=>Convert.ToString(x["id"])==Convert.ToString(args["id"]));
            if(row==null||!row.ContainsKey("sha256"))throw new IOException("The original file is unavailable.");
            row["local"]=row["sha256"];row["recent"]=false;return row;
        }
        if(op=="reveal"){Process.Start("explorer.exe","/select,\""+path+"\"");return true;}
        if(op=="export"||op=="exportSource"){
            using(var dialog=new SaveFileDialog{FileName=Path.GetFileName(path),Filter="Media file|*"+Path.GetExtension(path),OverwritePrompt=true}){
                if(dialog.ShowDialog(monitor)!=DialogResult.OK)return false;
                if(String.Equals(Path.GetFullPath(dialog.FileName),Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new IOException("Choose a different location for the copy.");
                await Task.Run(()=>File.Copy(path,dialog.FileName,true));return true;
            }
        }
        throw new InvalidOperationException("Unsupported desktop media action.");
    }
    static async Task<string> DesktopSource(string job,string role){
        Guid parsed;if(!Guid.TryParse(job,out parsed))throw new IOException("Invalid source generation.");
        if(!new[]{"upload","mask","extension","upload-thumb","mask-thumb","extension-thumb"}.Contains(role))throw new IOException("Invalid source type.");
        var reply=DesktopJson().Deserialize<Dictionary<string,object>>(await StudioRequest("source-file/"+job+"/"+role,DesktopDevice(),""));
        if(!reply.ContainsKey("file"))throw new IOException(Convert.ToString(((Dictionary<string,object>)reply["data"])["error"]));
        return Convert.ToString(((Dictionary<string,object>)reply["file"])["path"]);
    }
    async void DesktopResource(WebView2 view,CoreWebView2WebResourceRequestedEventArgs e){
        var deferral=e.GetDeferral();
        try{
            var uri=new Uri(e.Request.Uri);var env=view.CoreWebView2.Environment;
            if(uri.GetLeftPart(UriPartial.Authority)!=DesktopOrigin){e.Response=env.CreateWebResourceResponse(Stream.Null,403,"Forbidden","");return;}
            string path=Uri.UnescapeDataString(uri.AbsolutePath);
            if(path.Contains("..")||path.Contains("\\"))throw new IOException("Invalid resource.");
            if(path.StartsWith("/local/")||path.StartsWith("/source/")){
                var parts=path.Split('/');bool source=path.StartsWith("/source/");if(parts.Length!=(source?4:5))throw new IOException("Invalid media resource.");
                string file=source?await DesktopSource(parts[2],parts[3]):await DesktopFile(parts[3],parts[2]=="thumb");
                var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
                long start=0,end=stream.Length-1;bool partial=false;
                if(e.Request.Headers.Contains("Range")){
                    string range=e.Request.Headers.GetHeader("Range");
                    if(!ParseDesktopRange(range,stream.Length,out start,out end)){stream.Dispose();e.Response=env.CreateWebResourceResponse(Stream.Null,416,"Range Not Satisfiable","");return;}
                    partial=true;
                }
                stream.Position=start;
                string headers="Content-Type: "+DesktopMime(file)+"\r\nAccept-Ranges: bytes\r\nContent-Length: "+(end-start+1)+"\r\nCache-Control: no-store\r\n";
                if(partial)headers+="Content-Range: bytes "+start+"-"+end+"/"+stream.Length+"\r\n";
                e.Response=env.CreateWebResourceResponse(new DesktopSlice(stream,end-start+1),partial?206:200,partial?"Partial Content":"OK",headers);return;
            }
            if(path.StartsWith("/preview")||path.StartsWith("/thumb/")||path=="/api/upload-video"){
                string route=path.StartsWith("/api/")?path.Substring(5):path.Substring(1);
                var req=DesktopRequest(route+uri.Query,e.Request.Method);
                if(e.Request.Method=="POST"){
                    if(route!="upload-video")throw new IOException("Unsupported upload.");
                    req.ContentType="application/octet-stream";req.AllowWriteStreamBuffering=false;req.ContentLength=Convert.ToInt64(e.Request.Headers.GetHeader("Content-Length"));
                    if(req.ContentLength>512L*1024*1024)throw new IOException("Video exceeds 512 MB.");
                    using(var output=await req.GetRequestStreamAsync())await e.Request.Content.CopyToAsync(output);
                }
                using(var response=await DesktopResponse(req)){
                    var bytes=new MemoryStream();using(var input=response.GetResponseStream())await input.CopyToAsync(bytes);bytes.Position=0;
                    string headers="Content-Type: "+response.ContentType+"\r\nCache-Control: no-store\r\n";
                    if(response.Headers["X-Preview-Revision"]!=null)headers+="X-Preview-Revision: "+response.Headers["X-Preview-Revision"]+"\r\n";
                    e.Response=env.CreateWebResourceResponse(bytes,(int)response.StatusCode,response.StatusDescription,headers);return;
                }
            }
            if(e.Request.Method!="GET")throw new IOException("Unsupported method.");
            string name=path.TrimStart('/');
            if(name.Contains("/")||!new[]{".html",".js",".css"}.Contains(Path.GetExtension(name)))throw new IOException("Unknown asset.");
            var asset=File.OpenRead(Path.Combine(Home,"desktop-assets",name));
            e.Response=env.CreateWebResourceResponse(asset,200,"OK","Content-Type: "+DesktopMime(name)+"\r\nContent-Security-Policy: default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'none'; object-src 'none'\r\n");
        }catch(Exception ex){if(!view.IsDisposed&&view.CoreWebView2!=null)e.Response=view.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(ex.Message)),404,"Unavailable","Content-Type: text/plain\r\n");}
        finally{try{deferral.Complete();}catch(System.Runtime.InteropServices.COMException){}catch(ObjectDisposedException){}}
    }
    internal static bool ParseDesktopRange(string range,long length,out long start,out long end){
        start=0;end=length-1;
        if(!range.StartsWith("bytes=")||range.Contains(","))return false;
        var halves=range.Substring(6).Split('-');long value;
        if(halves.Length!=2)return false;
        if(halves[0]==""){if(!long.TryParse(halves[1],out value)||value<=0)return false;start=Math.Max(0,length-value);}
        else{
            if(!long.TryParse(halves[0],out start)||start<0)return false;
            if(halves[1]!=""){if(!long.TryParse(halves[1],out value))return false;end=Math.Min(value,end);}
        }
        return start<=end&&start<length;
    }
    static string DesktopMime(string path){switch(Path.GetExtension(path).ToLowerInvariant()){
        case ".html":return "text/html; charset=utf-8";case ".js":return "text/javascript; charset=utf-8";case ".css":return "text/css; charset=utf-8";
        case ".png":return "image/png";case ".jpg":case ".jpeg":return "image/jpeg";case ".webp":return "image/webp";case ".webm":return "video/webm";case ".mp4":return "video/mp4";default:return "application/octet-stream";
    }}
    sealed class DesktopSlice:Stream {
        readonly Stream input;readonly long origin,length;long position;
        internal DesktopSlice(Stream input,long length){this.input=input;this.origin=input.Position;this.length=length;}
        public override bool CanRead{get{return true;}}public override bool CanSeek{get{return true;}}public override bool CanWrite{get{return false;}}
        public override long Length{get{return length;}}public override long Position{get{return position;}set{Seek(value,SeekOrigin.Begin);}}
        public override int Read(byte[] b,int o,int n){int read=input.Read(b,o,(int)Math.Min(n,length-position));position+=read;return read;}
        public override long Seek(long offset,SeekOrigin where){long next=where==SeekOrigin.Begin?offset:where==SeekOrigin.Current?position+offset:length+offset;if(next<0||next>length)throw new IOException("Outside media range.");input.Position=origin+next;return position=next;}
        public override void Flush(){}public override void SetLength(long n){throw new NotSupportedException();}public override void Write(byte[] b,int o,int n){throw new NotSupportedException();}
        protected override void Dispose(bool disposing){if(disposing)input.Dispose();base.Dispose(disposing);}
    }
}
