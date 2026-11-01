using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

partial class Bridge {
    const string releasesApi="https://api.github.com/repos/gkoogz/ComfyBridge/releases";
    static readonly Regex releaseVersion=new Regex(@"\A(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?\z");
    DateTime lastReleaseCheck=DateTime.MinValue;
    bool checkingRelease;
    string lastOffered;

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

    internal sealed class PublishedAsset {public string name{get;set;} public string state{get;set;} public long size{get;set;}}
    internal sealed class PublishedRelease {public string tag_name{get;set;} public bool? draft{get;set;} public PublishedAsset[] assets{get;set;}}
    static string ZipName(string version){return "ComfyBridge-Windows-"+version+".zip";}
    internal static string SelectRelease(PublishedRelease[] releases,string best){
        foreach(var release in releases){
            if(release==null||release.draft!=false||release.assets==null||String.IsNullOrEmpty(release.tag_name)||!release.tag_name.StartsWith("v"))continue;
            string version=release.tag_name.Substring(1);
            if(!NewerRelease(version,best))continue;
            foreach(var asset in release.assets)if(asset!=null&&asset.name==ZipName(version)&&asset.state=="uploaded"&&asset.size>0){
                best=version;break;
            }
        }
        return best;
    }
    internal static string LookupRelease(string installed){
        // Older .NET Framework apps can default to protocols GitHub rejects.
        if((int)ServicePointManager.SecurityProtocol!=0)
            ServicePointManager.SecurityProtocol|=SecurityProtocolType.Tls12;
        string best=installed;
        var json=new JavaScriptSerializer{MaxJsonLength=16000000};
        for(int page=1;;page++){
            var request=(HttpWebRequest)WebRequest.Create(releasesApi+"?per_page=100&page="+page);
            request.UserAgent="ComfyBridge-Windows/"+installed;request.Accept="application/vnd.github+json";
            request.Timeout=5000;request.ReadWriteTimeout=7000;
            using(var response=(HttpWebResponse)request.GetResponse())
            using(var reader=new StreamReader(response.GetResponseStream())){
                var releases=json.Deserialize<PublishedRelease[]>(reader.ReadToEnd());
                best=SelectRelease(releases,best);
                if(releases.Length<100)return best;
            }
        }
    }
    async void CheckForRelease(){
        if(checkingRelease||(DateTime.UtcNow-lastReleaseCheck).TotalMinutes<5)return;
        checkingRelease=true;lastReleaseCheck=DateTime.UtcNow;
        try{
            string installed=Application.ProductVersion;
            string best=await Task.Run(()=>LookupRelease(installed));
            if(NewerRelease(best,installed)&&best!=lastOffered){lastOffered=best;ShowUpdateOffer(best);}
        }catch(Exception){ /* Offline, rate limited, or closing the tray: stay quiet. */ }
        finally{checkingRelease=false;}
    }
    internal static void ShowUpdateOffer(string version){
        var prompt=new Form{Text="ComfyBridge update available",ClientSize=new Size(376,132),
            StartPosition=FormStartPosition.Manual,FormBorderStyle=FormBorderStyle.FixedDialog,
            MaximizeBox=false,MinimizeBox=false,ShowInTaskbar=false,TopMost=true,BackColor=Ink,ForeColor=Color.White,AutoScaleMode=AutoScaleMode.Dpi};
        var message=new Label{Text="ComfyBridge "+version+" is available on GitHub. Download the Windows ZIP, extract it, and run Install.ps1 to update.",
            Dock=DockStyle.Fill,Padding=new Padding(14,12,14,0),Font=new Font("Segoe UI",10)};
        var buttons=new FlowLayoutPanel{Dock=DockStyle.Bottom,FlowDirection=FlowDirection.RightToLeft,Height=46,Padding=new Padding(4)};
        var download=B("Download ZIP",(s,e)=>{
            try{Process.Start(new ProcessStartInfo("https://github.com/gkoogz/ComfyBridge/releases/download/v"+version+"/"+ZipName(version)){UseShellExecute=true});prompt.Close();}
            catch(Exception){message.Text="Could not open GitHub in your browser. You can try Download ZIP again.";}
        });
        var later=B("Later",(s,e)=>prompt.Close());
        buttons.Controls.Add(download);buttons.Controls.Add(later);prompt.CancelButton=later;
        prompt.Controls.Add(message);prompt.Controls.Add(buttons);
        var area=Screen.FromPoint(Cursor.Position).WorkingArea;
        prompt.Location=new Point(area.Right-prompt.Width-8,area.Bottom-prompt.Height-8);
        prompt.Show();
    }
}
