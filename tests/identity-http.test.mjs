import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openStore,readBooks,saveBooks,passwordHash,putUser,safeUser,tx} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {createIdentityService} from '../identity.mjs';
import {createSuite} from '../server.mjs';

const password='Fictional HTTP fixture credentials.';
const USER='urn:ietf:params:scim:schemas:core:2.0:User';
async function request(origin,path,{method='GET',body,cookie='',csrf='',headers={}}={}){
  const response=await fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const raw=await response.text();return {status:response.status,headers:response.headers,raw,data:raw?JSON.parse(raw):null};
}
async function session(origin,username){const login=await request(origin,'/api/login',{method:'POST',body:{username,password}});assert.equal(login.status,200,login.raw);return {origin,cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf,data:login.data};}
function call(client,path,body){return request(client.origin,path,{method:body===undefined?'GET':'POST',body,cookie:client.cookie,csrf:client.csrf});}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'firmquill-identity-http-')),database=join(directory,'fixture.sqlite'),db=openStore(database),state=sampleVault();tx(db,()=>saveBooks(db,state));
  const hash=await passwordHash(password),ownerId=tx(db,()=>putUser(db,null,{username:'fictional-owner',name:'Fictional Owner',role:'owner',assignments:[]},hash,{bootstrap:true})),owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(ownerId));
  const identity=createIdentityService({db,database,readBooks,saveBooks,passwordHash,putUser,secretKey:randomBytes(32)}),companyId=state.companies[0].id;
  const {connectorId}=await identity.command(owner,state,{type:'connector-save',config:{companyId,type:'scim',name:'Fictional HTTP SCIM',enabled:true,newEmployeeDefaults:{rate:2100,state:'CO',locality:'Fictional locality'}}});
  const {scimToken}=await identity.command(owner,state,{type:'scim-token',id:connectorId});db.close();const suite=await createSuite({database,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(directory,{recursive:true,force:true});});return {state,suite,companyId,connectorId,scimToken};
}

test('HTTP SCIM media types, company bearer scope, worker invite/login/clock and immediate session revocation',async t=>{
  const {suite,state,companyId,connectorId,scimToken}=await fixture(t),owner=await session(suite.mainUrl,'fictional-owner'),base='/api/scim/'+connectorId,headers={Authorization:'Bearer '+scimToken,'Content-Type':'application/scim+json'};
  const missing=await request(suite.mainUrl,base+'/Users');assert.equal(missing.status,401);assert.match(missing.headers.get('content-type'),/^application\/scim\+json/);
  const created=await request(suite.mainUrl,base+'/Users',{method:'POST',headers,body:{schemas:[USER],externalId:'fictional-http-guid',userName:'fictional.http@example.invalid',displayName:'Fictional HTTP Warehouse Worker',emails:[{type:'work',value:'fictional.http@example.invalid'}],active:true}});assert.equal(created.status,201,created.raw);assert.match(created.headers.get('content-type'),/^application\/scim\+json/);assert.ok(created.headers.get('etag'));const id=created.data.id;
  const listed=await request(suite.mainUrl,base+'/Users?filter='+encodeURIComponent('externalId eq "fictional-http-guid"'),{headers});assert.equal(listed.data.totalResults,1);
  const identities=await call(owner,'/api/identity?companyId='+encodeURIComponent(companyId)),binding=identities.data.bindings.find(b=>b.externalId==='fictional-http-guid');assert.ok(binding);
  const invite=await call(owner,'/api/identity/action',{action:{type:'invite-create',companyId,employeeId:binding.employee,username:'fictional-http-worker'}});assert.equal(invite.status,200,invite.raw);
  const setup=await request(suite.workerUrl,'/api/identity/invite/accept',{method:'POST',body:{token:invite.data.result.inviteToken,password}});assert.equal(setup.status,200,setup.raw);assert.equal((await request(suite.workerUrl,'/api/identity/invite/accept',{method:'POST',body:{token:invite.data.result.inviteToken,password}})).status,400);
  const worker=await session(suite.workerUrl,'fictional-http-worker');assert.equal((await call(worker,'/api/worker/action',{action:{type:'clock-in',jobId:state.companies[0].jobs[0].id}})).status,200);
  const patch={schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]};const disabled=await request(suite.mainUrl,base+'/Users/'+id,{method:'PATCH',headers,body:patch});assert.equal(disabled.status,200,disabled.raw);assert.equal(disabled.data.active,false);assert.equal((await call(worker,'/api/session')).status,401,'an existing worker session must stop working as soon as SCIM disables access');
  assert.equal((await request(suite.workerUrl,base+'/Users',{headers})).status,404,'SCIM is exposed only on the ERP listener');
  const rehire=await request(suite.mainUrl,base+'/Users/'+id,{method:'PATCH',headers,body:{...patch,Operations:[{op:'replace',path:'active',value:true}]}});assert.equal(rehire.status,200,rehire.raw);const rehired=await session(suite.workerUrl,'fictional-http-worker');assert.ok(rehired.data.data.openShift,'deactivation and rehire must preserve the original clock record');
  const removed=await request(suite.mainUrl,base+'/Users/'+id,{method:'DELETE',headers});assert.equal(removed.status,204);assert.equal(removed.raw,'');assert.match(removed.headers.get('content-type'),/^application\/scim\+json/);assert.equal((await call(rehired,'/api/session')).status,401);
  const rotated=await call(owner,'/api/identity/action',{action:{type:'scim-token',id:connectorId}});assert.equal(rotated.status,200);assert.equal((await request(suite.mainUrl,base+'/Users',{headers})).status,401,'rotation must revoke the old bearer token');
});

test('HTTP SCIM validation errors retain SCIM media type and do not expose profile or secret values',async t=>{
  const {suite,connectorId,scimToken}=await fixture(t),headers={Authorization:'Bearer '+scimToken,'Content-Type':'application/scim+json'},base='/api/scim/'+connectorId;
  const invalid=await request(suite.mainUrl,base+'/Users',{method:'POST',headers,body:[]});assert.equal(invalid.status,400);assert.match(invalid.headers.get('content-type'),/^application\/scim\+json/);assert.deepEqual(invalid.data.schemas,['urn:ietf:params:scim:api:messages:2.0:Error']);
  const rejected=await request(suite.mainUrl,base+'/Users',{method:'POST',headers,body:{schemas:[USER],externalId:'fixture',userName:'fixture',displayName:'Fictional Name',password:'NEVER COPY THIS SECRET'}});assert.equal(rejected.status,400);assert.equal(rejected.raw.includes('NEVER COPY THIS SECRET'),false);
});
