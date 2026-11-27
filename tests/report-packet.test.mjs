import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {openStore,tx,saveBooks,putUser,passwordHash,readBooks} from '../store.mjs';
import {newVault,apply} from '../shared/core.mjs';
import {defaultPacket,packetCsv} from '../shared/report-packet.mjs';
import {projectCommand} from '../project-workspace.mjs';
import {createSuite} from '../server.mjs';
import {acceptFixtureBrowser,seedFixtureTerms} from './fixture-terms.mjs';
const password='Only fictional report packet testing 2026!';
const from='2026-10-01',through='2026-10-31';
const journal=(date,label,lines,flow)=>({type:'journal',date,label,lines,flow});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'fq-report-packet-')),database=join(dir,'test.sqlite');
 let state=newVault('=Example Transport',['jobs']),companyId=state.companies[0].id;
 for(const a of [
   journal('2026-09-01','Private investment source',[['1000',50000],['3000',-50000]],'Financing'),
   journal('2026-10-06','Operating sale',[['1000',12525],['4000',-12525]],'Operating'),
   journal('2026-10-11','Outflow',[['5100',2550],['1000',-2550]],'Operating'),
   journal('2026-11-01','Later cutoff excluded',[['1000',100],['4000',-100]],'Operating'),
   {type:'company',date:'2026-11-01',name:'Separated company',activities:[]}
 ])state=apply(state,companyId,a);
 const ac=a=>{state=apply(state,companyId,a);return state.companies[0].docs.at(-1)?.id;};
 const dated={date:'2026-10-20'};
 ac({type:'contact',kind:'Vendor',name:'Private source vendor',...dated});ac({type:'item',kind:'Service',name:'Accrued operations',...dated});
 const first=state.companies[0],po=ac({type:'purchase order',party:first.parties[0].id,item:first.items[0].id,qty:1,unit:1000,...dated});
 const receiving=ac({type:'receiving',parent:po,...dated});ac({type:'bill',parent:receiving,...dated});
 const db=openStore(database),hash=await passwordHash(password),other=state.companies.at(-1).id;
 try{tx(db,()=>{
   saveBooks(db,state);
   for(const [username,role,assignments,areas] of [['owner','owner',[],[]],['reports','viewer',[companyId],['Reports']],['blind','viewer',[companyId],['Directory']],['other','viewer',[other],['Reports']]])
     putUser(db,null,{username,name:'Fictional '+username,role,assignments,areas},hash,{bootstrap:true});
   seedFixtureTerms(db);
 });}finally{db.close();}
 const server=await createSuite({database,mainPort:0,workerPort:0});
 t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
 const restrict=()=>{const db=openStore(database);try{tx(db,()=>{
   const owner={id:db.prepare("SELECT id FROM accounts WHERE username='owner'").get().id,role:'owner'};
   const created=projectCommand(db,owner,readBooks(db).state,{type:'project-save',companyId,name:'Restricted source project',departmentId:'legal',visibility:'restricted',date:'2026-10-15',readers:[]});
   saveBooks(db,apply(created.state,companyId,{type:'job expense',job:created.result.projectId,date:'2026-10-20',label:'Confidential accrual source',amount:1234}));
 });}finally{db.close();}};
 const mutate=()=>{const db=openStore(database);try{tx(db,()=>saveBooks(db,apply(readBooks(db).state,companyId,journal('2026-10-31','Late posted income',[['1000',500],['4000',-500]],'Operating'))));}finally{db.close();}};
 return {server,companyId,other,database,dir,mutate,restrict};
}
async function client(origin,username){
 let cookie='',csrf='';
 const get=async(path,body)=>{
  const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),headers:r.headers};
 };
 const result=await get('login',{username,password});assert.equal(result.status,200);
 cookie=result.headers.get('set-cookie').split(';')[0];csrf=result.data.csrf;return get;
}
const url=id=>'report-packets?companyId='+encodeURIComponent(id);
const options={...defaultPacket(through),title:'@Lending packet',from,through,sections:['trial','income','cash','balance']};
const amount=(p,k,label)=>p.sections.find(s=>s.kind===k).rows.find(r=>r.label===label).amounts[0];
test('packet HTTP ties independently to ledger, filters and protects per-account/per-company templates',async t=>{
 const f=await fixture(t),origin=f.server.mainUrl,id=f.companyId;
 const owner=await client(origin,'owner'),reports=await client(origin,'reports'),blind=await client(origin,'blind'),other=await client(origin,'other');
 assert.equal((await blind(url(id))).status,403);assert.equal((await other(url(id))).status,404);
 assert.equal((await reports(url(f.other),{type:'preview',options})).status,404);
 const packet=(await reports(url(id),{type:'preview',options})).data.packet;
 assert.deepEqual(packet.sections.map(s=>s.kind),options.sections);
 assert.equal(amount(packet,'balance','Total assets'),59975);
 assert.equal(amount(packet,'balance','Total liabilities'),1000);
 assert.equal(amount(packet,'balance','Total liabilities and equity'),59975);
 assert.equal(amount(packet,'income','Total revenue'),12525);
 assert.equal(amount(packet,'income','Total expenses'),3550);
 assert.equal(amount(packet,'income','Net income'),8975);
 assert.equal(amount(packet,'cash','Opening operating cash'),50000);
 assert.equal(amount(packet,'cash','Operating'),9975);
 assert.equal(amount(packet,'cash','Closing operating cash'),59975);
 assert.deepEqual(packet.sections[0].rows.at(-1).amounts,[63525,63525]);
 assert.doesNotMatch(JSON.stringify(packet),/Private investment source|Later cutoff excluded|Fictional owner/);
 const csv=packetCsv(packet);assert.match(csv,/"'@Lending packet","'=Example Transport"/);
 assert.match(csv,/"Net income","","",89\.75,,,/);
 const filtered=(await reports(url(id),{type:'preview',options:{...options,trialClass:'Expense',columns:{codes:false,classes:false}}})).data.packet;
 assert.deepEqual(filtered.sections[0].headers,['Account','Debit (USD)','Credit (USD)']);
 assert.deepEqual(filtered.sections[0].rows.at(-1).amounts,[3550,0]);
 assert.match(filtered.sections[0].note,/not a full trial balance/);
 assert.equal((await reports(url(id),{type:'preview',options:{...options,from:'2026-02-31'}})).status,400);
 assert.equal((await reports(url(id),{type:'preview',options:{...options,sections:['income','income']}})).status,400);
 const save=(await reports(url(id),{type:'save',name:'Financing packet',options:{...options,untrustedCachedRows:{income:10}}})).data;
 assert.equal(save.templates.length,1);assert.equal(save.templates[0].options.untrustedCachedRows,undefined);
 assert.doesNotMatch(JSON.stringify(save),/8975|59975/);
 assert.deepEqual((await owner(url(id))).data.templates,[]);
 assert.equal((await owner(url(id),{type:'delete',id:save.templateId,version:1})).status,404);
 assert.equal((await reports(url(id),{type:'save',name:'Financing packet',id:save.templateId,version:0,options})).status,409);
 f.mutate();
 const saved=(await reports(url(id))).data.templates[0];
 const changed=(await reports(url(id),{type:'preview',options:saved.options})).data.packet;
 assert.equal(amount(changed,'income','Net income'),9475);
 assert.equal((await reports(url(id),{type:'delete',id:save.templateId,version:1})).status,200);
 assert.deepEqual((await reports(url(id))).data.templates,[]);
 f.restrict();
 const hidden=(await reports(url(id),{type:'preview',options})).data.packet;
 const full=(await owner(url(id),{type:'preview',options})).data.packet;
 assert.equal(hidden.restricted,true);assert.equal(full.restricted,false);
 assert.equal(amount(hidden,'income','Net income'),9475);
 assert.equal(amount(full,'income','Net income'),8241);
 assert.match(packetCsv(hidden),/permitted records only/);
 assert.doesNotMatch(JSON.stringify(hidden),/Confidential accrual source|Restricted source project/);
});

const executable=process.env.FIRMQUILL_BROWSER_EXE;
test('report builder browser previews, reorders, saves templates, and manually exports current PDF and CSV',{skip:!executable},async t=>{
 const f=await fixture(t),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({acceptDownloads:true,viewport:{width:1360,height:960}}),errors=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.server.mainUrl);
 await page.locator('#login [name=username]').fill('reports');await page.locator('#login [name=password]').fill(password);
 await page.locator('#login button').click();await acceptFixtureBrowser(page);
 await page.locator('[data-act="nav"][data-key="Report builder"]').click();
 await page.getByLabel('Packet title').fill('Fictional lender packet');
 await page.getByLabel('From',{exact:true}).fill(from);
 await page.getByLabel('Through / as of').fill(through);
 await page.getByRole('button',{name:'Move Income statement up'}).click();
 await page.getByLabel('Template name').fill('Loan template');
 await page.getByRole('button',{name:'Save template'}).click();
 await page.getByText('Template saved.').waitFor();
 await page.getByRole('button',{name:'Build preview'}).click();
 const preview=page.locator('.packet-printable');await preview.waitFor();
 assert.equal(await preview.locator('h3').first().textContent(),'Income statement');
 assert.match(await preview.innerText(),/Net income\s+\$89\.75/);
 assert.equal(await page.getByRole('button',{name:'Download packet CSV'}).count(),1);
 f.mutate();
 await page.getByRole('button',{name:'Download packet CSV'}).click();
 await page.getByText('Books or permissions changed. Review the refreshed preview and choose export again.').waitFor();
 assert.match(await preview.innerText(),/Net income\s+\$94\.75/);
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download packet CSV'}).click();
 const download=await downloading,text=await readFile(await download.path(),'utf8');
 assert.match(text,/"Net income","","",94\.75,,,/);
 await page.evaluate(()=>{window.print=()=>{window.printWasInvoked=document.body.classList.contains('printing-report-packet');};});
 await page.getByRole('button',{name:'Print / Save as PDF'}).click();
 await page.waitForFunction(()=>window.printWasInvoked===true);
 await page.evaluate(()=>document.body.classList.add('printing-report-packet'));
 const pdf=join(f.dir,'packet.pdf');await page.pdf({path:pdf,format:'Letter',printBackground:true});
 const extraction=spawnSync('pdftotext',[pdf,'-'],{encoding:'utf8'});
 if(!extraction.error){assert.equal(extraction.status,0,extraction.stderr);assert.match(extraction.stdout,/Fictional lender packet/);assert.match(extraction.stdout,/94\.75/);assert.doesNotMatch(extraction.stdout,/Template name|Sign out|Download packet CSV/);}
 assert.deepEqual(errors,[]);
});
