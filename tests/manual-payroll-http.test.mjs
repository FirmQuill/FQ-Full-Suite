import {activationFixture} from './fixture-activation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {apply} from '../shared/core.mjs';
import {projectErpState} from '../access.mjs';
import {inspectLite} from '../transfer.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

const password='Fictional manual payroll test password';
async function client(url,username){
 let cookie='',csrf='';
 const raw=(path,data)=>fetch(url+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{Origin:url,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 const request=async(path,data)=>{const r=await raw(path,data);return {status:r.status,data:await r.json(),headers:r.headers};};
 const login=await request('login',{username,password});
 assert.equal(login.status,200,JSON.stringify(login.data));cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;if(login.data.termsRequired)assert.equal((await request('terms',fixtureAgreement)).status,200);
 return {request,raw};
}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'firmquill-manual-payroll-')),database=join(dir,'test.sqlite');
 let state=sampleVault();const c0=state.companies[0];
 state=apply(state,c0.id,{type:'employee',name:'Second Fictional Employee',state:'WA',locality:'Seattle',rate:2100,date:'2027-01-02',requestId:randomUUID()});
 const [c,other]=state.companies,employee=c.employees[0],e2=c.employees.at(-1);
 state=apply(state,c.id,{type:'time',employee:employee.id,job:c.jobs[0].id,minutes:90,date:'2027-01-02',requestId:randomUUID()});
 state=apply(state,c.id,{type:'approve time',time:state.companies[0].time.at(-1).id,date:'2027-01-02',requestId:randomUUID()});
 state=apply(state,c.id,{type:'time',employee:employee.id,job:c.jobs[0].id,minutes:500,date:'2027-01-02',requestId:randomUUID()});
 const db=openStore(database),hash=await passwordHash(password);
 try{tx(db,()=>{
   saveBooks(db,state);
   const owner=putUser(db,null,{username:'pay-owner',name:'Payroll Owner',role:'owner',assignments:[]},hash,{bootstrap:true});
   const {companies}=state;const regular=companies[0];
   // A genuine account-area split and cross-company test.
   for(const [name,role,assignments,employeeId,areas] of [
     ['pay-staff','payroll',[c.id],'',['Payroll','Employee records']],
     ['pay-denied','payroll',[c.id],'',['Employee records']],
     ['pay-manager','manager',[c.id],'',['Payroll']],
     ['pay-other','payroll',[other.id],'',['Payroll']],
     ['pay-worker','worker',[c.id],employee.id,[]],
     ['unrelated-worker','worker',[c.id],e2.id,[]]
   ])putUser(db,{id:owner,role:'owner'},{username:name,name,role,assignments,employeeId,areas},hash);
   const synthetic={...regular,manualPayroll:{secret:'PRIVATE LITE PAYROLL'}};
   for(const row of db.prepare("SELECT * FROM accounts WHERE role='manager' OR role='payroll'").all()){
     const u={...row,assignments:JSON.parse(row.assignments)};
     assert.equal(projectErpState(db,u,{...state,companies:[synthetic]}).companies[0].manualPayroll,undefined);
   }
 });}finally{db.close();}
 const {options:activationOptions}=await activationFixture(dir,{activate:['manual-payroll']});
 let suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions});
 t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
 return {database,get suite(){return suite;},async restart(){await suite.close();suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions});},c,other,employee,state};
}
test('manual payroll HTTP: scoped rules, approved time, exactly-once publication, restart and encrypted owner export',async t=>{
 const x=await fixture(t),portal=x.suite;
 const owner=await client(portal.mainUrl,'pay-owner'),staff=await client(portal.mainUrl,'pay-staff');
 const manager=await client(portal.mainUrl,'pay-manager'),denied=await client(portal.mainUrl,'pay-denied'),other=await client(portal.mainUrl,'pay-other');
 const worker=await client(portal.workerUrl,'pay-worker'),unrelated=await client(portal.workerUrl,'unrelated-worker');
 const path='manual-payroll?companyId='+encodeURIComponent(x.c.id);
 assert.equal((await manager.request(path)).status,403);assert.equal((await denied.request(path)).status,403);assert.equal((await other.request(path)).status,404);assert.notEqual((await worker.raw(path)).status,200);
 let rev=0;const post=async input=>{const out=await staff.request(path,{revision:rev,...input});assert.equal(out.status,200,JSON.stringify(out.data));rev=out.data.data.revision;return out.data;};
 await post({type:'rule',key:'example-local',name:'Fictional Local Tax',effective:'2027-01-01',side:'employee',method:'percentage',rate:100000});
 assert.equal((await staff.request(path,{type:'draft',revision:rev,companyId:x.other.id,employee:x.other.employees[0]?.id??'other-company-employee',id:'other-draft',start:'2027-01-01',end:'2027-01-07',payDate:'2027-01-08',regular:5000})).status,404);
 const approved=x.state.companies[0].time.filter(a=>a.employee===x.employee.id&&a.approved&&a.date==='2027-01-02')[0];
 const d=await post({type:'draft',id:'test-run',employee:x.employee.id,start:'2027-01-01',end:'2027-01-07',payDate:'2027-01-08',regular:1,fromApprovedTime:true,timeSource:{cents:999999}});
 assert.equal(d.data.drafts[0].preview.gross,approved.cost);assert.equal(d.data.drafts[0].timeSource.count,1);
 assert.equal((await staff.request(path,{type:'finalize',id:'test-run',revision:rev,reviewed:false})).status,400);
 const finalRequest={type:'finalize',id:'test-run',revision:rev,reviewed:true};
 const final=await post(finalRequest);assert.equal(final.data.runs.length,1);assert.equal(final.data.runs[0].net,approved.cost-Math.round(approved.cost/10));
 const retry=await post(finalRequest);assert.equal(retry.replayed,true);assert.equal(retry.data.runs.length,1);
 const records=(await worker.request('session')).data.records;assert.equal(records.paystubs.filter(x=>x.source==='FirmQuill manual payroll').length,1);
 const stub=records.paystubs.find(x=>x.source==='FirmQuill manual payroll');
 assert.equal((await worker.raw('records/file/'+stub.id)).headers.get('content-type'),'application/pdf');
 assert.equal((await unrelated.raw('records/file/'+stub.id)).status,404);
 assert.doesNotMatch(JSON.stringify((await manager.request('session')).data),/Fictional Local Tax|test-run/);
 assert.doesNotMatch(JSON.stringify((await worker.request('session')).data),/Fictional Local Tax|test-run/);
 const exported=await owner.request('transfer/export',{password});assert.equal(exported.status,200);
 const portable=await inspectLite(exported.data.envelope,password);
 assert.equal(portable.state.companies[0].manualPayroll.runs[0].net,final.data.runs[0].net);
 assert.equal(portable.state.companies[0].manualPayroll.runs[0].finalizedBy,'prior authorized payroll operator');
 assert.deepEqual(portable.state.companies[0].entries,x.state.companies[0].entries,'manual payroll does not post the general ledger');
 await x.restart();
 const reopened=await client(x.suite.mainUrl,'pay-owner');
 assert.equal((await reopened.request(path)).data.data.runs[0].net,final.data.runs[0].net);
});

const executable=process.env.FIRMQUILL_BROWSER_EXE;
test('Full Suite payroll user finalizes a manual pay run through actual forms',{skip:!executable,timeout:90000},async t=>{
 const x=await fixture(t),{createRequire}=await import('node:module');
 const {acceptFixtureBrowser}=await import('./fixture-terms.mjs');
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
 const p=await browser.newPage(),modal=p.locator('dialog[open]');p.setDefaultTimeout(8000);
 const fill=(name,value)=>modal.locator(`[name="${name}"]`).fill(value);
 const click=(a,k)=>p.locator(`[data-act="${a}"]${k?`[data-key="${k}"]`:''}`).first().click();
 const submit=async()=>{await modal.locator('button[type=submit]').click();await modal.waitFor({state:'hidden'});};
 await p.goto(x.suite.mainUrl);await p.locator('#login [name=username]').fill('pay-staff');await p.locator('#login [name=password]').fill(password);await p.locator('#login button').click();await acceptFixtureBrowser(p);
 await click('nav','Payroll');await click('manual-rule');
 await fill('key','hourly');await fill('name','Synthetic Time Tax');await fill('effective','2027-01-01');await fill('rate','10');await submit();
 await click('manual-draft');await modal.locator('[name=employee]').selectOption(x.employee.id);
 await fill('start','2027-01-01');await fill('end','2027-01-07');await fill('payDate','2027-01-08');await modal.locator('[name=fromApprovedTime]').check();await submit();
 await click('manual-finalize');assert.match(await modal.innerText(),/Approved time imported: 90 minutes across 1 entries/);
 await modal.locator('[name=reviewed]').check();await submit();
 await p.getByRole('button',{name:'Download PDF',exact:true}).waitFor();
 const [download]=await Promise.all([p.waitForEvent('download'),click('manual-stub')]);assert.match(download.suggestedFilename(),/\.pdf$/);
});
