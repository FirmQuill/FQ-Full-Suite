import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {openStore,readBooks,saveBooks,putUser,passwordHash,passwordMatches,safeUser,tx} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {initializeIdentity,createIdentityService,validateIdToken} from '../identity.mjs';
import {initializeRecords,employeeProfile,setEmployeeProfile} from '../records.mjs';

const USER='urn:ietf:params:scim:schemas:core:2.0:User';
const pw='Fictional employee fixture only.';
async function fixture(t,options={}){
  const db=openStore(':memory:');initializeIdentity(db);initializeRecords(db);const state=sampleVault();tx(db,()=>saveBooks(db,state));
  const hash=await passwordHash(pw);const id=tx(db,()=>putUser(db,null,{username:'fixture-owner',name:'Fictional Owner',role:'owner',assignments:[]},hash,{bootstrap:true})),owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
  const service=createIdentityService({db,readBooks,saveBooks,putUser,passwordHash,secretKey:randomBytes(32),...options});t.after(()=>db.close());return {db,state,owner,service};
}
const config=(companyId,type='fixture')=>({companyId,type,name:'Fictional workforce fixture',enabled:true,newEmployeeDefaults:{rate:2000,state:'CO',locality:'Fictional location'},groupMap:[{externalGroup:'fixture-warehouse',groupId:'warehouse',role:'manager',priority:10}]});

test('provider scoped provisioning repeats safely, previews conflicts, preserves history and deactivates sessions',async t=>{
  const {db,state,owner,service}=await fixture(t),companyId=state.companies[0].id;
  const {connectorId:id}=await service.command(owner,state,{type:'connector-save',config:config(companyId)});
  const rows=[{externalId:'fictional-guid-1',name:'Fictional Warehouse Employee',workEmail:'fixture-one@example.invalid',department:'Warehouse',groups:['fixture-warehouse']}];
  const preview=await service.command(owner,state,{type:'connector-preview',id,rows});assert.equal(preview.preview.conflicts.length,0);assert.equal(preview.preview.rows[0].suggestedErpRole,'manager');
  await service.command(owner,state,{type:'connector-sync',id,previewId:preview.preview.id});const binding=db.prepare('SELECT * FROM identity_bindings WHERE connector=?').get(id),account=db.prepare('SELECT * FROM accounts WHERE id=?').get(binding.user_id);
  assert.equal(account.role,'worker','mapped ERP duties must not elevate the worker login');assert.equal(employeeProfile(db,readBooks(db).state,companyId,binding.employee).department,'Warehouse');
  const second=await service.command(owner,state,{type:'connector-preview',id,rows:[{...rows[0],department:'Sales'}]});await service.command(owner,state,{type:'connector-sync',id,previewId:second.preview.id});assert.equal(db.prepare('SELECT count(*) AS n FROM identity_bindings WHERE connector=?').get(id).n,1);assert.equal(readBooks(db).state.companies[0].employees.length,state.companies[0].employees.length+1);
  const profile=employeeProfile(db,readBooks(db).state,companyId,binding.employee);assert.ok(profile.history.some(h=>h.changes.department?.after==='Sales'));
  const collision=await service.command(owner,state,{type:'connector-preview',id,rows:[{...rows[0],externalId:'different-person-same-email'}]});assert.equal(collision.preview.conflicts.length,1);await assert.rejects(service.command(owner,state,{type:'connector-sync',id,previewId:collision.preview.id}),{status:409});
  const failure=db.prepare("SELECT * FROM identity_syncs WHERE status='failed' AND connector=?").get(id);assert.equal(JSON.parse(failure.summary).operation,'connector-sync');assert.equal(failure.summary.includes(rows[0].workEmail),false);
  const disabled=await service.command(owner,state,{type:'connector-preview',id,rows:[{...rows[0],active:false}]});await service.command(owner,state,{type:'connector-sync',id,previewId:disabled.preview.id});const inactive=db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);assert.equal(inactive.active,0);assert.ok(inactive.authVersion>account.authVersion);assert.ok(db.prepare('SELECT 1 FROM identity_bindings WHERE id=?').get(binding.id));
  const rehire=await service.command(owner,state,{type:'connector-preview',id,rows});await service.command(owner,state,{type:'connector-sync',id,previewId:rehire.preview.id});assert.equal(db.prepare('SELECT active FROM accounts WHERE id=?').get(account.id).active,1);assert.equal(db.prepare('SELECT employee FROM identity_bindings WHERE id=?').get(binding.id).employee,binding.employee);
  assert.ok(!JSON.stringify(service.view(owner,readBooks(db).state)).includes('token_hash'));
});

test('local invite adopts automatic worker identity, is one-time and does not require a connector',async t=>{
  const {db,state,owner,service}=await fixture(t),companyId=state.companies[0].id,employeeId=state.companies[0].employees[0].id,original=db.prepare("SELECT * FROM accounts WHERE employeeId=? AND role='worker'").get(employeeId);
  const invite=await service.command(owner,state,{type:'invite-create',companyId,employeeId,username:'fictional-worker'});assert.equal(invite.username,'fictional-worker');assert.equal(db.prepare("SELECT count(*) AS n FROM accounts WHERE employeeId=? AND role='worker'").get(employeeId).n,1);
  const result=await service.acceptInvite(invite.inviteToken,pw);assert.equal(result.userId,original.id);const row=db.prepare('SELECT * FROM accounts WHERE id=?').get(result.userId);assert.equal(await passwordMatches(pw,row.hash),true);await assert.rejects(service.acceptInvite(invite.inviteToken,pw),/Invalid or expired/);
  const renew=await service.command(owner,state,{type:'invite-create',companyId,employeeId});db.prepare('UPDATE identity_invites SET expires=0 WHERE token_hash IS NOT NULL AND consumed IS NULL').run();await assert.rejects(service.acceptInvite(renew.inviteToken,pw),/Invalid or expired/);
});

test('SCIM supports create/list/filter/patch/rehire, atomic patch failure and company-token isolation',async t=>{
  const {db,state,owner,service}=await fixture(t),companyId=state.companies[0].id;
  const {connectorId:id}=await service.command(owner,state,{type:'connector-save',config:config(companyId,'scim')});const {scimToken}=await service.command(owner,state,{type:'scim-token',id}),headers={authorization:'Bearer '+scimToken},base='/api/scim/'+id;
  const data={schemas:[USER],externalId:'fictional-scim-001',userName:'scim-worker@example.invalid',displayName:'Fictional SCIM Worker',active:true,emails:[{value:'scim-worker@example.invalid',type:'work'}]};
  const created=await service.scim('POST',base+'/Users',headers,data);assert.equal(created.status,201,JSON.stringify(created.body));const resourceId=created.body.id;
  assert.equal((await service.scim('POST',base+'/Users',headers,data)).status,409);
  assert.equal((await service.scim('GET',base+'/Users?filter='+encodeURIComponent('externalId eq "fictional-scim-001"'),headers)).body.totalResults,1);
  const patch={schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]};assert.equal((await service.scim('PATCH',base+'/Users/'+resourceId,headers,patch)).body.active,false);
  const failed=await service.scim('PATCH',base+'/Users/'+resourceId,headers,{...patch,Operations:[{op:'replace',path:'active',value:true},{op:'replace',path:'password',value:'forbidden'}]});assert.equal(failed.status,400);assert.equal((await service.scim('GET',base+'/Users/'+resourceId,headers)).body.active,false);
  assert.equal((await service.scim('PATCH',base+'/Users/'+resourceId,headers,{...patch,Operations:[{op:'replace',path:'active',value:true}]})).body.active,true);
  const {connectorId:other}=await service.command(owner,state,{type:'connector-save',config:config(state.companies[1].id,'scim')});assert.equal((await service.scim('GET','/api/scim/'+other+'/Users',headers)).status,401);assert.equal((await service.scim('GET',base+'/Users',{})).status,401);assert.equal(db.prepare('SELECT count(*) AS n FROM identity_bindings WHERE connector=?').get(id).n,1);
  const manager={...owner,role:'manager'};await assert.rejects(service.command(manager,state,{type:'scim-token',id}),{status:403});assert.throws(()=>service.view(manager,state),{status:403});
});

test('separate ERP invitation requires explicit employee flags and leaves worker credentials independent',async t=>{
  const {db,state,owner,service}=await fixture(t),companyId=state.companies[0].id,employeeId=state.companies[0].employees[0].id;
  const worker=await service.command(owner,state,{type:'invite-create',companyId,employeeId,username:'fictional-worker-two'});const workerId=(await service.acceptInvite(worker.inviteToken,pw)).userId;
  const request={type:'invite-create',companyId,employeeId,portal:'main',role:'viewer',areas:['Reports'],username:'fictional-erp-two'};
  await assert.rejects(service.command(owner,state,request),{status:403});
  db.prepare('INSERT INTO employee_erp_flags VALUES(?,?,?,?)').run(companyId,employeeId,1,JSON.stringify(['Reports']));
  await assert.rejects(service.command(owner,state,{...request,areas:['Payroll']}),{status:403});
  const invite=await service.command(owner,state,request),erpPassword='Different fictional ERP credentials.';assert.equal(invite.portal,'main');const erpId=(await service.acceptInvite(invite.inviteToken,erpPassword)).userId;assert.notEqual(erpId,workerId);
  const erp=db.prepare('SELECT * FROM accounts WHERE id=?').get(erpId),workerAccount=db.prepare('SELECT * FROM accounts WHERE id=?').get(workerId);assert.equal(erp.role,'viewer');assert.equal(workerAccount.role,'worker');assert.equal(await passwordMatches(erpPassword,erp.hash),true);assert.equal(await passwordMatches(erpPassword,workerAccount.hash),false);assert.equal(await passwordMatches(pw,workerAccount.hash),true);
  await service.command(owner,state,{...request,role:'manager'});assert.equal(db.prepare('SELECT role FROM accounts WHERE id=?').get(erpId).role,'manager');assert.equal(await passwordMatches(erpPassword,db.prepare('SELECT hash FROM accounts WHERE id=?').get(erpId).hash),true,'issuing another ERP invite preserves its password until setup is redeemed');assert.equal(await passwordMatches(pw,db.prepare('SELECT hash FROM accounts WHERE id=?').get(workerId).hash),true);
});

function signer(){const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'fixture-key',use:'sig',alg:'RS256'};return {jwk,encode(claims){const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url'),b=Buffer.from(JSON.stringify(claims)).toString('base64url');return h+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+b),privateKey).toString('base64url');}};}
test('OIDC validates signature issuer audience expiry nonce, PKCE state and explicit provider subject binding',async t=>{
  const signing=signer(),issuer='https://fictional-issuer.example.invalid',clientId='fictional-client',now=Date.now(),claims={iss:issuer,aud:clientId,sub:'fictional-subject',nonce:'fixture-nonce',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+600},options={issuer,audience:clientId,nonce:'fixture-nonce',jwks:{keys:[signing.jwk]},now};
  assert.equal((await validateIdToken(signing.encode(claims),options)).sub,claims.sub);
  for(const patch of [{iss:'https://wrong.example.invalid'},{aud:'wrong'},{nonce:'wrong'},{exp:Math.floor(now/1000)-1}])await assert.rejects(validateIdToken(signing.encode({...claims,...patch}),options),{status:401});
  const valid=signing.encode(claims);await assert.rejects(validateIdToken(valid.slice(0,-8)+'AAAAAAAA',options),{status:401});
  let currentNonce='',tokenRequests=0;const fixtureFetch=async(url,opts)=>{let body;if(url.endsWith('/.well-known/openid-configuration'))body={issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['RS256']};else if(url.endsWith('/keys'))body={keys:[signing.jwk]};else{tokenRequests++;assert.equal(new URLSearchParams(opts.body).get('code_verifier')?.length,43);body={id_token:signing.encode({...claims,nonce:currentNonce})};}return {ok:true,text:async()=>JSON.stringify(body)};};
  const {db,state,owner,service}=await fixture(t,{fetcher:fixtureFetch}),companyId=state.companies[0].id,employeeId=state.companies[0].employees[0].id;
  const {connectorId:id}=await service.command(owner,state,{type:'connector-save',config:{...config(companyId,'oidc'),issuer,clientId,clientSecret:'fictional-secret'}});await service.command(owner,state,{type:'identity-link',id,employeeId,externalId:claims.sub});
  const redirectUri='http://127.0.0.1:4180/api/identity/oidc/callback',start=await service.beginOidc(id,redirectUri,'worker'),redirect=new URL(start.redirect);currentNonce=redirect.searchParams.get('nonce');assert.equal(redirect.searchParams.get('code_challenge_method'),'S256');const result=await service.finishOidc({state:redirect.searchParams.get('state'),code:'fictional-code'},redirectUri,start.binding);assert.equal(result.portal,'worker');assert.ok(result.userId);assert.equal(tokenRequests,1);
  await assert.rejects(service.finishOidc({state:redirect.searchParams.get('state'),code:'fictional-code'},redirectUri,start.binding),{status:401});
  const second=await service.beginOidc(id,redirectUri,'worker');await assert.rejects(service.finishOidc({state:new URL(second.redirect).searchParams.get('state'),code:'fictional-code'},redirectUri,'wrong-browser'),{status:401});assert.equal(tokenRequests,1);
  const attempt=async portal=>{const callback=portal==='main'?'http://127.0.0.1:4179/api/identity/oidc/callback':redirectUri,start=await service.beginOidc(id,callback,portal),url=new URL(start.redirect);currentNonce=url.searchParams.get('nonce');return service.finishOidc(new URLSearchParams({state:url.searchParams.get('state'),code:'fictional-code'}),callback,start.binding);};
  const before=db.prepare('SELECT count(*) AS n FROM accounts').get().n;await assert.rejects(attempt('main'),{status:403});assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n,before,'federation never creates an ERP account');
  await assert.rejects(service.command(owner,state,{type:'identity-link',id,employeeId,externalId:claims.sub,portal:'main'}),{status:403});
  db.prepare('INSERT INTO employee_erp_flags VALUES(?,?,?,?)').run(companyId,employeeId,1,JSON.stringify(['Reports']));
  await assert.rejects(service.command(owner,state,{type:'identity-link',id,employeeId,externalId:claims.sub,portal:'main'}),{status:403},'an ERP account must already exist');
  const erpInvite=await service.command(owner,state,{type:'invite-create',companyId,employeeId,portal:'main',username:'federated-fixture-erp',role:'viewer',areas:['Reports']}),erpAccount=(await service.acceptInvite(erpInvite.inviteToken,'Separate fictional ERP password.')).userId;
  await assert.rejects(attempt('main'),{status:403},'an existing ERP account is insufficient without an explicit portal link');
  await service.command(owner,state,{type:'identity-link',id,employeeId,externalId:claims.sub,portal:'main',accountId:erpAccount});
  assert.equal((await attempt('main')).userId,erpAccount);assert.equal((await attempt('worker')).userId,result.userId);assert.notEqual(erpAccount,result.userId);assert.equal(service.view(owner,state).loginLinks.filter(l=>l.externalId===claims.sub).length,2);
  db.prepare('UPDATE employee_erp_flags SET enabled=0 WHERE company=? AND employee=?').run(companyId,employeeId);await assert.rejects(attempt('main'),{status:403});assert.equal((await attempt('worker')).userId,result.userId,'worker federation remains separate when ERP eligibility is disabled');
  db.prepare('UPDATE employee_erp_flags SET enabled=1 WHERE company=? AND employee=?').run(companyId,employeeId);db.prepare('UPDATE accounts SET active=0,authVersion=authVersion+1 WHERE id=?').run(erpAccount);await assert.rejects(attempt('main'),{status:403});
});

test('AD adapter fixtures keep passwords out of config, previews, and audit, requiring explicit TLS settings',async t=>{
  let called=false;const {db,state,owner,service}=await fixture(t,{directoryReader:async(config,secrets)=>{called=true;assert.equal(config.host,'directory.example.invalid');assert.equal(secrets.bindPassword,'fictional-directory-secret');return [{objectGUID:'fictional-guid',displayName:'Fictional Directory Worker',mail:'directory@example.invalid',active:true}];}});
  const {connectorId:id}=await service.command(owner,state,{type:'connector-save',config:{...config(state.companies[0].id,'ldaps'),host:'directory.example.invalid',bindUser:'read-only-fixture',baseDn:'DC=example,DC=invalid',bindPassword:'fictional-directory-secret'}});const tested=await service.command(owner,state,{type:'connector-test',id});assert.equal(tested.connection.ok,true);const preview=await service.command(owner,state,{type:'connector-preview',id});assert.equal(preview.preview.rows.length,1);assert.equal(called,true);
  assert.equal(JSON.stringify(service.view(owner,state)).includes('fictional-directory-secret'),false);assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('fictional-directory-secret'),false);assert.equal(db.prepare('SELECT secrets FROM identity_connectors WHERE id=?').get(id).secrets.includes('fictional-directory-secret'),false);
});
