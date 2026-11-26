import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {purchaseMatches} from '../team-workflows.mjs';
import {seedFixtureTerms,acceptFixtureBrowser,fixtureAgreement} from './fixture-terms.mjs';

const password='Synthetic Team Workflows Only 2026!';
async function setup(t,{timeOff=true}={}){
  const dir=await mkdtemp(join(tmpdir(),'fq-team-fixture-')),database=join(dir,'company.sqlite');
  let state=newVault('Synthetic Team Warehouse',['jobs','time','employees']);const companyId=state.companies[0].id;
  for(const [type,fields] of [['contact',{kind:'Vendor',name:'Synthetic seller'}],['item',{kind:'Service',name:'Inspection'}],['employee',{name:'Synthetic employee',rate:2600,state:'WA',locality:'Fictional'}],['employee',{name:'Other employee',rate:2500,state:'WA',locality:'Fictional'}]]){
    state=apply(state,companyId,{type,date:'2026-11-15',...fields});
  }
  const {items,parties,employees}=state.companies[0],itemId=items[0].id;
  // Legacy commerce integration continues supporting old workspaces.
  state=apply(state,companyId,{type:'purchase order',date:'2026-11-16',party:parties[0].id,item:itemId,qty:4,unit:10500,label:'Inspection order'});
  const poId=state.companies[0].docs.at(-1).id;
  state=apply(state,companyId,{type:'receiving',date:'2026-11-17',parent:poId,label:'Inspection receipt'});
  state=apply(state,companyId,{type:'bill',date:'2026-11-18',parent:state.companies[0].docs.at(-1).id,label:'Inspection bill'});
  state=apply(state,companyId,{type:'company',date:'2026-11-20',name:'Independent Fictional Company',activities:['jobs']});
  const otherCompanyId=state.companies.at(-1).id,ids={},db=openStore(database),hash=await passwordHash(password);
  try{tx(db,()=>{
    saveBooks(db,state);
    for(const [username,role,employeeId,assignment] of [['owner','owner','',[]],['manager','manager','',[companyId]],['outsider','manager','',[companyId]],['otherco','manager','',[otherCompanyId]],['bookkeeper','bookkeeper','',[companyId]],['worker','worker',employees[0].id,[companyId]],['otherworker','worker',employees[1].id,[companyId]]])
      ids[username]=putUser(db,null,{username,name:username,role,assignments:assignment,employeeId},hash,{bootstrap:true});
    if(timeOff)for(const employee of employees)db.prepare('INSERT INTO employee_portal_flags VALUES(?,?,?)').run(companyId,employee.id,JSON.stringify(['Time','Pay','Reviews','Benefits','My Profile','Contacts','Time off']));
  });seedFixtureTerms(db);}finally{db.close();}
  const suite=await createSuite({database,mainPort:0,workerPort:0});t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
  return {suite,companyId,otherCompanyId,employeeId:employees[0].id,otherEmployeeId:employees[1].id,ids,poId,itemId};
}
async function client(url,username){
  let cookie='',csrf='';const request=async(path,body)=>{const r=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};};
  const log=await request('login',{username,password});assert.equal(log.status,200,JSON.stringify(log.data));cookie=log.headers.get('set-cookie').split(';')[0];csrf=log.data.csrf;if(log.data.termsRequired)assert.equal((await request('terms',fixtureAgreement)).status,200);return request;
}
const post=(request,path,companyId,action)=>request(path,{action:{companyId,...action}});
async function ok(request,path,companyId,action){const r=await post(request,path,companyId,action);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.result??r.data;}
test('partial and full purchase snapshots trace quantities and values by original line and detect variance',()=>{
  const mk=(kind,id,parent,lines,party='v1')=>({kind,id,parent,lines,party,number:1,label:id});
  const a=(lineId,item,qty,total)=>({lineId,item,qty,total,unit:1050,discount:0,location:'Main'});
  const po=mk('purchase order','p','',[a('L1','i1',4,4200),a('L2','i2',8,8400)]);
  const received=mk('receiving','r','p',[a('L1','i1',4,4200),a('L2','i2',4,4200)]);
  const billed=mk('bill','b','r',[a('L1','i1',4,4200),a('L2','i2',4,4200)]);
  assert.equal(purchaseMatches([po])[0].status,'Awaiting receipt');
  assert.equal(purchaseMatches([po,received])[0].status,'Awaiting bill');
  assert.equal(purchaseMatches([po,received,billed])[0].status,'Partial match');
  const received2=mk('receiving','r2','p',[a('L2','i2',4,4200)]),billed2=mk('bill','b2','r2',[a('L2','i2',4,4200)]);
  assert.equal(purchaseMatches([po,received,received2,billed,billed2])[0].status,'Matched');
  const wrong=mk('bill','b','r',[a('L1','i1',4,4200),a('L2','i2',6,6300)]);
  assert.match(purchaseMatches([po,received,received2,wrong])[0].reasons.join(),/specific linked receipt/);
  for(const problem of [mk('bill','b','r',[a('L1','i1',4,4300)]),mk('bill','b','r',[a('L1','i1',4,4200)],'other vendor'),mk('bill','b','p',[a('L1','i1',4,4200)])])
    assert.equal(purchaseMatches([po,received,problem])[0].status,'Variance');
});
test('purchase requests and three-way reconciliation use scoped HTTP snapshots and never post ledger records',async t=>{
  const x=await setup(t),{companyId,otherCompanyId}=x,owner=await client(x.suite.mainUrl,'owner'),buyer=await client(x.suite.mainUrl,'bookkeeper'),other=await client(x.suite.mainUrl,'otherco'),path='team/purchasing';
  const initial=(await owner('session')).data;
  const request=await ok(buyer,path,companyId,{type:'submit',description:'Extra inspection',reason:'Capacity',itemId:x.itemId,qty:4,estimatedUnit:10500,needBy:'2026-12-01'});
  assert.equal((await post(buyer,path,companyId,{type:'review',decision:'approved',...request})).status,403);
  const reviewed=await ok(owner,path,companyId,{type:'review',decision:'approved',...request});
  assert.equal((await post(owner,path,companyId,{type:'link',poId:x.poId,...request})).status,409);
  await ok(owner,path,companyId,{type:'link',poId:x.poId,...reviewed});
  const p=(await buyer(path+'?companyId='+companyId)).data;
  assert.equal(p.requests[0].status,'linked');assert.equal(p.requests[0].poId,x.poId);
  assert.equal(p.matches[0].status,'Matched');assert.equal(p.matches[0].lines[0].billedCents,42000);
  assert.equal((await buyer(path+'?companyId='+otherCompanyId)).status,404);assert.equal((await other(path+'?companyId='+companyId)).status,404);
  const current=(await owner('session')).data;assert.equal(current.revision,initial.revision);assert.deepEqual(current.state,initial.state);
});
test('worker PTO is independently scoped to employee and direct manager; approved time never posts employee hours',async t=>{
  const x=await setup(t),{companyId,otherCompanyId}=x,owner=await client(x.suite.mainUrl,'owner'),manager=await client(x.suite.mainUrl,'manager'),
    outsider=await client(x.suite.mainUrl,'outsider'),worker=await client(x.suite.workerUrl,'worker'),otherWorker=await client(x.suite.workerUrl,'otherworker');
  const init=(await owner('session')).data;
  const p=(await owner('records?companyId='+companyId+'&employeeId='+x.employeeId)).data.employee.profile;
  const changed=await post(owner,'records/action',companyId,{type:'profile-update',employeeId:x.employeeId,version:p.version,patch:{managerAccountId:x.ids.manager}});
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  const sent=await ok(worker,'team/my-time-off',otherCompanyId,{type:'submit',employeeId:x.otherEmployeeId,category:'Vacation',from:'2027-02-22',through:'2027-02-23',note:'Synthetic private PTO note'});
  const saved=sent.leave.requests[0];assert.equal(saved.status,'pending');assert.equal(saved.employeeId,undefined);
  assert.equal((await otherWorker('session')).data.leave.requests.length,0);
  assert.equal((await outsider('team/time-off?companyId='+companyId)).data.requests.length,0);
  assert.equal((await post(outsider,'team/time-off',companyId,{type:'review',id:saved.id,version:saved.version,decision:'approved'})).status,404);
  assert.equal((await manager('team/time-off?companyId='+companyId)).data.requests[0].employeeName,'Synthetic employee');
  await ok(manager,'team/time-off',companyId,{type:'review',id:saved.id,version:saved.version,decision:'approved'});
  assert.equal((await worker('session')).data.leave.requests[0].status,'approved');
  assert.equal((await post(worker,'team/my-time-off',companyId,{type:'withdraw',id:saved.id,version:2})).status,409);
  assert.equal((await post(worker,'team/my-time-off',companyId,{type:'submit',category:'Vacation',from:'2027-02-23',through:'2027-02-25'})).status,409);
  assert.equal((await owner('admin/employee-features',{companyId,employeeId:x.employeeId,features:['Time']})).status,200);
  assert.equal((await worker('session')).data.leave,null);
  assert.equal((await post(worker,'team/my-time-off',companyId,{type:'submit',category:'Personal',from:'2027-03-01',through:'2027-03-01'})).status,403);
  const final=(await owner('session')).data;assert.deepEqual(final.state.companies[0].time,init.state.companies[0].time);
});
test('project templates schedule task dates atomically, dependencies are scoped and enforced, and cycles rejected',async t=>{
 const x=await setup(t),{companyId,otherCompanyId}=x,owner=await client(x.suite.mainUrl,'owner'),manager=await client(x.suite.mainUrl,'manager'),other=await client(x.suite.mainUrl,'otherco');
 const path='projects',template=await ok(owner,path,companyId,{type:'template-save',name:'Ordinary warehouse launch',tasks:[{title:'Plan',days:0},{title:'Count',days:2,after:[0]},{title:'Reconcile',days:4,after:[1]}]});
 const get=(request=owner,id=companyId)=>request(path+'?companyId='+id);
 const t1=(await get()).data.templates.find(m=>m.id===template.templateId);
 assert.equal(t1.name,'Ordinary warehouse launch');
 assert.equal((await get(other,otherCompanyId)).data.templates.length,0);
 assert.equal((await post(manager,path,companyId,{type:'template-use',templateId:t1.id,version:t1.version,name:'Forbidden',departmentId:'operations',start:'2026-12-30'})).status,403);
 const created=await ok(owner,path,companyId,{type:'template-use',templateId:t1.id,version:t1.version,name:'Launch project',departmentId:'operations',start:'2026-12-30'});
 const find=async()=> (await get()).data.projects.find(p=>p.id===created.projectId);
 const taskData=(m,patch)=>({type:'project-task-save',projectId:created.projectId,id:m.id,version:m.version,title:m.title,departmentId:m.departmentId,dueDate:m.dueDate,status:m.status,...patch});
 let project=await find(),[a,b,c]=['Plan','Count','Reconcile'].map(title=>project.tasks.find(m=>m.title===title));
 assert.equal(b.dueDate,'2027-01-01');assert.deepEqual(b.dependencies,[a.id]);assert.deepEqual(c.dependencies,[b.id]);
 assert.equal((await post(owner,path,companyId,taskData(b,{status:'in-progress'}))).status,409);
 assert.equal((await post(owner,path,companyId,taskData(a,{dependencies:[c.id]}))).status,400);
 assert.equal((await post(owner,path,companyId,taskData(a,{restricted:true}))).status,400);
 await ok(owner,path,companyId,taskData(a,{status:'done'}));
 await ok(owner,path,companyId,taskData(b,{status:'in-progress'}));
 project=await find();a=project.tasks.find(m=>m.title==='Plan');b=project.tasks.find(m=>m.title==='Count');
 assert.equal(b.status,'in-progress');assert.deepEqual(b.dependencies,[a.id]);
 assert.equal((await post(owner,path,companyId,taskData(a,{status:'open'}))).status,409);
});
const browserExe=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('browser portal submits PTO, owner reviews it, creates purchase request and uses project template with task board',{skip:!browserExe},async t=>{
 const x=await setup(t,{timeOff:false}),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:browserExe,headless:true});t.after(()=>browser.close());
 const errors=[];
 const login=async(url,username)=>{
   const page=await browser.newPage({viewport:{width:1250,height:900}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
   await page.locator('#login [name=username]').fill(username);await page.locator('#login [name=password]').fill(password);
   await page.locator('#login button').click();await acceptFixtureBrowser(page);return page;
 };
 const worker=await login(x.suite.workerUrl,'worker'),owner=await login(x.suite.mainUrl,'owner');
 await worker.locator('.portal-tabs').waitFor();
 assert.equal(await worker.locator('[data-tab="Time off"]').count(),0);
 const nav=name=>owner.locator('[data-act="nav"][data-key="'+name+'"]').click(),modal=()=>owner.locator('dialog[open]');
 await nav('User access');
 const employeeRow=owner.getByRole('row').filter({has:owner.getByRole('cell',{name:/Synthetic employee/})});
 await employeeRow.locator('[data-act="identity-employee-features"]').click();
 await modal().locator('[name=features][value="Time off"]').check();
 await modal().getByRole('button',{name:'Save portal features'}).click();
 await modal().waitFor({state:'hidden'});
 await worker.locator('#refresh').click();
 await worker.locator('[data-tab="Time off"]').click();
 await worker.locator('#request-leave [name="from"]').fill('2027-03-01');await worker.locator('#request-leave [name="through"]').fill('2027-03-02');
 await worker.getByRole('button',{name:'Send request'}).click();await worker.getByText('2027-03-01 through 2027-03-02 · pending').waitFor();
 await nav('Time off review');await owner.getByRole('button',{name:'Review request',exact:true}).click();
 await modal().getByRole('button',{name:'Save decision'}).click();await owner.getByRole('cell',{name:'approved',exact:true}).waitFor();
 await worker.locator('#refresh').click();await worker.getByText('2027-03-01 through 2027-03-02 · approved').waitFor();
 await nav('Purchase requests');await owner.getByRole('cell',{name:'Matched',exact:true}).waitFor();
 await owner.getByRole('button',{name:'Request purchase'}).click();
 await modal().locator('[name=description]').fill('Browser synthetic equipment');await modal().getByRole('button',{name:'Submit purchase request'}).click();
 await owner.getByRole('cell',{name:'Browser synthetic equipment',exact:true}).waitFor();
 await nav('Project tracker');await owner.getByRole('button',{name:'New template',exact:true}).click();
 await modal().locator('[name=name]').fill('Browser template');await modal().locator('[name=taskRows]').fill('Prepare | 0\nFollow up | 3 | 1');await modal().getByRole('button',{name:'Save template',exact:true}).click();
 await owner.getByRole('button',{name:'Start from template'}).click();
 await modal().locator('[name=departmentId]').selectOption('operations');await modal().locator('[name=start]').fill('2027-02-01');
 await modal().getByRole('button',{name:'Create project'}).click();await owner.getByRole('heading',{name:'Browser template',exact:true}).waitFor();
 await owner.getByText('Open Kanban task board').click();await owner.getByText('After: Prepare',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
});
