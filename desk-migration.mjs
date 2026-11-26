import {createHash} from 'node:crypto';
import {validateDesk} from './shared/desk-core.mjs';
import {ensureDepartments} from './departments.mjs';
import {migrateOwnerAssets} from './asset-desk-migration.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const importedId=(company,kind,source)=>'lite-'+createHash('sha256').update(company+'\0'+kind+'\0'+source).digest('hex').slice(0,40);
const now=()=>new Date().toISOString();
const status=value=>({'Active':'open','On hold':'in-progress','Complete':'done','Open':'open','In progress':'in-progress','Done':'done','Expired':'done','Terminated':'done','Closed':'done'}[value]||'open');
const taskKind=value=>({'Onboarding':'onboarding','Termination':'termination'}[value]||'task');
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{status:400});};

function initialize(db){db.exec(`CREATE TABLE IF NOT EXISTS owner_desk_imports(company TEXT NOT NULL,digest TEXT NOT NULL,imported_at TEXT NOT NULL,report TEXT NOT NULL,PRIMARY KEY(company,digest));
  CREATE TABLE IF NOT EXISTS owner_desk_rows(company TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(company,kind,source));`);}
function currentOwner(db){return db.prepare("SELECT id FROM accounts WHERE role='owner' AND active=1 ORDER BY rowid LIMIT 1").get()?.id||'';}
function resolveInitialOwner(db,owner){
  if(!owner)return;
  for(const table of ['project_workspaces','project_tasks','department_records'])for(const row of db.prepare('SELECT id,company,body,version FROM '+table+' WHERE version=1').all()){
    const body=JSON.parse(row.body);if(body.sourceEdition!=='Lite'||!body.pendingOwner)continue;const field=table==='project_workspaces'?'leadId':'ownerId';if(body[field])continue;
    body[field]=owner;delete body.pendingOwner;
    // Identity resolution is part of initial conversion. It cannot replace a
    // user edit because edited rows have version >1 and are excluded above.
    db.prepare('UPDATE '+table+' SET body=? WHERE id=? AND company=? AND version=1').run(JSON.stringify(body),row.id,row.company);
  }
}
export function ownerDeskMigrationReports(db,companyId){initialize(db);return db.prepare('SELECT digest,imported_at,report FROM owner_desk_imports WHERE company=? ORDER BY imported_at').all(companyId).map(r=>({digest:r.digest,importedAt:r.imported_at,...JSON.parse(r.report)}));}

/** Convert a validated optional Lite owner desk once, without replaying books.
 * Call inside the caller's database transaction, after module initialization.
 * The original extension is retained unchanged; receipts and row fingerprints
 * prevent restarts, future books saves, and changed snapshots overwriting Full
 * Suite work. No login, permission grant, time row or financial posting is made.
 */
export function migrateOwnerDesk(db,state){
  initialize(db);const owner=currentOwner(db);resolveInitialOwner(db,owner);ensureDepartments(db,state);const reports=[];
  for(const c of state.companies){
    if(!c.desk)continue;const hash=digest(c.desk),prior=db.prepare('SELECT report FROM owner_desk_imports WHERE company=? AND digest=?').get(c.id,hash);if(prior){reports.push({companyId:c.id,digest:hash,duplicate:true,...JSON.parse(prior.report)});continue;}
    validateDesk(c);const d=c.desk,at=now(),report={sourceVersion:d.version,projects:0,tasks:0,staffing:0,contracts:0,departments:0,assets:null,conflicts:[]};
    const source=(kind,row)=>({sourceEdition:'Lite',sourceLiteId:row.id,sourceDigest:hash,sourceKind:kind});
    const accept=(kind,row,target)=>{
      const fingerprint=digest(row),old=db.prepare('SELECT * FROM owner_desk_rows WHERE company=? AND kind=? AND source=?').get(c.id,kind,row.id);
      if(old){if(old.fingerprint!==fingerprint)report.conflicts.push({kind,sourceId:row.id,targetId:old.target,reason:'The source changed after initial conversion; the Full Suite record was preserved.'});return false;}
      db.prepare('INSERT INTO owner_desk_rows VALUES(?,?,?,?,?)').run(c.id,kind,row.id,target,fingerprint);return true;
    };
    const department=label=>{
      const name=String(label||'Owner'),id='lite-dept-'+createHash('sha256').update(c.id+'\0'+name.toLocaleLowerCase('en-US')).digest('hex').slice(0,32);
      const existing=db.prepare('SELECT body FROM departments WHERE company=? AND id=?').get(c.id,id);
      if(!existing){const kind=/human|\bhr\b|people/i.test(name)?'HR':/finance|account/i.test(name)?'Finance':/legal/i.test(name)?'Legal':'Custom';db.prepare('INSERT INTO departments VALUES(?,?,?,1)').run(id,c.id,JSON.stringify({name:'Owner — '+name,kind,widgets:kind==='HR'?['onboarding','termination','tasks','records']:kind==='Finance'?['close-tasks','projects','tasks','records']:kind==='Legal'?['contracts','renewals','projects','tasks']:['projects','tasks','records'],sourceEdition:'Lite',sourceLiteId:name}));report.departments++;}
      return id;
    };
    const sourceProjects=new Map(d.projects.map(p=>[p.job,p]));
    const projectJobs=new Set([...d.projects.map(p=>p.job),...d.tasks.map(t=>t.job),...d.staffing.map(s=>s.job),...d.contracts.map(r=>r.job)].filter(Boolean));
    for(const jobId of projectJobs){
      const original=sourceProjects.get(jobId)||{id:'job-'+jobId,job:jobId,department:'Owner',status:'Active'},target=jobId;if(!accept('project',original,target))continue;
      if(db.prepare('SELECT 1 FROM project_workspaces WHERE company=? AND id=?').get(c.id,target)){report.conflicts.push({kind:'project',sourceId:original.id,targetId:target,reason:'An existing Full Suite project was preserved.'});continue;}
      const body={departmentId:department(original.department),leadId:owner,leadLabel:'Owner (from Lite)',...(!owner?{pendingOwner:true}:{}),visibility:'restricted',readers:[],status:status(original.status),created:at,updated:at,...source('project',original),sourceStatus:original.status};db.prepare('INSERT INTO project_workspaces VALUES(?,?,?,1)').run(target,c.id,JSON.stringify(body));report.projects++;
    }
    const projectDepartment=job=>{const r=db.prepare('SELECT body FROM project_workspaces WHERE company=? AND id=?').get(c.id,job);return r?JSON.parse(r.body).departmentId:department('Owner');};
    for(const original of d.contracts){
      const id=importedId(c.id,'contract',original.id);if(!accept('contract',original,id))continue;
      if(db.prepare('SELECT 1 FROM department_records WHERE id=?').get(id)){report.conflicts.push({kind:'contract',sourceId:original.id,targetId:id,reason:'An existing record was preserved.'});continue;}
      const departmentId=department('Legal records'),body={departmentId,kind:'contract',title:original.name,dueDate:original.renewal,status:status(original.status),contractStatus:original.status,ownerId:owner,ownerLabel:'Owner (from Lite)',...(!owner?{pendingOwner:true}:{}),restricted:true,readers:[],notes:original.notes||'',counterparty:original.counterparty,reference:original.reference,effectiveDate:original.effective,projectId:original.job||'',sourceStatus:original.status,created:at,updated:at,...source('contract',original)};
      db.prepare('INSERT INTO department_records VALUES(?,?,?,?,1)').run(id,c.id,departmentId,JSON.stringify(body));report.contracts++;
    }
    for(const original of d.tasks){
      const id=importedId(c.id,'task',original.id);if(!accept('task',original,id))continue;
      if(db.prepare('SELECT 1 FROM project_tasks WHERE id=?').get(id)||db.prepare('SELECT 1 FROM department_records WHERE id=?').get(id)){report.conflicts.push({kind:'task',sourceId:original.id,targetId:id,reason:'An existing task was preserved.'});continue;}
      if(!original.job){
        const kind=({'Onboarding':'onboarding','Termination':'termination','Close':'close-task'})[original.kind]||'record',departmentId=department(original.provenance?.sourceDepartment||(['onboarding','termination'].includes(kind)?'HR work':kind==='close-task'?'Finance work':'Company work'));
        const body={departmentId,kind,title:original.title,ownerId:owner,ownerLabel:'Owner (from Lite)',...(!owner?{pendingOwner:true}:{}),dueDate:original.due||'',status:status(original.status),restricted:true,readers:[],notes:original.notes||'',contractId:original.contract?importedId(c.id,'contract',original.contract):'',sourceStatus:original.status,sourceTaskKind:original.kind,created:at,updated:at,...source('task',original)};
        db.prepare('INSERT INTO department_records VALUES(?,?,?,?,1)').run(id,c.id,departmentId,JSON.stringify(body));report.tasks++;continue;
      }
      const departmentId=projectDepartment(original.job),body={projectId:original.job,departmentId,title:original.title,kind:taskKind(original.kind),ownerId:owner,ownerLabel:'Owner (from Lite)',...(!owner?{pendingOwner:true}:{}),dueDate:original.due,status:status(original.status),restricted:true,readers:[],notes:original.notes||'',contractId:original.contract?importedId(c.id,'contract',original.contract):'',sourceStatus:original.status,sourceTaskKind:original.kind,created:at,updated:at,...source('task',original)};
      db.prepare('INSERT INTO project_tasks VALUES(?,?,?,?,?,1)').run(id,c.id,original.job,departmentId,JSON.stringify(body));report.tasks++;
    }
    for(const original of d.staffing){
      const id=importedId(c.id,'staffing',original.id);if(!accept('staffing',original,id))continue;
      if(db.prepare('SELECT 1 FROM project_staffing WHERE id=?').get(id)){report.conflicts.push({kind:'staffing',sourceId:original.id,targetId:id,reason:'An existing staffing record was preserved.'});continue;}
      const firstTime=c.time.filter(t=>t.job===original.job&&t.employee===original.employee).map(t=>t.date).sort()[0],start=firstTime||c.history.find(h=>h.id===original.id)?.date||'';
      const body={employeeId:original.employee,start,end:'',...(!start?{sourceStartNotRecorded:true}:{}),role:'Owner-assigned staffing (from Lite)',plannedMinutes:original.plannedMinutes,created:at,...source('staffing',original)};db.prepare('INSERT INTO project_staffing VALUES(?,?,?,?,?,1)').run(id,c.id,original.job,original.employee,JSON.stringify(body));report.staffing++;
    }
    report.assets=migrateOwnerAssets(db,c,hash);db.prepare('INSERT INTO owner_desk_imports VALUES(?,?,?,?)').run(c.id,hash,at,JSON.stringify(report));db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(at,owner||'system',c.id,'Lite owner desk converted',JSON.stringify({digest:hash,projects:report.projects,tasks:report.tasks,contracts:report.contracts,staffing:report.staffing,conflicts:report.conflicts.length}));reports.push({companyId:c.id,digest:hash,...report});
  }
  return reports;
}
