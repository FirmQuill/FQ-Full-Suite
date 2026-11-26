import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,saveBooks,putUser,safeUser,tx} from '../store.mjs';
import {projectErpState,saveAreas} from '../access.mjs';
import {sampleVault} from '../shared/sample.mjs';

test('ERP area projection retains permitted document references without exposing other area attachments or embedded payroll history',()=>{
  const db=openStore(':memory:'),state=sampleVault(),company=state.companies[0];
  try{
    let account;
    tx(db,()=>{saveBooks(db,state);const id=putUser(db,null,{username:'fictional-scoped-account',name:'Fictional scoped staff',role:'manager',assignments:[company.id],areas:['Directory']},'!pending-invite:fixture',{bootstrap:true});account=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));});
    const customer=company.parties.find(p=>p.kind==='Customer'),invoice=company.docs.find(d=>d.kind==='invoice');
    assert.ok(customer&&invoice,'fixture includes distinct permitted contact and financial document');
    company.attachments.push({id:'fictional-contact-file',source:customer.id,name:'Fictional business contact file',mime:'text/plain',data:'permitted-contact'},{id:'fictional-invoice-file',source:invoice.id,name:'Fictional invoice file',mime:'text/plain',data:'restricted-financial'});
    company.history.push({id:'fictional-payroll-history',kind:'time',date:'2026-01-01',label:'Fictional time',rate:1234567,workerTimeReview:{priorTime:[{cost:7654321}]}});
    const directory=projectErpState(db,account,state).companies[0];
    assert.deepEqual(directory.attachments.map(a=>a.id),['fictional-contact-file']);assert.equal(directory.docs.length,0);assert.equal(directory.entries.length,0);
    assert.ok(!JSON.stringify(directory).includes('restricted-financial'));assert.ok(!JSON.stringify(directory).includes('1234567'));assert.ok(!JSON.stringify(directory).includes('7654321'));
    saveAreas(db,account.id,['Accounting']);
    const accounting=projectErpState(db,account,state).companies[0];
    assert.ok(accounting.entries.length);assert.deepEqual(accounting.attachments,[]);
    assert.ok(accounting.entries.every(e=>accounting.history.some(h=>h.id===e.source)),'authorized journals retain displayable source references');
    saveAreas(db,account.id,['Sales']);
    const sales=projectErpState(db,account,state).companies[0];
    assert.ok(sales.docs.some(d=>d.kind==='invoice'));assert.ok(sales.parties.every(p=>p.kind==='Customer'));assert.ok(!sales.docs.some(d=>d.kind==='bill'));
  }finally{db.close();}
});
