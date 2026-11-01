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
 private SharedPreferences prefs;
 private final ExecutorService io=Executors.newFixedThreadPool(4);
 private ValueCallback<Uri[]> chooser;
 private String saveId,saveKind;
 private static final String ORIGIN="https://appassets.androidplatform.net";
 @Override public void onCreate(Bundle b){
  super.onCreate(b);prefs=getSharedPreferences("connection",MODE_PRIVATE);
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
     if(path.startsWith("/media/")||path.startsWith("/thumb/")||path.equals("/preview")){
      HttpURLConnection c=connection("api"+path,"GET");String range=r.getRequestHeaders().get("Range");if(range!=null)c.setRequestProperty("Range",range);
      int code=c.getResponseCode();Map<String,String> headers=new HashMap<>();
      for(String h:new String[]{"Content-Length","Content-Range","Accept-Ranges","Cache-Control"})if(c.getHeaderField(h)!=null)headers.put(h,c.getHeaderField(h));
      String mime=c.getContentType();if(mime==null)mime="application/octet-stream";mime=mime.split(";")[0];
      InputStream stream=code>=400?c.getErrorStream():c.getInputStream();if(stream==null)stream=new ByteArrayInputStream(new byte[0]);
      final InputStream input=stream;
      return new WebResourceResponse(mime,null,code,c.getResponseMessage()==null?"Response":c.getResponseMessage(),headers,new FilterInputStream(input){@Override public void close()throws IOException{super.close();c.disconnect();}});
     }
     if(path.equals("/"))path="/index.html";
     if(!Arrays.asList("/index.html","/style.css","/app.js").contains(path))return response(404,"Not Found","text/plain",new byte[0]);
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
  String host=prefs.getString("host","");if(host.isEmpty())throw new IOException("Enter your PC address first.");
  HttpURLConnection c=(HttpURLConnection)new URL(host+"/"+path).openConnection();c.setConnectTimeout(12000);c.setReadTimeout(240000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+prefs.getString("key",""));
  final String pin=prefs.getString("fingerprint","");
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
  @JavascriptInterface public String configuration(){JSONObject d=new JSONObject();try{d.put("host",prefs.getString("host","https://192.168.1.4:18764"));d.put("key",prefs.getString("key",""));d.put("fingerprint",prefs.getString("fingerprint",""));}catch(Exception ignored){}return d.toString();}
  @JavascriptInterface public void configure(String host,String key,String fingerprint){
   try{URL url=new URL(host);if(!Arrays.asList("http","https").contains(url.getProtocol())||url.getHost().isEmpty()||url.getUserInfo()!=null||(!url.getPath().isEmpty()&&!url.getPath().equals("/"))||url.getQuery()!=null||url.getRef()!=null)throw new Exception();
    String pin=fingerprint==null?"":fingerprint.replace(":","").replace(" ","").toUpperCase(Locale.ROOT);
    if(!pin.isEmpty()&&!pin.matches("[A-F0-9]{64}"))throw new Exception();
    prefs.edit().putString("host",host.replaceAll("/+$","")).putString("key",key).putString("fingerprint",pin).commit();
   }catch(Exception e){throw new IllegalArgumentException("Use a valid bridge URL and, for direct connections, the 64-character certificate fingerprint from your PC.");}
  }
  @JavascriptInterface public void request(int id,String path,String method,String body){io.execute(()->{
   boolean ok=false;String result;
   try{
    if(!path.matches("[a-zA-Z0-9_/-]+")||path.contains("..")||!Arrays.asList("GET","POST").contains(method))throw new IOException("Invalid request.");
    HttpURLConnection c=connection("api/"+path,method);
    try{if(method.equals("POST")){byte[] data=body.getBytes(StandardCharsets.UTF_8);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(data.length);try(OutputStream out=c.getOutputStream()){out.write(data);}}
     int code=c.getResponseCode();InputStream input=code>=400?c.getErrorStream():c.getInputStream();String text=read(input);if(code>=400){try{throw new IOException("HTTP "+code+": "+new JSONObject(text).optString("error",text));}catch(org.json.JSONException e){throw new IOException("HTTP "+code);}}
     result=text;ok=true;
    }finally{c.disconnect();}
   }catch(Exception e){result=e.getMessage()==null?"Connection failed":e.getMessage();}
   final String js="window.bridgeResult("+id+","+ok+","+(ok?result:JSONObject.quote(result))+")";
   runOnUiThread(()->web.evaluateJavascript(js,null));
  });}
  @JavascriptInterface public void saveMedia(String id,String kind){if(!id.matches("[a-f0-9]{32}"))return;runOnUiThread(()->{saveId=id;saveKind=kind;Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(kind.equals("video")?"video/mp4":"image/png");i.putExtra(Intent.EXTRA_TITLE,"ComfyBridge-"+id.substring(0,8)+(kind.equals("video")?".mp4":".png"));startActivityForResult(i,101);});}
 }
 private static String read(InputStream input)throws IOException{if(input==null)return "";try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toString("UTF-8");}}
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
  if(request==100 && chooser!=null){chooser.onReceiveValue(result==RESULT_OK&&data!=null?new Uri[]{data.getData()}:null);chooser=null;}
  if(request==101 && result==RESULT_OK && data!=null){Uri uri=data.getData();String id=saveId;io.execute(()->{try{HttpURLConnection c=connection("api/media/"+id,"GET");try{if(c.getResponseCode()!=200)throw new IOException("Download failed.");try(InputStream in=c.getInputStream();OutputStream out=getContentResolver().openOutputStream(uri)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);}}finally{c.disconnect();}runOnUiThread(()->Toast.makeText(this,"Saved to your phone",Toast.LENGTH_LONG).show());}catch(Exception e){runOnUiThread(()->Toast.makeText(this,e.getMessage(),Toast.LENGTH_LONG).show());}});}
 }
 @Override public void onBackPressed(){web.evaluateJavascript("(()=>{if(document.querySelector('#modal').open){closeModal();return;}if(document.querySelector('#drawer').classList.contains('open')){drawer(false);return;}navigate('bridge');})()",null);}
}
