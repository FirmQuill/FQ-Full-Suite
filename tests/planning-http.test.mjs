import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {newVault,apply} from '../shared/core.mjs';
import {planningCommand} from '../shared/planning-core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash,readBooks} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {seedFixtureTerms} from './fixture-terms.mjs';

const password='Fictional planning host password';
test('self-hosted scheduler creates restart-safe drafts, supports planning UI, asserts owner and rejects stale state', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fq-full-planning-')),database=join(dir,'fiction.sqlite');
 let day='2026-02-01',suite,browser;
 const boot=()=>createSuite({database,mainPort:0,workerPort:0,planningClock:()=>day,planningIntervalMs:30});
 try{
  let state=newVault('Synthetic Planning'),c=state.companies[0],companyId=c.id;
  for(const a of [{type:'item',name:'Synthetic Business Service',kind:'Service'},{type:'contact',name:'Synthetic planning vendor',kind:'Vendor'},{type:'job',name:'Synthetic project'}])state=apply(state,companyId,{date:'2026-01-01',...a});
  c=state.companies[0];
  state=planningCommand(state,companyId,{type:'schedule-create',kind:'bill',name:'Sensitive budget title',party:c.parties[0].id,item:c.items[0].id,quantity:1,unitCents:5000,start:'2026-02-09',frequency:'monthly'},day).state;
  const db=openStore(database),hash=await passwordHash(password);
  try{tx(db,()=>{saveBooks(db,state);for(const role of ['owner','manager'])putUser(db,null,{username:'plans-'+role,name:'Planning '+role,role,assignments:role==='owner'?[]:[companyId]},hash,{bootstrap:true});});seedFixtureTerms(db);}finally{db.close();}
  suite=await boot();
  const login=async role=>{
    const origin=suite.mainUrl;
    const l=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'plans-'+role,password})});assert.equal(l.status,200);
    const cookie=l.headers.get('set-cookie').split(';')[0],s=await l.json();
    return (path,body)=>fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body?JSON.stringify(body):undefined});
  };
  let o=await login('owner');const view=()=>o('planning?companyId='+companyId).then(r=>r.json());
  assert.equal((await view()).data.drafts.length,0);
  day='2026-02-09';
  for(let tries=0;tries<100&&!(await view()).data.drafts.length;tries++)await delay(20);
  const d=(await view()).data.drafts[0];assert.equal(d.due,'2026-02-09');
  const m=await login('manager');
  assert.equal((await m('planning?companyId='+companyId)).status,403);
  const mSession=await m('session').then(r=>r.json());assert.equal(mSession.state.companies[0].planning,undefined);
  assert.equal((await o('planning',{companyId,revision:0,action:{type:'draft-copy',id:d.id}})).status,409);
  // Optional live main-portal smoke test, including a real UI save.
  const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
  if(executable){
    const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
    browser=await chromium.launch({executablePath:executable,headless:true});
    const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
    try{
      await p.goto(suite.mainUrl);
      await p.locator('#login [name=username]').fill('plans-owner');await p.locator('#login [name=password]').fill(password);await p.locator('#login button').click();
      await p.locator('nav [data-key=Planning]').click();await p.getByRole('heading',{name:'Draft inbox'}).waitFor();
      assert.equal(await p.locator('[data-act=plan-copy]').count(),1);
      await p.locator('[data-act=plan-new-budget]').click();const dialog=p.locator('dialog[open]');
      await dialog.locator('[name=name]').fill('Synthetic annual limit');await dialog.locator('[name=amount]').fill('150.00');
      await dialog.locator('button[type=submit]').click();await p.getByText('Synthetic project · Synthetic annual limit',{exact:true}).waitFor();
      assert.deepEqual(errors,[]);
    }finally{await browser.close();browser=null;}
  }
  await suite.close();suite=null;suite=await boot();o=await login('owner');
  assert.equal((await view()).data.drafts.length,1);
  const read=openStore(database);
  try{const state=readBooks(read).state;assert.equal(state.companies[0].entries.length,0);assert.equal(state.companies[0].docs.length,0);}finally{read.close();}
 }finally{await browser?.close();await suite?.close();await rm(dir,{recursive:true,force:true});}
});
