$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'ComfyBridge\app'
New-Item -ItemType Directory -Force $target | Out-Null
$exe = Join-Path $target 'ComfyBridge.exe'
# Only replace this installation; the Python worker and queued Comfy jobs keep running.
Get-Process ComfyBridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { Stop-Process -Id $_.Id; $_.WaitForExit() }
# Let the previous chat protocol finish before accepting isolated quick-edit jobs.
# The generation worker/ComfyUI keep running throughout this installation.
$chatScript=Join-Path $target 'chat.py'
$announcedChatWait=$false
while(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($chatScript,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.Contains('--run') }){
    if(-not $announcedChatWait){Write-Output 'Waiting for the current local reply to finish before updating chat.';$announcedChatWait=$true}
    Start-Sleep -Seconds 1
}
foreach($file in 'ComfyBridge.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt','worker.py','workflows.py','extension.py','handoff.py','cancel_recovery.py','gpu_handoff.py','media_index.py','progress.py','queue_progress.py','queue_eta.py','studio.py','recipes.py','provenance.py','chat.py','quick_edit.py','install_chat.py','Setup-Chat.ps1'){
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target -Force
}
New-Item -ItemType Directory -Force (Join-Path $target 'desktop-assets') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'desktop-assets/*') (Join-Path $target 'desktop-assets') -Force
if (-not (Test-Path (Join-Path $target 'config.json'))) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Destination $target }
$studioRoot=(Get-Content -Raw -LiteralPath (Join-Path $target 'config.json')|ConvertFrom-Json).comfyRoot
$nodeFolder=Join-Path $studioRoot 'custom_nodes/comfybridge_eros_vsa'
New-Item -ItemType Directory -Force $nodeFolder | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'comfybridge_eros_vsa.py') -Destination (Join-Path $nodeFolder '__init__.py') -Force
$checkpointFolder=Join-Path $studioRoot 'custom_nodes/comfybridge_checkpoint'
New-Item -ItemType Directory -Force $checkpointFolder | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'comfybridge_checkpoint.py') -Destination (Join-Path $checkpointFolder '__init__.py') -Force
& (Join-Path $studioRoot 'venv\Scripts\python.exe') (Join-Path $target 'studio.py') --init
if($LASTEXITCODE){throw 'Could not initialize queue timers and workspace storage.'}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($admin){ & (Join-Path $PSScriptRoot 'AllowNetwork.ps1') }
else { Write-Warning 'Run AllowNetwork.ps1 as administrator once to allow phone connections through Windows Firewall.' }
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ComfyBridge' -Value ('"'+(Join-Path $target 'ComfyBridge.exe')+'"') -PropertyType String -Force |Out-Null
$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath("Programs")) "ComfyBridge.lnk"))
$shortcut.TargetPath=$exe
$shortcut.Arguments="--panel"
$shortcut.IconLocation="$exe,0"
$shortcut.Save()
Start-Process -FilePath (Join-Path $target 'ComfyBridge.exe') -WindowStyle Hidden
Write-Output 'Click the cube by the clock, or open ComfyBridge from Start, to see the address and pairing code.'
