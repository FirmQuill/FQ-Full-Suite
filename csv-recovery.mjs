import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail=(ok,message,status=409)=>{if(!ok)throw Object.assign(Error(message),{status});};
const snapshot=r=>({id:r.id,source:r.source,sourceRef:r.sourceRef,statementKey:r.statementKey,date:r.date,description:r.description,amountCents:r.amountCents});
const maxRows=25000;

export function initializeCsvRecovery(db){
  db.exec(`CREATE TABLE IF NOT EXISTS csv_import_receipts (
    company_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL,
    imported_by TEXT NOT NULL, row_snapshot TEXT NOT NULL,
    undo_token TEXT, undo_receipt TEXT, PRIMARY KEY(company_id,event_id)
  ); CREATE INDEX IF NOT EXISTS csv_import_receipts_order ON csv_import_receipts(company_id,created_at DESC);`);
}
export function recordCsvReceipt(db,before,after,companyId,action,actor){
  if(action.type!=='statement import'||action.csvRecovery!==true)return;
  const old=before.companies.find(c=>c.id===companyId),company=after.companies.find(c=>c.id===companyId),event=company?.history.at(-1),key=action.rows[0]?.statementKey;
  const fromPreview=row=>{
    if(typeof row.sourceRef!=='string'||row.statementKey!==key)return false;
    if(row.sourceRef.startsWith('bank-reviewed/v1/'+key+'/'))return /^(0|[1-9]\d*)$/.test(row.sourceRef.slice(('bank-reviewed/v1/'+key+'/').length));
    const m=/^bank-v1\/[1-9]\d*\/(.+)$/.exec(row.sourceRef);
    return !!m&&m[1]===JSON.stringify([row.date,row.description,row.amountCents]);
  };
  fail(old&&event?.kind==='statement import'&&event.requestId===action.requestId&&identity.test(key||'')&&action.rows.length<=maxRows&&action.rows.every(fromPreview),'This statement does not have a verifiable CSV review receipt.',400);
  const created=company.bank.filter(r=>r.source===event.id);
  fail(created.length===action.rows.length&&company.bank.length-old.bank.length===created.length&&!company.entries.some(e=>e.source===event.id),'Could not verify the rows created by this statement.');
  db.prepare('INSERT INTO csv_import_receipts(company_id,event_id,created_at,imported_by,row_snapshot) VALUES(?,?,?,?,?)')
    .run(companyId,event.id,new Date().toISOString(),actor.id,JSON.stringify(created.map(snapshot)));
}
const allowed=id=>typeof id==='string'&&uuid.test(id);
function receipt(db,company,batch){
  fail(allowed(batch),'Select a tracked CSV import.',400);
  const row=db.prepare('SELECT * FROM csv_import_receipts WHERE company_id=? AND event_id=?').get(company.id,batch);
  fail(row,'Tracked CSV import not found for this company.',404);return row;
}
export function csvReceiptList(db,company){
  const rows=db.prepare('SELECT event_id,created_at,undo_receipt,json_array_length(row_snapshot) AS row_count FROM csv_import_receipts WHERE company_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(company.id);
  return {batches:rows.map(r=>({id:r.event_id,createdAt:r.created_at,rowCount:r.row_count,removed:r.undo_receipt?JSON.parse(r.undo_receipt).removed:null}))};
}
function relations(db,company,batch){
  const closed=company.closedThrough||'';
  const posted=company.entries.some(e=>e.source===batch);
  const reconciled=new Set(company.reconciliations.flatMap(r=>r.rows));
  const clearedDate=company.reconciliations.at(-1)?.date||'';
  const hasCloseTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='month_end_close'").get();
  const closeCutoff=hasCloseTable?(db.prepare('SELECT max(cutoff) AS cutoff FROM month_end_close WHERE company=?').get(company.id).cutoff||''):'';
  const pending=db.prepare("SELECT action FROM approvals WHERE companyId=? AND status='pending' AND kind IN ('match','reconcile')").all(company.id).map(r=>JSON.parse(r.action));
  const matchPending=new Set(pending.filter(a=>a.type==='match').map(a=>a.row));
  const reconcilePending=pending.filter(a=>a.type==='reconcile').map(a=>a.date).sort().at(-1)||'';
  return ({actual,expected})=>{
    if(!actual)return 'No longer in the statement';
    if(posted)return 'Import has an associated posted journal';
    if(digest(snapshot(actual))!==digest(expected))return 'The current row differs from the import receipt';
    if(reconciled.has(actual.id)||actual.date<=clearedDate)return 'Protected by a saved reconciliation';
    if(actual.match)return 'Matched to a cash entry';
    if(matchPending.has(actual.id)||actual.date<=reconcilePending)return 'Referenced by a pending match or reconciliation';
    if(actual.date<=closed)return 'Inside a closed accounting period';
    if(actual.date<=closeCutoff)return 'Protected by a saved month-end close packet';
    return null;
  };
}
function plan(db,company,row){
  const original=JSON.parse(row.row_snapshot);
  const byId=new Map(company.bank.map(r=>[r.id,r]));
  const reason=relations(db,company,row.event_id);
  const prior=row.undo_receipt?JSON.parse(row.undo_receipt):null;
  const assigned=new Set(prior?.rowIds||[]);
  const rows=original.map(expected=>({id:expected.id,date:expected.date,description:expected.description,amountCents:expected.amountCents,
    status:assigned.has(expected.id)?'Removed by this reviewed undo':(reason({actual:byId.get(expected.id),expected})??(prior?'Undo already used; row retained':null))}));
  const eligible=rows.filter(r=>!r.status);
  return {id:row.event_id,createdAt:row.created_at,rows,eligible:eligible.length,removed:prior?.removed??null,
    reviewToken:prior?null:digest(['firmquill.csv-recovery.v1',company.id,row.event_id,rows])};
}
export function previewCsvUndo(db,company,batch){return plan(db,company,receipt(db,company,batch));}
export function executeCsvUndo(db,company,{batch,reviewToken,confirm},actor){
  fail(confirm===true&&typeof reviewToken==='string'&&identity.test(reviewToken),'Review this batch and explicitly confirm removal.',400);
  const row=receipt(db,company,batch);
  if(row.undo_receipt){
    fail(row.undo_token===reviewToken,'This import already used its reviewed undo.');
    return {repeated:true,removed:JSON.parse(row.undo_receipt).removed};
  }
  const p=plan(db,company,row);
  fail(p.reviewToken===reviewToken,'The batch changed after your preview. Reopen the review and check the protected rows.');
  fail(p.eligible>0,'This batch has no eligible rows to remove.');
  const rowIds=p.rows.filter(r=>!r.status).map(r=>r.id),removed=new Set(rowIds);
  // The caller persists only this narrowed bank collection and audit record in the same transaction.
  const result={removed:rowIds.length,rowIds,at:new Date().toISOString(),actor:actor.id};
  db.prepare('UPDATE csv_import_receipts SET undo_token=?,undo_receipt=? WHERE company_id=? AND event_id=?').run(reviewToken,JSON.stringify(result),company.id,batch);
  return {bank:company.bank.filter(r=>!removed.has(r.id)),removed:result.removed,repeated:false};
}
