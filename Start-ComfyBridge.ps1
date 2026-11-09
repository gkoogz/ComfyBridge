param([switch]$Background)
$ErrorActionPreference = 'Stop'
# Keep the installed path: Windows startup, firewall rules and updates use it.
# In the consolidated installation this directory links to local/data.
$exe = Join-Path $env:LOCALAPPDATA 'ComfyBridge\app\ComfyBridge.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'ComfyBridge is not installed. Install the Windows package first; see README.md.'
}
$launch = @{FilePath=$exe; WorkingDirectory=(Split-Path $exe); WindowStyle='Hidden'}
if (-not $Background) { $launch.ArgumentList = '--panel' }
Start-Process @launch
