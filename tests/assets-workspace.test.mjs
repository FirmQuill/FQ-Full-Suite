import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {newVault,apply,position,balance,validateState} from '../shared/core.mjs';
import {initializeAssets,assetsView,assetsCommand,validateAssetAllocations} from '../assets-workspace.mjs';

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT,role TEXT,assignments TEXT,active INTEGER);CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,companyId TEXT,kind TEXT,detail TEXT);CREATE TABLE books(body TEXT);`);
  let state=newVault('Harborline Fictional Supply',['stock']);const company=state.companies[0].id;
  for(const name of ['Fictional bolts','Fictional crates'])state=apply(state,company,{type:'item',name,kind:'Product',date:'2026-01-01'});
  const [item,second]=state.companies[0].items.map(i=>i.id);
  for(const id of [item,second])state=apply(state,company,{type:'adjust in',item:id,qty:20,amount:20000,location:'Harbor A',date:'2026-01-02'});
  state=apply(state,company,{type:'asset',name:'Harborline forklift',amount:500000,residual:0,months:60,date:'2026-01-02'});
  state=apply(state,company,{type:'company',name:'Other fictional company',activities:[],date:'2026-01-01'});
  const other=state.companies[1].id,owner={id:'owner',role:'owner',assignments:[]},auditor={id:'auditor',role:'viewer',assignments:[company]},approver={id:'approver',role:'manager',assignments:[company]},manager={id:'manager',role:'manager',assignments:[company]},worker={id:'worker',role:'worker',assignments:[company]},outsider={id:'outsider',role:'viewer',assignments:[other]};
  for(const user of [owner,auditor,approver,manager,worker,outsider])db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(user.id,user.id,user.role,JSON.stringify(user.assignments),1);
  db.prepare('INSERT INTO books VALUES(?)').run(JSON.stringify(state));initializeAssets(db);
  const act=(user,action)=>{db.exec('BEGIN');try{const result=assetsCommand(db,user,state,{companyId:company,requestId:crypto.randomUUID(),...action});if(result.state){validateState(result.state);db.prepare('UPDATE books SET body=?').run(JSON.stringify(result.state));state=result.state;}db.exec('COMMIT');return result.result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const view=(user=owner,scope={})=>assetsView(db,user,state,{companyId:company,...scope});
  for(const [user,rights] of [[auditor,['audit']],[approver,['view','approve']],[manager,['view','manage']]])act(owner,{type:'grant',accountId:user.id,rights});
  const register=(extra={})=>act(manager,{type:'register',identifier:'HL-PALLET-001',name:'Harborline pallet',kind:'pallet',location:'Harbor A',date:'2026-01-03',contents:[{itemId:item,quantity:10}],...extra});
  const count=(unitId,quantity=8)=>{const {sessionId}=act(auditor,{type:'count-start',name:'Fictional cycle count',date:'2026-01-05',unitIds:[unitId]});let row=view().sessions.find(s=>s.id===sessionId);act(auditor,{type:'count-observe',sessionId,unitId,version:row.version,location:'Harbor A',contents:quantity?[{itemId:item,quantity}]:[],note:'Two missing on physical count'});row=view().sessions.find(s=>s.id===sessionId);act(auditor,{type:'count-submit',sessionId,version:row.version});return view().sessions.find(s=>s.id===sessionId);};
  return {db,company,other,item,second,owner,auditor,approver,manager,worker,outsider,act,view,register,count,get state(){return state;},get book(){return state.companies[0];}};
}

test('asset schema upgrade is idempotent and preserves existing books, fixed assets and accounts',t=>{
  const x=fixture(t),before=JSON.stringify(x.state),accounts=x.db.prepare('SELECT * FROM accounts').all();
  initializeAssets(x.db);initializeAssets(x.db);
  assert.equal(JSON.stringify(x.state),before);assert.equal(x.db.prepare('SELECT body FROM books').get().body,before);assert.deepEqual(x.db.prepare('SELECT * FROM accounts').all(),accounts);
  assert.equal(x.db.prepare('SELECT count(*) n FROM asset_migrations').get().n,1);assert.equal(x.view().units.length,0);assert.equal(x.book.assets.length,1);
  const {unitId}=x.register();assert.equal(x.book.assets.length,1,'a pallet is not a fixed asset');assert.equal(balance(x.book,'1200'),40000,'allocating existing stock posts no duplicate inventory');
  x.register({identifier:'HL-FORK-001',kind:'asset',name:'Forklift',contents:[],fixedAssetId:x.book.assets[0].id});assert.equal(x.view().units.find(u=>u.id===unitId).kind,'pallet');
  assert.throws(()=>x.register({identifier:'hl-pallet-001'}),/already exists/);
  assert.throws(()=>x.register({identifier:'HL-PALLET-002',fixedAssetId:x.book.assets[0].id}),/Only an individual asset/);
  assert.throws(()=>x.register({identifier:'HL-PALLET-003',contents:[{itemId:x.item,quantity:11}]}),/exceed available stock/);
});

test('explicit auditor and approver rights are independent and company, worker, revocation boundaries are live',t=>{
  const x=fixture(t);const {unitId}=x.register();
  for(const user of [x.worker,x.outsider]){assert.throws(()=>x.view(user),/unavailable/);assert.throws(()=>x.act(user,{type:'count-start',name:'No',date:'2026-01-04',unitIds:[unitId]}),/unavailable/);}
  assert.equal(x.view(x.auditor,{auditOnly:true}).units.length,1);assert.equal(x.view(x.auditor).accounts.length,0);assert.equal(x.view(x.auditor).grants.length,0);
  assert.ok(!JSON.stringify(x.view(x.auditor)).includes('500000'),'asset projection does not expose fixed asset cost');
  assert.throws(()=>x.act(x.auditor,{type:'register',identifier:'NO-1'}),/manage permission/);
  assert.throws(()=>x.act(x.auditor,{type:'grant',accountId:x.auditor.id,rights:['approve']}),/Owner access/);
  const row=x.count(unitId);assert.throws(()=>x.act(x.auditor,{type:'count-review',sessionId:row.id,version:row.version,decision:'approve',reason:'Self approval',date:'2026-01-06'}),/approve permission/);
  assert.ok(!JSON.stringify(x.view(x.auditor)).includes('"value":'),'observation-only audit rights do not disclose internal stock carrying values');
  assert.throws(()=>x.act(x.approver,{type:'count-start',name:'No audit rights',date:'2026-01-04',unitIds:[unitId]}),/audit permission/);
  x.act(x.owner,{type:'grant',accountId:x.auditor.id,rights:[]});assert.throws(()=>x.view(x.auditor),/unavailable/);
  x.db.prepare('UPDATE accounts SET active=0 WHERE id=?').run(x.approver.id);assert.throws(()=>x.view(x.approver),/unavailable/);
});

test('pallet movements transfer stock with its value and append immutable dated history',t=>{
  const x=fixture(t),{unitId}=x.register();let u=x.view().units[0];
  const result=x.act(x.manager,{type:'move',unitId,version:u.version,location:'Harbor B',status:'in-transit',date:'2026-01-04',note:'Fictional delivery'});
  assert.equal(position(x.book,x.item,'Harbor A').qty,10);assert.deepEqual(position(x.book,x.item,'Harbor B'),{qty:10,value:10000});assert.equal(balance(x.book,'1200'),40000);assert.equal(result.stockSources.length,1);
  u=x.view().units.find(a=>a.id===unitId);assert.equal(u.status,'in-transit');assert.equal(u.location,'Harbor B');const m=x.view().movements[0];assert.equal(m.statusBefore,'active');assert.equal(m.statusAfter,'in-transit');assert.equal(m.from,'Harbor A');assert.equal(m.to,'Harbor B');
  assert.throws(()=>x.act(x.manager,{type:'move',unitId,version:1,location:'Harbor C',date:'2026-01-05'}),/changed/);
  assert.throws(()=>x.act(x.manager,{type:'move',unitId,version:u.version,location:'Harbor C',date:'2026-01-03'}),/precedes/);
  assert.throws(()=>x.db.prepare('UPDATE asset_movements SET body=? WHERE id=?').run('{}',m.id),/immutable/);
  assert.throws(()=>x.db.prepare('DELETE FROM asset_movements WHERE id=?').run(m.id),/immutable/);
});

test('count discrepancy preserves original quantities, approved corrections, and existing average book cost',t=>{
  const x=fixture(t),{unitId}=x.register(),s=x.count(unitId,8),before=structuredClone(s);
  assert.equal(position(x.book,x.item,'Harbor A').qty,20,'observations do not change stock');
  x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'approve',reason:'Physical recount confirmed',date:'2026-01-06'});
  const approved=x.view().sessions.find(r=>r.id===s.id);assert.equal(approved.status,'approved');assert.deepEqual(approved.expected,before.expected);assert.deepEqual(approved.observations,before.observations);assert.equal(approved.expected[0].contents[0].quantity,10);assert.equal(approved.observations[0].contents[0].quantity,8);assert.equal(approved.corrections[0].before[0].quantity,10);assert.equal(approved.corrections[0].after[0].quantity,8);assert.equal(approved.corrections[0].stockSources.length,1);
  assert.deepEqual(position(x.book,x.item,'Harbor A'),{qty:18,value:18000});assert.equal(balance(x.book,'1200'),38000);assert.equal(x.view().units[0].contents[0].quantity,8);validateState(x.state);
  assert.throws(()=>x.act(x.approver,{type:'count-review',sessionId:s.id,version:approved.version,decision:'approve',reason:'Again',date:'2026-01-07'}),/Only a submitted/);
  initializeAssets(x.db);assert.deepEqual(x.view().sessions.find(r=>r.id===s.id),approved);assert.equal(x.view().movements[0].kind,'count-approved');
});

test('positive count corrections require reviewed values and failed approvals leave sessions, quantities and history intact',t=>{
  const x=fixture(t),{unitId}=x.register(),s=x.count(unitId,12),before=JSON.stringify(x.view()),books=JSON.stringify(x.state);
  assert.throws(()=>x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'approve',reason:'Recount',date:'2026-01-06'}),/whole quantity or exact cent/);
  assert.equal(JSON.stringify(x.view()),before);assert.equal(JSON.stringify(x.state),books);
  x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'approve',reason:'Two extra at verified total cost',date:'2026-01-06',values:{[unitId]:{[x.item]:2400}}});
  assert.deepEqual(position(x.book,x.item,'Harbor A'),{qty:22,value:22400});assert.equal(x.view().sessions[0].corrections[0].after[0].quantity,12);
});

test('changed pallet, unidentified contents and location discrepancies cannot silently reconcile',t=>{
  const x=fixture(t),{unitId}=x.register(),s=x.count(unitId);
  x.act(x.manager,{type:'move',unitId,version:x.view().units[0].version,location:'Harbor A',status:'quarantine',date:'2026-01-06'});
  assert.throws(()=>x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'approve',reason:'Cannot use stale count',date:'2026-01-07'}),/changed/);
  x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'reject',reason:'Pallet moved after original count'});assert.equal(x.view().sessions[0].status,'rejected');assert.equal(x.view().sessions[0].expected[0].contents[0].quantity,10);
  const {sessionId}=x.act(x.auditor,{type:'count-start',name:'Unknown contents',date:'2026-01-07',unitIds:[unitId]});let next=x.view().sessions[0];
  x.act(x.auditor,{type:'count-observe',sessionId,unitId,version:next.version,location:'Harbor A',contents:[{itemId:x.item,quantity:10}],unknownContents:'Unidentified box'});next=x.view().sessions[0];x.act(x.auditor,{type:'count-submit',sessionId,version:next.version});next=x.view().sessions[0];
  assert.throws(()=>x.act(x.approver,{type:'count-review',sessionId,version:next.version,decision:'approve',reason:'Cannot identify',date:'2026-01-08'}),/unknown contents/);
  assert.equal(x.view().sessions[0].status,'submitted');assert.equal(x.view().sessions[0].observations[0].unknownContents,'Unidentified box');
});

test('durable request IDs never duplicate stock movement, detect changed payloads, and require current rights on replay',t=>{
  const x=fixture(t),{unitId}=x.register(),u=x.view().units[0],requestId=crypto.randomUUID();const action={type:'move',unitId,version:u.version,location:'Harbor B',date:'2026-01-04',requestId};
  x.act(x.manager,action);const before=JSON.stringify(x.state),history=x.view().movements.length;const duplicate=x.act(x.manager,action);assert.equal(duplicate.duplicate,true);assert.equal(JSON.stringify(x.state),before);assert.equal(x.view().movements.length,history);
  assert.throws(()=>x.act(x.manager,{...action,location:'Elsewhere'}),/different operation/);
  x.act(x.owner,{type:'grant',accountId:x.manager.id,rights:['view']});assert.throws(()=>x.act(x.manager,action),/manage permission/);
});

test('tracked allocation protects existing stock workflows and packing or unpacking never duplicates a ledger movement',t=>{
  const x=fixture(t),{unitId}=x.register(),u=x.view().units[0];
  const consumed=apply(x.state,x.company,{type:'adjust out',item:x.item,qty:11,location:'Harbor A',date:'2026-01-04'});
  assert.throws(()=>validateAssetAllocations(x.db,consumed),/Unpack the affected contents/);
  const before=JSON.stringify(x.state);x.act(x.manager,{type:'contents',unitId,version:u.version,contents:[{itemId:x.item,quantity:8}],date:'2026-01-04',note:'Unpacked two for fictional shipment'});
  assert.equal(JSON.stringify(x.state),before,'packing changes allocation, not stock or ledger');assert.equal(x.view().units[0].contents[0].quantity,8);assert.equal(x.view().movements[0].kind,'packed-unpacked');assert.equal(validateAssetAllocations(x.db,consumed),true);
  assert.throws(()=>x.act(x.auditor,{type:'contents',unitId,version:x.view().units[0].version,contents:[],date:'2026-01-05',note:'Not authorized'}),/manage permission/);
});

test('approval rejects stock movement after an observation even while the pallet version is unchanged',t=>{
  const x=fixture(t),{unitId}=x.register(),s=x.count(unitId,8),original=x.view().units[0];
  const changed=apply(x.state,x.company,{type:'adjust in',item:x.item,qty:1,amount:1000,location:'Harbor A',date:'2026-01-06'});x.state.companies=changed.companies;
  assert.equal(x.view().units[0].version,original.version);assert.throws(()=>x.act(x.approver,{type:'count-review',sessionId:s.id,version:s.version,decision:'approve',reason:'Stale stock snapshot',date:'2026-01-07'}),/Stock changed since the observation/);assert.equal(x.view().sessions[0].status,'submitted');assert.deepEqual(x.view().sessions[0].observations[0].contents,[{itemId:x.item,quantity:8}]);
});
