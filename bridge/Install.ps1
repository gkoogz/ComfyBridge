$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'ComfyBridge\app'
New-Item -ItemType Directory -Force $target | Out-Null
$exe = Join-Path $target 'ComfyBridge.exe'
# Only replace this installation; the Python worker and queued Comfy jobs keep running.
Get-Process ComfyBridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { Stop-Process -Id $_.Id; $_.WaitForExit() }
foreach($file in 'ComfyBridge.exe','worker.py','workflows.py','extension.py','media_index.py','progress.py','queue_progress.py','studio.py'){
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target -Force
}
if (-not (Test-Path (Join-Path $target 'config.json'))) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Destination $target }
$studioRoot=(Get-Content -Raw -LiteralPath (Join-Path $target 'config.json')|ConvertFrom-Json).comfyRoot
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
