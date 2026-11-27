// Compile and launch only the trusted native supervisor. Never fall back to a
// normal Node child if token/job verification or cleanup cannot be completed.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,lstat,realpath,open,rename,unlink,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';

const exec=promisify(execFile),source=fileURLToPath(new URL('./addon-windows-supervisor.cs',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=(ok,message)=>{if(!ok)throw Error('Windows add-on isolation: '+message);};
const inside=(root,path)=>{const d=relative(root,path);return !!d&&!isAbsolute(d)&&!/^\.\.(?:[\\/]|$)/.test(d);};
const systemRoot=process.env.SystemRoot||'C:\\Windows';
const minimalEnv={SystemRoot:systemRoot,WINDIR:systemRoot};
async function safe(path,directory){
  need(typeof path==='string'&&isAbsolute(path),'absolute paths required');const st=await lstat(path);
  need(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()),'regular local files/directories required');
  const canonical=await realpath(path);need(canonical.toLowerCase()===resolve(path).toLowerCase(),'junctions are not supported');return canonical;
}
async function protect(path,fresh=false){
  const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');if($env:FQ_FRESH -eq 'yes'){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($s in @($sid.Value,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath $env:FQ_PATH -AclObject $a};$paths=@(Get-Item -LiteralPath $env:FQ_PATH)+@(Get-ChildItem -LiteralPath $env:FQ_PATH -Recurse -Force);if($paths.Count -gt 4096){throw 'Too many supervisor files'};foreach($p in $paths){if($p.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe link'};$a=Get-Acl -LiteralPath $p.FullName;$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;if($allowed -notcontains $owner){throw 'Untrusted owner'};foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights.value__ -band 852310) -ne 0 -and $allowed -notcontains $r.IdentityReference.Value){throw 'Untrusted write access'}}};'protected'";
  const r=await exec(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:4096,env:{...minimalEnv,FQ_PATH:path,FQ_FRESH:fresh?'yes':'no'}});
  need(r.stdout.trim()==='protected','private supervisor/storage ACL verification failed');
}
async function compile(root){
  const bytes=await readFile(source),sourceHash=hash(bytes),name='supervisor-'+sourceHash;
  const exe=join(root,name+'.exe'),manifest=join(root,name+'.json'),lockPath=join(root,name+'.lock');
  async function existing(){try{const row=JSON.parse(await readFile(manifest,'utf8'));need(row.sourceHash===sourceHash&&row.binaryHash===hash(await readFile(await safe(exe,false))),'supervisor binary hash mismatch');return {exe,...row};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  let found=await existing();if(found)return found;
  let lock;try{lock=await open(lockPath,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,100));found=await existing();if(found)return found;}throw Error('Windows add-on isolation: supervisor compilation lock needs operator review');}
  const temp=join(root,name+'.'+randomBytes(8).toString('hex')+'.exe');
  try{
    const compiler=join(systemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');await safe(compiler,false);
    await exec(compiler,['/nologo','/optimize+','/platform:x64','/target:exe','/reference:System.Web.Extensions.dll','/out:'+temp,source],{windowsHide:true,timeout:30000,maxBuffer:8192,env:minimalEnv});
    need(hash(await readFile(source))===sourceHash,'supervisor source changed during compilation');
    const row={format:1,sourceHash,binaryHash:hash(await readFile(temp)),compilerHash:hash(await readFile(compiler))};
    await rename(temp,exe);await writeFile(manifest,JSON.stringify(row)+'\n',{flag:'wx',mode:0o600});return {exe,...row};
  }finally{await unlink(temp).catch(()=>{});await lock.close();await unlink(lockPath).catch(()=>{});}
}
export async function startWindowsAddon({nodePath=process.execPath,runnerPath,payloadDirectory,dataDirectory,supervisorDirectory,args=[],lessPrivileged=false,protectedPaths=[]}={}){
  need(process.platform==='win32','Windows AppContainer support required');
  need(Number(process.versions.node.split('.')[0])>=24,'Node 24 or later required');
  need(Array.isArray(args)&&args.length===1&&typeof args[0]==='string','one sealed payload entry is required');
  need(typeof lessPrivileged==='boolean','explicit AppContainer policy required');
  need(Array.isArray(protectedPaths)&&protectedPaths.length>=1&&protectedPaths.length<=16,'protected core/database paths are required');
  const protectedCanonical=[];for(const path of protectedPaths){const info=await lstat(path);protectedCanonical.push(await safe(path,info.isDirectory()));}
  const originalNode=await safe(nodePath,false),runnerSource=await safe(runnerPath,false),payload=await safe(payloadDirectory,true),data=await safe(dataDirectory,true);
  const entry=await safe(args[0],false);need(inside(payload,entry)&&entry.toLowerCase().endsWith('.mjs'),'entry must be a sealed payload .mjs');
  need(!inside(payload,data)&&!inside(data,payload)&&payload!==data,'payload and private data must be separate');
  need(typeof supervisorDirectory==='string'&&isAbsolute(supervisorDirectory),'dedicated supervisor directory required');
  let fresh=false;try{await mkdir(supervisorDirectory,{mode:0o700});fresh=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  const root=await safe(supervisorDirectory,true);need(!inside(payload,root)&&!inside(root,payload)&&!inside(data,root)&&!inside(root,data)&&root!==payload&&root!==data,'supervisor must be separate from payload/data');
  await protect(root,fresh);await protect(payload);await protect(data);
  const compiled=await compile(root),nodeHash=hash(await readFile(originalNode)),runnerHash=hash(await readFile(runnerSource));
  need(nodeHash===hash(await readFile(process.execPath)),'Node executable differs from the running verified host');
  const launch=join(root,'run-'+randomBytes(16).toString('hex'));await mkdir(launch,{mode:0o700});
  const runtime=join(launch,'runtime');await mkdir(runtime,{mode:0o700});
  const node=join(runtime,'node.exe'),runner=join(runtime,'runner.mjs'),configPath=join(launch,'launch.json');
  const nonce=randomBytes(32).toString('hex'),control='Local\\FirmQuillAddon-'+randomBytes(24).toString('hex');
  await copyFile(originalNode,node);await copyFile(runnerSource,runner);
  need(hash(await readFile(node))===nodeHash&&hash(await readFile(runner))===runnerHash,'runtime copy failed integrity verification');
  need(protectedCanonical.every(path=>!inside(payload,path)&&!inside(data,path)&&path!==payload&&path!==data),'protected paths overlap package storage');
  await writeFile(configPath,JSON.stringify({nonce,node,runner,payload,data,entry,control,nodeHash,runnerHash,lessPrivileged,protectedPaths:protectedCanonical,parentPid:process.pid}),{flag:'wx',mode:0o600});
  const child=spawn(compiled.exe,[configPath],{cwd:launch,env:minimalEnv,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  const result=new EventEmitter(),stderr=new PassThrough();result.stdin=child.stdin;result.stdout=child.stdout;result.stderr=stderr;
  let verification=null,cleanup=null,buffer='',stderrSize=0,exited=false,closePromise,stopRequested=false,nativeFailed=false,stopPromise=Promise.resolve();
  let resolveVerify,rejectVerify;const verified=new Promise((yes,no)=>{resolveVerify=yes;rejectVerify=no;});
  const stop=()=>{if(exited||stopRequested)return false;stopRequested=true;stopPromise=exec(compiled.exe,['--stop',control],{env:minimalEnv,windowsHide:true,timeout:3000,maxBuffer:2048}).catch(()=>child.kill('SIGKILL'));return true;};
  result.kill=()=>stop();
  result.close=async()=>{stop();await closePromise;await stopPromise;need(cleanup?.profileDeleted===true&&cleanup.jobClosed===true&&cleanup.processEnded===true&&cleanup.aclCleanup===true&&cleanup.privateDesktopClosed===true&&cleanup.threadDesktopRestored===true&&cleanup.stationHandleClosed===true&&cleanup.stationAclUnchanged===true,'native profile/job/desktop cleanup could not be verified');};
  closePromise=new Promise(resolveClose=>child.once('close',async(code,signal)=>{
    exited=true;rejectVerify(Error('Windows add-on isolation: supervisor exited before verification'));
    try{const checked=resolve(launch);need(inside(root,checked),'unsafe cleanup path');await rm(checked,{recursive:true,force:true});}catch{}
    stderr.end();result.exitCode=code;result.signalCode=signal;result.emit('close',code,signal);resolveClose();
  }));
  child.on('error',cause=>{rejectVerify(cause);if(result.listenerCount('error'))result.emit('error',cause);});
  child.once('exit',(code,signal)=>{result.exitCode=code;result.signalCode=signal;result.emit('exit',code,signal);});
  child.stderr.on('data',chunk=>{
    stderrSize+=chunk.length;if(stderrSize>65536){rejectVerify(Error('Windows add-on isolation: excessive supervisor output'));stop();return;}
    buffer+=chunk.toString('utf8');let index;
    while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index).trimEnd();buffer=buffer.slice(index+1);
      if(!line.startsWith('FQSUPERVISOR ')){stderr.write(line+'\n');continue;}
      let value;try{value=JSON.parse(line.slice(13));}catch{rejectVerify(Error('Windows add-on isolation: malformed native evidence'));stop();continue;}
      if(value.nonce!==nonce){stderr.write(line+'\n');continue;}
      if(value.phase==='verified'&&!verification){
        if(value.appContainer!==true||value.lpac!==lessPrivileged||lessPrivileged&&value.allApplicationPackages!==false||value.capabilities!==0||value.activeProcessLimit!==1||value.killOnClose!==true||value.noNetworkCapabilities!==true||value.protectedPathsDenied!==protectedCanonical.length||value.privateDesktop!==true||value.inheritedStationReadOnly!==true||value.stationHandleAccess!==2||value.desktopHandleAccess!==0x83||value.stationAclUnchanged!==true||value.parentMonitored!==true||!/^S-1-15-2-/.test(value.appContainerSid)||!Number.isInteger(value.pid)){
          rejectVerify(Error('Windows add-on isolation: native protection evidence rejected'));stop();continue;
        }
        verification=value;result.pid=value.pid;result.protection=Object.freeze({...value,nonce:undefined,supervisor:lessPrivileged?'windows-lpac-job-v1':'windows-appcontainer-job-v1',nativeSourceSha256:compiled.sourceHash,nativeBinarySha256:compiled.binaryHash,nodeSha256:nodeHash,runnerSha256:runnerHash});resolveVerify();
      }else if(value.phase==='failed'){nativeFailed=true;rejectVerify(Error('Windows add-on isolation: '+value.reason+' (Win32 '+value.win32+')'));}
      else if(value.phase==='service-exit'){result.serviceExitCode=value.code;stderr.write('Windows isolated service exited with code '+value.code+'.\n');}
      else if(value.phase==='closed')cleanup=value;
    }
  });
  const timer=setTimeout(()=>{rejectVerify(Error('Windows add-on isolation: native verification timeout'));stop();},15000);
  try{await verified;return result;}catch(cause){
    if(!nativeFailed)stop();await closePromise;await stopPromise;cause.isolationCleanup=cleanup??null;
    if(cleanup?.profileDeleted!==true||cleanup.jobClosed!==true||cleanup.processEnded!==true||cleanup.aclCleanup!==true||cleanup.privateDesktopClosed!==true||cleanup.threadDesktopRestored!==true||cleanup.stationHandleClosed!==true||cleanup.stationAclUnchanged!==true){
      const failure=Error('Windows add-on isolation: native cleanup could not be verified after startup failure');failure.cause=cause;failure.isolationCleanup=cleanup??null;throw failure;
    }
    throw cause;
  }finally{clearTimeout(timer);}
}
