import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {newVault,apply} from '../shared/core.mjs';
import {initializeRecords,setEmployeeProfile} from '../records.mjs';
import {initializeBenefits,benefitsView,benefitsCommand,benefitFile,effectivePayrollDeductions} from '../benefits.mjs';

const NOW=new Date('2027-11-15T19:00:00Z');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,companyId TEXT,kind TEXT,detail TEXT); CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT,active INTEGER,assignments TEXT,employeeId TEXT,authVersion INTEGER);');
  initializeRecords(db);initializeBenefits(db);
  let state=newVault('Fictional Benefits Works',['employees']);const company=state.companies[0].id;
  for(const name of ['Fictional Warehouse One','Fictional Warehouse Two'])state=apply(state,company,{type:'employee',name,rate:2500,state:'CO',locality:'Fictional City',date:'2027-01-01'});
  state=apply(state,company,{type:'company',name:'Fictional Other Company',activities:[],date:'2027-01-01'});
  const [employee,otherEmployee]=state.companies[0].employees.map(e=>e.id),otherCompany=state.companies[1].id;
  const users={owner:{id:'owner',role:'owner',assignments:[]},hr:{id:'hr',role:'hr',assignments:[company]},otherHR:{id:'other-hr',role:'hr',assignments:[company]},payroll:{id:'payroll',role:'payroll',assignments:[company]},manager:{id:'manager',role:'manager',assignments:[company]},worker:{id:'worker',role:'worker',assignments:[company],employeeId:employee},otherWorker:{id:'other-worker',role:'worker',assignments:[company],employeeId:otherEmployee},foreignHR:{id:'foreign-hr',role:'hr',assignments:[otherCompany]}};
  for(const user of Object.values(users))db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,1)').run(user.id,user.role,1,JSON.stringify(user.assignments),user.employeeId||'');
  for(const person of [employee,otherEmployee])setEmployeeProfile(db,state,company,person,{hireDate:'2027-11-01',groupIds:['warehouse','admin']},'owner');
  const configuration={timezone:'America/Denver',hrOwnerId:'hr',defaultInitial:{opensDays:0,closesDays:20},groups:[{id:'warehouse',name:'Warehouse',priority:10,initial:{opensDays:0,closesDays:30}},{id:'admin',name:'Admin',priority:20,initial:{opensDays:0,closesDays:5}}],planYears:[{id:'2027',label:'2027',startDate:'2027-01-01',endDate:'2027-12-31'},{id:'2028',label:'2028',startDate:'2028-01-01',endDate:'2028-12-31'}],plans:[{id:'medical27',planYear:'2027',name:'Fictional Medical 2027',category:'medical',groupIds:['warehouse'],waiverAllowed:true,tiers:[{id:'self',name:'Employee',employeeCostCents:10000,employerCostCents:50000}]},{id:'medical28',planYear:'2028',name:'Fictional Medical 2028',category:'medical',groupIds:['warehouse'],waiverAllowed:true,tiers:[{id:'self',name:'Employee',employeeCostCents:11000,employerCostCents:55000}]}],openWindows:[{id:'oe28',planYear:'2028',groupId:'warehouse',startDate:'2027-11-01',endDate:'2027-11-30',effectiveDate:'2028-01-01'},{id:'oe-admin',planYear:'2028',groupId:'admin',startDate:'2027-10-01',endDate:'2027-10-05',effectiveDate:'2028-01-01'}],individualOverrides:[],retirementPlans:[{id:'401k',name:'Fictional 401(k)',groupIds:['warehouse'],selfService:true,taxTreatments:['pre-tax','roth'],units:['percent','amount'],control:'firmquill',maxPercent:100,maxAmountCents:500000,schedule:{minimumLeadDays:0,effectiveRule:'requested'}},{id:'provider',name:'Fictional Provider Plan',groupIds:['warehouse'],selfService:true,taxTreatments:['pre-tax'],units:['percent'],control:'provider',schedule:{minimumLeadDays:0,effectiveRule:'next-month'}}]};
  function command(action,user=users.worker,at=NOW){db.exec('BEGIN IMMEDIATE');try{const result=benefitsCommand(db,user,state,action,at);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
  command({type:'benefits-config',companyId:company,version:0,configuration},users.owner);
  const view=(user=users.worker,options={})=>benefitsView(db,user,state,{companyId:company,at:NOW,...options});
  const submit=(row,user=users.worker,extra={})=>command({type:'enrollment-submit',instanceId:row.id,version:row.version,elections:row.plans.map(p=>({planId:p.id,tierId:'self',waived:false})),...extra},user);
  return {db,state,company,employee,otherEmployee,otherCompany,users,configuration,command,view,submit};
}

test('next-year open election submitted first preserves independent initial draft and both receipts',t=>{
  const x=fixture(t),before=x.view(),open=before.instances.find(i=>i.type==='open'),initial=before.instances.find(i=>i.type==='initial');
  assert.equal(open.label,'2028 Open Enrollment');assert.equal(initial.label,'2027 Initial Enrollment');assert.equal(initial.ruleApplied,'Group Warehouse (priority 10)');assert.equal(initial.endDate,'2027-12-01');assert.equal(open.effectiveDate,'2028-01-01');
  const openResult=x.submit(open),afterOpen=x.view();assert.equal(afterOpen.instances.find(i=>i.id===initial.id).status,'draft');
  const initialResult=x.submit(afterOpen.instances.find(i=>i.id===initial.id)),final=x.view();
  assert.equal(final.instances.length,2);assert.equal(final.instances.filter(i=>i.status==='submitted').length,2);assert.notEqual(openResult.receipt,initialResult.receipt);assert.equal(final.conflicts.length,0);assert.equal(final.instances.find(i=>i.id===open.id).receipt,openResult.receipt);
  assert.throws(()=>x.submit(open),/changed/);assert.throws(()=>x.submit(final.instances[0]),/immutable/);
});

test('initial-first and independent waivers do not close open enrollment',t=>{
  const x=fixture(t),initial=x.view().instances.find(i=>i.type==='initial');
  x.command({type:'enrollment-submit',instanceId:initial.id,version:initial.version,elections:[{planId:'medical27',waived:true}]});
  const open=x.view().instances.find(i=>i.type==='open');assert.equal(open.status,'draft');x.submit(open);
  assert.equal(x.view().instances.find(i=>i.id===initial.id).elections[0].waived,true);
});

test('individual override precedes group and company policy; ties require explicit priorities',t=>{
  const x=fixture(t),configuration=structuredClone(x.configuration);configuration.individualOverrides=[{employeeId:x.employee,planYear:'2027',startDate:'2027-11-10',endDate:'2027-11-20',effectiveDate:'2027-11-01'}];
  x.command({type:'benefits-config',companyId:x.company,version:1,configuration},x.users.hr);
  const initial=x.view().instances.find(i=>i.type==='initial');assert.equal(initial.ruleApplied,'Individual override');assert.equal(initial.endDate,'2027-11-20');
  configuration.groups[1].priority=10;assert.throws(()=>x.command({type:'benefits-config',companyId:x.company,version:2,configuration},x.users.hr),/unique priority/);
});

test('election deadline uses company calendar, separate from coverage effective date',t=>{
  const x=fixture(t),open=x.view().instances.find(i=>i.type==='open');
  x.command({type:'enrollment-save',instanceId:open.id,version:open.version,elections:[{planId:'medical28',tierId:'self'}]},x.users.worker,new Date('2027-12-01T06:59:00Z'));
  const fresh=x.view().instances.find(i=>i.id===open.id);
  assert.throws(()=>x.command({type:'enrollment-submit',instanceId:fresh.id,version:fresh.version,elections:[{planId:'medical28',tierId:'self'}]},x.users.worker,new Date('2027-12-01T07:00:00Z')),/outside its election window/);
  assert.equal(x.view().instances.find(i=>i.id===open.id).effectiveDate,'2028-01-01');
});

test('special enrollment reaches designated HR queue, protects evidence, and requires human decision',t=>{
  const x=fixture(t),proof=Buffer.from('Fictional supporting evidence').toString('base64'),created=x.command({type:'special-request',event:'Fictional household change',eventDate:'2027-11-10',requestedChange:'Please review eligible options',attachments:[{name:'fictional-proof.txt',mime:'text/plain',data:proof}]});
  assert.ok(created.receipt);let row=x.view().cases[0];assert.equal(row.status,'received');assert.equal(row.ownerId,'hr');assert.equal(x.view(x.users.hr).cases.length,1);assert.equal(x.view(x.users.otherHR).cases.length,0);assert.equal(x.view(x.users.payroll).cases.length,0);
  const fileId=row.attachments[0].id;assert.equal(benefitFile(x.db,x.users.worker,x.state,fileId).bytes.toString(),'Fictional supporting evidence');
  for(const user of [x.users.otherWorker,x.users.otherHR,x.users.manager,x.users.payroll,x.users.foreignHR])assert.throws(()=>benefitFile(x.db,user,x.state,fileId),/unavailable|denied/);
  assert.throws(()=>x.command({type:'special-review',caseId:row.id,version:row.version,status:'approved',reason:'Unassigned staff attempt',planYear:'2027',deadline:'2027-12-01',effectiveDate:'2027-11-01'},x.users.otherHR),/unavailable/);
  x.command({type:'special-review',caseId:row.id,version:row.version,status:'information_requested',reason:'Please provide a fictional supporting detail'},x.users.hr);
  row=x.view().cases[0];x.command({type:'special-update',caseId:row.id,version:row.version,message:'Here is the requested detail',attachments:[]});row=x.view().cases[0];
  x.command({type:'special-review',caseId:row.id,version:row.version,status:'approved',reason:'Human reviewed applicable plan and rules',planYear:'2027',deadline:'2027-12-01',effectiveDate:'2027-11-15'},x.users.hr);
  const decided=x.view();assert.equal(decided.cases[0].status,'approved');assert.equal(decided.instances.filter(i=>i.type==='special').length,1);assert.equal(decided.instances.find(i=>i.type==='special').status,'draft');
});

test('overlapping coverage goes to HR conflict review and never silently overwrites',t=>{
  const x=fixture(t),initial=x.view().instances.find(i=>i.type==='initial');x.submit(initial);
  const created=x.command({type:'special-request',event:'Fictional event',eventDate:'2027-11-10',requestedChange:'Review requested'}),row=x.view().cases.find(c=>c.id===created.id);
  x.command({type:'special-review',caseId:row.id,version:row.version,status:'approved',reason:'Reviewed manually',planYear:'2027',deadline:'2027-12-01',effectiveDate:'2027-11-15'},x.users.hr);
  x.submit(x.view().instances.find(i=>i.type==='special'));let special=x.view().instances.find(i=>i.type==='special');
  assert.equal(special.status,'conflict');assert.equal(x.view().instances.find(i=>i.id===initial.id).status,'submitted');
  assert.throws(()=>x.command({type:'enrollment-review',instanceId:special.id,version:special.version,decision:'confirm',reason:'Reviewed'},x.users.hr),/conflict/);
  x.command({type:'enrollment-review',instanceId:special.id,version:special.version,decision:'confirm',resolveConflict:true,reason:'Explicitly replacing the earlier election after review'},x.users.hr);
  assert.equal(x.view().instances.find(i=>i.id===initial.id).status,'superseded');assert.equal(x.view().instances.find(i=>i.id===special.id).status,'confirmed');
});

test('retirement operates outside health windows with pending receipt, payroll confirmation and effective instructions',t=>{
  const x=fixture(t);x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:6,effectiveDate:'2027-12-01'},x.users.worker,new Date('2027-12-01T19:00:00Z'));
  let row=x.view().retirementChanges[0];assert.equal(row.status,'pending');assert.ok(row.receipt);assert.equal(x.view(x.users.payroll).deductions.length,0);
  x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'confirm',reason:'Payroll reviewed and accepted'},x.users.payroll);
  row=x.view().retirementChanges[0];assert.equal(row.displayStatus,'future');assert.equal(x.view(x.users.payroll).deductions.length,1);
  assert.equal(effectivePayrollDeductions(x.db,x.users.payroll,x.state,x.company,'2027-11-30').length,0);assert.equal(effectivePayrollDeductions(x.db,x.users.payroll,x.state,x.company,'2027-12-01')[0].value,6);
  assert.throws(()=>effectivePayrollDeductions(x.db,x.users.manager,x.state,x.company,'2027-12-01'),/Payroll access/);
});

test('provider handoff stays pending until explicit confirmation and never creates internal deduction',t=>{
  const x=fixture(t),created=x.command({type:'retirement-change',planId:'provider',taxTreatment:'pre-tax',unit:'percent',value:4,effectiveDate:'2027-12-01'});let row=x.view().retirementChanges.find(r=>r.id===created.id);
  const exported=x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'export',reason:'Prepared HR handoff'},x.users.payroll);assert.match(Buffer.from(exported.export.data,'base64').toString(),/request_id,employee_id/);
  row=x.view().retirementChanges[0];assert.equal(row.status,'exported');assert.equal(x.view(x.users.payroll).deductions.length,0);
  x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'confirm',reason:'Provider confirmed the setting with reference TEST-123'},x.users.payroll);
  assert.equal(x.view().retirementChanges[0].status,'confirmed');assert.equal(x.view(x.users.payroll).deductions.length,0);
});

test('retirement limits and dates are plan-specific and closed payroll cannot change',t=>{
  const x=fixture(t);assert.throws(()=>x.command({type:'retirement-change',planId:'401k',taxTreatment:'invalid',unit:'percent',value:5,effectiveDate:'2027-12-01'}),/permitted/);assert.throws(()=>x.command({type:'retirement-change',planId:'provider',taxTreatment:'pre-tax',unit:'percent',value:5,effectiveDate:'2027-11-16'}),/first of a future month/);
  x.state.companies[0].closedThrough='2027-12-31';assert.throws(()=>x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:6,effectiveDate:'2027-12-01'}),/closed payroll/);assert.equal(x.view().retirementChanges.length,0);
});

test('every benefit action denies other employee and company, manager and bookkeeper access',t=>{
  const x=fixture(t),row=x.view().instances[0];
  assert.throws(()=>x.submit(row,x.users.otherWorker),/unavailable/);assert.throws(()=>x.submit(row,x.users.foreignHR),/denied/);assert.throws(()=>x.view(x.users.manager),/denied/);assert.throws(()=>x.view({id:'books',role:'bookkeeper',assignments:[x.company]}),/denied/);
  assert.equal(x.view(x.users.otherWorker).instances.some(i=>i.employeeId===x.employee),false);assert.throws(()=>x.command({type:'benefits-config',companyId:x.company,version:1,configuration:x.configuration},x.users.payroll),/HR configuration/);assert.throws(()=>x.view(x.users.hr,{companyId:x.otherCompany}),/denied/);
});

test('eligibility transfers do not delete history and block stale drafts',t=>{
  const x=fixture(t),row=x.view().instances[0];setEmployeeProfile(x.db,x.state,x.company,x.employee,{groupIds:['admin']},'owner');
  assert.throws(()=>x.submit(row),/eligibility changed/);assert.equal(x.view().instances.some(i=>i.id===row.id),true);setEmployeeProfile(x.db,x.state,x.company,x.employee,{employmentStatus:'terminated'},'owner');assert.throws(()=>x.view(),/disabled/);
});

test('idempotent migrations preserve configuration, submitted elections and case evidence',t=>{
  const x=fixture(t),initial=x.view().instances[0],result=x.submit(initial);initializeBenefits(x.db);initializeRecords(x.db);
  assert.equal(x.view().instances.find(i=>i.id===initial.id).receipt,result.receipt);assert.equal(x.view(x.users.hr).configuration.version,1);assert.equal(x.db.prepare("SELECT count(*) AS n FROM employee_feature_migrations WHERE name='benefits-v1'").get().n,1);
});

test('company scope is checked even if two companies use the same employee identifier',t=>{
  const x=fixture(t),created=x.command({type:'special-request',event:'Fictional private event',eventDate:'2027-11-10',requestedChange:'Private company request',attachments:[{name:'private.txt',mime:'text/plain',data:Buffer.from('Fictional private evidence').toString('base64')}]});
  const row=x.view().cases.find(c=>c.id===created.id);x.state.companies[1].employees.push({...x.state.companies[0].employees[0]});
  const foreignWorker={...x.users.worker,id:'foreign-worker',assignments:[x.otherCompany]};assert.throws(()=>benefitFile(x.db,foreignWorker,x.state,row.attachments[0].id),/unavailable/);assert.throws(()=>x.command({type:'special-update',caseId:row.id,version:row.version,message:'Wrong company'},foreignWorker),/unavailable/);
});

test('employer override changes refresh a draft while submitted history retains its rule',t=>{
  const x=fixture(t),initial=x.view().instances.find(i=>i.type==='initial'),open=x.view().instances.find(i=>i.type==='open');x.submit(open);
  const configuration=structuredClone(x.configuration);configuration.individualOverrides=[{employeeId:x.employee,planYear:'2027',startDate:'2027-11-05',endDate:'2027-11-25',effectiveDate:'2027-11-01'}];configuration.openWindows[0].endDate='2027-11-20';x.command({type:'benefits-config',companyId:x.company,version:1,configuration},x.users.hr);
  const updated=x.view();assert.equal(updated.instances.find(i=>i.id===initial.id).ruleApplied,'Individual override');assert.equal(updated.instances.find(i=>i.id===initial.id).endDate,'2027-11-25');assert.equal(updated.instances.find(i=>i.id===open.id).endDate,'2027-11-30');assert.throws(()=>x.submit(initial),/changed/);
});

test('future retirement election does not replace current until its date and prior history stays immutable',t=>{
  const x=fixture(t);
  const first=x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:4,effectiveDate:'2027-11-15'});let row=x.view().retirementChanges.find(r=>r.id===first.id);x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'confirm',reason:'First payroll instruction accepted'},x.users.payroll);
  const firstHistory=JSON.stringify(x.view().retirementChanges.find(r=>r.id===first.id).history);
  const second=x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:6,effectiveDate:'2027-12-01'});row=x.view().retirementChanges.find(r=>r.id===second.id);x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'confirm',reason:'Future payroll instruction accepted'},x.users.payroll);
  const before=x.view().retirementChanges;assert.equal(before.find(r=>r.id===first.id).displayStatus,'current');assert.equal(before.find(r=>r.id===second.id).displayStatus,'future');assert.equal(effectivePayrollDeductions(x.db,x.users.payroll,x.state,x.company,'2027-11-30')[0].value,4);
  const after=x.view(x.users.worker,{at:new Date('2027-12-01T19:00:00Z')}).retirementChanges;assert.equal(after.find(r=>r.id===first.id).displayStatus,'historical');assert.equal(after.find(r=>r.id===second.id).displayStatus,'current');assert.equal(after.find(r=>r.id===first.id).status,'confirmed');assert.equal(JSON.stringify(after.find(r=>r.id===first.id).history),firstHistory);assert.equal(effectivePayrollDeductions(x.db,x.users.payroll,x.state,x.company,'2027-12-01')[0].value,6);
  const roth=x.command({type:'retirement-change',planId:'401k',taxTreatment:'roth',unit:'percent',value:2,effectiveDate:'2027-11-15'});row=x.view().retirementChanges.find(r=>r.id===roth.id);x.command({type:'retirement-review',changeId:row.id,version:row.version,decision:'confirm',reason:'Independent Roth instruction accepted'},x.users.payroll);assert.equal(x.view().retirementChanges.filter(r=>r.displayStatus==='current').length,2);assert.equal(effectivePayrollDeductions(x.db,x.users.payroll,x.state,x.company,'2027-12-01').length,2);
});

test('permitted fractional percentages retain precision and excess precision is rejected',t=>{
  const x=fixture(t),created=x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:6.5,effectiveDate:'2027-12-01'});assert.equal(x.view().retirementChanges.find(r=>r.id===created.id).value,6.5);assert.throws(()=>x.command({type:'retirement-change',planId:'401k',taxTreatment:'pre-tax',unit:'percent',value:6.555,effectiveDate:'2027-12-01'}),/two decimal/);
});
