package com.comfybridge.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.widget.*;
import android.view.View;

/** Unprivileged website view: no bridge JavaScript interface or bridge credentials. */
public class ProfileActivity extends Activity {
 private WebView web;
 public static boolean validProfile(String value){
  if(value==null)return false;
  Uri u=Uri.parse(value);
  return "https".equals(u.getScheme())&&("civitai.com".equals(u.getHost())||"civitai.red".equals(u.getHost()))
   &&u.getUserInfo()==null&&u.getPort()==-1&&u.getPath()!=null&&u.getPath().startsWith("/user/");
 }
 @Override public void onCreate(Bundle state){
  super.onCreate(state);String url=getIntent().getStringExtra("url");
  if(!validProfile(url)){finish();return;}
  int dark=Color.rgb(11,16,20);
  getWindow().setStatusBarColor(dark);getWindow().setNavigationBarColor(dark);
  getWindow().getDecorView().setSystemUiVisibility(0);
  LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(dark);root.setFitsSystemWindows(true);
  root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
  LinearLayout bar=new LinearLayout(this);bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
  Button back=new Button(this);back.setText("‹ Back to ComfyBridge");back.setTextColor(Color.rgb(163,242,204));back.setAllCaps(false);back.setBackgroundColor(dark);back.setOnClickListener(v->finish());
  bar.addView(back,new LinearLayout.LayoutParams(-2,-1));
  TextView origin=new TextView(this);origin.setText("civitai.com");origin.setTextColor(Color.LTGRAY);origin.setTextSize(11);origin.setGravity(android.view.Gravity.RIGHT|android.view.Gravity.CENTER_VERTICAL);origin.setPadding(0,0,16,0);
  bar.addView(origin,new LinearLayout.LayoutParams(0,-1,1));root.addView(bar,new LinearLayout.LayoutParams(-1,(int)(52*getResources().getDisplayMetrics().density)));
  web=new WebView(this);web.setBackgroundColor(dark);
  WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return !"https".equals(request.getUrl().getScheme());}
   @Override public void onPageStarted(WebView view,String location,android.graphics.Bitmap icon){origin.setText(Uri.parse(location).getHost());}
  });
  // No Native object, custom resource interception, permission grants or TLS bypass.
  web.setWebChromeClient(new WebChromeClient());
  root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
  if(state==null)web.loadUrl(url);else web.restoreState(state);
 }
 @Override protected void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);if(web!=null)web.saveState(state);}
 @Override public void onBackPressed(){finish();}
 @Override protected void onDestroy(){if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
