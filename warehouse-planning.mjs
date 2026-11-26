import {emptyWarehouse,validateWarehouse,fullWarehouseUnits,warehouseEvent,warehouseTypes,warehouseView} from './shared/warehouse-desk.mjs';
const check=(ok,msg,status=400)=>{if(!ok)throw Object.assign(Error(msg),{status});};
const clean=(v,max=200)=>{check(typeof v==='string'&&v.trim().length>0&&v.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(v),'Enter valid warehouse planning text.');return v.trim();};
const day=v=>{check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'Enter a valid schedule date.');return v;};
const now=()=>new Date().toISOString();
export const planningRights={...Object.fromEntries([...warehouseTypes].map(t=>[t,'manage'])),'warehouse-pick-create':'manage','warehouse-pick-review':'approve','warehouse-pick-complete':'manage','warehouse-pick-cancel':'manage','warehouse-count-plan':'manage','warehouse-count-start':'audit','warehouse-count-cancel':'manage'};
export function initializeWarehousePlanning(db){
 db.exec(`CREATE TABLE IF NOT EXISTS warehouse_metadata(company TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(company,id));
 CREATE TABLE IF NOT EXISTS warehouse_plans(company TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(company,id));
 CREATE TRIGGER IF NOT EXISTS warehouse_metadata_no_update BEFORE UPDATE ON warehouse_metadata BEGIN SELECT RAISE(ABORT,'Warehouse metadata history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS warehouse_metadata_no_delete BEFORE DELETE ON warehouse_metadata BEGIN SELECT RAISE(ABORT,'Warehouse metadata history is immutable'); END;`);
}
const ledger=(db,company)=>({...emptyWarehouse(),events:db.prepare('SELECT body FROM warehouse_metadata WHERE company=? ORDER BY rowid').all(company).map(x=>JSON.parse(x.body))});
export function importOwnerWarehouseMetadata(db,book,desk){
 if(desk?.warehouse===undefined)return 0;
 validateWarehouse(desk.warehouse,book,desk.units.map(u=>({id:u.id})));
 let inserted=0;
 for(const source of desk.warehouse.events){
  const {id,type,date}=source;
  const fields={
    'warehouse-bin':['unitId','location','locationEpoch','bin'],
    'warehouse-trace':['unitId','itemId','location','lot','serial','expiry','quantity'],
    'warehouse-trace-release':['traceId','note'],
    'warehouse-reorder':['itemId','location','minimum','target']
  }[type];
  const safe={id,type,date,actor:'owner',...Object.fromEntries(fields.filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]))};
  const existing=db.prepare('SELECT body FROM warehouse_metadata WHERE company=? AND id=?').get(book.id,source.id);
  if(existing){const saved=JSON.parse(existing.body);check(Object.keys(safe).every(k=>k==='actor'||saved[k]===safe[k]),'A portable warehouse event conflicts with retained history.',409);continue;}
  db.prepare('INSERT INTO warehouse_metadata VALUES(?,?,?)').run(book.id,safe.id,JSON.stringify(safe));++inserted;
 }
 return inserted;
}
export function portableWarehouseMetadata(db,company,unitMap,validUnits){
 const moved=ledger(db,company),unmapped=new Set();
 moved.events=moved.events.flatMap(e=>{
   const safe={...e,actor:'owner'};
   if(e.unitId){safe.unitId=unitMap.get(e.unitId)||e.unitId;if(!validUnits.has(safe.unitId)){unmapped.add(e.id);return [];}}
   if(e.traceId&&unmapped.has(e.traceId))return [];
   return [safe];
 });
 return {data:moved,omitted:unmapped.size,plans:plans(db,company).length};
}
const plans=(db,company)=>db.prepare('SELECT body,version FROM warehouse_plans WHERE company=? ORDER BY rowid').all(company).map(x=>({...JSON.parse(x.body),version:x.version}));
const read=(db,company,id,kind,version)=>{const row=db.prepare('SELECT body,version FROM warehouse_plans WHERE company=? AND id=? AND kind=?').get(company,id,kind);check(row,'Warehouse plan unavailable.',404);check(row.version===version,'Warehouse plan changed. Refresh and review it.',409);return {...JSON.parse(row.body),version:row.version};};
const write=(db,company,row)=>{const {version,...body}=row;db.prepare('INSERT INTO warehouse_plans(company,id,kind,version,body) VALUES(?,?,?,?,?) ON CONFLICT(company,id) DO UPDATE SET version=excluded.version,body=excluded.body').run(company,row.id,row.kind,version,JSON.stringify(body));};
const activeUnit=(units,id)=>{const u=units.find(x=>x.id===id);check(u&&u.status==='active','Select an active pallet or asset.',409);return u;};
const remarks=(row,status,actor,note='')=>({...row,status,version:row.version+1,history:[...row.history,{status,actor,at:now(),note}]});
const maySeePlan=(kind,rights,actor,r,auditOnly)=>(!auditOnly&&kind==='pick'&&rights.some(r=>['view','manage','approve'].includes(r)))||(kind==='count'&&(rights.includes('approve')||(!auditOnly&&rights.includes('manage'))||rights.includes('audit')&&r.assignee===actor));
export function planningView(db,book,units,{user,rights,auditOnly,accounts}){
 const m=warehouseView(ledger(db,book.id),book,fullWarehouseUnits(units),now().slice(0,10));
 const rows=plans(db,book.id);
 return {...m,reorder:auditOnly?[]:m.reorder,events:auditOnly?m.events.filter(e=>e.type!=='warehouse-reorder'):m.events,picks:rows.filter(r=>r.kind==='pick'&&maySeePlan(r.kind,rights,user.id,r,auditOnly)),
  schedules:rows.filter(r=>r.kind==='count'&&maySeePlan(r.kind,rights,user.id,r,auditOnly)),accounts,actor:user.id};
}
export function planningCommand(db,book,units,a,{actor,newId,account,accountRights}){
 const company=book.id;
 if(warehouseTypes.has(a.type)){
  const row=warehouseEvent(ledger(db,company),book,fullWarehouseUnits(units),a,{id:newId(),actor});
  db.prepare('INSERT INTO warehouse_metadata VALUES(?,?,?)').run(company,row.id,JSON.stringify(row));return {unitId:row.unitId,metadataId:row.id};
 }
 if(a.type==='warehouse-pick-create'){
  const u=activeUnit(units,a.unitId),name=clean(a.name);
  const lines=a.lines;check(Array.isArray(lines)&&lines.length>=1&&lines.length<=200&&new Set(lines.map(r=>r?.itemId)).size===lines.length,'Choose different packed products and positive quantities.');
  for(const r of lines)check(Number.isSafeInteger(r?.quantity)&&r.quantity>0&&u.contents.some(c=>c.itemId===r.itemId&&c.quantity>=r.quantity),'Pick quantity exceeds current packed stock.',409);
  const row={id:newId(),kind:'pick',unitId:u.id,unitVersion:u.version,identifier:u.identifier,location:u.location,name,lines:lines.map(({itemId,quantity})=>({itemId,quantity})),version:1,status:'draft',history:[{status:'draft',actor,at:now(),note:''}]};
  write(db,company,row);return {planId:row.id};
 }
 if(a.type.startsWith('warehouse-pick-')){
  const row=read(db,company,a.planId,'pick',a.version);
  let status;
  if(a.type==='warehouse-pick-review'){
   check(row.status==='draft'&&['approved','rejected'].includes(a.decision),'Review is only available for draft pick lists.',409); status=a.decision;
   if(status==='approved'){
    const u=activeUnit(units,row.unitId);check(u.version===row.unitVersion,'Pallet changed. Make a fresh pick list.',409);
    const committed=plans(db,company).filter(r=>r.kind==='pick'&&['approved','completed'].includes(r.status)&&r.unitId===u.id&&r.unitVersion===u.version&&r.id!==row.id);
    for(const l of row.lines){const pending=committed.reduce((n,p)=>n+(p.lines.find(x=>x.itemId===l.itemId)?.quantity||0),0);
     check(pending+l.quantity<=u.contents.find(x=>x.itemId===l.itemId)?.quantity,'Other approved picks already allocate that stock.',409);}
   }
  }else if(a.type==='warehouse-pick-complete'){
   check(row.status==='approved','Only an approved pick can be completed.',409);
   check(activeUnit(units,row.unitId).version===row.unitVersion,'Pallet changed. Cancel this pick and make a fresh list.',409);status='completed';
  }else{check(['draft','approved'].includes(row.status),'Only an open pick can be canceled.',409);status='canceled';}
  write(db,company,remarks(row,status,actor,clean(a.note,500)));return {planId:row.id};
 }
 if(a.type==='warehouse-count-plan'){
  const who=account(a.assignee);
  check(accountRights(who.id).includes('audit'),'Assign a company account with count audit permission.',403);
  const date=day(a.due),ids=a.unitIds;
  check(date>=now().slice(0,10),'Schedule for today or a future date.');
  check(Array.isArray(ids)&&ids.length>=1&&ids.length<=200&&new Set(ids).size===ids.length,'Choose 1–200 different tracked assets.');
  const refs=ids.map(id=>{const u=activeUnit(units,id);return {id:u.id,identifier:u.identifier};});
  const row={id:newId(),kind:'count',name:clean(a.name),assignee:who.id,assigneeName:who.name,due:date,units:refs,status:'scheduled',version:1,history:[{status:'scheduled',actor,at:now(),note:''}]};
  write(db,company,row);return {planId:row.id};
 }
 if(a.type==='warehouse-count-cancel'){
  const row=read(db,company,a.planId,'count',a.version);check(row.status==='scheduled','Only a scheduled count can be canceled.',409);
  write(db,company,remarks(row,'canceled',actor,clean(a.note,500)));return {planId:row.id};
 }
 throw Error('Unknown warehouse planning action.');
}
export function plannedCount(db,book,units,a,actor){
 const row=read(db,book.id,a.planId,'count',a.version);
 check(row.assignee===actor,'Only the assigned auditor can start this count.',403);check(row.status==='scheduled','This count has already been started or canceled.',409);
 const today=now().slice(0,10);
 check(today>=row.due,'The assigned count is not due yet.',409);
 const unitIds=row.units.map(({id})=>activeUnit(units,id).id);
 return {row,unitIds,name:row.name,date:today};
}
export function writePlannedCount(db,company,row,actor,sessionId){write(db,company,{...remarks(row,'started',actor),sessionId});}
