import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,saveBooks,putUser,readBooks,safeUser} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {initializeManualPayroll,manualPayrollView,manualPayrollStoreCommand} from '../manual-payroll-store.mjs';
import {applyPayrollTemplates,previewPayrollTemplates,validatePayrollTemplatePayload} from '../payroll-template-package.mjs';
const rule=(key='fixture-one')=>({key,name:'Fictional test only',effective:'2027-01-01',side:'employee',method:'percentage',rate:10000,jurisdiction:'Fictional testing',wageBasis:'all'});
const item=(id='fixture-one',revision=1)=>({templateId:id,revision,label:'Fictional test rule',provenance:'Not a tax source. Synthetic test only.',rule:rule(id)});
const packageFrom=(templates,version=2)=>({version,files:{'templates.json':JSON.stringify({version:1,templates})}});
test('strict data-only payroll template parser rejects extra fields, employees, unsupported methods, bad amounts and collisions',()=>{
 const base={version:1,templates:[item()]};
 assert.equal(validatePayrollTemplatePayload(base).templates[0].rule.rate,10000);
 for(const bad of [
  {...base,executable:'none'},{...base,templates:[item(),item()]},{...base,templates:[item(),{...item('other'),rule:rule()}]},
  {...base,templates:[{...item(),provenance:'bad\nline'}]},
  {...base,templates:[{...item(),employeeId:'fiction'}]},
  {...base,templates:[{...item(),rule:{...rule(),type:'finalize'}}]},
  {...base,templates:[{...item(),rule:{...rule(),amount:10000}}]},
  {...base,templates:[{...item(),rule:{...rule(),rate:1.25}}]},
  {...base,templates:[{...item(),rule:{...rule(),method:'brackets',rate:undefined,brackets:[{start:0,rate:10,unknown:0}]}}]},
 ])assert.throws(()=>validatePayrollTemplatePayload(bad));
});
function setup(t){
 const db=openStore(':memory:');t.after(()=>db.close());initializeManualPayroll(db);saveBooks(db,sampleVault());
 const state=()=>readBooks(db).state;
 const [a,b]=state().companies;
 const add=(name,role,assignments,areas,actor)=>putUser(db,actor,{username:name,name,role,assignments,areas},'fictional-hash-not-used',actor?{}:{bootstrap:true});
 const ownerId=add('owner','owner',[],[],null),owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(ownerId));
 const get=id=>safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
 const payroll=get(add('payroll','payroll',[a.id],['Payroll'],owner));
 const other=get(add('other','payroll',[b.id],['Payroll'],owner));
 const denied=get(add('nopay','payroll',[a.id],['Directory'],owner));
 return {db,state,a,b,owner,payroll,other,denied};
}
const request=(p,selected=p.templates.map(x=>({id:x.templateId,revision:x.revision})))=>({companyId:p.companyId,payrollRevision:p.payrollRevision,packageVersion:p.packageVersion,packageDigest:p.packageDigest,selected,confirm:true});
test('payroll preview is read-only and excludes unentitled, unassigned and non-payroll-area requests',t=>{
 const {db,state,a,owner,payroll,other,denied}=setup(t);
 const options={db,state:state(),companyId:a.id,allows:()=>true,packageFor:()=>packageFrom([item()])};
 assert.deepEqual(previewPayrollTemplates({...options,user:owner,allows:()=>false}),{enabled:false});
 assert.deepEqual(previewPayrollTemplates({...options,user:owner,packageFor:()=>null}),{enabled:false});
 assert.equal(previewPayrollTemplates({...options,user:payroll}).templates.length,1);
 assert.throws(()=>previewPayrollTemplates({...options,user:other}),{status:404});
 assert.throws(()=>previewPayrollTemplates({...options,user:denied}),{status:403});
 assert.equal(db.prepare('SELECT count(*) AS n FROM manual_payroll').get().n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE kind='payroll templates imported'").get().n,0);
});
test('transaction enforces explicit company, selection, live license, exact content, role and stale revisions; never runs or replaces',t=>{
 const {db,state,a,b,payroll,other}=setup(t);
 let entitled=true,pack=packageFrom([item(),item('fixture-two')]);
 const options={db,companyId:a.id,allows:()=>entitled,packageFor:()=>pack};
 const preview=()=>previewPayrollTemplates({...options,user:payroll,state:state()});
 const apply=(input,active=()=>payroll)=>applyPayrollTemplates({...options,active,readState:state,input});
 const original=preview(),input=request(original);
 assert.throws(()=>apply({...input,confirm:false}),{status:400});
 assert.throws(()=>apply({...input,companyId:b.id}),{status:400});
 assert.throws(()=>apply(input,()=>other),{status:404});
 assert.throws(()=>apply({...input,selected:[{id:'fixture-one',revision:2}]}),{status:409});
 entitled=false;assert.throws(()=>apply(input),{status:403});entitled=true;
 pack=packageFrom([{...item(),label:'Modified package same version'},item('fixture-two')]);
 assert.throws(()=>apply(input),{status:409});pack=packageFrom([item(),item('fixture-two')]);
 assert.equal(db.prepare('SELECT count(*) AS n FROM manual_payroll').get().n,0);
 assert.deepEqual(apply(request(original,[{id:'fixture-one',revision:1}])),{imported:1,payrollRevision:1});
 assert.throws(()=>apply(input),{status:409});
 const next=preview();assert.equal(next.templates[0].conflict,true);
 assert.throws(()=>apply(request(next)),{status:409});
 const after=manualPayrollView(db,payroll,state(),a.id).data;
 assert.deepEqual(after.rules.map(r=>r.key),['fixture-one']);assert.deepEqual(after.drafts,[]);assert.deepEqual(after.runs,[]);
 assert.equal(db.prepare('SELECT count(*) AS n FROM manual_payroll_published').get().n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE kind='payroll templates imported'").get().n,1);
});
test('normal rule edit after preview invalidates the template confirmation',t=>{
 const {db,state,a,payroll}=setup(t),options={db,companyId:a.id,allows:()=>true,packageFor:()=>packageFrom([item()])};
 const before=previewPayrollTemplates({...options,user:payroll,state:state()});
 manualPayrollStoreCommand(db,payroll,state(),a.id,{...rule('normal-rule'),type:'rule',revision:0});
 assert.throws(()=>applyPayrollTemplates({...options,active:()=>payroll,readState:state,input:request(before)}),{status:409});
});
