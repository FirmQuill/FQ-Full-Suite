import {randomUUID} from 'node:crypto';
import {apply,jobSummary,sum} from './shared/core.mjs';
import {accountAreas} from './access.mjs';
import {companyAccess,departmentCompany,ensureDepartments,departmentFor,departmentPermissions,visibleProject,visibleWorkspaceRecord,validateReaders,validateWorkspaceAccount,workspaceAccounts} from './departments.mjs';

const check=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const now=()=>new Date().toISOString();
const day=(v,optional=false)=>{check(optional&&v===''||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v,'Enter a valid calendar date.');return v;};
const text=(v,max=160,optional=false)=>{check(typeof v==='string'&&v.length<=max&&(optional||v.trim()),'Enter valid text.');return v.trim();};
const provenance=row=>Object.fromEntries(Object.entries(row||{}).filter(([k])=>k.startsWith('source')||['leadLabel','ownerLabel','contractId','plannedMinutes'].includes(k)));
const parsed=r=>r&&({...JSON.parse(r.body),id:r.id,companyId:r.company,version:r.version});
const metadata=(db,company,id)=>parsed(db.prepare('SELECT * FROM project_workspaces WHERE company=? AND id=?').get(company,id));
export function initializeProjects(db){db.exec(`CREATE TABLE IF NOT EXISTS project_workspaces(id TEXT NOT NULL,company TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(company,id));
  CREATE TABLE IF NOT EXISTS project_tasks(id TEXT PRIMARY KEY,company TEXT NOT NULL,project TEXT NOT NULL,department TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS project_tasks_scope ON project_tasks(company,project,department);
  CREATE TABLE IF NOT EXISTS project_staffing(id TEXT PRIMARY KEY,company TEXT NOT NULL,project TEXT NOT NULL,employee TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS project_events(id INTEGER PRIMARY KEY,company TEXT NOT NULL,project TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`);}
const legacy=id=>({id,departmentId:'',visibility:'company',readers:[],leadId:'',status:'open',version:0});
export function visibleProjectJobs(db,user,company){return companyAccess(user,company.id)?company.jobs.filter(j=>visibleProject(db,user,company.id,metadata(db,company.id,j.id)||legacy(j.id))).map(j=>({id:j.id,name:j.name})):[];}
function rightsFor(db,user,company,project){return user.role==='owner'?['view','manage','assign','restricted','finance','hr']:departmentPermissions(db,user,company,project.departmentId);}
function writeProject(db,user,company,project){check(user.role!=='worker'&&user.role!=='viewer'&&visibleProject(db,user,company,project),'Project unavailable.',404);check(user.role==='owner'||project.visibility==='company'&&['manager','bookkeeper'].includes(user.role)||rightsFor(db,user,company,project).includes('manage'),'Project management permission required.',403);}
function audit(db,user,company,project,body){const at=now();db.prepare('INSERT INTO project_events(company,project,actor,at,body) VALUES(?,?,?,?,?)').run(company,project,user.id,at,JSON.stringify(body));db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(at,user.id,company,'project workspace updated',project);}
export function projectCommand(db,user,state,a){
  const c=departmentCompany(state,user,a.companyId);check(user.role!=='worker'&&user.role!=='viewer','Corporate project write access required.',403);ensureDepartments(db,state);
  if(a.type==='project-save'){
    const job=a.id?c.jobs.find(j=>j.id===a.id):null;check(!a.id||job,'Project unavailable.',404);const old=job?(metadata(db,c.id,job.id)||legacy(job.id)):null;
    if(old){writeProject(db,user,c.id,old);check(a.version===old.version,'Project changed. Refresh before saving.',409);}
    const departmentId=a.departmentId||'',dept=departmentId?departmentFor(db,c.id,departmentId):null;check(!departmentId||dept,'Department unavailable.',404);const rights=departmentPermissions(db,user,c.id,departmentId);
    check(user.role==='owner'||rights.includes('manage')||!departmentId&&['manager','bookkeeper'].includes(user.role),'Department project management permission required.',403);
    const visibility=a.visibility||'department';check(['company','department','restricted'].includes(visibility),'Choose project visibility.');check(visibility==='company'||departmentId,'Protected projects need a department.');
    const readers=validateReaders(db,c.id,a.readers||[]);check(user.role==='owner'||(!old||old.departmentId===departmentId)&&(!old||old.visibility===visibility)&&JSON.stringify(readers)===JSON.stringify(old?.readers||[])&&visibility!=='restricted','Only the owner can change project access.',403);
    const name=text(a.name),leadId=validateWorkspaceAccount(db,c.id,a.leadId||'');check(leadId===(old?.leadId||'')||user.role==='owner'||rights.includes('assign'),'Assignment permission required.',403);
    let next=structuredClone(state),id=job?.id;if(!id){next=apply(next,c.id,{type:'job',name,date:day(a.date||now().slice(0,10)),label:name});id=next.companies.find(x=>x.id===c.id).jobs.at(-1).id;}else next.companies.find(x=>x.id===c.id).jobs.find(j=>j.id===id).name=name;
    const body={...provenance(old),departmentId,leadId,visibility,readers,status:a.status||'open',created:old?.created||now(),updated:now()};check(['open','in-progress','done'].includes(body.status),'Choose project status.');
    db.prepare('INSERT INTO project_workspaces VALUES(?,?,?,1) ON CONFLICT(company,id) DO UPDATE SET body=excluded.body,version=project_workspaces.version+1').run(id,c.id,JSON.stringify(body));audit(db,user,c.id,id,{type:a.type,before:old,after:body});return {state:next,result:{projectId:id}};
  }
  const job=c.jobs.find(j=>j.id===a.projectId),project=job&&(metadata(db,c.id,job.id)||legacy(job.id));check(project,'Project unavailable.',404);writeProject(db,user,c.id,project);
  if(a.type==='project-task-save'){
    const old=a.id?parsed(db.prepare('SELECT * FROM project_tasks WHERE id=? AND company=? AND project=?').get(a.id,c.id,job.id)):null;check(!a.id||old&&visibleWorkspaceRecord(db,user,c.id,old),'Task unavailable.',404);if(old)check(a.version===old.version,'Task changed. Refresh before saving.',409);
    const departmentId=a.departmentId||project.departmentId,dept=departmentFor(db,c.id,departmentId);check(dept,'Choose a task department.');const rights=departmentPermissions(db,user,c.id,departmentId);check(user.role==='owner'||rights.includes('manage'),'Task department management permission required.',403);
    const kind=a.kind||'task';check(['task','onboarding','termination'].includes(kind),'Choose a task kind.');const restricted=!!a.restricted;check(!(restricted||old?.restricted)||rights.includes('restricted'),'Restricted task permission required.',403);if(kind!=='task')check(rights.includes('hr')&&(user.role==='owner'||accountAreas(db,user).some(a=>['Employee records','Benefits administration'].includes(a))),'HR permission and employee ERP area required.',403);
    const ownerId=validateWorkspaceAccount(db,c.id,a.ownerId||'',{hrOnly:kind!=='task'});check(ownerId===(old?.ownerId||'')||rights.includes('assign'),'Assignment permission required.',403);const readers=validateReaders(db,c.id,a.readers||[]);check(user.role==='owner'||JSON.stringify(readers)===JSON.stringify(old?.readers||[]),'Only the owner can grant explicit task access.',403);
    const id=old?.id||randomUUID(),body={...provenance(old),projectId:job.id,departmentId,title:text(a.title),kind,ownerId,dueDate:day(a.dueDate||'',true),status:a.status||'open',restricted,readers,notes:text(a.notes||'',4000,true),created:old?.created||now(),updated:now()};check(['open','in-progress','done'].includes(body.status),'Choose task status.');
    db.prepare('INSERT INTO project_tasks VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET department=excluded.department,body=excluded.body,version=project_tasks.version+1').run(id,c.id,job.id,departmentId,JSON.stringify(body));audit(db,user,c.id,job.id,{type:a.type,before:old,after:body});return {result:{taskId:id}};
  }
  const rights=rightsFor(db,user,c.id,project);check(rights.includes('assign')||user.role==='owner','Worker assignment permission required.',403);
  if(a.type==='project-staff'){
    const employee=c.employees.find(e=>e.id===a.employeeId);check(employee,'Select a worker record in this company.');const start=day(a.start||now().slice(0,10)),end=day(a.end||'',true);check(!end||end>=start,'Assignment end precedes start.');
    const existing=db.prepare('SELECT * FROM project_staffing WHERE company=? AND project=? AND employee=?').all(c.id,job.id,employee.id).map(parsed);check(!existing.some(s=>(!s.end||s.end>=start)&&(!end||end>=s.start)),'This worker already has an overlapping assignment.',409);
    const id=randomUUID(),body={employeeId:employee.id,start,end,role:text(a.role||'',160,true),created:now()};db.prepare('INSERT INTO project_staffing VALUES(?,?,?,?,?,1)').run(id,c.id,job.id,employee.id,JSON.stringify(body));audit(db,user,c.id,job.id,{type:a.type,assignmentId:id,after:body});return {result:{assignmentId:id}};
  }
  if(a.type==='project-staff-remove'){
    const old=parsed(db.prepare('SELECT * FROM project_staffing WHERE id=? AND company=? AND project=?').get(a.assignmentId,c.id,job.id));check(old,'Assignment unavailable.',404);db.prepare('DELETE FROM project_staffing WHERE id=?').run(old.id);audit(db,user,c.id,job.id,{type:a.type,before:old});return {result:{assignmentId:old.id}};
  }
  check(false,'Unknown project operation.');
}
export function projectView(db,user,state,query={}){
  check(user.role!=='worker','Corporate project workspace access required.',403);ensureDepartments(db,state);const projects=[],companies=state.companies.filter(c=>companyAccess(user,c.id)&&(!query.companyId||query.companyId===c.id));
  for(const c of companies)for(const job of c.jobs){const p=metadata(db,c.id,job.id)||legacy(job.id);if(!visibleProject(db,user,c.id,p))continue;
    const rights=rightsFor(db,user,c.id,p),finance=user.role==='owner'||rights.includes('finance')&&accountAreas(db,user).some(a=>['Accounting','Reports','Payroll'].includes(a));
    const tasks=db.prepare('SELECT * FROM project_tasks WHERE company=? AND project=?').all(c.id,job.id).map(parsed).filter(t=>visibleWorkspaceRecord(db,user,c.id,t));
    const staffing=db.prepare('SELECT * FROM project_staffing WHERE company=? AND project=?').all(c.id,job.id).map(parsed).map(s=>({...s,employeeName:c.employees.find(e=>e.id===s.employeeId)?.name||'Worker'}));
    projects.push({...p,name:job.name,companyId:c.id,companyName:c.name,rights,tasks,staffing,timeMinutes:sum(c.time.filter(t=>t.job===job.id).map(t=>t.minutes)),...(finance?{cost:jobSummary(c,job.id)}:{})});
  }
  const companyId=query.companyId||companies[0]?.id,departments=companyId?db.prepare('SELECT * FROM departments WHERE company=?').all(companyId).map(parsed).filter(d=>departmentPermissions(db,user,companyId,d.id).includes('view')):[],available=user.role==='owner'||projects.length||departments.length;
  return {projects,accounts:companyId&&available?workspaceAccounts(db,user,state,companyId):[],employees:companyId&&available?companies.find(c=>c.id===companyId)?.employees.map(({id,name})=>({id,name}))||[]:[],departments};
}
function hiddenProjectRecords(db,user,company){
  // Legacy and company-visible journals retain their pre-upgrade financial
  // area permissions even when the account cannot open the job selector.
  const hidden=new Set(company.jobs.filter(j=>{const project=metadata(db,company.id,j.id);return project&&project.visibility!=='company'&&!visibleProject(db,user,company.id,project);}).map(j=>j.id)),denied=new Set(hidden);
  const records=[...company.history,...company.docs,...company.time,...company.entries,...company.moves,...company.bank,...company.attachments];let changed=true;
  while(changed){changed=false;for(const r of records){
    if(!denied.has(r.id)&&[r.job,r.jobId,r.projectId,r.source,r.parent,r.approval,r.match].some(id=>id&&denied.has(id))){denied.add(r.id);changed=true;}
    // An approval belongs to its time entry; its own historical event does not
    // carry a job ID, so follow this ownership edge in the other direction.
    if(denied.has(r.id)&&r.approval&&!denied.has(r.approval)){denied.add(r.approval);changed=true;}
  }}
  return {hidden,denied};
}
// Apply this to every general session/report/export projection. Filter by the
// authoritative full books first or pass fullState when an area projection has
// already discarded the source history needed to resolve journal ownership.
export function projectBusinessState(db,user,state,fullState=state){
  if(user.role==='owner')return state;
  const out=structuredClone(state);for(const c of out.companies){const original=fullState.companies.find(x=>x.id===c.id)||c,{hidden,denied}=hiddenProjectRecords(db,user,original);c.jobs=(c.jobs||[]).filter(j=>visibleProject(db,user,c.id,metadata(db,c.id,j.id)||legacy(j.id)));if(!hidden.size)continue;
    for(const key of ['jobs','time','docs','entries','history','moves','attachments','bank'])c[key]=(c[key]||[]).filter(r=>!denied.has(r.id));
    // Reconciliation totals are company-wide snapshots; do not leak them when
    // their component journals include records outside this account's scope.
    c.reconciliations=[];c.projectScope='permitted-records';
  }return out;
}
export function authorizeProjectAction(db,user,state,companyId,a){
  if(user.role==='owner')return;const c=departmentCompany(state,user,companyId);let job=a.job||a.jobId;
  const {denied}=hiddenProjectRecords(db,user,c);check(![a.time,a.parent,a.source,a.entry,a.row].some(id=>id&&denied.has(id)),'Project access denied.',403);
  if(a.time)job=c.time.find(t=>t.id===a.time)?.job||job;
  if(a.parent)job=c.docs.find(d=>d.id===a.parent)?.job||job;
  const source=a.source||a.entry;if(source){const r=[...c.history,...c.docs,...c.entries,...c.moves,...c.bank].find(r=>r.id===source);job=r?.job||c.history.find(h=>h.id===r?.source)?.job||c.docs.find(d=>d.id===r?.source)?.job||job;}
  if(job){const project=metadata(db,c.id,job);check(c.jobs.some(j=>j.id===job)&&(!project||project.visibility==='company'||visibleProject(db,user,c.id,project)),'Project access denied.',403);}
  // Accounting reports may be partial, but a write to a company-wide close,
  // reconciliation or reversal requires visibility of every affected project.
  if(['close','reconcile','reverse journal','intercompany'].includes(a.type))check(!hiddenProjectRecords(db,user,c).hidden.size,'Company-wide action requires access to every protected project.',403);
}
