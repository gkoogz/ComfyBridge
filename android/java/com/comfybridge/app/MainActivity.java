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
 private int statusInsetPx;
 private void applyStatusInset(){
  // WebView layout uses CSS pixels, while Android reports physical pixels.
  web.evaluateJavascript("document.documentElement.style.setProperty('--status-inset',("+
    statusInsetPx+"/window.devicePixelRatio)+'px')",null);
 }
 private final java.util.concurrent.atomic.AtomicReference<String> noticeRoute=new java.util.concurrent.atomic.AtomicReference<>("");
 private SharedPreferences prefs;
 private final ExecutorService io=Executors.newFixedThreadPool(4);
 private final ReleaseUpdates updates=new ReleaseUpdates();
 private final ExecutorService heartbeat=Executors.newSingleThreadExecutor();
 private ValueCallback<Uri[]> chooser;
 private volatile Uri pickedUri;
 private final ExecutorService mediaIO=Executors.newSingleThreadExecutor();
 private final ExecutorService prefetchIO=Executors.newSingleThreadExecutor();
 private volatile boolean foreground=false,prefetchAllowed=false;
 private final java.util.concurrent.atomic.AtomicLong prefetchEpoch=new java.util.concurrent.atomic.AtomicLong();
 private volatile HttpURLConnection prefetchConnection;
 private volatile HttpURLConnection listingPreviewConnection;
 private void stopListingPreviews(){
  HttpURLConnection c=listingPreviewConnection;listingPreviewConnection=null;
  if(c!=null)new Thread(()->c.disconnect(),"Stop listing preview").start();
  runOnUiThread(()->{if(web!=null)web.evaluateJavascript("if(window.ModelPreviews)ModelPreviews.pause();",null);});
 }
 private void stopPrefetch(){
  prefetchAllowed=false;prefetchEpoch.incrementAndGet();HttpURLConnection c=prefetchConnection;
  prefetchConnection=null;if(c!=null)new Thread(()->c.disconnect(),"Stop media prefetch").start();
 }
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
  getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
  getWindow().setStatusBarColor(Color.TRANSPARENT);
  if(android.os.Build.VERSION.SDK_INT>=29)getWindow().setStatusBarContrastEnforced(false);
  getWindow().setNavigationBarColor(Color.rgb(11,16,20));
  web=new WebView(this);web.setBackgroundColor(Color.rgb(11,16,20));FrameLayout root=new FrameLayout(this);root.addView(web,new FrameLayout.LayoutParams(-1,-1));setContentView(root);
  root.setOnApplyWindowInsetsListener((v,insets)->{
   v.setPadding(insets.getSystemWindowInsetLeft(),0,insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
   int top=insets.getSystemWindowInsetTop();
   if(top!=statusInsetPx){statusInsetPx=top;applyStatusInset();}
   return insets.consumeSystemWindowInsets();
  });root.requestApplyInsets();
  if((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0)WebView.setWebContentsDebuggingEnabled(true);
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(true);s.setMediaPlaybackRequiresUserGesture(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  web.addJavascriptInterface(new NativeApi(),"Native");
  web.setWebViewClient(new WebViewClient(){
   @Override public void onPageFinished(WebView view,String url){applyStatusInset();}
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
     if(path.startsWith("/source/")||path.startsWith("/model-preview/")||path.startsWith("/thumb/")||path.equals("/preview")||path.startsWith("/preview/")){
      boolean listingPreview=path.startsWith("/model-preview/");
      if(listingPreview&&!foreground)return response(503,"Paused","text/plain",new byte[0]);
      String query=uri.getEncodedQuery();
      HttpURLConnection c=connection((path.startsWith("/source/")?"api/studio/source-file/"+path.substring(8):"api"+path)+(query==null?"":"?"+query),"GET");String range=r.getRequestHeaders().get("Range");if(range!=null)c.setRequestProperty("Range",range);
      if(listingPreview){listingPreviewConnection=c;if(!foreground){stopListingPreviews();return response(503,"Paused","text/plain",new byte[0]);}}
      int code=c.getResponseCode();Map<String,String> headers=new HashMap<>();
      for(String h:new String[]{"Content-Length","Content-Range","Accept-Ranges","Cache-Control","X-Preview-Revision"})if(c.getHeaderField(h)!=null)headers.put(h,c.getHeaderField(h));
      String mime=c.getContentType();if(mime==null)mime="application/octet-stream";mime=mime.split(";")[0];
      InputStream stream=code>=400?c.getErrorStream():c.getInputStream();if(stream==null)stream=new ByteArrayInputStream(new byte[0]);
      final InputStream input=stream;
      return new WebResourceResponse(mime,null,code,c.getResponseMessage()==null?"Response":c.getResponseMessage(),headers,new FilterInputStream(input){@Override public void close()throws IOException{try{super.close();}finally{c.disconnect();if(listingPreviewConnection==c)listingPreviewConnection=null;}}});
     }
     if(path.equals("/"))path="/index.html";
     if(!Arrays.asList("/index.html","/style.css","/app.js","/profile.js","/gallery.js","/gallery.css","/studio.css","/studio.js","/notepad.js","/live-image.js","/generator-controls.js","/generator.css","/desktop.js","/desktop.css","/provenance.js","/chat.js","/quick-edit.js","/chat-format.js","/chat.css","/provenance.css","/model-cache.js","/model-browser.js","/model-browser.css").contains(path))return response(404,"Not Found","text/plain",new byte[0]);
     String mime=path.endsWith("css")?"text/css":path.endsWith("js")?"application/javascript":"text/html";
     return new WebResourceResponse(mime,"UTF-8",getAssets().open(path.substring(1)));
    }catch(Exception e){return response(503,"Unavailable","text/plain",new byte[0]);}
   }
  });
  web.setWebChromeClient(new WebChromeClient(){
   @Override public boolean onShowFileChooser(WebView w,ValueCallback<Uri[]> callback,FileChooserParams p){
    if(chooser!=null)chooser.onReceiveValue(null);chooser=callback;
    boolean videos=Arrays.stream(p.getAcceptTypes()).anyMatch(type->type.contains("video/"));
    Intent picker=new Intent("android.provider.action.PICK_IMAGES");
    if(!videos)picker.setType("image/*");
    try{startActivityForResult(picker,100);}
    catch(android.content.ActivityNotFoundException unavailable){
     Intent files=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
     files.setType(videos?"*/*":"image/*");
     if(videos)files.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/*","video/*"});
     startActivityForResult(files,100);
    }
    return true;
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
 String exportOperation="export";
 public class NativeApi {
  @JavascriptInterface public void openListing(String value){
   Uri uri=Uri.parse(value);if(!"https".equals(uri.getScheme())||!Arrays.asList("civitai.com","civitai.red","huggingface.co").contains(uri.getHost())||uri.getUserInfo()!=null||uri.getPort()!=-1)return;
   runOnUiThread(()->{try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}});
  }
  @JavascriptInterface public void copyText(String text){if(text==null||text.length()>1000000)return;runOnUiThread(()->{android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);clipboard.setPrimaryClip(android.content.ClipData.newPlainText("ComfyBridge response",text));});}
  @JavascriptInterface public void prefetchEnabled(boolean enabled){
   if(enabled&&foreground)prefetchAllowed=true;else if(prefetchAllowed||prefetchConnection!=null)stopPrefetch();
  }
  @JavascriptInterface public boolean listingPreviewsAllowed(){return foreground;}
  @JavascriptInterface public boolean pickedVideo(){
   Uri uri=pickedUri;
   String type=uri==null?null:getContentResolver().getType(uri);
   return type!=null && type.startsWith("video/");
  }
  @JavascriptInterface public void importVideo(int id,long size){
   final Uri uri=pickedUri;
   io.execute(()->{
    HttpURLConnection conn=null;
    File temp=null;
    try{
     if(uri==null||!"content".equals(uri.getScheme()))throw new IOException("Choose a video again.");
     final long limit=512L*1024*1024;
     long length=size;
     if(length>limit)throw new IOException("Choose a video up to 512 MiB.");
     if(length<=0){
      temp=File.createTempFile("import-",".video",getCacheDir());
      try(InputStream in=getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(temp)){
       copyVideo(in,out,limit);
      }
      length=temp.length();
     }
     if(length==0)throw new IOException("That video is empty.");
     conn=connection("api/upload-video","POST");
     conn.setDoOutput(true);conn.setFixedLengthStreamingMode(length);conn.setReadTimeout(900000);
     conn.setRequestProperty("Content-Type","application/octet-stream");
     try(InputStream in=temp==null?getContentResolver().openInputStream(uri):new FileInputStream(temp);
         OutputStream out=conn.getOutputStream()){copyVideo(in,out,length);}
     int code=conn.getResponseCode();
     String result=read(code>=400?conn.getErrorStream():conn.getInputStream());
     if(code>=400){
      String reason=code==404?"Update the Windows bridge to beta 20 for video imports.":"Video import failed.";
      try{reason=new JSONObject(result).optString("error",reason);}catch(org.json.JSONException ignored){}
      throw new IOException("HTTP "+code+": "+reason);
     }
     callback(id,true,new JSONObject(result).toString());
    }catch(Exception e){callback(id,false,friendly(e));}
    finally{if(conn!=null)conn.disconnect();if(temp!=null)temp.delete();}
   });
  }
  private void copyVideo(InputStream in,OutputStream out,long max)throws IOException{
   if(in==null)throw new IOException("The selected video could not be opened.");
   byte[] buffer=new byte[128*1024];long total=0;
   for(int n;(n=in.read(buffer))!=-1;){total+=n;if(total>max)throw new IOException("Video exceeds the upload size.");out.write(buffer,0,n);}
  }
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
   if((op.equals("export")||op.equals("exportSource"))&&android.os.Build.VERSION.SDK_INT<29&&checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)!=android.content.pm.PackageManager.PERMISSION_GRANTED){
    runOnUiThread(()->{exportRequest=request;exportArgs=args;exportOperation=op;requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},104);});return;
   }
   final long ticket=prefetchEpoch.get();
   (op.equals("prefetch")?prefetchIO:mediaIO).execute(()->{try{
    MediaShelf m=shelf();JSONObject d=new JSONObject(args);String id=d.optString("id");Object result=new JSONObject();
    switch(op){
     case "list": result=m.snapshot();break;
     case "sync":m.reconcile(d);result=m.snapshot();break;
     case "fetch":result=m.obtain(id,false);break;
     case "prefetch":{
      try{result=m.obtain(id,false,new MediaShelf.DownloadGuard(){
       public boolean allowed(){return foreground&&prefetchAllowed&&ticket==prefetchEpoch.get();}
       public void connection(HttpURLConnection c){prefetchConnection=c;c.setReadTimeout(15000);}
      });}catch(Exception e){if(!foreground||!prefetchAllowed||ticket!=prefetchEpoch.get())throw new InterruptedIOException("Prefetch paused.");throw e;}
      finally{prefetchConnection=null;}
      break;
     }
     case "replace":{JSONObject j=m.get(id);if(!j.getString("local").equals(d.getString("local"))||!j.getString("warning").equals("changed")||!j.getString("sha256").equals(d.getString("sha256")))throw new IOException("PC copy changed again. Check the library.");result=m.obtain(id,true);break;}
     case "drop":result=m.discard(id,d.getString("local"));break;

     case "export":m.export(MainActivity.this,id);break;
     case "exportSource":{
      String job=d.getString("job"),role=d.getString("role");UUID.fromString(job);
      if(!Arrays.asList("upload","mask","finalFrame","extension").contains(role))throw new IOException("Invalid source type.");
      HttpURLConnection conn=connection("api/studio/source-file/"+job+"/"+role,"GET");
      try{if(conn.getResponseCode()!=200)throw new IOException("The saved source is unavailable on the PC.");
       m.exportStream(MainActivity.this,conn.getInputStream(),role.equals("extension"),"ComfyBridge-source-"+job+"-"+role+(role.equals("extension")?".mp4":".png"));
      }finally{conn.disconnect();}break;
     }
     default:throw new IOException("Unknown media action.");
    }callback(request,true,result.toString());
   }catch(Exception e){callback(request,false,friendly(e));}});
  }
 }
 private void readRoute(Intent i){String v=i.getStringExtra("view");if("queue".equals(v)||"library".equals(v))noticeRoute.set(v);i.removeExtra("view");}
 @Override protected void onNewIntent(Intent i){super.onNewIntent(i);setIntent(i);readRoute(i);if(web!=null)web.evaluateJavascript("window.openJobAlert?.()",null);}
 @Override public void onRequestPermissionsResult(int code,String[] names,int[] grants){super.onRequestPermissionsResult(code,names,grants);if(code==105){JobWatch.resume(this);return;}if(code==104&&exportRequest!=-1){int id=exportRequest;exportRequest=-1;if(grants.length>0&&grants[0]==android.content.pm.PackageManager.PERMISSION_GRANTED)new NativeApi().localMedia(id,exportOperation,exportArgs);else new NativeApi().callback(id,false,"Camera roll access denied. Your private copy was kept.");}}
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
 @Override protected void onResume(){super.onResume();foreground=true;if(prefs!=null)JobWatch.resume(this);updates.foreground(this,io);if(web!=null)web.evaluateJavascript("if(typeof prefetchVisibility==='function'){prefetchVisibility();fillShelf();}",null);}
 @Override protected void onPause(){foreground=false;stopPrefetch();stopListingPreviews();updates.background();super.onPause();}
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
  if(request==100 && chooser!=null){
   pickedUri=result==RESULT_OK&&data!=null?data.getData():null;
   chooser.onReceiveValue(pickedUri==null?null:new Uri[]{pickedUri});chooser=null;
  }
 }
 @Override public void onBackPressed(){web.evaluateJavascript("bridgeBack()",null);}
 @Override protected void onDestroy(){foreground=false;stopPrefetch();stopListingPreviews();prefetchIO.shutdownNow();heartbeat.shutdownNow();io.shutdownNow();mediaIO.shutdownNow();super.onDestroy();}
}
