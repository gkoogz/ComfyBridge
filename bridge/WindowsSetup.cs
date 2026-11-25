using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

static class WindowsSetup {
    const string Caption = "ComfyBridge Setup";
    static readonly string Data = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"),"ComfyBridge");

    [STAThread] static int Main(string[] args) {
        int trayPid=0;
        if(args.Length!=0&&(args.Length!=2||args[0]!="--from-tray"||!Int32.TryParse(args[1],out trayPid)||trayPid<=0))return 2;
        Application.EnableVisualStyles();
        string comfyRoot=null;
        if(!File.Exists(Path.Combine(Data,"app","config.json"))&&!Directory.Exists(@"E:\ComfyUI-Zluda\venv")){
            using(var picker=new FolderBrowserDialog{Description="Choose the ComfyUI folder containing its Python environment.",ShowNewFolderButton=false}){
                if(picker.ShowDialog()!=DialogResult.OK)return 1;
                comfyRoot=picker.SelectedPath;
            }
        }
        int result=1;
        bool finished=false;
        using(var form=new Form{Text=Caption,ClientSize=new Size(410,115),StartPosition=FormStartPosition.CenterScreen,
            FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false,AutoScaleMode=AutoScaleMode.Dpi}){
            var label=new Label{Text="Installing ComfyBridge…\nAny active local chat will finish before files are replaced.",
                Dock=DockStyle.Fill,Padding=new Padding(14,14,14,0),Font=new Font("Segoe UI",10)};
            var progress=new ProgressBar{Dock=DockStyle.Bottom,Height=6,Style=ProgressBarStyle.Marquee,MarqueeAnimationSpeed=30};
            form.Controls.Add(label);form.Controls.Add(progress);
            form.FormClosing+=(s,e)=>{e.Cancel=!finished&&e.CloseReason==CloseReason.UserClosing;};
            form.Shown+=async(s,e)=>{
                try{result=await Task.Run(()=>Install(trayPid,comfyRoot));}
                catch(Exception ex){
                    MessageBox.Show(form,ex.Message,Caption,MessageBoxButtons.OK,MessageBoxIcon.Error);
                    finished=true;form.Close();return;
                }
                if(result==23){
                    var answer=MessageBox.Show(form,
                        "The previous ComfyBridge tray is running as administrator. Allow Setup to restart it, or close that tray icon and run Setup again.",
                        Caption,MessageBoxButtons.RetryCancel,MessageBoxIcon.Information);
                    if(answer==DialogResult.Retry){
                        try{
                            using(var retry=Process.Start(new ProcessStartInfo(Application.ExecutablePath){UseShellExecute=true,Verb="runas"})){
                                if(retry!=null)result=0;
                            }
                        }catch(Win32Exception ex){if(ex.NativeErrorCode!=1223)MessageBox.Show(form,ex.Message,Caption);}
                    }
                }else if(result!=0){
                    MessageBox.Show(form,"Setup couldn’t finish. Details are in:\n"+Path.Combine(Data,"updates","install.log"),
                        Caption,MessageBoxButtons.OK,MessageBoxIcon.Error);
                }
                finished=true;form.Close();
            };
            Application.Run(form);
        }
        return result;
    }

    static string Quote(string path){return "\""+path.TrimEnd(Path.DirectorySeparatorChar)+"\"";}

    static int Install(int trayPid,string comfyRoot){
        string updates=Path.Combine(Data,"updates");
        Directory.CreateDirectory(updates);
        string stage=Path.Combine(updates,"setup-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try{
            string archive=Path.Combine(stage,"payload.zip"),payload=Path.Combine(stage,"payload");
            using(var resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("ComfyBridge.Package"))
            using(var output=File.Create(archive)){
                resource.CopyTo(output);
            }
            ZipFile.ExtractToDirectory(archive,payload);
            string shell=Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe");
            string cmd="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Quote(Path.Combine(payload,"Install.ps1"));
            if(trayPid>0)cmd+=" -WaitForTray "+trayPid;
            if(comfyRoot!=null)cmd+=" -ComfyRoot "+Quote(comfyRoot);
            var info=new ProcessStartInfo(shell,cmd){WorkingDirectory=payload,UseShellExecute=false,CreateNoWindow=true,
                RedirectStandardOutput=true,RedirectStandardError=true};
            // The caller may be PowerShell 7 or have a custom module path.
            // Setup uses only modules shipped with Windows PowerShell 5.1.
            info.EnvironmentVariables["PSModulePath"]=Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\Modules");
            using(var process=Process.Start(info)){
                var stdout=process.StandardOutput.ReadToEndAsync();
                var stderr=process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                File.WriteAllText(Path.Combine(updates,"install.log"),stdout.GetAwaiter().GetResult()+"\r\n"+stderr.GetAwaiter().GetResult());
                return process.ExitCode;
            }
        }finally{try{Directory.Delete(stage,true);}catch(IOException){}catch(UnauthorizedAccessException){}}
    }
}
