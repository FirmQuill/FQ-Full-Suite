import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newVault,apply,position,jobSummary,validateState} from '../shared/core.mjs';
import {applyDesk,validateDesk} from '../shared/desk-core.mjs';
import {openStore,putUser,safeUser,tx,readBooks,saveBooks} from '../store.mjs';
import {migrateOwnerDesk,ownerDeskMigrationReports} from '../desk-migration.mjs';
import {projectView,projectCommand} from '../project-workspace.mjs';
import {departmentView} from '../departments.mjs';
import {assetsView} from '../assets-workspace.mjs';

function liteBooks(){
  let s=newVault('Harborline Fictional Owner Desk',['jobs','employees','stock']),company=s.companies[0].id;const a=action=>{s=apply(s,company,{date:'2026-01-01',...action});return s.companies[0];},d=action=>{s=applyDesk(s,company,{date:'2026-01-02',...action},apply);return s.companies[0].desk;};
  const employee=a({type:'employee',name:'Harborline Fictional Staff',rate:2400,state:'WA',locality:'Fictional'}).employees[0].id,job=a({type:'job',name:'Harborline owner warehouse setup'}).jobs[0].id,item=a({type:'item',name:'Harborline fittings',kind:'Product'}).items[0].id;
  a({type:'adjust in',item,qty:20,amount:20000,location:'Main'});d({type:'project details',job,department:'Owner operations',status:'Active'});const contract=d({type:'contract record',job,name:'Harborline fictional lease',counterparty:'Fictional Harborline Landlord',reference:'DEMO-LEASE-1',effective:'2026-01-01',renewal:'2027-01-01',notes:'Fictional only'}).contracts[0].id;
  d({type:'project task',job,name:'Fictional owner onboarding',kind:'Onboarding',due:'2026-02-01',contract});d({type:'project staffing',job,employee,plannedMinutes:120});a({type:'time',job,employee,minutes:90,date:'2026-01-02'});a({type:'approve time',time:s.companies[0].time[0].id,date:'2026-01-02'});
  const unit=d({type:'tracked unit',unitId:'HL-IMPORT-001',name:'Harborline imported pallet',kind:'Pallet',location:'Main',contents:[{item,qty:10}]}).units[0].id;const count=d({type:'count open',unit}).counts[0].id;d({type:'count observe',count,contents:[{item,qty:8}],notes:'Two fictional missing fittings'});d({type:'count approve',count,notes:'Fictional approved count'});
  validateDesk(s.companies[0]);validateState(s);return {state:s,company,employee,job,item,unit,count};
}
function fixture(t,{owner=true}={}){const db=openStore(':memory:');t.after(()=>db.close());let user;if(owner){const id=putUser(db,null,{username:'fictional-owner',name:'Harborline Owner',role:'owner',assignments:[]},'!fixture',{bootstrap:true});user=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));}const x=liteBooks();db.prepare('UPDATE books SET body=? WHERE id=1').run(JSON.stringify(x.state));return {db,user,...x};}

test('Lite owner desk converts projects, contracts, staffing and approved pallet counts without changing books or repeating postings',t=>{
  const x=fixture(t),before=JSON.stringify(x.state),stock=position(x.state.companies[0],x.item,'Main'),labor=jobSummary(x.state.companies[0],x.job).labor;
  const reports=tx(x.db,()=>migrateOwnerDesk(x.db,x.state));assert.equal(reports[0].projects,1);assert.equal(reports[0].tasks,1);assert.equal(reports[0].contracts,1);assert.equal(reports[0].staffing,1);assert.equal(reports[0].assets.units,1);assert.equal(reports[0].assets.counts,1);assert.deepEqual(reports[0].conflicts,[]);assert.equal(JSON.stringify(x.state),before);assert.equal(JSON.stringify(readBooks(x.db).state),before);
  const projects=projectView(x.db,x.user,x.state,{companyId:x.company}).projects,p=projects.find(p=>p.id===x.job);assert.equal(p.visibility,'restricted');assert.equal(p.leadId,x.user.id);assert.equal(p.tasks[0].ownerId,x.user.id);assert.equal(p.tasks[0].contractId,departmentView(x.db,x.user,x.state).workspaces.flatMap(w=>w.records).find(r=>r.kind==='contract').id);assert.equal(p.staffing[0].plannedMinutes,120);assert.equal(p.cost.labor,labor);assert.equal(labor,3600);
  const contract=departmentView(x.db,x.user,x.state).workspaces.flatMap(w=>w.records).find(r=>r.kind==='contract');assert.equal(contract.counterparty,'Fictional Harborline Landlord');assert.equal(contract.reference,'DEMO-LEASE-1');assert.equal(contract.effectiveDate,'2026-01-01');
  const assets=assetsView(x.db,x.user,x.state,{companyId:x.company});assert.equal(assets.units[0].contents[0].quantity,8);assert.equal(assets.sessions[0].expected[0].contents[0].quantity,10);assert.equal(assets.sessions[0].observations[0].contents[0].quantity,8);assert.equal(assets.sessions[0].status,'approved');assert.deepEqual(position(x.state.companies[0],x.item,'Main'),stock);
  const again=tx(x.db,()=>migrateOwnerDesk(x.db,x.state));assert.equal(again[0].duplicate,true);assert.equal(x.db.prepare('SELECT count(*) n FROM project_tasks').get().n,1);assert.equal(x.db.prepare('SELECT count(*) n FROM asset_count_sessions').get().n,1);assert.equal(ownerDeskMigrationReports(x.db,x.company).length,1);
});

test('conversion is owner-only, preserves later Full edits, reports changed source conflicts and resolves first-owner identity safely',t=>{
  const x=fixture(t,{owner:false});tx(x.db,()=>migrateOwnerDesk(x.db,x.state));const projectBody=()=>JSON.parse(x.db.prepare('SELECT body FROM project_workspaces WHERE company=? AND id=?').get(x.company,x.job).body);assert.equal(projectBody().leadId,'');assert.equal(projectBody().pendingOwner,true);const ownerId=putUser(x.db,null,{username:'new-fictional-owner',name:'Harborline New Owner',role:'owner',assignments:[]},'!fixture',{bootstrap:true}),owner=safeUser(x.db.prepare('SELECT * FROM accounts WHERE id=?').get(ownerId));tx(x.db,()=>migrateOwnerDesk(x.db,x.state));assert.equal(projectBody().leadId,ownerId);assert.equal(projectBody().pendingOwner,undefined);
  const managerId=putUser(x.db,null,{username:'fictional-manager',name:'Fictional Company Manager',role:'manager',assignments:[x.company]},'!fixture',{bootstrap:true}),manager=safeUser(x.db.prepare('SELECT * FROM accounts WHERE id=?').get(managerId));assert.ok(!projectView(x.db,manager,x.state).projects.some(p=>p.id===x.job));assert.ok(!JSON.stringify(departmentView(x.db,manager,x.state)).includes('fictional lease'));
  const originalTask=projectView(x.db,owner,x.state).projects.find(p=>p.id===x.job).tasks[0];tx(x.db,()=>projectCommand(x.db,owner,x.state,{type:'project-task-save',companyId:x.company,projectId:x.job,id:originalTask.id,version:originalTask.version,departmentId:originalTask.departmentId,title:'Harborline edited in Full',kind:originalTask.kind,ownerId:ownerId,dueDate:originalTask.dueDate,restricted:true,readers:[],status:'done'}));
  let task=projectView(x.db,owner,x.state).projects.find(p=>p.id===x.job).tasks[0];assert.equal(task.sourceLiteId,originalTask.sourceLiteId);assert.equal(task.contractId,originalTask.contractId);
  const changed=structuredClone(x.state);changed.companies[0].desk.tasks[0].status='In progress';const report=tx(x.db,()=>migrateOwnerDesk(x.db,changed))[0];assert.equal(report.tasks,0);assert.ok(report.conflicts.some(r=>r.kind==='task'));task=projectView(x.db,owner,x.state).projects.find(p=>p.id===x.job).tasks[0];assert.equal(task.title,'Harborline edited in Full');assert.equal(task.status,'done');assert.equal(ownerDeskMigrationReports(x.db,x.company).length,2);
});

test('owner company tasks without projects or dates convert to private department work and optional contract fields survive',t=>{
  const x=fixture(t);let state=applyDesk(x.state,x.company,{type:'project task',date:'2026-01-03',name:'Harborline company close',kind:'Close',due:''},apply);state=applyDesk(state,x.company,{type:'contract record',date:'2026-01-03',name:'Harborline optional dates agreement',counterparty:'',reference:'',effective:'',renewal:''},apply);
  const report=tx(x.db,()=>migrateOwnerDesk(x.db,state))[0];assert.equal(report.projects,1);assert.equal(report.tasks,2);assert.equal(report.contracts,2);const records=departmentView(x.db,x.user,state).workspaces.flatMap(w=>w.records),companyTask=records.find(r=>r.title==='Harborline company close');assert.equal(companyTask.kind,'close-task');assert.equal(companyTask.dueDate,'');assert.equal(companyTask.sourceKind,'task');const contract=records.find(r=>r.title==='Harborline optional dates agreement');assert.equal(contract.effectiveDate,'');assert.equal(contract.reference,'');assert.equal(contract.counterparty,'');
});

test('invalid incoming owner desk is rejected transactionally and an existing workspace upgrades idempotently on reopen',t=>{
  const x=fixture(t),bad=structuredClone(x.state);bad.companies[0].desk.tasks[0].job='foreign-company-job';assert.throws(()=>tx(x.db,()=>migrateOwnerDesk(x.db,bad)),/valid project/);assert.deepEqual(ownerDeskMigrationReports(x.db,x.company),[]);assert.equal(x.db.prepare('SELECT count(*) n FROM project_tasks').get().n,0);
  const dir=mkdtempSync(join(tmpdir(),'fq-ownerdesk-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const filename=join(dir,'existing.sqlite'),db=openStore(filename);db.prepare('UPDATE books SET body=? WHERE id=1').run(JSON.stringify(x.state));const before=JSON.stringify(readBooks(db));db.close();let upgraded=openStore(filename);tx(upgraded,()=>migrateOwnerDesk(upgraded,readBooks(upgraded).state));assert.equal(JSON.stringify(readBooks(upgraded)),before);upgraded.close();upgraded=openStore(filename);tx(upgraded,()=>migrateOwnerDesk(upgraded,readBooks(upgraded).state));assert.equal(JSON.stringify(readBooks(upgraded)),before);assert.equal(upgraded.prepare('SELECT count(*) n FROM owner_desk_imports').get().n,1);assert.equal(upgraded.prepare('SELECT count(*) n FROM project_tasks').get().n,1);upgraded.close();
});
