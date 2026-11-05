using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

partial class Bridge {
    static readonly SemaphoreSlim studioLock = new SemaphoreSlim(1,1);
    static Process studio;
    static readonly Timer studioIdle = new Timer(async unused => {
        await studioLock.WaitAsync().ConfigureAwait(false);
        try {
            if(studio!=null && DateTime.UtcNow-lastStudioUse>=TimeSpan.FromSeconds(45)) CloseStudio();
        } finally {studioLock.Release();}
    },null,Timeout.Infinite,Timeout.Infinite);
    static DateTime lastStudioUse;
    static void CloseStudio(){
        if(studio==null)return;
        try{studio.StandardInput.Close();}catch(IOException){}
        studio.Dispose();studio=null;
    }
    static async Task<string> StudioRequest(string route,string device,string payload){
        var json=new JavaScriptSerializer{MaxJsonLength=100000000};
        string line=json.Serialize(new {route=route,device=device,body=String.IsNullOrEmpty(payload)?null:json.DeserializeObject(payload)});
        await studioLock.WaitAsync().ConfigureAwait(false);
        try{
            if(studio==null||studio.HasExited){
                CloseStudio();
                studio=Process.Start(new ProcessStartInfo(python,"\""+Path.Combine(Home,"studio.py")+"\""){
                    WorkingDirectory=Home,CreateNoWindow=true,UseShellExecute=false,
                    RedirectStandardInput=true,RedirectStandardOutput=true
                });
            }
            byte[] bytes=Encoding.UTF8.GetBytes(line+"\n");
            await studio.StandardInput.BaseStream.WriteAsync(bytes,0,bytes.Length).ConfigureAwait(false);
            await studio.StandardInput.BaseStream.FlushAsync().ConfigureAwait(false);
            string reply=await studio.StandardOutput.ReadLineAsync().ConfigureAwait(false);
            if(reply==null)throw new IOException("PC workspace closed unexpectedly.");
            return reply;
        }catch{CloseStudio();throw;}
        finally{lastStudioUse=DateTime.UtcNow;studioIdle.Change(46000,Timeout.Infinite);studioLock.Release();}
    }
    static async Task ReplyStudio(Stream stream,string route,string device,long length){
        byte[] data=new byte[(int)length];
        for(int pos=0;pos<data.Length;){
            int n=await stream.ReadAsync(data,pos,data.Length-pos).ConfigureAwait(false);
            if(n==0)throw new EndOfStreamException();pos+=n;
        }
        string reply=await StudioRequest(route,device,Encoding.UTF8.GetString(data)).ConfigureAwait(false);
        var json=new JavaScriptSerializer{MaxJsonLength=100000000};
        var envelope=json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(reply);
        if(envelope.ContainsKey("file")){
            var file=(System.Collections.Generic.Dictionary<string,object>)envelope["file"];
            using(var input=new FileStream((string)file["path"],FileMode.Open,FileAccess.Read,FileShare.Read)){
                await Headers(stream,200,(string)file["mime"],input.Length,null);
                await input.CopyToAsync(stream);
            }
            return;
        }
        await Reply(stream,Convert.ToInt32(envelope["code"]),json.Serialize(envelope["data"]));
    }
}
