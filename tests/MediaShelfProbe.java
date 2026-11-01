package com.comfybridge.app;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;

/** Runs in its own test package on Android; never opens the user's library. */
public class MediaShelfProbe extends Instrumentation {
 @Override public void onCreate(Bundle b){super.onCreate(b);start();}
 @Override public void onStart(){Bundle report=new Bundle();int result=Activity.RESULT_OK;
  try{exercise();report.putString("checks","100 mixed originals, older on-demand, corrupt transfer, changed/missing retention, restart, camera-roll bytes, explicit removal");}
  catch(Throwable e){result=Activity.RESULT_CANCELED;report.putString("error",e.toString());}
  finish(result,report);
 }
 static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
 static String id(int n){return String.format(Locale.ROOT,"%032x",n);}
 static String sha(byte[] b)throws Exception{return MediaShelf.hex(MessageDigest.getInstance("SHA-256").digest(b));}
 static byte[] png(int color){Bitmap b=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);b.eraseColor(color);ByteArrayOutputStream out=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);b.recycle();return out.toByteArray();}
 static JSONObject fixture(int n,byte[] bytes)throws Exception{return new JSONObject().put("id",id(n)).put("kind",n%2==0?"image":"video").put("archived",n%4==0?1:0).put("source","available").put("size",bytes.length).put("created",1000-n).put("sha256",sha(bytes));}
 void exercise()throws Exception{
  final byte[] original=png(0xffaa3322),replacement=png(0xff1177bb);final byte[][] wire={original};
  Context ctx=getTargetContext();File root=Files.createTempDirectory(ctx.getFilesDir().toPath(),"probe-").toFile();
  MediaShelf.Network net=path->new HttpURLConnection(new URL("http://invalid.test/")){
   public int getResponseCode(){return 200;}public InputStream getInputStream(){return new ByteArrayInputStream(wire[0]);}
   public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
  };
  MediaShelf m=new MediaShelf(root,net);JSONArray items=new JSONArray();for(int n=0;n<101;n++)items.put(fixture(n,original));
  JSONObject index=new JSONObject().put("version",1).put("items",items);m.reconcile(index);
  int recent=0;for(int i=0;i<101;i++)if(m.get(id(i)).getBoolean("recent"))recent++;
  check(recent==100&&!m.get(id(100)).getBoolean("recent"),"mixed media shares one limit");
  String h=m.obtain(id(0),false).getString("local");check(!h.isEmpty(),"verified local copy");
  check(m.obtain(id(100),false).getString("warning").equals("older"),"older transfer");
  items.put(0,fixture(0,replacement));m.reconcile(index);
  check(m.get(id(0)).getString("warning").equals("changed"),"changed warning");
  wire[0]=Arrays.copyOf(replacement,replacement.length-1);
  try{m.obtain(id(0),true);throw new AssertionError("accepted truncated transfer");}catch(IOException ok){}
  check(Arrays.equals(Files.readAllBytes(m.existing(id(0),h,false).toPath()),original),"old bytes retained");
  Uri exported=m.export(ctx,id(0));try(InputStream in=ctx.getContentResolver().openInputStream(exported)){
   ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[1024];for(int k;(k=in.read(buf))!=-1;)out.write(buf,0,k);
   check(Arrays.equals(original,out.toByteArray()),"camera roll contains protected bytes");
  }finally{ctx.getContentResolver().delete(exported,null,null);}
  wire[0]=replacement;String h2=m.obtain(id(0),true).getString("local");check(!h2.equals(h),"confirmed replacement");
  items.getJSONObject(0).put("source","missing");m.reconcile(index);m.db.close();m=new MediaShelf(root,net);
  check(m.get(id(0)).getString("warning").equals("missing")&&m.existing(id(0),h2,false).length()==replacement.length,"missing copy survives relaunch");
  m.reconcile(new JSONObject().put("version",1).put("items",new JSONArray()));
  check(m.get(id(100)).getString("warning").equals("missing"),"row deleted from PC database");
  m.discard(id(0),h2);check(m.get(id(0)).getString("local").isEmpty(),"explicit drop");
  m.db.close();
 }
}
