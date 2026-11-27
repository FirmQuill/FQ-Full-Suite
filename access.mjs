import {randomUUID} from 'node:crypto';

export const DEFAULT_ERP_AREAS=['Overview','Directory','Sales','Purchasing','Jobs & time','Warehouse','Assembly','Fixed assets','Accounting','Banking','Reports','Payroll','History','Company setup','Approvals','Audit trail','Employee records','Benefits administration','Identity connectors'];
export const ERP_AREAS=[...DEFAULT_ERP_AREAS,'Drives','Messages','Company knowledge'];
const DEFAULT_WORKER_FEATURES=['Time','Pay','Reviews','Benefits','My Profile','Contacts'];
export const WORKER_FEATURES=[...DEFAULT_WORKER_FEATURES,'Time off','Company knowledge','Messages','Drives'];
const fail=(ok,message,status=403)=>{if(!ok)throw Object.assign(Error(message),{status});};
export function initializeAccess(db){
  db.exec(`CREATE TABLE IF NOT EXISTS account_grants(account_id TEXT PRIMARY KEY REFERENCES accounts(id),areas TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS employee_erp_flags(company TEXT NOT NULL,employee TEXT NOT NULL,enabled INTEGER NOT NULL,areas TEXT NOT NULL,PRIMARY KEY(company,employee));
    CREATE TABLE IF NOT EXISTS employee_portal_flags(company TEXT NOT NULL,employee TEXT NOT NULL,features TEXT NOT NULL,PRIMARY KEY(company,employee));`);
  // Preserve the scope of existing ERP accounts during an upgrade.
  for(const r of db.prepare("SELECT id,employeeId,assignments,active FROM accounts WHERE role NOT IN ('worker','owner')").all()){
    db.prepare('INSERT OR IGNORE INTO account_grants VALUES(?,?)').run(r.id,JSON.stringify(DEFAULT_ERP_AREAS));
    const companies=JSON.parse(r.assignments);
    if(r.employeeId&&companies.length===1)db.prepare('INSERT OR IGNORE INTO employee_erp_flags VALUES(?,?,?,?)').run(companies[0],r.employeeId,r.active,db.prepare('SELECT areas FROM account_grants WHERE account_id=?').get(r.id).areas);
  }
}
export function workerFeatures(db,user){const r=db.prepare('SELECT features FROM employee_portal_flags WHERE company=? AND employee=?').get(user.assignments[0],user.employeeId);return r?JSON.parse(r.features):DEFAULT_WORKER_FEATURES;}
export function requireWorkerFeature(db,user,feature){if(user.role==='worker')fail(workerFeatures(db,user).includes(feature),'This feature is not enabled for your employee account.');}
export function workerRecords(db,user,records){
  const features=workerFeatures(db,user),out={...records};
  if(!features.includes('Pay'))out.paystubs=[];
  if(!features.includes('Reviews'))out.reviews=[];
  if(!features.includes('Contacts'))out.contacts={};
  if(!features.includes('Benefits')){
    const clean=e=>{if(!e)return e;const profile={...e.profile};delete profile.groupIds;profile.history=(profile.history||[]).map(h=>({...h,changes:Object.fromEntries(Object.entries(h.changes||{}).filter(([k])=>k!=='groupIds'))})).filter(h=>Object.keys(h.changes).length);return {...e,profile};};
    out.employees=(out.employees||[]).map(clean);out.employee=clean(out.employee);
  }
  if(!features.includes('My Profile')){out.employees=[];out.employee=null;out.corrections=[];out.jobs=[];out.fieldRules={};}
  return out;
}
export function ensureWorkerAccounts(db,state){
  for(const c of state.companies)for(const e of c.employees){
    const exists=db.prepare("SELECT id FROM accounts WHERE role='worker' AND employeeId=? AND assignments=? LIMIT 1").get(e.id,JSON.stringify([c.id]));
    if(!exists){
      const id=randomUUID();
      db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)').run(id,'employee-'+id,e.name,'worker',JSON.stringify([c.id]),e.id,1,'',1);
      db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),'system',c.id,'worker account provisioned',id);
    }
  }
}
export function accountAreas(db,user){
  if(user.role==='owner')return ERP_AREAS;
  if(user.role==='worker')return [];
  const r=db.prepare('SELECT areas FROM account_grants WHERE account_id=?').get(user.id);
  const granted=r?JSON.parse(r.areas):[],account=db.prepare('SELECT employeeId,assignments FROM accounts WHERE id=?').get(user.id);
  if(account?.employeeId){const companies=JSON.parse(account.assignments),flag=db.prepare('SELECT enabled,areas FROM employee_erp_flags WHERE company=? AND employee=?').get(companies[0],account.employeeId);return flag?.enabled?granted.filter(a=>JSON.parse(flag.areas).includes(a)):[];}
  return granted;
}
export function requireArea(db,user,area){fail(user.role==='owner'||accountAreas(db,user).includes(area),'This ERP area is not enabled for your account.');}
export function saveAreas(db,id,areas){
  fail(Array.isArray(areas)&&new Set(areas).size===areas.length&&areas.every(a=>ERP_AREAS.includes(a)),'Choose valid ERP areas.',400);
  db.prepare('INSERT INTO account_grants VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET areas=excluded.areas').run(id,JSON.stringify(areas));
}
const actionAreas={company:'Company setup',settings:'Company setup',contact:'Directory',item:'Directory',job:'Jobs & time',employee:'Employee records',time:'Jobs & time','approve time':'Jobs & time','job expense':'Jobs & time',quote:'Sales','sales order':'Sales',invoice:'Sales',collection:'Sales','sales credit':'Sales','purchase order':'Purchasing',bill:'Purchasing',payment:'Purchasing','purchase credit':'Purchasing',transfer:'Warehouse',adjust:'Warehouse','adjust in':'Warehouse','adjust out':'Warehouse',assemble:'Assembly',asset:'Fixed assets',depreciate:'Fixed assets',journal:'Accounting','reverse journal':'Accounting',close:'Accounting',bank:'Banking','bank match':'Banking','bank unmatch':'Banking','bank reconciliation':'Banking',group:'Reports',intercompany:'Accounting',attachment:'Directory'};
export function requireActionArea(db,user,action){if(user.role==='owner')return;requireArea(db,user,actionAreas[action?.type]||'Accounting');}
Object.assign(actionAreas,{fulfillment:'Sales',receiving:'Purchasing','vendor credit':'Purchasing','statement import':'Banking',match:'Banking',reconcile:'Banking'});
export function projectErpState(db,user,state){
  if(user.role==='owner')return state;
  const areas=accountAreas(db,user),has=(...names)=>names.some(n=>areas.includes(n));
  return {...state,groups:has('Reports')?state.groups:[],companies:state.companies.map(c=>{
    const out={...c};
    // Imported single-owner desk details remain private until converted into scoped workspace records.
    delete out.desk;
    delete out.manualPayroll;
    if(!has('Directory','Sales','Purchasing','Accounting','Banking','Reports'))out.parties=[];
    else if(!has('Directory','Accounting','Banking','Reports'))out.parties=out.parties.filter(p=>has('Sales')&&p.kind==='Customer'||has('Purchasing')&&p.kind==='Vendor');
    if(!has('Directory','Sales','Purchasing','Warehouse','Assembly','Reports'))out.items=[];
    if(!has('Jobs & time','Sales','Purchasing','Reports','Employee records'))out.jobs=[];
    if(!has('Employee records','Jobs & time','Payroll'))out.employees=[];
    if(!has('Payroll'))out.employees=out.employees.map(({id,name,state,locality})=>({id,name,state,locality}));
    if(!has('Jobs & time','Payroll','Reports'))out.time=[];
    else if(!has('Payroll','Reports'))out.time=out.time.map(({rate,cost,...t})=>t);
    if(!has('Sales','Purchasing','Reports'))out.docs=[];
    else if(!has('Reports'))out.docs=out.docs.filter(d=>has('Sales')&&['quote','sales order','fulfillment','invoice','collection','sales credit'].includes(d.kind)||has('Purchasing')&&['purchase order','receiving','bill','payment','vendor credit'].includes(d.kind));
    if(!has('Warehouse','Assembly','Reports'))out.moves=[];
    if(!has('Accounting','Banking','Reports'))out.entries=[];
    if(!has('Fixed assets','Reports'))out.assets=[];
    if(!has('Banking','Reports')){out.bank=[];out.reconciliations=[];}
    // Portable history can contain embedded financial operations and documents.
    const references=new Set([...out.entries,...out.moves,...out.assets,...out.docs,...out.time,...out.parties,...out.items,...out.jobs,...out.employees].flatMap(r=>[r.id,r.source,r.parent,r.approval]).filter(Boolean));
    out.history=out.history.filter(e=>references.has(e.id)||has('History')||has(actionAreas[e.kind]||'Accounting')).map(({id,number,kind,date,label,at,type})=>({id,number,kind,date,label,at,type}));
    out.attachments=has('Directory')?out.attachments.filter(a=>references.has(a.source)):[];
    return out;
  })};
}
