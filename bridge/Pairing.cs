using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

// SRP-6a (RFC 5054, 2048-bit group), SHA-256, fixed-width big-endian integers.
// Key confirmation covers both public values, session ID, and the TLS leaf fingerprint.
internal static class Pairing {
    static BigInteger N = BigInteger.Parse("0AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73", NumberStyles.HexNumber);
    static readonly Dictionary<string, string> proofs = new Dictionary<string, string>();
    static string code, note = "Open this panel to pair a phone.";
    static DateTime expires;
    static int starts;
    static byte[] Random(int n) { var b=new byte[n]; using(var rng=RandomNumberGenerator.Create())rng.GetBytes(b);return b; }
    static BigInteger Num(byte[] bytes) { var b=new byte[bytes.Length+1];for(int i=0;i<bytes.Length;i++)b[i]=bytes[bytes.Length-i-1];return new BigInteger(b); }
    static byte[] Pad(BigInteger v) { var b=v.ToByteArray();var r=new byte[256];for(int i=0;i<Math.Min(256,b.Length);i++)r[255-i]=b[i];return r; }
    static byte[] Hash(params byte[][] fields) {using(var h=SHA256.Create()){foreach(var f in fields)h.TransformBlock(f,0,f.Length,f,0);h.TransformFinalBlock(new byte[0],0,0);return h.Hash;} }
    static string Hex(byte[] b) {return BitConverter.ToString(b).Replace("-","");}
    static byte[] Txt(string s){return Encoding.ASCII.GetBytes(s);}
    internal static void Issue() {lock(proofs){uint n;do{n=BitConverter.ToUInt32(Random(4),0);}while(n>=4294000000U);code=(n%1000000).ToString("D6",CultureInfo.InvariantCulture);expires=DateTime.UtcNow.AddMinutes(5);starts=0;proofs.Clear();note="Enter this code on your phone.";} }
    internal static void Close(string why) {lock(proofs){code=null;proofs.Clear();note=why;} }
    static void Expire(){if(code!=null && DateTime.UtcNow>=expires)Close("Code expired. Click New code to pair.");}
    internal static string Display(out string hint){lock(proofs){Expire();hint=note;if(code!=null)hint+="  Expires in "+Math.Ceiling((expires-DateTime.UtcNow).TotalMinutes)+" min.";return code??"—";} }
    internal static object Exchange(string path, Dictionary<string,string> d, string pin, string token) {
      lock(proofs){Expire();if(code==null)throw new InvalidOperationException("No active code. On the PC, open ComfyBridge and click New code.");
        if(path=="begin"){
          if(starts>=5){Close("Attempt limit reached. Click New code.");throw new InvalidOperationException("Attempt limit reached. Click New code on your PC.");}
          starts++;
          string aText;if(!d.TryGetValue("A",out aText)||aText.Length!=512 || !System.Text.RegularExpressions.Regex.IsMatch(aText,@"\A[0-9a-fA-F]+\z"))throw new ArgumentException("Invalid pairing request.");
          var A=BigInteger.Parse("0"+aText,NumberStyles.HexNumber);
          if(A<=1 || A>=N-1)throw new ArgumentException("Invalid pairing request.");
          var salt=Random(16);var b=Num(Random(32))+1;
          var x=Num(Hash(salt,Hash(Txt("ComfyBridge:"+code))));
          var v=BigInteger.ModPow(2,x,N);var k=Num(Hash(Pad(N),Pad(2)));
          var B=(k*v+BigInteger.ModPow(2,b,N))%N;
          var u=Num(Hash(Pad(A),Pad(B)));if(u.IsZero||B.IsZero)throw new InvalidOperationException("Retry pairing.");
          var shared=BigInteger.ModPow(A*BigInteger.ModPow(v,u,N)%N,b,N);
          var id=Hex(Random(16));var key=Hash(Pad(shared));
          var proof=Hex(Hash(Txt("CB1/client"),Txt(id),Txt(pin),Pad(A),Pad(B),key));
          proofs[id]=proof+Hex(Hash(Txt("CB1/server"),Txt(proof),key));
          return new { id=id, salt=Hex(salt), B=Hex(Pad(B)) };
        }
        string sid,actual,both;
        if(!d.TryGetValue("id",out sid)||!d.TryGetValue("proof",out actual)||!proofs.TryGetValue(sid,out both))throw new ArgumentException("Pairing session expired. Try again with the current PC code.");
        proofs.Remove(sid);
        int diff=0;if(actual.Length!=64)diff=1;else for(int i=0;i<64;i++)diff|=actual[i]^both[i];
        if(diff!=0)throw new ArgumentException("That code does not match this PC. Check the six digits and try again.");
        Close("Phone paired. Use New code to pair another phone.");
        return new { proof=both.Substring(64), key=token };
      }
    }
}
