package com.comfybridge.app;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.*;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Only full, hash-verified files become visible. Index changes never remove a local original. */
final class MediaShelf {
 interface Network { HttpURLConnection open(String path) throws Exception; }
 final File dir; final SQLiteDatabase db; final Network net;
 MediaShelf(File dir,Network net) throws IOException {
  this.dir=dir;this.net=net;if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("Cannot open phone storage.");
  db=SQLiteDatabase.openOrCreateDatabase(new File(dir,"index.db"),null);
  db.execSQL("CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, meta TEXT NOT NULL, local TEXT NOT NULL DEFAULT '', recent INTEGER NOT NULL DEFAULT 0)");
  File[] parts=dir.listFiles((d,n)->n.endsWith(".partial"));if(parts!=null)for(File part:parts)part.delete();
 }
 static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte v:b)s.append(String.format(Locale.ROOT,"%02x",v));return s.toString();}
 static boolean idOK(String id){return id!=null&&id.matches("[0-9a-f]{32}");}
 File file(String id,String hash){if(!idOK(id)||!hash.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid local media reference.");return new File(dir,id+"-"+hash);}
 JSONObject row(Cursor c)throws Exception{
  JSONObject j=new JSONObject(c.getString(0));String local=c.getString(1);
  boolean here=!local.isEmpty()&&file(j.getString("id"),local).isFile();
  String state=j.getString("source");boolean recent=c.getInt(2)!=0;
  String warning=!here?"":state.equals("missing")?"missing":state.equals("unavailable")?"":!local.equals(j.optString("sha256"))?"changed":!recent?"older":"";
  return j.put("local",here?local:"").put("recent",recent).put("warning",warning);
 }
 JSONObject get(String id)throws Exception{if(!idOK(id))throw new IOException("Invalid media ID.");try(Cursor c=db.rawQuery("SELECT meta,local,recent FROM items WHERE id=?",new String[]{id})){if(!c.moveToFirst())throw new IOException("Item is not in the phone library.");return row(c);}}
 JSONArray snapshot()throws Exception{JSONArray a=new JSONArray();try(Cursor c=db.rawQuery("SELECT meta,local,recent FROM items",null)){while(c.moveToNext())a.put(row(c));}return a;}
 void reconcile(JSONObject manifest)throws Exception{
  if(manifest.getInt("version")!=1)throw new IOException("Update the Windows bridge for local media sync.");
  JSONArray all=manifest.getJSONArray("items");Set<String> present=new HashSet<>();int count=0;
  db.beginTransaction();try{
   for(int i=0;i<all.length();i++){JSONObject j=all.getJSONObject(i);String id=j.getString("id"),state=j.getString("source");
    if(!idOK(id)||!present.add(id)||!Arrays.asList("available","missing","unavailable").contains(state))throw new IOException("Invalid PC media index.");
    if(state.equals("available")&&(!j.getString("sha256").matches("[0-9a-f]{64}")||j.getLong("size")<=0))throw new IOException("Invalid PC file details.");
    int recent=(!state.equals("missing")&&count++<100)?1:0;
    db.execSQL("INSERT OR IGNORE INTO items(id,meta) VALUES(?,?)",new Object[]{id,j.toString()});
    db.execSQL("UPDATE items SET meta=?,recent=? WHERE id=?",new Object[]{j.toString(),recent,id});
   }
   try(Cursor c=db.rawQuery("SELECT id,meta,local FROM items",null)){while(c.moveToNext()){
    String id=c.getString(0);if(present.contains(id))continue;
    if(c.getString(2).isEmpty()){db.delete("items","id=?",new String[]{id});continue;}
    JSONObject j=new JSONObject(c.getString(1)).put("source","missing");
    db.execSQL("UPDATE items SET meta=?,recent=0 WHERE id=?",new Object[]{j.toString(),id});
   }}
   db.setTransactionSuccessful();
  }finally{db.endTransaction();}
 }
 JSONObject obtain(String id,boolean replace)throws Exception{
  JSONObject j=get(id);String local=j.getString("local");
  if(!local.isEmpty()&&!replace)return j;
  if(!"available".equals(j.getString("source")))throw new IOException("The PC original is unavailable.");
  String expected=j.getString("sha256");if(expected.equals(local))return j;
  long size=j.getLong("size");if(dir.getUsableSpace()-size<16L*1024*1024)throw new IOException("Phone storage is too low. Existing copies were kept.");
  File dest=file(id,expected),tmp=new File(dir,id+".partial");HttpURLConnection c=net.open("api/media/"+id);
  try{
   if(c.getResponseCode()!=200)throw new IOException("PC file could not be downloaded (HTTP "+c.getResponseCode()+").");
   MessageDigest digest=MessageDigest.getInstance("SHA-256");long n=0;byte[] buf=new byte[131072];
   try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(tmp)){for(int k;(k=in.read(buf))!=-1;){n+=k;if(n>size)throw new IOException("PC file changed during transfer.");digest.update(buf,0,k);out.write(buf,0,k);}out.getFD().sync();}
   if(n!=size||!expected.equals(hex(digest.digest())))throw new IOException("Transfer incomplete or PC file changed. The previous copy was kept.");
   Files.move(tmp.toPath(),dest.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
   db.execSQL("UPDATE items SET local=? WHERE id=?",new Object[]{expected,id});
   if(!local.isEmpty())removeVersion(id,local);
   makeThumb(dest,j.getString("kind"));
   return get(id);
  }finally{c.disconnect();tmp.delete();}
 }
 private void removeVersion(String id,String hash){File f=file(id,hash);f.delete();new File(f+".jpg").delete();}
 JSONObject discard(String id,String hash)throws Exception{
  JSONObject j=get(id);if(!hash.equals(j.getString("local"))||hash.isEmpty()||!Arrays.asList("older","missing").contains(j.getString("warning")))throw new IOException("Library changed. Review the copy again.");
  db.execSQL("UPDATE items SET local='' WHERE id=?",new Object[]{id});removeVersion(id,hash);return get(id);
 }
 File existing(String id,String hash,boolean thumb)throws Exception{
  JSONObject j=get(id);if(hash.isEmpty()||!hash.equals(j.getString("local")))throw new IOException("File is not on this phone.");
  File f=file(id,hash);if(thumb){File t=new File(f+".jpg");if(!t.isFile())makeThumb(f,j.getString("kind"));return t;}return f;
 }
 private synchronized void makeThumb(File file,String kind){
  Bitmap b=null;try{
   if(kind.equals("video")){MediaMetadataRetriever r=new MediaMetadataRetriever();try{r.setDataSource(file.getPath());
    if(Build.VERSION.SDK_INT>=27){int w=Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)),h=Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));float scale=320f/Math.max(w,h);b=r.getScaledFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale)));}
    else b=r.getFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
   }finally{r.release();}}
   else{BitmapFactory.Options o=new BitmapFactory.Options();o.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getPath(),o);o.inSampleSize=1;
    while(Math.max(o.outWidth,o.outHeight)/o.inSampleSize>640)o.inSampleSize*=2;o.inJustDecodeBounds=false;b=BitmapFactory.decodeFile(file.getPath(),o);}
   if(b!=null){File t=new File(file+".jpg"),tmp=new File(file+".thumb.partial");try(FileOutputStream out=new FileOutputStream(tmp)){b.compress(Bitmap.CompressFormat.JPEG,80,out);}tmp.renameTo(t);}
  }catch(Exception ignored){}finally{if(b!=null)b.recycle();}
 }
 Uri export(Context ctx,String id)throws Exception{
  JSONObject j=get(id);String hash=j.getString("local");File f=existing(id,hash,false);
  boolean video="video".equals(j.getString("kind"));String name="ComfyBridge-"+id.substring(0,8)+"-"+hash.substring(0,8)+(video?".mp4":".png");
  return exportStream(ctx,new FileInputStream(f),video,name);
 }
 Uri exportStream(Context ctx,InputStream source,boolean video,String name)throws Exception{
  try(InputStream original=source){
  ContentValues cv=new ContentValues();
  cv.put(MediaStore.MediaColumns.DISPLAY_NAME,name);cv.put(MediaStore.MediaColumns.MIME_TYPE,video?"video/mp4":"image/png");
  if(Build.VERSION.SDK_INT>=29){cv.put(MediaStore.MediaColumns.RELATIVE_PATH,"DCIM/ComfyBridge");cv.put(MediaStore.MediaColumns.IS_PENDING,1);}
  else{File folder=new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM),"ComfyBridge");folder.mkdirs();File dst=new File(folder,name);if(dst.exists())dst=new File(folder,System.currentTimeMillis()+"-"+name);cv.put(MediaStore.MediaColumns.DATA,dst.getPath());}
  ContentResolver resolver=ctx.getContentResolver();Uri out=resolver.insert(video?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Images.Media.EXTERNAL_CONTENT_URI,cv);if(out==null)throw new IOException("Cannot create a camera roll entry.");
  try{try(InputStream in=original;OutputStream os=resolver.openOutputStream(out)){byte[] buf=new byte[131072];for(int k;(k=in.read(buf))!=-1;)os.write(buf,0,k);}
   if(Build.VERSION.SDK_INT>=29){cv.clear();cv.put(MediaStore.MediaColumns.IS_PENDING,0);if(resolver.update(out,cv,null,null)!=1)throw new IOException("Camera roll did not confirm the save.");}
  }catch(Exception e){resolver.delete(out,null,null);throw e;}return out;
  }
 }
}
