package com.comfybridge.app;

import java.math.BigInteger;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.Locale;
import javax.net.ssl.*;
import org.json.JSONObject;

final class Pairing {
 private static final BigInteger N=new BigInteger("AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73",16), G=BigInteger.valueOf(2);
 private static final SecureRandom rng=new SecureRandom();
 static String address(String value)throws Exception {
  value=value.trim(); if(value.isEmpty())throw new IOException("Enter the PC address shown in the Windows panel.");
  if(!value.contains("://"))value="https://"+value;
  URL u=new URL(value);
  if(!"https".equals(u.getProtocol())||u.getHost().isEmpty()||u.getUserInfo()!=null||u.getQuery()!=null||u.getRef()!=null||(!u.getPath().isEmpty()&&!u.getPath().equals("/"))||u.getPort()==0||u.getPort()>65535)
   throw new IOException("Use the HTTPS address and port shown in the PC panel.");
  return "https://"+u.getAuthority();
 }
 static byte[] txt(String s){return s.getBytes(StandardCharsets.US_ASCII);}
 static byte[] hash(byte[]... parts)throws Exception{MessageDigest h=MessageDigest.getInstance("SHA-256");for(byte[] p:parts)h.update(p);return h.digest();}
 static BigInteger num(byte[] b){return new BigInteger(1,b);}
 static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte v:b)s.append(String.format(Locale.ROOT,"%02X",v));return s.toString();}
 static byte[] pad(BigInteger n){byte[] b=n.toByteArray(),r=new byte[256];int k=Math.min(b.length,r.length);System.arraycopy(b,b.length-k,r,r.length-k,k);return r;}
 static byte[] bytes(String s){if(!s.matches("[0-9A-Fa-f]{32}"))throw new IllegalArgumentException("Invalid PC pairing response.");byte[] b=new byte[16];for(int i=0;i<16;i++)b[i]=(byte)Integer.parseInt(s.substring(2*i,2*i+2),16);return b;}
 // No bearer or PIN is sent during bootstrap. The proof binds the observed TLS
 // certificate to the out-of-band code, and finish cannot change certificates.
 private String observed;
 JSONObject post(String host,String step,JSONObject body)throws Exception {
  HttpsURLConnection c=(HttpsURLConnection)new URL(host+"/api/pair/"+step).openConnection();
  SSLContext ctx=SSLContext.getInstance("TLS");
  ctx.init(null,new TrustManager[]{new X509TrustManager(){
   public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
   public void checkClientTrusted(X509Certificate[] chain,String t)throws CertificateException{throw new CertificateException();}
   public void checkServerTrusted(X509Certificate[] chain,String t)throws CertificateException{
    if(chain==null||chain.length==0)throw new CertificateException("Missing PC certificate.");chain[0].checkValidity();
    try{String p=hex(hash(chain[0].getEncoded()));if(observed!=null&&!observed.equals(p))throw new CertificateException("PC identity changed during pairing.");observed=p;}catch(GeneralSecurityException e){throw new CertificateException(e);}catch(Exception e){throw new CertificateException(e);}
   }
  }},rng);
  c.setSSLSocketFactory(ctx.getSocketFactory());c.setHostnameVerifier((h,s)->true);c.setInstanceFollowRedirects(false);
  c.setConnectTimeout(8000);c.setReadTimeout(12000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
  try{byte[] data=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(data.length);
   try(OutputStream out=c.getOutputStream()){out.write(data);}int status=c.getResponseCode();
   InputStream stream=status>=400?c.getErrorStream():c.getInputStream();ByteArrayOutputStream result=new ByteArrayOutputStream();
   if(stream!=null)try(InputStream in=stream){byte[] b=new byte[512];int k;while((k=in.read(b))!=-1){if(result.size()+k>8192)throw new IOException("Unexpected PC response.");result.write(b,0,k);}}
   JSONObject json;try{json=new JSONObject(result.toString("UTF-8"));}catch(Exception ex){throw new IOException("This address did not return a ComfyBridge pairing response.");}
   if(status>=400)throw new IOException(status==404||status==401?"Update the Windows bridge to beta 2, then open its pairing panel.":json.optString("error","PC rejected pairing ("+status+")."));
   return json;
  }finally{c.disconnect();}
 }
 String[] run(String host,String pin)throws Exception{
  if(!pin.matches("[0-9]{6}"))throw new IOException("Enter the six-digit code shown in the PC panel.");
  BigInteger a=new BigInteger(256,rng).add(BigInteger.ONE), A=G.modPow(a,N);
  JSONObject start=post(host,"begin",new JSONObject().put("A",hex(pad(A))));
  String id=start.getString("id"),Btext=start.getString("B");
  if(observed==null||!id.matches("[0-9A-F]{32}")||!Btext.matches("[0-9A-F]{512}"))throw new IOException("Invalid PC pairing response.");
  BigInteger B=new BigInteger(Btext,16);if(B.signum()<=0||B.compareTo(N)>=0)throw new IOException("Invalid PC pairing response.");
  BigInteger x=num(hash(bytes(start.getString("salt")),hash(txt("ComfyBridge:"+pin))));
  BigInteger u=num(hash(pad(A),pad(B))),k=num(hash(pad(N),pad(G)));
  BigInteger base=B.subtract(k.multiply(G.modPow(x,N))).mod(N);
  if(u.signum()==0||base.signum()==0)throw new IOException("Invalid PC pairing response.");
  byte[] key=hash(pad(base.modPow(a.add(u.multiply(x)),N)));
  String proof=hex(hash(txt("CB1/client"),txt(id),txt(observed),pad(A),pad(B),key));
  JSONObject finish=post(host,"finish",new JSONObject().put("id",id).put("proof",proof));
  String check=hex(hash(txt("CB1/server"),txt(proof),key));
  if(!MessageDigest.isEqual(txt(check),txt(finish.getString("proof"))))throw new IOException("Could not verify this PC. Pairing was not saved.");
  return new String[]{finish.getString("key"),observed};
 }
}
