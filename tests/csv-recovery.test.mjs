import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {newVault,apply,statements} from '../shared/core.mjs';
import {previewBankCsv,bankImportReview,statementFingerprint} from '../shared/interop.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash,readBooks} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

const password='Fictional CSV recovery test password';
const bookingDay='2026-11-26',initial={date:'2026-11-25',amountCents:2900,description:'Previously imported CSV row',sourceRef:'untracked-previous'};
const csvRef=row=>'bank-v1/1/'+JSON.stringify([row.date,row.description,row.amountCents]);
async function fixture(t,legacy={...initial,sourceRef:csvRef(initial)}){
 const dir=await mkdtemp(join(tmpdir(),'fq-csv-undo-')),dbfile=join(dir,'fictional.sqlite');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 let s=newVault('Fictional CSV shop');const company=s.companies[0].id;
 const b=()=>s.companies[0],post=(type,date,extra)=>{s=apply(s,company,{type,date,...extra});};
 post('journal','2026-09-30',{label:'Opening capital',lines:[['1000',100000],['3000',-100000]],flow:'Financing'});
 post('journal','2026-11-05',{label:'Bank matched capital',lines:[['1000',4000],['3000',-4000]],flow:'Financing'});
 post('journal','2026-11-07',{label:'Pending match cash',lines:[['1000',1000],['3000',-1000]],flow:'Financing'});
 post('statement import',bookingDay,{rows:[legacy]});
 const oldRow=b().bank[0];
 post('employee',bookingDay,{name:'Fictional employee',state:'WA',locality:'Tacoma',rate:2500});
 post('company',bookingDay,{name:'Fictional second company',activities:[]});const other=s.companies[1].id;
 const db=openStore(dbfile),hash=await passwordHash(password);
 try{tx(db,()=>{
  saveBooks(db,s);
  for(const [role,companyId] of [['owner',company],['manager',company],['viewer',company],['bookkeeper',company],['worker',company],['other-manager',other]]){
   putUser(db,null,{username:'qa-'+role,name:'Fictional '+role,role:role==='other-manager'?'manager':role,assignments:role==='owner'?[]:[companyId],...(role==='worker'?{employeeId:b().employees[0].id}:{})},hash,{bootstrap:true});
  }
 });}finally{db.close();}
 const suite=await createSuite({database:dbfile,mainPort:0,workerPort:0});t.after(()=>suite.close());
 const inspect=fn=>{const db=openStore(dbfile);try{return fn(db);}finally{db.close();}};
 return {...suite,company,other,oldRow,inspect,dbfile};
}
async function api(base,path,session,data){
 const rsp=await fetch(base+'/api/'+path,{method:data?'POST':'GET',headers:{...(session?.cookie?{cookie:session.cookie}:{}),...(data?{origin:base,'content-type':'application/json','x-csrf-token':session?.csrf||''}:{})},...(data?{body:JSON.stringify(data)}:{})});
 return {status:rsp.status,data:await rsp.json(),cookie:rsp.headers.get('set-cookie')?.split(';')[0]};
}
async function login(base,role,accept=true){
 let out=await api(base,'login',null,{username:'qa-'+role,password});assert.equal(out.status,200);
 const session={cookie:out.cookie,csrf:out.data.csrf};
 if(accept){out=await api(base,'terms',session,fixtureAgreement);assert.equal(out.status,200);}
 return session;
}
function scope(base,company,user){
 const route='csv-import-recovery?companyId='+company;
 return {list:()=>api(base,route,user),preview:id=>api(base,route+'&batch='+id,user),undo:(batch,reviewToken,confirm=true)=>api(base,route,user,{batch,reviewToken,confirm})};
}
function poster(base,company){
 return async (user,type,options={})=>{
  const current=(await api(base,'session',user));assert.equal(current.status,200);
  return api(base,'action',user,{companyId:company,revision:current.data.revision,action:{requestId:randomUUID(),type,date:bookingDay,...options}});
 };
}
async function normalized(csv,existing=[],picks=[]){
 const preview=previewBankCsv(csv,'wave',existing);
 const statementKey=await statementFingerprint(preview,0,preview.totalCents);
 return bankImportReview(preview,existing,statementKey,picks).rows;
}
const csv=(...rows)=>'Date,Description,Amount\n'+rows.join('\n');
test('HTTP reviewed undo removes only new unmatched rows; preserves explicit matches, pending, closed/sealed/reconciled rows, company boundaries and later books',async t=>{
 const {mainUrl,workerUrl,company,other,oldRow,inspect}=await fixture(t),owner=await login(mainUrl,'owner',false);
 const a=scope(mainUrl,company,owner),post=poster(mainUrl,company);
 assert.equal((await a.list()).status,428);
 assert.equal((await api(mainUrl,'terms',owner,fixtureAgreement)).status,200);
 assert.equal((await scope(mainUrl,company).list()).status,401);
 for(const role of ['manager','viewer','bookkeeper','other-manager'])assert.equal((await scope(mainUrl,company,await login(mainUrl,role)).list()).status,403);
 assert.equal((await scope(workerUrl,company,await login(workerUrl,'worker')).list()).status,404);
 assert.equal((await a.preview(oldRow.source)).status,404);
 const firstRows=await normalized(csv('2026-10-17,Month end protected,1.00','2026-11-05,Matched cash,40.00','2026-11-06,Wrong bank CSV,21.00','2026-11-07,Pending match,10.00','2026-11-08,Later wrong CSV,99.00'),[oldRow]);
 const idempotent=randomUUID();
 assert.equal((await post(owner,'statement import',{requestId:idempotent,rows:firstRows,csvRecovery:true,label:'Bank CSV import'})).status,200);
 assert.equal((await post(owner,'statement import',{requestId:idempotent,rows:firstRows,csvRecovery:true,label:'Bank CSV import'})).status,200);
 let list=(await a.list()).data.batches;assert.equal(list.length,1);
 const {id}=list[0],before=(await a.preview(id)).data;
 assert.equal(before.rows.length,5);assert.equal(before.eligible,5);
 assert.equal((await scope(mainUrl,other,owner).preview(id)).status,404);
 assert.equal((await a.undo(id,before.reviewToken,false)).status,400);
 const read=()=>inspect(db=>readBooks(db).state.companies[0]);
 const matched=read().bank.find(r=>r.description==='Matched cash'),m=read().entries.find(r=>r.memo==='Bank matched capital');
 assert.equal((await post(owner,'match',{date:'2026-11-05',row:matched.id,entry:m.id})).status,200);
 const preparePath='month-end-close?companyId='+company+'&period=2026-10';
 const current=(await api(mainUrl,preparePath,owner)).data;
 assert.equal((await api(mainUrl,preparePath,owner,{action:{type:'prepare',period:'2026-10',version:0,digest:current.digest,note:'Synthetic saved October packet'}})).status,200);
 const clerk=await login(mainUrl,'bookkeeper');
 const pending=read().bank.find(r=>r.description==='Pending match'),j=read().entries.find(r=>r.memo==='Pending match cash');
 assert.ok((await post(clerk,'match',{date:'2026-11-07',row:pending.id,entry:j.id})).data.pendingApproval);
 const unrelatedRows=await normalized(csv('2026-11-11,Another legitimate import,49.00'),read().bank);
 assert.equal((await post(owner,'statement import',{rows:unrelatedRows,csvRecovery:true,label:'Later legitimate CSV'})).status,200);
 assert.equal((await post(owner,'journal',{label:'Later legitimate journal',lines:[['1000',13000],['3000',-13000]],flow:'Financing'})).status,200);
 const saved=read(),basis=statements(saved.entries,'2026-09-01',bookingDay);
 const packet=inspect(db=>db.prepare('SELECT * FROM month_end_close').get());
 const prior=(await a.preview(id)).data;assert.equal(prior.eligible,2);
 assert.deepEqual(prior.rows.map(r=>r.status),['Protected by a saved month-end close packet','Matched to a cash entry',null,'Referenced by a pending match or reconciliation',null]);
 assert.equal((await a.undo(id,before.reviewToken)).status,409);
 assert.deepEqual(read(),saved);
 const done=await a.undo(id,prior.reviewToken);assert.equal(done.status,200);assert.deepEqual(done.data,{removed:2,repeated:false});
 assert.deepEqual((await a.undo(id,prior.reviewToken)).data,{removed:2,repeated:true});
 assert.equal((await a.undo(id,before.reviewToken)).status,409);
 const after=read();assert.deepEqual(after,{...saved,bank:saved.bank.filter(r=>!['Wrong bank CSV','Later wrong CSV'].includes(r.description))});
 assert.deepEqual(statements(after.entries,'2026-09-01',bookingDay),basis);
 assert.deepEqual(inspect(db=>db.prepare('SELECT * FROM month_end_close').get()),packet);
 assert.equal(inspect(db=>db.prepare("SELECT count(*) n FROM audit WHERE kind='CSV import recovery'").get().n),1);
 assert.equal((await a.preview(id)).data.removed,2);assert.equal((await a.preview(id)).data.eligible,0);
});
test('posted approval is tracked; saved opening/reconciliation and closed Cutoff remain bit-for-bit',async t=>{
 const initial={date:'2026-11-25',amountCents:2900,description:'Previously imported CSV row',sourceRef:'untracked-previous'};
 const {mainUrl,company,inspect}=await fixture(t,initial),owner=await login(mainUrl,'owner'),clerk=await login(mainUrl,'bookkeeper');
 const a=scope(mainUrl,company,owner),post=poster(mainUrl,company),read=()=>inspect(db=>readBooks(db).state.companies[0]);
 const input=await normalized(csv('2026-11-05,Cleared cash,40.00','2026-11-06,Retain due to close,11.00','2026-11-15,Outer case may undo,12.00'));
 const proposal=(await post(clerk,'statement import',{rows:input,csvRecovery:true,label:'Bank CSV import'})).data.pendingApproval;assert.ok(proposal);
 assert.deepEqual((await a.list()).data.batches,[]);
 const rev=(await api(mainUrl,'session',owner)).data.revision;
 assert.equal((await api(mainUrl,'approve',owner,{id:proposal,decision:'approve',revision:rev})).status,200);
 const batch=(await a.list()).data.batches[0].id;
 const row=read().bank.find(r=>r.description==='Cleared cash'),cash=read().entries.find(r=>r.memo==='Bank matched capital');
 assert.equal((await post(owner,'match',{date:'2026-11-05',row:row.id,entry:cash.id})).status,200);
 assert.equal((await post(owner,'reconcile',{date:'2026-11-05',closing:104000,openingBasis:{through:'2026-09-30',balance:100000,outstanding:[]}})).status,200);
 assert.equal((await post(owner,'close',{date:'2026-11-10'})).status,200);
 const before=read(),p=(await a.preview(batch)).data;
 assert.deepEqual(p.rows.map(r=>r.status),['Protected by a saved reconciliation','Inside a closed accounting period',null]);
 assert.deepEqual((await a.undo(batch,p.reviewToken)).data,{removed:1,repeated:false});
 assert.deepEqual(read(),{...before,bank:before.bank.filter(r=>r.description!=='Outer case may undo')});
});
const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('owner uses real Banking CSV preview and recovery dialog with duplicate warning and result', {skip:!executable,timeout:60000},async t=>{
 const {mainUrl,inspect}=await fixture(t);
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(mainUrl);await page.locator('#login [name=username]').fill('qa-owner');await page.locator('#login [name=password]').fill(password);
 const click=name=>page.getByRole('button',{name,exact:true}).first().click();
 await click('Sign in');await click('I agree to the Terms of Service');
 await page.locator('nav [data-act="nav"][data-key="Banking"]').first().click();
 const modal=page.locator('dialog[open]');
 async function bankCsv(text,end){
  await click('Import CSV');await modal.locator('[name=file]').setInputFiles({name:'fixture.csv',mimeType:'text/csv',buffer:Buffer.from(text)});
  await modal.locator('[name=opening]').fill('0.00');await modal.locator('[name=closing]').fill(end);
  await click('Preview');await click('Import lines');
  await modal.waitFor({state:'hidden'});
 }
 await bankCsv(csv('2026-11-10,Wrong imported bank row,25.00','2026-11-25,Previously imported CSV row,29.00'),'54.00');
 await bankCsv(csv('2026-11-11,Later legitimate bank row,14.00'),'14.00');
 await page.getByRole('button',{name:'Review CSV batch',exact:true}).nth(1).click();
 await modal.getByText('Wrong imported bank row',{exact:true}).waitFor();
 assert.equal(await modal.getByText('Later legitimate bank row',{exact:true}).count(),0);
 assert.equal(await modal.getByText('Previously imported CSV row',{exact:true}).count(),0);
 const images=process.env.FIRMQUILL_CSV_RECOVERY_SHOTS;
 if(images){await mkdir(images,{recursive:true});await page.screenshot({path:join(images,'01-batch-preview.png')});}
 const before=inspect(db=>readBooks(db).state.companies[0]);
 await modal.getByRole('checkbox').check();await click('Remove eligible rows');
 await page.getByText('1 unmatched CSV row removed. No journal changed.',{exact:true}).waitFor();
 const after=inspect(db=>readBooks(db).state.companies[0]);
 assert.deepEqual(after,{...before,bank:before.bank.filter(r=>r.description!=='Wrong imported bank row')});
 await page.getByRole('button',{name:'Review CSV batch',exact:true}).nth(1).click();
 await modal.getByText('Removed by this reviewed undo',{exact:true}).waitFor();assert.equal(await modal.getByRole('button',{name:'Remove eligible rows'}).count(),0);
 if(images)await page.screenshot({path:join(images,'02-review-receipt.png')});
 assert.deepEqual(errors,[]);
});
