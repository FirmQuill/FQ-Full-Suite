// Shared v1 installer: declarative data or contained Node runtimes; never core overlays.
import {createHash,createPublicKey,verify,randomBytes} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,open,rename,unlink,readdir,realpath,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startAddonService} from './addon-service-host.mjs';
import {addonHttps} from './addon-network-broker.mjs';

const exec=promisify(execFile), app=dirname(fileURLToPath(import.meta.url));
const MAX=2*1024*1024, idPattern=/^[a-z][a-z0-9-]{2,63}$/, hex=/^[a-f0-9]{64}$/;
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const need=(value,message)=>{if(!value)fail(message);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const inside=(a,b)=>{const p=relative(a,b);return !p||!isAbsolute(p)&&!/^\.\.(?:[\\/]|$)/.test(p);};
const decode=s=>{need(typeof s==='string'&&s.length>0&&/^[A-Za-z0-9_-]+$/.test(s),'Invalid package encoding.');const b=Buffer.from(s,'base64url');need(b.toString('base64url')===s,'Invalid package encoding.');return b;};
const version=s=>{need(typeof s==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(s),'Unsupported compatibility version.');return s.split('.').map(Number);};
const compare=(a,b)=>{for(let i=0;i<3;i++)if(a[i]!==b[i])return Math.sign(a[i]-b[i]);return 0;};
const scalar=(field,value)=>field.type==='string'?typeof value==='string'&&value.length<=(field.maxLength??200):field.type==='boolean'?typeof value==='boolean':Number.isInteger(value)&&value>=field.min&&value<=field.max;
export function validateAddonSettings(schema,settings){
  need(settings&&typeof settings==='object'&&!Array.isArray(settings)&&Object.keys(settings).length===schema.length,'Settings do not match the signed schema.');
  const out=Object.create(null);for(const f of schema){need(Object.hasOwn(settings,f.key)&&scalar(f,settings[f.key]),'Invalid value for '+f.key+'.');out[f.key]=settings[f.key];}return out;
}
export function inspectAddon(bytes,key,{installationId,runtime='0.6.5'}={}){
  need(bytes.length<=MAX,'Add-on exceeds size limit.');let envelope;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid add-on JSON.');}
  need(exact(envelope,['signed','signature']),'Invalid signed envelope.');const signed=decode(envelope.signed),signature=decode(envelope.signature);
  need(signature.length===64&&verify(null,signed,key,signature),'Publisher signature did not verify.');
  let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(signed));}catch{fail('Invalid signed manifest.');}
  need(exact(p,['format','id','name','revision','installationId','compatibility','type','permissions','settings','files','network'])&&p.format==='firmquill.addon.v1','Unsupported add-on format.');
  need(typeof p.id==='string'&&idPattern.test(p.id)&&typeof p.name==='string'&&p.name.length>0&&p.name.length<=80&&Number.isSafeInteger(p.revision)&&p.revision>0,'Invalid add-on identity or revision.');
  need(p.installationId===installationId&&hex.test(installationId),'Add-on belongs to another installation.');
  need(exact(p.compatibility,['min','max','hostApi'])&&p.compatibility.hostApi===1,'Unsupported service interface.');
  const minimum=version(p.compatibility.min),maximum=version(p.compatibility.max),current=version(runtime);
  need(compare(minimum,maximum)<=0&&compare(minimum,current)<=0&&compare(current,maximum)<=0,'Add-on is incompatible with this ERP version.');
  need(['settings','service'].includes(p.type)&&Array.isArray(p.permissions)&&p.permissions.length>=1&&new Set(p.permissions).size===p.permissions.length&&p.permissions.includes('settings')&&p.permissions.every(x=>['settings','service.runtime','network.https','workspace.read','workspace.write','workspace.write.auto'].includes(x))&&(p.type==='service')===p.permissions.includes('service.runtime'),'Unsupported package permissions.');
  need(p.type==='service'||p.permissions.length===1,'Data-only add-ons can request settings only.');
  need(!p.permissions.includes('workspace.write.auto')||p.permissions.includes('workspace.write'),'Automatic writes require the write permission.');
  need(Array.isArray(p.network)&&p.network.length<=8&&new Set(p.network).size===p.network.length&&p.network.every(origin=>typeof origin==='string'&&/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?$/.test(origin)&&origin===new URL(origin).origin&&!/\.(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(new URL(origin).hostname)&&/\.[a-z]{2,63}$/.test(new URL(origin).hostname))&&p.permissions.includes('network.https')===(p.network.length>0),'Unsupported HTTPS destinations.');
  need(Array.isArray(p.settings)&&p.settings.length<=16,'Invalid signed settings schema.');const keys=new Set();
  for(const f of p.settings){
    need(f&&typeof f==='object'&&typeof f.key==='string'&&/^[a-z][a-zA-Z0-9]{0,31}$/.test(f.key)&&!['constructor','prototype','__proto__'].includes(f.key)&&!keys.has(f.key)&&typeof f.label==='string'&&f.label.length>0&&f.label.length<=80,'Invalid setting key or label.');keys.add(f.key);
    const fields=f.type==='integer'?['key','label','type','default','min','max']:f.type==='string'?['key','label','type','default','maxLength']:['key','label','type','default'];
    need(exact(f,fields)&&['string','integer','boolean'].includes(f.type),'Unsupported setting type.');
    if(f.type==='integer')need(Number.isInteger(f.min)&&Number.isInteger(f.max)&&f.min>=-2147483648&&f.max<=2147483647&&f.min<=f.max,'Invalid integer range.');
    if(f.type==='string')need(Number.isInteger(f.maxLength)&&f.maxLength>=1&&f.maxLength<=200,'Invalid text length.');need(scalar(f,f.default),'Invalid setting default.');
  }
  need(p.files&&typeof p.files==='object'&&!Array.isArray(p.files),'Invalid file manifest.');const files=Object.create(null);
  if(p.type==='settings')need(Object.keys(p.files).length===0,'Settings add-ons cannot contain executable files.');
  else {
    const names=Object.keys(p.files);need(names.length>=1&&names.length<=32&&names.includes('service.mjs')&&new Set(names.map(n=>n.toLowerCase())).size===names.length&&names.every(n=>!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n)),'Service entry service.mjs and unique Windows-safe file names are required.');let size=0;
    for(const name of names){need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.(?:mjs|json)$/.test(name)&&exact(p.files[name],['sha256','content']),'Only flat JavaScript modules and JSON data are supported.');const f=p.files[name],bytes=decode(f.content);size+=bytes.length;need(bytes.length<=512*1024&&size<=1024*1024&&hex.test(f.sha256)&&digest(bytes)===f.sha256,'Service integrity check failed.');new TextDecoder('utf-8',{fatal:true}).decode(bytes);files[name]=bytes;}
  }
  return {manifest:p,digest:digest(bytes),bytes:Buffer.from(bytes),files};
}
async function bounded(path,cap=MAX){const st=await lstat(path);need(st.isFile()&&!st.isSymbolicLink()&&st.size<=cap,'Unsafe or oversized add-on file.');const b=await readFile(path);need(b.length===st.size,'Add-on changed while reading.');return b;}
// Provision a new dedicated state directory; existing directories must already be protected.
async function protectWindows(state,keyFile,fresh){
  const script=`$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');if($env:FQ_ADDON_FRESH -eq 'yes'){$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);foreach($s in @($sid.Value,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($r)};Set-Acl -LiteralPath $env:FQ_ADDON_STATE -AclObject $acl}; $paths=@(Get-Item -LiteralPath $env:FQ_ADDON_STATE)+@(Get-ChildItem -LiteralPath $env:FQ_ADDON_STATE -Recurse -Force)+@(Get-Item -LiteralPath $env:FQ_ADDON_KEY)+@(Get-Item -LiteralPath (Split-Path -Parent $env:FQ_ADDON_STATE))+@(Get-Item -LiteralPath (Split-Path -Parent $env:FQ_ADDON_KEY));if($paths.Count -gt 8192){throw 'Too many state files'};foreach($item in $paths){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe state link'};$p=$item.FullName;$a=Get-Acl -LiteralPath $p;if($a.Owner -eq $null){throw 'Missing owner'};$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;if($allowed -notcontains $owner){throw 'Untrusted owner'};foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights.value__ -band 852310) -ne 0 -and $allowed -notcontains $r.IdentityReference.Value){throw 'Untrusted write access'}}};Write-Output 'protected'`;
  const result=await exec(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:4096,env:{SystemRoot:process.env.SystemRoot||'C:\\Windows',FQ_ADDON_STATE:state,FQ_ADDON_KEY:keyFile,FQ_ADDON_FRESH:fresh?'yes':'no'}});
  need(result.stdout.trim()==='protected','Add-on state permissions could not be verified.');
}
export function addonOptionsFromEnv(env=process.env){return {publisherKey:env.FIRMQUILL_ADDON_PUBLISHER_PUBLIC_KEY||env.FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY,directory:env.FIRMQUILL_PACKAGES_DIR||join(app,'packages')};}
export async function createAddonInstaller({directory=join(app,'packages'),publisherKey,activationDirectory,activation,runtime='0.6.5',protectedPaths=[],authorizeRuntime=()=>{},serviceStart=startAddonService,workspaceBridge=async()=>{throw Error('Workspace API bridge unavailable.');},httpsTransport,monitorMs=1000}={}){
  let key,stateRoot,lock,problem='',busy=false,closed=false,timer,inFlight=Promise.resolve();let state={format:1,installed:{}},services=new Map();
  const installationId=activation?.status().installationId;
  const permitted=p=>activation.addonAllows(p.id,p.revision,p.permissions);
  const cachePath=d=>{need(hex.test(d),'Invalid cached package identity.');return join(stateRoot,d+'.fqaddon');};
  async function cached(d){const p=inspectAddon(await bounded(cachePath(d)),key,{installationId,runtime});need(p.digest===d,'Cached package integrity check failed.');return p;}
  async function save(next){
    need(Buffer.byteLength(JSON.stringify(next))<=2*1024*1024,'Installer history is full; archive completed work before adding more.');
    const path=join(stateRoot,'state.json'),temp=path+'.'+randomBytes(8).toString('hex')+'.partial';
    try{const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(next)+'\n');await f.sync();}finally{await f.close();}await rename(temp,path);state=next;}finally{await unlink(temp).catch(()=>{});}
  }
  const copyState=()=>structuredClone(state);
  const settingsFor=(p,old={})=>Object.fromEntries(p.settings.map(f=>[f.key,scalar(f,old[f.key])?old[f.key]:f.default]));
  const dataPath=(packageDigest,settings)=>join(stateRoot,'runtime-data-'+digest(JSON.stringify([packageDigest,Object.fromEntries(Object.entries(settings).sort(([a],[b])=>a.localeCompare(b)))])));
  async function start(p,settings,approval,previous){
    authorizeRuntime(approval);
    let committed=false,service;
    const payloadDirectory=join(stateRoot,'payload-'+p.digest);await mkdir(payloadDirectory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    for(const [name,bytes] of Object.entries(p.files)){const path=join(payloadDirectory,name);try{const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}catch(e){if(e.code!=='EEXIST')throw e;}need((await bounded(path,512*1024)).equals(bytes),'Sealed runtime file changed.');}
    need((await readdir(payloadDirectory)).length===Object.keys(p.files).length,'Unexpected sealed runtime file.');
    const dataDirectory=dataPath(p.digest,settings);let fresh=false;try{await mkdir(dataDirectory,{mode:0o700});fresh=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    if(fresh&&previous){
      const from=dataPath(previous.digest,previous.settings);let files=0,total=0;
      async function copy(from,to){for(const name of await readdir(from)){const source=join(from,name),dest=join(to,name),st=await lstat(source);need(!st.isSymbolicLink()&&++files<=256,'Unsafe or oversized private runtime state.');if(st.isDirectory()){await mkdir(dest,{mode:0o700});await copy(source,dest);}else{need(st.isFile()&&st.size<=4*1024*1024&&(total+=st.size)<=16*1024*1024,'Private runtime state exceeds its migration limit.');await writeFile(dest,await bounded(source,4*1024*1024),{flag:'wx',mode:0o600});}}}
      try{await copy(from,dataDirectory);}catch(e){need(inside(stateRoot,dataDirectory),'Unsafe private state cleanup path.');await rm(dataDirectory,{recursive:true,force:true});throw e;}
    }
    service=await serviceStart({payloadDirectory,dataDirectory,supervisorDirectory:join(stateRoot,'supervisor'),protectedPaths,settings,
      request:async(op,input)=>{
        const m=p.manifest;need(permitted(m),'Matching active service license required.');if(committed)need(services.get(m.id)===service&&state.installed[m.id]?.active===p.digest,'Runtime was replaced.');const principal=committed?state.installed[m.id].approval:approval;authorizeRuntime(principal);
        if(op==='https'){need(m.permissions.includes('network.https'),'HTTPS permission was not approved.');need(committed||(input?.method||'POST')==='GET','Mutating provider requests require an active admitted runtime.');return addonHttps(input,m.network,{transport:httpsTransport});}
        if(op==='workspace.read'){need(m.permissions.includes('workspace.read'),'Workspace read permission was not approved.');return workspaceBridge(op,input,{approval:principal,addonId:m.id});}
        if(op==='workspace.write'){
          need(m.permissions.includes('workspace.write'),'Workspace write permission was not approved.');
          const row=state.installed[m.id];need(committed&&row?.active===p.digest,'Workspace writes require a fully active installed runtime.');
          const proposal=await propose(m.id,input);
          if(row.writeMode==='automatic'){need(m.permissions.includes('workspace.write.auto'),'Automatic writes are not licensed.');return approveWrite({id:m.id,proposalId:proposal.id,digest:proposal.digest,confirm:true},()=>state.installed[m.id].approval,true);}
          return {proposalId:proposal.id,status:'pending-owner-approval'};
        }
        throw Error('Unsupported broker operation.');
      }});
    const original=service;service={...original,health:()=>original.health(),invoke:value=>original.invoke(value),close:()=>original.close(),commit(){committed=true;}};return service;
  }
  async function exclusive(fn){need(!closed&&!problem,'Add-on installer unavailable: '+(problem||'closed'));need(!busy,'Another add-on operation is in progress.');busy=true;const work=(async()=>{try{return await fn();}finally{busy=false;}})();inFlight=work.catch(()=>{});return work;}
  async function recover(id,reason){
    const row=state.installed[id];if(!row)return;const running=services.get(id);services.delete(id);await running?.close();
    const next=copyState(),target=next.installed[id];target.reason=reason;target.status='unavailable';
    let replacement;
    if(row.previous){try{const p=await cached(row.previous.digest);need(permitted(p.manifest),'Last working revision is not licensed.');replacement=await start(p,row.previous.settings,row.approval);target.active=row.previous.digest;target.settings=row.previous.settings;target.previous=null;target.writeMode='review';for(const proposal of target.proposals)if(proposal.status==='pending'){proposal.status='failed';proposal.reason='Runtime rolled back; request new work.';}target.status='rolled-back';target.reason=reason+' Restored last working revision.';}catch{target.reason=reason+' Last working service could not be restored.';}}
    try{await save(next);if(replacement){replacement.commit();services.set(id,replacement);}}catch(e){await replacement?.close();throw e;}
  }
  async function refresh(){
    if(problem||closed||busy)return;
    await exclusive(async()=>{
      for(const [id,row] of Object.entries(state.installed)){
        try{const p=await cached(row.active);if(!permitted(p.manifest)){await services.get(id)?.close();services.delete(id);continue;}authorizeRuntime(row.approval);
          if(p.manifest.type==='service'){
            const running=services.get(id);
            if(running){try{await running.health();}catch{await recover(id,'Service health check failed.');}}
          }
        }catch{await services.get(id)?.close();services.delete(id);}
      }
    });
  }
  try{
    if(!publisherKey||!activationDirectory||!installationId)problem='Trusted publisher and installation provisioning required.';
    else {
      need(isAbsolute(publisherKey)&&isAbsolute(activationDirectory)&&isAbsolute(directory),'Use absolute installer paths.');
      stateRoot=join(await realpath(activationDirectory),'addons-v1');
      const keyPath=await realpath(publisherKey),drop=await realpath(directory).catch(e=>{if(e.code==='ENOENT')return resolve(directory);throw e;}),core=await realpath(app);
      need(drop.toLowerCase()===resolve(directory).toLowerCase(),'Junction package folders are not supported.');
      need(!inside(core,stateRoot)&&!inside(drop,stateRoot)&&!inside(stateRoot,drop)&&!inside(drop,keyPath)&&!inside(core,keyPath),'Keep trusted state and publisher key outside the application and drop folder.');
      const pem=(await bounded(keyPath,512)).toString('utf8');need(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem),'Provision only a publisher public key.');key=createPublicKey(pem);need(key.asymmetricKeyType==='ed25519','Publisher key must be Ed25519.');
      let fresh=false;try{await mkdir(stateRoot,{mode:0o700});fresh=true;}catch(e){if(e.code!=='EEXIST')throw e;}
      const st=await lstat(stateRoot);need(st.isDirectory()&&!st.isSymbolicLink()&&(await realpath(stateRoot))===resolve(stateRoot),'Unsafe installer state directory.');
      if(process.platform==='win32')await protectWindows(stateRoot,keyPath,fresh);else need((st.mode&0o077)===0&&(await lstat(keyPath)).mode%8<2,'Protect installer state and publisher verifier.');
      lock=await open(join(stateRoot,'runtime.lock'),'wx',0o600);
      try{state=JSON.parse((await bounded(join(stateRoot,'state.json'),2*1024*1024)).toString('utf8'));need(exact(state,['format','installed'])&&state.format===1&&state.installed&&typeof state.installed==='object'&&!Array.isArray(state.installed)&&Object.keys(state.installed).length<=16,'Invalid installer state.');}catch(e){if(e.code!=='ENOENT')throw e;}
      for(const [id,row] of Object.entries(state.installed)){
        need(idPattern.test(id)&&exact(row,['active','highRevision','highDigest','settings','pending','previous','status','reason','approval','writeMode','proposals'])&&hex.test(row.active)&&Number.isSafeInteger(row.highRevision)&&row.highRevision>0&&hex.test(row.highDigest)&&['active','rolled-back','unavailable'].includes(row.status)&&typeof row.reason==='string'&&row.reason.length<=256&&exact(row.approval,['id','authVersion'])&&typeof row.approval.id==='string'&&Number.isSafeInteger(row.approval.authVersion)&&['review','automatic'].includes(row.writeMode)&&Array.isArray(row.proposals)&&row.proposals.length<=8,'Invalid installed add-on history.');
        const p=await cached(row.active);need(p.manifest.id===id&&p.manifest.revision<=row.highRevision,'Installed add-on history mismatch.');validateAddonSettings(p.manifest.settings,row.settings);
        const high=await cached(row.highDigest);need(high.manifest.id===id&&high.manifest.type===p.manifest.type&&high.manifest.revision===row.highRevision,'Invalid revision high-water history.');
        for(const item of [row.pending,row.previous])if(item){need(exact(item,['digest','settings'])&&hex.test(item.digest),'Invalid pending or rollback history.');const q=await cached(item.digest);need(q.manifest.id===id&&q.manifest.type===p.manifest.type&&q.manifest.revision<=row.highRevision,'Invalid pending or rollback target.');validateAddonSettings(q.manifest.settings,item.settings);}
        for(const proposal of row.proposals){need(exact(proposal,['id','runtime','path','body','digest','status','reason'])&&hex.test(proposal.id)&&hex.test(proposal.runtime)&&hex.test(proposal.digest)&&['pending','executing','complete','failed'].includes(proposal.status)&&digest(JSON.stringify([id,proposal.runtime,proposal.id,proposal.path,proposal.body]))===proposal.digest,'Invalid workspace write history.');}
      }
      timer=setInterval(()=>refresh().catch(()=>{}),monitorMs);timer.unref();
    }
  }catch(e){problem=e.code==='EEXIST'?'Another installer is running, or its crash lock needs operator review.':e.message||'Installer trust or state could not be verified.';for(const s of services.values())await s.close();services.clear();if(lock){await lock.close();lock=null;await unlink(join(stateRoot,'runtime.lock')).catch(()=>{});}}
  function isolationView(id){
    const service=services.get(id),evidence=service?.protection;
    return evidence?.appContainer===true?{appContainer:true,capabilities:evidence.capabilities,noNetworkCapabilities:evidence.noNetworkCapabilities,activeProcessLimit:evidence.activeProcessLimit,killOnClose:evidence.killOnClose,protectedPathsDenied:evidence.protectedPathsDenied,pid:service.pid}:null;
  }
  async function status(){
    await refresh();const installed=[];
    if(!problem)for(const [id,row] of Object.entries(state.installed)){try{const p=(await cached(row.active)).manifest;const eligible=permitted(p),stopped=p.type==='service'&&!services.has(id);installed.push({id,name:p.name,revision:p.revision,type:p.type,status:!eligible?'license-required':stopped?'unavailable':row.status,reason:!eligible?'Matching active license required.':row.reason||(stopped?'Service stopped. Review and Apply its accepted package to request an owner-approved start.':''),runtimeIsolation:isolationView(id),permissions:p.permissions,network:p.network,writeMode:row.writeMode,writeProposals:eligible?row.proposals:[],settingsSchema:eligible?p.settings:[],settings:eligible?row.settings:{},pendingRestart:eligible&&!!row.pending});}catch{installed.push({id,status:'unavailable',reason:'Accepted package could not be verified.',settingsSchema:[],settings:{}});}}
    return {configured:!problem,installationId,reason:problem,installed};
  }
  async function review(){
    need(!problem&&!closed,'Add-on installer unavailable: '+problem);const candidates=[],errors=[],packages=new Map();
    let names;try{const st=await lstat(directory);need(st.isDirectory()&&!st.isSymbolicLink()&&(await realpath(directory)).toLowerCase()===resolve(directory).toLowerCase(),'Unsafe package folder.');names=await readdir(directory);}catch(e){if(e.code==='ENOENT')names=[];else throw e;}
    need(names.length<=512,'Too many package folder entries.');const ids=new Set();
    for(const name of names.sort().filter(n=>n.toLowerCase().endsWith('.fqaddon'))){
      try{need(/^[A-Za-z0-9_.-]{1,100}\.fqaddon$/.test(name)&&candidates.length<16,'Invalid add-on filename or count.');const p=inspectAddon(await bounded(join(directory,name)),key,{installationId,runtime}),m=p.manifest;
        need(!ids.has(m.id),'Duplicate add-on ID in folder.');ids.add(m.id);const row=state.installed[m.id];if(row)need((await cached(row.active)).manifest.type===m.type,'Add-on type cannot change for an installed ID.');const obsolete=row&&(m.revision<row.highRevision||m.revision===row.highRevision&&p.digest!==row.highDigest);
        const eligible=!obsolete&&permitted(m);const reason=obsolete?'Older or conflicting revision.':!permitted(m)?'Matching active license required.':row?.active===p.digest?'Already active.':'Ready for owner review.';
        const c={id:m.id,name:m.name,revision:m.revision,type:m.type,permissions:m.permissions,network:m.network,eligible,reason,restartRequired:!!row&&m.type==='service'&&row.active!==p.digest,digest:p.digest};candidates.push(c);packages.set(m.id,p);
      }catch(e){errors.push({file:name,reason:e.message});}
    }
    // A duplicate must never leave the first package selectable.
    if(errors.some(e=>e.reason==='Duplicate add-on ID in folder.'))for(const c of candidates)c.eligible=false;
    const receipt=digest(JSON.stringify([installationId,state,activation.addonGrants(),candidates,errors]));
    return {receipt,candidates,errors,packages};
  }
  async function apply({id,receipt,confirm},authorize){return exclusive(async()=>{
    need(confirm===true&&typeof authorize==='function','Explicit owner approval required.');authorize();const r=await review();need(receipt===r.receipt,'Review changed; review the folder again.');const p=r.packages.get(id);need(p&&r.candidates.find(c=>c.id===id)?.eligible,'Package is not eligible.');const m=p.manifest;authorize();need(permitted(m),'License changed.');
    const cache=cachePath(p.digest);try{const f=await open(cache,'wx',0o600);try{await f.writeFile(p.bytes);await f.sync();}finally{await f.close();}}catch(e){if(e.code!=='EEXIST')throw e;await cached(p.digest);}
    const next=copyState(),prior=next.installed[id],settings=settingsFor(m,prior?.settings);need(prior||Object.keys(next.installed).length<16,'Installed add-on limit reached.');
    if(prior?.active===p.digest){if(m.type==='service'&&!services.has(id)){prior.pending={digest:p.digest,settings:prior.settings};prior.reason='Owner restart approval required.';authorize();need(permitted(m),'License changed.');await save(next);}return status();}
    if(prior&&m.type==='service'){
      prior.pending={digest:p.digest,settings};prior.highRevision=m.revision;prior.highDigest=p.digest;prior.reason='Owner restart approval required.';authorize();need(permitted(m),'License changed.');await save(next);
    }else {
      const owner=authorize();need(owner&&typeof owner.id==='string'&&Number.isSafeInteger(owner.authVersion),'A current owner identity must approve the add-on.');const approval={id:owner.id,authVersion:owner.authVersion};
      let service;try{if(m.type==='service')service=await start(p,settings,approval);authorize();need(permitted(m),'License changed.');next.installed[id]={active:p.digest,highRevision:m.revision,highDigest:p.digest,settings,pending:null,previous:prior?{digest:prior.active,settings:prior.settings}:null,status:'active',reason:'',approval,writeMode:'review',proposals:[]};await save(next);if(service){service.commit();services.set(id,service);}}catch(e){await service?.close();throw e;}
    }
    return status();
  });}
  async function restart({id,confirm},authorize){return exclusive(async()=>{
    need(confirm===true&&typeof authorize==='function','Explicit owner restart approval required.');authorize();const row=state.installed[id];need(row?.pending,'No approved service change is pending.');const p=await cached(row.pending.digest);need(p.manifest.id===id&&p.manifest.type==='service'&&permitted(p.manifest),'Pending service is not licensed or supported.');const next=copyState(),target=next.installed[id];let candidate;
    validateAddonSettings(p.manifest.settings,row.pending.settings);
    const owner=authorize(),approval={id:owner.id,authVersion:owner.authVersion};
    const old=services.get(id);await old?.close();services.delete(id);
    try{candidate=await start(p,row.pending.settings,approval,{digest:row.active,settings:row.settings});}
    catch(e){target.pending=null;target.status='rolled-back';target.reason='Update failed its start or health check; retained last working revision. '+String(e.message).slice(0,120);target.approval=approval;if(JSON.stringify(row.approval)!==JSON.stringify(approval))target.writeMode='review';authorize();need(permitted(p.manifest),'License changed.');await save(next);try{const previous=await cached(row.active);if(permitted(previous.manifest)){const restored=await start(previous,row.settings,approval);restored.commit();services.set(id,restored);}}catch{}return status();}
    try{authorize();need(permitted(p.manifest),'License changed.');target.previous={digest:row.active,settings:row.settings};if(row.active!==p.digest||JSON.stringify(row.approval)!==JSON.stringify(approval)){target.writeMode='review';for(const proposal of target.proposals)if(proposal.status==='pending'){proposal.status='failed';proposal.reason='Runtime or approving owner changed; request new work.';}}target.active=p.digest;target.settings=row.pending.settings;target.pending=null;target.approval=approval;target.status='active';target.reason='';await save(next);}catch(e){await candidate.close();try{const previous=await cached(row.active);if(permitted(previous.manifest)){const restored=await start(previous,row.settings,row.approval);restored.commit();services.set(id,restored);}}catch{}throw e;}
    candidate.commit();services.set(id,candidate);
    return status();
  });}
  async function settings({id,settings:values,confirm},authorize){return exclusive(async()=>{
    need(confirm===true&&typeof authorize==='function','Explicit owner settings approval required.');authorize();const row=state.installed[id];need(row,'Add-on is not installed.');const p=await cached(row.active);need(permitted(p.manifest),'Matching active license required.');const valuesChecked=validateAddonSettings(p.manifest.settings,values),next=copyState(),target=next.installed[id];
    if(p.manifest.type==='service'){need(!target.pending,'Review the pending service update first.');target.pending={digest:row.active,settings:valuesChecked};target.reason='Settings saved for review; owner restart approval required.';}else target.settings=valuesChecked;
    authorize();need(permitted(p.manifest),'License changed.');await save(next);return status();
  });}
  async function invoke({id,value},authorize){
    need(!closed&&!problem,'Installer unavailable.');authorize();const row=state.installed[id];need(row,'Add-on not installed.');const p=await cached(row.active);need(permitted(p.manifest)&&p.manifest.type==='service','Matching service license required.');need(Buffer.byteLength(JSON.stringify(value)??'null')<=1024*1024,'Service request too large.');const svc=services.get(id);need(svc,'Service unavailable.');let result;
    try{result=await svc.invoke(value);}catch(e){if(e.code==='ADDON_REQUEST_REJECTED')throw Object.assign(e,{status:409});if(!closed&&!busy&&services.get(id)===svc)await exclusive(()=>recover(id,'Service request failed its health check.'));fail('Service request failed; review add-on status.');}
    authorize();need(permitted(p.manifest),'License changed.');return {value:result};
  }
  async function propose(id,input){return exclusive(async()=>{
    need(exact(input,['path','body'])&&typeof input.path==='string'&&input.path.startsWith('/api/')&&input.path.length<=240&&Buffer.byteLength(JSON.stringify(input))<=128*1024,'Invalid workspace write proposal.');const next=copyState(),row=next.installed[id];need(row,'Runtime is not active.');row.proposals=row.proposals.filter(p=>['pending','executing'].includes(p.status));need(row.proposals.length<8,'Too many pending writes.');const proposal={id:randomBytes(32).toString('hex'),runtime:row.active,path:input.path,body:input.body,status:'pending',reason:''};proposal.digest=digest(JSON.stringify([id,proposal.runtime,proposal.id,proposal.path,proposal.body]));row.proposals.push(proposal);await save(next);return proposal;
  });}
  async function approveWrite({id,proposalId,digest:confirmed,confirm},authorize,automatic=false){return exclusive(async()=>{
    need(confirm===true,'Explicit workspace write approval required.');const owner=authorize(),row=state.installed[id];need(row,'Add-on is not installed.');const pkg=(await cached(row.active)).manifest;need(permitted(pkg)&&pkg.permissions.includes('workspace.write'),'Workspace writes are not licensed.');if(automatic)need(row.writeMode==='automatic'&&pkg.permissions.includes('workspace.write.auto'),'Automatic writes were not owner-approved.');const found=row.proposals.find(p=>p.id===proposalId);need(found?.status==='pending'&&found.runtime===row.active&&found.digest===confirmed&&digest(JSON.stringify([id,found.runtime,found.id,found.path,found.body]))===confirmed,'Write proposal is stale or already attempted.');
    let next=copyState(),proposal=next.installed[id].proposals.find(p=>p.id===proposalId);proposal.status='executing';proposal.reason='Outcome must be reconciled if the host is interrupted.';await save(next);
    try{const result=await workspaceBridge('workspace.write',{path:found.path,body:found.body},{approval:{id:owner.id,authVersion:owner.authVersion},addonId:id});next=copyState();proposal=next.installed[id].proposals.find(p=>p.id===proposalId);proposal.status='complete';proposal.reason='Workspace API completed; recorded in the audit trail.';await save(next);return automatic?{status:'complete',result}:status();}
    catch(e){next=copyState();proposal=next.installed[id].proposals.find(p=>p.id===proposalId);proposal.status='failed';proposal.reason='Workspace API did not complete successfully; review its audit trail before retrying.';await save(next);throw e;}
  });}
  async function writePolicy({id,autoApproveWrites,confirm},authorize){return exclusive(async()=>{
    need(confirm===true&&typeof autoApproveWrites==='boolean','Explicit owner write policy approval required.');const owner=authorize(),row=state.installed[id];need(row,'Add-on is not installed.');const p=(await cached(row.active)).manifest;need(permitted(p)&&p.permissions.includes('workspace.write')&&(!autoApproveWrites||p.permissions.includes('workspace.write.auto')),'Requested write policy is not licensed.');const next=copyState(),approval={id:owner.id,authVersion:owner.authVersion};if(JSON.stringify(row.approval)!==JSON.stringify(approval))for(const proposal of next.installed[id].proposals)if(proposal.status==='pending'){proposal.status='failed';proposal.reason='Approving owner changed; request new work.';}next.installed[id].writeMode=autoApproveWrites?'automatic':'review';next.installed[id].approval=approval;authorize();await save(next);return status();
  });}
  async function restore(){if(problem||closed)return status();return exclusive(async()=>{for(const [id,row] of Object.entries(state.installed)){try{const p=await cached(row.active);if(permitted(p.manifest)&&p.manifest.type==='service'&&!services.has(id)){const service=await start(p,row.settings,row.approval);service.commit();services.set(id,service);}}catch(e){await recover(id,'Service failed to start after host restart.');}}return status();});}
  return {status,review:async()=>{const {packages,...r}=await review();return r;},apply,restart,settings,invoke,refresh,restore,approveWrite,writePolicy,
    async close(){closed=true;clearInterval(timer);await inFlight;for(const svc of services.values())await svc.close();services.clear();if(lock){await lock.close();lock=null;await unlink(join(stateRoot,'runtime.lock')).catch(()=>{});}}};
}
