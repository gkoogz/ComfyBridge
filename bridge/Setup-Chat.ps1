param([string]$ModelRoot='E:\ComfyBridge-LLM')
$ErrorActionPreference='Stop'
$config=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
$python=Join-Path $config.comfyRoot 'venv\Scripts\python.exe'
& $python (Join-Path $PSScriptRoot 'install_chat.py') --root $ModelRoot
if($LASTEXITCODE){throw 'Local chat setup did not finish. Run Setup-Chat.ps1 again to resume.'}
