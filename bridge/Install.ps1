$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'ComfyBridge\app'
New-Item -ItemType Directory -Force $target | Out-Null
$exe = Join-Path $target 'ComfyBridge.exe'
# Only replace this installation; the Python worker and queued Comfy jobs keep running.
Get-Process ComfyBridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { Stop-Process -Id $_.Id; $_.WaitForExit() }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ComfyBridge.exe'),(Join-Path $PSScriptRoot 'worker.py'),(Join-Path $PSScriptRoot 'workflows.py') -Destination $target -Force
if (-not (Test-Path (Join-Path $target 'config.json'))) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Destination $target }
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($admin){ & (Join-Path $PSScriptRoot 'AllowNetwork.ps1') }
else { Write-Warning 'Run AllowNetwork.ps1 as administrator once to allow phone connections through Windows Firewall.' }
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ComfyBridge' -Value ('"'+(Join-Path $target 'ComfyBridge.exe')+'"') -PropertyType String -Force |Out-Null
Start-Process -FilePath (Join-Path $target 'ComfyBridge.exe') -WindowStyle Hidden
Write-Output 'Comfy Bridge installed. Right-click its tray icon for addresses and pairing key.'
