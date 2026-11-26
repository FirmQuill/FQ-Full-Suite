// Data-only import of owner-operated Lite tracking. Posted stock entries already
// belong to the portable books and must never be replayed by this migration.
import {randomUUID} from 'node:crypto';
import {importOwnerWarehouseMetadata} from './warehouse-planning.mjs';
import {initializeAssets} from './assets-workspace.mjs';

const contents=rows=>(rows||[]).filter(r=>r.qty>0).map(r=>({itemId:r.item,quantity:r.qty})).sort((a,b)=>a.itemId.localeCompare(b.itemId));
const stock=rows=>(rows||[]).map(r=>({itemId:r.item,qty:r.qty,value:r.value})).sort((a,b)=>a.itemId.localeCompare(b.itemId));
const statuses={Available:'active','In transit':'in-transit',Hold:'quarantine',Retired:'retired'};
const when=value=>(value||'1970-01-01').slice(0,10)+'T00:00:00.000Z';
const fail=message=>{throw Object.assign(Error(message),{status:409});};
export function migrateOwnerAssets(db,company,receiptKey){
  const desk=company.desk;if(!desk)return {units:0,counts:0,movements:0};initializeAssets(db);
  const owner=db.prepare("SELECT id FROM accounts WHERE role='owner' ORDER BY rowid LIMIT 1").get()?.id||'owner';
  const save='import_asset_'+randomUUID().replaceAll('-','');db.exec('SAVEPOINT '+save);
  let importedUnits=0,importedCounts=0,importedMovements=0;
  try{
    for(const source of desk.units||[]){
      const existing=db.prepare('SELECT body FROM tracked_units WHERE company=? AND id=?').get(company.id,source.id);
      if(existing){if(JSON.parse(existing.body).sourceEdition!=='Lite')fail('A Lite asset ID collides with an existing Full Suite asset. Preserve both workspaces and resolve the ID before importing.');continue;}
      if(db.prepare('SELECT 1 FROM tracked_units WHERE company=? AND identifier=? COLLATE NOCASE').get(company.id,source.unitId))fail('A Lite tracking identifier already exists in Full Suite. Resolve the duplicate without replacing its history.');
      const history=source.history||[],row={id:source.id,identifier:source.unitId,name:source.name,kind:source.kind.toLowerCase(),location:source.location,locationEpoch:source.locationEpoch||0,status:statuses[source.status],contents:contents(source.contents),fixedAssetId:source.fixedAsset||'',created:when(history[0]?.date),lastDate:history.at(-1)?.date||'1970-01-01',sourceEdition:'Lite',importReceipt:receiptKey,sourceOwnerRecord:structuredClone(source)};
      db.prepare('INSERT INTO tracked_units VALUES(?,?,?,?,?)').run(company.id,source.id,source.unitId,JSON.stringify(row),source.version);importedUnits++;
      for(const h of history){
        const movement={id:h.id,unitId:source.id,identifier:source.unitId,kind:'imported-lite-'+h.kind,date:h.date,at:when(h.date),actor:owner,from:'',to:'',before:h.before?contents(h.before):[],after:h.after?contents(h.after):[],beforeKnown:!!h.before,afterKnown:!!h.after,note:h.detail,stockSources:[],sourceEdition:'Lite',sourceHistory:structuredClone(h)};
        if(db.prepare('SELECT 1 FROM asset_movements WHERE id=?').get(movement.id))fail('A Lite asset history ID collides with an existing movement.');
        db.prepare('INSERT INTO asset_movements VALUES(?,?,?,?)').run(company.id,movement.id,source.id,JSON.stringify(movement));importedMovements++;
      }
    }
    for(const source of desk.counts||[]){
      const existing=db.prepare('SELECT body FROM asset_count_sessions WHERE company=? AND id=?').get(company.id,source.id);if(existing){if(JSON.parse(existing.body).sourceEdition!=='Lite')fail('A Lite count ID collides with a Full Suite count session.');continue;}
      const sourceUnit=desk.units.find(u=>u.id===source.unit),observed=source.observed===null?null:contents(source.observed),expected={unitId:source.unit,identifier:source.unitId,version:source.version,location:source.location,status:statuses[sourceUnit.status],contents:contents(source.expected),stock:stock(source.stock)};
      const row={id:source.id,name:'Imported Lite count '+source.unitId,date:source.date,status:source.status.toLowerCase(),created:when(source.date),createdBy:owner,expected:[expected],observations:observed===null?[]:[{unitId:source.unit,location:source.location,contents:observed,stock:stock(source.stock),unknownContents:'',note:source.notes,observedAt:when(source.observedAt),observedBy:owner}],sourceEdition:'Lite',importReceipt:receiptKey,sourceOwnerRecord:structuredClone(source)};
      const revisions=Array.isArray(source.provenance?.observationHistory)?source.provenance.observationHistory:[];
      row.observationHistory=revisions.map(o=>({unitId:source.unit,location:o.location,contents:contents(o.contents),stock:stock(o.stock),unknownContents:o.unknownContents||'',note:o.note||'',observedAt:o.observedAt||when(source.observedAt||source.date),observedBy:owner,sourceObserverName:o.sourceObserverName||''}));
      const latest=row.observationHistory.at(-1),latestNotes=latest?([latest.note,latest.unknownContents?'Unidentified contents: '+latest.unknownContents:''].filter(Boolean).join('; ')||'Full Suite physical observation').slice(0,500):'';
      // A direct Full -> Lite -> Full transfer restores the observed location,
      // unknown contents and original timestamp. If the owner edited the count
      // in Lite, retain the old revisions and append the actual owner observation.
      if(observed!==null&&latest&&JSON.stringify(latest.contents)===JSON.stringify(observed)&&latestNotes===source.notes)row.observations=[{...structuredClone(latest),stock:stock(source.stock)}];
      else if(observed!==null)row.observationHistory.push(structuredClone(row.observations[0]));
      if(source.status!=='Open'){row.submitted=when(source.observedAt||source.date);row.submittedBy=owner;}
      if(source.status==='Approved'||source.status==='Rejected'){
        row.reviewed=when(source.approvedAt||source.history?.at(-1)?.date||source.date);row.reviewedBy=owner;row.reason=source.approvalNotes||source.rejectionNotes;row.adjustmentDate=source.approvedAt||null;
        row.corrections=source.status==='Approved'?[{unitId:source.unit,before:contents(source.expected),after:observed,stockSources:(source.corrections||[]).map(c=>c.source).filter(Boolean)}]:[];
      }
      db.prepare('INSERT INTO asset_count_sessions VALUES(?,?,?,?)').run(company.id,source.id,JSON.stringify(row),Math.max(1,source.history?.length||1));importedCounts++;
    }
    const warehouseEvents=importOwnerWarehouseMetadata(db,company,desk);
    db.exec('RELEASE '+save);return {units:importedUnits,counts:importedCounts,movements:importedMovements,...(warehouseEvents?{warehouseEvents}:{})};
  }catch(error){db.exec('ROLLBACK TO '+save);db.exec('RELEASE '+save);throw error;}
}
