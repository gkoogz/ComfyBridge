$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$b=Join-Path $root 'build\media-test'
$sdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools=Join-Path $sdk 'build-tools\35.0.1'
$android=Join-Path $sdk 'platforms\android-35\android.jar'
$adb=Join-Path $sdk 'platform-tools\adb.exe'
$keys=Join-Path $env:LOCALAPPDATA 'ComfyBridge\signing'
function Run($tool,[string[]]$arguments){& $tool @arguments;if($LASTEXITCODE){throw "$tool failed"}}
New-Item -ItemType Directory -Force "$b/classes","$b/dex" | Out-Null
$manifest='<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.comfybridge.shelftest"><uses-sdk android:minSdkVersion="29" android:targetSdkVersion="35"/><application android:label="ComfyBridge storage tests"/><instrumentation android:name="com.comfybridge.app.MediaShelfProbe" android:targetPackage="com.comfybridge.shelftest"/></manifest>'
[IO.File]::WriteAllText("$b/AndroidManifest.xml",$manifest)
Run javac.exe @('-encoding','UTF-8','-source','8','-target','8','-Xlint:-options','-classpath',$android,'-d',"$b/classes","$root/android/java/com/comfybridge/app/MediaShelf.java","$PSScriptRoot/MediaShelfProbe.java")
Run jar.exe @('cf',"$b/classes.jar",'-C',"$b/classes",'.')
Run "$tools/d8.bat" @('--lib',$android,'--min-api','29','--output',"$b/dex","$b/classes.jar")
Run "$tools/aapt.exe" @('package','-f','-M',"$b/AndroidManifest.xml",'-I',$android,'-F',"$b/test.apk")
Push-Location "$b/dex"
try{Run "$tools/aapt.exe" @('add',"$b/test.apk",'classes.dex')}finally{Pop-Location}
Run "$tools/zipalign.exe" @('-f','4',"$b/test.apk","$b/aligned.apk")
Run "$tools/apksigner.bat" @('sign','--ks',"$keys/release.jks",'--ks-pass',"file:$keys/password.txt",'--out',"$b/signed.apk","$b/aligned.apk")
Run $adb @('install','-r',"$b/signed.apk")
try{
 $out=& $adb shell am instrument -w com.comfybridge.shelftest/com.comfybridge.app.MediaShelfProbe
 $out
 if($LASTEXITCODE -or $out -notcontains 'INSTRUMENTATION_CODE: -1'){throw 'Android media tests failed'}
}finally{Run $adb @('uninstall','com.comfybridge.shelftest')}
