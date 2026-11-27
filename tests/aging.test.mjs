import test from 'node:test';
import assert from 'node:assert/strict';
for(const [edition,loc] of [['full','../shared/core.mjs']]){
 const {newVault,apply,validateState,agingSnapshot,balance}=await import(loc);
 const fixture=()=>{
  let vault=newVault('Fictional aged balance');const id=vault.companies[0].id,c=()=>vault.companies[0];
  function post(type,fields){vault=apply(vault,id,{type,label:'Synthetic '+type,date:'2026-10-01',...fields});return c().docs.at(-1);}
  post('contact',{name:'Synthetic buyer',kind:'Customer'});post('contact',{name:'Synthetic vendor',kind:'Vendor'});
  post('item',{name:'Fictional design service',kind:'Service'});
  const item=c().items[0].id,party=c().parties;
  const make=(kind,amount,dueDate,fields={})=>{
   const sale=kind==='invoice',types=sale?['quote','sales order','fulfillment']:['purchase order','receiving'];
   const a=post(types[0],{party:party[sale?0:1].id,lines:[{item,qty:1,unit:amount,discount:0,location:'Main'}]});
   let b=a;for(const t of types.slice(1))b=post(t,{parent:b.id});
   return post(kind,{parent:b.id,...(dueDate?{dueDate}:{}),...fields});
  };
  return {c,post,make};
 };
 test(edition+' optional due dates preserve schema and journal amounts, and aging uses historical settlement dates',()=>{
  const x=fixture(),a=x.make('invoice',40000,'2026-10-10'),v=x.make('bill',20000,'2026-11-05'),old=x.make('invoice',2500);
  x.post('collection',{date:'2026-10-12',parent:a.id,amount:18000});
  x.post('payment',{date:'2026-10-21',parent:v.id,amount:15000});
  x.make('invoice',1000,'2026-12-10',{date:'2026-12-01'});
  assert.equal(validateState(x.c().docs.length&&{...newVault('blank'),companies:[JSON.parse(JSON.stringify(x.c()))]}),true);
  const month=agingSnapshot(x.c(),'2026-10-31'),early=agingSnapshot(x.c(),'2026-10-10');
  assert.equal(early.invoice.buckets.current,40000);assert.equal(early.invoice.buckets.unknown,2500);assert.equal(early.bill.total,20000);
  assert.equal(month.invoice.buckets['d1-30'],22000);assert.equal(month.invoice.buckets.unknown,2500);assert.equal(month.bill.buckets.current,5000);
  assert.deepEqual(month.invoice.rows.map(x=>[x.dueDate,x.open]),[['2026-10-10',22000],[null,2500]]);
  assert.equal(month.invoice.total,balance(x.c(),'1100','2026-10-31'));assert.equal(month.bill.total,-balance(x.c(),'2000','2026-10-31'));
  assert.equal(x.c().history.find(h=>h.id===a.id).dueDate,a.dueDate);
  assert.equal(Object.hasOwn(old,'dueDate'),false);
  for(const d of [a,v])assert.equal(Object.hasOwn(x.c().entries.find(e=>e.source===d.id),'dueDate'),false);
  x.post('collection',{date:'2026-11-02',parent:a.id,amount:22000});
  assert.equal(agingSnapshot(x.c(),'2026-11-03').invoice.total,2500);
 });
 test(edition+' six age buckets are exact; reject invalid due dates and non-invoice/bill date metadata',()=>{
  const x=fixture();
  for(const d of ['2026-10-31','2026-10-01','2026-09-30','2026-09-01','2026-08-31','2026-08-02','2026-08-01',''])x.make('invoice',10000,d);
  const y=agingSnapshot(x.c(),'2026-10-31').invoice;
  assert.deepEqual(y.buckets,{current:10000,'d1-30':10000,'d31-60':20000,'d61-90':20000,'d91+':10000,unknown:10000});
  assert.throws(()=>x.make('invoice',1000,'2026-02-30'),/valid calendar date/);
  const d=x.c().docs.find(o=>o.kind==='invoice');
  assert.throws(()=>x.post('collection',{parent:d.id,amount:1000,dueDate:'2026-10-31'}),/Only an invoice or bill/);
  const s={...newVault('blank'),companies:[JSON.parse(JSON.stringify(x.c()))]};s.companies[0].docs.find(y=>y.id===d.id).dueDate='2026-10-25';
  assert.throws(()=>validateState(s),/differs from posting history/);
 });
}
