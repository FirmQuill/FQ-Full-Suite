import {createPrivateKey,createPublicKey,randomBytes,verify} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {unwrapUpgradeLicense} from './upgrade-envelope.mjs';

const app=fileURLToPath(new URL('./',import.meta.url));
const marker='firmquill.activation.v1';
export const edition='firmquill-full-suite';
export const modules=Object.freeze(['manual-payroll','private-support']);
// Recognition for read-only preview does not add runtime entitlements.
const previewModules=Object.freeze([...modules,'expanded_agent','software_updates']);
const installationId=/^[a-f0-9]{64}$/;
const codeMax=4096;
const block=(status,message)=>{throw Object.assign(Error(message),{status});};
const within=(root,file)=>{const r=relative(root,file);return r===''||(!isAbsolute(r)&&!/^\.\.(?:[\\/]|$)/.test(r));};
const trustedOwner=info=>process.platform==='win32'||info.uid===0||info.uid===process.geteuid();
const protectedStat=info=>process.platform==='win32'||trustedOwner(info)&&(info.mode&0o077)===0;
const decode=(text)=>{
  if(typeof text!=='string'||text.length===0||!/^[A-Za-z0-9_-]+$/.test(text))throw Error();
  const bytes=Buffer.from(text,'base64url');
  if(bytes.toString('base64url')!==text)throw Error();return bytes;
};
function validPreviewFeed(feed){
  if(!feed||typeof feed!=='object'||Array.isArray(feed)||Object.keys(feed).length!==2||!['stable','current'].includes(feed.channel)||
    typeof feed.origin!=='string'||feed.origin.length>261||feed.origin!==feed.origin.trim())return false;
  const host=/^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(feed.origin)?.[1];
  return !!host&&host.length<=253&&/\.[a-z]{2,63}$/.test(host)&&
    host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&
    !/\.(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host);
}
function inspect(code,key,id,allowed=modules,withFeed=false){
  if(typeof code!=='string'||code.length>codeMax)throw Error();
  const [encoded,sign,...rest]=code.trim().split('.');
  if(rest.length)throw Error();
  const b=decode(encoded),sig=decode(sign);
  if(sig.length!==64||!verify(null,b,key,sig))throw Error();
  const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
  const allow=new Set(['format','edition','installationId','modules','notBefore','expiresAt','licenseId','issuedAt']);
  if(withFeed)allow.add('updateFeed');
  if(!p||Object.keys(p).some(k=>!allow.has(k))||p.format!==marker||p.edition!==edition||p.installationId!==id||
    !Array.isArray(p.modules)||p.modules.length===0||new Set(p.modules).size!==p.modules.length||p.modules.some(m=>!allowed.includes(m)))throw Error();
  if(p.updateFeed!==undefined&&(!validPreviewFeed(p.updateFeed)||!p.modules.includes('software_updates')||
    p.licenseId===undefined||p.issuedAt===undefined||p.expiresAt===undefined))throw Error();
  if(p.licenseId!==undefined&&(typeof p.licenseId!=='string'||!/^[a-f0-9]{32}$/.test(p.licenseId)))throw Error();
  for(const k of ['notBefore','expiresAt','issuedAt'])if(p[k]!==undefined&&(!Number.isSafeInteger(p[k])||p[k]<0||p[k]>253402300799))throw Error();
  if(p.expiresAt!==undefined&&(p.notBefore!==undefined&&p.expiresAt<=p.notBefore||p.issuedAt!==undefined&&p.expiresAt<=p.issuedAt))throw Error();
  return p;
}
function temporal(p,now){
  if(!p)return 'not activated';
  if(p.notBefore!==undefined&&now<p.notBefore*1000)return 'not yet valid';
  if(p.expiresAt!==undefined&&now>=p.expiresAt*1000)return 'expired';
  return 'active';
}
async function readBounded(file,max,{privateFile=false}={}){
  const f=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const info=await f.stat();
    if(!info.isFile()||info.size>max||privateFile&&!protectedStat(info))throw Error();
    const b=Buffer.alloc(max+1);let used=0;
    while(used<b.length){const out=await f.read(b,used,b.length-used,null);if(!out.bytesRead)break;used+=out.bytesRead;}
    if(used>max)throw Error();
    return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,used));
  }finally{await f.close();}
}
async function writeNew(path,value){
  const f=await open(path,'wx',0o600);
  try{await f.writeFile(value);await f.sync();}finally{await f.close();}
}
export function activationOptionsFromEnv(env=process.env){return {directory:env.FIRMQUILL_MODULE_INSTALL_DIR,verifierPath:env.FIRMQUILL_ENTITLEMENT_PUBLIC_KEY};}

export async function createModuleActivation({directory,verifierPath,clock=Date.now}={}){
  let id=null,key=null,recipientKey=null,filename=null,current=null,problem=false,invalid=false,writing=false;
  if(directory||verifierPath){
    try{
      if(typeof directory!=='string'||typeof verifierPath!=='string'||!isAbsolute(directory)||!isAbsolute(verifierPath))throw Error();
      const [root,codeDir,canonicalKey]=await Promise.all([realpath(directory),realpath(app),realpath(verifierPath)]);
      const [dirInfo,keyInfo]=await Promise.all([lstat(directory),lstat(verifierPath)]);
      if(!dirInfo.isDirectory()||!protectedStat(dirInfo)||!keyInfo.isFile()||!trustedOwner(keyInfo)||process.platform!=='win32'&&(keyInfo.mode&0o022)!==0||within(codeDir,root)||within(root,codeDir)||within(codeDir,canonicalKey))throw Error();
      // Only an SPKI public PEM can be provisioned; never accept a private or symmetric key.
      const pem=(await readBounded(canonicalKey,512)).trim();
      if(!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem))throw Error();
      key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw Error();
      const identityFile=join(root,'installation-id');
      try{await writeNew(identityFile,randomBytes(32).toString('hex')+'\n');}catch(e){if(e.code!=='EEXIST')throw e;}
      id=(await readBounded(identityFile,80,{privateFile:true})).trim();
      if(!installationId.test(id))throw Error();
      // Externally provisioned per-installation recipient key. Missing or unsafe
      // recipient setup must not change legacy activation or ordinary app use.
      try{
        const recipient=(await readBounded(join(root,'upgrade-recipient.pem'),4096,{privateFile:true})).trim();
        if(!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----$/.test(recipient))throw Error();
        const parsed=createPrivateKey(recipient),d=parsed.asymmetricKeyDetails;
        if(parsed.asymmetricKeyType!=='rsa'||![3072,4096].includes(d?.modulusLength)||d.publicExponent!==65537n)throw Error();
        recipientKey=parsed;
      }catch{}
      filename=join(root,'active-entitlement.fqlicense');
      try{current=inspect(await readBounded(filename,codeMax,{privateFile:true}),key,id);}catch(e){if(e.code!=='ENOENT')invalid=true;}
    }catch{problem=true;id=null;key=null;filename=null;}
  }
  const status=()=>{
    const state=temporal(current,clock()),active=state==='active';
    return {edition,installationId:id,configured:!!key,configurationIssue:problem,upgradePreviewConfigured:!!key&&!!recipientKey,paidScopePresent:!!current?.modules.some(m=>m!=='manual-payroll'),
      modules:Object.fromEntries(modules.map(m=>[m,active&&current.modules.includes(m)])),
      status:invalid?'invalid saved activation':state,expiresAt:current?.expiresAt??null,notBefore:current?.notBefore??null};
  };
  // Owner UI projection only: no code, identity, module scope, issuer or file paths.
  const renewalNotice=()=>{
    const now=clock(),state=temporal(current,now);
    if(invalid||!current||current.expiresAt===undefined||!['active','expired'].includes(state)||!current.modules.some(m=>m!=='manual-payroll'))return null;
    return {expiresAt:current.expiresAt,remainingMs:Math.max(0,current.expiresAt*1000-now)};
  };
  const allows=mod=>modules.includes(mod)&&!!key&&temporal(current,clock())==='active'&&current.modules.includes(mod);
  function preview(code){
    if(!key||!recipientKey)block(409,'This host is not configured to review encrypted licenses. Ask the host administrator to provision its recipient key and public verifier.');
    let p;
    try{p=inspect(unwrapUpgradeLicense(code,recipientKey),key,id,previewModules,true);}catch{block(400,'Encrypted license is invalid for this Full Suite installation.');}
    return {edition,installationId:id,status:temporal(p,clock()),expiresAt:p.expiresAt??null,notBefore:p.notBefore??null,
      updateFeed:p.updateFeed??null,entitlements:p.modules.filter(m=>m!=='manual-payroll').map(id=>({id,requiresPaidBuild:!modules.includes(id)}))};
  }
  async function activate(code,authorize){
    if(!key||!filename)block(409,'Host activation is not configured. Ask the host administrator to provision the public verifier.');
    if(writing)block(409,'Another activation is in progress. Retry.');
    let p;
    try{p=inspect(code,key,id);}catch{block(400,'Activation code is invalid for this Full Suite installation.');}
    if(temporal(p,clock())!=='active')block(409,'This activation is expired or is not yet valid.');
    authorize();
    const tmp=resolve(filename+'.'+randomBytes(16).toString('hex')+'.partial');
    writing=true;
    try{
      await writeNew(tmp,code.trim());
      authorize();
      if(temporal(p,clock())!=='active')block(409,'This activation is expired or is not yet valid.');
      await rename(tmp,filename);
      current=p;invalid=false;
    }catch(error){if(error.status)throw error;block(503,'Could not save this activation. Existing books and activation are unchanged.');}
    finally{writing=false;await unlink(tmp).catch(()=>{});}
    return status();
  }
  return {status,allows,activate,preview,renewalNotice};
}
