import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {localServer} from '../baseline/serve.mjs';

if(process.env.ERP_LITE_BROWSER_EXE)test('desktop and phone layouts, offline edits, locked recovery, banking, payroll and cache privacy',async t=>{
  const require=createRequire(import.meta.url);
  const {chromium}=require(process.env.ERP_LITE_PLAYWRIGHT||'playwright');
  const server=localServer();await new Promise((r,j)=>server.once('error',j).listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port+'/fieldledger-lite/';
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.ERP_LITE_BROWSER_EXE,headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:950}});
    const p=await context.newPage();p.setDefaultTimeout(8000);const errors=[],logs=[],requests=[];
    p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>logs.push(m.text()));p.on('request',r=>requests.push(r.url()));
    const secret='Synthetic Browser Password 12',sentinel='Synthetic Indigo Contact 741';
    const click=(act,key)=>p.locator(`[data-act="${act}"]${key?'[data-key="'+key+'"]':''}`).first().click();
    const modal=p.locator('dialog[open]'), submit=()=>modal.locator('button[type=submit]').click();
    async function login(){await p.locator('#gate-form [type=password]').fill(secret);await p.locator('#gate-form button').click();await p.locator('#company').waitFor();}
    await p.goto(url);await p.getByRole('heading',{name:'Create your workspace'}).waitFor();
    await p.locator('[name=activities][value=stock]').check();assert.match(await p.locator('#suggested').innerText(),/Warehouse/);
    await click('sample');await modal.locator('[name=password]').fill(secret);await modal.locator('[name=confirm]').fill(secret);await submit();
    await p.getByRole('heading',{name:'Workspace overview'}).waitFor();
    await p.waitForFunction(()=>navigator.serviceWorker.controller!==null);
    assert.match(await p.locator('.hero strong').innerText(),/15,420.00/);
    if(process.env.ERP_LITE_QA_DIR)await p.screenshot({path:process.env.ERP_LITE_QA_DIR+'/desktop.png'});
    for(const m of ['Directory','Sales','Purchasing','Jobs & time','Warehouse','Assembly','Fixed assets','Accounting','Banking','Reports','Payroll','History','Company setup']){
      await click('nav',m);await p.getByRole('heading',{name:m,exact:true,level:1}).waitFor();
    }
    await click('nav','Reports');await p.locator('#report-filter [name=group]').selectOption({index:1});await p.locator('#report-filter button').click();
    await p.getByRole('heading',{name:'Group-only elimination journals'}).waitFor();assert.match(await p.locator('.reports').innerText(),/4,918.00/);
    await click('nav','Payroll');await click('worksheet');
    for(const k of ['fed','ss','med'])await modal.locator(`[name=${k}]`).fill('180.00');
    for(const k of ['priorSs','priorMed'])await modal.locator(`[name=${k}]`).fill('0.00');
    await modal.locator('[name=date]').fill('2026-02-01');await modal.locator('[name=to]').fill('2026-01-31');
    await submit();await modal.getByRole('heading',{name:'Federal worksheet result'}).waitFor();assert.match(await modal.innerText(),/\$11\.16/);
    assert.match(await modal.innerText(),/Final output blocked/);await click('cancel');
    await click('nav','Banking');
    const bankFile={name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Description,Amount\n2026-01-05,Synthetic contribution,15000.00')};
    async function previewBank(){
      await click('import');await modal.locator('[name=file]').setInputFiles(bankFile);
      await modal.locator('[name=closing]').fill('15000.00');await submit();await modal.getByRole('heading',{name:'Review statement lines'}).waitFor();
    }
    await previewBank();await submit();await modal.waitFor({state:'hidden'});
    await previewBank();assert.match(await modal.innerText(),/0 new · 1 already imported/);await click('cancel');
    await click('match');await submit();await modal.waitFor({state:'hidden'});
    await click('reconcile');await modal.locator('[name=date]').fill('2026-01-05');await modal.locator('[name=closing]').fill('15000');await submit();await modal.waitFor({state:'hidden'});
    await context.setOffline(true);await p.reload();await login();await click('nav','Directory');await click('contact');
    await modal.locator('[name=name]').fill(sentinel);await submit();await p.getByRole('cell',{name:sentinel,exact:true}).waitFor();
    await p.locator('#company').selectOption({index:1});assert.ok(!(await p.locator('#app').innerText()).includes(sentinel));
    await p.locator('#company').selectOption({index:0});await p.getByRole('cell',{name:sentinel,exact:true}).waitFor();
    await click('nav','Company setup');const download=p.waitForEvent('download');await click('backup');
    const file=await download,bytes=await readFile(await file.path());assert.ok(!bytes.toString().includes(sentinel));
    const cached=await p.evaluate(async()=>{
      const keys=await caches.keys(),list=[];
      for(const key of keys){const cache=await caches.open(key);for(const r of await cache.keys())list.push({url:r.url,body:await (await cache.match(r)).text()});}
      return {keys,list,ls:localStorage.length,ss:sessionStorage.length};
    });
    assert.equal(cached.keys.length,1);assert.match(cached.keys[0],/^fieldledger-lite:/);
    assert.equal(cached.list.length,11);assert.equal(cached.ls+cached.ss,0);
    assert.ok(cached.list.every(x=>x.url.startsWith(url)&&!x.body.includes(sentinel)));
    assert.ok(!JSON.stringify(logs).includes(sentinel));assert.ok(!JSON.stringify(requests).includes(sentinel));
    assert.ok(requests.every(req=>req.startsWith(url)));
    await click('lock');await p.getByRole('heading',{name:'Unlock your vault'}).waitFor();assert.ok(!(await p.locator('body').innerText()).includes(sentinel));
    await login();await click('nav','Directory');await p.getByRole('cell',{name:sentinel}).waitFor();
    await p.setViewportSize({width:390,height:844});await click('menu');await click('nav','Overview');
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.ERP_LITE_QA_DIR)await p.screenshot({path:process.env.ERP_LITE_QA_DIR+'/phone.png'});
    await p.clock.install();await click('menu');await click('nav','Directory');await p.clock.fastForward(301000);
    await p.getByRole('heading',{name:'Unlock your vault'}).waitFor();
    const restored=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const q=await restored.newPage();
    await q.goto(url);await q.locator('[data-act=restore]').click();const d=q.locator('dialog[open]');
    await d.locator('[name=file]').setInputFiles({name:'backup.fieldledger',mimeType:'application/json',buffer:bytes});
    await d.locator('[name=password]').fill(secret);await d.locator('[type=submit]').click();await q.locator('#company').waitFor();
    await q.locator('[data-act=menu]').click();await q.locator('nav [data-key=Directory]').click();
    await q.getByRole('cell',{name:sentinel}).waitFor();assert.equal(await q.locator('#company option').count(),2);assert.deepEqual(errors,[]);
    const fresh=await browser.newContext(),u=await fresh.newPage();u.setDefaultTimeout(8000);await u.goto(url);
    const form=u.locator('#gate-form');await form.locator('[name=name]').fill('Synthetic River Studio');await form.locator('[value=jobs]').check();
    await form.locator('[name=password]').fill(secret);await form.locator('[name=confirm]').fill(secret);await form.locator('button').click();
    await u.waitForSelector('#company');await u.locator('nav [data-key=Directory]').click();
    const uf=u.locator('dialog[open]');async function uSave(){await uf.locator('button[type=submit]').click();await uf.waitFor({state:'hidden'});}
    await u.locator('[data-act=contact]').click();await uf.locator('[name=name]').fill('Synthetic River Customer');await uSave();
    await u.locator('[data-act=item]').click();await uf.locator('[name=name]').fill('Design review');await uf.locator('[name=kind]').selectOption('Service');await uSave();
    await u.locator('nav [data-key=Sales]').click();await u.locator('[data-act=quote]').click();
    await uf.locator('[name=label]').fill('Synthetic design review');await uf.locator('[name=unit]').fill('125.25');await uSave();
    for(const step of ['Sales order','Fulfillment','Invoice','Collection']){
      await u.getByRole('button',{name:step,exact:true}).click();await uSave();
    }
    await u.locator('[data-act=detail]').first().click();await uf.locator('.printable').waitFor();assert.match(await uf.locator('.printable').innerText(),/125.25/);
    await u.emulateMedia({media:'print'});assert.ok(await uf.locator('.printable').isVisible());assert.equal(await u.locator('#app').isVisible(),false);await u.emulateMedia({media:'screen'});
    await uf.locator('[data-act=cancel]').click();await u.locator('nav [data-key=Overview]').click();assert.match(await u.locator('.hero strong').innerText(),/125.25/);
    t.diagnostic('Edge '+browser.version()+'; desktop 1440×950 and phone 390×844; all business records synthetic.');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});



