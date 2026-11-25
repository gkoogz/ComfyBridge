$ErrorActionPreference = 'Stop'
$build = Join-Path $PSScriptRoot 'build'
$bridge = Join-Path $PSScriptRoot 'bridge'
$exe = Join-Path $build 'ComfyBridge.exe'
$version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
$manifest = Import-PowerShellDataFile (Join-Path $bridge 'WindowsFiles.psd1')
$stage = Join-Path $build ('setup-' + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'payload'
$archive = Join-Path $stage 'payload.zip'
New-Item -ItemType Directory -Path $payload | Out-Null
try {
    foreach ($name in ($manifest.App + $manifest.Setup)) {
        $source = if ($name -match '\.(exe|dll)$' -or $name -eq 'WebView2-LICENSE.txt') { $build } else { $bridge }
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $payload
    }
    New-Item -ItemType Directory -Path (Join-Path $payload 'desktop-assets') | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'android/assets') -File) {
        Copy-Item -LiteralPath (Join-Path $build ('desktop-assets/' + $file.Name)) -Destination (Join-Path $payload 'desktop-assets')
    }
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $archive
    $setup = Join-Path $build "ComfyBridge-Setup-$version.exe"
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$setup" "/resource:$archive,ComfyBridge.Package" `
        "/win32icon:$PSScriptRoot/artwork/comfybridge.ico" /reference:System.Windows.Forms.dll `
        /reference:System.Drawing.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $bridge 'WindowsSetup.cs')
    if ($LASTEXITCODE) { throw 'Windows setup compilation failed.' }
    Get-Item -LiteralPath $setup
} finally {
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if ($resolved -eq $stage -and (Split-Path -Parent $resolved) -eq $build) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
