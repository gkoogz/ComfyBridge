param([string]$Screenshot)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$build=Join-Path $root 'build'
New-Item -ItemType Directory -Force $build | Out-Null
$exe=Join-Path $build 'PanelTests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /main:PanelTests "/out:$exe" "/win32icon:$root\artwork\comfybridge.ico" /reference:System.Numerics.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "$root\bridge\Tray.cs" "$root\bridge\Panel.cs" "$root\bridge\Pairing.cs" "$PSScriptRoot\PanelTests.cs"
if($LASTEXITCODE){throw 'Panel test compilation failed'}
if($Screenshot){& $exe $Screenshot}else{& $exe}
if($LASTEXITCODE){throw 'Panel tests failed'}
