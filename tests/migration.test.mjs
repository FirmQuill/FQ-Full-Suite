import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore,putUser,passwordHash,safeUser,readBooks,tx,saveBooks} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {migrationCommand,migrationView,parseMigrationCsv,quickBooksIifContacts} from '../migration.mjs';
import {createSetupPackage,inspectSetupPackage,initializeSetupPackage} from '../setup-package.mjs';
import {fictionalBatches,fictionalSources} from '../fixtures/migration-fixture.mjs';

async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'fq-migration-')),db=openStore(join(dir,'operator.sqlite')),hash=await passwordHash('FICTIONAL migration password');const id=putUser(db,null,{username:'fixture-owner',name:'FICTIONAL Owner',role:'owner',assignments:[]},hash,{bootstrap:true});const user=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});const call=p=>migrationCommand(db,user,p),run=call({type:'create',companyName:'FICTIONAL Multi Source'});const stage=b=>call({...b,type:'stage',runId:run.runId,source:fictionalSources[b.source]});return {db,user,dir,call,run,stage};}
async function approvedFixture(t){const f=await fixture(t);for(const batch of fictionalBatches)f.stage(batch);f.call({type:'expectations',runId:f.run.runId,balances:{1000:52000,1100:7000,2000:-3000,3000:-50000,4000:-10000,5100:4000}});const preview=f.call({type:'preview',runId:f.run.runId});f.call({type:'approve',runId:f.run.runId,previewDigest:preview.digest,acceptExceptions:true});const approved=f.call({type:'package',runId:f.run.runId,approvedDigest:preview.digest});return {...f,preview,pkg:createSetupPackage(approved.dataset,approved.approval)};}

test('fictional multiple-source mapped onboarding reconciles and preserves historical payroll outside calculations',async t=>{
 const {db,user,preview,pkg,dir}=await approvedFixture(t);assert.equal(preview.counts.input,10);assert.equal(preview.counts.accepted,10);assert.equal(preview.counts.error,0);assert.equal(preview.reconciliation.independentlyVerified,true);assert.equal(preview.reconciliation.balanced,true);assert.equal(preview.reconciliation.trialDifferenceCents,0);assert.equal(preview.historicalCount,2);assert.deepEqual(readBooks(db).state.companies,[],'staging never changes operator books');
 const inspected=inspectSetupPackage(pkg.packageText);assert.equal(inspected.digest,pkg.digest);assert.match(inspected.gettingStarted,/FICTIONAL Multi Source/);const destination=join(dir,'customer.sqlite');await initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:pkg.digest});
 const customer=openStore(destination);try{const c=readBooks(customer).state.companies[0];assert.equal(c.parties.length,2);assert.equal(c.employees.length,0);assert.equal(c.time.length,0);assert.equal(customer.prepare('SELECT count(*) AS n FROM migration_historical').get().n,2);assert.equal(customer.prepare('SELECT count(*) AS n FROM accounts').get().n,0);assert.equal(customer.prepare('SELECT count(*) AS n FROM migration_setup_receipts').get().n,1);}finally{customer.close();}
 const bytes=await readFile(destination);await assert.rejects(initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:pkg.digest}),/already exists/);assert.deepEqual(await readFile(destination),bytes,'restart/retry cannot overwrite existing workspace');assert.deepEqual(migrationView(db,user).coverage.nativeAdapters,['quickbooks-desktop-iif-contacts']);
});
test('stable source IDs deduplicate, changed values conflict, cross-source duplicates surface and exclusions permit reviewed retry',async t=>{
 const f=await fixture(t);f.stage(fictionalBatches[1]);let p=f.stage(fictionalBatches[1]);assert.equal(p.counts.accepted,1);assert.equal(p.counts.duplicate,1);
 p=f.stage({...fictionalBatches[1],csv:'ID,Name,Kind\nc1,Fictional Buyer Changed,Customer\n'});assert.equal(p.counts.conflict,1);
 p=f.stage({...fictionalBatches[1],source:'vendors'});assert.equal(p.counts['duplicate-candidate'],1);assert.equal(p.liveRecordCounts.contacts,1);assert.equal(p.unresolved.length,3);
 const unresolved=p.unresolved.find(r=>r.status==='conflict');p=f.call({type:'exclude',runId:f.run.runId,items:[{batchId:unresolved.batchId,line:unresolved.line}]});assert.equal(p.counts.conflict,0);assert.equal(p.counts.excluded,1);assert.throws(()=>f.call({type:'approve',runId:f.run.runId,previewDigest:p.digest}),/Explicitly accept/);assert.doesNotThrow(()=>f.call({type:'approve',runId:f.run.runId,previewDigest:p.digest,acceptExceptions:true}));
});
test('row errors, missing references, period/amount errors are isolated; mapping profiles and correction preserve valid rows',async t=>{
 const f=await fixture(t);f.call({type:'profile',name:'fictional contacts',recordType:'contacts',mapping:fictionalBatches[1].mapping});let p=f.stage({...fictionalBatches[1],profileName:'fictional contacts',mapping:undefined,csv:'ID,Name,Kind\nc1,Fictional Buyer,Customer\nbad,Fictional Invalid,Other\n'});assert.equal(p.counts.accepted,1);assert.equal(p.counts.error,1);
 p=f.stage({...fictionalBatches[3],csv:'ID,Contact,Date,Dollars,Description\ni1,missing,11/01/2026,100.00,Fictional Missing Contact\ni2,c1,11/01/2026,100.00,Fictional Valid Invoice\ni3,c1,99/99/2026,100.00,Fictional Bad Date\n'});assert.equal(p.counts.error,3);assert.equal(p.liveRecordCounts.contacts,1);assert.equal(p.liveRecordCounts.documents,4);assert.equal(p.liveRecordCounts.journals,1,'failed rows leave no partially posted invoice');
 const old=p.digest;f.stage({...fictionalBatches[1],csv:'ID,Name,Kind\nmissing,Fictional Later Contact,Customer\n'});p=f.call({type:'preview',runId:f.run.runId});assert.equal(p.counts.error,2);assert.equal(p.liveRecordCounts.journals,2);assert.throws(()=>f.call({type:'approve',runId:f.run.runId,previewDigest:old,acceptExceptions:true}),/Staging changed/);
 assert.throws(()=>f.call({type:'expectations',runId:f.run.runId,balances:{1000:9}})&&f.call({type:'approve',runId:f.run.runId,previewDigest:f.call({type:'preview',runId:f.run.runId}).digest,acceptExceptions:true}),/Expected balances differ/);
});
test('generic CSV strict quoting/IDs and existing verified bank interchange are reused without native-schema claims',async t=>{
 assert.deepEqual(parseMigrationCsv('ID,Name\na,"Fictional, Buyer"\nb,"Two\nLines"\n').rows.map(r=>r.values),[['a','Fictional, Buyer'],['b','Two\nLines']]);assert.throws(()=>parseMigrationCsv('ID,ID\na,b'),/headers/);assert.throws(()=>parseMigrationCsv('ID,Name\na,"broken'),/Unclosed/);
 const f=await fixture(t);const p=f.call({type:'stage',runId:f.run.runId,source:fictionalSources.books,recordType:'bank',bankProfile:'quickbooks',csv:'Date,Description,Amount\n01/11/2026,Fictional bank receipt,30.00\n'});assert.equal(p.liveRecordCounts.bank,1);assert.equal(p.reconciliation.acceptedTotalsCents.bank,3000);assert.throws(()=>f.stage({...fictionalBatches[1],mapping:{name:'Name',kind:'Kind'}}),/stable sourceId/);
});
test('permissions isolate migration/historical archives; staging preserves existing books and unrelated users',async t=>{
 const f=await fixture(t),original=sampleVault();tx(f.db,()=>saveBooks(f.db,original));for(const role of ['manager','hr','payroll','worker','viewer']){const u={id:'fictional-'+role,role,assignments:[original.companies[0].id]};assert.throws(()=>migrationView(f.db,u),/Owner access/);assert.throws(()=>migrationCommand(f.db,u,{type:'historical-archive',companyId:original.companies[0].id}),/Owner access/);}f.stage(fictionalBatches[1]);assert.deepEqual(readBooks(f.db).state,original);
});
test('package corruption, traversal filenames, oversized files and missing references fail before publication and allow retry',async t=>{
 const {pkg,dir}=await approvedFixture(t),destination=join(dir,'retry.sqlite');const corrupt=JSON.parse(pkg.packageText);corrupt.files[0].content+=' ';await assert.rejects(initializeSetupPackage({packageText:JSON.stringify(corrupt),destination,confirmedDigest:pkg.digest}),/size|integrity/);await assert.rejects(stat(destination),{code:'ENOENT'});
 const traversal=JSON.parse(pkg.packageText);traversal.files[0].name='../mapped.json';assert.throws(()=>inspectSetupPackage(JSON.stringify(traversal)),/filename/);const huge=JSON.parse(pkg.packageText);huge.files[0].size=999999999;assert.throws(()=>inspectSetupPackage(JSON.stringify(huge)),/size/);
 await assert.rejects(initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:'wrong'}),/confirm/);await initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:pkg.digest});assert.ok((await stat(destination)).size>0);
});
test('host package preview is read-only and noninteractive setup cancellation leaves a fresh destination retryable',async t=>{
 const {pkg,dir}=await approvedFixture(t),file=join(dir,'fictional.fqsetup.json'),destination=join(dir,'cli.sqlite');await writeFile(file,pkg.packageText,{mode:0o600});const host=new URL('../host.mjs',import.meta.url);
 const run=cmd=>spawnSync(process.execPath,[fileURLToPath(host),cmd,file],{env:{...process.env,FIRMQUILL_DB:destination},encoding:'utf8'});
 const preview=run('setup-preview');assert.equal(preview.status,0,preview.stderr);assert.equal(JSON.parse(preview.stdout).digest,pkg.digest);await assert.rejects(stat(destination),{code:'ENOENT'});
 const cancel=run('setup');assert.equal(cancel.status,1);assert.match(cancel.stderr,/interactive terminal/);await assert.rejects(stat(destination),{code:'ENOENT'});await initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:pkg.digest});
 const occupied=run('setup');assert.equal(occupied.status,1);assert.match(occupied.stderr,/Existing workspaces/);const customer=openStore(destination);try{assert.equal(customer.prepare('SELECT count(*) AS n FROM migration_setup_receipts').get().n,1);}finally{customer.close();}
});

const groupedMapping={sourceId:'Document',lineId:'Line',contactRef:'Contact',date:'Date',itemName:'Service',quantity:'Quantity',unitCents:{column:'Unit',transform:'decimalDollars'},discountCents:{column:'Discount',transform:'decimalDollars'},amountCents:{column:'Net',transform:'decimalDollars'},description:'Description'};
const groupedHeader='Document,Line,Contact,Date,Service,Quantity,Unit,Discount,Net,Description\n';
const groupedRows=['doc-a,b,c1,2026-11-01,Design work,1,30.00,,30.00,Two extras','doc-a,a,c1,2026-11-01,Planning work,2,40.00,5.00,75.00,Two extras'];
test('grouped service CSV applies discounts, deduplicates physical order, links payment and reconciles approved setup',async t=>{
 const f=await fixture(t);f.stage(fictionalBatches[1]);const pay={source:'books',recordType:'payments',csv:'ID,Document,Type,Date,Cents,Description\np1,doc-a,invoices,2026-11-03,2000,Fictional receipt\n',mapping:fictionalBatches[5].mapping};f.stage(pay);
 let p=f.stage({source:'books',recordType:'invoiceLines',csv:groupedHeader+groupedRows.join('\n')+'\n',mapping:groupedMapping});assert.equal(p.counts.accepted,3);
 p=f.stage({source:'books',recordType:'invoiceLines',csv:groupedHeader+groupedRows.toReversed().join('\n')+'\n',mapping:groupedMapping});assert.equal(p.counts.duplicate,1);
 assert.equal(p.reconciliation.acceptedTotalsCents.invoices,10500);assert.equal(p.reconciliation.balances[1100],8500);assert.equal(p.reconciliation.balances[1000],2000);assert.equal(p.reconciliation.balances[4000],-10500);
 assert.deepEqual(p.outcomes.find(r=>r.recordType==='invoiceLines'&&r.status==='accepted').sourceRows,[2,3]);
 p=f.call({type:'expectations',runId:f.run.runId,balances:{1000:2000,1100:8500,4000:-10500}});
 f.call({type:'approve',runId:f.run.runId,previewDigest:p.digest,acceptExceptions:true});
 const staged=f.call({type:'package',runId:f.run.runId,approvedDigest:p.digest}),pkg=createSetupPackage(staged.dataset,staged.approval),destination=join(f.dir,'grouped.sqlite');
 await initializeSetupPackage({packageText:pkg.packageText,destination,confirmedDigest:pkg.digest});const actual=openStore(destination);
 try{const c=readBooks(actual).state.companies[0],inv=c.docs.find(d=>d.kind==='invoice');assert.equal(inv.lines.length,2);assert.deepEqual(inv.lines.map(l=>l.discount),[500,0]);assert.equal(c.docs.find(d=>d.kind==='collection').parent,inv.id);}finally{actual.close();}
});
test('wrong amount or duplicate group line blocks entire proposed invoice while other good documents still stage',async t=>{
 const f=await fixture(t);f.stage(fictionalBatches[1]);
 const p=f.stage({source:'books',recordType:'invoiceLines',csv:groupedHeader+groupedRows[0].replace('30.00,,30.00','30.00,,29.00')+'\n'+groupedRows[1]+'\n'+groupedRows[1].replace('doc-a,a,','doc-b,a,')+'\n',mapping:groupedMapping});
 assert.equal(p.counts.error,1);assert.deepEqual(p.unresolved[0].sourceRows,[2,3]);assert.equal(p.reconciliation.balances[1100],7500);assert.equal(p.counts.accepted,2);assert.throws(()=>f.stage({source:'books',recordType:'invoiceLines',csv:groupedHeader+groupedRows[0].slice('doc-a'.length)+'\n',mapping:groupedMapping}),/stable document source ID/);
});
test('native QuickBooks export layout stages only flat contact names from REFNUM or a deliberate crosswalk',async t=>{
 const f=await fixture(t);
 const iif='!HDR\tPROD\tVER\tREL\tIIFVER\tDATE\tTIME\r\nHDR\tQuickBooks Premier\tVersion 20.0D\tRelease R6\t1\t1/1/2010\t794236875\r\n!CUST\tNAME\tBADDR1\tBADDR2\tREFNUM\r\nCUST\t"Example, Customer"\tDo not stage this address\t\t120\r\nCUST\tSynthetic Other\t\t\t\r\nCUST\tSynthetic Other:Job\t\t\t180\r\n';
 const profile={type:'stage',runId:f.run.runId,source:fictionalSources.books,recordType:'contacts',nativeProfile:'quickbooks-desktop-iif-contacts',contactKind:'Customer',csv:iif,iifCrosswalk:{'Synthetic Other':'customer-synthetic-2'}};
 const p=f.call(profile);assert.equal(p.counts.accepted,2);assert.equal(p.counts.error,1);assert.match(p.unresolved[0].detail,/Hierarchical/);
 assert.ok(!JSON.stringify(p).includes('Do not stage this address'));
 assert.deepEqual(p.outcomes.filter(r=>r.status==='accepted').map(r=>r.sourceIdValue),['qbd-cust-120','customer-synthetic-2']);
 const missing=quickBooksIifContacts(iif,'Customer');assert.match(missing[1].error,/No stable REFNUM/);
 const next=f.call(profile);assert.equal(next.counts.duplicate,2);assert.equal(next.liveRecordCounts.contacts,2);
 assert.throws(()=>quickBooksIifContacts(iif+'!TRNS\tTRNSID\n','Customer'),/combined IIF or transaction/);
 assert.throws(()=>quickBooksIifContacts(iif,'Vendor'),/one flat vendor list/);
});
