// Optional local account passkeys. WebAuthn parsing/signature verification is performed by the
// pinned SimpleWebAuthn runtime, not by application cryptography.
import {randomBytes,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,decodeClientDataJSON,decodeAttestationObject} from './vendor/simplewebauthn-server.mjs';

const lifetime=120000,cap=1500,pause=300000;
const opaque=()=>randomBytes(32).toString('base64url');
const handle=user=>createHash('sha256').update('firmquill-passkey-v1\0'+user).digest();
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{10,1024}$/.test(id);
const usablePassword=hash=>typeof hash==='string'&&/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(hash);
const names=['usb','nfc','ble','internal','hybrid','smart-card'];
function insist(ok,status,message){if(!ok)throw Object.assign(Error(message),{status});}
const verifiedFail=()=>insist(false,401,'Passkey could not be verified. Use a registered passkey or sign in with your password.');
export function initializePasskeys(db){
  db.exec(`CREATE TABLE IF NOT EXISTS local_passkeys (
    credential_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    portal TEXT NOT NULL CHECK(portal IN ('main','worker')), rp_id TEXT NOT NULL, auth_version INTEGER NOT NULL,
    label TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
    created_at TEXT NOT NULL, last_used TEXT, backup_eligible INTEGER NOT NULL, backed_up INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS local_passkeys_account ON local_passkeys(account_id,portal,rp_id,auth_version);`);
}
export function passkeyOrigin(portal,origin,host){
  const u=new URL(origin);
  // No parent-domain RP alias, subdomain sharing, TLS/IP aliases, or cleartext LAN logins.
  const valid=u.protocol==='https:'&&!isIP(u.hostname)&&u.hostname.includes('.')||
    u.protocol==='http:'&&u.hostname==='localhost';
  if(!valid||u.host!==host)return null;
  return {portal,origin:u.origin,rpID:u.hostname};
}
const canUse=(u,portal)=>!!u&&u.active===1&&usablePassword(u.hash)&&
  (portal==='worker'?u.role==='worker':u.role==='owner'||u.role==='manager');
export function createPasskeys(db){
  const pending=new Map(),rate=new Map();
  const listRows=(u,p)=>db.prepare('SELECT * FROM local_passkeys WHERE account_id=? AND portal=? AND rp_id=? AND auth_version=? ORDER BY created_at,credential_id').all(u.id,p.portal,p.rpID,u.authVersion);
  const lookup=id=>validId(id)?db.prepare('SELECT * FROM local_passkeys WHERE credential_id=?').get(id):undefined;
  const account=id=>db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  const ensure=(u,p)=>insist(p&&canUse(u,p.portal),403,'Passkeys require an eligible local account on this exact portal.');
  const nowIso=()=>new Date().toISOString();
  function limit(scope,count=90){
    const now=Date.now();
    for(const [key,b] of rate)if(b.expires<=now)rate.delete(key);
    const current=rate.get(scope)||{count:0,expires:now+pause};
    insist((rate.has(scope)||rate.size<cap)&&current.count<count,429,'Too many passkey requests. Wait a few minutes or use your password.');
    current.count++;rate.set(scope,current);
  }
  function save(p,kind,challenge,bind,extra={}){
    const now=Date.now();for(const [id,c] of pending)if(c.expires<=now)pending.delete(id);
    insist(pending.size<cap,429,'Passkey requests are busy. Retry shortly or use your password.');
    const id=opaque();pending.set(id,{p,kind,challenge,bind,expires:now+lifetime,...extra});return id;
  }
  function consume(id,p,kind,bind){
    const c=pending.get(id);if(c)pending.delete(id);
    insist(c&&c.kind===kind&&c.bind===bind&&c.p.origin===p.origin&&c.p.portal===p.portal&&c.expires>Date.now(),400,'Passkey prompt expired. Start again from this portal.');
    return c;
  }
  async function loginStart(p){
    const options=await generateAuthenticationOptions({rpID:p.rpID,timeout:lifetime,userVerification:'required'});
    return {options,ticket:save(p,'login',options.challenge,p.portal)};
  }
  async function loginFinish(p,ticket,response,authorize){
    const {challenge}=consume(ticket,p,'login',p.portal),r=lookup(response?.id);
    if(!r||r.portal!==p.portal||r.rp_id!==p.rpID)verifiedFail();
    const initial=account(r.account_id);
    if(!canUse(initial,p.portal)||initial.authVersion!==r.auth_version||response?.response?.userHandle!==handle(initial.id).toString('base64url'))verifiedFail();
    let result;
    try{const client=decodeClientDataJSON(response.response.clientDataJSON);if(client.crossOrigin||client.topOrigin)throw Error();
      result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:p.origin,expectedRPID:p.rpID,
      credential:{id:r.credential_id,publicKey:new Uint8Array(r.public_key),counter:r.counter,transports:JSON.parse(r.transports)},requireUserVerification:true});}
    catch{verifiedFail();}
    if(!result.verified||!result.authenticationInfo.userVerified)verifiedFail();
    const live=account(initial.id);
    if(!canUse(live,p.portal)||live.authVersion!==initial.authVersion)verifiedFail();
    authorize(live,r.credential_id);
    const info=result.authenticationInfo;
    const affected=db.prepare('UPDATE local_passkeys SET counter=?,last_used=?,backed_up=? WHERE credential_id=? AND counter=? AND auth_version=?')
      .run(info.newCounter,nowIso(),Number(info.credentialBackedUp),r.credential_id,r.counter,r.auth_version);
    if(!affected.changes)verifiedFail();
    return {account:live,credential:r.credential_id};
  }
  async function begin(p,u,sid,label){
    ensure(u,p);
    insist(typeof label==='string'&&label.trim()&&label.length<=64&&!/[\u0000-\u001f\u007f]/.test(label),400,'Enter a passkey name of up to 64 characters.');
    const existing=listRows(u,p);insist(existing.length<12,409,'This account already has 12 passkeys on this portal.');
    const options=await generateRegistrationOptions({rpName:'FirmQuill '+(p.portal==='main'?'Full Suite':'Employee'),rpID:p.rpID,userName:u.username,userID:handle(u.id),
      userDisplayName:u.name,timeout:lifetime,attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},
      excludeCredentials:existing.map(r=>({id:r.credential_id,transports:JSON.parse(r.transports)})),supportedAlgorithmIDs:[-7,-257]});
    return {options,ticket:save(p,'register',options.challenge,sid,{id:u.id,version:u.authVersion,label:label.trim()})};
  }
  async function finish(p,u,sid,ticket,response,current){
    ensure(u,p);
    const r=consume(ticket,p,'register',sid);
    insist(r.id===u.id&&r.version===u.authVersion,409,'The account changed. Verify your password and start again.');
    let result;
    try{const client=decodeClientDataJSON(response.response.clientDataJSON);
      if(client.crossOrigin||client.topOrigin||decodeAttestationObject(Buffer.from(response.response.attestationObject,'base64url')).get('fmt')!=='none')throw Error();
      result=await verifyRegistrationResponse({response,expectedChallenge:r.challenge,expectedOrigin:p.origin,expectedRPID:p.rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});}
    catch{insist(false,400,'Passkey registration could not be verified. Try again.');}
    const live=current();ensure(live,p);
    insist(u.id===live.id&&u.authVersion===live.authVersion,409,'The account changed. Verify your password and start again.');
    const i=result.registrationInfo,k=i?.credential;
    insist(result.verified&&i?.userVerified&&validId(k?.id),400,'Passkey registration could not be verified.');
    insist(listRows(live,p).length<12&&!lookup(k.id),409,'This passkey is already registered or the account limit was reached.');
    db.prepare('INSERT INTO local_passkeys VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(k.id,live.id,p.portal,p.rpID,live.authVersion,r.label,Buffer.from(k.publicKey),k.counter,JSON.stringify(Array.isArray(k.transports)?k.transports.filter(t=>names.includes(t)):[]),nowIso(),null,Number(i.credentialDeviceType==='multiDevice'),Number(i.credentialBackedUp));
    return list(p,live);
  }
  function list(p,u){
    if(!p||!canUse(u,p.portal))return {available:false,credentials:[]};
    return {available:true,credentials:listRows(u,p).map(r=>({id:r.credential_id,name:r.label,createdAt:r.created_at,lastUsed:r.last_used,backedUp:!!r.backed_up}))};
  }
  function revoke(p,u,id){
    ensure(u,p);
    insist(validId(id),400,'Select an existing passkey.');
    insist(db.prepare('DELETE FROM local_passkeys WHERE credential_id=? AND account_id=? AND auth_version=? AND portal=? AND rp_id=?')
      .run(id,u.id,u.authVersion,p.portal,p.rpID).changes,404,'Passkey unavailable.');
    return list(p,u);
  }
  const currentCredential=(user,portal,id)=>{
    const row=lookup(id);return row?.account_id===user.id&&row?.portal===portal&&row?.auth_version===user.authVersion;
  };
  return {limit,loginStart,loginFinish,begin,finish,list,revoke,currentCredential};
}
