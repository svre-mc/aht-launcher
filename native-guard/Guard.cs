// AHT native runtime monitor. Read-only access to one game process; no driver or injection.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using System.Reflection;
[assembly: AssemblyTitle("AHT Runtime Guard")]
[assembly: AssemblyDescription("Read-only game runtime integrity monitor")]
[assembly: AssemblyCompany("A Hard Time")]
[assembly: AssemblyProduct("AHT Runtime Guard")]
[assembly: AssemblyVersion("1.0.0.0")]
internal static class Guard {
    const int MaxImage = 96 * 1024 * 1024;
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, int size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=16384, RecursionLimit=8 };
    static readonly object Gate = new object();
    static readonly RSACryptoServiceProvider Key = new RSACryptoServiceProvider(2048) { PersistKeyInCsp=false };
    static readonly DateTime Epoch = new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);
    static string gameDir, expectedImage, keyHash, modulus, exponent;
    static volatile int targetPid; static long targetBirth, sequence, lastScan, started;
    static readonly int OwnSession=Process.GetCurrentProcess().SessionId;
    static volatile bool stopping;
    static Process target; static IntPtr handle; static string state="pending";
    static int checkedModules; static long checkedBytes; static int mismatchStreak;
    static string detail="Waiting for the launched game";
    static int port;
    static readonly Dictionary<string,Image> Images = new Dictionary<string,Image>(StringComparer.OrdinalIgnoreCase);
    static readonly HashSet<string> ProtectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "jvm.dll", "java.dll", "lwjgl64.dll", "lwjgl.dll" };
    static long Now() { return (long)(DateTime.UtcNow-Epoch).TotalMilliseconds; }
    static string B64(byte[] data) { return Convert.ToBase64String(data).TrimEnd('=').Replace('+','-').Replace('/','_'); }
    static string Hash(byte[] data) { using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant(); }
    static string Text(object value) { return value==null?"":Convert.ToString(value); }
    static string Info() { return Json.Serialize(new {protocol="AHT-GUARD-1",port=port,keyHash=keyHash,modulus=modulus,exponent=exponent,gamePid=targetPid,guardPid=Process.GetCurrentProcess().Id}); }
    static string PathKey(string value) { return Path.GetFullPath(value).TrimEnd('\\','/').Replace('/','\\').ToLowerInvariant(); }
    static string ReadLine(Stream input,int maximum) {
        var bytes=new List<byte>();
        while(bytes.Count<=maximum) { int b=input.ReadByte();if(b<0)return null;if(b==10)return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');bytes.Add((byte)b); }
        throw new InvalidDataException("request size");
    }
    static bool GameCommandMatches(string command) {
        // Match a complete JVM property or game argument, never an arbitrary directory substring.
        int count;IntPtr block=CommandLineToArgvW(command,out count);if(block==IntPtr.Zero)return false;
        var args=new List<string>();try {for(int n=0;n<count;n++)args.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(block,n*IntPtr.Size)));}finally{LocalFree(block);}
        for(int i=0;i<args.Count;i++) {
            string value=args[i];
            if(value.StartsWith("-Dminecraft.applet.TargetDirectory=",StringComparison.OrdinalIgnoreCase)) {
                try { if(PathKey(value.Substring(value.IndexOf('=')+1).Trim('"'))==gameDir)return true; }catch{}
            }
            if(value=="--gameDir" && i+1<args.Count) {
                try { if(PathKey(args[i+1])==gameDir)return true; }catch{}
            }
        }
        return false;
    }
    static bool Bind(int pid) {
        if(targetPid!=0)return targetPid==pid && target!=null && !target.HasExited && target.StartTime.ToUniversalTime().ToFileTimeUtc()==targetBirth;
        var candidate=Process.GetProcessById(pid);
        try {
            if(candidate.SessionId!=OwnSession)return false;
            string image=candidate.MainModule.FileName;
            if(!new[]{"java.exe","javaw.exe"}.Contains(Path.GetFileName(image).ToLowerInvariant()))return false;
            if(expectedImage.Length>0 && PathKey(image)!=expectedImage)return false;
            if((long)(candidate.StartTime.ToUniversalTime()-Epoch).TotalMilliseconds<started-30000)return false;
            using(var query=new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId="+pid))
            using(var results=query.Get()) {
                bool match=false;foreach(ManagementObject row in results)match=GameCommandMatches(Text(row["CommandLine"]));
                if(!match)return false;
            }
            IntPtr opened=OpenProcess(0x0400|0x0010,false,pid); // QUERY_INFORMATION | VM_READ only.
            if(opened==IntPtr.Zero)return false;
            handle=opened;target=candidate;targetBirth=candidate.StartTime.ToUniversalTime().ToFileTimeUtc();targetPid=pid;return true;
        } finally { if(target!=candidate)candidate.Dispose(); }
    }
    static bool DiscoverGame() {
        // Select independently of the reporting client. Ambiguous matching games never yield clean coverage.
        try {
            var matches=new List<int>();
            using(var query=new ManagementObjectSearcher("SELECT ProcessId,CommandLine FROM Win32_Process WHERE Name='java.exe' OR Name='javaw.exe'"))
            using(var rows=query.Get()) {
                int examined=0;
                foreach(ManagementObject row in rows) {
                    if(++examined>64)return false;
                    if(!GameCommandMatches(Text(row["CommandLine"])))continue;
                    int pid=Convert.ToInt32(row["ProcessId"]);
                    using(var process=Process.GetProcessById(pid)) {
                        if(process.SessionId==OwnSession && (expectedImage.Length==0 || PathKey(process.MainModule.FileName)==expectedImage)
                            && (long)(process.StartTime.ToUniversalTime()-Epoch).TotalMilliseconds>=started-30000)matches.Add(pid);
                    }
                }
            }
            if(matches.Count==1)lock(Gate){return Bind(matches[0]);}
        }catch { }
        return false;
    }
    sealed class Section { public int Rva, Raw, Size; public byte[] Bytes; public bool[] Skip; }
    sealed class Image {
        public string Hash; public long Length, WriteTicks; public List<Section> Sections=new List<Section>();
        static uint U32(byte[] b,int off) { if(off<0||off>b.Length-4)throw new InvalidDataException();return BitConverter.ToUInt32(b,off); }
        static ushort U16(byte[] b,int off) { if(off<0||off>b.Length-2)throw new InvalidDataException();return BitConverter.ToUInt16(b,off); }
        public static Image Load(string path) {
            var file=new FileInfo(path);if(file.Length<512||file.Length>MaxImage)throw new InvalidDataException("image bound");
            byte[] bytes=File.ReadAllBytes(path);var result=new Image { Hash=Guard.Hash(bytes),Length=file.Length,WriteTicks=file.LastWriteTimeUtc.Ticks };
            if(U16(bytes,0)!=0x5a4d)throw new InvalidDataException("DOS header");
            int pe=checked((int)U32(bytes,60));if(U32(bytes,pe)!=0x4550)throw new InvalidDataException("PE header");
            int count=U16(bytes,pe+6),optional=pe+24,optionalSize=U16(bytes,pe+20),table=optional+optionalSize;
            if(count<1||count>96)throw new InvalidDataException("sections");
            var all=new List<Section>();
            for(int i=0;i<count;i++) {
                int offset=table+i*40;uint flags=U32(bytes,offset+36);
                var s=new Section { Rva=checked((int)U32(bytes,offset+12)),Raw=checked((int)U32(bytes,offset+20)),Size=checked((int)U32(bytes,offset+16)) };
                if(s.Size<0||s.Raw<0||s.Raw>bytes.Length-s.Size)throw new InvalidDataException("section extent");
                all.Add(s);
                if((flags&0x20000000)!=0 && (flags&0x80000000)==0 && s.Size>0) {
                    s.Bytes=new byte[s.Size];Buffer.BlockCopy(bytes,s.Raw,s.Bytes,0,s.Size);s.Skip=new bool[s.Size];result.Sections.Add(s);
                }
            }
            int directory=optional+(U16(bytes,optional)==0x20b?112:96);
            if(directory+48>optional+optionalSize)throw new InvalidDataException("directories");
            int relocRva=checked((int)U32(bytes,directory+40)),relocSize=checked((int)U32(bytes,directory+44));
            if(relocRva>0 && relocSize>0) {
                var source=all.FirstOrDefault(s=>relocRva>=s.Rva && relocRva-s.Rva<s.Size);
                if(source==null || relocSize>source.Size-(relocRva-source.Rva))throw new InvalidDataException("relocations");
                int cursor=source.Raw+relocRva-source.Rva,end=checked(cursor+relocSize);
                while(cursor+8<=end) {
                    int page=checked((int)U32(bytes,cursor)),size=checked((int)U32(bytes,cursor+4));
                    if(size<8 || size>end-cursor || (size&1)!=0)throw new InvalidDataException("relocation block");
                    for(int n=cursor+8;n<cursor+size;n+=2) {
                        int entry=U16(bytes,n),type=entry>>12,address=page+(entry&4095),width=type==10?8:type==3?4:0;
                        if(type!=0 && width==0)throw new InvalidDataException("unsupported relocation");
                        foreach(var s in result.Sections)for(int j=0;j<width;j++)if(address+j>=s.Rva && address+j-s.Rva<s.Size)s.Skip[address+j-s.Rva]=true;
                    }
                    cursor+=size;
                }
            }
            if(result.Sections.Count==0)throw new InvalidDataException("no immutable code");return result;
        }
    }
    static void Scan() {
        int modules=0;long bytes=0;var differences=new List<string>();
        try {
            target.Refresh();if(target.HasExited){stopping=true;return;}
            if(target.StartTime.ToUniversalTime().ToFileTimeUtc()!=targetBirth)throw new InvalidOperationException("process identity");
            var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(ProcessModule module in target.Modules) {
                if(!ProtectedNames.Contains(module.ModuleName))continue;
                if(modules>=8)throw new InvalidDataException("module bound");
                string path=module.FileName;seen.Add(path);Image image;
                if(!Images.TryGetValue(path,out image)){if(Images.Count>=8)Images.Clear();image=Image.Load(path);Images.Add(path,image);}
                var stat=new FileInfo(path);
                if(stat.Length!=image.Length || stat.LastWriteTimeUtc.Ticks!=image.WriteTicks)throw new InvalidDataException("baseline changed");
                foreach(var section in image.Sections)for(int offset=0;offset<section.Size;offset+=65536) {
                    int size=Math.Min(65536,section.Size-offset);bytes+=size;if(bytes>MaxImage)throw new InvalidDataException("read bound");
                    var actual=new byte[size];IntPtr read;
                    if(!ReadProcessMemory(handle,new IntPtr(module.BaseAddress.ToInt64()+section.Rva+offset),actual,size,out read)||read.ToInt64()!=size)throw new IOException("code read unavailable");
                    for(int j=0;j<size;j++)if(!section.Skip[offset+j] && actual[j]!=section.Bytes[offset+j]) {
                        if(differences.Count<4)differences.Add(module.ModuleName+":rva="+(section.Rva+offset+j).ToString("x")+":image="+image.Hash);
                        break;
                    }
                }
                modules++;
            }
            foreach(string absent in Images.Keys.Where(p=>!seen.Contains(p)).ToArray())Images.Remove(absent);
            if(modules==0)throw new InvalidDataException("protected runtime not loaded");
            mismatchStreak=differences.Count>0?mismatchStreak+1:0;
            lock(Gate) { state=mismatchStreak>=2?"tampered":differences.Count>0?"pending":"clean";
                checkedModules=modules;checkedBytes=bytes;detail=differences.Count>0?String.Join(";",differences):"Protected native code matches its disk image";lastScan=Now();sequence++; }
        } catch(Exception error) {
            mismatchStreak=0;lock(Gate){state="incomplete";detail=error.GetType().Name;checkedModules=modules;checkedBytes=bytes;lastScan=Now();sequence++;}
        }
    }
    static string Answer(string nonce,int pid) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(nonce??"",@"\A[a-f0-9]{48}\z"))throw new InvalidDataException("nonce");
        lock(Gate) {
            if(targetPid==0 || targetPid!=pid || target==null || target.HasExited)throw new InvalidDataException("game identity");
            string status=lastScan==0?"pending":Now()-lastScan>6000?"incomplete":state;
            string payload=String.Join("\n",new[]{"AHT-GUARD-1",nonce,keyHash,targetPid.ToString(),targetBirth.ToString(),sequence.ToString(),lastScan.ToString(),status,checkedModules.ToString(),checkedBytes.ToString(),B64(Encoding.UTF8.GetBytes(detail))});
            byte[] data=Encoding.UTF8.GetBytes(payload);
            return Json.Serialize(new {payload=B64(data),signature=B64(Key.SignData(data,CryptoConfig.MapNameToOID("SHA256"))),modulus=modulus,exponent=exponent});
        }
    }
    static void Serve(TcpListener listener) {
        long nextRequest=0;
        while(!stopping) {
            try {
                if(!listener.Pending()){Thread.Sleep(50);continue;}
                using(var client=listener.AcceptTcpClient()) {
                    client.ReceiveTimeout=1500;client.SendTimeout=1500;
                    using(var stream=client.GetStream()) {
                        var line=ReadLine(stream,256);if(line==null)continue;
                        if(line=="INFO") {byte[] info=Encoding.UTF8.GetBytes(Info()+"\n");stream.Write(info,0,info.Length);continue;}
                        if(Now()<nextRequest)continue;nextRequest=Now()+100;
                        string[] parts=line.Split('|');
                        if(parts.Length!=2)continue;int pid;if(!Int32.TryParse(parts[1],out pid)||pid<=0)continue;
                        byte[] response=Encoding.UTF8.GetBytes(Answer(parts[0],pid)+"\n");stream.Write(response,0,response.Length);
                    }
                }
            }catch { /* A malformed local request is not a clean measurement or an accusation. */ }
        }
    }
    public static int Main() {
        TcpListener listener=null;
        try {
            started=Now();var config=Json.Deserialize<Dictionary<string,object>>(ReadLine(Console.OpenStandardInput(),8192));
            gameDir=PathKey(Text(config["gameDir"]));expectedImage=config.ContainsKey("javaPath")&&Text(config["javaPath"]).Length>0?PathKey(Text(config["javaPath"])):"";
            var key=Key.ExportParameters(false);modulus=B64(key.Modulus);exponent=B64(key.Exponent);keyHash=Hash(Encoding.UTF8.GetBytes(modulus+"."+exponent));
            listener=new TcpListener(IPAddress.Loopback,0);listener.Start(4);port=((IPEndPoint)listener.LocalEndpoint).Port;
            Console.WriteLine(Info());Console.Out.Flush();
            var server=new Thread(()=>Serve(listener));server.IsBackground=true;server.Start();
            while(!stopping) {
                if(target!=null && target.HasExited)break;
                if(targetPid==0 && Now()-started>30*60*1000)break;
                if(DiscoverGame())Scan();
                else lock(Gate) {state="incomplete";detail="No unique matching game process";checkedModules=0;checkedBytes=0;mismatchStreak=0;lastScan=Now();sequence++;}
                Thread.Sleep(2000);
            }
            return 0;
        } catch {return 1;}
        finally {stopping=true;if(listener!=null)listener.Stop();if(handle!=IntPtr.Zero)CloseHandle(handle);if(target!=null)target.Dispose();Key.Dispose();}
    }
}
