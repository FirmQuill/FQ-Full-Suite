import {receipt,acceptIfRequired} from './agreement-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,saveBooks,passwordHash,putUser,safeUser} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';

const password='Fictional portal branding test';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNTsAAAAASUVORK5CYII=';
test('owner configures worker company or parent branding; isolation, fallback and persistence',{timeout:120000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fq-branding-')), database=join(dir,'sample.sqlite');
  let suite,db,browser;
  try{
    let state=newVault('Harborline Parent');
    const parent=state.companies[0].id;
    for(const name of ['Harborline Child','Other Company'])state=apply(state,parent,{type:'company',name,activities:['employees'],date:'2026-01-01'});
    const [,child,other]=state.companies;
    for(const c of [parent,child.id,other.id])state=apply(state,c,{type:'employee',date:'2026-01-01',name:'Fictional '+c.slice(0,6),rate:2500,state:'WA',locality:'Demo'});
    db=openStore(database);const hash=await passwordHash(password);
    const ownerId=putUser(db,null,{username:'demo-owner',name:'Demo Owner',role:'owner',assignments:[]},hash,{bootstrap:true});
    saveBooks(db,state);
    const owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(ownerId));
    for(const [index,c] of state.companies.entries())putUser(db,owner,{username:'demo-worker-'+index,name:c.employees[0].name,role:'worker',assignments:[c.id],employeeId:c.employees[0].id},hash);
    putUser(db,owner,{username:'demo-hr',name:'Demo HR',role:'hr',assignments:[child.id],areas:['Employee records']},hash);
    db.close();db=null;
    suite=await createSuite({database,mainPort:0,workerPort:0});
    function client(base){
      let cookie='',csrf='';
      const send=async(path,body,options={})=>{
        const response=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
        if(options.binary)return response;
        const data=await response.json();
        if(path==='login'&&response.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=data.csrf;}
        if(path==='login'&&data.termsRequired)return send('terms',receipt);
        return {status:response.status,data};
      };return send;
    }
    const main=client(suite.mainUrl), hr=client(suite.mainUrl), staff=client(suite.workerUrl), unrelated=client(suite.workerUrl);
    assert.equal((await main('login',{username:'demo-owner',password})).status,200);
    assert.equal((await hr('login',{username:'demo-hr',password})).status,200);
    assert.equal((await hr('worker-brand?companyId='+child.id)).status,403);
    assert.equal((await client(suite.workerUrl)('worker-brand/logo')).status,401);
    assert.equal((await staff('login',{username:'demo-worker-1',password})).data.branding,null);
    const update=(who,version,mode,extra={})=>main('worker-brand',{companyId:who,version,mode,label:'',logoAction:'keep',...extra});
    assert.equal((await update(parent,0,'company',{label:'The Harborline Group',logoAction:'replace',logo:{mime:'image/png',data:png}})).status,200);
    assert.equal((await update(child.id,0,'parent',{parent:child.id})).status,400);
    assert.equal((await update(child.id,0,'parent',{parent})).status,200);
    const result=(await staff('session')).data.branding;
    assert.equal(result.name,'The Harborline Group');
    const logo=await staff(result.logo.slice(5),undefined,{binary:true});
    assert.equal(logo.headers.get('content-type'),'image/png');
    assert.equal(logo.headers.get('cache-control'),'no-store');
    assert.equal(Buffer.from(await logo.arrayBuffer()).toString('base64'),png);
    assert.equal((await unrelated('login',{username:'demo-worker-2',password})).data.branding,null);
    assert.equal((await unrelated('worker-brand/logo?companyId='+parent)).status,404);
    assert.equal((await update(child.id,0,'company')).status,409);
    assert.equal((await update(child.id,1,'company',{logoAction:'replace',logo:{mime:'image/png',data:Buffer.from('<svg>not PNG</svg>').toString('base64')}})).status,400);
    assert.equal((await update(child.id,1,'company',{label:'Local Child'})).status,200);
    assert.deepEqual((await staff('session')).data.branding,{name:'Local Child',logo:''});

    const executable=process.env.FIRMQUILL_BROWSER_EXE;
    if(executable){
      const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
      browser=await chromium.launch({executablePath:executable,headless:true});
      const adminPage=await browser.newPage(), workerPage=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      adminPage.setDefaultTimeout(10000);workerPage.setDefaultTimeout(10000);
      async function browserLogin(page,url,username){await page.goto(url);const form=page.locator('#login');await form.locator('[name=username]').fill(username);await form.locator('[name=password]').fill(password);await form.getByRole('button',{name:'Sign in',exact:true}).click();await acceptIfRequired(page);}
      await browserLogin(adminPage,suite.mainUrl,'demo-owner');
      await adminPage.locator('nav [data-key="Employee records"]').click();
      const switcher=adminPage.locator('select').filter({has:adminPage.locator('option[value="'+child.id+'"]')}).first();
      await switcher.selectOption(child.id);
      await adminPage.getByRole('button',{name:'Worker portal branding'}).click();
      const dialog=adminPage.locator('dialog[open]');
      await dialog.locator('[name=mode]').selectOption('parent');await dialog.locator('[name=parent]').selectOption(parent);
      await dialog.getByRole('button',{name:'Save branding',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
      const fixture=await adminPage.evaluate(()=>{
        const canvas=document.createElement('canvas');canvas.width=2304;canvas.height=1152;
        const ctx=canvas.getContext('2d'), pixels=ctx.createImageData(canvas.width,canvas.height);let x=313373;
        for(let i=0;i<pixels.data.length;i+=4){x^=x<<13;x^=x>>>17;x^=x<<5;
          pixels.data[i]=x&255;pixels.data[i+1]=(x>>>8)&255;pixels.data[i+2]=(x>>>16)&255;
          pixels.data[i+3]=i/4%canvas.width<90?0:255;
        }
        ctx.putImageData(pixels,0,0);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      const fixtureBytes=Buffer.from(fixture,'base64');assert(fixtureBytes.length>512*1024);
      const file={name:'synthetic-transparent.png',mimeType:'image/png',buffer:fixtureBytes};
      const open=()=>adminPage.getByRole('button',{name:'Worker portal branding'}).click();
      const upload=dialog.locator('input[name=file]'), preview=dialog.locator('[data-logo-preview]');
      await open();
      const invalid=Buffer.from('<svg>not a logo</svg>');
      await upload.setInputFiles({name:'misnamed.png',mimeType:'image/png',buffer:invalid});
      await dialog.getByRole('status').getByText('Choose a readable PNG or JPEG logo.').waitFor();
      assert(await preview.isHidden());
      await upload.setInputFiles(file);
      await dialog.getByRole('status').getByText(/Fitted to/).waitFor();
      const size=await preview.evaluate(async img=>{
        await img.decode();
        const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(img,0,0);
        return {width:img.naturalWidth,height:img.naturalHeight,alpha:context.getImageData(0,0,1,1).data[3],bytes:atob(img.src.split(',')[1]).length};
      });
      assert(size.bytes<=512*1024);assert(size.width<=2048);assert(Math.abs(size.width-2*size.height)<=1);assert.equal(size.alpha,0);
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal((await main('worker-brand?companyId='+child.id)).data.hasLogo,false);
      await open();await dialog.locator('[name=mode]').selectOption('company');await upload.setInputFiles(file);
      await dialog.getByRole('status').getByText(/Fitted to/).waitFor();
      await dialog.getByRole('button',{name:'Save branding',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
      await browserLogin(workerPage,suite.workerUrl,'demo-worker-1');
      await workerPage.locator('.brand').getByText('Local Child',{exact:true}).waitFor();
      await workerPage.waitForFunction(w=>document.querySelector('.brand img').naturalWidth===w,size.width);
      await workerPage.reload();
      await workerPage.waitForFunction(w=>document.querySelector('.brand img').naturalWidth===w,size.width);
      const stored=await (await workerPage.request.get(suite.workerUrl+'/api/worker-brand/logo')).body();
      assert.equal(stored.length,size.bytes);
      const largeArchive=join(dir,'large.fqdb'), largeRestored=join(dir,'large-restored.sqlite');
      await backupDatabase(database,largeArchive,password);await restoreDatabase(largeArchive,largeRestored,password);
      const restoredLarge=openStore(largeRestored);
      try{assert.deepEqual(Buffer.from(restoredLarge.prepare('SELECT logo FROM worker_branding WHERE company=?').get(child.id).logo),stored);}
      finally{restoredLarge.close();}
      console.info('Synthetic PNG source '+fixtureBytes.length+' bytes; stored '+size.bytes+' bytes, '+size.width+' × '+size.height+' pixels; transparency verified.');
      const small=await adminPage.evaluate(()=>{
        const c=document.createElement('canvas');c.width=24;c.height=12;
        const ctx=c.getContext('2d');ctx.fillStyle='#358d8d';ctx.fillRect(2,3,16,7);
        return ['image/png','image/jpeg'].map(mime=>c.toDataURL(mime).split(',')[1]);
      });
      await open();
      const excessive=Buffer.from(fixtureBytes.subarray(0,33));excessive.writeUInt32BE(9000,16);
      await upload.setInputFiles({name:'too-wide.png',mimeType:'image/png',buffer:excessive});
      await dialog.getByRole('status').getByText(/Choose a logo at most 20 MiB/).waitFor();
      await upload.setInputFiles({name:'small.png',mimeType:'image/png',buffer:Buffer.from(small[0],'base64')});
      await dialog.getByRole('status').getByText('Ready at 24 × 12 pixels.').waitFor();
      await upload.setInputFiles({name:'small.jpg',mimeType:'image/jpeg',buffer:Buffer.from(small[1],'base64')});
      await dialog.getByRole('status').getByText('Ready at 24 × 12 pixels.').waitFor();
      assert((await preview.getAttribute('src')).startsWith('data:image/jpeg;'));
      await dialog.locator('[name=mode]').selectOption('parent');await dialog.locator('[name=parent]').selectOption(parent);
      await dialog.getByRole('button',{name:'Save branding',exact:true}).click();await dialog.waitFor({state:'hidden'});
      await workerPage.reload();
      await workerPage.locator('.brand').getByText('The Harborline Group',{exact:true}).waitFor();
      await workerPage.waitForFunction(()=>document.querySelector('.brand img').naturalWidth>0);
      assert.equal(await workerPage.title(),'The Harborline Group · Employee portal');
      assert(await workerPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await workerPage.getByRole('button',{name:'Sign out',exact:true}).click();
      await workerPage.locator('.brand').getByText('FirmQuill',{exact:true}).waitFor();
    }else assert.equal((await update(child.id,2,'parent',{parent})).status,200);
    await browser?.close();browser=null;await suite.close();suite=null;
    db=openStore(database);
    assert.equal(db.prepare('SELECT parent FROM worker_branding WHERE company=?').get(child.id).parent,parent);
    const prior=db.prepare('SELECT mime,logo FROM worker_branding WHERE company=?').get(child.id);
    db.close();db=null;
    const archive=join(dir,'sample.fqdb'), restored=join(dir,'restored.sqlite');
    await backupDatabase(database,archive,password);await restoreDatabase(archive,restored,password);
    db=openStore(restored);
    assert.deepEqual(db.prepare('SELECT mime,logo FROM worker_branding WHERE company=?').get(child.id),prior);
  }finally{await browser?.close();await suite?.close();db?.close();await rm(dir,{recursive:true,force:true});}
});
