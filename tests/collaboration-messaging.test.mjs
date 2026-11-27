import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {inspectLite} from '../transfer.mjs';
import {fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';

const password='Fictional 0.6 Workspace test only!';
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'fq-collab-fixture-')),database=join(dir,'books.sqlite');
  let state=newVault('Fixture Company A',['jobs','time','employees']);
  const company=state.companies[0].id;
  state=apply(state,company,{type:'employee',date:'2026-11-24',name:'Fixture employee',rate:2500,state:'WA',locality:'Fictional'});
  const employeeId=state.companies[0].employees[0].id;
  state=apply(state,company,{type:'employee',date:'2026-11-24',name:'Another fixture person',rate:2600,state:'WA',locality:'Fictional'});
  const anotherEmployeeId=state.companies[0].employees[1].id;
  state=apply(state,company,{type:'company',date:'2026-11-24',name:'Fixture Company B',activities:['jobs']});
  const otherCompany=state.companies.at(-1).id,ids={};
  const db=openStore(database),hash=await passwordHash(password);
  try{tx(db,()=>{saveBooks(db,state);
    for(const [username,role,assignments,employee] of [['owner','owner',[]],['staff1','bookkeeper',[company]],['staff2','manager',[company]],['peer','viewer',[company]],['external','manager',[otherCompany]],['employee','worker',[company],employeeId]])
      ids[username]=putUser(db,null,{username,name:username,role,assignments,employeeId:employee||'',areas:['Directory','Messages']},hash,{bootstrap:true});
  });}finally{db.close();}
  const options={database,mainPort:0,workerPort:0};
  let suite=await createSuite(options);
  t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
  return {suite,company,otherCompany,employeeId,anotherEmployeeId,ids,async restart(){const mainPort=+new URL(suite.mainUrl).port,workerPort=+new URL(suite.workerUrl).port;await suite.close();suite=await createSuite({...options,mainPort,workerPort});return suite;}};
}
async function client(base,username,{accept=true}={}){
  let cookie='',csrf='';
  async function req(path,body,headers={}){
    const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),headers:r.headers};
  }
  const login=await req('login',{username,password});assert.equal(login.status,200,JSON.stringify(login.data));
  cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
  if(accept&&login.data.termsRequired)assert.equal((await req('terms',fixtureAgreement)).status,200);
  return req;
}
const path=(company,threadId,before)=>'collaboration/messages?'+new URLSearchParams({...company?{companyId:company}:{},...threadId?{threadId}:{},...before?{before}:{}});
const groups=company=>'collaboration/groups?companyId='+encodeURIComponent(company);
async function ok(req,p,action){const r=await req(p,action?{action}:undefined);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}

test('HTTP private chat requires consent, exact company scope, CSRF, opt-in and current group membership',async t=>{
  const {suite,company,otherCompany,employeeId,anotherEmployeeId,ids}=await setup(t),main=suite.mainUrl;
  const owner=await client(main,'owner'),a=await client(main,'staff1'),b=await client(main,'staff2'),outsider=await client(main,'peer',{accept:false});
  const external=await client(main,'external'),worker=await client(suite.workerUrl,'employee');
  assert.equal((await outsider(path(company))).status,428);
  assert.equal((await outsider('terms',fixtureAgreement)).status,200);
  assert.equal((await worker(path(company))).status,403);
  assert.equal((await a(path(otherCompany))).status,403);
  assert.equal((await a(groups(company))).status,403);
  assert.equal((await owner(groups(company),{action:{type:'save',name:'Bad roster',memberIds:[ids.external]}})).status,400);
  assert.equal((await a(path(company),{action:{type:'send',kind:'direct',target:ids.external,body:'not delivered'}})).status,404);
  assert.equal((await a(path(company),{action:{type:'send',kind:'direct',target:ids.staff2,body:'not delivered'}},{'X-CSRF-Token':'invalid'})).status,403);
  const direct=(await ok(a,path(company),{type:'send',kind:'direct',target:ids.staff2,body:'<b>literal body</b>\nInternal only'})).id;
  assert.equal((await owner(path(company))).data.threads.length,0);
  for(const account of [outsider,owner])assert.equal((await account(path(company,direct))).status,404);
  assert.equal((await external(path(company,direct))).status,403);
  assert.equal((await b(path(otherCompany,direct))).status,403);
  assert.equal((await b(path(company))).data.threads[0].unread,1);
  let opened=(await ok(b,path(company,direct))).conversation;
  assert.equal(opened.messages[0].body,'<b>literal body</b>\nInternal only');
  await ok(b,path(company),{type:'read',threadId:direct,through:opened.messages[0].id});
  assert.equal((await b(path(company))).data.threads[0].unread,0);
  assert.equal((await owner('admin/employee-features',{companyId:company,employeeId,features:['Time','Messages']})).status,200);
  const group=async(g,people)=>(await ok(owner,groups(company),{type:'save',...(g?{id:g.id,version:g.version}:{}),name:'Fixture project',memberIds:people})).groups[0];
  let roster=await group(null,[ids.staff1,ids.staff2,ids.employee]);
  const groupThread=(await ok(a,path(company),{type:'send',kind:'group',target:roster.id,body:'Fictional group message before removal'})).id;
  assert.equal((await ok(worker,path(otherCompany,groupThread))).conversation.messages.length,1,'worker is always pinned to their assigned company despite supplied query');
  assert.equal((await owner(path(company,groupThread))).status,404);
  assert.equal((await outsider(path(company,groupThread))).status,404);
  roster=await group(roster,[ids.staff1,ids.staff2]);
  assert.equal((await worker(path(company,groupThread))).status,404);
  const [oldWorker,peer]=(await ok(owner,'admin/users')).users.reduce(([w,p],u)=>[u.id===ids.employee?u:w,u.id===ids.peer?u:p],[null,null]);
  const refused=await owner('admin/user',{...oldWorker,employeeId:anotherEmployeeId});
  assert.equal(refused.status,409);assert.match(refused.data.error,/collaboration history/);
  assert.equal((await owner('admin/user',{...peer,areas:['Directory']})).status,200);
  const restricted=await client(main,'peer');
  assert.equal((await restricted(path(company))).status,403);
  assert.equal((await worker(path(company),{action:{type:'send',threadId:groupThread,body:'not delivered'}})).status,404);
  await ok(b,path(company),{type:'send',threadId:groupThread,body:'Fictional message during removal'});
  roster=await group(roster,[ids.staff1,ids.staff2,ids.employee,ids.owner]);
  assert.equal((await ok(worker,path(company,groupThread))).conversation.messages.length,0,'rejoining never restores older messages');
  assert.equal((await ok(owner,path(company,groupThread))).conversation.messages.length,0,'self-enrollment does not disclose history');
  await ok(a,path(company),{type:'send',threadId:groupThread,body:'Fictional message after adding'});
  assert.deepEqual((await ok(worker,path(company,groupThread))).conversation.messages.map(m=>m.body),['Fictional message after adding']);
  assert.equal((await ok(a,path(company,groupThread))).conversation.messages.length,3);
  assert.equal((await owner('admin/employee-features',{companyId:company,employeeId,features:['Time']})).status,200);
  assert.equal((await worker(path(company))).status,403);
  assert.ok(!(await owner('session')).data.state.companies[0].collaboration);
  const exported=(await owner('transfer/export',{password})).data;
  const exportedBooks=JSON.stringify((await inspectLite(exported.envelope,password)).state);
  assert.doesNotMatch(exportedBooks,/Fixture project|literal body|Fictional message/);
});
test('messages persist after a restart, paginate, and become unavailable when participant loses account access',async t=>{
  const x=await setup(t),{company,ids}=x,a=await client(x.suite.mainUrl,'staff1'),b=await client(x.suite.mainUrl,'staff2');
  const thread=(await ok(a,path(company),{type:'send',kind:'direct',target:ids.staff2,body:'Message 1'})).id;
  for(let i=2;i<=53;i++)await ok(a,path(company),{type:'send',threadId:thread,body:'Message '+i});
  const suite=await x.restart(),freshB=await client(suite.mainUrl,'staff2'),freshOwner=await client(suite.mainUrl,'owner');
  const page=(await ok(freshB,path(company,thread))).conversation;
  assert.equal(page.messages.length,50);
  assert.equal(page.messages.at(-1).body,'Message 53');
  assert.deepEqual((await ok(freshB,path(company,thread,page.before))).conversation.messages.map(m=>m.body),['Message 1','Message 2','Message 3']);
  const account=(await ok(freshOwner,'admin/users')).users.find(u=>u.id===ids.staff1);
  assert.equal((await freshOwner('admin/user',{...account,active:false})).status,200);
  assert.equal((await freshB(path(company,thread))).status,404);
  assert.equal((await freshB(path(company))).data.threads.length,0);
  assert.equal((await b(path(company,thread))).status,401,'restart invalidates pre-existing session');
});

const browserExe=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('owner and worker portals exchange direct and group messages; removal takes effect on refresh',{skip:!browserExe},async t=>{
  const x=await setup(t),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:browserExe,headless:true});t.after(()=>browser.close());
  const errors=[];
  const login=async(url,username)=>{
    const page=await browser.newPage({viewport:{width:1250,height:900}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);await page.goto(url);
    await page.locator('#login [name=username]').fill(username);await page.locator('#login [name=password]').fill(password);
    await page.locator('#login button').click();await acceptFixtureBrowser(page);return page;
  };
  const owner=await login(x.suite.mainUrl,'owner'),worker=await login(x.suite.workerUrl,'employee');
  const nav=name=>owner.locator('[data-act="nav"][data-key="'+name+'"]').click();
  assert.equal(await worker.locator('[data-tab=Messages]').count(),0);
  await nav('User access');
  await owner.getByRole('row').filter({has:owner.getByRole('cell',{name:/Fixture employee/})}).locator('[data-act="identity-employee-features"]').click();
  const modal=owner.locator('dialog[open]');await modal.locator('[name=features][value=Messages]').check();
  await modal.getByRole('button',{name:'Save portal features'}).click();await modal.waitFor({state:'hidden'});
  await nav('Collaboration groups');
  const setupForm=owner.locator('form[data-chat-group=""]');await setupForm.getByLabel('Group name').fill('Crew chat');
  await setupForm.getByLabel('owner · owner').check();await setupForm.getByLabel('employee · worker').check();
  await setupForm.getByRole('button',{name:'Create group',exact:true}).click();
  await owner.getByText('Crew chat · 2 account(s)',{exact:true}).waitFor();
  await nav('Messages');
  const groupForm=owner.locator('form[data-chat=group]');
  await groupForm.getByLabel('Recipient').selectOption({label:'Crew chat'});
  const literal='<em>Plain text only</em>';
  await groupForm.getByLabel('Message').fill(literal);
  await groupForm.getByRole('button',{name:'Send group message'}).click();
  await owner.getByText(literal,{exact:true}).waitFor();
  assert.equal(await owner.locator('.message-text em').count(),0);
  await worker.locator('#refresh').click();await worker.locator('[data-tab=Messages]').click();
  await worker.getByRole('button',{name:'Crew chat · group · 1 unread'}).click();
  await worker.getByText(literal,{exact:true}).waitFor();
  await worker.getByRole('button',{name:'Crew chat · group',exact:true}).waitFor();
  const direct=worker.locator('form[data-chat=direct]');
  await direct.getByLabel('Recipient').selectOption({label:'owner · owner'});
  await direct.getByLabel('Message').fill('Fictional direct message');
  await direct.getByRole('button',{name:'Send direct message'}).click();
  await worker.getByText('Fictional direct message',{exact:true}).waitFor();
  await nav('Collaboration groups');await owner.getByText('Crew chat · 2 account(s)',{exact:true}).click();
  const edit=owner.locator('details form[data-chat-group]');
  await edit.getByLabel('employee · worker').uncheck();await edit.getByRole('button',{name:'Save group membership'}).click();
  await owner.getByText('Crew chat · 1 account(s)',{exact:true}).waitFor();
  await worker.getByRole('button',{name:'Refresh messages'}).click();await worker.getByRole('button',{name:'owner · direct',exact:true}).waitFor();
  await worker.getByRole('button',{name:/Crew chat/}).waitFor({state:'detached'});
  assert.equal(await worker.getByRole('button',{name:/Crew chat/}).count(),0);
  assert.deepEqual(errors,[]);
});
