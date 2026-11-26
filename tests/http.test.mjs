import {receipt} from './agreement-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {statements,consolidate} from '../shared/core.mjs';
import {ficaPreview,payrollGate,states} from '../shared/payroll-rules.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';

const pw='Synthetic fixture access, only.';
async function client(url,username){
  const session={cookie:'',csrf:''};
  async function request(path,data,headers={}){
    const res=await fetch(url+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{Origin:url,Cookie:session.cookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:res.status,data:await res.json(),headers:res.headers};
  }
  let login=await request('login',{username,password:pw});
  if(login.status===200){session.cookie=login.headers.get('set-cookie').split(';')[0];session.csrf=login.data.csrf;}
  if(login.data.termsRequired)login=await request('terms',receipt);
  return {login,request};
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fq-http-fixture-')),database=join(dir,'test.sqlite'),state=sampleVault();
  const db=openStore(database),hash=await passwordHash(pw);const [a,b]=state.companies;
  const ids={};
  try{tx(db,()=>{
    saveBooks(db,state);
    const owner=putUser(db,null,{username:'owner',name:'Synthetic Owner',role:'owner',assignments:[]},hash,{bootstrap:true});ids.owner=owner;
    for(const [username,role,assignments] of [['lead','manager',[a.id]],['otherlead','manager',[b.id]],['clerk','bookkeeper',[a.id]],['reader','viewer',[a.id]],['worker','worker',[a.id]]]){
      ids[username]=putUser(db,{id:owner,role:'owner'},{username,name:username,role,assignments,employeeId:a.employees[0].id},hash);
    }
  });}finally{db.close();}
  const suite=await createSuite({database,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
  return {dir,database,state,suite,ids};
}
test('pinned Lite build bytes, both company reports, consolidation and federal preview parity',async t=>{
  const baseline=await readFile(new URL('../baseline/LITE-SHA256SUMS.txt',import.meta.url),'utf8');
  for(const line of baseline.trim().split(/\r?\n/)){
    const [hash,path]=line.split('  ');if(!path.startsWith('dist/'))continue;
    const bytes=await readFile(new URL('../shared/'+path.slice(5),import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,path);
  }
  const {state,suite}=await fixture(t),owner=await client(suite.mainUrl,'owner'),full=owner.login.data.state;
  assert.deepEqual(full,state);
  for(const [index,amount] of [1542000,994800].entries())assert.equal(statements(full.companies[index].entries).closingCash,amount);
  assert.equal(consolidate(full,full.groups[0].id).report.income,491800);
  for(const c of full.companies){
    const args={payDate:'2026-03-01',ssWagesCents:18000,medicareWagesCents:18000,priorSsWagesCents:0,priorMedicareWagesCents:0};
    assert.equal(ficaPreview(args).employeeSocialSecurityCents,1116,c.name);
    for(const stateCode of states)assert.equal(payrollGate({payDate:args.payDate,state:stateCode,locality:'Example'}).allowed,false);
  }
});
test('server enforces assigned companies, role boundaries, portal separation, CSRF and account revocation',async t=>{
  const {suite,state,ids}=await fixture(t);
  const manager=await client(suite.mainUrl,'lead'),reader=await client(suite.mainUrl,'reader'),owner=await client(suite.mainUrl,'owner'),worker=await client(suite.workerUrl,'worker');
  const [a,b]=state.companies;
  assert.deepEqual(manager.login.data.state.companies.map(c=>c.id),[a.id]);assert.equal(manager.login.data.state.groups.length,0);
  assert.equal((await manager.request('admin/users')).status,403);
  const action={type:'contact',name:'Synthetic Buyer',kind:'Customer',requestId:randomUUID(),date:'2026-02-01'};
  const body={companyId:b.id,action,revision:manager.login.data.revision};
  assert.equal((await manager.request('action',body)).status,403);
  assert.equal((await reader.request('action',{...body,companyId:a.id})).status,403);
  assert.equal((await manager.request('transfer/export',{password:pw})).status,403);
  assert.equal((await manager.request('action',{...body,companyId:a.id},{'X-CSRF-Token':''})).status,403);
  assert.equal((await manager.request('action',{...body,companyId:a.id},{Origin:suite.workerUrl})).status,403);
  assert.equal((await client(suite.mainUrl,'worker')).login.status,401);
  assert.equal((await client(suite.workerUrl,'lead')).login.status,401);
  assert.equal(worker.login.status,200);assert.equal(worker.login.data.state,undefined);assert.equal((await worker.request('admin/users')).status,403);
  assert.equal((await worker.request('transfer/export',{password:pw})).status,403);
  const users=(await owner.request('admin/users')).data.users;
  assert.ok(users.every(u=>!Object.hasOwn(u,'hash')));
  const old=users.find(u=>u.id===ids.lead);assert.equal((await owner.request('admin/user',{...old,active:false})).status,200);
  assert.equal((await manager.request('session')).status,401);assert.equal((await owner.request('admin/user',{...old,active:true})).status,409);
});
test('simultaneous financial writers, replay, independent approval and scoped audit',async t=>{
  const {suite,state}=await fixture(t),owner=await client(suite.mainUrl,'owner'),manager=await client(suite.mainUrl,'lead'),clerk=await client(suite.mainUrl,'clerk'),other=await client(suite.mainUrl,'otherlead');
  const companyId=state.companies[0].id,start=owner.login.data.revision;
  const posting=()=>({type:'journal',requestId:randomUUID(),label:'Synthetic contribution',date:'2026-02-01',lines:[['1000',999],['3000',-999]],flow:'Financing'});
  const inputs=[posting(),posting()].map(action=>({companyId,action,revision:start}));
  const results=await Promise.all([owner.request('action',inputs[0]),manager.request('action',inputs[1])]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const which=results.findIndex(r=>r.status===200),winner=[owner,manager][which];
  const replay=await winner.request('action',inputs[which]);assert.equal(replay.status,200);assert.equal(replay.data.revision,start+1);
  const pending=await clerk.request('action',{companyId,action:posting(),revision:start+1});assert.ok(pending.data.pendingApproval);
  assert.equal(pending.data.state.companies[0].entries.length,state.companies[0].entries.length+1);
  const decide={id:pending.data.pendingApproval,decision:'approve',revision:pending.data.revision};
  assert.equal((await clerk.request('approve',decide)).status,403);assert.equal((await other.request('approve',decide)).status,404);
  const done=await manager.request('approve',decide);assert.equal(done.status,200);assert.equal(done.data.state.companies[0].entries.length,state.companies[0].entries.length+2);
  assert.equal((await manager.request('approve',{...decide,revision:done.data.revision})).status,409);
  const audit=await manager.request('audit');assert.ok(audit.data.events.every(x=>x.companyId===companyId));assert.ok(audit.data.events.some(x=>x.kind==='approve'));
});
test('encrypted entire-database recovery opens in a distinct running instance with working credentials and books',async t=>{
  const {dir,database,suite,state}=await fixture(t);const p=await client(suite.mainUrl,'lead');assert.equal(p.login.status,200);
  const backup=join(dir,'whole.fqdb'),copy=join(dir,'recovered.sqlite');await backupDatabase(database,backup,pw);await restoreDatabase(backup,copy,pw);
  const recovered=await createSuite({database:copy,mainPort:0,workerPort:0});
  try{assert.deepEqual((await client(recovered.mainUrl,'owner')).login.data.state,state);assert.equal((await client(recovered.workerUrl,'worker')).login.status,200);}finally{await recovered.close();}
});



