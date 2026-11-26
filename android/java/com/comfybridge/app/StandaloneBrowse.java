package com.comfybridge.app;

import android.content.Context;
import android.content.SharedPreferences;
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
 private final Context context;
 private long nextRead;
 private String revokedPin="",revokedRevision="";
 StandaloneBrowse(Context context){this.context=context;}

 private AtomicFile file(String pin,String account)throws IOException{
  if(!pin.matches("[A-F0-9]{64}")||!account.matches("[1-9][0-9]{0,15}"))throw new IOException("Browse needs a paired PC and a Civitai account.");
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
 private SharedPreferences state(){return context.getSharedPreferences("offline-browse-state",Context.MODE_PRIVATE);}
 String revision(String pin){
  if(revokedPin.equals(pin))return revokedRevision;
  String account=state().getString(pin+":account","");
  return enrolled(pin,account)?state().getString(pin+":revision",""):"";
 }
 private void discardOtherKeys(String pin,String keep){
  if(!pin.matches("[A-F0-9]{64}"))return;
  File[] files=context.getNoBackupFilesDir().listFiles((dir,name)->name.matches("civitai-"+pin+"-[1-9][0-9]{0,15}\\.key"));
  if(files!=null)for(File old:files)if(!old.getName().equals(keep))new AtomicFile(old).delete();
 }
 void clear(String pin){
  discardOtherKeys(pin,"");
  state().edit().remove(pin+":account").remove(pin+":revision").apply();
  if(revokedPin.equals(pin)){revokedPin="";revokedRevision="";}
 }
 void reject(String pin,String revision){
  clear(pin);revokedPin=pin;revokedRevision=revision;
 }
 void store(String pin,String account,String token,String revision)throws Exception{
  AtomicFile file=file(pin,account);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD((pin+":"+account).getBytes(StandardCharsets.UTF_8));
  byte[] iv=cipher.getIV(),encrypted=cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
  FileOutputStream out=file.startWrite();
  try{out.write(iv.length);out.write(iv);out.write(encrypted);file.finishWrite(out);}
  catch(Exception e){file.failWrite(out);throw e;}
  state().edit().putString(pin+":account",account).putString(pin+":revision",revision).commit();
  discardOtherKeys(pin,file.getBaseFile().getName());
  revokedPin="";revokedRevision="";nextRead=0;
 }
 private String load(String pin,String account)throws Exception{
  AtomicFile file=file(pin,account);
  if(!file.getBaseFile().isFile())throw new IOException("Reconnect to the PC to sync its Civitai key.");
  try(DataInputStream in=new DataInputStream(file.openRead())){
   int length=in.readUnsignedByte();if(length!=12)throw new IOException();
   byte[] iv=new byte[length];in.readFully(iv);
   ByteArrayOutputStream data=new ByteArrayOutputStream();
   byte[] chunk=new byte[512];int n;while((n=in.read(chunk))!=-1){data.write(chunk,0,n);if(data.size()>1024)throw new IOException();}
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
   cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));cipher.updateAAD((pin+":"+account).getBytes(StandardCharsets.UTF_8));
   return new String(cipher.doFinal(data.toByteArray()),StandardCharsets.UTF_8);
  }catch(Exception e){file.delete();throw new IOException("Reconnect to the PC to refresh its Civitai key.");}
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
 String verifiedAccount(String token)throws Exception{
  String account=request("v1/me",token).optString("id");
  if(!account.matches("[1-9][0-9]{0,15}"))throw new IOException("Could not verify the Civitai account.");
  return account;
 }
 private void revoked(String pin,String account)throws IOException{
  revokedRevision=revision(pin);revokedPin=pin;file(pin,account).delete();
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
    revoked(pin,account);throw new IOException("The Civitai key expired or was revoked. Update it on the PC.");
   }
   if("images".equals(operation)&&error.getMessage().startsWith("HTTP 403:")){
    try{if(!account.equals(verifiedAccount(token)))throw new IOException("Civitai account changed.");}catch(IOException invalid){
     if(invalid.getMessage().startsWith("HTTP 401:")||invalid.getMessage().startsWith("HTTP 403:")||invalid.getMessage().startsWith("Civitai account changed")){
      revoked(pin,account);throw new IOException("The Civitai key is no longer valid. Update it on the PC.");
     }
    }
   }
   throw error;
  }
 }
}
