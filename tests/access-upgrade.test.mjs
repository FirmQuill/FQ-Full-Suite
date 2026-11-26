import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,tx,saveBooks,passwordHash,putUser} from '../store.mjs';
import {initializeWorker,workerCommand,workerView} from '../worker.mjs';
import {setEmployeeProfile} from '../records.mjs';
import {createSuite} from '../server.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

const OWNER_PASSWORD='Fictional owner password 902!';
const WORKER_PASSWORD='Fictional worker password 903!';
const ERP_PASSWORD='Fictional ERP password 904!';
function books(){
  let state=newVault('Fictional Warehouse Co',['employees','time']),company=state.companies[0].id;
  for(const name of ['Fictional Warehouse Worker','Fictional Second Worker'])state=apply(state,company,{type:'employee',name,rate:2600,state:'CO',locality:'Fictional locality',date:'2026-01-01'});
  state=apply(state,company,{type:'job',name:'Fictional warehouse project',date:'2026-01-01'});
  state=apply(state,company,{type:'company',name:'Fictional Other Company',activities:['employees'],date:'2026-01-01'});
  const other=state.companies[1].id;state=apply(state,other,{type:'employee',name:'Fictional Other Employee',rate:3500,state:'CO',locality:'Fictional locality',date:'2026-01-01'});
  return state;
}
async function client(url,username,password){
  const jar={cookie:'',csrf:''};
  async function request(path,body){
    const response=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie:jar.cookie,'Content-Type':'application/json','X-CSRF-Token':jar.csrf},body:body===undefined?undefined:JSON.stringify(body)});
    const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
    return {status:response.status,data,headers:response.headers};
  }
  const login=username?await request('login',{username,password}):null;
  if(login?.status===200){jar.cookie=login.headers.get('set-cookie').split(';')[0];jar.csrf=login.data.csrf;if(login.data.termsRequired){const accepted=await request('terms',fixtureAgreement);assert.equal(accepted.status,200);login.data=accepted.data;}}
  return {login,request};
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fq-access-upgrade-')),database=join(dir,'suite.sqlite'),state=books(),db=openStore(database);
  const hash=await passwordHash(OWNER_PASSWORD);let ownerId;
  try{tx(db,()=>{saveBooks(db,state);ownerId=putUser(db,null,{name:'Fictional Owner',username:'fictional-owner',role:'owner',assignments:[]},hash,{bootstrap:true});});}finally{db.close();}
  const suite=await createSuite({database,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
  const owner=await client(suite.mainUrl,'fictional-owner',OWNER_PASSWORD);assert.equal(owner.login.status,200);
  return {dir,database,state,suite,owner,ownerId,company:state.companies[0].id,employee:state.companies[0].employees[0].id,second:state.companies[0].employees[1].id,other:state.companies[1].id};
}
async function invite(x,portal='worker',extra={}){
  const response=await x.owner.request('identity/action',{action:{type:'invite-create',companyId:x.company,employeeId:x.employee,portal,username:portal==='worker'?'fictional-worker':'fictional-erp',...extra}});
  assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;
}
async function accept(x,invitation,password){
  const anonymous=await client(invitation.portal==='worker'?x.suite.workerUrl:x.suite.mainUrl);
  const result=await anonymous.request('identity/invite/accept',{token:invitation.inviteToken,password});assert.equal(result.status,200,JSON.stringify(result.data));
}

test('upgrade creates one worker account per employee while preserving legacy credentials and punches',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fq-legacy-access-')),database=join(dir,'legacy.sqlite'),state=books(),company=state.companies[0].id,employee=state.companies[0].employees[0].id;
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let db=new DatabaseSync(database);
  db.exec(`PRAGMA application_id=1179735372; PRAGMA user_version=1;
    CREATE TABLE books(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,assignments TEXT NOT NULL,employeeId TEXT NOT NULL,active INTEGER NOT NULL,hash TEXT NOT NULL,authVersion INTEGER NOT NULL);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,companyId TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);`);
  db.prepare('INSERT INTO books VALUES(1,12,?)').run(JSON.stringify(state));
  db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-worker','legacy-worker','Fictional Legacy Worker','worker',JSON.stringify([company]),employee,1,'preserved-legacy-hash',7);
  initializeWorker(db);const user={id:'legacy-worker',role:'worker',assignments:[company],employeeId:employee};
  workerCommand(db,user,state,{type:'clock-in',jobId:state.companies[0].jobs[0].id},new Date('2026-01-02T10:00:00Z'));
  workerCommand(db,user,state,{type:'clock-out',shiftId:workerView(db,user,state).openShift.id},new Date('2026-01-02T11:00:00Z'));db.close();
  db=openStore(database);
  try{
    const legacy=db.prepare('SELECT * FROM accounts WHERE id=?').get('legacy-worker');assert.equal(legacy.hash,'preserved-legacy-hash');assert.equal(legacy.authVersion,7);
    assert.equal(db.prepare("SELECT count(*) n FROM accounts WHERE role='worker'").get().n,3);
    assert.equal(db.prepare("SELECT count(*) n FROM accounts WHERE role='worker' AND hash=''").get().n,2);
    assert.equal(workerView(db,user,state).shifts.length,1);assert.equal(db.prepare('SELECT revision FROM books').get().revision,12);
  }finally{db.close();}
  db=openStore(database);try{assert.equal(db.prepare("SELECT count(*) n FROM accounts WHERE role='worker'").get().n,3);}finally{db.close();}
});

test('automatic worker account has no default password; local invite works without an identity provider',async t=>{
  const x=await fixture(t),users=(await x.owner.request('admin/users')).data.users,workers=users.filter(u=>u.role==='worker');
  assert.equal(workers.length,3);assert.ok(workers.every(u=>u.configured===false));
  const account=workers.find(u=>u.employeeId===x.employee),bad=await client(x.suite.workerUrl,account.username,'');assert.equal(bad.login.status,401);
  const invitation=await invite(x);await accept(x,invitation,WORKER_PASSWORD);
  const worker=await client(x.suite.workerUrl,invitation.username,WORKER_PASSWORD);assert.equal(worker.login.status,200);assert.deepEqual(worker.login.data.features,['Time','Pay','Reviews','Benefits','My Profile','Contacts']);
  assert.equal((await worker.request('worker/action',{action:{type:'clock-in',jobId:x.state.companies[0].jobs[0].id}})).status,200);
  const clock=(await worker.request('session')).data.data.openShift;
  assert.equal((await worker.request('worker/action',{action:{type:'clock-out',shiftId:clock.id}})).status,200);
  assert.equal((await client(x.suite.mainUrl,invitation.username,WORKER_PASSWORD)).login.status,401);
  const replay=await client(x.suite.workerUrl);assert.equal((await replay.request('identity/invite/accept',{token:invitation.inviteToken,password:'Another fictional password 908!'})).status,400);
});

test('worker feature flags remove sensitive projections and deny disabled APIs and downloads',async t=>{
  const x=await fixture(t),invitation=await invite(x);await accept(x,invitation,WORKER_PASSWORD);
  const stub=await x.owner.request('records/action',{action:{type:'paystub-import',companyId:x.company,employeeId:x.employee,periodStart:'2026-01-01',periodEnd:'2026-01-15',payDate:'2026-01-20',source:'Fictional test payroll source',filename:'fictional.pdf',finalized:true,data:Buffer.from('%PDF-1.4\n%Fictional test PDF\n%%EOF\n').toString('base64')}});assert.equal(stub.status,200);
  const review=await x.owner.request('records/action',{action:{type:'review-save',companyId:x.company,employeeId:x.employee,title:'Fictional review',body:'Fictional review contents'}});assert.equal(review.status,200);
  assert.equal((await x.owner.request('records/action',{action:{type:'review-publish',reviewId:review.data.result.reviewId,version:1}})).status,200);
  assert.equal((await x.owner.request('admin/employee-features',{companyId:x.company,employeeId:x.employee,features:['Time']})).status,200);
  const worker=await client(x.suite.workerUrl,invitation.username,WORKER_PASSWORD),s=worker.login.data;
  assert.deepEqual(s.features,['Time']);assert.deepEqual(s.records.paystubs,[]);assert.deepEqual(s.records.reviews,[]);assert.equal(s.records.employee,null);assert.deepEqual(s.records.contacts,{});assert.equal(s.benefits,null);
  assert.equal((await worker.request('records/file/'+stub.data.result.paystubId)).status,403);
  assert.equal((await worker.request('benefits')).status,403);
  assert.equal((await worker.request('records/action',{action:{type:'profile-update',version:0,patch:{personalPhone:'555-0100'}}})).status,403);
  assert.equal((await worker.request('records/action',{action:{type:'review-acknowledge',reviewId:review.data.result.reviewId}})).status,403);
  const hidden=(await worker.request('records')).data;assert.deepEqual(hidden.paystubs,[]);assert.equal(hidden.employee,null);
  assert.equal((await worker.request('worker/action',{action:{type:'clock-in',jobId:x.state.companies[0].jobs[0].id}})).status,200);
  assert.equal((await x.owner.request('admin/employee-features',{companyId:x.company,employeeId:x.employee,features:[]})).status,409);
  const open=(await worker.request('session')).data.data.openShift;assert.equal((await worker.request('worker/action',{action:{type:'clock-out',shiftId:open.id}})).status,200);
  assert.equal((await x.owner.request('admin/employee-features',{companyId:x.company,employeeId:x.employee,features:[]})).status,200);
  const minimal=(await worker.request('session')).data;assert.ok(!Object.hasOwn(minimal.data,'shifts'));assert.ok(!Object.hasOwn(minimal.data,'jobs'));
  assert.equal((await worker.request('worker/action',{action:{type:'clock-in',jobId:x.state.companies[0].jobs[0].id}})).status,403);
});

test('separate ERP login requires owner flags and area plus role permission; disabling ERP preserves worker login',async t=>{
  const x=await fixture(t),workerInvite=await invite(x);await accept(x,workerInvite,WORKER_PASSWORD);
  const denied=await x.owner.request('identity/action',{action:{type:'invite-create',companyId:x.company,employeeId:x.employee,portal:'main',role:'manager',areas:['Directory']}});assert.equal(denied.status,403);
  assert.equal((await x.owner.request('admin/employee-erp',{companyId:x.company,employeeId:x.employee,enabled:true,areas:['Directory','Accounting','Overview']})).status,200);
  const erpInvite=await invite(x,'main',{role:'manager',areas:['Directory']});await accept(x,erpInvite,ERP_PASSWORD);
  assert.equal((await client(x.suite.mainUrl,erpInvite.username,WORKER_PASSWORD)).login.status,401);
  assert.equal((await client(x.suite.workerUrl,workerInvite.username,ERP_PASSWORD)).login.status,401);
  const erp=await client(x.suite.mainUrl,erpInvite.username,ERP_PASSWORD);assert.equal(erp.login.status,200);assert.deepEqual(erp.login.data.user.areas,['Directory']);
  const state=erp.login.data.state;assert.equal(state.companies.length,1);const company=state.companies[0];
  for(const field of ['employees','time','jobs','entries','docs','assets','bank','reconciliations','history','moves'])assert.deepEqual(company[field],[],field);
  assert.deepEqual(state.groups,[]);assert.equal((await erp.request('records')).status,403);assert.equal((await erp.request('benefits')).status,403);assert.equal((await erp.request('audit')).status,403);
  const session=(await erp.request('session')).data;
  const posted=await erp.request('action',{companyId:x.company,revision:session.revision,action:{type:'contact',name:'Fictional permitted contact',kind:'Customer',date:'2026-01-02',requestId:randomUUID()}});assert.equal(posted.status,200);
  assert.equal((await erp.request('action',{companyId:x.company,revision:posted.data.revision,action:{type:'journal',date:'2026-01-02',requestId:randomUUID(),lines:[['1000',100],['3000',-100]],flow:'Financing'}})).status,403);
  const viewerCreated=await x.owner.request('admin/user',{username:'fictional-viewer',name:'Fictional read only viewer',role:'viewer',assignments:[x.company],employeeId:'',active:true,password:ERP_PASSWORD,areas:['Directory']});assert.equal(viewerCreated.status,200);
  const viewer=await client(x.suite.mainUrl,'fictional-viewer',ERP_PASSWORD);assert.equal(viewer.login.status,200);
  assert.equal((await viewer.request('action',{companyId:x.company,revision:viewer.login.data.revision,action:{type:'contact',name:'Fictional denied contact',kind:'Customer',date:'2026-01-02',requestId:randomUUID()}})).status,403,'an area flag cannot elevate a read only duty');
  assert.equal((await x.owner.request('admin/employee-erp',{companyId:x.company,employeeId:x.employee,enabled:true,areas:['Directory','Accounting','Overview','Reports']})).status,200);
  assert.equal((await erp.request('session')).status,401,'changing the employee ceiling revokes the prior ERP session');
  const expanded=await client(x.suite.mainUrl,erpInvite.username,ERP_PASSWORD);assert.equal(expanded.login.status,200);assert.deepEqual(expanded.login.data.user.areas,['Directory'],'widening the employee ceiling cannot widen a narrower login grant');
  assert.equal((await x.owner.request('admin/employee-erp',{companyId:x.company,employeeId:x.employee,enabled:true,areas:['Accounting','Overview','Reports']})).status,200);
  assert.equal((await expanded.request('session')).status,401);
  const noAreas=await client(x.suite.mainUrl,erpInvite.username,ERP_PASSWORD);assert.equal(noAreas.login.status,200);assert.deepEqual(noAreas.login.data.user.areas,[]);
  assert.deepEqual(noAreas.login.data.state.companies[0].parties,[]);assert.equal((await noAreas.request('records')).status,403);
  assert.equal((await x.owner.request('admin/employee-erp',{companyId:x.company,employeeId:x.employee,enabled:false,areas:['Directory']})).status,200);
  assert.equal((await noAreas.request('session')).status,401);
  assert.equal((await client(x.suite.workerUrl,workerInvite.username,WORKER_PASSWORD)).login.status,200);
  assert.equal((await client(x.suite.mainUrl,erpInvite.username,ERP_PASSWORD)).login.status,401);
});

test('scheduled employment deactivation cannot obtain a login snapshot after it becomes effective',async t=>{
  const x=await fixture(t),invitation=await invite(x);await accept(x,invitation,WORKER_PASSWORD);
  const db=openStore(x.database);try{tx(db,()=>{
    setEmployeeProfile(db,x.state,x.company,x.employee,{employmentStatus:'terminated'},x.ownerId,{effectiveDate:'2026-01-01'});
    // Simulate a scheduled transition whose account still has its prior active bit.
    db.prepare('UPDATE accounts SET active=1 WHERE employeeId=?').run(x.employee);
  });}finally{db.close();}
  const disabled=await client(x.suite.workerUrl,invitation.username,WORKER_PASSWORD);assert.equal(disabled.login.status,401);assert.ok(!disabled.login.data.records);
});
