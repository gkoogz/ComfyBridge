# Pinned SDK; Evergreen Runtime is supplied by Microsoft Edge/Windows.
$webviewVersion='1.0.4314.35'
$webviewHash='90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$webviewSdk=Join-Path $build "webview2-$webviewVersion"
if(-not(Test-Path "$webviewSdk\lib\net462\Microsoft.Web.WebView2.WinForms.dll")){
    $archive=Join-Path $build 'webview2.zip'
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webviewVersion/microsoft.web.webview2.$webviewVersion.nupkg" -OutFile $archive
    if((Get-FileHash $archive -Algorithm SHA256).Hash -ne $webviewHash){throw 'WebView2 SDK checksum mismatch'}
    Expand-Archive -LiteralPath $archive -DestinationPath $webviewSdk -Force
}
$webviewRefs=@("/reference:$webviewSdk\lib\net462\Microsoft.Web.WebView2.Core.dll","/reference:$webviewSdk\lib\net462\Microsoft.Web.WebView2.WinForms.dll")
Copy-Item "$webviewSdk\lib\net462\Microsoft.Web.WebView2.Core.dll","$webviewSdk\lib\net462\Microsoft.Web.WebView2.WinForms.dll","$webviewSdk\runtimes\win-x64\native\WebView2Loader.dll" -Destination $build -Force
Copy-Item "$webviewSdk\LICENSE.txt" "$build\WebView2-LICENSE.txt" -Force
