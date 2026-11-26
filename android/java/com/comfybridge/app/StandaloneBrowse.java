package com.comfybridge.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class StandaloneBrowse {
 private static final String ALIAS="comfybridge-civitai-browse";
 private static final long READ=(1L<<0)|(1L<<2)|(1L<<5)|(1L<<8)|(1L<<11)|(1L<<14)|(1L<<16)|(1L<<17)|(1L<<21)|(1L<<23);
 private static final long REQUIRED=(1L<<0)|(1L<<5)|(1L<<17);
 private final Context context;
 private long nextRead;
 StandaloneBrowse(Context context){this.context=context;}

 private AtomicFile file(String pin,String account)throws IOException{
  if(!pin.matches("[A-F0-9]{64}")||!account.matches("[1-9][0-9]{0,15}"))throw new IOException("Pair this phone securely to set up offline Browse.");
  return new AtomicFile(new File(context.getNoBackupFilesDir(),"civitai-"+pin+"-"+account+".key"));
 }
 boolean enrolled(String pin,String account){
  try{return file(pin,account).getBaseFile().isFile();}catch(IOException e){return false;}
 }
 private SecretKey key()throws Exception{
  KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
  SecretKey existing=(SecretKey)store.getKey(ALIAS,null);if(existing!=null)return existing;
  KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
  generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
   .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
  return generator.generateKey();
 }
 void store(String pin,String account,String token)throws Exception{
  AtomicFile file=file(pin,account);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD((pin+":"+account).getBytes(StandardCharsets.UTF_8));
  byte[] iv=cipher.getIV(),encrypted=cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
  FileOutputStream out=file.startWrite();
  try{out.write(iv.length);out.write(iv);out.write(encrypted);file.finishWrite(out);}
  catch(Exception e){file.failWrite(out);throw e;}
  nextRead=0;
 }
 private String load(String pin,String account)throws Exception{
  AtomicFile file=file(pin,account);
  if(!file.getBaseFile().isFile())throw new IOException("Set up offline Browse to load new media without the PC.");
  try(DataInputStream in=new DataInputStream(file.openRead())){
   int length=in.readUnsignedByte();if(length!=12)throw new IOException();
   byte[] iv=new byte[length];in.readFully(iv);
   ByteArrayOutputStream data=new ByteArrayOutputStream();
   byte[] chunk=new byte[512];int n;while((n=in.read(chunk))!=-1){data.write(chunk,0,n);if(data.size()>1024)throw new IOException();}
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
   cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));cipher.updateAAD((pin+":"+account).getBytes(StandardCharsets.UTF_8));
   return new String(cipher.doFinal(data.toByteArray()),StandardCharsets.UTF_8);
  }catch(Exception e){file.delete();throw new IOException("Set up offline Browse again to replace the unreadable phone key.");}
 }
 static JSONObject response(HttpURLConnection c)throws Exception{
  try(InputStream in=c.getInputStream()){
   ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] chunk=new byte[8192];int n;
   while((n=in.read(chunk))!=-1){out.write(chunk,0,n);if(out.size()>4*1024*1024)throw new IOException("Browse response exceeded the size limit.");}
   return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
  }
 }
 private JSONObject request(String endpoint,String token)throws Exception{
  HttpURLConnection c=(HttpURLConnection)new URL("https://civitai.red/api/"+endpoint).openConnection();
  c.setConnectTimeout(8000);c.setReadTimeout(12000);c.setInstanceFollowRedirects(false);
  c.setRequestProperty("Authorization","Bearer "+token);c.setRequestProperty("User-Agent","ComfyBridge-Browse/1.0");
  try{
   int status=c.getResponseCode();
   if(status==429||status==503){
    int seconds=30;try{seconds=Math.max(15,Math.min(600,Integer.parseInt(c.getHeaderField("Retry-After"))));}catch(NumberFormatException ignored){}
    nextRead=android.os.SystemClock.elapsedRealtime()+seconds*1000L;
    throw new IOException("HTTP "+status+": Civitai paused reads. Retry in "+seconds+" seconds.");
   }
   if(status!=200)throw new IOException("HTTP "+status+": Could not read Civitai.");
   return response(c);
  }finally{c.disconnect();}
 }
 void verify(String token,String account)throws Exception{
  JSONObject me=request("v1/me",token);long scopes=me.optLong("tokenScope",-1);
  if(!account.equals(me.optString("id"))||(scopes&~READ)!=0||(scopes&REQUIRED)!=REQUIRED)
   throw new IOException("Use a separate read-only Civitai key for the same account.");
 }
 JSONObject read(String pin,String account,String operation,JSONObject input)throws Exception{
  long now=android.os.SystemClock.elapsedRealtime();
  if(now<nextRead)throw new IOException("HTTP 429: Retry in "+((nextRead-now+999)/1000)+" seconds.");
  String route;
  if("images".equals(operation))route="image.getInfinite";
  else if("detail".equals(operation))route="image.getGenerationData";
  else throw new IOException("Unsupported Browse read.");
  String token=load(pin,account);nextRead=now+850;
  JSONObject wrapped=new JSONObject().put("json",input);
  try{return request("trpc/"+route+"?input="+URLEncoder.encode(wrapped.toString(),"UTF-8"),token)
   .getJSONObject("result").getJSONObject("data").getJSONObject("json");}
  catch(IOException error){
   if(error.getMessage().startsWith("HTTP 401:")){
    file(pin,account).delete();throw new IOException("The phone's Civitai key expired or was revoked. Set up offline Browse again.");
   }
   if("images".equals(operation)&&error.getMessage().startsWith("HTTP 403:")){
    try{verify(token,account);}catch(IOException invalid){
     if(invalid.getMessage().startsWith("HTTP 401:")||invalid.getMessage().startsWith("HTTP 403:")||invalid.getMessage().startsWith("Use a separate")){
      file(pin,account).delete();throw new IOException("The phone's Civitai key is no longer valid. Set up offline Browse again.");
     }
    }
   }
   throw error;
  }
 }
}
