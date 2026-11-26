import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,lstat,link,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,tx,saveBooks,readBooks,audit,requireThat} from './store.mjs';
import {initializeMigration,previewMigration,validateMigrationDataset,migrationDigest} from './migration.mjs';

export const SETUP_PACKAGE_VERSION='0.3.0-preview.1';
export const MAX_SETUP_BYTES=16*1024*1024;
const names=['mapped.json','provenance.json','exceptions.json','reconciliation.json','getting-started.txt'];
const fail=(ok,message,status=400)=>requireThat(ok,status,message);
const sha=text=>createHash('sha256').update(text).digest('hex');
const encode=x=>JSON.stringify(x);
const keys=(o,allowed)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>allowed.includes(k));
const publicReport=p=>({counts:p.counts,batches:p.batches,unresolved:p.unresolved,reconciliation:p.reconciliation,historicalCount:p.historical.length});
function provenance(dataset){return dataset.batches.map(b=>({batchId:b.id,source:b.source,recordType:b.recordType,mapping:b.mapping,profileName:b.profileName,csvSha256:b.csvSha256,rows:b.rows.length}));}
function guide(dataset,preview){return `FirmQuill customer getting-started guide\nInstalled application: ${SETUP_PACKAGE_VERSION}\nCompany: ${dataset.company.name}\nCompany ID: ${dataset.company.id}\n\nMigrated scope\n${preview.counts.accepted} accepted mapped records from ${new Set(dataset.batches.map(b=>b.source.id)).size} source(s). ${preview.historical.length} restricted historical archive rows. All records are USD. Generic mapped CSV coverage does not certify vendor-native exports.\n\nExceptions\n${preview.unresolved.length} unresolved or intentionally skipped rows are listed in exceptions.json. Reconcile them with the company owner before relying on migrated books. Source totals and accepted totals are distinguished in reconciliation.json. Independently supplied balance checks: ${preview.reconciliation.balanceChecks.length}.\n\nFirst workflow\n1. Check this package's SHA-256 digest against the private handoff, preview all contents, and confirm initialization in FirmQuill.\n2. Create your individual owner account at the local terminal; no account password is included in this data package.\n3. Sign in to the books portal, verify the company name, open Reports, and compare the trial balance and open invoices/bills to source reports.\n4. Check unmatched bank lines under Banking. Imported statements do not post or reconcile themselves.\n5. Make an encrypted Full Suite recovery backup after validating the setup. Retain raw source exports separately in protected storage.\n\nHistory and privacy\nHistorical employee/payroll rows are a restricted archive. They do not create employee accounts, payroll runs, deductions, or year-to-date tax calculations. The package is private, unencrypted business data; keep it outside source control, shared downloads and public application archives. No data is sent to an AI service.\n\nHelp\nUse the shipped public setup guide and local documentation search for installation and setup. For unresolved migration balances, contact the person who prepared your migration, using your agreed private support channel. Supply the application version, package digest, and redacted error; do not attach raw exports, passwords, tokens or personnel records. FirmQuill does not include a verified public support address.\n`;}

export function createSetupPackage(dataset,approval){
  validateMigrationDataset(dataset);const preview=previewMigration(dataset),digest=migrationDigest(dataset);
  fail(approval?.digest===digest&&typeof approval.approvedBy==='string'&&approval.approvedBy.length>0&&typeof approval.approvedAt==='string'&&Number.isFinite(Date.parse(approval.approvedAt)),'Current staged records require explicit approval before packaging.',409);
  fail(preview.reconciliation.balanced,'Resolve reconciliation differences before packaging.');
  const contents=[encode(dataset),encode(provenance(dataset)),encode(preview.unresolved),encode(preview.reconciliation),guide(dataset,preview)];
  const pkg={format:'firmquill.setup',schema:1,applicationVersion:SETUP_PACKAGE_VERSION,packageId:randomUUID(),companyId:dataset.company.id,approval:{digest,approvedBy:approval.approvedBy,approvedAt:approval.approvedAt},files:names.map((name,i)=>({name,size:Buffer.byteLength(contents[i]),sha256:sha(contents[i]),content:contents[i]}))};
  const packageText=encode(pkg);fail(Buffer.byteLength(packageText)<=MAX_SETUP_BYTES,'Setup package exceeds 16 MiB.',413);
  return {packageText,filename:dataset.company.id+'.fqsetup.json',digest:sha(packageText),summary:{company:dataset.company,...publicReport(preview),applicationVersion:SETUP_PACKAGE_VERSION},privacy:'Private, unencrypted, data-only company package. Checksums detect corruption; they do not establish who created the package.'};
}
export function inspectSetupPackage(packageText){
  fail(typeof packageText==='string'&&Buffer.byteLength(packageText)<=MAX_SETUP_BYTES,'Setup package must be JSON text of at most 16 MiB.',413);let pkg;
  try{pkg=JSON.parse(packageText);}catch{fail(false,'Invalid setup package JSON.');}
  fail(keys(pkg,['format','schema','applicationVersion','packageId','companyId','approval','files'])&&pkg.format==='firmquill.setup'&&pkg.schema===1&&pkg.applicationVersion===SETUP_PACKAGE_VERSION,'Unsupported setup package schema or application version.');
  fail(typeof pkg.packageId==='string'&&/^[a-zA-Z0-9-]{1,120}$/.test(pkg.packageId)&&typeof pkg.companyId==='string','Invalid setup package identity.');
  fail(keys(pkg.approval,['digest','approvedBy','approvedAt'])&&/^[a-f0-9]{64}$/.test(pkg.approval.digest)&&typeof pkg.approval.approvedBy==='string'&&pkg.approval.approvedBy.length<=160&&pkg.approval.approvedBy.length>0&&typeof pkg.approval.approvedAt==='string'&&Number.isFinite(Date.parse(pkg.approval.approvedAt)),'Missing package approval metadata.');
  fail(Array.isArray(pkg.files)&&pkg.files.length===names.length,'Setup package requires exactly the declared data files.');const files=new Map();
  for(const file of pkg.files){fail(keys(file,['name','size','sha256','content'])&&names.includes(file.name)&&!files.has(file.name),'Invalid or repeated package filename.');fail(typeof file.content==='string'&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=8*1024*1024&&Buffer.byteLength(file.content)===file.size,'Invalid declared file size.');fail(typeof file.sha256==='string'&&/^[a-f0-9]{64}$/.test(file.sha256)&&sha(file.content)===file.sha256,'Setup package file integrity check failed.');files.set(file.name,file.content);}
  let dataset;try{dataset=JSON.parse(files.get('mapped.json'));}catch{fail(false,'Mapped records are invalid JSON.');}validateMigrationDataset(dataset);
  fail(dataset.company.id===pkg.companyId&&migrationDigest(dataset)===pkg.approval.digest,'Package company or approved record digest differs.');
  const preview=previewMigration(dataset);fail(preview.reconciliation.balanced,'Package reconciliation does not balance.');
  fail(files.get('provenance.json')===encode(provenance(dataset))&&files.get('exceptions.json')===encode(preview.unresolved)&&files.get('reconciliation.json')===encode(preview.reconciliation),'Package provenance, exceptions or reconciliation differ from the mapped records.');
  // Treat guide text only as inert text; the application never executes package content.
  fail(files.get('getting-started.txt')===guide(dataset,preview),'Customer guide differs from the package records/version.');
  return {digest:sha(packageText),packageId:pkg.packageId,applicationVersion:pkg.applicationVersion,company:dataset.company,files:pkg.files.map(({name,size,sha256})=>({name,size,sha256})),...publicReport(preview),gettingStarted:files.get('getting-started.txt'),dataset,approval:pkg.approval};
}
async function absent(path){try{await lstat(path);}catch(e){if(e.code==='ENOENT')return;throw e;}throw Object.assign(Error('Setup destination already exists. Existing workspaces are never replaced; choose a fresh database filename.'),{status:409});}
export async function initializeSetupPackage({packageText,destination,confirmedDigest}){
  const inspected=inspectSetupPackage(packageText);fail(confirmedDigest===inspected.digest,'Preview and explicitly confirm the exact package digest before initialization.',409);
  fail(typeof destination==='string'&&destination.length>0,'Choose a database destination.');destination=resolve(destination);
  for(const suffix of ['','-wal','-shm','-journal'])await absent(destination+suffix);await mkdir(dirname(destination),{recursive:true,mode:0o700});
  const stage=join(dirname(destination),'.firmquill-setup-'+randomUUID()+'.partial');const handle=await open(stage,'wx',0o600);await handle.close();let db;
  try{
    const preview=previewMigration(inspected.dataset);db=openStore(stage);initializeMigration(db);
    tx(db,()=>{saveBooks(db,preview.state);for(const row of preview.historical)db.prepare('INSERT INTO migration_historical VALUES(?,?,?,?)').run(inspected.company.id,row.kind,row.sourceKey,encode(row.record));
      db.prepare('INSERT INTO migration_setup_receipts VALUES(?,?,?,?)').run(inspected.digest,inspected.company.id,new Date().toISOString(),encode(publicReport(preview)));
      audit(db,{id:'setup'},inspected.company.id,'setup package initialized',inspected.digest);
      fail(encode(readBooks(db).state)===encode(preview.state),'Temporary database reconciliation failed.');
      fail(db.prepare('PRAGMA integrity_check(1)').get().integrity_check==='ok'&&!db.prepare('PRAGMA foreign_key_check').get(),'Temporary database integrity failed.');
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();db=null;
    const verify=new DatabaseSync(stage,{readOnly:true});try{fail(verify.prepare('PRAGMA integrity_check(1)').get().integrity_check==='ok','Staged database verification failed.');}finally{verify.close();}
    const file=await open(stage,'r+');try{await file.sync();}finally{await file.close();}
    for(const suffix of ['','-wal','-shm','-journal'])await absent(destination+suffix);
    // Same-filesystem hard link is atomic and refuses overwrite if another creator wins.
    await link(stage,destination);
    return {destination,digest:inspected.digest,company:inspected.company,...publicReport(preview),ownerSetupRequired:true};
  }finally{db?.close();for(const suffix of ['','-wal','-shm','-journal'])await unlink(stage+suffix).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
