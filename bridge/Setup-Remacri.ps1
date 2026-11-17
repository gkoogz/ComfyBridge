param([string]$ComfyRoot='E:\ComfyUI-Zluda')
$ErrorActionPreference='Stop'
# FoolhardyVEVO's original Remacri, linked by OpenModelDB; pinned HF revision and SHA-256.
$name='4x_foolhardy_Remacri.pth'
$expected='e1a73bd89c2da1ae494774746398689048b5a892bd9653e146713f9df8bca86a'
$url='https://huggingface.co/FacehugmanIII/4x_foolhardy_Remacri/resolve/cc321d560d74ac924feac463373b8fc4f59fee31/4x_foolhardy_Remacri.pth'
$folder=Join-Path $ComfyRoot 'models\upscale_models'
New-Item -ItemType Directory -Force $folder | Out-Null
$target=Join-Path $folder $name
if(Test-Path -LiteralPath $target){
 if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() -ne $expected){throw 'An existing Remacri file has a different hash; it was not overwritten.'}
 Write-Output 'Verified Remacri already installed.'
 exit 0
}
$partial=Join-Path $folder ($name+'.'+[guid]::NewGuid().ToString('N')+'.part')
try{
 Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
 if((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLower() -ne $expected){throw 'Remacri download failed SHA-256 verification.'}
 Move-Item -LiteralPath $partial -Destination $target
 Write-Output "Installed verified Remacri: $target"
}finally{if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial}}
