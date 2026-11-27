import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createSuite} from '../server.mjs';
import {supportDiagnostics} from '../support-diagnostics.mjs';
import {INSTALLED_VERSION} from '../support.mjs';
import {openStore,putUser,tx,saveBooks,passwordHash,audit} from '../store.mjs';
import {newVault,apply} from '../shared/core.mjs';
import {fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';

const marker='PRIVATE-DATA-MARKER-93FAG';
const password='Fictional '+marker+' Password';
const expected=['books','approvals','employeePortal','employeeRecords','benefits','companyKnowledge','collaboration','drives','monthEndClose'];

function exactShape(value){
  assert.deepEqual(Object.keys(value),['format','product','runtime','schemaVersion','checks']);
  assert.equal(value.format,'firmquill.support-diagnostics.v1');
  assert.deepEqual(value.product,{edition:'Full Suite',version:INSTALLED_VERSION});
  assert.deepEqual(Object.keys(value.runtime),['node','sqlite']);
  assert.match(value.runtime.node,/^\d+\.\d+\.\d+$/);assert.match(value.runtime.sqlite,/^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(value.checks),expected);
  for(const result of Object.values(value.checks))assert.ok(['schema-present','schema-unavailable'].includes(result));
  assert.ok(!JSON.stringify(value).includes(marker));
}
test('strict allowlist does not expose schema names, rows, or unrecognized diagnostic metadata',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("PRAGMA user_version=777; CREATE TABLE books(label TEXT); CREATE TABLE \""+marker+"\"(secret TEXT)");
    db.prepare('INSERT INTO books VALUES(?)').run(marker);
    const value=supportDiagnostics(db);exactShape(value);
    assert.equal(value.schemaVersion,'unrecognized');
    assert.equal(value.checks.books,'schema-present');assert.equal(value.checks.approvals,'schema-unavailable');
    assert.equal(Object.values(value.checks).filter(x=>x==='schema-present').length,1);
  }finally{db.close();}
});

async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),marker+'-')),database=join(folder,marker+'.sqlite');
  let books=newVault(marker+' fictional company'),company=books.companies[0].id;
  books=apply(books,company,{type:'employee',date:'2026-10-01',name:marker+' employee',rate:2100,state:'WA',locality:'Fixture'});
  const worker=books.companies[0].employees[0].id,hash=await passwordHash(password),db=openStore(database);
  try{tx(db,()=>{
    saveBooks(db,books);
    for(const [username,role,assignments] of [['owner','owner',[]],['manager','manager',[company]],['worker','worker',[company]]]){
      const id=putUser(db,null,{username,name:marker+' '+username,role,assignments,employeeId:role==='worker'?worker:''},hash,{bootstrap:true});
      audit(db,{id},company,'fixture secret',marker+' synthetic token value');
    }
  });}finally{db.close();}
  const suite=await createSuite({database,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(folder,{recursive:true,force:true});});
  return suite;
}
async function client(base,username,{assent=true}={}){
  let cookie='',csrf='';
  const req=async(path,body)=>{
    const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:base,'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),headers:r.headers};
  };
  const r=await req('login',{username,password});assert.equal(r.status,200,JSON.stringify(r.data));cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;
  if(assent&&r.data.termsRequired)assert.equal((await req('terms',fixtureAgreement)).status,200);
  return req;
}
test('only consenting ERP owner can obtain no-store diagnostics; records and paths stay absent',async t=>{
  const suite=await fixture(t),path='support/diagnostics';
  assert.equal((await fetch(suite.mainUrl+'/api/'+path)).status,401);
  const owner=await client(suite.mainUrl,'owner',{assent:false}),manager=await client(suite.mainUrl,'manager'),worker=await client(suite.workerUrl,'worker');
  assert.equal((await owner(path)).status,428);
  assert.equal((await owner('terms',fixtureAgreement)).status,200);
  assert.equal((await manager(path)).status,403);assert.equal((await worker(path)).status,404);assert.equal((await owner(path,{})).status,404);
  const result=await owner(path+'?note='+encodeURIComponent(marker));
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');exactShape(result.data);
  assert.equal(result.data.schemaVersion,2);
  assert.ok(Object.values(result.data.checks).every(value=>value==='schema-present'),JSON.stringify(result.data));
  assert.ok(!JSON.stringify(result.data).includes(password));
});
const chromiumPath=process.env.FIRMQUILL_BROWSER_EXE;
test('real Setup help preview downloads identical UTF-8 bytes with no telemetry or additional API requests',{skip:!chromiumPath},async t=>{
  const suite=await fixture(t),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:chromiumPath,headless:true});t.after(()=>browser.close());
  const shots=process.env.FIRMQUILL_DIAGNOSTICS_SHOTS;
  async function shot(page,name){if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:join(shots,name+'.png'),fullPage:true});}}
  async function login(username){
    const page=await browser.newPage({viewport:{width:1300,height:930}});page.setDefaultTimeout(12000);
    await page.goto(suite.mainUrl);await page.locator('#login [name=username]').fill(username);await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click();await acceptFixtureBrowser(page);
    await page.locator('[data-key="Setup help"]').click();await page.getByRole('heading',{name:'Public setup guide',exact:true}).waitFor();return page;
  }
  const owner=await login('owner'),manager=await login('manager'),network=[];
  assert.equal(await manager.getByRole('button',{name:'Preview diagnostics'}).count(),0);
  owner.on('request',req=>network.push({url:req.url(),method:req.method()}));
  await owner.getByRole('button',{name:'Preview diagnostics'}).click();const dialog=owner.locator('dialog[open]');
  const visible=await dialog.locator('[data-support-diagnostics-preview]').innerText();exactShape(JSON.parse(visible));
  await shot(owner,'01-owner-reviewed-diagnostics');
  const [download]=await Promise.all([owner.waitForEvent('download'),dialog.getByRole('button',{name:'Download diagnostics JSON'}).click()]);
  assert.equal(download.suggestedFilename(),'FirmQuill-Full-Suite-diagnostics.json');
  assert.deepEqual(await readFile(await download.path()),Buffer.from(visible,'utf8'));
  await owner.getByText('Diagnostics downloaded. Nothing was sent.',{exact:true}).waitFor();
  assert.deepEqual(network,[{url:suite.mainUrl+'/api/support/diagnostics',method:'GET'}]);
  await shot(owner,'02-local-download-complete');
});
