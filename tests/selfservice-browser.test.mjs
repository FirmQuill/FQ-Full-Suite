import {acceptIfRequired} from './agreement-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {openStore} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {seedWorkforceDemo} from '../fixtures/workforce-demo.mjs';

const executable=process.env.ERP_LITE_BROWSER_EXE||process.env.FIRMQUILL_BROWSER_EXE;
test('actual mobile and desktop portal: 2028 open first, 2027 initial second, assigned HR case and pending retirement',{skip:!executable,timeout:120000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'firmquill-selfservice-')),database=join(root,'fictional.sqlite'),password='Fictional browser fixture password 184';let browser,suite;
  try{
    const db=openStore(database);let fixture;try{fixture=await seedWorkforceDemo(db,{password});}finally{db.close();}
    suite=await createSuite({database,mainPort:0,workerPort:0});const {chromium}=createRequire(import.meta.url)(process.env.ERP_LITE_PLAYWRIGHT||process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
    browser=await chromium.launch({executablePath:executable,headless:true});
    const worker=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),hr=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    for(const page of [worker,hr]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));}
    async function login(page,url,username){await page.goto(url);const form=page.locator('form#login');await form.locator('[name=username]').fill(username);await form.locator('[name=password]').fill(password);await form.getByRole('button',{name:'Sign in',exact:true}).click();await acceptIfRequired(page);}
    await login(worker,suite.workerUrl,fixture.usernames.worker);await worker.getByRole('button',{name:'Clock in',exact:true}).waitFor();
    await worker.getByRole('button',{name:'Clock in',exact:true}).click();await worker.getByRole('button',{name:'Clock out',exact:true}).click();await worker.getByText('Awaiting review',{exact:true}).waitFor();
    await worker.locator('[data-tab="Benefits"]').click();
    const open=worker.locator('.enrollment').filter({has:worker.getByRole('heading',{name:'2028 Open Enrollment',exact:true})}),initial=worker.locator('.enrollment').filter({has:worker.getByRole('heading',{name:'2027 Initial Enrollment',exact:true})});
    await open.locator('select').selectOption('employee');await open.getByRole('button',{name:'Submit enrollment',exact:true}).click();await open.locator('.receipt').waitFor();const openReceipt=await open.locator('.receipt').innerText();
    assert.equal(await initial.getByRole('button',{name:'Submit enrollment',exact:true}).count(),1);await initial.locator('select').selectOption('family');await initial.getByRole('button',{name:'Submit enrollment',exact:true}).click();await initial.locator('.receipt').waitFor();const initialReceipt=await initial.locator('.receipt').innerText();
    assert.notEqual(openReceipt,initialReceipt);assert.equal(await open.locator('.receipt').innerText(),openReceipt);assert.equal(await worker.locator('.enrollment').count(),2);assert.equal(await open.locator('select').inputValue(),'employee');assert.equal(await initial.locator('select').inputValue(),'family');
    assert.ok(await worker.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile portal has no horizontal overflow');
    const special=worker.locator('form[data-service="special-request"]');await special.locator('[name=event]').fill('FICTIONAL — household event');await special.locator('[name=eventDate]').fill(fixture.today);await special.locator('[name=requestedChange]').fill('Please manually review the fictional requested coverage change.');await special.locator('[name=attachments]').setInputFiles({name:'fictional-evidence.txt',mimeType:'text/plain',buffer:Buffer.from('FICTIONAL supporting detail; no real personal information.')});await special.getByRole('button',{name:'Send to HR'}).click();await worker.getByRole('heading',{name:'FICTIONAL — household event · received',exact:true}).waitFor();
    const retirement=worker.locator('form[data-service="retirement-change"][data-id="fictional-401k"]');await retirement.locator('[name=value]').fill('6');await retirement.locator('[name=effectiveDate]').fill(fixture.today);await retirement.getByRole('button',{name:'Request contribution change'}).click();await worker.getByText('pending · Effective '+fixture.today,{exact:true}).waitFor();
    await login(hr,suite.mainUrl,fixture.usernames.hr);await hr.locator('nav [data-key="Benefits administration"]').click();await hr.getByRole('heading',{name:'Assigned HR special enrollment queue',exact:true}).waitFor();const caseRow=hr.locator('tr').filter({hasText:'FICTIONAL — household event'});await caseRow.getByRole('button',{name:'Open case',exact:true}).click();const dialog=hr.locator('dialog[open]');assert.match(await dialog.innerText(),/FICTIONAL — Avery Warehouse/);assert.match(await dialog.innerText(),/fictional-evidence\.txt/);await dialog.locator('[name=status]').selectOption('information_requested');await dialog.locator('[name=reason]').fill('FICTIONAL HR follow-up: provide a sample clarification.');await dialog.getByRole('button',{name:'Record HR update',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await worker.getByRole('button',{name:'Refresh',exact:true}).click();await worker.getByRole('heading',{name:'FICTIONAL — household event · information_requested',exact:true}).waitFor();await worker.locator('form[data-service="special-update"] [name=message]').fill('FICTIONAL employee clarification.');await worker.getByRole('button',{name:'Send response',exact:true}).click();await worker.getByRole('heading',{name:'FICTIONAL — household event · received',exact:true}).waitFor();
    const imageDir=process.env.FIRMQUILL_QA_DIR;if(imageDir){await mkdir(imageDir,{recursive:true});await worker.evaluate(()=>scrollTo(0,0));await hr.evaluate(()=>scrollTo(0,0));await worker.screenshot({path:join(imageDir,'selfservice-mobile.png'),fullPage:true});await hr.screenshot({path:join(imageDir,'selfservice-hr-desktop.png'),fullPage:true});}
    await worker.setViewportSize({width:1280,height:900});assert.ok(await worker.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'desktop portal has no horizontal overflow');assert.equal(await worker.locator('.enrollment').count(),2);assert.equal(await open.locator('.receipt').innerText(),openReceipt);if(imageDir)await worker.screenshot({path:join(imageDir,'selfservice-worker-desktop.png'),fullPage:true});
    await worker.locator('[data-tab="Reviews"]').click();await worker.getByRole('heading',{name:'FICTIONAL — Welcome review'}).waitFor();assert.equal(await worker.getByText('FICTIONAL — Private draft',{exact:true}).count(),0);await worker.getByRole('button',{name:'Acknowledge receipt',exact:true}).click();await worker.getByText(/^Acknowledged /).waitFor();
    await worker.getByRole('button',{name:'Sign out',exact:true}).click();await worker.getByRole('heading',{name:'Worker sign in',exact:true}).waitFor();assert.ok(!(await worker.locator('body').innerText()).includes('Avery Warehouse'));assert.deepEqual(errors,[]);
    t.diagnostic('Verified real worker UI on 390px and 1280px: local punches, two independent enrollment receipts, restricted evidence routed to assigned HR, employee follow-up, pending 401(k), published review acknowledgement.');
  }finally{await browser?.close();await suite?.close();for(const suffix of ['','-wal','-shm'])await rm(database+suffix,{force:true});await rmdir(root);}
});
