import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createSetupWizard} from '../setup-wizard.mjs';
import {createSuite} from '../server.mjs';
import {INSTALLED_VERSION} from '../support.mjs';
import {openStore,readBooks} from '../store.mjs';

test('fresh browser setup, mapped multi-source package, agent approval and public-only help survive restart',{skip:!process.env.FIRMQUILL_BROWSER_EXE},async t=>{
  const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
  const dir=await mkdtemp(join(tmpdir(),'fq-connected-ui-'));let browser,wizard,suite,secondWizard,secondSuite;
  const password='Fictional setup fixture 2026!';const errors=[];
  const publicShots=process.env.FIRMQUILL_PUBLIC_SHOTS,privateShots=process.env.FIRMQUILL_PRIVATE_SHOTS||null;
  async function shot(page,name,folder=publicShots){if(folder){await mkdir(folder,{recursive:true});await page.screenshot({path:join(folder,name+'.png'),fullPage:true});}}
  try{
    browser=await chromium.launch({executablePath:process.env.FIRMQUILL_BROWSER_EXE,headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    const database=join(dir,'empty.sqlite');wizard=await createSetupWizard({destination:database});await page.goto(wizard.url);await shot(page,'01-private-first-launch');
    await page.locator('#preview button').click();await page.locator('#account').waitFor({state:'visible'});
    await page.locator('[name=username]').fill('harborline-admin');await page.locator('[name=name]').fill('FICTIONAL Harborline Administrator');await page.locator('[name=password]').fill(password);await page.locator('[name=confirmPassword]').fill(password+'wrong');await page.locator('[name=confirm]').check();
    await shot(page,'02-first-administrator');await page.locator('#initialize button').click();await page.locator('#error').filter({hasText:'Passwords differ'}).waitFor();await shot(page,'03-setup-error-and-retry');
    await page.locator('[name=confirmPassword]').fill(password);await page.locator('#initialize button').click();await page.locator('#done').waitFor({state:'visible'});await shot(page,'04-empty-setup-complete');await wizard.close();wizard=null;
    suite=await createSuite({database,mainPort:0,workerPort:0});
    async function login(url){await page.goto(url);await page.locator('#login').waitFor();await shot(page,'05-books-sign-in');await page.locator('#login [name=username]').fill('harborline-admin');await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click();
      await page.waitForFunction(()=>document.querySelector('.terms-sheet[open],.toolbar'));const agree=page.getByRole('button',{name:'I agree to the Terms of Service',exact:true});if(await agree.isVisible()){await shot(page,'06-review-terms');await agree.click();}await page.locator('.toolbar').waitFor();}
    await login(suite.mainUrl);await page.getByRole('heading',{name:'Set up your books'}).waitFor();await shot(page,'07-empty-books');await page.locator('[data-act=company]').first().click();await page.locator('dialog [name=name]').fill('FICTIONAL Harborline Freight');await shot(page,'08-create-first-company');await page.locator('dialog button[type=submit]').click();await page.locator('#company').waitFor();await shot(page,'09-setup-verified');
    const modal=()=>page.locator('dialog[open]'),click=(act,key)=>page.locator(`[data-act="${act}"]${key?`[data-key="${key}"]`:''}`).first().click();
    const api=(path,body)=>page.evaluate(async({path,body})=>{const s=await fetch('/api/session').then(r=>r.json());const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;},{path,body});
    await click('nav','Migration workspace');await page.getByRole('heading',{name:'Prepare a company package'}).waitFor();await click('migration-create');await modal().locator('[name=companyName]').fill('FICTIONAL Harborline Migration');await modal().locator('button[type=submit]').click();await modal().waitFor({state:'hidden'});
    const migration=(await api('migration')).runs[0];assert.equal(migration.company.name,'FICTIONAL Harborline Migration');
    await click('migration-stage',migration.id);await modal().locator('[name=recordType]').selectOption('contacts');await modal().locator('button[type=submit]').click();
    await modal().locator('[name=sourceId]').fill('qb-fiction');await modal().locator('[name=product]').fill('QuickBooks Online — generic fictional fixture');await modal().locator('[name=profileName]').fill('Fictional reusable contacts');
    await modal().locator('[name=file]').setInputFiles({name:'fictional-contacts.csv',mimeType:'text/csv',buffer:Buffer.from('ID,Name,Kind\nc1,FICTIONAL Harborline Buyer,Customer\n')});
    for(const [field,header]of Object.entries({sourceId:'ID',name:'Name',kind:'Kind'}))await modal().locator(`[name="map-${field}"]`).fill(header);
    await shot(page,'migration-map-csv',privateShots);await modal().locator('button[type=submit]').click();await modal().getByRole('heading',{name:'Staging result'}).waitFor();await click('cancel');
    const source={id:'wave-fiction',product:'Wave',edition:'Explicit generic mapping fixture',exportedAt:'2026-11-26',fixtureOnly:true};
    await api('migration',{type:'stage',runId:migration.id,source,recordType:'contacts',csv:'ID,Name,Kind\nv1,FICTIONAL Harborline Vendor,Vendor\n',mapping:{sourceId:'ID',name:'Name',kind:'Kind'}});
    await click('migration-preview',migration.id);await modal().getByRole('heading',{name:'Reconcile migration preview'}).waitFor();await shot(page,'migration-reconciliation',privateShots);await modal().locator('[name=accept]').check();await modal().locator('button[type=submit]').click();await modal().waitFor({state:'hidden'});
    const downloadPromise=page.waitForEvent('download');await click('migration-package',migration.id);const download=await downloadPromise;const packageText=await readFile(await download.path(),'utf8');
    // Use the exact downloaded package bytes for a second fresh installation.
    secondWizard=await createSetupWizard({destination:join(dir,'package.sqlite')});const second=await browser.newPage({viewport:{width:1280,height:1000}});second.setDefaultTimeout(15000);second.on('pageerror',e=>errors.push(e.message));await second.goto(secondWizard.url);
    await second.locator('[name=mode][value=package]').check();await second.locator('[name=file]').setInputFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:Buffer.from(packageText)});await second.locator('#preview button').click();await second.getByRole('heading',{name:'Review company package'}).waitFor();await shot(second,'10-approved-package-preview');
    await second.locator('[name=username]').fill('harborline-admin');await second.locator('[name=name]').fill('FICTIONAL Harborline Administrator');await second.locator('[name=password]').fill(password);await second.locator('[name=confirmPassword]').fill(password);await second.locator('[name=confirm]').check();await second.locator('#initialize button').click();await second.locator('#done').waitFor({state:'visible'});await shot(second,'11-package-setup-complete');await secondWizard.close();secondWizard=null;
    await click('nav','Agent access');await click('agent-grant');await modal().locator('[name=name]').fill('FICTIONAL customer-selected agent');await modal().locator('[name=allowProposals]').check();await modal().locator('[name=consent]').check();await shot(page,'agent-explicit-grant',privateShots);await modal().locator('button[type=submit]').click();await modal().getByRole('heading',{name:/Save this token/}).waitFor();
    const grant=JSON.parse(await modal().locator('pre').innerText());await click('cancel');
    const state=await api('session'),company=state.state.companies[0];
    const result=await fetch(suite.mainUrl+'/api/agents/v1/proposals',{method:'POST',headers:{Authorization:'Bearer '+grant.token,'Content-Type':'application/json'},body:JSON.stringify({companyId:company.id,requestId:'fictional-browser-proposal',revision:state.revision,action:{type:'contact',name:'FICTIONAL proposed buyer',kind:'Customer',date:'2026-11-26'}})});assert.equal(result.status,200);const proposal=await result.json();await click('refresh');await click('agent-review',proposal.id);await shot(page,'agent-review-proposal',privateShots);await modal().locator('[name=decision]').selectOption('approve');await modal().locator('button[type=submit]').click();await modal().waitFor({state:'hidden'});assert.ok((await api('session')).state.companies[0].parties.some(r=>r.name==='FICTIONAL proposed buyer'));
    await click('nav','Setup help');await click('support-ask');await modal().locator('[name=question]').fill('How do I initialize a fresh workspace with a setup package?');await modal().locator('button[type=submit]').click();await modal().getByRole('heading',{name:'Public setup guidance'}).waitFor();assert.ok((await modal().innerText()).includes(INSTALLED_VERSION));await shot(page,'12-public-setup-help');await click('cancel');
    const before=await api('session');await suite.close();suite=null;suite=await createSuite({database,mainPort:0,workerPort:0});await login(suite.mainUrl);assert.deepEqual((await api('session')).state,before.state);
    secondSuite=await createSuite({database:join(dir,'package.sqlite'),mainPort:0,workerPort:0});const check=openStore(join(dir,'package.sqlite'));try{assert.equal(readBooks(check).state.companies[0].parties.length,2);assert.equal(check.prepare('SELECT count(*) AS n FROM migration_setup_receipts').get().n,1);}finally{check.close();}
    assert.deepEqual(errors,[]);t.diagnostic('Real Chromium/Edge screenshots; all data fictional; no token screenshot saved.');
  }finally{await browser?.close();await wizard?.close();await secondWizard?.close();await suite?.close();await secondSuite?.close();await rm(dir,{recursive:true,force:true});}
});
