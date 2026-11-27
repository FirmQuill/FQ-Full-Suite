import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {apply} from '../shared/core.mjs';
import {projectErpState} from '../access.mjs';
import {inspectLite} from '../transfer.mjs';
import {activationFixture} from './fixture-activation.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';
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
async function fixture(t,{legacyRuntime}={}){
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
 const activationOptions=legacyRuntime?(await activationFixture(dir,{activate:['manual-payroll']})).options:{};
 const starter=legacyRuntime?(await import(pathToFileURL(join(legacyRuntime,'server.mjs')).href)).createSuite:createSuite;
 let suite=await starter({database,mainPort:0,workerPort:0,activationOptions});
 t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
 return {dir,database,get suite(){return suite;},async restart(){await suite.close();suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions});},c,other,employee,state};
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
 await fill('key','hourly');await fill('name','Synthetic <em>Time Tax</em>');await fill('effective','2027-01-01');
 await modal.locator('[name=method]').selectOption('brackets');await fill('brackets','0,10\n20,15');await fill('annualCap','1000');
 await fill('jurisdiction','Fictional <b>Work Area</b>');await modal.locator('[name=wageBasis]').selectOption('regular');
 await modal.locator('[name=pretaxTreatment]').selectOption('subtract');await modal.locator('[name=rounding]').selectOption('down');
 await submit();
 const ruleRow=p.getByRole('row').filter({hasText:'Synthetic <em>Time Tax</em>'});
 await ruleRow.getByText('$20.00',{exact:true}).waitFor();
 assert.equal(await ruleRow.locator('.money').count(),3);
 assert.equal(await ruleRow.locator('em,b').count(),0);
 assert.match(await ruleRow.innerText(),/Fictional <b>Work Area<\/b>/);
 assert.doesNotMatch(await ruleRow.innerText(),/<span/);
 await click('manual-draft');await modal.locator('[name=employee]').selectOption(x.employee.id);
 await fill('start','2027-01-01');await fill('end','2027-01-07');await fill('payDate','2027-01-08');await modal.locator('[name=fromApprovedTime]').check();await fill('pretaxRegular','1.25');
 await modal.locator('[name=periodKind]').selectOption('partial');await submit();
 await click('manual-finalize');assert.match(await modal.innerText(),/Approved time imported: 90 minutes across 1 entries/);
 assert.match(await modal.innerText(),/Partial period.*Entered pre-tax deductions.*1.25/s);
 assert.match(await modal.innerText(),/Fictional <b>Work Area<\/b>/);
 await modal.locator('[name=reviewed]').check();await submit();
 await p.getByRole('button',{name:'Download PDF',exact:true}).waitFor();
 const [download]=await Promise.all([p.waitForEvent('download'),click('manual-stub')]);assert.match(download.suggestedFilename(),/\.pdf$/);
});

test('independent cap and bracket controls survive finalization, later rule changes and portable export',async t=>{
 const x=await fixture(t),staff=await client(x.suite.mainUrl,'pay-staff'),owner=await client(x.suite.mainUrl,'pay-owner');
 const path='manual-payroll?companyId='+encodeURIComponent(x.c.id);
 let revision=0;
 async function post(body){
  const result=await staff.request(path,{...body,revision});assert.equal(result.status,200,JSON.stringify(result.data));revision=result.data.data.revision;return result.data.data;
 }
 const common={effective:'2027-01-01',wageBasis:'all',pretaxTreatment:'ignore',rounding:'nearest',periodPolicy:'every'};
 const local={...common,type:'rule',key:'city-fiction',name:'Fictional bands',jurisdiction:'Fictional City A',side:'employee',method:'brackets',annualCap:100000,
   brackets:[{start:0,rate:20000},{start:10000,rate:40000}]};
 await post(local);
 await post({...common,type:'rule',key:'another-region',name:'Fictional regional tax',jurisdiction:'Fictional Region B',
   workState:'ZZ',side:'employee',method:'flat',amount:1000});
 await post({...common,type:'rule',key:'employer-fiction',name:'Fictional company-side',jurisdiction:'Fictional County C',side:'employer',method:'percentage',rate:10000});
 await post({type:'opening',employee:x.employee.id,key:'city-fiction',year:'2027',wages:85000});
 const input={employee:x.employee.id,regular:50000,periodKind:'full',pretaxRegular:0,pretaxOther:0};
 await post({...input,type:'draft',id:'fictional-cap-1',start:'2027-01-01',end:'2027-01-07',payDate:'2027-01-08'});
 const first=(await post({type:'finalize',id:'fictional-cap-1',reviewed:true})).runs[0];
 assert.deepEqual([first.employeeTax,first.employerTax,first.net,first.cost],[400,500,49600,50500]);
 assert.deepEqual(first.ruleLines.map(l=>[l.rule.key,l.basis,l.amount]),[['city-fiction',15000,400],['employer-fiction',50000,500]]);
 await post({...input,type:'draft',id:'fictional-cap-2',start:'2027-01-08',end:'2027-01-14',payDate:'2027-01-15'});
 const second=(await post({type:'finalize',id:'fictional-cap-2',reviewed:true})).runs[1];
 assert.deepEqual([second.employeeTax,second.employerTax,second.net,second.cost],[0,500,50000,50500]);
 const revised=await post({...local,effective:'2027-01-16',jurisdiction:'Fictional future label',rounding:'up'});
 assert.deepEqual(revised.runs,[first,second]);
 const encrypted=await owner.request('transfer/export',{password});
 const parsed=await inspectLite(encrypted.data.envelope,password);
 const copied=parsed.state.companies[0].manualPayroll.runs[0];assert.deepEqual(copied.ruleLines,first.ruleLines);
 assert.equal(copied.calculationVersion,2);assert.equal(copied.finalizedBy,'prior authorized payroll operator');
});

const legacyRuntime=process.env.FIRMQUILL_LEGACY_MANUAL_RUNTIME;
test('exact predecessor v1 archived run and worker PDF open unchanged in a restored unlicensed public host',{skip:!legacyRuntime,timeout:45000},async t=>{
 const x=await fixture(t,{legacyRuntime}),old=await client(x.suite.mainUrl,'pay-staff'),formerWorker=await client(x.suite.workerUrl,'pay-worker');
 const route='manual-payroll?companyId='+x.c.id;
 assert.equal((await old.request(route,{type:'rule',revision:0,key:'legacy-tax',name:'Fictional old tax',effective:'2026-12-01',side:'employee',method:'percentage',rate:10000})).status,200);
 assert.equal((await old.request(route,{type:'draft',id:'old-archived-run',revision:1,employee:x.employee.id,start:'2026-12-20',end:'2026-12-26',payDate:'2026-12-27',regular:10000})).status,200);
 const posted=await old.request(route,{type:'finalize',id:'old-archived-run',revision:2,reviewed:true});assert.equal(posted.status,200);
 const oldRun=posted.data.data.runs[0];assert.equal(oldRun.calculationVersion,undefined);
 const stub=(await formerWorker.request('session')).data.records.paystubs.find(p=>p.source==='FirmQuill manual payroll');
 const original=Buffer.from(await (await formerWorker.raw('records/file/'+stub.id)).arrayBuffer());
 assert.equal(original.subarray(0,4).toString(),'%PDF');
 const archive=join(x.dir,'prior-runtime.fqdb'),copy=join(x.dir,'restored-public.sqlite');
 await backupDatabase(x.database,archive,password);await restoreDatabase(archive,copy,password);
 const restored=await createSuite({database:copy,mainPort:0,workerPort:0});
 try{
   const staff=await client(restored.mainUrl,'pay-staff'),worker=await client(restored.workerUrl,'pay-worker'),owner=await client(restored.mainUrl,'pay-owner');
   assert.equal((await owner.request('module-activation')).data.configured,false);
   const current=(await staff.request(route)).data;
   assert.equal(current.canProcess,true);assert.deepEqual(current.data.runs,[oldRun]);
   assert.deepEqual(Buffer.from(await (await worker.raw('records/file/'+stub.id)).arrayBuffer()),original);
   assert.equal((await owner.request('software-update-check',{type:'check'})).status,404);
   assert.equal((await owner.request('agent-admin/action',{type:'grant-directory-policy',companyId:x.c.id,name:'Unavailable in public fixture',recordTypes:['contacts']})).status,400);
   assert.equal((await staff.request(route,{type:'rule',revision:3,key:'new-configured-only',name:'Fictional chosen rule',jurisdiction:'Fixture only',effective:'2027-01-01',side:'employee',method:'flat',amount:200,wageBasis:'regular',pretaxTreatment:'subtract',rounding:'nearest',periodPolicy:'every'})).status,200);
   const d=await staff.request(route,{type:'draft',id:'new-after-recovery',revision:4,employee:x.employee.id,start:'2027-01-02',end:'2027-01-08',payDate:'2027-01-09',regular:10000,pretaxRegular:1200,pretaxOther:0,periodKind:'full'});
   assert.equal(d.status,200,JSON.stringify(d.data));
   assert.deepEqual(d.data.data.runs[0],oldRun);
   const final=await staff.request(route,{type:'finalize',id:'new-after-recovery',revision:5,reviewed:true});
   assert.equal(final.status,200,JSON.stringify(final.data));
   assert.deepEqual(final.data.data.runs[0],oldRun);
   const latest=final.data.data.runs[1];assert.equal(latest.calculationVersion,2);assert.equal(latest.pretaxTotal,1200);
   assert.deepEqual(latest.ruleLines.map(l=>l.rule.key),['legacy-tax','new-configured-only'],'Manual draws no bundled tax rules');
 }finally{await restored.close();}
});
