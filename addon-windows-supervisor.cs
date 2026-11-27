// Trusted Windows AppContainer launcher. No ordinary-process fallback.
// Inherited handles are stdio, read-only station metadata and a private desktop.
// No capability, existing-desktop handle, clipboard or screen access is granted.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

class AddonWindowsSupervisor {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr Sid,Capabilities; public uint Count,Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)]public bool inherit; }
  [StructLayout(LayoutKind.Sequential)] struct GENERIC_MAPPING { public uint read,write,execute,all; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved,desktop,title; public uint x,y,width,height,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out EXTENDED_LIMIT info,int size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool included);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exit);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exit);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint exit);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr destination,out IntPtr copy,uint access,bool inherit,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateEventW(IntPtr attrs,bool manual,bool initial,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenEventW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEvent(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr copy);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(byte[] descriptor,IntPtr token,uint desired,ref GENERIC_MAPPING mapping,IntPtr privileges,ref uint length,out uint granted,[MarshalAs(UnmanagedType.Bool)]out bool allowed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr info,int length,out int needed);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr acl,out bool defaulted);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name,int kind,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,string device,IntPtr mode,uint flags,uint access,ref SECURITY_ATTRIBUTES attrs);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr handle,ref uint information,byte[] descriptor,uint length,out uint needed);
  static JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=65536 };
  static List<string> grants=new List<string>();
  static void Check(bool value,string step) { if(!value)throw new Win32Exception(Marshal.GetLastWin32Error(),step); }
  static string Text(Dictionary<string,object> c,string key) { object v; if(!c.TryGetValue(key,out v)||!(v is string)||((string)v).Length>32760)throw new Exception("invalid-config");return (string)v; }
  static string Hash(string path) { using(var stream=File.OpenRead(path))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
  static string StationAclHash(IntPtr station){uint info=4,size;GetUserObjectSecurity(station,ref info,null,0,out size);if(size==0||size>65536)throw new Exception("station-acl-size");byte[] bytes=new byte[size];Check(GetUserObjectSecurity(station,ref info,bytes,size,out size),"station-acl-read");using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static void Safe(string path,bool directory) { if(!Path.IsPathRooted(path)||((File.GetAttributes(path)&FileAttributes.Directory)!=0)!=directory||(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new Exception("unsafe-path"); }
  static bool Inside(string root,string path) { return path.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
  static void Grant(string path,SecurityIdentifier sid,bool write) {
    bool dir=Directory.Exists(path);Safe(path,dir);
    FileSystemRights rights=write?FileSystemRights.Modify|FileSystemRights.Synchronize:FileSystemRights.ReadAndExecute|FileSystemRights.Synchronize;
    if(dir){var acl=Directory.GetAccessControl(path);acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(path,acl);}
    else {var acl=File.GetAccessControl(path);acl.AddAccessRule(new FileSystemAccessRule(sid,rights,AccessControlType.Allow));File.SetAccessControl(path,acl);}
    grants.Add(path);
    FileSystemSecurity checkedAcl=dir?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);bool applied=false;
    foreach(FileSystemAccessRule rule in checkedAcl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.IdentityReference.Equals(sid)&&rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&rights)==rights)applied=true;
    if(!applied)throw new Exception("container-storage-grant-not-verified");
  }
  static void GrantTree(string root,SecurityIdentifier sid,bool write) {
    Grant(root,sid,write);int count=0;
    foreach(string p in Directory.EnumerateFileSystemEntries(root,"*",SearchOption.AllDirectories)) { if(++count>1024)throw new Exception("storage-entry-limit");Grant(p,sid,write); }
  }
  static bool Revoke(SecurityIdentifier sid) {
    bool clean=true;for(int i=grants.Count-1;i>=0;i--)try {string p=grants[i];if(Directory.Exists(p)){var a=Directory.GetAccessControl(p);a.PurgeAccessRules(sid);Directory.SetAccessControl(p,a);}else if(File.Exists(p)){var a=File.GetAccessControl(p);a.PurgeAccessRules(sid);File.SetAccessControl(p,a);}}catch{clean=false;}
    // Parent revocation must propagate before checking inherited child ACEs.
    foreach(string p in grants)try{if(!Directory.Exists(p)&&!File.Exists(p))continue;FileSystemSecurity checkedAcl=Directory.Exists(p)?(FileSystemSecurity)Directory.GetAccessControl(p):File.GetAccessControl(p);foreach(FileSystemAccessRule rule in checkedAcl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.IdentityReference.Equals(sid))clean=false;}catch{clean=false;}return clean;
  }
  static void LowIntegrity(string path) {
    IntPtr descriptor=IntPtr.Zero;uint size;
    Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size),"low-integrity-descriptor");
    try{bool present,defaulted;IntPtr acl;Check(GetSecurityDescriptorSacl(descriptor,out present,out acl,out defaulted)&&present,"low-integrity-acl");uint code=SetNamedSecurityInfoW(path,1,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,acl);if(code!=0)throw new Win32Exception((int)code,"low-integrity-data");}finally{LocalFree(descriptor);}
  }
  static string Quote(string s) {var b=new StringBuilder("\"");int slashes=0;foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);return b.Append('"').ToString();}
  static IntPtr TokenData(IntPtr token,int kind) {int size;GetTokenInformation(token,kind,IntPtr.Zero,0,out size);if(size<4||size>65536)throw new Win32Exception(Marshal.GetLastWin32Error(),"token-query-size-"+kind+"-"+size);IntPtr p=Marshal.AllocHGlobal(size);if(!GetTokenInformation(token,kind,p,size,out size)){Marshal.FreeHGlobal(p);Check(false,"token-query-"+kind);}return p;}
  static int TokenInt(IntPtr token,int kind) {IntPtr p=TokenData(token,kind);try{return Marshal.ReadInt32(p);}finally{Marshal.FreeHGlobal(p);}}
  static bool HasGroup(IntPtr token,string sid) {IntPtr p=TokenData(token,2);try{int count=Marshal.ReadInt32(p);if(count<0||count>4096)throw new Exception("invalid-token-groups");int offset=IntPtr.Size==8?8:4,stride=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));for(int i=0;i<count;i++){IntPtr value=Marshal.ReadIntPtr(p,offset+i*stride);if(new SecurityIdentifier(value).Value==sid)return true;}return false;}finally{Marshal.FreeHGlobal(p);}}
  static int CheckProtectedPaths(Dictionary<string,object> config,IntPtr token) {
    if(!config.ContainsKey("protectedPaths")||!(config["protectedPaths"] is System.Collections.IEnumerable))throw new Exception("protected-paths-required");
    var paths=new List<string>();foreach(object value in (System.Collections.IEnumerable)config["protectedPaths"]){if(!(value is string)||paths.Count>=16)throw new Exception("invalid-protected-path");paths.Add((string)value);}if(paths.Count<1)throw new Exception("protected-paths-required");
    IntPtr impersonation;Check(DuplicateToken(token,2,out impersonation),"duplicate-access-check-token");
    try{foreach(string path in paths){bool dir=Directory.Exists(path);Safe(path,dir);byte[] descriptor=dir?Directory.GetAccessControl(path).GetSecurityDescriptorBinaryForm():File.GetAccessControl(path).GetSecurityDescriptorBinaryForm();
      // Read data/list, write data/create file, append/create directory, delete,
      // change DACL and take ownership must all be denied by the actual token.
      foreach(uint desired in new uint[]{1,2,4,0x10000,0x40000,0x80000}){var mapping=new GENERIC_MAPPING { read=0x120089,write=0x120116,execute=0x1200a0,all=0x1f01ff };uint length=4096,granted;bool allowed;IntPtr privileges=Marshal.AllocHGlobal(4096);try{Check(AccessCheck(descriptor,impersonation,desired,ref mapping,privileges,ref length,out granted,out allowed),"protected-path-access-check");if(allowed)throw new Exception("protected-path-access-not-denied");}finally{Marshal.FreeHGlobal(privileges);}}
    }return paths.Count;}finally{CloseHandle(impersonation);}
  }
  static void Attribute(IntPtr list,long kind,IntPtr data,int size){Check(UpdateProcThreadAttribute(list,0,new IntPtr(kind),data,new IntPtr(size),IntPtr.Zero,IntPtr.Zero),"process-attribute");}
  static void Emit(object value){Console.Error.WriteLine("FQSUPERVISOR "+json.Serialize(value));Console.Error.Flush();}
  public static int Main(string[] args) {
    if(args.Length==2&&args[0]=="--stop") {IntPtr e=OpenEventW(2,false,args[1]);if(e==IntPtr.Zero)return 2;try{return SetEvent(e)?0:3;}finally{CloseHandle(e);}}
    if(args.Length!=1)return 2;
    string profile="FirmQuill.Addon."+Guid.NewGuid().ToString("N");IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,stop=IntPtr.Zero,token=IntPtr.Zero,attrs=IntPtr.Zero,envPtr=IntPtr.Zero,desktop=IntPtr.Zero,oldStation=IntPtr.Zero,oldDesktop=IntPtr.Zero,stationCopy=IntPtr.Zero,desktopCopy=IntPtr.Zero,desktopSd=IntPtr.Zero,parent=IntPtr.Zero;var allocated=new List<IntPtr>();var inherited=new List<IntPtr>();var pi=new PROCESS_INFORMATION();SecurityIdentifier identity=null;bool started=false,clean=false;string nonce="",stationAcl="";
    try {
      var c=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[0]));nonce=Text(c,"nonce");bool lpac=c.ContainsKey("lessPrivileged")&&(c["lessPrivileged"] is bool)&&(bool)c["lessPrivileged"];string node=Text(c,"node"),runner=Text(c,"runner"),payload=Text(c,"payload"),data=Text(c,"data"),entry=Text(c,"entry"),control=Text(c,"control");
      Safe(node,false);Safe(runner,false);Safe(payload,true);Safe(data,true);Safe(entry,false);if(!Inside(payload,entry)||Inside(payload,data)||Inside(data,payload)||!node.EndsWith("node.exe",StringComparison.OrdinalIgnoreCase)||!runner.EndsWith(".mjs",StringComparison.OrdinalIgnoreCase))throw new Exception("unsafe-layout");
      parent=OpenProcess(0x100000,false,Convert.ToUInt32(c["parentPid"]));Check(parent!=IntPtr.Zero,"supervisor-parent");
      if(Hash(node)!=Text(c,"nodeHash")||Hash(runner)!=Text(c,"runnerHash"))throw new Exception("trusted-runtime-hash");
      int hr=CreateAppContainerProfile(profile,profile,"FirmQuill isolated add-on",IntPtr.Zero,0,out sid);if(hr!=0)Marshal.ThrowExceptionForHR(hr);identity=new SecurityIdentifier(sid);
      if(Path.GetDirectoryName(node)!=Path.GetDirectoryName(runner))throw new Exception("unsafe-runtime-layout");GrantTree(Path.GetDirectoryName(node),identity,false);GrantTree(payload,identity,false);GrantTree(data,identity,true);LowIntegrity(data);
      // A specified window-station name requires Administrators membership.
      // The documented non-admin path creates a private desktop on the current
      // station and inherits only a READATTRIBUTES station handle plus that
      // private desktop. No existing station/desktop security is modified.
      string desktopName="FirmQuillAddon"+Guid.NewGuid().ToString("N"),owner=WindowsIdentity.GetCurrent().User.Value;uint sdLength;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+owner+"D:P(A;;GA;;;"+owner+")(A;;GA;;;SY)(A;;0x00000083;;;"+identity.Value+")S:(ML;;NW;;;LW)",1,out desktopSd,out sdLength),"private-desktop-security");
      var desktopAttrs=new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),descriptor=desktopSd,inherit=false };
      oldStation=GetProcessWindowStation();Check(oldStation!=IntPtr.Zero,"current-window-station");stationAcl=StationAclHash(oldStation);oldDesktop=GetThreadDesktop(GetCurrentThreadId());Check(oldDesktop!=IntPtr.Zero,"current-desktop");desktop=CreateDesktopW(desktopName,null,IntPtr.Zero,0,0xF01FF,ref desktopAttrs);Check(desktop!=IntPtr.Zero,"private-desktop");
      job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"create-job");var limit=new EXTENDED_LIMIT();limit.basic.flags=0x2000|0x8|0x100;limit.basic.active=1;limit.processMemory=new UIntPtr(512UL*1024UL*1024UL);Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(EXTENDED_LIMIT))),"job-limits");
      stop=CreateEventW(IntPtr.Zero,true,false,control);Check(stop!=IntPtr.Zero,"create-stop-event");
      int attributeCount=lpac?4:3;IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,attributeCount,0,ref size);attrs=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attrs,attributeCount,0,ref size),"attribute-list");
      var capabilities=new SECURITY_CAPABILITIES { Sid=sid,Capabilities=IntPtr.Zero,Count=0,Reserved=0 };IntPtr cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));allocated.Add(cap);Marshal.StructureToPtr(capabilities,cap,false);Attribute(attrs,0x20009,cap,Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      if(lpac){IntPtr policy=Marshal.AllocHGlobal(4);allocated.Add(policy);Marshal.WriteInt32(policy,1);Attribute(attrs,0x2000f,policy,4);} // LPAC: opt out of ALL APPLICATION PACKAGES
      IntPtr childPolicy=Marshal.AllocHGlobal(4);allocated.Add(childPolicy);Marshal.WriteInt32(childPolicy,1);Attribute(attrs,0x2000e,childPolicy,4); // no child processes
      foreach(int handle in new[]{-10,-11,-12}){IntPtr copy;Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(handle),GetCurrentProcess(),out copy,0,true,2),"stdio-handle");inherited.Add(copy);}
      Check(DuplicateHandle(GetCurrentProcess(),oldStation,GetCurrentProcess(),out stationCopy,2,true,0),"station-read-handle");inherited.Add(stationCopy);Check(DuplicateHandle(GetCurrentProcess(),desktop,GetCurrentProcess(),out desktopCopy,0x83,true,0),"private-desktop-handle");inherited.Add(desktopCopy);
      IntPtr handles=Marshal.AllocHGlobal(IntPtr.Size*inherited.Count);allocated.Add(handles);for(int i=0;i<inherited.Count;i++)Marshal.WriteIntPtr(handles,i*IntPtr.Size,inherited[i]);Attribute(attrs,0x20002,handles,IntPtr.Size*inherited.Count);
      var startup=new STARTUPINFOEX();startup.info.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.info.flags=0x100;startup.info.desktop=desktopName;startup.info.input=inherited[0];startup.info.output=inherited[1];startup.info.error=inherited[2];startup.attributes=attrs;
      var environment=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);environment["SystemRoot"]=Environment.GetEnvironmentVariable("SystemRoot")??"C:\\Windows";environment["WINDIR"]=environment["SystemRoot"];environment["TEMP"]=data;environment["TMP"]=data;environment["LOCALAPPDATA"]=data;environment["NODE_NO_WARNINGS"]="1";
      string block=String.Join("\0",environment.Select(kv=>kv.Key+"="+kv.Value).ToArray())+"\0\0";envPtr=Marshal.StringToHGlobalUni(block);
      // Canonical paths and link-free payloads were verified by the trusted
      // parent. Avoid Node probing inaccessible ancestor directories solely to
      // canonicalize main/module names; actual OS and Node file rights remain.
      string[] command={node,"--permission","--no-addons","--preserve-symlinks-main","--preserve-symlinks","--allow-fs-read="+runner,"--allow-fs-read="+payload,"--allow-fs-read="+data,"--allow-fs-write="+data,"--max-old-space-size=128","--disable-proto=throw",runner,entry,data};
      // DETACHED_PROCESS keeps redirected pipes without console allocation.
      // CREATE_NO_WINDOW makes USER32 initialization fail in this restricted
      // desktop path (0xC0000142), before Node executes any JavaScript.
      Check(CreateProcessW(node,new StringBuilder(String.Join(" ",command.Select(Quote).ToArray())),IntPtr.Zero,IntPtr.Zero,true,0x80000|4|0x400|8,envPtr,data,ref startup,out pi),"create-lpac-process");started=true;
      Check(AssignProcessToJobObject(job,pi.process),"assign-job");Check(OpenProcessToken(pi.process,10,out token),"open-token");
      // Some GetTokenInformation implementations reject class 46. LPAC is
      // requested with the mandatory opt-out attribute above, then independently
      // checked by absence of ALL APPLICATION PACKAGES in the resulting token.
      bool allPackages=HasGroup(token,"S-1-15-2-1");if(TokenInt(token,29)!=1||lpac&&allPackages||TokenInt(token,30)!=0)throw new Exception("unverified-appcontainer-token");
      IntPtr package=TokenData(token,31);string packageSid;try{packageSid=new SecurityIdentifier(Marshal.ReadIntPtr(package)).Value;}finally{Marshal.FreeHGlobal(package);}if(packageSid!=identity.Value)throw new Exception("wrong-container-sid");
      bool included;Check(IsProcessInJob(pi.process,job,out included)&&included,"verify-job-membership");EXTENDED_LIMIT verified;Check(QueryInformationJobObject(job,9,out verified,Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero),"verify-job-limits");if((verified.basic.flags&0x2008)!=0x2008||verified.basic.active!=1)throw new Exception("unverified-job");
      int checkedPaths=CheckProtectedPaths(c,token);
      Emit(new {phase="verified",nonce=nonce,pid=pi.pid,appContainer=true,lpac=lpac,lpacVerification=lpac?"opt-out-attribute-and-token-groups":"not-requested",allApplicationPackages=allPackages,capabilities=0,appContainerSid=packageSid,activeProcessLimit=1,killOnClose=true,processMemoryLimit=536870912,noNetworkCapabilities=true,protectedPathsDenied=checkedPaths,privateDesktop=true,inheritedStationReadOnly=true,stationHandleAccess=2,desktopHandleAccess=0x83,parentMonitored=true,stationAclUnchanged=StationAclHash(oldStation)==stationAcl});
      Check(ResumeThread(pi.thread)!=0xffffffff,"resume-service");
      uint wait=WaitForMultipleObjects(3,new[]{pi.process,stop,parent},false,0xffffffff);if(wait==1||wait==2)TerminateJobObject(job,1);else if(wait!=0)throw new Exception("supervisor-wait");
      WaitForSingleObject(pi.process,5000);uint exitCode;GetExitCodeProcess(pi.process,out exitCode);Emit(new {phase="service-exit",nonce=nonce,code=exitCode});clean=true;return 0;
    } catch(Exception e) {Emit(new {phase="failed",nonce=nonce,reason=e.Message,win32=e is Win32Exception?((Win32Exception)e).NativeErrorCode:0});return 1;}
    finally {
      // Even a suspended process not yet assigned to the job must be terminated.
      if(started&&pi.process!=IntPtr.Zero)TerminateProcess(pi.process,1);if(job!=IntPtr.Zero){TerminateJobObject(job,1);CloseHandle(job);}
      bool processEnded=pi.process==IntPtr.Zero||WaitForSingleObject(pi.process,5000)==0;
      if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(token!=IntPtr.Zero)CloseHandle(token);if(stop!=IntPtr.Zero)CloseHandle(stop);if(parent!=IntPtr.Zero)CloseHandle(parent);
      foreach(IntPtr h in inherited)if(h!=stationCopy&&h!=desktopCopy)CloseHandle(h);if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr p in allocated)Marshal.FreeHGlobal(p);if(envPtr!=IntPtr.Zero)Marshal.FreeHGlobal(envPtr);bool threadRestored=oldDesktop==IntPtr.Zero||SetThreadDesktop(oldDesktop);bool privateCopyClosed=desktopCopy==IntPtr.Zero||CloseDesktop(desktopCopy);bool privateOriginalClosed=desktop==IntPtr.Zero||CloseDesktop(desktop);bool privateDesktopClosed=privateCopyClosed&&privateOriginalClosed;bool stationHandleClosed=stationCopy==IntPtr.Zero||CloseWindowStation(stationCopy);bool stationAclUnchanged=false;try{stationAclUnchanged=oldStation==IntPtr.Zero||stationAcl==""||StationAclHash(oldStation)==stationAcl;}catch{}if(desktopSd!=IntPtr.Zero)LocalFree(desktopSd);
      bool revoked=identity==null||Revoke(identity);int deleted=sid!=IntPtr.Zero?DeleteAppContainerProfile(profile):0;if(sid!=IntPtr.Zero)FreeSid(sid);
      Emit(new {phase="closed",nonce=nonce,profileDeleted=deleted==0,jobClosed=true,processEnded=processEnded,aclCleanup=revoked,privateDesktopClosed=privateDesktopClosed,threadDesktopRestored=threadRestored,stationHandleClosed=stationHandleClosed,stationAclUnchanged=stationAclUnchanged,serviceStarted=started,serviceWaited=clean||processEnded});
    }
  }
}
