import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {newVault,apply,validateState} from '../shared/core.mjs';
import {initializeWorker,workerCommand,workerView,workerPending,workerReview} from '../worker.mjs';

const first='2026-03-08T06:30:00Z', last='2026-03-08T10:30:00Z', later='2026-03-09T12:00:00Z';
function fixture(t) {
  const prior=process.env.FIRMQUILL_TIMEZONE;
  process.env.FIRMQUILL_TIMEZONE='America/Denver';
  t.after(()=>{if(prior===undefined)delete process.env.FIRMQUILL_TIMEZONE;else process.env.FIRMQUILL_TIMEZONE=prior;});
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  initializeWorker(db);
  let state=newVault('Synthetic Works',['time']);
  const cid=state.companies[0].id;
  for(const a of [
    {type:'employee',name:'Worker One',rate:3000,state:'CO',locality:'Test city'},
    {type:'employee',name:'Worker Two',rate:5900,state:'CO',locality:'Test city'},
    {type:'job',name:'Synthetic service visit'},
    {type:'company',name:'Other synthetic book',activities:[]}
  ])state=apply(state,cid,{...a,date:'2026-01-01'});
  const c=state.companies[0], worker={id:'one',role:'worker',assignments:[cid],employeeId:c.employees[0].id};
  const manager={id:'manager',role:'manager',assignments:[cid]};
  function act(type,at,body={},u=worker){return workerCommand(db,u,state,{type,...(type==='clock-out'?{shiftId:view(u).openShift?.id}:{}),...body},new Date(at));}
  function view(u=worker){return workerView(db,u,state);}
  function pending(u=manager){return workerPending(db,u,state);}
  function decide(id,decision='approve',u=manager){state=workerReview(db,u,state,id,decision,new Date(later));}
  function shift(){act('clock-in',first,{jobId:c.jobs[0].id});act('clock-out',last);return view().shifts[0].id;}
  return {db,worker,manager,cid,job:c.jobs[0].id,second:c.employees[1].id,other:state.companies[1].id,view,act,shift,pending,decide,get state(){return state;}};
}

test('server punches, competing clocks, limited worker projection and actual DST minutes',t=>{
  const x=fixture(t);
  x.act('clock-in',first,{jobId:x.job,start:'1999-01-01T00:00:00Z',employeeId:x.second});
  assert.equal(x.view().openShift.start,'2026-03-08T06:30:00.000Z');
  assert.throws(()=>x.act('clock-in',first,{jobId:x.job}),/already open/);
  assert.throws(()=>x.act('clock-out',last,{shiftId:'obsolete'}),/changed/);
  x.act('clock-out',last);
  assert.throws(()=>x.act('clock-out',last),/No open shift/);
  const request=x.pending()[0];
  assert.equal(x.view().time.length,0);
  x.decide(request.id);
  assert.deepEqual(x.view().time.map(({date,minutes,approved})=>[date,minutes,approved]),[
    ['2026-03-07',30,true],['2026-03-08',210,true]
  ]);
  assert.equal(x.state.companies[0].time.reduce((n,t)=>n+t.cost,0),12000);
  assert.ok(!JSON.stringify(x.view()).includes('Worker Two'));
  assert.ok(!JSON.stringify(x.view()).includes('Other synthetic book'));
  for(const name of ['rate','cost','entries','bank','hash'])assert.ok(!Object.hasOwn(x.view().time[0],name));
  assert.throws(()=>x.decide(request.id),/already reviewed/);
});
test('approved correction supersedes original payroll minutes and preserves linked originals',t=>{
  const x=fixture(t),shiftId=x.shift(); x.decide(x.pending()[0].id);
  const originals=structuredClone(x.state.companies[0].time);
  x.act('correction',later,{shiftId,start:'2026-03-08T07:00:00Z',end:'2026-03-08T09:30:00Z',reason:'Missed break'});
  assert.equal(x.view().time.reduce((n,t)=>n+t.minutes,0),240);
  x.decide(x.pending()[0].id);
  const c=x.state.companies[0];
  assert.equal(c.time.length,1); assert.equal(c.time[0].minutes,150); assert.equal(c.time[0].cost,7500);
  assert.deepEqual(c.history.at(-1).workerTimeReview.priorTime,originals);
  assert.deepEqual(c.history.at(-1).workerTimeReview.newTime,[c.time[0].id]);
  assert.equal(x.view().shifts[0].start,'2026-03-08T06:30:00.000Z');
  assert.equal(x.view().shifts[0].reviews.filter(r=>r.status==='approved').length,2);
  validateState(x.state);
});
test('manager authority, worker assignment and correction read/write boundaries',t=>{
  const x=fixture(t),shiftId=x.shift();
  const other={...x.worker,id:'two',employeeId:x.second};
  assert.deepEqual(x.view(other).shifts,[]);
  assert.throws(()=>x.act('correction',later,{shiftId,start:first,end:last,reason:'Change'},other),/unavailable/);
  assert.throws(()=>x.view({...x.worker,assignments:[x.other]}),/unavailable/);
  assert.throws(()=>x.view(x.manager),/Worker access/);
  assert.deepEqual(x.pending({...x.manager,assignments:[x.other]}),[]);
  assert.throws(()=>x.decide(x.pending()[0].id,'approve',{...x.manager,assignments:[x.other]}),/unavailable/);
  assert.throws(()=>x.decide(x.pending()[0].id,'approve',x.worker),/Manager access/);
  assert.throws(()=>x.decide(x.pending()[0].id,'approve',{...x.manager,id:x.worker.id}),/own time/);
});
test('correction before first approval can be rejected or approved without double counting',t=>{
  const x=fixture(t),shiftId=x.shift();
  const request={shiftId,start:first,end:'2026-03-08T10:15:00Z',reason:'Forgot to clock out'};
  x.act('correction',later,request);
  assert.throws(()=>x.act('correction',later,request),/already awaits/);
  const original=x.pending().find(r=>r.kind==='Timesheet');
  assert.throws(()=>x.decide(original.id),/pending correction/);
  x.decide(x.pending().find(r=>r.kind==='Correction').id,'reject');
  assert.equal(x.pending().length,1); assert.equal(x.view().time.length,0);
  x.act('correction',later,request); x.decide(x.pending().find(r=>r.kind==='Correction').id);
  assert.equal(x.pending().length,0); assert.equal(x.view().shifts[0].reviews.find(r=>r.kind==='Timesheet').status,'superseded');
  assert.equal(x.state.companies[0].time.reduce((n,t)=>n+t.minutes,0),225);
});
test('abnormal short and long shifts can be closed and reviewed after a correction',t=>{
  const x=fixture(t);
  x.act('clock-in',first,{jobId:x.job});x.act('clock-out',first);
  assert.throws(()=>x.decide(x.pending()[0].id),/one minute/);
  x.decide(x.pending()[0].id,'reject');
  x.act('clock-in',last,{jobId:x.job});x.act('clock-out',later);
  assert.throws(()=>x.decide(x.pending()[0].id),/24 hours/);
  const id=x.view().shifts[0].id;
  assert.throws(()=>x.act('correction',later,{shiftId:id,start:first,end:later,reason:'too long'}),/24 hours/);
  assert.throws(()=>x.act('correction',later,{shiftId:id,start:last,end:'2026-03-12T08:00:00Z',reason:'future'}),/future/);
  x.act('correction',later,{shiftId:id,start:last,end:'2026-03-08T11:30:00Z',reason:'Missed punch'});
  x.decide(x.pending().find(r=>r.kind==='Correction').id);
  assert.equal(x.view().time[0].minutes,60);
});
test('no overlapping approved intervals and no retroactive corrections in closed periods',t=>{
  const x=fixture(t),s=x.shift();x.decide(x.pending()[0].id);
  x.act('clock-in','2026-03-08T11:00:00Z',{jobId:x.job});x.act('clock-out','2026-03-08T12:00:00Z');x.decide(x.pending()[0].id);
  x.act('correction',later,{shiftId:s,start:first,end:'2026-03-08T11:30:00Z',reason:'Overlap'});
  assert.throws(()=>x.decide(x.pending()[0].id),/overlaps/);x.decide(x.pending()[0].id,'reject');
  x.act('correction',later,{shiftId:s,start:last,end:'2026-03-08T10:45:00Z',reason:'Change after close'});
  const closed=apply(x.state,x.cid,{type:'close',date:'2026-03-07'});
  assert.throws(()=>workerReview(x.db,x.manager,closed,x.pending()[0].id,'approve',new Date(later)),/closed period/);
  assert.equal(x.pending().length,1);
});
