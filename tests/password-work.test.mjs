import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createPasswordWorkGate} from '../password-work.mjs';
import {createSuite} from '../server.mjs';
import {openStore,putUser,passwordHash,readBooks,saveBooks,tx} from '../store.mjs';
import {apply,newVault} from '../shared/core.mjs';
import {seedFixtureTerms} from './fixture-terms.mjs';

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('login-only queue fairly round-robins peers, retains one lane, and caps waiting without invoking overflow work',async()=>{
 const g=createPasswordWorkGate({maxQueued:4,maxPerPeer:3,waitMs:5000});
 const gates=Array.from({length:4},deferred),seen=[];
 const work=(id,wait)=>async()=>{seen.push(id);await wait;return id;};
 const inFlight=[0,1,2].map(i=>g.login('office',work('run-'+i,gates[i].promise)));
 const other=g.immediate(work('maintenance',gates[3].promise));
 for(const i of [0,1,2])assert.ok(seen.includes('run-'+i));
 await assert.rejects(g.immediate(work('never')), {status:429});
 const firstBlocked=deferred();
 const queued=['a1','a2','a3'].map(n=>g.login('office',work(n,n==='a1'?firstBlocked.promise:undefined)));
 await assert.rejects(g.login('office',work('too-many-per-peer')), {status:429,retryAfter:2});
 queued.push(g.login('remote',work('b1')));
 await assert.rejects(g.login('other',work('too-many-total')), {status:429,retryAfter:2});
 gates[0].resolve();await inFlight[0];await sleep(0);
 assert.deepEqual(seen.slice(4),['a1']);
 gates[1].resolve();await inFlight[1];await sleep(0);
 assert.deepEqual(seen.slice(4),['a1','b1','a2','a3']);
 gates[2].resolve();gates[3].resolve();firstBlocked.resolve();
 await Promise.all([...queued,...inFlight,other]);
 assert.equal(seen.some(x=>x.includes('too-many')||x==='never'),false);
 g.close();
});
test('expired, abandoned and shutdown sign-ins leave bounded wait and never execute or take another lane',async()=>{
 const g=createPasswordWorkGate({waitMs:35,maxQueued:2,maxPerPeer:2}),held=deferred();
 const active=[0,1,2].map(()=>g.login('office',()=>held.promise));
 const abandoned=new AbortController();
 let invoked=false;
 const attempt=()=>{invoked=true;};
 const cancel=g.login('office',attempt,abandoned.signal);abandoned.abort();await assert.rejects(cancel,{status:499});
 // Keep a referenced timer for the test; pending expiry timers alone never keep a host alive.
 const passed=sleep(45);
 await assert.rejects(g.login('office',attempt), {status:429,retryAfter:2});await passed;
 const pending=g.login('remote',attempt);g.close();await assert.rejects(pending,{status:429,retryAfter:2});
 await assert.rejects(g.login('remote',attempt),{status:429});
 held.resolve();await Promise.all(active);
 assert.equal(invoked,false);
});

const secret='Synthetic shift change password only!';
async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'fq-login-queue-')),database=join(folder,'fixture.sqlite');
 let state=newVault('Fictional robotics co',['employees']);const c=state.companies[0].id;
 const db=openStore(database),hash=await passwordHash(secret);
 try{tx(db,()=>{
   for(let i=0;i<15;i++)state=apply(state,c,{type:'employee',date:'2026-11-27',name:'Sample employee '+i,rate:2000,state:'WA',locality:'Seattle'});
   saveBooks(db,state);
   for(let i=0;i<15;i++){
     putUser(db,null,{username:'erp-'+i,name:'Sample ERP '+i,role:'viewer',assignments:[c],areas:['Overview']},hash,{bootstrap:true});
     putUser(db,null,{username:'worker-'+i,name:'Sample worker '+i,role:'worker',assignments:[c],employeeId:state.companies[0].employees[i].id},hash,{bootstrap:true});
   }
   seedFixtureTerms(db);
   db.prepare("DELETE FROM terms_acceptance_hashes WHERE account_id=(SELECT id FROM accounts WHERE username='erp-14')").run();
 });}finally{db.close();}
 const suite=await createSuite({database,mainPort:0,workerPort:0});
 t.after(async()=>{await suite.close();await rm(folder,{recursive:true,force:true});});
 return {suite,database,c};
}
async function login(url,username,password=secret,origin=url){
 const start=performance.now();
 const response=await fetch(url+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 return {status:response.status,elapsed:performance.now()-start,body:await response.json(),cookie:response.headers.get('set-cookie'),retry:response.headers.get('retry-after')};
}
async function request(origin,path,{cookie,csrf,body}={}){
 const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',
  headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie.split(';')[0]}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},
  body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
test('30 simultaneous distinct synthetic staff across both portals wait locally; cookie isolation, consent, origin and rate limits remain intact',async t=>{
 const {suite,database}=await fixture(t),{mainUrl,workerUrl}=suite;
 const started=performance.now(),attempts=await Promise.all(Array.from({length:15},(_,i)=>[login(mainUrl,'erp-'+i),login(workerUrl,'worker-'+i)]).flat());
 const times=attempts.map(r=>r.elapsed).sort((a,b)=>a-b),p95=times[Math.ceil(times.length*.95)-1];
 t.diagnostic(JSON.stringify({attempted:attempts.length,successful:attempts.filter(a=>a.status===200).length,wallMs:Math.round(performance.now()-started),p95Ms:Math.round(p95),maxMs:Math.round(times.at(-1))}));
 assert.ok(attempts.every(r=>r.status===200&&r.cookie&&r.body.csrf&&r.retry===null));
 assert.equal(new Set(attempts.map(r=>r.cookie)).size,30);
 assert.equal(attempts[28].body.termsRequired!==undefined,true);
 assert.equal((await request(mainUrl,'report-packets?companyId=x',{cookie:attempts[28].cookie})).status,428);
 assert.equal((await request(workerUrl,'session',{cookie:attempts[0].cookie})).status,401);
 assert.equal((await request(workerUrl,'session',{cookie:attempts[1].cookie})).status,200);
 assert.equal((await request(mainUrl,'logout',{cookie:attempts[0].cookie,body:{}})).status,403);
 assert.equal((await login(mainUrl,'erp-0',secret,'http://mismatch.invalid')).status,403);
 const known=await login(mainUrl,'erp-0','Wrong fictional password');
 const unknown=await login(mainUrl,'missing-fixture','Wrong fictional password');
 const wrongPortal=await login(workerUrl,'erp-0');
 for(const failure of [known,unknown,wrongPortal]){assert.equal(failure.status,401);assert.equal(failure.cookie,null);assert.deepEqual(failure.body,known.body);}
 const lockedAttempts=await Promise.all(Array.from({length:10},()=>login(mainUrl,'never-valid','Wrong fictional password')));
 assert.ok(lockedAttempts.every(r=>r.status===401));
 const eleventh=await login(mainUrl,'never-valid','Wrong fictional password');assert.equal(eleventh.status,429);
 assert.match(eleventh.body.error,/Too many attempts/);assert.equal(eleventh.cookie,null);
 // Deactivation still invalidates an existing authenticated session.
 const db=openStore(database);
 try{db.prepare("UPDATE accounts SET active=0,authVersion=authVersion+1 WHERE username='erp-0'").run();}finally{db.close();}
 assert.equal((await request(mainUrl,'session',{cookie:attempts[0].cookie})).status,401);
});
