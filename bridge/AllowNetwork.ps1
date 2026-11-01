$ErrorActionPreference='Stop'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'This one-time Windows Firewall change requires an administrator PowerShell window.'
}
if (-not (Get-NetFirewallRule -DisplayName 'Comfy Bridge TLS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Comfy Bridge TLS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18764 -Profile Any -Program (Join-Path $env:LOCALAPPDATA 'ComfyBridge\app\ComfyBridge.exe') -ErrorAction Stop | Out-Null
}
Write-Output 'Encrypted bridge connections allowed on TCP 18764 only. Pairing key and pinned certificate are required by the phone.'
