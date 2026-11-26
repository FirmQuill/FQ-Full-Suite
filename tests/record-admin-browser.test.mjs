import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {seedFixtureTerms,acceptFixtureBrowser} from './fixture-terms.mjs';

const browserExe=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
if(browserExe)test('employee records admin forms publish reviews and real stub PDFs and preserve effective profile records',async t=>{
  const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
  const dir=await mkdtemp(join(tmpdir(),'fq-records-admin-browser-')),database=join(dir,'suite.sqlite'),password='Fictional browser test password 905!';
  let state=newVault('Fictional Browser Company',['employees','time']),company=state.companies[0].id;
  state=apply(state,company,{type:'employee',name:'Fictional Browser Worker',rate:2500,state:'CO',locality:'Fictional locality',date:'2026-01-01'});
  state=apply(state,company,{type:'job',name:'Fictional Warehouse Project',date:'2026-01-01'});
  state=apply(state,company,{type:'time',employee:state.companies[0].employees[0].id,job:state.companies[0].jobs[0].id,minutes:60,date:'2026-01-02'});
  state=apply(state,company,{type:'approve time',time:state.companies[0].time[0].id,date:'2026-01-03'});
  const employee=state.companies[0].employees[0].id,key=company+'|'+employee,db=openStore(database),hash=await passwordHash(password);
  try{tx(db,()=>{saveBooks(db,state);putUser(db,null,{username:'fictional-owner',name:'Fictional Browser Owner',role:'owner',assignments:[]},hash,{bootstrap:true});});seedFixtureTerms(db);}finally{db.close();}
  let browser,suite;
  try{
    suite=await createSuite({database,mainPort:0,workerPort:0});
    browser=await chromium.launch({executablePath:browserExe,headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    const modal=()=>page.locator('dialog[open]');
    const click=(action,keyValue)=>page.locator(`[data-act="${action}"]${keyValue?`[data-key="${keyValue}"]`:''}`).first().click();
    const submit=()=>modal().locator('button[type=submit]').click();
    const waitClosed=()=>page.locator('dialog[open]').waitFor({state:'hidden'});
    await page.goto(suite.mainUrl);await page.locator('#login [name=username]').fill('fictional-owner');await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click();await page.locator('.toolbar').waitFor();
    await click('nav','Employee records');await page.getByRole('heading',{name:'Employee records',exact:true,level:2}).waitFor();
    await click('record-contacts',company);await modal().locator('[name=contactName0]').fill('Fictional HR Contact');await modal().locator('[name=contactEmail0]').fill('hr@example.invalid');await modal().locator('[name=contactPhone0]').fill('555-0101');
    await modal().locator('[name=contactName1]').fill('Fictional Payroll Contact');await modal().locator('[name=contactEmail1]').fill('payroll@example.invalid');await modal().locator('[name=hrContact]').selectOption('0');await modal().locator('[name=payrollContact]').selectOption('1');await submit();await waitClosed();
    await click('record-detail',key);await click('record-profile',key);await modal().locator('[name=hireDate]').fill('2026-01-01');await modal().locator('[name=department]').fill('Warehouse');await modal().locator('[name=title]').fill('Fictional Associate');await modal().locator('[name=location]').fill('Fictional warehouse');await modal().locator('[name=workEmail]').fill('worker@example.invalid');await modal().locator('[name=effectiveDate]').fill('2026-01-01');await modal().locator('[name=reason]').fill('Fictional onboarding record');await submit();await waitClosed();
    await page.getByRole('cell',{name:'Warehouse · Fictional Associate',exact:true}).waitFor();
    await click('record-detail',key);assert.match(await modal().innerText(),/Fictional HR Contact/);assert.match(await modal().innerText(),/Fictional Payroll Contact/);
    await click('record-credentials',key);await modal().locator('[name=educationName0]').fill('Fictional logistics course');await modal().locator('[name=institution0]').fill('Fictional Academy');await modal().locator('[name=certName0]').fill('Fictional warehouse certificate');await modal().locator('[name=issuer0]').fill('Fictional Training');await modal().locator('[name=issued0]').fill('2026-01-01');await submit();await waitClosed();
    await click('record-detail',key);await click('record-projects',key);await modal().locator('[name=job0]').selectOption(state.companies[0].jobs[0].id);await modal().locator('[name=start0]').fill('2026-01-01');await modal().locator('[name=role0]').fill('Fictional warehouse associate');await modal().locator('[name=effectiveDate]').fill('2026-01-01');await modal().locator('[name=reason]').fill('Fictional project assignment');await submit();await waitClosed();
    await click('record-detail',key);await click('record-review-new',key);await modal().locator('[name=title]').fill('Fictional published review');await modal().locator('[name=body]').fill('Completed the fictional warehouse onboarding course.');await modal().locator('[name=next]').selectOption('publish');await submit();await waitClosed();await page.getByRole('cell',{name:'Fictional published review',exact:true}).waitFor();
    await click('record-detail',key);await click('record-stub-upload',key);await modal().locator('[name=periodStart]').fill('2026-01-01');await modal().locator('[name=periodEnd]').fill('2026-01-15');await modal().locator('[name=payDate]').fill('2026-01-20');await modal().locator('[name=source]').fill('Fictional finalized payroll fixture');
    const fixture=Buffer.from('%PDF-1.4\n%Fictional browser test fixture only\n%%EOF\n');await modal().locator('[name=file]').setInputFiles({name:'fictional-finalized.pdf',mimeType:'application/pdf',buffer:fixture});await modal().locator('[name=finalized]').check();await submit();await waitClosed();
    const downloadable=page.waitForEvent('download');await page.getByRole('link',{name:'Download finalized PDF'}).click();const downloaded=await downloadable;assert.deepEqual(await readFile(await downloaded.path()),fixture);
    await click('record-detail',key);const text=await modal().innerText();assert.match(text,/Fictional logistics course/);assert.match(text,/Fictional warehouse certificate/);assert.match(text,/Fictional Warehouse Project/);assert.match(text,/2026-01-01/);
    const created=await page.evaluate(async({company,password})=>{
      const session=await fetch('/api/session',{cache:'no-store'}).then(r=>r.json());
      const response=await fetch('/api/admin/user',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({username:'fictional-time-manager',name:'Fictional Time Manager',role:'manager',assignments:[company],employeeId:'',active:true,password,areas:['Jobs & time']})});return response.status;
    },{company,password});assert.equal(created,200);
    const restrictedContext=await browser.newContext(),restricted=await restrictedContext.newPage();restricted.on('pageerror',e=>errors.push(e.message));
    await restricted.goto(suite.mainUrl);await restricted.locator('#login [name=username]').fill('fictional-time-manager');await restricted.locator('#login [name=password]').fill(password);await restricted.locator('#login button').click();await acceptFixtureBrowser(restricted);await restricted.getByRole('heading',{name:'Jobs',exact:true,level:2}).waitFor();
    const work=await restricted.locator('.workspace').innerText();assert.match(work,/Fictional Warehouse Project/);assert.match(work,/Fictional Browser Worker/);assert.ok(!work.includes('$25.00'));assert.ok(!/Hourly|Rate|Labor cost|undefined|NaN/.test(work));
    const projected=await restricted.evaluate(()=>fetch('/api/session',{cache:'no-store'}).then(r=>r.json()));assert.ok(!Object.hasOwn(projected.state.companies[0].employees[0],'rate'));assert.ok(!Object.hasOwn(projected.state.companies[0].time[0],'cost'));assert.ok(!Object.hasOwn(projected.state.companies[0].time[0],'rate'));assert.ok(!JSON.stringify(projected.state.companies[0].history).includes('"rate"'));
    assert.deepEqual(errors,[]);t.diagnostic('Microsoft Edge '+browser.version()+'; actual admin forms, SQLite and authenticated PDF download.');
  }finally{await browser?.close();await suite?.close();await rm(dir,{recursive:true,force:true});}
});
