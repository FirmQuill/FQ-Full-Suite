import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {activationFixture} from './fixture-activation.mjs';

test('public runtime admits installed signed inert docs only for matching paid owner, preserves default help and books',async t=>{
 const root=await mkdtemp(join(tmpdir(),'fq-public-data-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime');await buildPublicRelease(runtime);
 const app=n=>import(pathToFileURL(join(runtime,n)));
 const {openStore,saveBooks,putUser,passwordHash}=await app('store.mjs'),{newVault}=await app('shared/core.mjs'),{createSuite}=await app('server.mjs');
 const pw='Fictional setup password only.',dbPath=join(root,'fictional.sqlite'),db=openStore(dbPath);
 try{saveBooks(db,newVault('Fictional Company'));putUser(db,null,{username:'owner',name:'Fictional Owner',role:'owner',assignments:[]},await passwordHash(pw),{bootstrap:true});}finally{db.close();}
 let now=Date.UTC(2026,10,27);const lic=await activationFixture(root,{clock:()=>now}),expiresAt=now/1000+120;
 const packagePath=join(root,'fixture.fqsupport'),verifierPath=join(root,'suite-package-public.pem'),pair=generateKeyPairSync('ed25519');
 await writeFile(verifierPath,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 const payload={format:'firmquill.support-content.v1',release:'0.6.5',installationId:lic.id,files:{'index.json':JSON.stringify({version:'0.6.5',scope:'private-customer-manual',articles:[{id:'fixture',file:'fixture.md',title:'Synthetic help fixture',status:'verified-local',keywords:['verification']}]}),'fixture.md':'# Synthetic fixture\n\nFictional package proof only.'}};
 async function put(body,{tamper=false}={}){
  const data=Buffer.from(JSON.stringify(body)),sig=sign(null,data,pair.privateKey);if(tamper)sig[0]^=1;
  await writeFile(packagePath,JSON.stringify({signed:data.toString('base64url'),signature:sig.toString('base64url')}),{mode:0o600});
 }
 const opts={packagePath,verifierPath};
 async function host(signedSupport,run){
  const s=await createSuite({database:dbPath,mainPort:0,workerPort:0,activationOptions:lic.options,supportOptions:{signedSupport}});
  try{
   let cookie,csrf;
   async function req(path,body){const r=await fetch(s.mainUrl+'/api/'+path,{method:body?'POST':'GET',headers:{Origin:s.mainUrl,'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
   const auth=await req('login',{username:'owner',password:pw});assert.equal(auth.status,200);cookie=auth.cookie;csrf=auth.data.csrf;
   if(auth.data.termsRequired){assert.equal((await req('support/info')).status,428);assert.equal((await req('terms',fixtureAgreement)).status,200);}
   await run(req);
  }finally{await s.close();}
 }
 const scope=async(r,want='public-setup-only')=>assert.equal((await r('support/info')).data.scope,want);
 await host(undefined,scope);
 await put(payload);
 const activation=lic.mint({modules:['private-support'],expiresAt});
 await host(opts,async r=>{
  await scope(r);assert.equal((await r('support/article?id=fixture')).status,404);
  assert.equal((await r('module-activation',{code:activation})).status,200);
  await scope(r,'private-customer-manual');assert.match((await r('support/article?id=fixture')).data.body,/Fictional package proof/);
  assert.equal((await r('support/article?id=fixture&scope=public')).status,404);
 });
 await host(opts,async r=>await scope(r,'private-customer-manual'));
 for(const body of [{...payload,installationId:'a'.repeat(64)},{...payload,release:'0.0.0'},{...payload,files:{...payload.files,'not-doc.js':'ignored'}}]){
  await put(body);await host(opts,scope);
 }
 await put(payload,{tamper:true});await host(opts,scope);
 await put(payload);await host({...opts,verifierPath:lic.options.verifierPath},scope);
 now=expiresAt*1000;await host(opts,scope);
});
