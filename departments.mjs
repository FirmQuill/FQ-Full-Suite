import {randomUUID} from 'node:crypto';
import {accountAreas} from './access.mjs';
import {balance,outstanding} from './shared/core.mjs';

export const DEPARTMENT_RIGHTS=['view','manage','assign','restricted','finance','hr'];
export const DEPARTMENT_WIDGETS=['projects','tasks','contracts','renewals','invoices','balances','close-tasks','onboarding','termination','benefits-work','cases','records'];
const presets=[['legal','Legal',['contracts','renewals','projects','tasks']],['finance','Finance',['balances','invoices','close-tasks','projects']],['hr','HR',['onboarding','termination','benefits-work','cases','tasks']],['operations','Operations',['projects','tasks','records']]];
const check=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const stamp=()=>new Date().toISOString();
const text=(v,max=160,optional=false)=>{check(typeof v==='string'&&v.length<=max&&(optional||v.trim()),'Enter valid text.');return v.trim();};
const day=(v,optional=true)=>{check(optional&&v===''||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v,'Enter a valid calendar date.');return v;};
const list=(v,allowed)=>{check(Array.isArray(v)&&v.length<=100&&new Set(v).size===v.length&&v.every(x=>allowed.includes(x)),'Choose valid permissions or widgets.');return v;};
const parsed=row=>row&&({...JSON.parse(row.body),id:row.id,companyId:row.company,version:row.version});
const provenance=row=>Object.fromEntries(Object.entries(row||{}).filter(([k])=>k.startsWith('source')||['counterparty','reference','effectiveDate','projectId','contractId','ownerLabel'].includes(k)));
export const companyAccess=(user,company)=>!!user&&user.active!==false&&(user.role==='owner'||user.assignments?.includes(company));
export function departmentCompany(state,user,company){const c=state.companies.find(c=>c.id===company);check(c&&companyAccess(user,company),'Company access denied.',403);return c;}
export function initializeDepartments(db,state){
  db.exec(`CREATE TABLE IF NOT EXISTS department_bootstrap(company TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS departments(id TEXT NOT NULL,company TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(company,id));
    CREATE TABLE IF NOT EXISTS department_grants(company TEXT NOT NULL,department TEXT NOT NULL,account TEXT NOT NULL,rights TEXT NOT NULL,PRIMARY KEY(company,department,account));
    CREATE TABLE IF NOT EXISTS department_records(id TEXT PRIMARY KEY,company TEXT NOT NULL,department TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS department_records_scope ON department_records(company,department);
    CREATE TABLE IF NOT EXISTS department_events(id INTEGER PRIMARY KEY,company TEXT NOT NULL,department TEXT NOT NULL,record TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`);
  const existing=state||(()=>{const r=db.prepare('SELECT body FROM books WHERE id=1').get();return r?JSON.parse(r.body):{companies:[]};})();
  ensureDepartments(db,existing);
}
export function ensureDepartments(db,state){
  for(const c of state.companies){
    if(db.prepare('SELECT 1 FROM department_bootstrap WHERE company=?').get(c.id))continue;
    for(const [id,name,widgets] of presets)db.prepare('INSERT OR IGNORE INTO departments VALUES(?,?,?,1)').run(id,c.id,JSON.stringify({name,kind:name,widgets}));
    // Existing HR/payroll roles receive their matching workspace once. A persisted
    // empty grant is a revocation and is never silently restored on restart.
    for(const a of db.prepare("SELECT id,role,assignments FROM accounts WHERE active=1 AND role IN ('hr','payroll')").all())if(JSON.parse(a.assignments).includes(c.id)){
      const dept=a.role==='hr'?'hr':'finance',rights=a.role==='hr'?['view','manage','assign','hr']:['view','manage','finance'];
      db.prepare('INSERT OR IGNORE INTO department_grants VALUES(?,?,?,?)').run(c.id,dept,a.id,JSON.stringify(rights));
    }
    db.prepare('INSERT OR IGNORE INTO department_bootstrap VALUES(?)').run(c.id);
  }
}
export function departmentPermissions(db,user,company,department){
  if(!companyAccess(user,company)||user.role==='worker')return [];
  if(user.role==='owner')return DEPARTMENT_RIGHTS;
  const r=db.prepare('SELECT rights FROM department_grants WHERE company=? AND department=? AND account=?').get(company,department,user.id);
  return r?JSON.parse(r.rights):[];
}
export function departmentFor(db,company,id){return parsed(db.prepare('SELECT * FROM departments WHERE company=? AND id=?').get(company,id));}
export function workspaceAccounts(db,user,state,company){
  departmentCompany(state,user,company);
  return db.prepare("SELECT id,name,role,assignments FROM accounts WHERE active=1 AND role<>'worker'").all().filter(a=>a.role==='owner'||JSON.parse(a.assignments).includes(company)).map(({id,name,role})=>({id,name,role}));
}
export function validateWorkspaceAccount(db,company,id,{optional=true,hrOnly=false,allowWorker=false}={}){
  if(optional&&!id)return '';
  const a=db.prepare('SELECT id,role,active,assignments FROM accounts WHERE id=?').get(id);
  check(a&&a.active&&(allowWorker||a.role!=='worker')&&(a.role==='owner'||JSON.parse(a.assignments).includes(company))&&(!hrOnly||['owner','hr'].includes(a.role)),'Choose an active authorized company account.');
  return id;
}
export function validateReaders(db,company,readers=[]){check(Array.isArray(readers)&&readers.length<=100&&new Set(readers).size===readers.length,'Choose valid reader accounts.');return readers.map(id=>validateWorkspaceAccount(db,company,id,{optional:false,allowWorker:true}));}
export function visibleWorkspaceRecord(db,user,company,record){
  if(!companyAccess(user,company))return false;
  if(user.role==='owner')return true;
  if(user.role==='worker')return false;
  const rights=departmentPermissions(db,user,company,record.departmentId),areas=accountAreas(db,user);
  if(['onboarding','termination','benefits-work','case'].includes(record.kind)&&(!rights.includes('hr')||!areas.some(a=>['Employee records','Benefits administration'].includes(a))))return false;
  if(record.kind==='close-task'&&(!rights.includes('finance')||!areas.some(a=>['Accounting','Banking','Reports'].includes(a))))return false;
  if(record.readers?.includes(user.id))return true;
  if(record.restricted)return record.readers?.includes(user.id)||rights.includes('view')&&rights.includes('restricted');
  return rights.includes('view')||record.readers?.includes(user.id);
}
export function visibleProject(db,user,company,project){
  if(!companyAccess(user,company))return false;
  if(user.role==='owner')return true;
  if(project.readers?.includes(user.id))return true;
  if(user.role==='worker')return !project.id||project.visibility==='company';
  const rights=departmentPermissions(db,user,company,project.departmentId);
  if(project.visibility==='company')return rights.includes('view')||accountAreas(db,user).some(a=>['Jobs & time','Sales','Purchasing','Reports','Employee records'].includes(a));
  return project.visibility==='department'&&rights.includes('view')||project.visibility==='restricted'&&rights.includes('view')&&rights.includes('restricted');
}
function log(db,user,company,department,record,body){const at=stamp();db.prepare('INSERT INTO department_events(company,department,record,actor,at,body) VALUES(?,?,?,?,?,?)').run(company,department,record,user.id,at,JSON.stringify(body));db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(at,user.id,company,'department workspace updated',record||department);}
export function departmentCommand(db,user,state,a){
  const c=departmentCompany(state,user,a.companyId);check(user.role!=='worker'&&user.role!=='viewer','Workspace write access denied.',403);ensureDepartments(db,state);
  if(a.type==='department-save'){
    check(user.role==='owner','Owner access required to configure departments.',403);
    const old=a.id?departmentFor(db,c.id,a.id):null;check(!a.id||old,'Department unavailable.',404);if(old)check(a.version===old.version,'Department changed. Refresh before saving.',409);
    const id=old?.id||randomUUID(),body={name:text(a.name),kind:a.kind||'Custom',widgets:list(a.widgets||[],DEPARTMENT_WIDGETS)};check(['Legal','Finance','HR','Operations','Custom'].includes(body.kind),'Choose a department kind.');
    db.prepare('INSERT INTO departments VALUES(?,?,?,1) ON CONFLICT(company,id) DO UPDATE SET body=excluded.body,version=departments.version+1').run(id,c.id,JSON.stringify(body));log(db,user,c.id,id,'',{type:a.type});return {departmentId:id};
  }
  const dept=departmentFor(db,c.id,a.departmentId);check(dept,'Department unavailable.',404);
  if(a.type==='department-grant'){
    check(user.role==='owner','Owner access required to grant department permissions.',403);validateWorkspaceAccount(db,c.id,a.accountId,{optional:false});const rights=list(a.rights||[],DEPARTMENT_RIGHTS);check(!rights.length||rights.includes('view'),'Department permissions require view access.');
    db.prepare('INSERT INTO department_grants VALUES(?,?,?,?) ON CONFLICT(company,department,account) DO UPDATE SET rights=excluded.rights').run(c.id,dept.id,a.accountId,JSON.stringify(rights));log(db,user,c.id,dept.id,a.accountId,{type:a.type,rights});return {accountId:a.accountId};
  }
  check(a.type==='record-save','Unknown department operation.');const rights=departmentPermissions(db,user,c.id,dept.id);check(rights.includes('manage'),'Department management permission required.',403);
  const old=a.id?parsed(db.prepare('SELECT * FROM department_records WHERE id=? AND company=?').get(a.id,c.id)):null;check(!a.id||old&&visibleWorkspaceRecord(db,user,c.id,old),'Record unavailable.',404);if(old){check(old.departmentId===dept.id||user.role==='owner','Only the owner can move a record between departments.',403);check(a.version===old.version,'Record changed. Refresh before saving.',409);}
  const kind=a.kind||'record';check(['contract','close-task','onboarding','termination','benefits-work','case','record'].includes(kind),'Choose a record kind.');
  const restricted=!!a.restricted||kind==='case';check(!(restricted||old?.restricted)||rights.includes('restricted'),'Restricted-record management permission required.',403);
  if(['onboarding','termination','benefits-work','case'].includes(kind))check(rights.includes('hr')&&(user.role==='owner'||accountAreas(db,user).some(a=>['Employee records','Benefits administration'].includes(a))),'HR permission and employee ERP area required.',403);
  if(kind==='close-task')check(rights.includes('finance')&&(user.role==='owner'||accountAreas(db,user).some(a=>['Accounting','Banking','Reports'].includes(a))),'Finance permission and financial ERP area required.',403);
  const ownerId=validateWorkspaceAccount(db,c.id,a.ownerId||'',{hrOnly:['onboarding','termination','benefits-work','case'].includes(kind)});
  check(ownerId===(old?.ownerId||'')||rights.includes('assign')||user.role==='owner','Assignment permission required.',403);
  const id=old?.id||randomUUID(),body={...provenance(old),departmentId:dept.id,kind,title:text(a.title),dueDate:day(a.dueDate||''),status:a.status||'open',ownerId,restricted,readers:validateReaders(db,c.id,a.readers||[]),notes:text(a.notes||'',4000,true),created:old?.created||stamp(),updated:stamp()};check(['open','in-progress','done'].includes(body.status),'Choose a record status.');
  if(kind==='contract'){
    body.counterparty=text(a.counterparty??old?.counterparty??'',160,true);body.reference=text(a.reference??old?.reference??'',500,true);body.effectiveDate=day(a.effectiveDate??old?.effectiveDate??'');
    const statuses=['Active','Expired','Terminated','Closed'];body.contractStatus=a.contractStatus??(statuses.includes(old?.contractStatus)?old.contractStatus:statuses.includes(old?.sourceStatus)?old.sourceStatus:body.status==='done'?'Closed':'Active');check(statuses.includes(body.contractStatus),'Choose a contract status.');
    check(!body.effectiveDate||!body.dueDate||body.dueDate>=body.effectiveDate,'Renewal cannot precede the effective date.');
  }
  check(user.role==='owner'||JSON.stringify(body.readers)===JSON.stringify(old?.readers||[]),'Only the owner can grant explicit record access.',403);
  db.prepare('INSERT INTO department_records VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET department=excluded.department,body=excluded.body,version=department_records.version+1').run(id,c.id,dept.id,JSON.stringify(body));log(db,user,c.id,dept.id,id,{type:a.type,before:old,after:body});return {recordId:id};
}
export function departmentView(db,user,state,query={}){
  check(user.role!=='worker','Corporate workspace access required.',403);ensureDepartments(db,state);const workspaces=[],areas=accountAreas(db,user),has=(...names)=>user.role==='owner'||names.some(n=>areas.includes(n));
  for(const c of state.companies.filter(c=>companyAccess(user,c.id)&&(!query.companyId||query.companyId===c.id))){
    for(const row of db.prepare('SELECT * FROM departments WHERE company=?').all(c.id)){
      const dept=parsed(row),rights=departmentPermissions(db,user,c.id,dept.id);if(!rights.includes('view'))continue;
      const records=db.prepare('SELECT * FROM department_records WHERE company=? AND department=?').all(c.id,dept.id).map(parsed).filter(r=>visibleWorkspaceRecord(db,user,c.id,r));
      const projectTable=db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_workspaces'").get();
      const projects=projectTable?db.prepare('SELECT * FROM project_workspaces WHERE company=?').all(c.id).map(parsed).filter(p=>p.departmentId===dept.id&&visibleProject(db,user,c.id,p)).map(p=>({...p,name:c.jobs.find(j=>j.id===p.id)?.name||'Project'})):[];
      const tasks=projectTable?db.prepare('SELECT * FROM project_tasks WHERE company=? AND department=?').all(c.id,dept.id).map(parsed).filter(t=>{const p=db.prepare('SELECT * FROM project_workspaces WHERE company=? AND id=?').get(c.id,t.projectId);return p&&visibleProject(db,user,c.id,parsed(p))&&visibleWorkspaceRecord(db,user,c.id,t);}):[];
      const widgets=[];for(const id of dept.widgets){
        if(id==='projects'){widgets.push({id,rows:projects.map(({id,name,status})=>({id,name,status}))});continue;}
        if(id==='tasks'){widgets.push({id,rows:tasks});continue;}
        if(['balances','invoices'].includes(id)){
          if(!rights.includes('finance'))continue;
          // Financial records linked to hidden projects are excluded before totals.
          const hidden=new Set(c.jobs.filter(j=>{const p=projectTable?parsed(db.prepare('SELECT * FROM project_workspaces WHERE company=? AND id=?').get(c.id,j.id)):null;return p&&p.visibility!=='company'&&!visibleProject(db,user,c.id,p);}).map(j=>j.id));
          const sources=new Set([...c.docs,...c.history,...c.time].filter(r=>hidden.has(r.job)).map(r=>r.id));
          if(id==='invoices'&&has('Sales','Reports'))widgets.push({id,rows:c.docs.filter(d=>d.kind==='invoice'&&!hidden.has(d.job)&&!sources.has(d.id)).map(d=>({id:d.id,date:d.date,label:d.label,total:d.total,outstanding:outstanding(c,d)}))});
          if(id==='balances'&&has('Accounting','Banking','Reports')){const book={...c,entries:c.entries.filter(e=>!sources.has(e.source))};widgets.push({id,value:{cash:balance(book,'1000'),receivable:balance(book,'1100'),payable:-balance(book,'2000'),scope:hidden.size?'permitted-records':'company'}});}
          continue;
        }
        const kinds={contracts:'contract',renewals:'contract','close-tasks':'close-task',onboarding:'onboarding',termination:'termination','benefits-work':'benefits-work',cases:'case'};
        if(['onboarding','termination','benefits-work','cases'].includes(id)&&(!rights.includes('hr')||!has('Employee records','Benefits administration')))continue;
        if(id==='close-tasks'&&!rights.includes('finance'))continue;
        widgets.push({id,rows:records.filter(r=>id==='records'||r.kind===kinds[id]&&(id!=='renewals'||r.dueDate&&(r.contractStatus||r.sourceStatus||(r.status==='done'?'Closed':'Active'))==='Active'))});
      }
      workspaces.push({...dept,companyName:c.name,rights,records,projects,tasks,widgets,grants:user.role==='owner'?db.prepare('SELECT account,rights FROM department_grants WHERE company=? AND department=?').all(c.id,dept.id).map(g=>({accountId:g.account,rights:JSON.parse(g.rights)})):[]});
    }
  }
  const companyId=query.companyId||(workspaces[0]?.companyId);return {workspaces,accounts:companyId&&(user.role==='owner'||workspaces.length)?workspaceAccounts(db,user,state,companyId):[],widgetTypes:DEPARTMENT_WIDGETS,rights:DEPARTMENT_RIGHTS};
}
