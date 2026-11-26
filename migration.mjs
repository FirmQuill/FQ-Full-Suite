import {createHash,randomUUID} from 'node:crypto';
import {newVault,apply,accounts,manualAccounts,date,integer,cents,statements,sum,validateState} from './shared/core.mjs';
import {previewBankCsv} from './shared/interop.mjs';
import {owner,tx,audit,requireThat} from './store.mjs';

export const MIGRATION_SCHEMA=1;
export const migrationFields={
  accounts:['sourceId','name','targetAccount'],
  contacts:['sourceId','name','kind'],
  invoices:['sourceId','contactRef','date','amountCents','description'],
  bills:['sourceId','contactRef','date','amountCents','description'],
  payments:['sourceId','documentRef','documentType','date','amountCents','description'],
  openingBalances:['sourceId','date','account','offsetAccount','amountCents','description'],
  historicalEmployees:['sourceId','name','state'],
  historicalPayroll:['sourceId','employeeRef','date','grossCents','taxCents','netCents'],
  bank:['sourceId','date','description','amountCents']
};
export const migrationCoverage={schema:1,nativeAdapters:[],bankProfiles:['quickbooks','wave'],
  supported:'Explicitly mapped generic CSV and fictional fixtures. Product exports must be mapped and reviewed; no native export schema is inferred.',
  limits:['USD only; fixed FirmQuill chart: source accounts map to existing codes.',
    'Invoices and bills: one service amount, no sales tax, inventory, discounts, foreign currency or attachments.',
    'Opening balances: supported manual accounts only; migrate receivable/payable control balances as open documents, inventory through its workflow.',
    'Historical employee and payroll rows are restricted archives only, never live employees, payroll runs or year-to-date tax inputs.',
    'Bank profiles are existing verified interchange templates, not vendor-native accounting exports.']};
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const migrationDigest=hash;
const fail=(ok,msg,status=400)=>requireThat(ok,status,msg);
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
function text(v,label,max=160){fail(typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v),'Invalid '+label+'.');return v.trim();}
function identity(v,label='source ID'){v=text(v,label,120);fail(/^[A-Za-z0-9_.@-]+$/.test(v),'Use letters, digits, dot, underscore, @ or hyphen for '+label+'.');return v;}
function exactKeys(o,keys,label){fail(plain(o)&&Object.keys(o).every(k=>keys.includes(k)),'Unsupported '+label+' fields.');}
function amount(v){if(typeof v==='string'){fail(/^-?\d+$/.test(v),'Amounts must be signed integer cents.');v=Number(v);}integer(v);return v;}
function positiveAmount(v){v=amount(v);fail(v>0,'Enter a positive integer cents amount.');return v;}
function mappingColumn(value){if(typeof value==='string')return text(value,'column header');exactKeys(value,['column','transform'],'column mapping');fail(['text','integerCents','decimalDollars','isoDate','MM/DD/YYYY','DD/MM/YYYY'].includes(value.transform),'Unsupported mapping transform.');return text(value.column,'column header');}
function mappedValue(value,mapping){if(typeof mapping==='string'||mapping.transform==='text')return value;const v=value.trim();if(mapping.transform==='decimalDollars')return cents(v);if(mapping.transform==='integerCents')return amount(v);if(mapping.transform==='isoDate')return date(v);const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);fail(m,'Date does not match the explicitly selected mapping format.');return date(m[3]+'-'+(mapping.transform==='MM/DD/YYYY'?m[1]:m[2])+'-'+(mapping.transform==='MM/DD/YYYY'?m[2]:m[1]));}
export function initializeMigration(db){db.exec(`CREATE TABLE IF NOT EXISTS migration_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL,approved_digest TEXT NOT NULL DEFAULT '',approved_by TEXT NOT NULL DEFAULT '',approved_at TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS migration_profiles(name TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_setup_receipts(digest TEXT PRIMARY KEY,company TEXT NOT NULL,installed_at TEXT NOT NULL,summary TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_historical(company TEXT NOT NULL,kind TEXT NOT NULL,source_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(company,kind,source_key));`);}
function sourceInfo(source){exactKeys(source,['id','product','edition','exportedAt','fixtureOnly'],'source');fail(typeof source.fixtureOnly==='boolean','Declare whether this source is fictional fixture data.');return {id:identity(source.id),product:text(source.product,'source product'),edition:text(source.edition||'Unspecified — verify before production','edition'),exportedAt:date(source.exportedAt),fixtureOnly:source.fixtureOnly};}
function normalize(type,input){
  exactKeys(input,migrationFields[type],'mapped row');const r={};
  for(const k of migrationFields[type])if(input[k]!==undefined&&input[k]!=='')r[k]=input[k];
  r.sourceId=identity(r.sourceId);
  if(['invoices','bills','payments','openingBalances','historicalPayroll','bank'].includes(type))r.date=date(r.date);
  if(['contacts','accounts','historicalEmployees'].includes(type))r.name=text(r.name,'name');
  if(type==='contacts')fail(['Customer','Vendor'].includes(r.kind),'Contact kind must be Customer or Vendor.');
  if(type==='accounts'){r.targetAccount=text(r.targetAccount,'target account',4);fail(Object.hasOwn(accounts,r.targetAccount),'Map this source account to an existing FirmQuill account.');}
  if(['invoices','bills','payments'].includes(type))r.amountCents=positiveAmount(r.amountCents);
  if(['invoices','bills'].includes(type))r.contactRef=text(r.contactRef,'contact reference',245);
  if(type==='payments'){r.documentRef=text(r.documentRef,'document reference',245);fail(['invoices','bills'].includes(r.documentType),'Payment documentType must be invoices or bills.');}
  if(type==='openingBalances'){r.account=text(r.account,'account',4);r.offsetAccount=text(r.offsetAccount||'3000','offset account',4);fail(manualAccounts.includes(r.account)&&manualAccounts.includes(r.offsetAccount)&&r.account!==r.offsetAccount,'Opening balance requires two distinct supported manual accounts; control accounts require their linked workflows.');r.amountCents=amount(r.amountCents);fail(r.amountCents!==0,'Opening balance must be nonzero.');}
  if(['invoices','bills','payments','openingBalances','bank'].includes(type))r.description=text(r.description||'Migrated '+type,'description');
  if(type==='bank'){r.amountCents=amount(r.amountCents);fail(r.amountCents!==0,'Bank amount must be nonzero.');}
  if(type==='historicalEmployees'){r.state=text(r.state,'state',2);fail(/^[A-Z]{2}$/.test(r.state),'Historical work state must be two uppercase letters.');}
  if(type==='historicalPayroll'){r.employeeRef=text(r.employeeRef,'historical employee reference',245);for(const k of ['grossCents','taxCents','netCents']){r[k]=amount(r[k]);fail(r[k]>=0,'Historical payroll amounts must be nonnegative.');}fail(r.taxCents<=r.grossCents&&r.netCents<=r.grossCents,'Historical tax and net amounts cannot exceed gross.');}
  return r;
}

// Bounded RFC 4180-style CSV; multiline quoted fields are supported, never evaluated.
export function parseMigrationCsv(csv){
  fail(typeof csv==='string'&&Buffer.byteLength(csv)<=2*1024*1024,'CSV must be text of at most 2 MiB.',413);
  csv=csv.replace(/^\uFEFF/,'');const rows=[];let row=[],value='',quoted=false,closed=false,line=1,start=1;
  const field=()=>{row.push(value);value='';closed=false;};const record=()=>{field();if(row.some(v=>v!==''))rows.push({line:start,values:row});row=[];start=line+1;};
  for(let i=0;i<csv.length;i++){const c=csv[i];if(quoted){if(c==='"'){if(csv[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else{value+=c;if(c==='\n')line++;}}
    else if(c==='"'&&!value&&!closed)quoted=true;else if(c===',')field();else if(c==='\n'){record();line++;}else if(c==='\r'&&csv[i+1]==='\n'){}else{fail(c!=='"'&&!closed,'Invalid CSV quoting at line '+line+'.');value+=c;}}
  fail(!quoted,'Unclosed CSV quote.');if(value||row.length||closed)record();
  const header=rows.shift()?.values||[];fail(header.length&&header.length<=40&&header.every(h=>h.length>0&&h.length<=160)&&new Set(header).size===header.length,'CSV headers must be nonempty and unique.');fail(rows.length>0&&rows.length<=10000,'Use 1–10,000 data rows.');return {header,rows};
}
function mapCsv(csv,type,mapping){
  fail(Object.hasOwn(migrationFields,type),'Choose a supported mapped record type.');exactKeys(mapping,migrationFields[type],'mapping');
  const {header,rows}=parseMigrationCsv(csv);fail(Object.values(mapping).every(h=>header.includes(mappingColumn(h))),'A mapped column is missing from the CSV.');
  fail(mapping.sourceId,'Map a stable sourceId column; row numbers and customer names are not stable IDs.');
  return rows.map(row=>{try{fail(row.values.length===header.length,'Column count differs from the header.');const input=Object.fromEntries(Object.entries(mapping).map(([k,h])=>[k,mappedValue(row.values[header.indexOf(mappingColumn(h))],h)]));return {line:row.line,record:normalize(type,input)};}catch(e){return {line:row.line,error:e.message};}});
}
function key(batch,row){return batch.source.id+'/'+batch.recordType+'/'+row.sourceId;}
function refKey(batch,type,reference){const parts=reference.split('/');fail(parts.length===1||parts.length===2,'References use sourceId or source/sourceId.');return (parts.length===1?batch.source.id:parts[0])+'/'+type+'/'+parts.at(-1);}
function stableId(seed){return 'migration-'+hash(seed).slice(0,32);}
function applyStable(state,companyId,action,seed){
  const before=new Set(state.companies[0].history.map(e=>e.id));const oldIds=new Set();for(const rows of Object.values(state.companies[0]))if(Array.isArray(rows))for(const row of rows)if(row?.id)oldIds.add(row.id);
  let next=apply(state,companyId,{...action,requestId:stableId(seed)});const replacements=new Map();let index=0;
  for(const rows of Object.values(next.companies[0]))if(Array.isArray(rows))for(const row of rows)if(row?.id&&!oldIds.has(row.id)&&!replacements.has(row.id))replacements.set(row.id,stableId(seed+'/'+index++));
  const replace=v=>typeof v==='string'?(replacements.get(v)||v):Array.isArray(v)?v.map(replace):plain(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
  next=replace(next);return {state:next,event:next.companies[0].history.find(e=>!before.has(e.id))};
}
export function validateMigrationDataset(dataset){
  exactKeys(dataset,['schema','company','batches','exclusions','expectedBalances'],'migration dataset');fail(dataset.schema===1,'Unsupported migration schema.');exactKeys(dataset.company,['id','name'],'company');identity(dataset.company.id,'company ID');text(dataset.company.name,'company name');
  fail(Array.isArray(dataset.batches)&&dataset.batches.length<=100&&Array.isArray(dataset.exclusions)&&dataset.exclusions.length<=10000,'Invalid migration collections.');
  const ids=new Set(),sources=new Map();let count=0;
  for(const b of dataset.batches){exactKeys(b,['id','source','recordType','mapping','profileName','csvSha256','rows'],'batch');identity(b.id,'batch ID');fail(!ids.has(b.id),'Duplicate batch ID.');ids.add(b.id);sourceInfo(b.source);const sourceIdentity=JSON.stringify([b.source.product,b.source.edition,b.source.fixtureOnly]),prior=sources.get(b.source.id);fail(!prior||prior===sourceIdentity,'One source ID cannot identify different source products or editions.');sources.set(b.source.id,sourceIdentity);fail(Object.hasOwn(migrationFields,b.recordType),'Unsupported record type.');exactKeys(b.mapping,migrationFields[b.recordType],'mapping');for(const value of Object.values(b.mapping))mappingColumn(value);fail(typeof b.profileName==='string'&&b.profileName.length<=160&&/^[a-f0-9]{64}$/.test(b.csvSha256),'Invalid source digest/profile.');fail(Array.isArray(b.rows)&&b.rows.length<=10000,'Invalid batch rows.');
    const rowLines=new Set();for(const row of b.rows){exactKeys(row,['line','record','error'],'row');fail(Number.isSafeInteger(row.line)&&row.line>=2&&!rowLines.has(row.line),'Invalid or repeated source line.');rowLines.add(row.line);fail((plain(row.record)&&row.error===undefined)||(typeof row.error==='string'&&!row.record&&row.error.length<=500),'Invalid staged row.');if(row.record){const normalized=normalize(b.recordType,row.record);fail(Object.keys(normalized).length===Object.keys(row.record).length&&Object.entries(normalized).every(([field,value])=>row.record[field]===value),'Mapped record is not in canonical normalized form.');}count++;}}
  fail(count<=20000,'A company package supports at most 20,000 staged rows.',413);
  fail(dataset.exclusions.every(x=>typeof x==='string'&&dataset.batches.some(b=>b.rows.some(r=>b.id+':'+r.line===x))),'Invalid excluded row reference.');
  fail(plain(dataset.expectedBalances)&&Object.entries(dataset.expectedBalances).every(([k,v])=>Object.hasOwn(accounts,k)&&Number.isSafeInteger(v)),'Expected balances must use FirmQuill account codes and integer cents.');return dataset;
}
export function previewMigration(dataset){
  validateMigrationDataset(dataset);const cid=dataset.company.id;let state=newVault(dataset.company.name);state.companies[0].id=cid;
  const links=new Map(),seen=new Map(),candidates=new Map(),unresolved=[],historical=[],outcomes=[],totals={invoices:0,bills:0,payments:0,bank:0},appliedTotals={...totals};
  const order=Object.keys(migrationFields);let items=dataset.batches.flatMap(b=>b.rows.map(row=>({b,row}))).sort((a,z)=>order.indexOf(a.b.recordType)-order.indexOf(z.b.recordType)||(a.row.record?.date||'').localeCompare(z.row.record?.date||''));
  const recordOutcome=(b,row,status,detail='')=>{outcomes.push({batchId:b.id,sourceId:b.source.id,recordType:b.recordType,line:row.line,sourceIdValue:row.record?.sourceId||'',status});if(detail)unresolved.push({batchId:b.id,line:row.line,sourceId:b.source.id,recordType:b.recordType,status,detail});};
  for(const {b,row} of items){const type=b.recordType,r=row.record;
    if(r&&type in totals)totals[type]=sum([totals[type],r.amountCents]);
    if(dataset.exclusions.includes(b.id+':'+row.line)){recordOutcome(b,row,'excluded','Explicitly excluded during migration review.');continue;}
    if(row.error){recordOutcome(b,row,'error',row.error);continue;}
    const k=key(b,r),fingerprint=hash(r);
    if(seen.has(k)){recordOutcome(b,row,seen.get(k)===fingerprint?'duplicate':'conflict',seen.get(k)===fingerprint?'Repeated stable source ID with identical mapped data; skipped.':'Stable source ID has different mapped values; resolve source IDs or mapping.');continue;}
    seen.set(k,fingerprint);
    const beforeRow=state;const historicalLength=historical.length;
    try{
      let businessKey=Object.fromEntries(Object.entries(r).filter(([field])=>field!=='sourceId'));
      if(type==='contacts')businessKey=[r.name.toLowerCase(),r.kind];
      if(type==='accounts')businessKey=[r.name.toLowerCase(),r.targetAccount];
      if(['invoices','bills'].includes(type))businessKey=[links.get(refKey(b,'contacts',r.contactRef))||r.contactRef,r.date,r.amountCents,r.description];
      if(type==='payments')businessKey=[links.get(refKey(b,r.documentType,r.documentRef))||r.documentRef,r.date,r.amountCents,r.description];
      const signature=hash([type,businessKey]);
      if(candidates.has(signature)&&candidates.get(signature).source!==b.source.id){const prior=candidates.get(signature);if(links.has(prior.key))links.set(k,links.get(prior.key));recordOutcome(b,row,'duplicate-candidate','Matching mapped content from another source; skipped for review. To import a distinct record, give it distinct business content or exclude and correct the source.');continue;}
      const run=(a,part='')=>{const result=applyStable(state,cid,a,k+'/'+part);state=result.state;return result.event.id;};
      if(type==='accounts')links.set(k,r.targetAccount);
      else if(type==='contacts')links.set(k,run({type:'contact',kind:r.kind,name:r.name,date:'2000-01-01'}));
      else if(type==='invoices'||type==='bills'){
        const party=links.get(refKey(b,'contacts',r.contactRef));fail(party,'Contact reference is unresolved.');const expectedKind=type==='invoices'?'Customer':'Vendor';fail(state.companies[0].parties.find(p=>p.id===party)?.kind===expectedKind,'Contact kind does not match document.');
        const item=run({type:'item',kind:'Service',name:'Migrated service — '+r.sourceId,date:r.date},'item');let parent=run({type:type==='invoices'?'quote':'purchase order',party,item,qty:1,unit:r.amountCents,date:r.date,label:r.description},'origin');
        for(const step of type==='invoices'?['sales order','fulfillment','invoice']:['receiving','bill'])parent=run({type:step,parent,date:r.date,label:r.description},step);links.set(k,parent);
      }else if(type==='payments'){
        const parent=links.get(refKey(b,r.documentType,r.documentRef));fail(parent,'Document reference is unresolved.');links.set(k,run({type:r.documentType==='invoices'?'collection':'payment',parent,amount:r.amountCents,date:r.date,label:r.description}));
      }else if(type==='openingBalances')links.set(k,run({type:'journal',date:r.date,label:r.description,lines:[[r.account,r.amountCents],[r.offsetAccount,-r.amountCents]],flow:'Financing'}));
      else if(type==='bank')links.set(k,run({type:'statement import',date:r.date,label:r.description,rows:[{date:r.date,description:r.description,amountCents:r.amountCents,sourceRef:k}]}));
      else if(type==='historicalEmployees'){links.set(k,k);historical.push({kind:type,sourceKey:k,record:r});}
      else if(type==='historicalPayroll'){fail(links.has(refKey(b,'historicalEmployees',r.employeeRef)),'Historical employee reference is unresolved.');historical.push({kind:type,sourceKey:k,record:r});}
      candidates.set(signature,{source:b.source.id,key:k});if(type in appliedTotals)appliedTotals[type]=sum([appliedTotals[type],r.amountCents]);recordOutcome(b,row,'accepted');
    }catch(e){state=beforeRow;historical.length=historicalLength;links.delete(k);recordOutcome(b,row,'error',e.message);}
  }
  validateState(state);const report=statements(state.companies[0].entries),counts={input:outcomes.length,accepted:0,duplicate:0,'duplicate-candidate':0,conflict:0,error:0,excluded:0};for(const o of outcomes)counts[o.status]++;
  const differences=Object.entries(dataset.expectedBalances).map(([account,expectedCents])=>({account,expectedCents,actualCents:report.balances[account],differenceCents:sum([report.balances[account],-expectedCents])}));
  const batches=dataset.batches.map(b=>({batchId:b.id,sourceId:b.source.id,recordType:b.recordType,input:b.rows.length,accepted:outcomes.filter(o=>o.batchId===b.id&&o.status==='accepted').length,unresolved:outcomes.filter(o=>o.batchId===b.id&&o.status!=='accepted').length}));
  return {digest:hash(dataset),company:dataset.company,counts,batches,outcomes,unresolved,reconciliation:{countsBalanced:sum(Object.entries(counts).filter(([k])=>k!=='input').map(([,v])=>v))===counts.input,sourceTotalsCents:totals,acceptedTotalsCents:appliedTotals,balances:report.balances,trialDifferenceCents:report.trialDifference,balanceChecks:differences,independentlyVerified: differences.length>0,balanced:differences.every(d=>d.differenceCents===0)&&report.trialDifference===0,note:'Source totals include duplicates and excluded rows. Accepted totals show imported scope; unresolved items explain the difference. Expected balances must be independently supplied; an empty comparison is not independent reconciliation.'},state,historical};
}
function getRun(db,id){identity(id,'run ID');const row=db.prepare('SELECT * FROM migration_runs WHERE id=?').get(id);fail(row,'Migration run unavailable.',404);return {...row,dataset:JSON.parse(row.body)};}
function publicPreview(result){const {state,historical,...view}=result;return {...view,historicalCount:historical.length,liveRecordCounts:{contacts:state.companies[0].parties.length,documents:state.companies[0].docs.length,journals:state.companies[0].entries.length,bank:state.companies[0].bank.length}};}
export function migrationView(db,user){owner(user);initializeMigration(db);return {schema:1,coverage:migrationCoverage,fields:migrationFields,profiles:db.prepare('SELECT body FROM migration_profiles ORDER BY name').all().map(r=>JSON.parse(r.body)),runs:db.prepare('SELECT id,body,approved_digest,approved_at FROM migration_runs').all().map(r=>({id:r.id,company:JSON.parse(r.body).company,approvedDigest:r.approved_digest,approvedAt:r.approved_at,batches:JSON.parse(r.body).batches.length})),historicalArchive:db.prepare('SELECT company,kind,count(*) AS records FROM migration_historical GROUP BY company,kind').all()};}
export function migrationCommand(db,user,p){owner(user);initializeMigration(db);fail(plain(p)&&typeof p.type==='string','Specify a migration command.');
  if(p.type==='historical-archive'){identity(p.companyId,'company ID');return {companyId:p.companyId,notice:'Restricted read-only migration history; excluded from payroll calculations.',records:db.prepare('SELECT kind,source_key,body FROM migration_historical WHERE company=? ORDER BY kind,source_key').all(p.companyId).map(r=>({kind:r.kind,sourceKey:r.source_key,record:JSON.parse(r.body)}))};}
  if(p.type==='create'){const id=randomUUID(),dataset={schema:1,company:{id:randomUUID(),name:text(p.companyName,'company name')},batches:[],exclusions:[],expectedBalances:{}};tx(db,()=>{db.prepare('INSERT INTO migration_runs(id,body) VALUES(?,?)').run(id,JSON.stringify(dataset));audit(db,user,dataset.company.id,'migration created',id);});return {runId:id,company:dataset.company};}
  if(p.type==='profile'){const name=text(p.name,'profile name');fail(Object.hasOwn(migrationFields,p.recordType),'Invalid profile record type.');exactKeys(p.mapping,migrationFields[p.recordType],'mapping');for(const value of Object.values(p.mapping))mappingColumn(value);const profile={schema:1,name,recordType:p.recordType,mapping:p.mapping};tx(db,()=>{db.prepare('INSERT INTO migration_profiles VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name,JSON.stringify(profile));audit(db,user,'','migration profile saved',name);});return {profile};}
  const run=getRun(db,p.runId),dataset=run.dataset;
  if(p.type==='preview')return {runId:p.runId,...publicPreview(previewMigration(dataset))};
  if(p.type==='package'){fail(run.approved_digest&&p.approvedDigest===run.approved_digest&&hash(dataset)===run.approved_digest,'Review and approve the current staged records first.',409);return {dataset,approval:{digest:run.approved_digest,approvedBy:run.approved_by,approvedAt:run.approved_at},preview:publicPreview(previewMigration(dataset)),packageRequested:true};}
  if(p.type==='approve'){const preview=previewMigration(dataset);fail(p.previewDigest===preview.digest,'Staging changed; preview it again.',409);fail(p.acceptExceptions===true,'Explicitly accept the unresolved report and migrated scope.');fail(preview.reconciliation.balanced,'Expected balances differ; resolve reconciliation before approval.');tx(db,()=>{db.prepare('UPDATE migration_runs SET approved_digest=?,approved_by=?,approved_at=? WHERE id=?').run(preview.digest,user.id,new Date().toISOString(),p.runId);audit(db,user,dataset.company.id,'migration approved',p.runId+' '+preview.digest);});return {runId:p.runId,approvedDigest:preview.digest,...publicPreview(preview)};}
  if(p.type==='stage'){
    const source=sourceInfo(p.source);let recordType=p.recordType,mapping=p.mapping,profileName=p.profileName||'';
    if(profileName){const profile=db.prepare('SELECT body FROM migration_profiles WHERE name=?').get(profileName);fail(profile,'Mapping profile unavailable.');const saved=JSON.parse(profile.body);fail(saved.recordType===recordType,'Profile record type differs.');mapping=saved.mapping;}
    let rows;if(p.bankProfile){fail(recordType==='bank'&&['wave','quickbooks'].includes(p.bankProfile),'Choose a verified bank profile.');const bank=previewBankCsv(p.csv,p.bankProfile);rows=bank.rows.map((r,i)=>({line:i+2,record:{sourceId:hash(r.sourceRef).slice(0,32),date:r.date,description:r.description,amountCents:r.amountCents}}));mapping={sourceId:'derived verified bank reference',date:'Date',description:'Description',amountCents:'Amount'};profileName='verified-bank-'+p.bankProfile;}else rows=mapCsv(p.csv,recordType,mapping);
    dataset.batches.push({id:randomUUID(),source,recordType,mapping,profileName,csvSha256:hash(p.csv),rows});
  }else if(p.type==='exclude'){fail(Array.isArray(p.items),'Specify row exclusions.');dataset.exclusions=[...new Set([...dataset.exclusions,...p.items.map(x=>x.batchId+':'+x.line)])];}
  else if(p.type==='expectations')dataset.expectedBalances=p.balances;
  else fail(false,'Unknown migration command.');
  validateMigrationDataset(dataset);const preview=previewMigration(dataset);tx(db,()=>{db.prepare("UPDATE migration_runs SET body=?,approved_digest='',approved_by='',approved_at='' WHERE id=?").run(JSON.stringify(dataset),p.runId);audit(db,user,dataset.company.id,'migration staged',p.runId+' '+p.type);});return {runId:p.runId,...publicPreview(preview)};
}
