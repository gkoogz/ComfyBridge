using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Threading.Tasks;
using System.Windows.Forms;

partial class Bridge {
    static readonly Color Ink=Color.FromArgb(17,23,29), Panel=Color.FromArgb(30,39,46), Mint=Color.FromArgb(151,239,197), Muted=Color.FromArgb(173,186,193), Red=Color.FromArgb(255,131,136);
    static volatile bool online;
    static int loopbackPort=18765, tlsPort=18764;
    static readonly HashSet<TcpClient> sockets=new HashSet<TcpClient>();
    readonly string remoteFile=Path.Combine(Data,"remote-address.txt"), offFile=Path.Combine(Data,"server-off");
    Label badge,phone,codeLabel,codeHint,jobText; Button power,newCode;
    string powerError;
    ComboBox addressBox; ProgressBar bar; bool reading;
    static Label L(string s,float pt,Color color,bool bold=false){return new Label{Text=s,UseMnemonic=false,ForeColor=color,Font=new Font("Segoe UI",pt,bold?FontStyle.Bold:FontStyle.Regular),Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,AutoEllipsis=true};}
    static Image PowerIcon(){var bmp=new Bitmap(20,20);using(var g=Graphics.FromImage(bmp))using(var pen=new Pen(Mint,2.2f)){g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;g.DrawArc(pen,3,4,14,14,-55,290);g.DrawLine(pen,10,1,10,10);}return bmp;}
    static Button B(string s,EventHandler action){var b=new Button{Text=s,AutoSize=true,MinimumSize=new Size(70,32),FlatStyle=FlatStyle.Flat,ForeColor=Color.White,BackColor=Panel,Font=new Font("Segoe UI",9)};b.FlatAppearance.BorderColor=Color.FromArgb(73,88,95);b.Click+=action;return b;}
    static FlowLayoutPanel Row(params Control[] cs){var row=new FlowLayoutPanel{Dock=DockStyle.Fill,WrapContents=false,Margin=Padding.Empty};foreach(var c in cs)row.Controls.Add(c);return row;}
    static void Add(TableLayoutPanel t,Control c,int height){int i=t.RowCount++;t.RowStyles.Add(new RowStyle(SizeType.Absolute,height));t.Controls.Add(c,0,i);}
    void Server(bool on,bool remember){
        powerError=null;
        if(!on){online=false;Pairing.Close("Server is off.");lock(phones){phones.Clear();watchers.Clear();}
            if(server!=null)server.Stop();if(tlsServer!=null)tlsServer.Stop();
            lock(sockets){foreach(var c in sockets)c.Close();}
        }else if(!online){
            var local=new TcpListener(IPAddress.Loopback,loopbackPort);var tls=new TcpListener(IPAddress.Any,tlsPort);
            int binding=loopbackPort;
            try{PrivateSocket(local.Server);PrivateSocket(tls.Server);local.Start();binding=tlsPort;tls.Start();}
            catch(SocketException e){local.Stop();tls.Stop();
                powerError=e.SocketErrorCode==SocketError.AddressAlreadyInUse?
                    "Port "+binding+" is already in use. Close the program using that port, then click Turn server on.":
                    "Cannot listen on TCP "+binding+": "+e.Message;
                RefreshState();return;
            }catch{local.Stop();tls.Stop();throw;}
            server=local;tlsServer=tls;online=true;
            Task.Run(()=>Listen(local,false));Task.Run(()=>Listen(tls,true));
            if(monitor!=null&&monitor.Visible)Pairing.Issue();
        }
        if(remember){if(on)File.Delete(offFile);else File.WriteAllText(offFile,"off");}
        RefreshState();
    }
    void RefreshState(){int count=PhoneCount();bool live=online&&count>0;
        tray.Text=!online?"ComfyBridge · server off":live?"ComfyBridge · "+count+(count==1?" phone connected":" phones connected"):"ComfyBridge · waiting for phone";
        if(badge==null)return;
        badge.Text=online?"●  Server on":"●  Server off";badge.ForeColor=online?Mint:Red;
        int bg;lock(phones)bg=watchers.Keys.Count(id=>!phones.ContainsKey(id));
        phone.Text=live?"●  "+count+(count==1?" phone":" phones")+(bg>0?" · "+bg+" in bg":" connected"):"●  No phones";phone.ForeColor=live?Mint:Red;
        power.Text=online?"Turn server off":"Turn server on";
        string hint;codeLabel.Text=Pairing.Display(out hint);codeLabel.AccessibleName="Pairing code "+codeLabel.Text;codeHint.Text=online?hint:powerError??"Turn the server on to pair.";codeHint.ForeColor=powerError!=null?Red:Muted;newCode.Enabled=online;
    }
    static bool ValidAddress(string s,out string clean){Uri u;clean=null;
        if(!Uri.TryCreate(s,UriKind.Absolute,out u)||u.Scheme!="https"||u.Host==""||u.AbsolutePath!="/"||u.UserInfo!=""||u.Query!=""||u.Fragment!="")return false;
        clean=u.GetLeftPart(UriPartial.Authority);return true;
    }
    void AddressesList(){
        addressBox.Items.Clear();string addr;
        if(File.Exists(remoteFile)&&ValidAddress(File.ReadAllText(remoteFile).Trim(),out addr))addressBox.Items.Add(addr);
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces().Where(n=>n.OperationalStatus==OperationalStatus.Up&&(n.NetworkInterfaceType==NetworkInterfaceType.Ethernet||n.NetworkInterfaceType==NetworkInterfaceType.Wireless80211)).OrderByDescending(n=>n.GetIPProperties().GatewayAddresses.Count>0))
            foreach(var a in nic.GetIPProperties().UnicastAddresses.Where(a=>a.Address.AddressFamily==AddressFamily.InterNetwork&&!IPAddress.IsLoopback(a.Address)&&!a.Address.ToString().StartsWith("169.254."))){
                addr="https://"+a.Address+":18764";if(!addressBox.Items.Contains(addr))addressBox.Items.Add(addr);
            }
        if(addressBox.Items.Count>0)addressBox.SelectedIndex=0;
    }
    void SetRemote(){using(var dlg=new Form{Text="Remote bridge address",ClientSize=new Size(440,150),StartPosition=FormStartPosition.CenterParent,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false}){
        var desc=new Label{Left=12,Top=10,Width=412,Height=36,Text="Enter the HTTPS address and external port from your VPN forwarding rule. Leave blank to use a local network address."};
        var field=new TextBox{Left=12,Top=54,Width=412,Text=File.Exists(remoteFile)?File.ReadAllText(remoteFile).Trim():""};
        var ok=new Button{Text="Save",Left=336,Top=90,Width=86};ok.Click+=(s,e)=>{string clean;if(field.Text.Trim()=="")File.Delete(remoteFile);else if(ValidAddress(field.Text.Trim(),out clean))File.WriteAllText(remoteFile,clean);else{MessageBox.Show(dlg,"Enter an HTTPS address, for example https://your-host:15294.");return;}dlg.DialogResult=DialogResult.OK;};
        dlg.Controls.AddRange(new Control[]{desc,field,ok});dlg.AcceptButton=ok;if(dlg.ShowDialog(monitor)==DialogResult.OK)AddressesList();
    }}
    void ShowMonitor(){
        if(monitor==null){
            monitor=new Form{Text="ComfyBridge",Icon=tray.Icon,ClientSize=new Size(438,340),BackColor=Ink,ForeColor=Color.White,ShowInTaskbar=false,TopMost=true,StartPosition=FormStartPosition.Manual,FormBorderStyle=FormBorderStyle.None,AutoScaleMode=AutoScaleMode.Dpi};
            monitor.SizeChanged+=(s,e)=>RoundPanel();RoundPanel();
            monitor.FormClosing+=(s,e)=>{Server(false,false);tray.Visible=false;Application.ExitThread();};
            var grid=new TableLayoutPanel{Padding=new Padding(14,8,14,8),Dock=DockStyle.Fill,ColumnCount=1,AutoScroll=true};grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));monitor.Controls.Add(grid);
            var head=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=3};head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));head.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,43));head.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,43));
            head.Controls.Add(L("ComfyBridge",15,Color.White,true),0,0);
            var hide=B("–",(s,e)=>HidePanel());hide.MinimumSize=Size.Empty;hide.AccessibleName="Hide to tray";head.Controls.Add(hide,1,0);
            var quit=B("×",(s,e)=>monitor.Close());quit.MinimumSize=Size.Empty;quit.AccessibleName="Quit ComfyBridge";head.Controls.Add(quit,2,0);Add(grid,head,36);
            badge=L("",10,Mint,true);badge.Dock=DockStyle.None;badge.Size=new Size(88,30);phone=L("",10,Red);phone.Dock=DockStyle.None;phone.Size=new Size(155,30);
            power=B("",(s,e)=>{try{Server(!online,true);}catch(Exception ex){MessageBox.Show(monitor,ex.Message);}});power.Image=PowerIcon();power.TextImageRelation=TextImageRelation.ImageBeforeText;Add(grid,Row(badge,phone,power),38);
            Add(grid,L("1   PC address",10,Mint,true),23);
            addressBox=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Font=new Font("Segoe UI",12),Width=270,AccessibleName="PC address"};
            var copy=B("Copy",(s,e)=>{if(addressBox.SelectedItem!=null)Clipboard.SetText(addressBox.SelectedItem.ToString());});copy.MinimumSize=Size.Empty;copy.AutoSize=false;copy.Size=new Size(55,29);
            var edit=B("Edit…",(s,e)=>SetRemote());edit.MinimumSize=Size.Empty;edit.AutoSize=false;edit.Size=new Size(55,29);Add(grid,Row(addressBox,copy,edit),36);
            Add(grid,L("2   Pairing code",10,Mint,true),23);
            codeLabel=L("",20,Color.White,true);codeLabel.Dock=DockStyle.None;codeLabel.Size=new Size(158,35);
            newCode=B("New code",(s,e)=>{if(online){Pairing.Issue();RefreshState();}});Add(grid,Row(codeLabel,newCode),39);
            codeHint=L("",9,Muted);Add(grid,codeHint,24);
            Add(grid,L("Generation",11,Color.White,true),23);jobText=L("No active generation",10,Muted);Add(grid,jobText,42);
            bar=new ProgressBar{Dock=DockStyle.Fill,Minimum=0,Maximum=100};Add(grid,bar,16);
        }
        if(!monitor.Visible){AddressesList();if(online)Pairing.Issue();monitor.Show();}
        DockPanel();
        monitor.WindowState=FormWindowState.Normal;monitor.Activate();timer.Interval=1400;RefreshState();RefreshJobs();
    }
    void HidePanel(){monitor.Hide();Pairing.Close("Click New code to pair.");timer.Interval=5000;}
    void RoundPanel(){int w=monitor.Width,h=monitor.Height,r=18;using(var p=new GraphicsPath()){
        p.AddArc(0,0,r,r,180,90);p.AddArc(w-r,0,r,r,270,90);p.AddArc(w-r,h-r,r,r,0,90);p.AddArc(0,h-r,r,r,90,90);p.CloseFigure();
        var old=monitor.Region;monitor.Region=new Region(p);if(old!=null)old.Dispose();
    }}
    void DockPanel(){var s=Screen.FromPoint(Cursor.Position);var a=s.WorkingArea;var bounds=s.Bounds;
        monitor.Location=new Point(a.Left>bounds.Left?a.Left+6:Math.Max(a.Left,a.Right-monitor.Width-6),
            a.Top>bounds.Top?a.Top+6:Math.Max(a.Top,a.Bottom-monitor.Height-6));}
    internal static string JobSummary(Dictionary<string,object> status,out int percent){
        percent=0;var jobs=((IEnumerable)status["jobs"]).Cast<Dictionary<string,object>>().ToList();
        var j=jobs.FirstOrDefault(z=>Convert.ToString(z["id"])==Convert.ToString(status["active"]))??jobs.FirstOrDefault(z=>Convert.ToString(z["status"])=="running")??jobs.Where(z=>new[]{"pending","submitting","cancelling"}.Contains(Convert.ToString(z["status"]))).OrderBy(z=>Convert.ToDouble(z["created"])).ThenBy(z=>Convert.ToInt32(z["ordinal"])).FirstOrDefault();
        if(j==null)return "No active generation";
        percent=Math.Max(0,Math.Min(99,(int)Math.Round(Convert.ToDouble(j["progress"])*100)));
        string stage=Convert.ToString(j["current_node"]);
        return String.Format("{0}  ·  Queue {1}/{2}  ·  {3}%   {4}\n{5}{6}",j["kind"],
            j.ContainsKey("queuePosition")?j["queuePosition"]:j["ordinal"],j.ContainsKey("queueTotal")?j["queueTotal"]:j["total"],percent,
            Convert.ToString(j["status"])+(status.ContainsKey("elapsed")?"  "+status["elapsed"]:""),
            stage==""?"Preparing workflow":stage,jobs.Count>1?"  ·  "+(jobs.Count-1)+" waiting":"");
    }
    // During an in-place upgrade the old worker still owns the running jobs.
    // Cache the DB-derived positions until its outstanding job IDs change.
    static readonly System.Threading.SemaphoreSlim countLock=new System.Threading.SemaphoreSlim(1,1);
    static string outstandingKey;
    static Dictionary<string,int[]> rollingCounts;
    static bool LiveJob(Dictionary<string,object> job){
        return new[]{"pending","submitting","running","cancelling"}.Contains(Convert.ToString(job["status"]));
    }
    static async Task<string> MonitorJson(){
        using(var client=new WebClient()){
            client.Proxy=null;client.Headers["Authorization"]="Bearer "+token;
            return await client.DownloadStringTaskAsync("http://127.0.0.1:18766/api/monitor").ConfigureAwait(false);
        }
    }
    static async Task<string> QueueResponse(string body,bool singleBatch){
        var serializer=new System.Web.Script.Serialization.JavaScriptSerializer();
        var response=serializer.Deserialize<Dictionary<string,object>>(body);
        if(Convert.ToInt32(response["protocol"])>=6)return body;
        var jobs=((IEnumerable)response["jobs"]).Cast<Dictionary<string,object>>().Where(LiveJob).ToArray();
        if(jobs.Length==0)return body;
        // The batch endpoint contains only the requesting phone's jobs. Use the
        // shared monitor privately for cache invalidation, never in its response.
        var shared=singleBatch?serializer.Deserialize<Dictionary<string,object>>(await MonitorJson()):response;
        var ids=((IEnumerable)shared["jobs"]).Cast<Dictionary<string,object>>().Where(LiveJob)
            .Select(j=>Convert.ToString(j["id"])).OrderBy(id=>id);
        string key=String.Join(",",ids);
        await countLock.WaitAsync().ConfigureAwait(false);
        try{
            if(rollingCounts==null||key!=outstandingKey){
                var start=new System.Diagnostics.ProcessStartInfo(python,"\""+Path.Combine(Home,"queue_progress.py")+"\""){
                    WorkingDirectory=Home,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};
                using(var proc=System.Diagnostics.Process.Start(start)){
                    string json=await proc.StandardOutput.ReadToEndAsync().ConfigureAwait(false);proc.WaitForExit();
                    if(proc.ExitCode!=0)throw new IOException("Could not read queue progress.");
                    rollingCounts=serializer.Deserialize<Dictionary<string,int[]>>(json);outstandingKey=key;
                }
            }
            foreach(var job in jobs){
                int[] count;
                if(rollingCounts.TryGetValue(Convert.ToString(job["id"]),out count)){
                    job["queuePosition"]=count[0];job["queueTotal"]=count[1];
                }
            }
        }finally{countLock.Release();}
        return serializer.Serialize(response);
    }
    async void RefreshJobs(){
        var target=monitor;if(reading||target==null||target.IsDisposed||!target.Visible)return;reading=true;
        string caption;int progress=0;
        try{
            string json=await QueueResponse(await MonitorJson().ConfigureAwait(false),false).ConfigureAwait(false);
            var serializer=new System.Web.Script.Serialization.JavaScriptSerializer();
            var status=serializer.Deserialize<Dictionary<string,object>>(json);
            string active=Convert.ToString(status["active"]);
            if(active!=""){
                var reply=serializer.Deserialize<Dictionary<string,object>>(await StudioRequest("clock/"+active,"panel","").ConfigureAwait(false));
                var clock=(Dictionary<string,object>)reply["data"];
                if(clock.ContainsKey("seconds")&&clock["seconds"]!=null){
                    var span=TimeSpan.FromSeconds(Convert.ToInt64(clock["seconds"]));
                    status["elapsed"]=(Convert.ToBoolean(clock["observed"])?"≥ ":"")+((int)span.TotalHours>0?((int)span.TotalHours)+":"+span.Minutes.ToString("00"):span.Minutes.ToString())+":"+span.Seconds.ToString("00");
                }
            }
            caption=JobSummary(status,out progress);
        }
        catch(WebException ex){caption=ex.Status==WebExceptionStatus.ConnectFailure?"No active generation":"Generation status unavailable";}
        catch(Exception){caption="Generation status unavailable";}
        try{target.BeginInvoke((Action)(()=>{reading=false;if(!target.IsDisposed && target.Visible){jobText.Text=caption;bar.Value=progress;}}));}
        catch(InvalidOperationException){reading=false;}
    }
}
