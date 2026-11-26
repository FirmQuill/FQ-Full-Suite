import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createSuite} from '../server.mjs';
import {openStore,tx,passwordHash,putUser} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {exportLite,inspectLite} from '../transfer.mjs';

if(process.env.FIRMQUILL_BROWSER_EXE)test('main portal opens a migrated tenant, accepts team actions, reconciles a portable export and handles a stale tab',async t=>{
  const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
  const root=await mkdtemp(join(tmpdir(),'fq-main-ui-')),database=join(root,'suite.sqlite');
  const password='Synthetic test passphrase 19';
  const snapshot=sampleVault(),encoded=await exportLite(snapshot,password);
  const db=openStore(database);
  try{const hash=await passwordHash(password);tx(db,()=>putUser(db,null,{name:'Synthetic Owner',username:'test-owner',role:'owner',assignments:[]},hash,{bootstrap:true}));}finally{db.close();}
  let browser,suite;
  try{
    suite=await createSuite({database,mainPort:0,workerPort:0});
    browser=await chromium.launch({executablePath:process.env.FIRMQUILL_BROWSER_EXE,headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:960}});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
    const click=(p,act,key)=>p.locator(`[data-act="${act}"]${key?`[data-key="${key}"]`:''}`).first().click();
    const modal=p=>p.locator('dialog[open]');
    const submit=async p=>{await modal(p).locator('button[type=submit]').click();};
    async function login(p,username){
      await p.goto(suite.mainUrl);
      const f=p.locator('#login');
      await f.locator('[name=username]').fill(username);await f.locator('[name=password]').fill(password);
      await f.locator('button').click();await p.locator('.toolbar').waitFor();
    }
    await login(page,'test-owner');await page.getByRole('heading',{name:'Set up your books'}).waitFor();
    await click(page,'nav','Portable transfers');await click(page,'portable-import');
    await modal(page).locator('[name=file]').setInputFiles({name:'synthetic.firmquill',mimeType:'application/json',buffer:Buffer.from(encoded.envelope)});
    await modal(page).locator('[name=password]').fill(password);await submit(page);
    await modal(page).getByRole('heading',{name:'Reconcile Lite import'}).waitFor();assert.match(await modal(page).innerText(),/\$15,420\.00/);
    await modal(page).locator('[type=checkbox]').check();await submit(page);await page.locator('#company').waitFor();assert.equal(await page.locator('#company option').count(),2);
    await click(page,'nav','Reports');await page.locator('#report-filter [name=group]').selectOption({index:1});await page.locator('#report-filter button').click();
    await page.getByRole('heading',{name:'Group-only elimination journals'}).waitFor();assert.match(await page.locator('.reports').innerText(),/\$4,918\.00/);
    await click(page,'nav','User access');await click(page,'add-user');
    const uf=modal(page);await uf.locator('[name=name]').fill('Synthetic Bookkeeper');await uf.locator('[name=username]').fill('test-clerk');await uf.locator('[name=password]').fill(password);
    await uf.locator('[name=role]').selectOption('bookkeeper');await uf.locator(`[name=assignments][value="${snapshot.companies[0].id}"]`).check();
    for(const area of ['Overview','Accounting','Directory','Approvals'])await uf.locator(`[name=areas][value="${area}"]`).check();
    await submit(page);await page.getByRole('cell',{name:/Synthetic Bookkeeper/}).waitFor();
    const clerkContext=await browser.newContext(),clerk=await clerkContext.newPage();clerk.on('pageerror',e=>errors.push(e.message));
    await login(clerk,'test-clerk');assert.equal(await clerk.locator('#company option').count(),1);assert.equal(await clerk.locator('nav [data-key="User access"]').count(),0);
    await click(clerk,'nav','Accounting');await click(clerk,'journal');const jr=modal(clerk);
    await jr.locator('[name=label]').fill('Synthetic cash contribution');await jr.locator('[name=debit]').selectOption('1000');await jr.locator('[name=credit]').selectOption('3000');
    await jr.locator('[name=amount]').fill('10.25');await jr.locator('[name=flow]').selectOption('Financing');
    await submit(clerk);await jr.waitFor({state:'hidden'});await click(clerk,'nav','Approvals');await clerk.getByRole('cell',{name:/Synthetic cash contribution/}).waitFor();
    await click(page,'refresh');await click(page,'nav','Approvals');await click(page,'review-approval');
    await modal(page).locator('[name=decision]').selectOption('approve');await submit(page);await modal(page).waitFor({state:'hidden'});
    await click(page,'nav','Overview');assert.match(await page.locator('.hero strong').innerText(),/\$15,430\.25/);
    await click(page,'nav','Audit trail');await page.getByRole('cell',{name:'approve',exact:true}).waitFor();
    await click(page,'nav','Directory');await click(page,'contact');await modal(page).locator('[name=name]').fill('Owner saved contact');await submit(page);await page.getByRole('cell',{name:'Owner saved contact'}).waitFor();
    await click(clerk,'nav','Directory');await click(clerk,'contact');await modal(clerk).locator('[name=name]').fill('Stale contact');await submit(clerk);
    await clerk.getByRole('cell',{name:'Owner saved contact'}).waitFor();assert.match(await clerk.locator('.workspace .error').innerText(),/refreshed records/);
    assert.equal(await clerk.getByRole('cell',{name:'Stale contact'}).count(),0);
    await click(page,'nav','Portable transfers');await click(page,'portable-export');await modal(page).locator('[name=password]').fill(password);await modal(page).locator('[name=confirm]').fill(password);await submit(page);
    await modal(page).getByRole('heading',{name:'Encrypted snapshot ready'}).waitFor();
    const downloading=page.waitForEvent('download');await submit(page);const downloaded=await downloading;
    const file=await readFile(await downloaded.path(),'utf8'),parsed=await inspectLite(file,password);assert.equal(parsed.summary.companies[0].balances.cash,1543025);
    assert.equal(parsed.state.companies[0].id,snapshot.companies[0].id);
    await click(page,'nav','User access');
    await page.getByRole('row').filter({hasText:'Synthetic Bookkeeper'}).getByRole('button',{name:'Edit'}).click();
    await modal(page).locator('[name=active]').selectOption('no');await submit(page);await page.locator('tr').filter({hasText:'Synthetic Bookkeeper'}).getByRole('cell',{name:'Disabled',exact:true}).waitFor();
    await click(clerk,'refresh');await clerk.locator('#login').waitFor();
    await click(page,'logout');await page.locator('#login').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('Owner saved contact'));
    assert.deepEqual(errors,[]);t.diagnostic('Microsoft Edge '+browser.version()+'; actual SQLite, encrypted transfer and separate user contexts.');
  }finally{await browser?.close();await suite?.close();await rm(root,{recursive:true,force:true});}
});

