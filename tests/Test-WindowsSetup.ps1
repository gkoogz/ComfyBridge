param([Parameter(Mandatory)][string]$Setup)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$workspace = Join-Path (Split-Path $PSScriptRoot) 'build'
$test = Join-Path $workspace ('test-setup-' + [guid]::NewGuid().ToString('N'))
$oldLocal = $env:LOCALAPPDATA
$oldFailure = $env:COMFYBRIDGE_TEST_INIT_FAIL
New-Item -ItemType Directory -Path $test | Out-Null
try {
    $archive = Join-Path $test 'payload.zip'
    $payload = Join-Path $test 'payload'
    $assembly = [Reflection.Assembly]::LoadFile((Resolve-Path -LiteralPath $Setup).Path)
    $stream = $assembly.GetManifestResourceStream('ComfyBridge.Package')
    $file = [IO.File]::Create($archive)
    try { $stream.CopyTo($file) } finally { $file.Dispose(); $stream.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive,$payload)
    $manifest = Import-PowerShellDataFile (Join-Path $payload 'WindowsFiles.psd1')
    foreach ($file in ($manifest.App + $manifest.Setup)) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $file) -PathType Leaf)) { throw "Payload missing $file" }
    }
    if ((Get-ChildItem -LiteralPath $payload -File).Count -ne ($manifest.App.Count + $manifest.Setup.Count)) {
        throw 'Unexpected files in Setup payload'
    }

    $env:LOCALAPPDATA = Join-Path $test 'local'
    $env:COMFYBRIDGE_TEST_INIT_FAIL = '0'
    $data = Join-Path $env:LOCALAPPDATA 'ComfyBridge'
    $app = Join-Path $data 'app'
    $renderer = Join-Path $test 'renderer'
    $scripts = Join-Path $renderer 'venv/Scripts'
    New-Item -ItemType Directory -Path $scripts,$app -Force | Out-Null
    $python = Join-Path $scripts 'python.exe'
    $stub = Join-Path $test 'Fixture.cs'
    @'
static class Fixture {
    static int Main() {
        return System.Environment.GetEnvironmentVariable("COMFYBRIDGE_TEST_INIT_FAIL")=="1" ? 1 : 0;
    }
}
'@ | Set-Content -LiteralPath $stub
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe "/out:$python" $stub
    if ($LASTEXITCODE) { throw 'Fixture compilation failed' }
    $config = Join-Path $app 'config.json'
    @{comfyRoot=$renderer;comfyUrl='http://127.0.0.1:1'} | ConvertTo-Json | Set-Content -LiteralPath $config
    $configHash = (Get-FileHash -LiteralPath $config).Hash
    'saved-queue' | Set-Content -LiteralPath (Join-Path $data 'library.sqlite')
    'saved-chat' | Set-Content -LiteralPath (Join-Path $data 'chat.sqlite')

    # The installer copies real files. Stub launch and shell registration so the
    # test cannot replace or interact with the installed tray or its startup entry.
    function Get-Process {
        param([int]$Id,[string]$Name)
        if ($Id -eq $PID) { return Microsoft.PowerShell.Management\Get-Process -Id $PID }
        if ($Name -ne 'ComfyBridge') { throw 'Unexpected fixture process lookup' }
    }
    function New-ItemProperty { param($Path,$Name,$Value,$PropertyType,[switch]$Force) }
    function New-Object {
        param([string]$TypeName,[string]$ComObject)
        if (-not $ComObject) { return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName }
        $shell = [pscustomobject]@{}
        Add-Member -InputObject $shell -Name CreateShortcut -MemberType ScriptMethod -Value {
            param($Path)
            $link = [pscustomobject]@{TargetPath='';Arguments='';IconLocation=''}
            Add-Member -InputObject $link -Name Save -MemberType ScriptMethod -Value {}
            return $link
        }
        return $shell
    }
    function Start-Process {
        param($FilePath,$WindowStyle,[switch]$PassThru)
        if ($FilePath -ne (Join-Path $app 'ComfyBridge.exe')) { throw 'Unexpected setup launch path' }
        $proc = [pscustomobject]@{}
        Add-Member -InputObject $proc -Name WaitForExit -MemberType ScriptMethod -Value { param($Timeout) return $false }
        return $proc
    }

    & (Join-Path $payload 'Install.ps1')
    $installed = Join-Path $app 'ComfyBridge.exe'
    if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath (Join-Path $payload 'ComfyBridge.exe')).Hash) {
        throw 'Installed tray differs from payload'
    }
    if ((Get-FileHash -LiteralPath $config).Hash -ne $configHash -or
        (Get-Content -LiteralPath (Join-Path $data 'library.sqlite')) -ne 'saved-queue' -or
        (Get-Content -LiteralPath (Join-Path $data 'chat.sqlite')) -ne 'saved-chat') { throw 'User data changed' }

    $worker = Join-Path $app 'worker.py'
    'previous worker bytes' | Set-Content -LiteralPath $worker
    $env:COMFYBRIDGE_TEST_INIT_FAIL = '1'
    $failed = $false
    try { & (Join-Path $payload 'Install.ps1') } catch {
        if ($_.Exception.Message -notlike '*workspace storage*') { throw }
        $failed = $true
    }
    if (-not $failed -or (Get-Content -LiteralPath $worker) -ne 'previous worker bytes') { throw 'Update did not roll back' }
    'Windows Setup payload, upgrade data preservation, restart command and failure rollback passed.'
} finally {
    $env:LOCALAPPDATA = $oldLocal
    $env:COMFYBRIDGE_TEST_INIT_FAIL = $oldFailure
    $resolved = (Resolve-Path -LiteralPath $test).Path
    if ($resolved -eq $test -and (Split-Path -Parent $resolved) -eq $workspace) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
