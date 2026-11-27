import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSuite} from '../server.mjs';
import {createAddonWorkspaceBridge} from '../addon-workspace-broker.mjs';
import {openStore,saveBooks,putUser,passwordHash} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

async function fixture(t,{publicOrigins=false}={}){
  const root=await mkdtemp(join(tmpdir(),'fq-addon-workspace-')),database=join(root,'fictional.sqlite'),password='Fictional delegated workspace verification.';let suite;
  t.after(async()=>{try{await suite?.close();}finally{await rm(root,{recursive:true,force:true});}});
  const state=sampleVault(),companyId=state.companies[0].id,db=openStore(database),hash=await passwordHash(password),ids={};
  try{saveBooks(db,state);for(const role of ['owner','manager'])ids[role]=putUser(db,null,{username:role,name:'Fictional '+role,role,assignments:role==='owner'?[]:[companyId]},hash,{bootstrap:true});}finally{db.close();}
  let bridge,context;
  const mainOrigin=publicOrigins?'https://books.fictional.example.com':undefined,workerOrigin=publicOrigins?'https://workers.fictional.example.com':undefined;
  suite=await createSuite({database,mainPort:0,workerPort:0,mainOrigin,workerOrigin,workspaceBridgeFactory:options=>{context=options;bridge=createAddonWorkspaceBridge(options);return bridge;},planningClock:()=> '2026-11-27'});
  assert.equal(typeof bridge,'function','createSuite must invoke the trusted workspaceBridgeFactory hook with its real session Map.');
  const login=async(role,{accept=true}={})=>{
    const headers={Host:mainOrigin?new URL(mainOrigin).host:new URL(suite.mainUrl).host,Origin:mainOrigin||suite.mainUrl,'Content-Type':'application/json'};
    const response=await fetch(suite.mainUrl+'/api/login',{method:'POST',headers,body:JSON.stringify({username:role,password})}),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
    if(data.termsRequired&&accept){const r=await fetch(suite.mainUrl+'/api/terms',{method:'POST',headers:{...headers,Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrf},body:JSON.stringify(fixtureAgreement)});assert.equal(r.status,200);await r.json();}
  };
  const approval=()=>({id:ids.owner,authVersion:context.db.prepare('SELECT authVersion FROM accounts WHERE id=?').get(ids.owner).authVersion});
  const request=(op,input,override={})=>bridge(op,input,{approval:approval(),addonId:'fictional-ai',...override});
  return {suite,context,request,login,companyId,ids,approval};
}

test('real delegated workspace APIs read books/accounts, write a balanced ledger and company note, and redact parent session credentials',{timeout:30000},async t=>{
  const x=await fixture(t);await x.login('owner');const size=x.context.sessions.size;
  const before=await x.request('workspace.read',{path:'/api/session'});assert.equal(before.user.role,'owner');assert.equal(Object.hasOwn(before,'csrf'),false);assert.equal(x.context.sessions.size,size);
  const company=before.state.companies.find(c=>c.id===x.companyId),entryCount=company.entries.length;
  const posted=await x.request('workspace.write',{path:'/api/action',body:{companyId:x.companyId,revision:before.revision,action:{type:'journal',requestId:randomUUID(),label:'Fictional delegated contribution',date:'2026-11-27',lines:[['1000',12345],['3000',-12345]],flow:'Financing'}}});
  const updated=posted.state.companies.find(c=>c.id===x.companyId);assert.equal(updated.entries.length,entryCount+1);assert.equal(updated.entries.at(-1).lines.reduce((n,line)=>n+line.cents,0),0);assert.equal(Object.hasOwn(posted,'csrf'),false);
  const employee=await x.request('workspace.write',{path:'/api/action',body:{companyId:x.companyId,revision:posted.revision,action:{type:'employee',requestId:randomUUID(),date:'2026-11-27',name:'Fictional delegated employee',rate:2500,state:'CO',locality:'Fictional'}}});assert.ok(employee.state.companies.find(c=>c.id===x.companyId).employees.some(e=>e.name==='Fictional delegated employee'));
  const note=await x.request('workspace.write',{path:'/api/company-knowledge?companyId='+x.companyId,body:{type:'save',title:'Fictional AI review note',category:'Verification',tags:'fictional',body:'Owner-authorized fictional workspace note.'}});assert.ok(note.result.id);
  const knowledge=await x.request('workspace.read',{path:'/api/company-knowledge',query:{companyId:x.companyId,id:note.result.id}});assert.match(JSON.stringify(knowledge),/Owner-authorized fictional workspace note/);
  const accounts=await x.request('workspace.read',{path:'/api/admin/users'});assert.equal(accounts.users.find(u=>u.id===x.ids.manager).role,'manager');assert.ok(accounts.users.every(u=>!Object.hasOwn(u,'hash')&&!Object.hasOwn(u,'password')));
  assert.equal(x.context.sessions.size,size,'Every bridge session is removed after the HTTP request.');
  const events=x.context.db.prepare("SELECT detail FROM audit WHERE kind IN ('add-on workspace read','add-on workspace write')").all().map(e=>JSON.parse(e.detail)),writes=events.filter(e=>e.operation==='workspace.write'&&e.outcome==='success');
  assert.deepEqual(writes.map(e=>e.route),['/api/action','/api/action','/api/company-knowledge']);assert.ok(events.some(e=>e.operation==='workspace.read'&&e.outcome==='success'));assert.ok(events.every(e=>e.addonId==='fictional-ai'&&e.ownerId===x.ids.owner&&typeof e.requestId==='string'));assert.doesNotMatch(JSON.stringify(events),/12345|Owner-authorized|Fictional delegated employee/);
  const visibleAudit=await x.request('workspace.read',{path:'/api/audit'});assert.ok(visibleAudit.events.some(e=>e.kind==='add-on workspace write'&&JSON.parse(e.detail).outcome==='success'),'Delegated outcomes are available through the ordinary audit API.');
});

test('delegated owner authorization is checked fresh for every request and retains no session on role, auth-version or Terms rejection',{timeout:30000},async t=>{
  const x=await fixture(t);await x.login('owner');const approved=x.approval(),size=x.context.sessions.size;
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session'},{approval:{id:x.ids.manager,authVersion:1}}),{status:403});
  x.context.db.prepare('UPDATE accounts SET authVersion=authVersion+1 WHERE id=?').run(x.ids.owner);
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session'},{approval:approved}),{status:403});
  x.context.db.prepare("UPDATE accounts SET role='manager' WHERE id=?").run(x.ids.owner);
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session'}),{status:403});
  x.context.db.prepare("UPDATE accounts SET role='owner',active=0 WHERE id=?").run(x.ids.owner);
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session'}),{status:403});
  x.context.db.prepare('UPDATE accounts SET active=1 WHERE id=?').run(x.ids.owner);
  x.context.db.prepare('DELETE FROM terms_acceptance_hashes WHERE account_id=?').run(x.ids.owner);
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session'}),{status:428});
  assert.equal(x.context.sessions.size,size);
});

test('host security plane, arbitrary URLs, path confusion and caller-supplied credentials cannot enter the business broker',{timeout:30000},async t=>{
  const x=await fixture(t);await x.login('owner');const size=x.context.sessions.size;
  for(const path of ['/api/login','/api/logout','/api/terms','/api/module-activation','/api/module-activation/upload','/api/addons','/api/addons/proposals','/api/passkeys/list','/api/identity','/api/identity/action','/api/managed-backups','/api/private-ftps','/api/time-kiosk-admin','/api/setup','/api/not-a-route']){
    await assert.rejects(()=>x.request('workspace.read',{path}),{status:403},path);
    await assert.rejects(()=>x.request('workspace.write',{path,body:{}}),{status:403},path);
  }
  for(const path of ['https://example.com/api/session','//example.com/api/session','/api/action/../session','/api/%73ession','/api/session#fragment','/api/session\\other'])await assert.rejects(()=>x.request('workspace.read',{path}),{status:400},path);
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session',headers:{Cookie:'caller'}}),{status:400});
  await assert.rejects(()=>x.request('workspace.read',{path:'/api/session',query:{q:'x'.repeat(2049)}}),{status:400});
  await assert.rejects(()=>x.request('workspace.write',{path:'/api/action',body:{payload:'x'.repeat(4*1024*1024)}}),{status:413});
  assert.equal(x.context.sessions.size,size,'Request failures also remove temporary sessions.');
});

test('loopback bridge uses the configured public HTTPS Host, Origin and secure cookie while transport remains local',{timeout:30000},async t=>{
  const x=await fixture(t,{publicOrigins:true});await x.login('owner');
  const before=await x.request('workspace.read',{path:'/api/session'});assert.equal(before.portalLinks.main,'https://books.fictional.example.com');
  const result=await x.request('workspace.write',{path:'/api/action',body:{companyId:x.companyId,revision:before.revision,action:{type:'contact',date:'2026-11-27',name:'Fictional secure-origin customer',kind:'Customer',requestId:randomUUID()}}});
  assert.ok(result.state.companies.find(c=>c.id===x.companyId).parties.some(p=>p.name==='Fictional secure-origin customer'));assert.equal(Object.hasOwn(result,'csrf'),false);
});
