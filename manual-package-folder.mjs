// Static package admission. Packages never execute, unpack, overlay or download code.
import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,opendir,realpath,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INSTALLED_VERSION} from './support.mjs';
import {loadSupportPublicKey,validateSignedSupportFiles,verifySupportEnvelope} from './signed-support-package.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));
const max=2*1024*1024, stateName='manual-package-admission.v1.json';
const kbId='full-suite-knowledge-base';
const baseTypes=Object.freeze({[kbId]:Object.freeze({type:'knowledge-base',entitlement:'private-support',validate:validateSignedSupportFiles})});
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=x=>{if(!x)throw Error('Package admission did not complete.');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=(s,n=64)=>typeof s==='string'&&s.length===n&&/^[a-f0-9]+$/.test(s);
const inside=(parent,path)=>{const d=relative(parent,path);return d===''||!isAbsolute(d)&&!/^\.\.(?:[\\/]|$)/.test(d);};
const permission=(s,privateFile=false)=>process.platform==='win32'||[0,process.geteuid()].includes(s.uid)&&(s.mode&(privateFile?0o077:0o022))===0;
async function safeDir(path,secret){
 need(typeof path==='string'&&isAbsolute(path));const first=await lstat(path);need(first.isDirectory()&&permission(first,secret));
 const canon=await realpath(path),st=await lstat(canon);need(st.isDirectory()&&permission(st,secret));return canon;
}
async function safeRead(path,cap,parent,secret=false){
 const first=await lstat(path);need(first.isFile()&&permission(first,secret)&&first.size<=cap);
 const canonical=await realpath(path);need(inside(parent,canonical));
 const file=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const st=await file.stat();need(st.isFile()&&permission(st,secret)&&st.size<=cap);
  const data=Buffer.alloc(st.size);let used=0;
  while(used<data.length){const r=await file.read(data,used,data.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead;}
  need(used===data.length&&(await file.stat()).size===st.size);return data;
 }finally{await file.close();}
}
async function createNew(path,contents){
 const f=await open(path,'wx',0o600);
 try{await f.writeFile(contents);await f.sync();}finally{await f.close();}
}
async function historyAt(stateRoot,installationId){
 const history=Object.create(null);
 let old;
 try{old=JSON.parse((await safeRead(join(stateRoot,stateName),8192,stateRoot,true)).toString('utf8'));}
 catch(e){if(e.code!=='ENOENT')throw e;}
 if(!old)return history;
 need(exact(old,['format','installationId','packages'])&&old.format===1&&old.installationId===installationId&&old.packages&&
   typeof old.packages==='object'&&!Array.isArray(old.packages)&&Object.keys(old.packages).length<=16);
 for(const [key,row] of Object.entries(old.packages)){
  need(/^[a-z0-9-]{1,80}$/.test(key)&&exact(row,['version','digest'])&&Number.isSafeInteger(row.version)&&row.version>0&&hex(row.digest));
  history[key]=row;
 }
 return history;
}
async function saveRevisions(stateRoot,installationId,packages,entitled,authorize,reviewedHistory){
 const path=join(stateRoot,stateName),lockPath=path+'.lock';
 const lock=await open(lockPath,'wx',0o600);
 let temp;
 try{
  const history=await historyAt(stateRoot,installationId);
  need(JSON.stringify(history)===reviewedHistory);
  let changed=false;
  const live=()=>Object.values(packages).every(p=>entitled(p.entitlement));
  authorize();need(live());
  for(const [key,pkg] of Object.entries(packages)){
   const prior=history[key];
   need(!prior||pkg.version>prior.version||pkg.version===prior.version&&pkg.digest===prior.digest);
   if(!prior||pkg.version>prior.version){history[key]={version:pkg.version,digest:pkg.digest};changed=true;}
  }
  if(!changed)return;
  const payload=JSON.stringify({format:1,installationId,packages:history})+'\n';
  temp=path+'.'+randomBytes(12).toString('hex')+'.partial';
  await createNew(temp,payload);authorize();need(live());
  await rename(temp,path);temp=null;
 }finally{
  if(temp)await unlink(temp).catch(()=>{});
  await lock.close();await unlink(lockPath);
 }
}
export function manualPackageFolderOptionsFromEnv(env=process.env){
 return env.FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY?{
  directory:env.FIRMQUILL_PACKAGES_DIR||join(root,'packages'),
  verifierPath:env.FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY
 }:(env.FIRMQUILL_PACKAGES_DIR?{directory:env.FIRMQUILL_PACKAGES_DIR}:{});
}
export async function loadManualPackageFolder({directory,verifierPath,entitlementVerifierPath,installationId,activationDirectory,entitled=()=>false,additionalTypes={},operation='restore',receipt,ids,authorize=()=>{throw Error('Owner confirmation required.');}}={}){
 if(!directory&&!verifierPath)return {status:'unconfigured'};
 try{
  // Only a configured trusted site can admit a drop, and the existing license must
  // authorize the known package type before history is advanced.
  need(hex(installationId)&&typeof verifierPath==='string'&&typeof entitlementVerifierPath==='string');
  const state=await safeDir(activationDirectory,true);
  let drop;
  try{drop=await safeDir(directory,false);}catch(e){if(e.code==='ENOENT')return {status:'empty'};throw e;}
  const appRoot=await realpath(root);
  need(!inside(drop,state)&&!inside(state,drop)&&!inside(drop,appRoot));
  const [vp,ep]=await Promise.all([realpath(verifierPath),realpath(entitlementVerifierPath)]);
  need(!inside(drop,vp)&&!inside(drop,ep));
  const [key,other]=await Promise.all([loadSupportPublicKey(verifierPath),loadSupportPublicKey(entitlementVerifierPath)]);
  need(!key.export({type:'spki',format:'der'}).equals(other.export({type:'spki',format:'der'})));
  const registry={...additionalTypes,...baseTypes};
  const candidates=[];let entries=0;
  for await(const entry of await opendir(drop)){
    need(++entries<=512);
    if(!/\.fqpackage$/i.test(entry.name))continue;
    need(candidates.length<8&&entry.isFile()&&/^[A-Za-z0-9_.-]{1,120}\.fqpackage$/i.test(entry.name));
    candidates.push(entry.name);
  }
  if(!candidates.length)return {status:'empty'};
  const seen=new Set(),packages=Object.create(null),candidatesView=[],receiptParts=[];
  const history=await historyAt(state,installationId),reviewedHistory=JSON.stringify(history);
  for(const candidate of candidates.sort()){
   const {body:d,signedBytes}=verifySupportEnvelope(await safeRead(join(drop,candidate),max,drop),key);
   need(exact(d,['format','id','type','version','runtime','installationId','entitlement','files','hashes'])&&d.format==='firmquill.manual-package.v1'&&
     typeof d.id==='string'&&Object.hasOwn(registry,d.id)&&!seen.has(d.id)&&Number.isSafeInteger(d.version)&&d.version>0&&
     d.runtime===INSTALLED_VERSION&&d.installationId===installationId);
   seen.add(d.id);
   const policy=registry[d.id];need(d.type===policy.type&&d.entitlement===policy.entitlement);
   const digest=hash(signedBytes),prior=history[d.id],already=prior?.version===d.version&&prior.digest===digest;
   const obsolete=!!prior&&(d.version<prior.version||d.version===prior.version&&!already);
   const licensed=entitled(d.entitlement),eligible=licensed&&!obsolete;
   const reason=obsolete?'revision-rejected':!licensed?'license-required':already?'already-applied':'review-required';
   candidatesView.push(Object.freeze({id:d.id,type:d.type,version:d.version,eligible,reason}));
   receiptParts.push([d.id,d.type,d.version,digest,eligible,reason]);
   if(!eligible)continue;
   need(d.files&&typeof d.files==='object'&&!Array.isArray(d.files));
   const names=Object.keys(d.files);need(names.length>=1&&names.length<=41);
   need(exact(d.hashes,names)&&names.every(n=>typeof d.files[n]==='string'&&hex(d.hashes[n])&&hash(Buffer.from(d.files[n],'utf8'))===d.hashes[n]));
   const validated=policy.validate(d.files);
   if(operation==='restore'&&!already)continue;
   packages[d.id]=Object.freeze({version:d.version,digest,entitlement:d.entitlement,files:Object.freeze(d.files),...(validated===undefined?{}:{payload:validated})});
  }
  const nextReceipt=hash(JSON.stringify([installationId,reviewedHistory,receiptParts]));
  if(operation==='preview')return {status:'review',receipt:nextReceipt,candidates:candidatesView};
  if(operation==='apply'){
   need(receipt===nextReceipt&&Array.isArray(ids)&&ids.length>=1&&ids.length<=8&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&Object.hasOwn(packages,id)));
   for(const id of Object.keys(packages))if(!ids.includes(id))delete packages[id];
   await saveRevisions(state,installationId,packages,entitled,authorize,reviewedHistory);
   authorize();
  }
  if(!Object.keys(packages).length)return {status:candidatesView.some(c=>c.eligible)?'review-required':'unentitled'};
  need(Object.values(packages).every(p=>entitled(p.entitlement)));
  return {status:'verified',packages:Object.freeze(packages),files:packages[kbId]?.files};

 }catch{return {status:'invalid'};}
}
