using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
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
        if(!on){online=false;Pairing.Close("Server is off.");seen=DateTime.MinValue;
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
    void RefreshState(){bool live=online&&(DateTime.UtcNow-seen).TotalSeconds<20;
        tray.Text=!online?"ComfyBridge · server off":live?"ComfyBridge · phone connected":"ComfyBridge · waiting for phone";
        if(badge==null)return;
        badge.Text=online?"●  Server on":"●  Server off";badge.ForeColor=online?Mint:Red;
        phone.Text=live?"●  Phone connected":"●  Phone disconnected";phone.ForeColor=live?Mint:Red;
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
            monitor=new Form{Text="ComfyBridge",Icon=tray.Icon,ClientSize=new Size(574,522),BackColor=Ink,ForeColor=Color.White,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedSingle,MaximizeBox=false,AutoScaleMode=AutoScaleMode.Dpi};
            monitor.FormClosing+=(s,e)=>{if(e.CloseReason==CloseReason.UserClosing){e.Cancel=true;monitor.Hide();Pairing.Close("Click New code to pair.");timer.Interval=5000;}};
            var grid=new TableLayoutPanel{Padding=new Padding(20,12,20,12),Dock=DockStyle.Fill,ColumnCount=1,RowCount=0,AutoScroll=true};
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));monitor.Controls.Add(grid);
            Add(grid,L("ComfyBridge",23,Color.White,true),48);
            badge=L("",11,Mint,true);badge.Dock=DockStyle.None;badge.Size=new Size(124,36);phone=L("",11,Red);phone.Dock=DockStyle.None;phone.Size=new Size(185,36);
            power=B("",(s,e)=>{try{Server(!online,true);}catch(Exception ex){MessageBox.Show(monitor,"Could not change server power: "+ex.Message);}});power.Image=PowerIcon();power.TextImageRelation=TextImageRelation.ImageBeforeText;Add(grid,Row(badge,phone,power),47);
            Add(grid,L("Pair your phone",15,Color.White,true),34);
            Add(grid,L("Open Bridge on your phone. Enter these two fields, then tap Pair & connect.",10,Muted),32);
            Add(grid,L("1   PC address",11,Mint,true),30);
            addressBox=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Font=new Font("Segoe UI",15),Width=400,AccessibleName="PC address"};
            Add(grid,Row(addressBox,B("Copy",(s,e)=>{if(addressBox.SelectedItem!=null)Clipboard.SetText(addressBox.SelectedItem.ToString());})),42);
            var remote=B("Set remote address…",(s,e)=>SetRemote());Add(grid,Row(remote),38);
            Add(grid,L("2   Pairing code",11,Mint,true),28);
            codeLabel=L("",24,Color.White,true);codeLabel.Dock=DockStyle.None;codeLabel.Size=new Size(188,48);codeLabel.AccessibleName="Pairing code";newCode=B("New code",(s,e)=>{if(online){Pairing.Issue();RefreshState();}});
            Add(grid,Row(codeLabel,newCode),54);codeHint=L("",10,Muted);Add(grid,codeHint,27);
            Add(grid,L("Generation",13,Color.White,true),36);jobText=L("No active generation",11,Muted);Add(grid,jobText,28);
            bar=new ProgressBar{Dock=DockStyle.Fill,Minimum=0,Maximum=100,Margin=new Padding(3,4,3,3)};Add(grid,bar,22);
        }
        if(!monitor.Visible){AddressesList();if(online)Pairing.Issue();monitor.Show();}
        monitor.WindowState=FormWindowState.Normal;monitor.Activate();timer.Interval=1400;RefreshState();RefreshJobs();
    }
    internal static string JobSummary(Dictionary<string,object> status,out int percent){
        percent=0;var jobs=((IEnumerable)status["jobs"]).Cast<Dictionary<string,object>>().ToList();
        var j=jobs.FirstOrDefault(z=>Convert.ToString(z["id"])==Convert.ToString(status["active"]))??jobs.FirstOrDefault(z=>Convert.ToString(z["status"])=="running")??jobs.Where(z=>new[]{"pending","submitting","cancelling"}.Contains(Convert.ToString(z["status"]))).OrderBy(z=>Convert.ToDouble(z["created"])).ThenBy(z=>Convert.ToInt32(z["ordinal"])).FirstOrDefault();
        if(j==null)return "No active generation";
        percent=Math.Max(0,Math.Min(100,(int)Math.Round(Convert.ToDouble(j["progress"])*100)));
        return String.Format("{0}  ·  {1}/{2}  ·  {3}  ·  {4}%   {5}",j["kind"],j["ordinal"],j["total"],j["status"],percent,j["current_node"]);
    }
    async void RefreshJobs(){
        var target=monitor;if(reading||target==null||target.IsDisposed||!target.Visible)return;reading=true;
        string caption;int progress=0;
        try{using(var c=new WebClient()){c.Headers["Authorization"]="Bearer "+token;
            string json=await c.DownloadStringTaskAsync("http://127.0.0.1:18766/api/monitor").ConfigureAwait(false);
            caption=JobSummary(new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json),out progress);}}
        catch(WebException ex){caption=ex.Status==WebExceptionStatus.ConnectFailure?"No active generation":"Generation status unavailable";}
        catch(Exception){caption="Generation status unavailable";}
        try{target.BeginInvoke((Action)(()=>{reading=false;if(!target.IsDisposed && target.Visible){jobText.Text=caption;bar.Value=progress;}}));}
        catch(InvalidOperationException){reading=false;}
    }
}
