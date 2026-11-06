param([switch]$DebugBuild)
$ErrorActionPreference='Stop'
$src=$PSScriptRoot
& node (Join-Path $src 'tests/android-assets.cjs')
if($LASTEXITCODE){throw 'Android asset routing validation failed'}
$build=Join-Path $src 'build'
$sdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools=Join-Path $sdk 'build-tools\35.0.1'
$android=Join-Path $sdk 'platforms\android-35\android.jar'
$jdk=Split-Path (Get-Command java.exe).Source
New-Item -ItemType Directory -Force "$build\classes","$build\dex" |Out-Null
. "$src\bridge\WebView2.ps1"
New-Item -ItemType Directory -Force "$build\desktop-assets" | Out-Null
Copy-Item "$src\android\assets\*" "$build\desktop-assets" -Force
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /platform:x64 /optimize+ @webviewRefs "/win32icon:$src\artwork\comfybridge.ico" "/out:$build\ComfyBridge.exe" /reference:System.Numerics.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "$src\bridge\Tray.cs" "$src\bridge\Panel.cs" "$src\bridge\Studio.cs" "$src\bridge\ReleaseUpdates.cs" "$src\bridge\Pairing.cs" "$src\bridge\Desktop.cs"
if($LASTEXITCODE){throw 'Windows bridge compilation failed'}
& "$jdk\javac.exe" -encoding UTF-8 -source 8 -target 8 -Xlint:-options -classpath $android -d "$build\classes" "$src\android\java\com\comfybridge\app\MainActivity.java" "$src\android\java\com\comfybridge\app\MediaShelf.java" "$src\android\java\com\comfybridge\app\JobWatch.java" "$src\android\java\com\comfybridge\app\ReleaseUpdates.java" "$src\android\java\com\comfybridge\app\Pairing.java"
if($LASTEXITCODE){throw 'Android Java compilation failed'}
& "$jdk\jar.exe" cf "$build\classes.jar" -C "$build\classes" .
& "$tools\d8.bat" --lib $android --min-api 26 --output "$build\dex" "$build\classes.jar"
if($LASTEXITCODE){throw 'Android dex compilation failed'}
$manifest="$src\android\AndroidManifest.xml"
if($DebugBuild){New-Item -ItemType Directory -Force "$build\debug"|Out-Null;$manifest="$build\debug\AndroidManifest.xml";(Get-Content "$src\android\AndroidManifest.xml" -Raw).Replace('<application ','<application android:debuggable="true" ')|Set-Content $manifest}
& "$tools\aapt.exe" package -f -M $manifest -A "$src\android\assets" -S "$src\android\res" -I $android -F "$build\unsigned.apk"
if($LASTEXITCODE){throw 'Android resource packaging failed'}
Push-Location "$build\dex"
try{& "$tools\aapt.exe" add "$build\unsigned.apk" classes.dex}finally{Pop-Location}
& "$tools\zipalign.exe" -f 4 "$build\unsigned.apk" "$build\aligned.apk"
$keys=Join-Path $env:LOCALAPPDATA 'ComfyBridge\signing'
New-Item -ItemType Directory -Force $keys |Out-Null
if(-not(Test-Path "$keys\release.jks")){
 $bytes=New-Object byte[] 32
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose()
 [Convert]::ToBase64String($bytes)|Set-Content "$keys\password.txt" -NoNewline
 & "$jdk\keytool.exe" -genkeypair -keystore "$keys\release.jks" -storepass:file "$keys\password.txt" -keypass:file "$keys\password.txt" -alias comfybridge -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Comfy Bridge Personal Build'
}
& "$tools\apksigner.bat" sign --ks "$keys\release.jks" --ks-pass "file:$keys\password.txt" --out "$build\ComfyBridge.apk" "$build\aligned.apk"
if($LASTEXITCODE){throw 'APK signing failed'}
& "$tools\apksigner.bat" verify --verbose "$build\ComfyBridge.apk"
