import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {activationFixture} from './fixture-activation.mjs';

test('public package has no agent implementation, protects existing history and retains ordinary workflows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'fq-public-no-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime');await buildPublicRelease(runtime);
 const app=n=>import(pathToFileURL(join(runtime,n)));
 for(const name of ['agent-access.mjs','mcp-agent.mjs','agent-action-policy.mjs','agent-bookkeeping.mjs','agent-project-tasks.mjs','agent-workplaces.mjs','paid-update-check.mjs','worker-help.mjs'])await assert.rejects(stat(join(runtime,name)),{code:'ENOENT'});
 const manifest=await readFile(join(runtime,'SHA256SUMS.txt'),'utf8');assert.doesNotMatch(manifest,/(agent-access|mcp-agent|worker-help|paid-update-check)/i);
 const {openStore,saveBooks,putUser,passwordHash}=await app('store.mjs'),{newVault}=await app('shared/core.mjs'),{createSuite}=await app('server.mjs');
 const password='Fictional no-agent endpoint check.',database=join(root,'historical.sqlite'),db=openStore(database),state=newVault('Fictional workspace');
 try{
  saveBooks(db,state);putUser(db,null,{username:'owner',name:'Fictional owner',role:'owner',assignments:[]},await passwordHash(password),{bootstrap:true});
  // Fixture stands in for old inert historical rows; current runtime never reads them.
  db.exec("CREATE TABLE agent_grants(id TEXT PRIMARY KEY);INSERT INTO agent_grants VALUES('fictional-past-grant');CREATE TABLE agent_proposals(id TEXT PRIMARY KEY,status TEXT);INSERT INTO agent_proposals VALUES('fictional-past-request','pending');");
 }finally{db.close();}
 const fx=await activationFixture(root),s=await createSuite({database,mainPort:0,workerPort:0,activationOptions:fx.options});
 try{
  const main=await(await fetch(s.mainUrl+'/app.mjs')).text(),connected=await(await fetch(s.mainUrl+'/connected-admin.mjs')).text(),groups=await(await fetch(s.mainUrl+'/navigation-groups.mjs')).text();
  assert.doesNotMatch(main+connected+groups,/(Agent access|agent-admin|agent-(grant|review|revoke|cleanup)|Ask AI)/i);
  assert.match(connected,/Find matching guidance/);assert.equal((await fetch(s.mainUrl+'/legal/legal.html')).status,200);
  assert.equal((await fetch(s.mainUrl+'/mcp-agent.mjs')).status,404);
  assert.equal((await fetch(s.mainUrl+'/agent-access.mjs')).status,404);
  assert.equal((await fetch(s.mainUrl+'/api/agents/v1/capabilities',{headers:{Authorization:'Bearer fqag_fictional_previous_token_only'}})).status,401);
  let cookie,csrf;
  const req=async(path,body)=>{const r=await fetch(s.mainUrl+'/api/'+path,{method:body?'POST':'GET',headers:{Origin:s.mainUrl,'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const login=await req('login',{username:'owner',password});assert.equal(login.status,200);cookie=login.cookie;csrf=login.data.csrf;
  assert.equal((await req('terms',fixtureAgreement)).status,200);
  const before=await req('session');
  for(const [path,payload] of [['agents/v1/capabilities'],['agents/v1/records'],['agents/v1/proposals',{companyId:state.companies[0].id,action:{type:'contact',name:'Fictional record',kind:'Vendor',date:'2026-11-27'}}],['agent-admin'],['agent-admin/action',{type:'decide',id:'fictional-past-request',decision:'approve',revision:before.data.revision}]]){
   const response=await req(path,payload);assert.equal(response.status,404,path);
  }
  const legacyMixedCode=fx.mint({modules:['expanded_agent','private-support'],expiresAt:Math.floor(Date.now()/1000)+3600});
  assert.equal((await req('module-activation',{code:legacyMixedCode})).status,400);
  assert.equal((await req('module-activation',{code:fx.mint({modules:['private-support']})})).status,200);
  assert.equal((await req('agents/v1/records')).status,404);
  assert.deepEqual((await req('session')).data.state,before.data.state);
  assert.equal((await req('manual-payroll?companyId='+state.companies[0].id)).status,200);
  assert.equal((await req('support/info?scope=public')).data.scope,'public-setup-only');
  assert.equal((await req('managed-backups')).status,200);
 }finally{await s.close();}
 const preserved=new DatabaseSync(database,{readOnly:true});
 try{assert.equal(preserved.prepare('SELECT id FROM agent_grants').get().id,'fictional-past-grant');assert.equal(preserved.prepare('SELECT status FROM agent_proposals').get().status,'pending');}finally{preserved.close();}
});
