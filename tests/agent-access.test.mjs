import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {openStore,readBooks,saveBooks,putUser,safeUser,tx,actionFor} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {createAgentService} from '../agent-access.mjs';
import {createMcpHandler,MCP_PROTOCOL_VERSION} from '../mcp-agent.mjs';
import {seedFixtureTerms} from './fixture-terms.mjs';

function fixture(t){
  const db=openStore(':memory:'),state=sampleVault();tx(db,()=>saveBooks(db,state));
  const ownerId=tx(db,()=>putUser(db,null,{username:'fictional-owner',name:'Fictional Owner',role:'owner',assignments:[]},'!fixture-only',{bootstrap:true}));
  const owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(ownerId));
  const managerId=tx(db,()=>putUser(db,owner,{username:'fictional-manager',name:'Fictional Manager',role:'manager',assignments:[state.companies[0].id]},'!fixture-only'));
  const manager=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(managerId));
  seedFixtureTerms(db);const service=createAgentService({db});t.after(()=>db.close());
  const grant=(options={})=>service.command(owner,{type:'grant',companyId:state.companies[0].id,name:'Fictional local agent',...options});
  const request=(token,path,body)=>service.request(body===undefined?'GET':'POST',new URL('http://127.0.0.1/api/agents/v1/'+path),{authorization:'Bearer '+token},body);
  return {db,state,owner,manager,service,grant,request};
}

test('agent grants use hashed tokens, safe projections, company/type isolation and server-side owner checks',t=>{
  const {db,state,owner,manager,service,grant,request}=fixture(t),issued=grant(),companyId=state.companies[0].id;
  const table=db.prepare('SELECT * FROM agent_grants').get();assert.notEqual(table.token_hash,issued.token);assert.equal(table.token_hash.length,64);
  assert.equal(JSON.stringify(service.view(owner)).includes(issued.token),false);
  const data=request(issued.token,'records?'+new URLSearchParams({companyId,recordType:'contacts',limit:'1'}));
  assert.equal(data.records.length,1);assert.equal(data.nextCursor,null);assert.deepEqual(Object.keys(data.records[0]).sort(),['id','kind','name']);
  assert.equal(Object.hasOwn(data,'employees'),false);assert.equal(data.company.id,companyId);
  assert.throws(()=>request(issued.token,'records?'+new URLSearchParams({companyId:state.companies[1].id,recordType:'contacts'})),{status:403});
  for(const type of ['items','payroll','personnel','history','journals','files','employees'])assert.throws(()=>request(issued.token,'records?'+new URLSearchParams({companyId,recordType:type})),{status:403});
  assert.throws(()=>request(issued.token,'records?'+new URLSearchParams({companyId,recordType:'contacts',limit:'101'})),{status:400});
  assert.throws(()=>service.view({...manager,role:'owner'}),{status:403});
  assert.throws(()=>service.command(manager,{type:'revoke',id:issued.grant.id}),{status:403});
  assert.throws(()=>service.command(owner,{type:'grant',companyId,name:'Unsafe',recordTypes:['employees']}),{status:400});
  assert.throws(()=>service.request('GET',new URL('http://localhost/api/agents/v1/capabilities'),{authorization:'Bearer '+issued.token,origin:'https://external.invalid'}),{status:403});
  const expanded=grant({recordTypes:['items','invoices','bills']});
  for(const type of ['items','invoices','bills']){
    const result=request(expanded.token,'records?'+new URLSearchParams({companyId,recordType:type}));
    assert.ok(result.records.every(r=>!('label' in r)&&!('data' in r)&&!('memo' in r)&&!('employee' in r)));
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(issued.token),false);
});

test('agent changes remain proposals until owner review, deduplicate and cannot call arbitrary operations',t=>{
  const {db,state,owner,manager,service,grant,request}=fixture(t),issued=grant({allowProposals:true}),companyId=state.companies[0].id;
  const before=readBooks(db),input={companyId,requestId:randomUUID(),revision:before.revision,action:{type:'contact',name:'Fictional Proposed Customer',kind:'Customer',date:'2026-11-26'}};
  const p=request(issued.token,'proposals',input);assert.equal(p.status,'pending');assert.deepEqual(readBooks(db),before);
  assert.deepEqual(request(issued.token,'proposals',input),p);
  assert.throws(()=>request(issued.token,'proposals',{...input,action:{...input.action,name:'Different'}}),{status:409});
  assert.throws(()=>request(issued.token,'proposals',{...input,requestId:randomUUID(),action:{...input.action,type:'employee'}}),{status:403});
  assert.throws(()=>request(issued.token,'proposals',{...input,requestId:randomUUID(),action:{...input.action,rate:6000}}),{status:400});
  assert.throws(()=>request(issued.token,'action',input),{status:404});
  assert.throws(()=>service.command(manager,{type:'decide',id:p.id,decision:'approve',revision:before.revision}),{status:403});
  assert.equal(service.command(owner,{type:'decide',id:p.id,decision:'approve',revision:before.revision}).status,'approved');
  const after=readBooks(db);assert.equal(after.state.companies[0].parties.length,before.state.companies[0].parties.length+1);
  assert.equal(after.state.companies[1].parties.length,before.state.companies[1].parties.length);
  assert.throws(()=>service.command(owner,{type:'decide',id:p.id,decision:'approve',revision:after.revision}),{status:409});
  assert.equal(request(issued.token,'proposal?'+new URLSearchParams({id:p.id})).status,'approved');
  const other=grant();assert.throws(()=>request(other.token,'proposal?'+new URLSearchParams({id:p.id})),{status:404});
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE kind='agent proposal approved'").get());
});

test('stale approvals, rejected proposals, grant revocation and issuer changes cannot alter books',t=>{
  const {db,state,owner,service,grant,request}=fixture(t),issued=grant({allowProposals:true}),companyId=state.companies[0].id;
  const input={companyId,requestId:randomUUID(),revision:readBooks(db).revision,action:{type:'contact',name:'Fictional Stale Contact',kind:'Vendor',date:'2026-11-26'}};
  const p=request(issued.token,'proposals',input);
  tx(db,()=>actionFor(db,owner,{companyId,revision:readBooks(db).revision,action:{type:'contact',name:'Fictional Concurrent Contact',kind:'Customer',date:'2026-11-26',requestId:randomUUID()}}));
  const current=readBooks(db);
  assert.throws(()=>service.command(owner,{type:'decide',id:p.id,decision:'approve',revision:current.revision}),{status:409});
  assert.deepEqual(readBooks(db),current);assert.equal(service.view(owner).proposals[0].status,'pending');
  service.command(owner,{type:'decide',id:p.id,decision:'reject',revision:current.revision});assert.deepEqual(readBooks(db),current);
  const next=request(issued.token,'proposals',{...input,revision:current.revision,requestId:randomUUID()});
  service.command(owner,{type:'revoke',id:issued.grant.id});
  assert.throws(()=>request(issued.token,'capabilities'),{status:401});
  assert.throws(()=>service.command(owner,{type:'decide',id:next.id,decision:'approve',revision:current.revision}),{status:401});
  assert.deepEqual(readBooks(db),current);
  const active=grant();db.prepare('UPDATE accounts SET authVersion=authVersion+1 WHERE id=?').run(owner.id);
  assert.throws(()=>request(active.token,'capabilities'),{status:401});
  assert.throws(()=>service.view(owner),{status:403});
});

test('bearer credentials cannot bypass a missing current owner agreement',t=>{
  const {db,owner,grant,request}=fixture(t),issued=grant();
  db.prepare('DELETE FROM terms_acceptance_hashes WHERE account_id=?').run(owner.id);
  assert.throws(()=>request(issued.token,'capabilities'),{status:428});
  seedFixtureTerms(db);assert.equal(request(issued.token,'capabilities').apiVersion,'1');
});

test('MCP pinned stdio lifecycle exposes scoped API tools and contains service errors',async()=>{
  const calls=[],handle=createMcpHandler({requestApi:async(...args)=>{calls.push(args);if(args[1]==='proposals')throw Error('secret should not escape');return {ok:true};}});
  assert.equal((await handle({jsonrpc:'2.0',id:1,method:'tools/list'})).error.code,-32000);
  assert.equal((await handle({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'unsupported'}})).error.code,-32602);
  assert.equal((await handle({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:MCP_PROTOCOL_VERSION,clientInfo:{name:'Fictional Client',version:'1'},capabilities:{}}})).result.protocolVersion,MCP_PROTOCOL_VERSION);
  assert.equal(await handle({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const list=await handle({jsonrpc:'2.0',id:4,method:'tools/list'});assert.equal(list.result.tools.length,4);
  assert.equal(list.result.tools.some(t=>/approve|payroll/.test(t.name)),false);
  const read=await handle({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'firmquill_read_records',arguments:{companyId:'fictional-company',recordType:'contacts'}}});
  assert.equal(JSON.parse(read.result.content[0].text).ok,true);assert.match(calls[0][1],/^records\?/);
  const failed=await handle({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'firmquill_propose_record',arguments:{companyId:'fictional-company',requestId:'fixture-1',revision:0,action:{}}}});
  assert.equal(failed.result.isError,true);assert.equal(JSON.stringify(failed).includes('secret should not escape'),false);
  assert.equal((await handle({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'firmquill_capabilities',arguments:{token:'not-allowed'}}})).error.code,-32602);
});
