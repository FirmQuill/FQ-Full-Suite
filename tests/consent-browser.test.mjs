import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createSuite} from '../server.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
test('books and worker portals: decline/reopen, accept/reopen, and review terms after assent',{skip:!process.env.FIRMQUILL_BROWSER_EXE},async()=>{
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const dir=await mkdtemp(join(tmpdir(),'fq-consent-browser-')),database=join(dir,'fictional.sqlite'),password='Fictional browser account 123',state=sampleVault();let suite,browser;
 try{
  const db=openStore(database),encoded=await passwordHash(password);
  try{tx(db,()=>{saveBooks(db,state);const owner=putUser(db,null,{username:'owner',name:'Fictional Owner',role:'owner',assignments:[]},encoded,{bootstrap:true});
   putUser(db,{id:owner,role:'owner'},{username:'worker',name:'Fictional Worker',role:'worker',assignments:[state.companies[0].id],employeeId:state.companies[0].employees[0].id},encoded);
  });}finally{db.close()}
  suite=await createSuite({database,mainPort:0,workerPort:0});browser=await chromium.launch({executablePath:process.env.FIRMQUILL_BROWSER_EXE,headless:true});
  for(const role of ['owner','worker']){
   const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(15000);
   const url=role==='owner'?suite.mainUrl:suite.workerUrl;
   async function signIn(){await page.locator('#login [name=username]').fill(role);await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click()}
   await page.goto(url);await signIn();await page.getByRole('button',{name:'Decline',exact:true}).click();
   const check=openStore(database);try{assert.equal(check.prepare('SELECT count(*) AS n FROM terms_acceptance_hashes').get().n,role==='owner'?0:1)}finally{check.close()}
   await page.reload();await page.getByRole('button',{name:'I agree to the Terms of Service',exact:true}).click();
   await page.reload();await page.locator(role==='owner'?'.toolbar':'#refresh').waitFor();assert.equal(await page.locator('.terms-sheet[open]').count(),0);
   await page.locator('.terms-bar button').click();assert.ok((await page.locator('.terms-scroll').innerText()).includes('MIT source-code license'));await page.getByRole('button',{name:'Close',exact:true}).click();
   await context.close();
  }
 }finally{if(browser)await browser.close();if(suite)await suite.close();await rm(dir,{recursive:true,force:true})}
});
