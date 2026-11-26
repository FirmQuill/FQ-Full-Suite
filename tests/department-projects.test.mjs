import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,saveBooks,putUser,safeUser,readBooks,tx} from '../store.mjs';
import {newVault,apply,jobSummary,validateState} from '../shared/core.mjs';
import {projectErpState,saveAreas} from '../access.mjs';
import {initializeDepartments,departmentView,departmentCommand,departmentPermissions} from '../departments.mjs';
import {initializeProjects,projectView,projectCommand,projectBusinessState,visibleProjectJobs,authorizeProjectAction} from '../project-workspace.mjs';
import {setEmployeeProfile,recordsView} from '../records.mjs';

function fixture(t,{filename=':memory:'}={}){
  const db=openStore(filename);t.after(()=>db.close());let state=newVault('Harborline Fictional Supply',['jobs','employees']);const companyId=state.companies[0].id;
  state=apply(state,companyId,{type:'employee',date:'2026-01-01',name:'Fictional No Platform Access',rate:2400,state:'WA',locality:'Fictional'});
  state=apply(state,companyId,{type:'job',date:'2026-01-01',name:'Harborline existing public work'});saveBooks(db,state);
  const account=(username,role)=>{const id=putUser(db,null,{username,name:username,role,assignments:role==='owner'?[]:[companyId]},'!pending-invite:fixture',{bootstrap:true});return safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));};
  const owner=account('fictional-owner','owner'),hr1=account('fictional-hr-one','hr'),hr2=account('fictional-hr-two','hr'),legal=account('fictional-legal','manager'),finance=account('fictional-finance','bookkeeper');
  initializeDepartments(db,state);initializeProjects(db);
  const current=()=>readBooks(db).state;
  const dep=(u,a)=>tx(db,()=>departmentCommand(db,u,current(),{companyId,...a}));
  const act=(u,a)=>tx(db,()=>{const r=projectCommand(db,u,current(),{companyId,...a});if(r.state)saveBooks(db,r.state);return r.result;});
  for(const u of [hr1,hr2])dep(owner,{type:'department-grant',departmentId:'hr',accountId:u.id,rights:['view','manage','assign','hr']});
  dep(owner,{type:'department-grant',departmentId:'legal',accountId:legal.id,rights:['view','manage','assign']});dep(owner,{type:'department-grant',departmentId:'finance',accountId:finance.id,rights:['view','manage','assign','finance']});
  const worker=safeUser(db.prepare("SELECT * FROM accounts WHERE role='worker'").get());
  return {db,companyId,employeeId:state.companies[0].employees[0].id,owner,hr1,hr2,legal,finance,worker,act,dep,current};
}

test('department defaults preserve legacy books; custom departments and multiple memberships are persisted with revocation',t=>{
  const x=fixture(t),before=JSON.stringify(x.current());assert.equal(departmentView(x.db,x.owner,x.current(),{companyId:x.companyId}).workspaces.length,4);assert.equal(JSON.stringify(x.current()),before);
  const {departmentId}=x.dep(x.owner,{type:'department-save',name:'Harborline Safety',kind:'Custom',widgets:['records','tasks']});x.dep(x.owner,{type:'department-grant',departmentId,accountId:x.legal.id,rights:['view']});
  assert.deepEqual(departmentView(x.db,x.legal,x.current(),{companyId:x.companyId}).workspaces.map(d=>d.name).sort(),['Harborline Safety','Legal']);
  x.dep(x.owner,{type:'department-grant',departmentId:'legal',accountId:x.legal.id,rights:[]});initializeDepartments(x.db,x.current());assert.deepEqual(departmentPermissions(x.db,x.legal,x.companyId,'legal'),[]);
  assert.throws(()=>x.dep(x.hr1,{type:'department-save',name:'Unauthorized',widgets:[]}),/Owner access/);
  assert.throws(()=>x.dep(x.owner,{type:'department-grant',departmentId,accountId:x.worker.id,rights:['view']}),/active authorized/);
});

test('two HR staff own separate onboarding and termination tasks; task ownership does not grant access',t=>{
  const x=fixture(t);const {projectId}=x.act(x.owner,{type:'project-save',name:'Harborline confidential staffing',departmentId:'hr',visibility:'department'});
  const first=x.act(x.hr1,{type:'project-task-save',projectId,title:'Fictional onboarding',kind:'onboarding',ownerId:x.hr1.id,departmentId:'hr'});
  const second=x.act(x.hr2,{type:'project-task-save',projectId,title:'Fictional termination',kind:'termination',ownerId:x.hr2.id,departmentId:'hr'});
  const p=projectView(x.db,x.hr1,x.current(),{companyId:x.companyId}).projects.find(p=>p.id===projectId);assert.equal(p.tasks.find(t=>t.id===first.taskId).ownerId,x.hr1.id);assert.equal(p.tasks.find(t=>t.id===second.taskId).ownerId,x.hr2.id);
  x.dep(x.owner,{type:'department-grant',departmentId:'hr',accountId:x.hr2.id,rights:[]});assert.ok(!projectView(x.db,x.hr2,x.current(),{companyId:x.companyId}).projects.some(p=>p.id===projectId));
  assert.throws(()=>x.act(x.hr1,{type:'project-task-save',projectId,title:'Bad owner',kind:'onboarding',departmentId:'hr',ownerId:x.legal.id}),/active authorized/);
});

test('worker staffing without platform visibility preserves approved time and job costing; explicit readers can see project',t=>{
  const x=fixture(t);const {projectId}=x.act(x.owner,{type:'project-save',name:'Harborline restricted acquisition',departmentId:'legal',visibility:'restricted',readers:[x.legal.id]});
  x.act(x.legal,{type:'project-staff',projectId,employeeId:x.employeeId,start:'2026-01-01',role:'Fictional warehouse labor'});
  assert.ok(!visibleProjectJobs(x.db,x.worker,x.current().companies[0]).some(j=>j.id===projectId));assert.ok(projectView(x.db,x.legal,x.current(),{companyId:x.companyId}).projects.some(p=>p.id===projectId));
  assert.throws(()=>authorizeProjectAction(x.db,x.worker,x.current(),x.companyId,{type:'time',job:projectId}),/Project access denied/);
  let state=apply(x.current(),x.companyId,{type:'time',date:'2026-01-02',job:projectId,employee:x.employeeId,minutes:90});const time=state.companies[0].time.at(-1);state=apply(state,x.companyId,{type:'approve time',date:'2026-01-02',time:time.id});saveBooks(x.db,state);
  assert.equal(jobSummary(x.current().companies[0],projectId).labor,3600);const p=projectView(x.db,x.owner,x.current(),{companyId:x.companyId}).projects.find(p=>p.id===projectId);assert.equal(p.cost.labor,3600);assert.equal(p.timeMinutes,90);assert.equal(p.staffing[0].employeeId,x.employeeId);
  const approval=x.current().companies[0].time.find(t=>t.id===time.id).approval;
  assert.throws(()=>authorizeProjectAction(x.db,x.finance,x.current(),x.companyId,{type:'attachment',source:approval}),/Project access denied/,'approval event ownership follows its hidden time entry');
  assert.ok(!projectBusinessState(x.db,x.finance,x.current()).companies[0].history.some(h=>h.id===approval));
  const legalProj=projectView(x.db,x.legal,x.current(),{companyId:x.companyId}).projects.find(p=>p.id===projectId);assert.equal(legalProj.cost,undefined,'project access does not grant payroll cost access');
  const update=x.act(x.owner,{type:'project-save',id:projectId,version:p.version,name:p.name,departmentId:'legal',visibility:'restricted',readers:[x.legal.id,x.worker.id]});assert.equal(update.projectId,projectId);assert.ok(visibleProjectJobs(x.db,x.worker,x.current().companies[0]).some(j=>j.id===projectId));
});

test('restricted tasks and records are separately scoped from department/project access, including search export payloads',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline public coordination',departmentId:'legal',visibility:'company'});
  x.act(x.owner,{type:'project-task-save',projectId,title:'Harborline restricted medical case',notes:'fictional-sensitive-task',departmentId:'hr',kind:'onboarding',ownerId:x.hr1.id,restricted:true,readers:[x.hr1.id]});
  x.dep(x.owner,{type:'record-save',departmentId:'hr',kind:'case',title:'Harborline restricted personnel case',notes:'fictional-sensitive-record',readers:[x.hr1.id]});
  const legalPayload=JSON.stringify([projectView(x.db,x.legal,x.current()),departmentView(x.db,x.legal,x.current())]);assert.ok(!legalPayload.includes('fictional-sensitive'));
  const hr1=JSON.stringify([projectView(x.db,x.hr1,x.current()),departmentView(x.db,x.hr1,x.current())]);assert.ok(hr1.includes('fictional-sensitive-task'));assert.ok(hr1.includes('fictional-sensitive-record'));
  const hr2=JSON.stringify([projectView(x.db,x.hr2,x.current()),departmentView(x.db,x.hr2,x.current())]);assert.ok(!hr2.includes('fictional-sensitive'));
  assert.throws(()=>x.dep(x.hr1,{type:'record-save',departmentId:'hr',kind:'case',title:'Unauthorized restricted write'}),/Restricted-record management/);
});

test('restricted project journals, histories, attachments, balances and source-ID writes are filtered server-side',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline acquisition secret',departmentId:'legal',visibility:'restricted',readers:[x.legal.id]});let state=x.current();
  state=apply(state,x.companyId,{type:'job expense',date:'2026-01-02',job:projectId,amount:7654321,label:'Harborline acquisition secret expense'});const source=state.companies[0].history.at(-1).id,entry=state.companies[0].entries.at(-1).id;
  state=apply(state,x.companyId,{type:'attachment',date:'2026-01-02',source,name:'Harborline secret attachment',data:'c2VjcmV0'});saveBooks(x.db,state);
  const hidden=projectBusinessState(x.db,x.finance,projectErpState(x.db,x.finance,state),state);assert.ok(!JSON.stringify(hidden).includes('acquisition secret'));assert.ok(!JSON.stringify(hidden).includes('7654321'));assert.ok(!hidden.companies[0].entries.some(e=>e.id===entry));
  const dashboard=departmentView(x.db,x.finance,state,{companyId:x.companyId}).workspaces.find(d=>d.id==='finance');assert.equal(dashboard.widgets.find(w=>w.id==='balances').value.cash,0);
  assert.throws(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'attachment',source}),/Project access denied/);assert.throws(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'match',entry}),/Project access denied/);assert.throws(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'close'}),/every protected project/);
  const allowed=projectBusinessState(x.db,x.legal,state);assert.ok(allowed.companies[0].entries.some(e=>e.id===entry));assert.ok(allowed.companies[0].jobs.some(j=>j.id===projectId));
  saveAreas(x.db,x.finance.id,['Directory']);assert.ok(!departmentView(x.db,x.finance,state).workspaces.flatMap(d=>d.widgets).some(w=>['balances','invoices'].includes(w.id)),'department permission cannot bypass ERP area restrictions');
  x.dep(x.owner,{type:'record-save',departmentId:'hr',title:'Fictional sensitive onboarding',kind:'onboarding'});x.dep(x.owner,{type:'department-grant',departmentId:'hr',accountId:x.legal.id,rights:['view']});
  assert.ok(!JSON.stringify(departmentView(x.db,x.legal,state)).includes('Fictional sensitive onboarding'),'HR view alone does not grant personnel-record access through raw records or export');
  saveAreas(x.db,x.hr1.id,['Directory']);assert.ok(!JSON.stringify(departmentView(x.db,x.hr1,state)).includes('Fictional sensitive onboarding'),'HR rights cannot bypass employee ERP areas');
  const directoryOnly={...x.finance};x.dep(x.owner,{type:'department-grant',departmentId:'finance',accountId:directoryOnly.id,rights:[]});const bare=projectView(x.db,directoryOnly,state);assert.deepEqual(bare.projects,[]);assert.deepEqual(bare.employees,[]);assert.deepEqual(bare.accounts,[],'no workspace grant means no assignment-directory side channel');
});

test('existing file upgrade and restart preserve books, task ownership, department grants and legacy access',t=>{
  const dir=mkdtempSync(join(tmpdir(),'firmquill-dept-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'fictional.sqlite');
  const db=openStore(path);let state=newVault('Harborline pre-upgrade',['jobs']);const companyId=state.companies[0].id;state=apply(state,companyId,{type:'job',date:'2026-01-01',name:'Fictional old job'});saveBooks(db,state);const before=JSON.stringify(readBooks(db));db.close();
  const upgraded=openStore(path);initializeDepartments(upgraded);initializeProjects(upgraded);assert.equal(JSON.stringify(readBooks(upgraded)),before);assert.equal(validateState(readBooks(upgraded).state),true);assert.equal(upgraded.prepare('SELECT count(*) n FROM departments WHERE company=?').get(companyId).n,4);upgraded.close();
  const restarted=openStore(path);initializeDepartments(restarted);initializeProjects(restarted);assert.equal(JSON.stringify(readBooks(restarted)),before);assert.equal(restarted.prepare('SELECT count(*) n FROM departments WHERE company=?').get(companyId).n,4);restarted.close();
});

test('functional ERP areas restrict HR and finance workspace writes as well as reads',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Fictional HR functional scope',departmentId:'hr',visibility:'department'});saveAreas(x.db,x.hr1.id,['Directory']);saveAreas(x.db,x.finance.id,['Directory']);
  assert.throws(()=>x.dep(x.hr1,{type:'record-save',departmentId:'hr',kind:'onboarding',title:'Unauthorized personnel work'}),/employee ERP area/);
  assert.throws(()=>x.act(x.hr1,{type:'project-task-save',projectId,departmentId:'hr',kind:'onboarding',title:'Unauthorized personnel task'}),/employee ERP area/);
  assert.throws(()=>x.dep(x.finance,{type:'record-save',departmentId:'finance',kind:'close-task',title:'Unauthorized close work'}),/financial ERP area/);
  saveAreas(x.db,x.hr1.id,['Employee records']);assert.ok(x.dep(x.hr1,{type:'record-save',departmentId:'hr',kind:'onboarding',title:'Authorized personnel work'}).recordId);
  saveAreas(x.db,x.finance.id,['Accounting']);assert.ok(x.dep(x.finance,{type:'record-save',departmentId:'finance',kind:'close-task',title:'Authorized close work'}).recordId);
});

test('Accounting-only accounts keep legacy and company-visible financial access while protected project totals remain scoped',t=>{
  const x=fixture(t),legacyJob=x.current().companies[0].jobs[0].id;let state=apply(x.current(),x.companyId,{type:'job expense',date:'2026-01-02',job:legacyJob,amount:1200,label:'Legacy permitted expense'});saveBooks(x.db,state);saveAreas(x.db,x.finance.id,['Accounting']);
  let projected=projectBusinessState(x.db,x.finance,projectErpState(x.db,x.finance,state),state).companies[0];assert.deepEqual(projected.jobs,[]);assert.equal(projected.entries.length,1);assert.equal(projected.entries[0].lines.find(l=>l.account==='1000').cents,-1200);assert.doesNotThrow(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'close'}));assert.doesNotThrow(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'reverse journal',source:state.companies[0].entries[0].source}));
  x.act(x.owner,{type:'project-save',id:legacyJob,version:0,name:'Legacy company project',visibility:'company'});state=x.current();projected=projectBusinessState(x.db,x.finance,projectErpState(x.db,x.finance,state),state).companies[0];assert.equal(projected.entries.length,1,'adding company-visible metadata preserves prior journal permissions');assert.equal(departmentView(x.db,x.finance,state).workspaces.find(d=>d.id==='finance').widgets.find(w=>w.id==='balances').value.cash,-1200);
  const {projectId}=x.act(x.owner,{type:'project-save',name:'Fictional protected legal project',departmentId:'legal',visibility:'restricted'});state=apply(x.current(),x.companyId,{type:'job expense',date:'2026-01-02',job:projectId,amount:3400,label:'Protected expense'});saveBooks(x.db,state);projected=projectBusinessState(x.db,x.finance,projectErpState(x.db,x.finance,state),state).companies[0];assert.equal(projected.entries.length,1);assert.equal(departmentView(x.db,x.finance,state).workspaces.find(d=>d.id==='finance').widgets.find(w=>w.id==='balances').value.cash,-1200);assert.throws(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'close'}),/protected project/);
});

test('employee profile history does not reveal a hidden assignment through a combined edit reason',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline confidential acquisition',departmentId:'legal',visibility:'restricted'});
  setEmployeeProfile(x.db,x.current(),x.companyId,x.employeeId,{title:'Fictional associate',projectAssignments:[{jobId:projectId,start:'2026-01-01',role:'Fictional secret project staffing detail'}]},x.owner.id,{effectiveDate:'2026-01-01',reason:'Harborline confidential acquisition transfer'});
  const worker=recordsView(x.db,x.worker,x.current());assert.deepEqual(worker.employee.profile.projectAssignments,[]);assert.ok(!JSON.stringify(worker).includes('Harborline confidential acquisition'));assert.ok(!JSON.stringify(worker).includes('secret project staffing detail'));
  const owner=recordsView(x.db,x.owner,x.current(),{companyId:x.companyId,employeeId:x.employeeId});assert.ok(JSON.stringify(owner).includes('Harborline confidential acquisition transfer'));
});

test('management can retain existing responsibility but assigning or clearing it requires assign permission',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline responsibility checks',departmentId:'hr',visibility:'department',leadId:x.hr1.id});
  x.act(x.owner,{type:'project-task-save',projectId,departmentId:'hr',title:'Harborline assigned onboarding',kind:'onboarding',ownerId:x.hr1.id});x.dep(x.owner,{type:'record-save',departmentId:'hr',title:'Harborline assigned HR work',kind:'onboarding',ownerId:x.hr1.id});x.dep(x.owner,{type:'department-grant',departmentId:'hr',accountId:x.hr1.id,rights:['view','manage','hr']});
  let p=projectView(x.db,x.hr1,x.current()).projects.find(p=>p.id===projectId),task=p.tasks[0],record=departmentView(x.db,x.hr1,x.current()).workspaces.find(w=>w.id==='hr').records[0];
  assert.ok(x.act(x.hr1,{type:'project-save',id:p.id,version:p.version,name:p.name,departmentId:p.departmentId,visibility:p.visibility,leadId:p.leadId,status:'in-progress'}).projectId);
  assert.ok(x.act(x.hr1,{type:'project-task-save',projectId,id:task.id,version:task.version,title:task.title,kind:task.kind,departmentId:task.departmentId,ownerId:task.ownerId,status:'in-progress'}).taskId);
  assert.ok(x.dep(x.hr1,{type:'record-save',id:record.id,version:record.version,title:record.title,kind:record.kind,departmentId:record.departmentId,ownerId:record.ownerId,status:'in-progress'}).recordId);
  p=projectView(x.db,x.hr1,x.current()).projects.find(p=>p.id===projectId);task=p.tasks[0];record=departmentView(x.db,x.hr1,x.current()).workspaces.find(w=>w.id==='hr').records[0];
  assert.throws(()=>x.act(x.hr1,{type:'project-save',id:p.id,version:p.version,name:p.name,departmentId:p.departmentId,visibility:p.visibility,leadId:''}),/Assignment permission/);
  assert.throws(()=>x.act(x.hr1,{type:'project-task-save',projectId,id:task.id,version:task.version,title:task.title,kind:task.kind,departmentId:task.departmentId,ownerId:''}),/Assignment permission/);
  assert.throws(()=>x.dep(x.hr1,{type:'record-save',id:record.id,version:record.version,title:record.title,kind:record.kind,departmentId:record.departmentId,ownerId:''}),/Assignment permission/);
});

test('contract fields and explicit lifecycle status survive edits and only active contracts appear as renewals',t=>{
  const x=fixture(t),{recordId}=x.dep(x.owner,{type:'record-save',departmentId:'legal',kind:'contract',title:'Harborline ended lease',counterparty:'Fictional Landlord',reference:'HL-DEMO-LEASE',effectiveDate:'2026-01-01',dueDate:'2027-01-01',contractStatus:'Terminated',status:'open'});
  const get=()=>departmentView(x.db,x.owner,x.current()).workspaces.find(w=>w.id==='legal');let workspace=get(),record=workspace.records.find(r=>r.id===recordId);assert.equal(record.contractStatus,'Terminated');assert.equal(record.effectiveDate,'2026-01-01');assert.equal(record.counterparty,'Fictional Landlord');assert.equal(record.reference,'HL-DEMO-LEASE');assert.ok(!workspace.widgets.find(w=>w.id==='renewals').rows.some(r=>r.id===recordId));
  x.dep(x.owner,{type:'record-save',id:recordId,version:record.version,departmentId:'legal',kind:'contract',title:record.title,dueDate:record.dueDate,status:'done'});record=get().records.find(r=>r.id===recordId);assert.equal(record.contractStatus,'Terminated','generic workflow status does not replace precise contract lifecycle');assert.equal(record.counterparty,'Fictional Landlord');
  assert.throws(()=>x.dep(x.owner,{type:'record-save',id:recordId,version:record.version,departmentId:'legal',kind:'contract',title:record.title,contractStatus:'Expired yesterday'}),/contract status/);
  const {recordId:closed}=x.dep(x.owner,{type:'record-save',departmentId:'legal',kind:'contract',title:'Harborline generic completed contract',status:'done'});assert.equal(get().records.find(r=>r.id===closed).contractStatus,'Closed');
});

test('Finance dashboards and exports resolve imported source chains before computing totals',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline protected imported project',departmentId:'legal',visibility:'restricted'});
  let state=apply(x.current(),x.companyId,{type:'job expense',date:'2026-01-02',job:projectId,amount:3400,label:'Harborline protected source'});
  const c=state.companies[0],source=c.history.at(-1).id;
  state=apply(state,x.companyId,{type:'journal',date:'2026-01-03',label:'Harborline protected imported correction',lines:[['5100',1200],['1000',-1200]]});
  // Imported histories may retain a parent/source link instead of a job field.
  const correction=state.companies[0].history.at(-1);correction.source=source;
  state=apply(state,x.companyId,{type:'attachment',date:'2026-01-03',source:correction.id,name:'Harborline protected imported file',data:'c2VjcmV0'});
  const correctionEntry=state.companies[0].entries.at(-1);
  state=apply(state,x.companyId,{type:'reverse journal',date:'2026-01-04',entry:correctionEntry.id,label:'Harborline protected imported reversal'});
  assert.equal(validateState(state),true);saveBooks(x.db,state);
  const projected=projectBusinessState(x.db,x.finance,projectErpState(x.db,x.finance,state),state).companies[0];
  assert.deepEqual(projected.entries,[]);assert.ok(!JSON.stringify(projected).includes('Harborline protected'));
  const dashboard=departmentView(x.db,x.finance,state).workspaces.find(w=>w.id==='finance');
  assert.equal(dashboard.widgets.find(w=>w.id==='balances').value.cash,0);
  const ownerDashboard=departmentView(x.db,x.owner,state).workspaces.find(w=>w.id==='finance');assert.equal(ownerDashboard.widgets.find(w=>w.id==='balances').value.cash,-3400);
  assert.throws(()=>authorizeProjectAction(x.db,x.finance,state,x.companyId,{type:'attachment',source:correction.id}),/Project access denied/);
});

test('moving a task requires management of its original department and exposes department rights to the UI',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline shared coordination',departmentId:'legal',visibility:'company'});
  const {taskId}=x.act(x.owner,{type:'project-task-save',projectId,departmentId:'legal',title:'Harborline legal work'});
  x.dep(x.owner,{type:'department-grant',departmentId:'legal',accountId:x.legal.id,rights:['view']});
  x.dep(x.owner,{type:'department-grant',departmentId:'hr',accountId:x.legal.id,rights:['view','manage']});
  const view=projectView(x.db,x.legal,x.current()),task=view.projects.find(p=>p.id===projectId).tasks.find(t=>t.id===taskId);
  assert.deepEqual(view.departments.find(d=>d.id==='legal').rights,['view']);
  assert.throws(()=>x.act(x.legal,{type:'project-task-save',projectId,id:task.id,version:task.version,departmentId:'hr',title:task.title}),/Original task department management/);
  assert.equal(projectView(x.db,x.owner,x.current()).projects.find(p=>p.id===projectId).tasks.find(t=>t.id===taskId).departmentId,'legal');
  const {taskId:restrictedId}=x.act(x.owner,{type:'project-task-save',projectId,departmentId:'legal',title:'Harborline restricted legal work',restricted:true,readers:[x.legal.id]});
  x.dep(x.owner,{type:'department-grant',departmentId:'legal',accountId:x.legal.id,rights:['view','manage']});x.dep(x.owner,{type:'department-grant',departmentId:'hr',accountId:x.legal.id,rights:['view','manage','restricted']});
  const restricted=projectView(x.db,x.legal,x.current()).projects.find(p=>p.id===projectId).tasks.find(t=>t.id===restrictedId);
  assert.throws(()=>x.act(x.legal,{type:'project-task-save',projectId,id:restricted.id,version:restricted.version,departmentId:'hr',title:restricted.title,restricted:true,readers:restricted.readers}),/Original restricted task management/);
});

test('only owner reader choices include worker accounts, without making workers eligible leads or task owners',t=>{
  const x=fixture(t),view=projectView(x.db,x.owner,x.current(),{companyId:x.companyId});
  assert.ok(view.readerAccounts.some(a=>a.id===x.worker.id));assert.ok(!view.accounts.some(a=>a.id===x.worker.id));
  assert.deepEqual(projectView(x.db,x.legal,x.current(),{companyId:x.companyId}).readerAccounts,[]);
  assert.throws(()=>x.act(x.owner,{type:'project-save',name:'Harborline invalid lead',departmentId:'legal',visibility:'restricted',leadId:x.worker.id}),/active authorized/);
});

test('authorized leads can update restricted projects while only owner can change access',t=>{
  const x=fixture(t),{projectId}=x.act(x.owner,{type:'project-save',name:'Harborline restricted coordination',departmentId:'legal',visibility:'restricted',readers:[x.legal.id],leadId:x.legal.id});
  let p=projectView(x.db,x.legal,x.current()).projects.find(p=>p.id===projectId);
  const payload={type:'project-save',id:projectId,version:p.version,name:'Harborline renamed coordination',departmentId:p.departmentId,visibility:p.visibility,readers:p.readers,leadId:p.leadId,status:'in-progress'};
  x.act(x.legal,payload);p=projectView(x.db,x.legal,x.current()).projects.find(p=>p.id===projectId);assert.equal(p.name,payload.name);assert.equal(p.status,'in-progress');assert.deepEqual(p.readers,[x.legal.id]);
  assert.throws(()=>x.act(x.legal,{...payload,version:p.version,readers:[]}),/Only the owner can change project access/);
  assert.throws(()=>x.act(x.legal,{...payload,version:p.version,visibility:'company'}),/Only the owner can change project access/);
  assert.throws(()=>x.act(x.legal,{type:'project-save',name:'Harborline unauthorized restricted project',departmentId:'legal',visibility:'restricted'}),/Only the owner can change project access/);
});
