package com.comfybridge.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.view.View;
import android.widget.Toast;
import android.widget.FrameLayout;
import android.widget.*;


import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.security.cert.CertificateException;
import javax.net.ssl.*;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
 private WebView web;
 private final java.util.concurrent.atomic.AtomicReference<String> noticeRoute=new java.util.concurrent.atomic.AtomicReference<>("");
 private SharedPreferences prefs;
 private final ExecutorService io=Executors.newFixedThreadPool(4);
 private final ReleaseUpdates updates=new ReleaseUpdates();
 private final ExecutorService heartbeat=Executors.newSingleThreadExecutor();
 private ValueCallback<Uri[]> chooser;
 private final ExecutorService mediaIO=Executors.newSingleThreadExecutor();
 private MediaShelf shelf;
 private int exportRequest=-1;private String exportArgs;
 private synchronized MediaShelf shelf()throws Exception{
  String scope=prefs.getString("fingerprint","");if(!scope.matches("[a-fA-F0-9]{64}"))throw new IOException("Pair with the PC to set up the phone library.");
  File dir=new File(getFilesDir(),"originals/"+scope);
  if(shelf==null||!shelf.dir.equals(dir))shelf=new MediaShelf(dir,p->{if(!scope.equals(prefs.getString("fingerprint","")))throw new IOException("PC pairing changed.");return connection(p,"GET");});
  return shelf;
 }
 private static final String ORIGIN="https://appassets.androidplatform.net";
 @Override public void onCreate(Bundle b){
  super.onCreate(b);prefs=getSharedPreferences("connection",MODE_PRIVATE);readRoute(getIntent());
  getWindow().setStatusBarColor(Color.rgb(11,16,20));getWindow().setNavigationBarColor(Color.rgb(11,16,20));
  web=new WebView(this);web.setBackgroundColor(Color.rgb(11,16,20));FrameLayout root=new FrameLayout(this);root.addView(web,new FrameLayout.LayoutParams(-1,-1));setContentView(root);
  // Respect system bars, including Android 15 edge-to-edge enforcement.
  root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();});root.requestApplyInsets();
  if((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0)WebView.setWebContentsDebuggingEnabled(true);
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(true);s.setMediaPlaybackRequiresUserGesture(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  web.addJavascriptInterface(new NativeApi(),"Native");
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r){return !r.getUrl().toString().startsWith(ORIGIN+"/");}
   @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r){
    Uri uri=r.getUrl();if(!"appassets.androidplatform.net".equals(uri.getHost()))return response(403,"Forbidden","text/plain",new byte[0]);
    String path=uri.getPath();
    try{
     if(path.startsWith("/local/")){
      String[] parts=path.split("/");boolean thumb=parts.length==5&&parts[2].equals("thumb");
      if(parts.length!=5||(!thumb&&!parts[2].equals("image")&&!parts[2].equals("video")))return response(404,"Not Found","text/plain",new byte[0]);
      File f=shelf().existing(parts[3],parts[4],thumb);
      if(parts[2].equals("video"))return new WebResourceResponse("video/mp4",null,200,"OK",Collections.singletonMap("Content-Length",Long.toString(f.length())),new FileInputStream(f));
      return new WebResourceResponse(thumb?"image/jpeg":"image/png",null,new FileInputStream(f));
     }
     if(path.startsWith("/thumb/")||path.equals("/preview")||path.startsWith("/preview/")){
      String query=uri.getEncodedQuery();
      HttpURLConnection c=connection("api"+path+(query==null?"":"?"+query),"GET");String range=r.getRequestHeaders().get("Range");if(range!=null)c.setRequestProperty("Range",range);
      int code=c.getResponseCode();Map<String,String> headers=new HashMap<>();
      for(String h:new String[]{"Content-Length","Content-Range","Accept-Ranges","Cache-Control","X-Preview-Revision"})if(c.getHeaderField(h)!=null)headers.put(h,c.getHeaderField(h));
      String mime=c.getContentType();if(mime==null)mime="application/octet-stream";mime=mime.split(";")[0];
      InputStream stream=code>=400?c.getErrorStream():c.getInputStream();if(stream==null)stream=new ByteArrayInputStream(new byte[0]);
      final InputStream input=stream;
      return new WebResourceResponse(mime,null,code,c.getResponseMessage()==null?"Response":c.getResponseMessage(),headers,new FilterInputStream(input){@Override public void close()throws IOException{super.close();c.disconnect();}});
     }
     if(path.equals("/"))path="/index.html";
     if(!Arrays.asList("/index.html","/style.css","/app.js","/profile.js","/gallery.js","/gallery.css","/studio.css","/studio.js","/notepad.js","/live-image.js","/generator-controls.js","/generator.css").contains(path))return response(404,"Not Found","text/plain",new byte[0]);
     String mime=path.endsWith("css")?"text/css":path.endsWith("js")?"application/javascript":"text/html";
     return new WebResourceResponse(mime,"UTF-8",getAssets().open(path.substring(1)));
    }catch(Exception e){return response(503,"Unavailable","text/plain",new byte[0]);}
   }
  });
  web.setWebChromeClient(new WebChromeClient(){
   @Override public boolean onShowFileChooser(WebView w,ValueCallback<Uri[]> callback,FileChooserParams p){
    if(chooser!=null)chooser.onReceiveValue(null);chooser=callback;
    Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
    startActivityForResult(intent,100);return true;
   }
  });
  web.loadUrl(ORIGIN+"/index.html");
 }
 private WebResourceResponse response(int code,String reason,String mime,byte[] body){return new WebResourceResponse(mime,"UTF-8",code,reason,Collections.emptyMap(),new ByteArrayInputStream(body));}
 private HttpURLConnection connection(String path,String method)throws Exception{
  return connection(prefs,path,method);
 }
 static synchronized String device(SharedPreferences p){String id=p.getString("device","");if(id.isEmpty()){id=UUID.randomUUID().toString();p.edit().putString("device",id).commit();}return id;}
 static HttpURLConnection connection(SharedPreferences prefs,String path,String method)throws Exception{
  String host=prefs.getString("host","");if(host.isEmpty())throw new IOException("Enter your PC address first.");
  HttpURLConnection c=(HttpURLConnection)new URL(host+"/"+path).openConnection();c.setConnectTimeout(12000);c.setReadTimeout(Arrays.asList("api/ping","api/status","api/metrics","api/disconnect").contains(path)?12000:240000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+prefs.getString("key",""));
  final String pin=prefs.getString("fingerprint","");
  c.setRequestProperty("X-Bridge-Device",device(prefs));
  if(c instanceof HttpsURLConnection && !pin.isEmpty()){
   SSLContext context=SSLContext.getInstance("TLS");
   context.init(null,new TrustManager[]{new X509TrustManager(){
    public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
    public void checkClientTrusted(X509Certificate[] chain,String auth)throws CertificateException{throw new CertificateException("Client certificates not supported");}
    public void checkServerTrusted(X509Certificate[] chain,String auth)throws CertificateException{
     if(chain.length==0)throw new CertificateException("Missing PC certificate");
     chain[0].checkValidity();
     try{byte[] hash=MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());StringBuilder text=new StringBuilder();for(byte v:hash)text.append(String.format(Locale.ROOT,"%02X",v));
      if(!MessageDigest.isEqual(pin.getBytes(StandardCharsets.US_ASCII),text.toString().getBytes(StandardCharsets.US_ASCII)))throw new CertificateException("PC certificate does not match your pairing fingerprint");
     }catch(CertificateException e){throw e;}catch(Exception e){throw new CertificateException(e);}
    }
   }},null);
   ((HttpsURLConnection)c).setSSLSocketFactory(context.getSocketFactory());
   // Hostnames may be changing VPN IPs. The exact paired certificate is the identity.
   ((HttpsURLConnection)c).setHostnameVerifier((hostname,session)->true);
  }
  return c;
 }
 public class NativeApi {
  @JavascriptInterface public String notificationRoute(){return noticeRoute.getAndSet("");}
  @JavascriptInterface public String configuration(){
   JSONObject d=new JSONObject();try{String h=prefs.getString("host","");d.put("host",h);d.put("paired",h.startsWith("https://")&&!prefs.getString("key","").isEmpty());d.put("fingerprint",prefs.getString("fingerprint",""));d.put("device",device(prefs));d.put("name",android.os.Build.MODEL);}catch(Exception ignored){}return d.toString();
  }
  @JavascriptInterface public void sliderTick(){
   runOnUiThread(()->web.performHapticFeedback(android.os.Build.VERSION.SDK_INT>=34
       ? android.view.HapticFeedbackConstants.SEGMENT_FREQUENT_TICK : android.view.HapticFeedbackConstants.CLOCK_TICK));
  }
  @JavascriptInterface public void enableAlerts(){runOnUiThread(()->alerts(true));}
  @JavascriptInterface public void watchBatch(String batch){try{UUID.fromString(batch);JobWatch.track(MainActivity.this,batch);runOnUiThread(()->alerts(false));}catch(Exception ignored){}}
  @JavascriptInterface public void pair(int id,String address,String code){io.execute(()->{
   try{String host=Pairing.address(address);String[] secrets=new Pairing().run(host,code);
    if(!prefs.edit().putString("host",host).putString("key",secrets[0]).putString("fingerprint",secrets[1]).commit())throw new IOException("Could not save the pairing on this phone.");
    callback(id,true,"{}");
   }catch(Exception e){callback(id,false,friendly(e));}
  });}
  private String friendly(Exception e){
   if(e instanceof UnknownHostException)return "Address not found. Copy the PC address from the Windows panel, including its port.";
   if(e instanceof SocketTimeoutException)return "The PC did not respond. Check Server on, the address and port, and your PC’s VPN connection.";
   if(e instanceof SSLException){
    for(Throwable cause=e;cause!=null;cause=cause.getCause())
     if(cause instanceof CertificateException||cause instanceof SSLPeerUnverifiedException)return "Could not verify the PC’s identity. Check the address. If this is your PC, choose Pair again and use a new code.";
    return "The encrypted connection was interrupted. Check Server on and your VPN connection.";
   }
   if(e instanceof ConnectException||e instanceof NoRouteToHostException)return "Cannot reach the PC. Check Server on, the address and port, and the PC’s VPN or firewall.";
   return e.getMessage()==null?"Connection failed. Check the PC panel and try again.":e.getMessage();
  }
  private void callback(int id,boolean ok,String value){String js="window.bridgeResult("+id+","+ok+","+(ok?value:JSONObject.quote(value))+")";runOnUiThread(()->web.evaluateJavascript(js,null));}
  @JavascriptInterface public void request(int id,String path,String method,String body){("ping".equals(path)||"disconnect".equals(path)?heartbeat:io).execute(()->{
   boolean ok=false;String result;
   try{
    if(!path.matches("[a-zA-Z0-9_/-]+")||path.contains("..")||!Arrays.asList("GET","POST").contains(method))throw new IOException("Invalid request.");
    HttpURLConnection c=connection("api/"+path,method);
    try{if(method.equals("POST")){byte[] data=body.getBytes(StandardCharsets.UTF_8);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(data.length);try(OutputStream out=c.getOutputStream()){out.write(data);}}
     int code=c.getResponseCode();InputStream input=code>=400?c.getErrorStream():c.getInputStream();String text=read(input);if(code>=400){try{throw new IOException("HTTP "+code+": "+new JSONObject(text).optString("error",text));}catch(org.json.JSONException e){throw new IOException("HTTP "+code);}}
     result=text;ok=true;
    }finally{c.disconnect();}
   }catch(Exception e){result=friendly(e);}
   final String js="window.bridgeResult("+id+","+ok+","+(ok?result:JSONObject.quote(result))+")";
   runOnUiThread(()->web.evaluateJavascript(js,null));
  });}
  @JavascriptInterface public void localMedia(int request,String op,String args){
   if(op.equals("export")&&android.os.Build.VERSION.SDK_INT<29&&checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)!=android.content.pm.PackageManager.PERMISSION_GRANTED){
    runOnUiThread(()->{exportRequest=request;exportArgs=args;requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},104);});return;
   }
   mediaIO.execute(()->{try{
    MediaShelf m=shelf();JSONObject d=new JSONObject(args);String id=d.optString("id");Object result=new JSONObject();
    switch(op){
     case "list": result=m.snapshot();break;
     case "sync":m.reconcile(d);result=m.snapshot();break;
     case "fetch":result=m.obtain(id,false);break;
     case "replace":{JSONObject j=m.get(id);if(!j.getString("local").equals(d.getString("local"))||!j.getString("warning").equals("changed")||!j.getString("sha256").equals(d.getString("sha256")))throw new IOException("PC copy changed again. Check the library.");result=m.obtain(id,true);break;}
     case "drop":result=m.discard(id,d.getString("local"));break;

     case "export":m.export(MainActivity.this,id);break;
     default:throw new IOException("Unknown media action.");
    }callback(request,true,result.toString());
   }catch(Exception e){callback(request,false,friendly(e));}});
  }
 }
 private void readRoute(Intent i){String v=i.getStringExtra("view");if("queue".equals(v)||"library".equals(v))noticeRoute.set(v);i.removeExtra("view");}
 @Override protected void onNewIntent(Intent i){super.onNewIntent(i);setIntent(i);readRoute(i);if(web!=null)web.evaluateJavascript("window.openJobAlert?.()",null);}
 @Override public void onRequestPermissionsResult(int code,String[] names,int[] grants){super.onRequestPermissionsResult(code,names,grants);if(code==105){JobWatch.resume(this);return;}if(code==104&&exportRequest!=-1){int id=exportRequest;exportRequest=-1;if(grants.length>0&&grants[0]==android.content.pm.PackageManager.PERMISSION_GRANTED)new NativeApi().localMedia(id,"export",exportArgs);else new NativeApi().callback(id,false,"Camera roll access denied. Your private copy was kept.");}}
 static String read(InputStream input)throws IOException{if(input==null)return "";try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toString("UTF-8");}}
 private void alerts(boolean explicit){
  JobWatch.channels(this);
  if(android.os.Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=android.content.pm.PackageManager.PERMISSION_GRANTED){
   if(explicit&&prefs.getBoolean("askedAlerts",false)&&!shouldShowRequestPermissionRationale("android.permission.POST_NOTIFICATIONS")){startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,getPackageName()));return;}
   if(explicit||!prefs.getBoolean("askedAlerts",false)){prefs.edit().putBoolean("askedAlerts",true).apply();requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},105);}return;
  }
  JobWatch.resume(this);
  if(explicit){Intent i=new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,getPackageName());startActivity(i);}
 }
 @Override protected void onResume(){super.onResume();if(prefs!=null)JobWatch.resume(this);updates.foreground(this,io);}
 @Override protected void onPause(){updates.background();super.onPause();}
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
  if(request==100 && chooser!=null){chooser.onReceiveValue(result==RESULT_OK&&data!=null?new Uri[]{data.getData()}:null);chooser=null;}
 }
 @Override public void onBackPressed(){web.evaluateJavascript("bridgeBack()",null);}
 @Override protected void onDestroy(){heartbeat.shutdownNow();io.shutdownNow();mediaIO.shutdownNow();super.onDestroy();}
}
