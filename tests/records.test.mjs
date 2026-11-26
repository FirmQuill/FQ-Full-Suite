import {initializeAccess} from '../access.mjs';
import {initializeDepartments} from '../departments.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {newVault,apply} from '../shared/core.mjs';
import {initializeWorker,workerCommand,workerView} from '../worker.mjs';
import {initializeRecords,employeeProfile,setEmployeeProfile,recordsView,recordsCommand,recordFile} from '../records.mjs';

const PDF=Buffer.from('%PDF-1.4\n% Fictional test fixture, not a real payroll document\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,name TEXT,role TEXT,assignments TEXT,employeeId TEXT,active INTEGER,hash TEXT,authVersion INTEGER);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,companyId TEXT,kind TEXT,detail TEXT);`);
  initializeWorker(db);initializeRecords(db);
  let state=newVault('Fictional Cedar Company',['time','employees']);const company=state.companies[0].id;
  for(const name of ['Fictional Worker A','Fictional Worker B','Fictional Manager'])state=apply(state,company,{type:'employee',name,rate:2500,state:'CO',locality:'Fictional city',date:'2026-01-01'});
  state=apply(state,company,{type:'job',name:'Fictional warehouse',date:'2026-01-01'});
  state=apply(state,company,{type:'company',name:'Other fictional company',activities:['employees'],date:'2026-01-01'});
  const other=state.companies[1].id;state=apply(state,other,{type:'employee',name:'Fictional Elsewhere',rate:3000,state:'CO',locality:'Fictional city',date:'2026-01-01'});
  const [employee,second,supervisor]=state.companies[0].employees.map(e=>e.id),otherEmployee=state.companies[1].employees[0].id;
  const owner={id:'owner',role:'owner',assignments:[],employeeId:''},hr={id:'hr',role:'hr',assignments:[company],employeeId:''},payroll={id:'payroll',role:'payroll',assignments:[company],employeeId:''},manager={id:'manager',role:'manager',assignments:[company],employeeId:''},unassigned={id:'unassigned',role:'manager',assignments:[company],employeeId:''},worker={id:'worker',role:'worker',assignments:[company],employeeId:employee},worker2={id:'worker2',role:'worker',assignments:[company],employeeId:second};
  for(const u of [owner,hr,payroll,manager,unassigned,worker,worker2])db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)').run(u.id,u.id,u.id,u.role,JSON.stringify(u.assignments),u.employeeId,1,'not-a-real-hash',1);
  initializeAccess(db);initializeDepartments(db,state);
  const act=(user,action)=>recordsCommand(db,user,state,{companyId:company,employeeId:employee,...action});
  const view=(user=worker,query={})=>recordsView(db,user,state,query);
  const profile=(id=employee)=>employeeProfile(db,state,company,id);
  const set=(patch,id=employee)=>setEmployeeProfile(db,state,company,id,patch,owner.id);
  return {db,state,company,other,employee,second,supervisor,otherEmployee,owner,hr,payroll,manager,unassigned,worker,worker2,act,view,profile,set};
}

test('idempotent records migration preserves employees, accounts and existing time',t=>{
  const x=fixture(t),original=structuredClone(x.state);
  workerCommand(x.db,x.worker,x.state,{type:'clock-in',jobId:x.state.companies[0].jobs[0].id},new Date('2026-01-02T10:00:00Z'));
  workerCommand(x.db,x.worker,x.state,{type:'clock-out',shiftId:workerView(x.db,x.worker,x.state).openShift.id},new Date('2026-01-02T11:00:00Z'));
  initializeRecords(x.db);initializeRecords(x.db);
  assert.deepEqual(x.state,original);assert.equal(x.db.prepare('SELECT count(*) n FROM accounts').get().n,7);
  assert.equal(workerView(x.db,x.worker,x.state).shifts.length,1);
  assert.equal(x.profile().version,0);assert.equal(x.profile().employmentStatus,'active');
  assert.equal(x.view().employees.length,1);assert.equal(x.view().employee.employeeId,x.employee);
  assert.equal(x.db.prepare('SELECT count(*) n FROM employee_record_migrations').get().n,1);
});

test('field rules allow own edits and corrections while preserving effective history',t=>{
  const x=fixture(t);
  setEmployeeProfile(x.db,x.state,x.company,x.employee,{hireDate:'2026-01-01',department:'Warehouse',title:'Associate',managerAccountId:x.manager.id,personalEmail:'private@example.invalid',groupIds:['warehouse']},x.owner.id,{effectiveDate:'2026-01-01'});
  const updated=x.act(x.worker,{type:'profile-update',version:x.profile().version,patch:{education:['Fictional school'],certifications:[{name:'Fictional lift training',issued:'2026-01-01',expires:'2027-01-01'}]}});
  assert.equal(updated.profile.education[0],'Fictional school');assert.equal(updated.profile.history.length,1);
  assert.throws(()=>x.act(x.worker,{type:'profile-update',version:x.profile().version,patch:{title:'Executive'}}),/requires HR correction/);
  assert.throws(()=>x.act(x.worker,{type:'profile-update',version:0,patch:{personalPhone:'555-0100'}}),/changed/);
  const correction=x.act(x.worker,{type:'profile-correction',field:'title',value:'Warehouse lead',reason:'Assigned a new role'});
  assert.equal(x.view().corrections[0].status,'pending');
  assert.throws(()=>x.act(x.manager,{type:'correction-decide',correctionId:correction.correctionId,decision:'approve',reason:'Agreed'}),/unavailable/);
  x.act(x.hr,{type:'correction-decide',correctionId:correction.correctionId,decision:'approve',reason:'Assignment verified',effectiveDate:'2026-02-01'});
  assert.equal(x.profile().title,'Warehouse lead');assert.equal(x.profile().history.at(-1).effectiveDate,'2026-02-01');assert.equal(x.view().corrections[0].status,'approved');
  assert.throws(()=>x.act(x.hr,{type:'correction-decide',correctionId:correction.correctionId,decision:'approve',reason:'Again'}),/already decided/);
  const managed=x.view(x.manager).employee;assert.equal(managed.employeeId,x.employee);assert.ok(!Object.hasOwn(managed.profile,'personalEmail'));assert.ok(!Object.hasOwn(managed.profile,'groupIds'));
  assert.equal(x.view(x.unassigned).employees.length,0);
  assert.equal(x.view(x.payroll).employee,null);assert.equal(x.view(x.payroll).reviews.length,0);
  assert.throws(()=>x.act(x.worker,{type:'profile-update',employeeId:x.second,version:0,patch:{personalPhone:'555-0100'}}),/unavailable/);
  assert.throws(()=>x.view(x.worker,{companyId:x.other,employeeId:x.otherEmployee}),/unavailable/);
  assert.throws(()=>x.set({managerAccountId:x.worker2.id}),/active assigned manager/);
  assert.throws(()=>x.set({projectAssignments:[{jobId:'other-company-job',start:'2026-02-01'}]}),/project in this company/);
});

test('draft reviews stay private and published review acknowledgements never change content',t=>{
  const x=fixture(t);x.set({managerAccountId:x.manager.id});
  const draft=x.act(x.manager,{type:'review-save',title:'Fictional annual review',body:'Completed warehouse training.'});
  assert.equal(x.view().reviews.length,0);assert.equal(x.view(x.worker2).reviews.length,0);
  assert.equal(x.view(x.hr).reviews.length,0,'another HR staff member cannot read a manager private draft');
  assert.throws(()=>x.act(x.hr,{type:'review-save',reviewId:draft.reviewId,version:1,title:'Another author',body:'Attempted edit'}),/unavailable/);
  assert.throws(()=>x.act(x.hr,{type:'review-publish',reviewId:draft.reviewId,version:1}),/unavailable/);
  assert.equal(x.view(x.unassigned).reviews.length,0);assert.equal(x.view(x.manager).reviews[0].status,'draft');
  assert.throws(()=>x.act(x.unassigned,{type:'review-save',title:'No assignment',body:'No assignment'}),/Assigned manager or HR/);
  assert.throws(()=>x.act(x.worker,{type:'review-publish',reviewId:draft.reviewId,version:1}),/unavailable/);
  x.act(x.manager,{type:'review-publish',reviewId:draft.reviewId,version:1});
  const published=x.view().reviews[0];assert.equal(published.publisher,x.manager.id);assert.ok(published.published);
  assert.throws(()=>x.act(x.hr,{type:'review-save',reviewId:draft.reviewId,version:published.version,title:'Replace',body:'Replace'}),/immutable/);
  assert.throws(()=>x.act(x.worker2,{type:'review-acknowledge',reviewId:draft.reviewId}),/unavailable/);
  x.act(x.worker,{type:'review-acknowledge',reviewId:draft.reviewId});
  const ack=x.view().reviews[0];assert.ok(ack.acknowledged);assert.equal(ack.body,published.body);assert.equal(ack.publisher,published.publisher);assert.equal(ack.published,published.published);
  assert.throws(()=>x.act(x.worker,{type:'review-acknowledge',reviewId:draft.reviewId}),/already acknowledged/);
  assert.equal(x.view(x.payroll).reviews.length,0);
});

test('future dated job and group changes stay scheduled and manager history excludes benefit groups',t=>{
  const x=fixture(t);
  x.set({title:'Current title',managerAccountId:x.manager.id,groupIds:['warehouse']});
  setEmployeeProfile(x.db,x.state,x.company,x.employee,{title:'Future title',groupIds:['future-benefit-group'],employmentStatus:'terminated'},x.owner.id,{effectiveDate:'2099-01-01',reason:'Fictional scheduled transfer'});
  assert.equal(x.profile().title,'Current title');assert.deepEqual(x.profile().groupIds,['warehouse']);assert.equal(x.profile().employmentStatus,'active');
  assert.equal(x.db.prepare('SELECT active FROM accounts WHERE id=?').get(x.worker.id).active,1);
  const managed=x.view(x.manager).employee.profile;
  assert.ok(managed.history.some(h=>h.effectiveDate==='2099-01-01'));
  assert.ok(!JSON.stringify(managed).includes('future-benefit-group'));assert.ok(!JSON.stringify(managed).includes('groupIds'));
  setEmployeeProfile(x.db,x.state,x.company,x.employee,{employmentStatus:'inactive'},x.owner.id,{effectiveDate:'2026-01-01',reason:'Fictional historical separation'});
  setEmployeeProfile(x.db,x.state,x.company,x.employee,{employmentStatus:'active'},x.owner.id,{effectiveDate:'2026-02-01',reason:'Fictional rehire'});
  x.db.prepare('UPDATE accounts SET active=1 WHERE id=?').run(x.worker.id);
  setEmployeeProfile(x.db,x.state,x.company,x.employee,{employmentStatus:'terminated'},x.owner.id,{effectiveDate:'2026-01-15',reason:'Fictional historical correction before rehire'});
  assert.equal(x.profile().employmentStatus,'active');assert.equal(x.db.prepare('SELECT active FROM accounts WHERE id=?').get(x.worker.id).active,1,'backdating a former separation cannot disable the later effective rehire');
});

test('only payroll or owner can publish real finalized stub files and all downloads are scoped',t=>{
  const x=fixture(t);x.set({managerAccountId:x.manager.id});
  const action={type:'paystub-import',periodStart:'2026-01-01',periodEnd:'2026-01-15',payDate:'2026-01-20',source:'Fictional test payroll export',filename:'stub.pdf',data:PDF.toString('base64'),finalized:true};
  assert.throws(()=>x.act(x.manager,action),/Payroll publishing/);assert.throws(()=>x.act(x.hr,action),/Payroll publishing/);
  assert.throws(()=>x.act(x.payroll,{...action,finalized:false}),/finalized/);
  assert.throws(()=>x.act(x.payroll,{...action,data:Buffer.from('not a PDF').toString('base64')}),/valid finalized PDF/);
  const {paystubId}=x.act(x.payroll,action),own=x.view();
  assert.equal(own.paystubs[0].id,paystubId);assert.equal(own.paystubs[0].status,'finalized');assert.ok(!Object.hasOwn(own.paystubs[0],'content'));assert.ok(!Object.hasOwn(own.paystubs[0],'earnings'));
  assert.deepEqual(recordFile(x.db,x.worker,x.state,paystubId).bytes,PDF);
  assert.deepEqual(recordFile(x.db,x.payroll,x.state,paystubId).bytes,PDF);
  for(const user of [x.worker2,x.manager,x.hr,{...x.payroll,assignments:[x.other]}])assert.throws(()=>recordFile(x.db,user,x.state,paystubId),/unavailable/);
  assert.equal(x.view(x.manager).paystubs.length,0);assert.equal(x.view(x.hr).paystubs.length,0);
  const detail=x.db.prepare("SELECT detail FROM audit WHERE kind='paystub downloaded'").all().map(r=>r.detail).join('');assert.equal(detail,paystubId.repeat(2));
});

test('business contacts use employee, location and company fallbacks; deactivation revokes sessions',t=>{
  const x=fixture(t),contacts=[{id:'hr-company',name:'Fictional Company HR',email:'hr@example.invalid',phone:'555-0101'},{id:'hr-warehouse',name:'Fictional Warehouse HR',email:'warehouse@example.invalid',phone:'555-0102'},{id:'payroll-company',name:'Fictional Payroll',email:'payroll@example.invalid',phone:'555-0103'}];
  x.act(x.hr,{type:'company-record-settings',settings:{contacts,hrContactId:'hr-company',payrollContactId:'payroll-company',locations:{Warehouse:{hrContactId:'hr-warehouse'}}}});
  x.set({location:'Warehouse',managerEmployeeId:x.supervisor});x.set({workEmail:'manager@example.invalid',businessPhone:'555-0104',title:'Fictional supervisor'},x.supervisor);
  assert.equal(x.view().contacts.hr.id,'hr-warehouse');assert.equal(x.view().contacts.payroll.id,'payroll-company');assert.equal(x.view().contacts.manager.email,'manager@example.invalid');
  x.set({hrContactId:'hr-company'});assert.equal(x.view().contacts.hr.id,'hr-company');
  x.act(x.hr,{type:'company-record-settings',settings:{contacts:contacts.filter(c=>c.id!=='hr-company'),hrContactId:'hr-warehouse',payrollContactId:'payroll-company',locations:{Warehouse:{hrContactId:'hr-warehouse'}}}});
  assert.equal(x.view().contacts.hr.id,'hr-warehouse','a removed employee contact falls back to the configured location');
  x.db.prepare('UPDATE accounts SET employeeId=? WHERE id=?').run(x.supervisor,x.manager.id);x.set({managerEmployeeId:'',managerAccountId:x.manager.id});
  assert.equal(x.view().contacts.manager.email,'manager@example.invalid','assigned manager account reuses its linked business contact profile');
  assert.throws(()=>x.act(x.hr,{type:'company-record-settings',settings:{contacts,fieldRules:{groupIds:'edit'}}}),/Invalid profile field rule/);
  x.set({employmentStatus:'terminated'});const account=x.db.prepare('SELECT active,authVersion FROM accounts WHERE id=?').get(x.worker.id);assert.equal(account.active,0);assert.equal(account.authVersion,2);
  assert.equal(x.profile().history.at(-1).changes.employmentStatus.after,'terminated');assert.equal(x.db.prepare('SELECT count(*) n FROM accounts').get().n,7);
});
