import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createSuite} from '../server.mjs';
import {openStore,tx,saveBooks,passwordHash,putUser} from '../store.mjs';
import {newVault,apply} from '../shared/core.mjs';

const exe=process.env.ERP_LITE_BROWSER_EXE;
test('worker and manager portals: mobile clock-in/out, two correction reviews, approved time and original punches', {skip:!exe}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'firmquill-worker-ui-')), file=join(dir,'synthetic.db');
  let browser,suite;
  const password='Synthetic portal browser password 161';
  try{
    const db=openStore(file);
    try{
      let s=newVault('Synthetic portal company',['jobs','time']);
      const company=s.companies[0].id;
      s=apply(s,company,{type:'job',date:'2026-01-01',name:'Synthetic field visit'});
      s=apply(s,company,{type:'employee',date:'2026-01-01',name:'Test Worker',state:'CO',locality:'Synthetic Town',rate:2500});
      const hash=await passwordHash(password);
      tx(db,()=>{
        saveBooks(db,s);
        putUser(db,null,{name:'Manager',username:'reviewer',role:'manager',assignments:[company]},hash,{bootstrap:true});
        putUser(db,null,{name:'Worker',username:'punchuser',role:'worker',assignments:[company],employeeId:s.companies[0].employees[0].id},hash,{bootstrap:true});
      });
    }finally{db.close();}
    suite=await createSuite({database:file,mainPort:0,workerPort:0});
    const {chromium}=createRequire(import.meta.url)(process.env.ERP_LITE_PLAYWRIGHT||'playwright');
    browser=await chromium.launch({executablePath:exe,headless:true});
    const worker=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const manager=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];for(const page of [worker,manager]){page.setDefaultTimeout(9000);page.on('pageerror',err=>errors.push(err.message));}
    async function login(page,url,username){
      await page.goto(url);const f=page.locator('form#login');await f.locator('[name=username]').fill(username);
      await f.locator('[name=password]').fill(password);await f.getByRole('button',{name:'Sign in'}).click();
      await page.getByRole('button',{name:'I agree to the Terms of Service'}).click();
    }
    await login(worker,suite.workerUrl,'punchuser');
    await worker.getByRole('button',{name:'Clock in',exact:true}).click();
    await worker.getByRole('button',{name:'Clock out',exact:true}).click();
    await worker.getByText('Awaiting review',{exact:true}).waitFor();
    const start=new Date();start.setUTCDate(start.getUTCDate()-2);start.setUTCHours(19,0,0,0);
    async function request(minutes,reason){
      await worker.locator('summary').filter({hasText:'Request correction'}).click();
      const f=worker.locator('[data-correction]');
      await f.locator('[name=start]').fill(start.toISOString());await f.locator('[name=end]').fill(new Date(start.getTime()+minutes*60000).toISOString());
      await f.locator('[name=reason]').fill(reason);await f.getByRole('button',{name:'Send correction'}).click();
      await worker.getByText('Correction awaiting manager review.').waitFor();
    }
    await request(75,'Synthetic scheduled time');
    await login(manager,suite.mainUrl,'reviewer');
    async function approve(reason){
      await manager.locator('nav [data-key=Approvals]').click();
      const row=manager.locator('tr').filter({hasText:'Correction'});
      await row.getByRole('button',{name:'Review',exact:true}).click();
      const d=manager.locator('dialog[open]');
      assert.match(await d.innerText(),new RegExp(reason));
      await d.locator('[name=decision]').selectOption('approve');await d.getByRole('button',{name:'Save decision'}).click();
      await d.waitFor({state:'hidden'});
    }
    await approve('Synthetic scheduled time');await worker.getByRole('button',{name:'Refresh'}).click();
    await worker.getByRole('cell',{name:'75',exact:true}).waitFor();
    const original=await worker.locator('.shift p').first().innerText();
    await request(40,'Synthetic second correction');await approve('Synthetic second correction');
    await worker.getByRole('button',{name:'Refresh'}).click();
    await worker.getByRole('cell',{name:'40',exact:true}).waitFor();
    assert.equal(await worker.locator('.records tbody tr').count(),1);
    assert.equal(await worker.locator('.shift p').first().innerText(),original);
    assert.ok(await worker.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await manager.locator('nav [data-key="Jobs & time"]').click();await manager.getByRole('cell',{name:'40',exact:true}).waitFor();
    await worker.getByRole('button',{name:'Sign out'}).click();await worker.getByRole('heading',{name:'Worker sign in'}).waitFor();
    assert.ok(!(await worker.locator('body').innerText()).includes('Synthetic field visit'));
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();await suite?.close();
    for(const suffix of ['','-wal','-shm'])await rm(file+suffix,{force:true});await rmdir(dir);
  }
});
