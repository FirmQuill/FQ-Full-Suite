import {createPublicKey,verify} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isAbsolute,relative} from 'node:path';
const max=1024*1024, cap=1400000, version='0.6.5';
const check=(x,m)=>{if(!x)throw Error(m);};
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const text=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
const app=fileURLToPath(new URL('./',import.meta.url));
const inside=(root,file)=>{const r=relative(root,file);return r===''||(!isAbsolute(r)&&!/^\.\.(?:[\\/]|$)/.test(r));};
const trusted=st=>process.platform==='win32'||([0,process.geteuid()].includes(st.uid)&&(st.mode&0o022)===0);
async function input(path,limit){
 check(typeof path==='string'&&isAbsolute(path),'Set an absolute package path.');
 const st=await lstat(path);
 check(st.isFile()&&st.size<=limit&&trusted(st),'Unsafe package file or permission.');
 const canonical=await realpath(path);
 check(!inside(app,canonical),'Keep packages and verifiers outside the app.');
 const h=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try {
  const before=await h.stat();check(before.isFile()&&before.size<=limit&&trusted(before),'Unsafe package file or permission.');
  const b=Buffer.alloc(before.size);let index=0;
  while(index<b.length){const r=await h.read(b,index,b.length-index,index);if(!r.bytesRead)break;index+=r.bytesRead;}
  check(index===b.length&&(await h.stat()).size===before.size,'Package changed while reading.');
  return b;
 }finally{await h.close();}
}
function validate(files){
 check(files&&typeof files==='object'&&!Array.isArray(files)&&typeof files['index.json']==='string','Content catalog missing.');
 const names=Object.keys(files);
 check(names.length>=2&&names.length<=41&&names.every(n=>n==='index.json'||/^[a-z0-9-]{1,80}\.md$/.test(n)),'Unsupported documentation file or count.');
 let total=0;for(const n of names){
  const s=files[n];
  check(typeof s==='string'&&!s.includes('\x00')&&Buffer.byteLength(s)<=65536,'Invalid text or file is too large.');total+=Buffer.byteLength(s);
 }
 check(total<=max,'Documentation package exceeds 1 MiB.');
 const i=JSON.parse(files['index.json']);
 check(exact(i,['version','scope','articles'])&&i.version===version&&i.scope==='private-customer-manual'&&Array.isArray(i.articles)&&i.articles.length===names.length-1,'Catalog does not match this private runtime.');
 const ids=new Set(),used=new Set();
 for(const a of i.articles){
  check(exact(a,['id','file','title','status','keywords'])&&/^[a-z0-9-]{1,80}$/.test(a.id)&&!ids.has(a.id)&&typeof a.title==='string'&&a.title.length>0&&a.title.length<=200&&['verified-local','unverified'].includes(a.status)&&Array.isArray(a.keywords)&&a.keywords.length<=20&&a.keywords.every(k=>typeof k==='string'&&k.length<=80)&&a.file!=='index.json'&&Object.hasOwn(files,a.file)&&!used.has(a.file),'Invalid article catalog.');
  ids.add(a.id);used.add(a.file);
 }
}
function decode(s){check(typeof s==='string'&&/^[A-Za-z0-9_-]+$/.test(s),'Invalid envelope encoding.');const b=Buffer.from(s,'base64url');check(b.toString('base64url')===s,'Invalid envelope encoding.');return b;}

const publicKey=async file=>{
 const pem=text(await input(file,512)).trim();
 check(/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem),'Expected public key PEM.');
 const key=createPublicKey(pem);check(key.asymmetricKeyType==='ed25519','Expected Ed25519 public key.');
 return key;
};
export async function loadSignedSupportPackage({packagePath,verifierPath,entitlementVerifierPath,installationId}={}){
 if(!packagePath&&!verifierPath)return {status:'unconfigured'};
 try {
  check(/^[a-f0-9]{64}$/.test(installationId||''),'Expected provisioned installation identity.');
  const [key,entitlement,raw]=await Promise.all([publicKey(verifierPath),publicKey(entitlementVerifierPath),input(packagePath,2*1024*1024)]);
  check(!key.export({type:'spki',format:'der'}).equals(entitlement.export({type:'spki',format:'der'})),'Keep issuance trust independent.');
  const e=JSON.parse(text(raw));check(exact(e,['signed','signature']),'Invalid envelope.');
  const b=decode(e.signed),sig=decode(e.signature);
  check(b.length<=cap&&sig.length===64&&verify(null,b,key,sig),'Signature verification failed.');
  const d=JSON.parse(text(b));
  check(exact(d,['format','release','installationId','files'])&&d.format==='firmquill.support-content.v1'&&d.release===version&&d.installationId===installationId,'Wrong release or installation.');
  validate(d.files);
  return {status:'verified',files:Object.freeze(d.files)};
 }catch{return {status:'invalid'};}
}
