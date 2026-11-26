// Owner-only Full Suite -> Lite projection. Call only after the existing export
// permission check. Platform account IDs, grants and ACLs are never portable.
import {validateState} from './shared/core.mjs';
import {deskOf,validateDesk} from './shared/desk-core.mjs';

const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const rows=(db,table,company)=>exists(db,table)?db.prepare('SELECT * FROM '+table+' WHERE company=? ORDER BY rowid').all(company).map(r=>({...r,...JSON.parse(r.body),id:r.id,version:r.version??JSON.parse(r.body).version})):[];
const date=(value,fallback='')=>{const v=String(value||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:fallback;};
const status=x=>({'open':'Open','in-progress':'In progress','done':'Done'})[x]||'Open';
const contents=rows=>(rows||[]).map(x=>({item:x.itemId??x.item,qty:x.quantity??x.qty}));
const clone=x=>structuredClone(x);
const taskKind=(r,original)=>r.kind==='onboarding'?'Onboarding':r.kind==='termination'?'Termination':r.kind==='close-task'?'Close':['General','Close','Legal'].includes(r.sourceTaskKind||original?.kind)?(r.sourceTaskKind||original.kind):'General';
function put(array,value){const index=array.findIndex(x=>x.id===value.id);if(index<0)array.push(value);else array[index]=value;}
function provenanceNote(original,source,names){return [source.notes||'',names.length?'Full Suite provenance: '+names.join('; ')+'. Operator in Lite: Owner.':'',original?.notes&&original.notes!==source.notes?'Original Lite notes: '+original.notes:''].filter(Boolean).join('\n');}
function plainRecord(r,department,name){return {id:r.sourceLiteId||r.id,title:r.title,kind:r.kind,dueDate:r.dueDate||'',status:r.status,notes:r.notes||'',department:department(r.departmentId),sourceOwnerName:name(r.ownerId),created:r.created||'',updated:r.updated||''};}

export function portableDeskState(db,state){
 const result=clone(state),hasAccounts=exists(db,'accounts');
 const name=id=>{if(!id||!hasAccounts)return '';return db.prepare('SELECT name FROM accounts WHERE id=?').get(id)?.name||'Former staff member';};
 for(const c of result.companies){
  const original=c.desk?clone(c.desk):null,d=clone(deskOf(c));c.desk=d;
  const department=id=>{if(!id||!exists(db,'departments'))return 'Owner';const row=db.prepare('SELECT body FROM departments WHERE company=? AND id=?').get(c.id,id);return row?JSON.parse(row.body).name:'Former department';};
  const warnings=[],archive={undatedTasks:[],contracts:[],staffing:[],departmentRecords:[],units:[],counts:[]};
  const warn=text=>{if(!warnings.includes(text))warnings.push(text);};
  const projectRows=rows(db,'project_workspaces',c.id),taskRows=rows(db,'project_tasks',c.id),staffRows=rows(db,'project_staffing',c.id),recordRows=rows(db,'department_records',c.id),unitRows=rows(db,'tracked_units',c.id),sessionRows=rows(db,'asset_count_sessions',c.id),movementRows=rows(db,'asset_movements',c.id);
  // Retained original Lite data is the fallback when it was never migrated to a
  // Full workspace. Once mapped, the SQL row (including deletion) is authoritative.
  if(exists(db,'owner_desk_rows'))for(const r of db.prepare('SELECT kind,source,target FROM owner_desk_rows WHERE company=?').all(c.id)){
   const key=({project:'projects',task:'tasks',staff:'staffing',staffing:'staffing',contract:'contracts',unit:'units',count:'counts'})[r.kind];if(key)d[key]=d[key].filter(x=>x.id!==r.source);
  }
  for(const p of projectRows){const originalProject=original?.projects.find(x=>x.id===p.sourceLiteId||x.job===p.id);put(d.projects,{id:p.sourceLiteId||originalProject?.id||p.id,job:p.id,lead:'owner',department:department(p.departmentId),status:p.status==='done'?'Complete':'Active',provenance:{edition:'Full Suite',leadName:name(p.leadId),sourceStatus:p.status}});}
  const contractIds=new Map(recordRows.filter(r=>r.kind==='contract').map(r=>[r.id,r.sourceLiteId||r.id]));
  for(const t of taskRows){const old=original?.tasks.find(x=>x.id===t.sourceLiteId),due=date(t.dueDate);
   put(d.tasks,{id:t.sourceLiteId||t.id,job:t.projectId,title:t.title,owner:'owner',kind:taskKind(t,old),status:status(t.status),due,notes:provenanceNote(old,t,name(t.ownerId)?['task owner '+name(t.ownerId)]:[]),contract:contractIds.get(t.contractId)||old?.contract||'',provenance:{edition:'Full Suite',sourceOwnerName:name(t.ownerId),sourceDepartment:department(t.departmentId)}});
  }
  for(const s of staffRows){const old=original?.staffing.find(x=>x.id===s.sourceLiteId);put(d.staffing,{id:s.sourceLiteId||s.id,job:s.projectId||s.project,employee:s.employeeId||s.employee,plannedMinutes:s.plannedMinutes??old?.plannedMinutes??0,provenance:{edition:'Full Suite',start:s.start||'',end:s.end||'',role:s.role||''}});}
  if(staffRows.some(s=>!s.sourceLiteId))warn('Full Suite staffing dates and roles are retained as provenance; a new Full Suite assignment exports with zero planned minutes because Full Suite does not store a Lite staffing estimate.');
  let personnelRecords=0;
  for(const r of recordRows){const old=original?.contracts.find(x=>x.id===r.sourceLiteId);
   if(r.kind==='contract'){
    put(d.contracts,{...old,id:r.sourceLiteId||r.id,name:r.title,counterparty:r.counterparty??old?.counterparty??'',reference:r.reference??old?.reference??'',effective:date(r.effectiveDate),renewal:date(r.dueDate),job:r.projectId||'',status:['Active','Expired','Terminated','Closed'].includes(r.contractStatus)?r.contractStatus:r.status==='done'?(['Expired','Terminated','Closed'].includes(r.sourceStatus)?r.sourceStatus:'Closed'):'Active',notes:provenanceNote(old,r,name(r.ownerId)?['record owner '+name(r.ownerId)]:[]),provenance:{edition:'Full Suite',sourceOwnerName:name(r.ownerId),department:department(r.departmentId)}});continue;
   }
   if(['onboarding','termination','benefits-work','case'].includes(r.kind)&&r.sourceKind!=='task'){++personnelRecords;continue;}
   const originalTask=original?.tasks.find(t=>t.id===r.sourceLiteId);put(d.tasks,{id:r.sourceLiteId||r.id,job:r.projectId||'',contract:contractIds.get(r.contractId)||originalTask?.contract||'',title:r.title,kind:taskKind(r,originalTask),owner:'owner',status:status(r.status),due:date(r.dueDate),notes:provenanceNote(originalTask,r,name(r.ownerId)?['record owner '+name(r.ownerId)]:[]),provenance:{edition:'Full Suite',sourceOwnerName:name(r.ownerId),sourceDepartment:department(r.departmentId),sourceRecordKind:r.kind}});
  }
  if(personnelRecords)warn('Personnel-only department records remain in the Full Suite database and are excluded from the Lite portable snapshot.');
  const unitMap=new Map();
  for(const u of unitRows){const id=u.sourceLiteId||u.sourceOwnerRecord?.id||u.id;unitMap.set(u.id,id);const old=original?.units.find(x=>x.id===id);const related=movementRows.filter(m=>m.unitId===u.id),safe={id,unitId:u.identifier,name:u.name,kind:u.kind==='pallet'?'Pallet':'Asset',location:u.location,status:({'active':'Available','in-transit':'In transit','quarantine':'Hold','retired':'Retired'})[u.status]||'Available',contents:contents(u.contents),fixedAsset:u.fixedAssetId||'',version:u.version||1,history:related.map(m=>m.sourceHistory?{...clone(m.sourceHistory),actor:'owner'}:{id:m.id,date:date(m.date),kind:m.kind,detail:([m.from&&m.to?m.from+' → '+m.to:'',m.note].filter(Boolean).join('; ')||m.kind).slice(0,500),actor:'owner',before:contents(m.before),after:contents(m.after),stockSources:clone(m.stockSources||[]),provenance:{edition:'Full Suite',actorName:name(m.actor),sourceNote:m.note||''}})};
   if(!safe.history.length&&old)safe.history=clone(old.history);if(!safe.history.length)safe.history=[{id:'portable-'+id,date:date(u.lastDate,date(u.created,'1970-01-01')),kind:'Imported',detail:'Full Suite tracking state exported; no movement records were available.',actor:'owner'}];
   if(safe.contents.length>100){d.units=d.units.filter(x=>x.id!==id);archive.units.push(safe);warn('Tracked units with more than 100 content rows are preserved in the transfer archive because Lite supports at most 100 per unit.');continue;}put(d.units,safe);
  }
  for(const s of sessionRows)for(const e of s.expected||[]){const mappedUnit=unitMap.get(e.unitId)||e.unitId,unit=d.units.find(u=>u.id===mappedUnit),o=s.observations?.find(x=>x.unitId===e.unitId),source=s.sourceLiteId||s.sourceOwnerRecord?.id;const old=original?.counts.find(x=>x.id===(source||s.id)&&x.unit===mappedUnit);const id=s.expected.length===1?(source||s.id):s.id+':'+mappedUnit;
   const safe={id,unit:mappedUnit,unitId:e.identifier,location:e.location,version:e.version,date:date(s.date),status:({'open':'Open','submitted':'Submitted','approved':'Approved','rejected':'Rejected'})[s.status]||'Open',expected:contents(e.contents),stock:(o?.stock||e.stock||[]).map(x=>({item:x.itemId,qty:x.qty,value:x.value})),observed:o?contents(o.contents):null,notes:o?([o.note,o.unknownContents?'Unidentified contents: '+o.unknownContents:''].filter(Boolean).join('; ')||'Full Suite physical observation').slice(0,500):'',history:[{id:s.id+':opened:'+mappedUnit,date:date(s.date),kind:'Opened',detail:'Expected quantities frozen in Full Suite',actor:'owner'}],provenance:{edition:'Full Suite',sessionId:s.id,sessionName:s.name,createdByName:name(s.createdBy),observedByName:name(o?.observedBy),reviewedByName:name(s.reviewedBy),observationNote:o?.note||'',unknownContents:o?.unknownContents||'',reviewReason:s.reason||''}};
   if(o){safe.observedAt=date(o.observedAt,safe.date);safe.history.push({id:s.id+':observed:'+mappedUnit,date:safe.observedAt,kind:'Submitted',detail:(o.note||'Physical observation submitted').slice(0,500),actor:'owner'});}
   if(s.status==='approved'){safe.approvedAt=date(s.adjustmentDate,date(s.reviewed,safe.date));safe.approvalNotes=(s.reason||'Full Suite approval').slice(0,500);const correction=s.corrections?.find(x=>x.unitId===e.unitId);let index=0;safe.corrections=[...new Set([...safe.expected,...(safe.observed||[])].map(x=>x.item))].map(item=>{const before=safe.expected.find(x=>x.item===item)?.qty||0,after=safe.observed?.find(x=>x.item===item)?.qty||0,delta=after-before,source=delta?correction?.stockSources?.[index++]:'';return {item,before,after,delta,...(source?{source}:{}),stockSources:clone(correction?.stockSources||[]),...(delta>0&&source?{increaseValueCents:c.moves.filter(m=>m.source===source&&m.item===item).reduce((n,m)=>n+m.value,0)}:{})};}).filter(x=>x.delta);safe.history.push({id:s.id+':approved:'+mappedUnit,date:safe.approvedAt,kind:'Approved',detail:(s.reason||'Count approved').slice(0,500),actor:'owner'});}
   if(s.status==='rejected'){safe.rejectionNotes=(s.reason||'Full Suite rejection').slice(0,500);safe.history.push({id:s.id+':rejected:'+mappedUnit,date:date(s.reviewed,safe.date),kind:'Rejected',detail:(s.reason||'Count rejected').slice(0,500),actor:'owner'});}
   if(s.sourceOwnerRecord?.history){const prior=clone(s.sourceOwnerRecord.history).map(h=>({...h,actor:'owner'}));safe.history=[...prior,...safe.history.filter(h=>!prior.some(x=>x.kind===h.kind))];}
   if(!unit||safe.expected.length>100||(safe.observed||[]).length>100){d.counts=d.counts.filter(x=>x.id!==id);archive.counts.push(safe);warn('Counts outside Lite content-row limits are preserved in the transfer archive.');continue;}
   // Original imported count IDs and observations are preserved, while SQL state
   // wins for subsequent Full Suite corrections or reviews.
   put(d.counts,{...old,...safe});
  }
  if(sessionRows.some(s=>s.expected.length>1))warn('Multi-unit Full Suite count sessions are split into one owner-operated Lite count per unit; the original session ID and name remain in provenance.');
  if(original?.transfer?.archive)for(const [key,list] of Object.entries(original.transfer.archive))if(Array.isArray(list))for(const r of list)if(!archive[key]?.some(x=>x.id===r.id)){(archive[key]??=[]).push(clone(r));}
  for(const warning of original?.transfer?.warnings||[])warn(warning);
  d.transfer={version:1,sourceEdition:'Full Suite',warnings,excluded:{personnelDepartmentRecords:personnelRecords,platformAccounts:true,departmentPermissions:true,assetPermissions:true},archive};
  validateDesk(c);
 }
 validateState(result);return result;
}

export function portableDeskReport(state){return state.companies.map(c=>({companyId:c.id,companyName:c.name,warnings:clone(c.desk?.transfer?.warnings||[]),excluded:clone(c.desk?.transfer?.excluded||{}),archived:Object.fromEntries(Object.entries(c.desk?.transfer?.archive||{}).map(([key,rows])=>[key,rows.length]))}));}
