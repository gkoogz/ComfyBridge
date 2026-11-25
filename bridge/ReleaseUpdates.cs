using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

partial class Bridge {
    const string releasesApi="https://api.github.com/repos/gkoogz/ComfyBridge/releases";
    static readonly Regex releaseVersion=new Regex(@"\A(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?\z");
    DateTime lastReleaseCheck=DateTime.MinValue;
    bool checkingRelease;
    bool installingRelease;
    string lastOffered;
    Form updateOffer;

    static int[] VersionParts(string version) {
        var m=releaseVersion.Match(version);
        if(!m.Success)return null;
        int[] parts=new int[5];
        for(int i=0;i<3;i++)if(!Int32.TryParse(m.Groups[i+1].Value,out parts[i]))return null;
        string channel=m.Groups[4].Value;
        parts[3]=channel==""?3:channel=="rc"?2:channel=="beta"?1:0;
        if(channel!=""&&!Int32.TryParse(m.Groups[5].Value,out parts[4]))return null;
        return parts;
    }
    internal static bool NewerRelease(string candidate,string current) {
        int[] a=VersionParts(candidate),b=VersionParts(current);
        if(a==null||b==null)return false;
        for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return a[i]>b[i];
        return false;
    }

    internal sealed class PublishedAsset {
        public string name{get;set;} public string state{get;set;} public long size{get;set;} public string digest{get;set;}
    }
    internal sealed class PublishedRelease {public string tag_name{get;set;} public bool? draft{get;set;} public PublishedAsset[] assets{get;set;}}
    internal sealed class WindowsUpdate {
        internal string Version;
        internal PublishedAsset Setup;
    }
    const long MaxSetupSize=64L*1024*1024;
    static string SetupName(string version){return "ComfyBridge-Setup-"+version+".exe";}
    internal static WindowsUpdate SelectRelease(PublishedRelease[] releases,string installed,WindowsUpdate best=null){
        foreach(var release in releases){
            if(release==null||release.draft!=false||release.assets==null||String.IsNullOrEmpty(release.tag_name)||!release.tag_name.StartsWith("v"))continue;
            string version=release.tag_name.Substring(1);
            if(!NewerRelease(version,best==null?installed:best.Version))continue;
            foreach(var asset in release.assets)if(asset!=null&&asset.name==SetupName(version)&&asset.state=="uploaded"
                &&asset.size>0&&asset.size<=MaxSetupSize&&Regex.IsMatch(asset.digest??"", @"\Asha256:[0-9a-fA-F]{64}\z")){
                best=new WindowsUpdate{Version=version,Setup=asset};break;
            }
        }
        return best;
    }
    internal static WindowsUpdate LookupRelease(string installed){
        // Older .NET Framework apps can default to protocols GitHub rejects.
        if((int)ServicePointManager.SecurityProtocol!=0)
            ServicePointManager.SecurityProtocol|=SecurityProtocolType.Tls12;
        WindowsUpdate best=null;
        var json=new JavaScriptSerializer{MaxJsonLength=16000000};
        for(int page=1;;page++){
            var request=(HttpWebRequest)WebRequest.Create(releasesApi+"?per_page=100&page="+page);
            request.UserAgent="ComfyBridge-Windows/"+installed;request.Accept="application/vnd.github+json";
            request.Timeout=5000;request.ReadWriteTimeout=7000;
            using(var response=(HttpWebResponse)request.GetResponse())
            using(var reader=new StreamReader(response.GetResponseStream())){
                var releases=json.Deserialize<PublishedRelease[]>(reader.ReadToEnd());
                best=SelectRelease(releases,installed,best);
                if(releases.Length<100||best!=null)return best;
            }
        }
    }
    async void CheckForRelease(bool requested=false){
        if(updateOffer!=null){if(requested)updateOffer.Activate();return;}
        if(checkingRelease||installingRelease||(!requested&&(DateTime.UtcNow-lastReleaseCheck).TotalMinutes<5))return;
        checkingRelease=true;lastReleaseCheck=DateTime.UtcNow;
        try{
            string installed=Application.ProductVersion;
            var best=await Task.Run(()=>LookupRelease(installed));
            if(best!=null&&(requested||best.Version!=lastOffered)){lastOffered=best.Version;ShowUpdateOffer(best);}
            else if(requested)MessageBox.Show("ComfyBridge is up to date.","ComfyBridge update");
        }catch(Exception){if(requested)MessageBox.Show("Couldn’t check for updates. Try again shortly.","ComfyBridge update");}
        finally{checkingRelease=false;}
    }
    internal static void CopyVerifiedSetup(Stream source,Stream output,PublishedAsset asset){
        var buffer=new byte[32768];
        long size=0;
        using(var hash=SHA256.Create()){
            for(int count;(count=source.Read(buffer,0,buffer.Length))!=0;){
                size+=count;
                if(size>asset.size||size>MaxSetupSize)throw new IOException("The update download has an unexpected size.");
                hash.TransformBlock(buffer,0,count,buffer,0);
                output.Write(buffer,0,count);
            }
            hash.TransformFinalBlock(new byte[0],0,0);
            string digest="sha256:"+BitConverter.ToString(hash.Hash).Replace("-","");
            if(size!=asset.size||!String.Equals(digest,asset.digest,StringComparison.OrdinalIgnoreCase))
                throw new IOException("The update could not be verified. Try downloading it again.");
        }
    }
    static string DownloadSetup(WindowsUpdate update){
        string folder=Path.Combine(Data,"updates");
        Directory.CreateDirectory(folder);
        string setup=Path.Combine(folder,"ComfyBridge-Setup.exe"),part=setup+".download";
        string url="https://github.com/gkoogz/ComfyBridge/releases/download/v"+update.Version+"/"+update.Setup.name;
        var request=(HttpWebRequest)WebRequest.Create(url);
        request.UserAgent="ComfyBridge-Windows/"+Application.ProductVersion;
        request.Timeout=15000;request.ReadWriteTimeout=15000;
        try{
            using(var response=request.GetResponse())
            using(var source=response.GetResponseStream())
            using(var output=new FileStream(part,FileMode.Create,FileAccess.Write,FileShare.None)){
                CopyVerifiedSetup(source,output,update.Setup);
                output.Flush(true);
            }
            if(File.Exists(setup))File.Replace(part,setup,null);
            else File.Move(part,setup);
            return setup;
        }finally{if(File.Exists(part))File.Delete(part);}
    }
    void ShowUpdateOffer(WindowsUpdate update){
        var prompt=new Form{Text="ComfyBridge update",ClientSize=new Size(404,142),
            StartPosition=FormStartPosition.Manual,FormBorderStyle=FormBorderStyle.FixedDialog,
            MaximizeBox=false,MinimizeBox=false,ShowInTaskbar=false,TopMost=true,BackColor=Ink,ForeColor=Color.White,AutoScaleMode=AutoScaleMode.Dpi};
        updateOffer=prompt;
        prompt.FormClosed+=(s,e)=>updateOffer=null;
        var message=new Label{Text="ComfyBridge "+update.Version+" is available. The app will restart when the update is applied.",
            Dock=DockStyle.Fill,Padding=new Padding(14,12,14,0),Font=new Font("Segoe UI",10)};
        var buttons=new FlowLayoutPanel{Dock=DockStyle.Bottom,FlowDirection=FlowDirection.RightToLeft,Height=46,Padding=new Padding(4)};
        var download=B("Install update",null);
        var later=B("Later",(s,e)=>prompt.Close());
        prompt.FormClosing+=(s,e)=>{if(installingRelease&&e.CloseReason==CloseReason.UserClosing)e.Cancel=true;};
        download.Click+=async(s,e)=>{
            installingRelease=true;download.Enabled=false;later.Enabled=false;
            message.Text="Downloading and verifying the update…";
            try{
                string setup=await Task.Run(()=>DownloadSetup(update));
                using(var me=Process.GetCurrentProcess())
                using(var installer=Process.Start(new ProcessStartInfo(setup,"--from-tray "+me.Id){UseShellExecute=false})){
                    if(installer==null)throw new IOException("Could not start ComfyBridge Setup.");
                }
            }catch(Exception ex){
                message.Text=ex is IOException?ex.Message:"Could not start the update. Try again.";
                installingRelease=false;download.Enabled=true;later.Enabled=true;return;
            }
            Server(false,false);tray.Visible=false;ExitThread();
        };
        buttons.Controls.Add(download);buttons.Controls.Add(later);prompt.CancelButton=later;
        prompt.Controls.Add(message);prompt.Controls.Add(buttons);
        var area=Screen.FromPoint(Cursor.Position).WorkingArea;
        prompt.Location=new Point(area.Right-prompt.Width-8,area.Bottom-prompt.Height-8);
        prompt.Show();
    }
}
