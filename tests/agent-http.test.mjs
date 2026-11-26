import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {openStore,putUser,passwordHash,saveBooks,tx,readBooks} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {createSuite} from '../server.mjs';
import {MCP_PROTOCOL_VERSION} from '../mcp-agent.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';

const password='Fictional API integration fixture only.';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fq-agent-fictional-')),database=join(dir,'test.sqlite'),db=openStore(database),state=sampleVault(),hash=await passwordHash(password);
  try{tx(db,()=>{
    saveBooks(db,state);const id=putUser(db,null,{username:'owner',name:'Fictional Owner',role:'owner',assignments:[]},hash,{bootstrap:true});
    putUser(db,{id,role:'owner'},{username:'manager',name:'Fictional Manager',role:'manager',assignments:[state.companies[0].id]},hash);
    putUser(db,{id,role:'owner'},{username:'worker',name:'Fictional Worker',role:'worker',assignments:[state.companies[0].id],employeeId:state.companies[0].employees[0].id},hash);
  });}finally{db.close();}
  const f={dir,database,state,suite:await createSuite({database,mainPort:0,workerPort:0})};
  t.after(async()=>{await f.suite.close();await rm(dir,{recursive:true,force:true});});return f;
}
async function login(url,username){
  const response=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username,password})}),data=await response.json();
  assert.equal(response.status,200);
  const headers={Origin:url,'Content-Type':'application/json',Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrf};
  const request=async(path,body,extra={})=>{
    const r=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  };
  if(data.termsRequired){const accepted=await request('terms',fixtureAgreement);assert.equal(accepted.status,200);return {data:accepted.data,request};}
  return {data,request};
}
async function bearer(url,token,path,body,extra={}){
  const r=await fetch(url+'/api/agents/v1/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),headers:r.headers};
}

test('HTTP agent API requires grant, blocks worker portal and browser origins, and protects owner administration',async t=>{
  const f=await fixture(t),owner=await login(f.suite.mainUrl,'owner'),manager=await login(f.suite.mainUrl,'manager'),worker=await login(f.suite.workerUrl,'worker'),companyId=f.state.companies[0].id;
  assert.equal((await manager.request('agent-admin')).status,403);
  assert.equal((await worker.request('agent-admin')).status,403);
  assert.equal((await owner.request('agent-admin/action',{type:'grant',name:'Fictional Agent',companyId},{'X-CSRF-Token':''})).status,403);
  const issued=await owner.request('agent-admin/action',{type:'grant',name:'Fictional Agent',companyId});assert.equal(issued.status,200);
  const token=issued.data.token;
  assert.equal((await bearer(f.suite.mainUrl,token,'capabilities')).status,200);
  assert.equal((await bearer(f.suite.workerUrl,token,'capabilities')).status,404);
  assert.equal((await bearer(f.suite.mainUrl,'invalid','capabilities')).status,401);
  assert.equal((await bearer(f.suite.mainUrl,token,'capabilities',undefined,{Origin:'https://fictional.invalid'})).status,403);
  const read=await bearer(f.suite.mainUrl,token,'records?'+new URLSearchParams({companyId,recordType:'contacts'}));assert.equal(read.status,200);assert.equal(read.headers.get('access-control-allow-origin'),null);
  assert.equal((await bearer(f.suite.mainUrl,token,'records?'+new URLSearchParams({companyId:f.state.companies[1].id,recordType:'contacts'}))).status,403);
  assert.equal((await bearer(f.suite.mainUrl,token,'records?'+new URLSearchParams({companyId,recordType:'employees'}))).status,403);
  const raw=await fetch(f.suite.mainUrl+'/api/agent-admin',{headers:{Authorization:'Bearer '+token}});assert.equal(raw.status,401);
  const view=await owner.request('agent-admin');assert.equal(JSON.stringify(view.data).includes(token),false);assert.equal(JSON.stringify(view.data).includes('token_hash'),false);
  assert.equal((await owner.request('agent-admin/action',{type:'revoke',id:issued.data.grant.id})).status,200);
  assert.equal((await bearer(f.suite.mainUrl,token,'capabilities')).status,401);
});

test('HTTP proposals persist through restart, require FirmQuill approval and cannot post twice',async t=>{
  const f=await fixture(t),companyId=f.state.companies[0].id;let owner=await login(f.suite.mainUrl,'owner');
  const issued=await owner.request('agent-admin/action',{type:'grant',name:'Fictional Proposed Records Agent',companyId,allowProposals:true}),token=issued.data.token;
  const input={companyId,requestId:randomUUID(),revision:owner.data.revision,action:{type:'contact',name:'Fictional API Customer',kind:'Customer',date:'2026-11-26'}};
  const proposal=await bearer(f.suite.mainUrl,token,'proposals',input);assert.equal(proposal.status,200);
  const before=await owner.request('session');assert.equal(before.data.state.companies[0].parties.some(p=>p.name===input.action.name),false);
  await f.suite.close();f.suite=await createSuite({database:f.database,mainPort:0,workerPort:0});owner=await login(f.suite.mainUrl,'owner');
  assert.equal((await bearer(f.suite.mainUrl,token,'proposal?'+new URLSearchParams({id:proposal.data.id}))).data.status,'pending');
  const manager=await login(f.suite.mainUrl,'manager');assert.equal((await manager.request('agent-admin/action',{type:'decide',id:proposal.data.id,decision:'approve',revision:owner.data.revision})).status,403);
  assert.equal((await owner.request('agent-admin/action',{type:'decide',id:proposal.data.id,decision:'approve',revision:owner.data.revision})).status,200);
  const after=await owner.request('session');assert.equal(after.data.state.companies[0].parties.filter(p=>p.name===input.action.name).length,1);
  assert.equal((await owner.request('agent-admin/action',{type:'decide',id:proposal.data.id,decision:'approve',revision:after.data.revision})).status,409);
  assert.equal((await bearer(f.suite.mainUrl,token,'proposals',input)).data.status,'approved');
  await f.suite.close();f.suite=await createSuite({database:f.database,mainPort:0,workerPort:0});owner=await login(f.suite.mainUrl,'owner');
  assert.equal(owner.data.state.companies[0].parties.filter(p=>p.name===input.action.name).length,1);
  assert.equal((await bearer(f.suite.mainUrl,token,'proposal?'+new URLSearchParams({id:proposal.data.id}))).data.status,'approved');
});

test('optional MCP process uses the same scoped HTTP grant and never prints its credential',async t=>{
  const f=await fixture(t),owner=await login(f.suite.mainUrl,'owner'),companyId=f.state.companies[0].id;
  const issued=await owner.request('agent-admin/action',{type:'grant',name:'Fictional MCP Agent',companyId}),token=issued.data.token;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../mcp-agent.mjs',import.meta.url))],{windowsHide:true,env:{...process.env,FIRMQUILL_AGENT_URL:f.suite.mainUrl,FIRMQUILL_AGENT_TOKEN:token},stdio:['pipe','pipe','pipe']});
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'Fictional MCP Client',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'firmquill_read_records',arguments:{companyId,recordType:'contacts'}}}];
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Fictional MCP test timed out.'));},15000);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve(code);});});
  child.stdin.end(messages.map(m=>JSON.stringify(m)+'\n').join(''));
  assert.equal(await closed,0);assert.equal(stderr,'');assert.equal(stdout.includes(token),false);
  const results=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(results.length,3);
  const records=JSON.parse(results[2].result.content[0].text);assert.equal(records.company.id,companyId);assert.equal(records.recordType,'contacts');assert.equal(records.records.length,1);
});

test('encrypted whole-database recovery retains agent grants, pending review and independent revocation',async t=>{
  const f=await fixture(t),owner=await login(f.suite.mainUrl,'owner'),companyId=f.state.companies[0].id;
  const issued=await owner.request('agent-admin/action',{type:'grant',name:'Fictional recovery agent',companyId,allowProposals:true}),token=issued.data.token;
  const proposal=await bearer(f.suite.mainUrl,token,'proposals',{companyId,requestId:randomUUID(),revision:owner.data.revision,action:{type:'contact',name:'Fictional Recovery Customer',kind:'Customer',date:'2026-11-26'}});
  const archive=join(f.dir,'fictional-agent.fqdb'),copy=join(f.dir,'recovered.sqlite');await backupDatabase(f.database,archive,password);await restoreDatabase(archive,copy,password);
  const recovered=await createSuite({database:copy,mainPort:0,workerPort:0});
  try{
    const restoredOwner=await login(recovered.mainUrl,'owner');
    assert.equal((await bearer(recovered.mainUrl,token,'proposal?'+new URLSearchParams({id:proposal.data.id}))).data.status,'pending');
    assert.equal((await restoredOwner.request('agent-admin/action',{type:'decide',id:proposal.data.id,decision:'approve',revision:restoredOwner.data.revision})).status,200);
    assert.equal((await restoredOwner.request('agent-admin/action',{type:'revoke',id:issued.data.grant.id})).status,200);
    assert.equal((await bearer(recovered.mainUrl,token,'capabilities')).status,401);
    assert.equal((await bearer(f.suite.mainUrl,token,'capabilities')).status,200);
    assert.equal((await bearer(f.suite.mainUrl,token,'proposal?'+new URLSearchParams({id:proposal.data.id}))).data.status,'pending');
    const original=await owner.request('session');assert.equal(original.data.state.companies[0].parties.some(p=>p.name==='Fictional Recovery Customer'),false);
  }finally{await recovered.close();}
});
