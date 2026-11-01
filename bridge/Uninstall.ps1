$ErrorActionPreference = 'Stop'
Get-Process ComfyBridge -ErrorAction SilentlyContinue | Stop-Process
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ComfyBridge' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'ComfyBridge.lnk') -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Comfy Bridge TLS' -ErrorAction SilentlyContinue |Remove-NetFirewallRule
Write-Output 'Startup and network access removed. Library, settings, and outputs retained. Already queued jobs can finish.'
