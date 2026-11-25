param([int]$WaitForTray, [string]$ComfyRoot)
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:LOCALAPPDATA 'ComfyBridge'
$target = Join-Path $data 'app'
$exe = Join-Path $target 'ComfyBridge.exe'
$updates = Join-Path $data 'updates'
$manifest = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'WindowsFiles.psd1')
$newConfig = Join-Path $PSScriptRoot 'config.json'
$config = Join-Path $target 'config.json'
$hasConfig = Test-Path -LiteralPath $config -PathType Leaf
if ($hasConfig) {
    $settings = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
} else {
    $settings = Get-Content -Raw -LiteralPath $newConfig | ConvertFrom-Json
    if ($ComfyRoot) {
        $settings.comfyRoot = $ComfyRoot
        $settings | ConvertTo-Json | Set-Content -LiteralPath $newConfig -Encoding UTF8
    }
}
$studioRoot = $settings.comfyRoot
$python = Join-Path $studioRoot 'venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "ComfyUI's Python environment was not found at $python." }

$files = @{}
foreach ($name in $manifest.App) {
    $files[(Join-Path $target $name)] = Join-Path $PSScriptRoot $name
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'desktop-assets') -File) {
    $files[(Join-Path $target ('desktop-assets/' + $file.Name))] = $file.FullName
}
if (-not $hasConfig) { $files[$config] = $newConfig }
foreach ($node in 'comfybridge_eros_vsa','comfybridge_checkpoint') {
    $files[(Join-Path $studioRoot ('custom_nodes/' + $node + '/__init__.py'))] = Join-Path $PSScriptRoot ($node + '.py')
}
foreach ($source in $files.Values) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Setup is missing $source." }
}

# Resolve junctions without matching other copies of the tray.
if (-not ('BridgeInstallPath' -as [type])) { Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class BridgeInstallPath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    public static string Resolve(string path) {
        using (var stream=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
            var result=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandle(stream.SafeFileHandle,result,(uint)result.Capacity,0);
            if(length==0||length>=result.Capacity)throw new IOException("Could not resolve "+path);
            return result.ToString();
        }
    }
}
"@
}

New-Item -ItemType Directory -Force $updates | Out-Null
$lock = [IO.File]::Open((Join-Path $updates 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$restart = $false
try {
    if ($WaitForTray) {
        $old = Get-Process -Id $WaitForTray -ErrorAction SilentlyContinue
        if ($old -and $old.ProcessName -eq 'ComfyBridge') {
            Wait-Process -Id $old.Id -Timeout 30 -ErrorAction Stop
        }
        $restart = $true
    }
    $here = (Get-Process -Id $PID).SessionId
    foreach ($old in Get-Process -Name ComfyBridge -ErrorAction SilentlyContinue | Where-Object SessionId -EQ $here) {
        if (-not $old.Path) { exit 23 }
        if ((Test-Path -LiteralPath $exe) -and [BridgeInstallPath]::Resolve($old.Path) -eq [BridgeInstallPath]::Resolve($exe)) {
            if ($WaitForTray) { throw 'ComfyBridge restarted before Setup could apply the update.' }
            Stop-Process -Id $old.Id -ErrorAction Stop
            $old.WaitForExit()
            $restart = $true
        } else { throw 'Close the other ComfyBridge installation in this Windows session before running Setup.' }
    }

    $chat = Join-Path $target 'chat.py'
    if (Test-Path -LiteralPath $chat) {
        $chatPath = [BridgeInstallPath]::Resolve($chat)
        # Retain existing local replies and queued quick edits. The GPU worker and
        # ComfyUI are separate processes and continue running throughout Setup.
        do {
            $active = Get-CimInstance Win32_Process -Filter "Name='python.exe' AND SessionId=$here" | Where-Object {
                if ($_.CommandLine -match '(?i)(?:"([^"]+\\chat\.py)"|(\S+\\chat\.py))\s+--run(?:\s|$)') {
                    $script = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
                    (Test-Path -LiteralPath $script) -and [BridgeInstallPath]::Resolve($script) -eq $chatPath
                }
            }
            if ($active) { Start-Sleep -Seconds 1 }
        } while ($active)
    }

    $rollback = New-Object 'System.Collections.Generic.Stack[object]'
    $backups = Join-Path $PSScriptRoot 'rollback'
    New-Item -ItemType Directory -Force $backups | Out-Null
    try {
        foreach ($entry in $files.GetEnumerator()) {
            if ((Test-Path -LiteralPath $entry.Key) -and
                (Get-FileHash -LiteralPath $entry.Key).Hash -eq (Get-FileHash -LiteralPath $entry.Value).Hash) { continue }
            $backup = $null
            if (Test-Path -LiteralPath $entry.Key) {
                $backup = Join-Path $backups ([string]$rollback.Count)
                Copy-Item -LiteralPath $entry.Key -Destination $backup
            }
            $rollback.Push(@{ Target=$entry.Key; Backup=$backup })
            New-Item -ItemType Directory -Force (Split-Path -Parent $entry.Key) | Out-Null
            Copy-Item -LiteralPath $entry.Value -Destination $entry.Key -Force
        }
        & $python (Join-Path $target 'studio.py') --init
        if ($LASTEXITCODE) { throw 'Could not initialize ComfyBridge workspace storage.' }
        $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $hasConfig -and $admin) { & (Join-Path $PSScriptRoot 'AllowNetwork.ps1') }
        New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ComfyBridge' -Value ('"'+$exe+'"') -PropertyType String -Force | Out-Null
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'ComfyBridge.lnk'))
        $shortcut.TargetPath=$exe
        $shortcut.Arguments='--panel'
        $shortcut.IconLocation="$exe,0"
        $shortcut.Save()
        $started = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
        $restart = $false
        if ($started.WaitForExit(1500)) {
            $restart = $hasConfig
            throw 'ComfyBridge exited during startup.'
        }
        'ComfyBridge is installed and running.'
    } catch {
        foreach ($file in $rollback) {
            if ($file.Backup) { Copy-Item -LiteralPath $file.Backup -Destination $file.Target -Force }
            elseif (Test-Path -LiteralPath $file.Target) { Remove-Item -LiteralPath $file.Target }
        }
        throw
    }
} finally {
    if ($restart -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe -WindowStyle Hidden }
    $lock.Dispose()
}
