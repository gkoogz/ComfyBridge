param([string]$Python='E:\ComfyUI-Zluda\venv\Scripts\python.exe',[string]$FFmpeg='C:\Program Files\Shotcut\ffmpeg.exe')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$build=Join-Path $root 'build'
. "$root\bridge\WebView2.ps1"
$test=Join-Path $build 'DesktopSmoke'
New-Item -ItemType Directory -Force "$test\desktop-assets","$test\fixture\ComfyBridge","$test\fixture\root\output\ComfyBridge" | Out-Null
Copy-Item "$build\*.dll" $test -Force
Copy-Item "$root\android\assets\*" "$test\desktop-assets" -Force
Copy-Item "$root\bridge\*.py" $test -Force
@{comfyRoot="$test\fixture\root";comfyUrl='http://127.0.0.1:1'} | ConvertTo-Json | Set-Content "$test\config.json"
& $FFmpeg -nostdin -v error -y -f lavfi -i 'color=c=0x99ddcc:s=320x240:r=24:d=3' -c:v libx264 -pix_fmt yuv420p "$test\fixture\root\output\ComfyBridge\fixture.mp4"
if($LASTEXITCODE){throw 'Fixture video creation failed'}
@'
import sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1])/'fixture'
with sqlite3.connect(p/'ComfyBridge/library.sqlite') as db:
    db.execute('CREATE TABLE IF NOT EXISTS media(id,path,thumbnail)')
    db.execute('DELETE FROM media')
    db.execute('INSERT INTO media VALUES(?,?,?)',('3f59770998574a8c80c18ed7d02b5389',str(p/'root/output/ComfyBridge/fixture.mp4'),''))
'@ | & $Python - $test
if($LASTEXITCODE){throw 'Fixture database creation failed'}
$files=@('bridge/Tray.cs','bridge/Panel.cs','bridge/Studio.cs','bridge/ReleaseUpdates.cs','bridge/Pairing.cs','bridge/Desktop.cs','tests/DesktopTests.cs') | ForEach-Object {Join-Path $root $_}
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 @webviewRefs /main:DesktopTests "/out:$test\DesktopTests.exe" "/win32icon:$root\artwork\comfybridge.ico" /reference:System.Numerics.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll @files
if($LASTEXITCODE){throw 'Desktop test compilation failed'}
& "$test\DesktopTests.exe" $Python
if($LASTEXITCODE){throw 'Desktop integration tests failed'}
