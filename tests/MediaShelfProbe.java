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
  try{exercise();prefetch();report.putString("checks","100 mixed originals, older on-demand, corrupt transfer, changed/missing retention, restart, camera-roll bytes, explicit removal; prefetch newest-20 cap, cached skip, pause cleanup, concurrent manual transfer and duplicate coalescing");}
  catch(Throwable e){result=Activity.RESULT_CANCELED;report.putString("error",e.toString());}
  finish(result,report);
 }
 static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
 static String id(int n){return String.format(Locale.ROOT,"%032x",n);}
 static String sha(byte[] b)throws Exception{return MediaShelf.hex(MessageDigest.getInstance("SHA-256").digest(b));}
 static byte[] png(int color){Bitmap b=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);b.eraseColor(color);ByteArrayOutputStream out=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);b.recycle();return out.toByteArray();}
 static JSONObject fixture(int n,byte[] bytes)throws Exception{return new JSONObject().put("id",id(n)).put("kind",n%2==0?"image":"video").put("archived",n%4==0?1:0).put("source","available").put("size",bytes.length).put("created",1000-n).put("sha256",sha(bytes));}
 void prefetch()throws Exception{
  byte[] bytes=png(0xff558877);File root=Files.createTempDirectory(getTargetContext().getFilesDir().toPath(),"prefetch-").toFile();
  java.util.concurrent.atomic.AtomicInteger opened=new java.util.concurrent.atomic.AtomicInteger();
  java.util.concurrent.atomic.AtomicBoolean allowed=new java.util.concurrent.atomic.AtomicBoolean(true),pauseOnRead=new java.util.concurrent.atomic.AtomicBoolean(false);
  java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);
  MediaShelf.Network net=path->{opened.incrementAndGet();return new HttpURLConnection(new URL("http://invalid.test/")){
   public int getResponseCode(){return 200;}
   public InputStream getInputStream(){return new ByteArrayInputStream(bytes){@Override public synchronized int read(byte[] b,int off,int len){
    if(path.endsWith(id(2))){started.countDown();try{if(!release.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("manual transfer blocked by prefetch");}catch(InterruptedException e){throw new AssertionError(e);}}
    int n=super.read(b,off,len);if(pauseOnRead.get())allowed.set(false);return n;
   }};}
   public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
  };};
  MediaShelf m=new MediaShelf(root,net);JSONArray rows=new JSONArray();for(int n=0;n<25;n++)rows.put(fixture(n,bytes));
  m.reconcile(new JSONObject().put("version",1).put("items",rows));
  MediaShelf.DownloadGuard guard=new MediaShelf.DownloadGuard(){public boolean allowed(){return allowed.get();}public void connection(HttpURLConnection c){}};
  check(m.inPrefetchWindow(id(19))&&!m.inPrefetchWindow(id(20)),"only newest 20 including archived");
  try{m.obtain(id(20),false,guard);throw new AssertionError("prefetched older item");}catch(InterruptedIOException ok){}
  allowed.set(false);try{m.obtain(id(0),false,guard);throw new AssertionError("prefetched while hidden");}catch(InterruptedIOException ok){}
  check(opened.get()==0,"hidden and older requests never open a socket");
  allowed.set(true);m.obtain(id(0),false,guard);m.obtain(id(0),false,guard);check(opened.get()==1,"cached original skipped");
  pauseOnRead.set(true);try{m.obtain(id(1),false,guard);throw new AssertionError("published partial on pause");}catch(InterruptedIOException ok){}
  check(m.get(id(1)).getString("local").isEmpty()&&!new File(root,id(1)+".partial").exists(),"pause discards only partial");
  pauseOnRead.set(false);allowed.set(true);m.obtain(id(1),false,guard);check(!m.get(id(1)).getString("local").isEmpty(),"resume downloads cleanly");
  java.util.concurrent.ExecutorService threads=java.util.concurrent.Executors.newFixedThreadPool(3);
  try{
   java.util.concurrent.Future<JSONObject> background=threads.submit(()->m.obtain(id(2),false,guard));
   check(started.await(5,java.util.concurrent.TimeUnit.SECONDS),"prefetch started");
   java.util.concurrent.Future<JSONObject> duplicate=threads.submit(()->m.obtain(id(2),false));
   java.util.concurrent.Future<JSONObject> manual=threads.submit(()->m.obtain(id(24),false));
   check(!manual.get(4,java.util.concurrent.TimeUnit.SECONDS).getString("local").isEmpty(),"older tap downloads independently");
   release.countDown();background.get(5,java.util.concurrent.TimeUnit.SECONDS);duplicate.get(5,java.util.concurrent.TimeUnit.SECONDS);
   check(opened.get()==5,"duplicate uses verified copy without second download");
  }finally{release.countDown();threads.shutdownNow();m.db.close();}
 }
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
