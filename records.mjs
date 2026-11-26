import {randomUUID} from 'node:crypto';

const PROFILE_FIELDS = new Set(['hireDate','employmentStatus','department','title','location','workEmail','businessPhone','personalEmail','personalPhone','managerEmployeeId','managerAccountId','hrContactId','payrollContactId','groupIds','education','certifications','projectAssignments']);
const EMPLOYEE_EDITABLE = new Set(['businessPhone','personalEmail','personalPhone','education','certifications']);
const CORRECTABLE = new Set(['hireDate','department','title','location','workEmail','businessPhone','personalEmail','personalPhone','managerEmployeeId','education','certifications']);
const HISTORY_FIELDS = new Set(['hireDate','employmentStatus','department','title','location','managerEmployeeId','managerAccountId','groupIds','projectAssignments']);
const MANAGER_FIELDS = ['hireDate','employmentStatus','department','title','location','workEmail','businessPhone','managerEmployeeId','managerAccountId','education','certifications','projectAssignments','history','version'];
const defaults = () => ({hireDate:'',employmentStatus:'active',department:'',title:'',location:'',workEmail:'',businessPhone:'',personalEmail:'',personalPhone:'',managerEmployeeId:'',managerAccountId:'',hrContactId:'',payrollContactId:'',groupIds:[],education:[],certifications:[],projectAssignments:[],history:[]});
const check = (yes, message, status=400) => {if(!yes) throw Object.assign(new Error(message),{status});};
const today=()=>new Date().toISOString().slice(0,10);
const now=()=>new Date().toISOString();
const text=(v,max=500)=>{check(typeof v==='string'&&v.length<=max,'Invalid text value.');return v.trim();};
function date(v,optional=false){check((optional&&v==='')||(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v),'Enter a valid calendar date.');return v;}
const scoped=(user,company)=>user?.role==='owner'||user?.assignments?.includes(company);
const role=(user,company,roles)=>scoped(user,company)&&roles.includes(user?.role);
const hr=(user,company)=>role(user,company,['owner','hr']);
const payroll=(user,company)=>role(user,company,['owner','payroll']);
function log(db,user,company,kind,detail){db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(now(),typeof user==='string'?user:user.id,company,kind,detail);}
function person(state,company,employee){const book=state.companies.find(c=>c.id===company),employeeRow=book?.employees.find(e=>e.id===employee);check(book&&employeeRow,'Employee record unavailable.',404);return {book,person:employeeRow};}
function own(user,company,employee){return user?.role==='worker'&&user.assignments?.length===1&&user.assignments[0]===company&&user.employeeId===employee;}
function directManager(user,company,profile){return role(user,company,['manager'])&&(profile.managerAccountId===user.id||(!!user.employeeId&&profile.managerEmployeeId===user.employeeId));}
function mayReview(user,company,profile){return hr(user,company)||directManager(user,company,profile);}

export function initializeRecords(db){
  db.exec(`CREATE TABLE IF NOT EXISTS employee_records(company TEXT NOT NULL,employee TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(company,employee));
    CREATE TABLE IF NOT EXISTS employee_reviews(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,author TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,published TEXT,publisher TEXT,acknowledged TEXT,version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS employee_reviews_scope ON employee_reviews(company,employee,status);
    CREATE TABLE IF NOT EXISTS employee_paystubs(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,pay_date TEXT NOT NULL,source TEXT NOT NULL,filename TEXT NOT NULL,content BLOB NOT NULL,published TEXT NOT NULL,publisher TEXT NOT NULL,status TEXT NOT NULL CHECK(status='finalized'));
    CREATE INDEX IF NOT EXISTS employee_paystubs_scope ON employee_paystubs(company,employee,pay_date);
    CREATE TABLE IF NOT EXISTS employee_corrections(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested TEXT NOT NULL,requester TEXT NOT NULL,decided TEXT,decider TEXT,decision_reason TEXT);
    CREATE TABLE IF NOT EXISTS company_record_settings(company TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS employee_record_migrations(version INTEGER PRIMARY KEY,applied TEXT NOT NULL);
    INSERT OR IGNORE INTO employee_record_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
}

export function employeeProfile(db,state,company,employee){
  person(state,company,employee);
  const row=db.prepare('SELECT body,version FROM employee_records WHERE company=? AND employee=?').get(company,employee);
  const profile={...defaults(),...(row?JSON.parse(row.body):{}),version:row?.version||0};
  // Job changes can be future dated or entered after their effective date.
  // Project the effective values without deleting scheduled or superseded history.
  for(const field of HISTORY_FIELDS){
    const changes=profile.history.filter(h=>Object.hasOwn(h.changes||{},field));
    if(!changes.length)continue;
    profile[field]=structuredClone(changes[0].changes[field].before);
    for(const h of changes.slice().sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)||a.at.localeCompare(b.at)))if(h.effectiveDate<=today())profile[field]=structuredClone(h.changes[field].after);
  }
  return profile;
}

function validatedPatch(db,state,company,employee,patch){
  const {book}=person(state,company,employee);
  check(patch&&typeof patch==='object'&&!Array.isArray(patch),'Provide profile fields.');
  const out={};
  for(const [key,value] of Object.entries(patch)){
    check(PROFILE_FIELDS.has(key),'This profile field cannot be changed.');
    if(key==='hireDate'){out[key]=date(value,true);continue;}
    if(key==='employmentStatus'){check(['active','leave','inactive','disabled','deactivated','terminated'].includes(value),'Choose an employment status.');out[key]=value;continue;}
    if(key==='groupIds'){check(Array.isArray(value)&&value.length<=50&&value.every(v=>typeof v==='string'&&v.length>0&&v.length<=100)&&new Set(value).size===value.length,'Invalid benefit groups.');out[key]=value;continue;}
    if(key==='education'||key==='certifications'){
      check(Array.isArray(value)&&value.length<=50,'Use a list with at most 50 entries.');
      out[key]=value.map(entry=>typeof entry==='string'?text(entry,1000):(()=>{check(entry&&typeof entry==='object'&&!Array.isArray(entry),'Invalid credential.');const obj={};for(const [k,v] of Object.entries(entry)){check(['name','institution','issuer','issued','expires','description'].includes(k),'Invalid credential field.');obj[k]=['issued','expires'].includes(k)?date(v,true):text(v,1000);}check(obj.name,'Name the credential.');return obj;})());continue;
    }
    if(key==='projectAssignments'){
      check(Array.isArray(value)&&value.length<=100,'Invalid project assignments.');
      out[key]=value.map(p=>{check(p&&book.jobs.some(j=>j.id===p.jobId),'Select a project in this company.');const start=date(p.start||today()),end=date(p.end||'',true);check(!end||end>=start,'Project end precedes its start.');return {jobId:p.jobId,start,end,role:text(p.role||'',160)};});continue;
    }
    out[key]=text(value,key.includes('Email')?254:500);
    if(key.endsWith('Email'))check(!out[key]||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out[key]),'Enter a valid email address.');
    if(key==='managerEmployeeId')check(!value||(value!==employee&&book.employees.some(e=>e.id===value)),'Select another employee in this company as manager.');
    if(key==='managerAccountId'&&value){const account=db.prepare('SELECT role,assignments,active FROM accounts WHERE id=?').get(value);check(account&&account.active&&['manager','owner','hr'].includes(account.role)&&(account.role==='owner'||JSON.parse(account.assignments).includes(company)),'Select an active assigned manager account.');}
  }
  return out;
}

export function setEmployeeProfile(db,state,company,employee,patch,actorId,{effectiveDate=today(),reason='Profile update'}={}){
  date(effectiveDate);text(reason,500);
  const prior=employeeProfile(db,state,company,employee),clean=validatedPatch(db,state,company,employee,patch),changed=Object.keys(clean).filter(k=>JSON.stringify(prior[k])!==JSON.stringify(clean[k]));
  const profile={...prior,...clean};delete profile.version;
  if(changed.some(k=>HISTORY_FIELDS.has(k))){
    profile.history=[...prior.history,{at:now(),effectiveDate,actor:actorId,reason,changes:Object.fromEntries(changed.filter(k=>HISTORY_FIELDS.has(k)).map(k=>[k,{before:prior[k],after:clean[k]}]))}];
    check(profile.history.length<=10000,'Employee history requires archival.');
  }
  db.prepare('INSERT INTO employee_records(company,employee,body,version) VALUES(?,?,?,1) ON CONFLICT(company,employee) DO UPDATE SET body=excluded.body,version=employee_records.version+1').run(company,employee,JSON.stringify(profile));
  const effectiveProfile=employeeProfile(db,state,company,employee);
  if(['inactive','disabled','deactivated','terminated'].includes(effectiveProfile.employmentStatus)){
    // Retain account and original punches; increment authVersion invalidates active sessions.
    for(const row of db.prepare('SELECT id,assignments FROM accounts WHERE employeeId=? AND active=1').all(employee))if(JSON.parse(row.assignments).includes(company))db.prepare('UPDATE accounts SET active=0,authVersion=authVersion+1 WHERE id=?').run(row.id);
  }
  log(db,actorId,company,'employee profile updated',employee+' · '+changed.join(', '));
  return effectiveProfile;
}

function defaultRules(){return Object.fromEntries([...CORRECTABLE].map(k=>[k,EMPLOYEE_EDITABLE.has(k)?'edit':'request']));}
function settings(db,company){const row=db.prepare('SELECT body FROM company_record_settings WHERE company=?').get(company);return {contacts:[],locations:{},hrContactId:'',payrollContactId:'',fieldRules:defaultRules(),...(row?JSON.parse(row.body):{})};}
function contactById(config,id){return config.contacts.find(c=>c.id===id)||null;}
function contacts(db,state,company,employee,profile){
  const config=settings(db,company),location=config.locations[profile.location]||{};
  const manager=profile.managerEmployeeId?state.companies.find(c=>c.id===company)?.employees.find(e=>e.id===profile.managerEmployeeId):null;
  let managerContact=null;
  if(manager){const p=employeeProfile(db,state,company,manager.id);managerContact={name:manager.name,title:p.title,email:p.workEmail,phone:p.businessPhone};}
  if(!managerContact&&profile.managerAccountId){const row=db.prepare('SELECT name,employeeId,assignments FROM accounts WHERE id=? AND active=1').get(profile.managerAccountId);if(row){const p=row.employeeId&&JSON.parse(row.assignments).includes(company)&&state.companies.find(c=>c.id===company)?.employees.some(e=>e.id===row.employeeId)?employeeProfile(db,state,company,row.employeeId):{};managerContact={name:row.name,title:p.title||'',email:p.workEmail||'',phone:p.businessPhone||''};}}
  const fallback=ids=>ids.map(id=>contactById(config,id)).find(Boolean)||null;
  return {manager:managerContact,hr:fallback([profile.hrContactId,location.hrContactId,config.hrContactId]),payroll:fallback([profile.payrollContactId,location.payrollContactId,config.payrollContactId])};
}
function scopeTarget(db,user,state,action={}){
  const company=action.companyId||(user.role==='worker'?user.assignments[0]:''),employee=action.employeeId||(user.role==='worker'?user.employeeId:'');
  person(state,company,employee);check(scoped(user,company),'Employee record unavailable.',404);
  if(user.role==='worker')check(own(user,company,employee),'Employee record unavailable.',404);
  return {company,employee,profile:employeeProfile(db,state,company,employee)};
}
function reviewVisible(db,user,state,row){
  const profile=employeeProfile(db,state,row.company,row.employee);
  if(own(user,row.company,row.employee))return row.status==='published';
  if(row.status==='draft')return scoped(user,row.company)&&(user.role==='owner'||row.author===user.id&&mayReview(user,row.company,profile));
  return hr(user,row.company)||directManager(user,row.company,profile);
}
function reviewOutput(row){return {id:row.id,companyId:row.company,employeeId:row.employee,title:row.title,body:row.body,status:row.status,author:row.author,created:row.created,updated:row.updated,published:row.published,publisher:row.publisher,acknowledged:row.acknowledged,version:row.version};}
function stubOutput(row){return {id:row.id,companyId:row.company,employeeId:row.employee,periodStart:row.period_start,periodEnd:row.period_end,payDate:row.pay_date,source:row.source,filename:row.filename,published:row.published,publisher:row.publisher,status:row.status};}

export function recordsView(db,user,state,query={}){
  check(['owner','hr','payroll','manager','worker'].includes(user?.role),'Employee records access denied.',403);
  const employees=[];
  for(const company of state.companies.filter(c=>scoped(user,c.id)&&(!query.companyId||query.companyId===c.id))){
    for(const e of company.employees){
      if(query.employeeId&&e.id!==query.employeeId)continue;
      const p=employeeProfile(db,state,company.id,e.id),isOwn=own(user,company.id,e.id),isHR=hr(user,company.id),isManager=directManager(user,company.id,p),isPayroll=payroll(user,company.id);
      if(!isOwn&&!isHR&&!isManager&&!isPayroll)continue;
      const profile=isOwn||isHR?p:isManager?Object.fromEntries(MANAGER_FIELDS.map(k=>[k,k==='history'?p.history.map(h=>({...h,changes:Object.fromEntries(Object.entries(h.changes).filter(([field])=>MANAGER_FIELDS.includes(field)))})).filter(h=>Object.keys(h.changes).length):p[k]])):{employmentStatus:p.employmentStatus,department:p.department,title:p.title,version:p.version};
      const linked=isHR?db.prepare("SELECT id,username,hash,active,assignments FROM accounts WHERE employeeId=? AND role='worker'").all(e.id).find(a=>JSON.parse(a.assignments)[0]===company.id):null;
      employees.push({companyId:company.id,employeeId:e.id,name:e.name,profile,...(linked?{workerAccount:{id:linked.id,username:linked.username,configured:!!linked.hash&&!linked.hash.startsWith('!pending-invite:'),active:!!linked.active}}:{}),permissions:{editProfile:isHR,reviews:isOwn||isHR||isManager,paystubs:isOwn||isPayroll}});
    }
  }
  if(query.employeeId||user.role==='worker')check(employees.length>0,'Employee record unavailable.',404);
  const selected=employees.length===1?employees[0]:employees.find(e=>e.companyId===query.companyId&&e.employeeId===query.employeeId);
  const reviews=[],paystubs=[],corrections=[];
  for(const e of employees){
    if(e.permissions.reviews)for(const row of db.prepare('SELECT * FROM employee_reviews WHERE company=? AND employee=? ORDER BY created DESC,id').all(e.companyId,e.employeeId))if(reviewVisible(db,user,state,row))reviews.push(reviewOutput(row));
    if(e.permissions.paystubs)for(const row of db.prepare('SELECT id,company,employee,period_start,period_end,pay_date,source,filename,published,publisher,status FROM employee_paystubs WHERE company=? AND employee=? ORDER BY pay_date DESC,id').all(e.companyId,e.employeeId))paystubs.push(stubOutput(row));
    if(own(user,e.companyId,e.employeeId)||hr(user,e.companyId))corrections.push(...db.prepare('SELECT * FROM employee_corrections WHERE company=? AND employee=? ORDER BY requested DESC,id').all(e.companyId,e.employeeId).map(r=>({...r,value:JSON.parse(r.value)})));
  }
  for(const e of employees)if(e.permissions.paystubs||e.permissions.reviews)log(db,user,e.companyId,'employee records viewed',e.employeeId);
  const configCompany=selected?.companyId||query.companyId;
  const config=configCompany&&scoped(user,configCompany)?settings(db,configCompany):null;
  const managers=configCompany&&hr(user,configCompany)?db.prepare("SELECT id,name,role,assignments FROM accounts WHERE active=1 AND role IN ('owner','manager','hr') ORDER BY name").all().filter(a=>a.role==='owner'||JSON.parse(a.assignments).includes(configCompany)).map(({id,name})=>({id,name})):[];
  return {employees,employee:selected||null,reviews,paystubs,corrections,contacts:selected?contacts(db,state,selected.companyId,selected.employeeId,employeeProfile(db,state,selected.companyId,selected.employeeId)):null,jobs:selected?person(state,selected.companyId,selected.employeeId).book.jobs.map(({id,name})=>({id,name})):[],managers,fieldRules:config?.fieldRules||defaultRules(),settings:config&&hr(user,configCompany)?config:null};
}

export function recordsCommand(db,user,state,action){
  check(action&&typeof action.type==='string','Choose an employee records action.');
  if(action.type==='company-record-settings'){
    const company=action.companyId;check(state.companies.some(c=>c.id===company)&&hr(user,company),'HR access required.',403);
    const input=action.settings;check(input&&typeof input==='object','Provide company contact settings.');
    const clean={contacts:[],locations:{},hrContactId:text(input.hrContactId||'',100),payrollContactId:text(input.payrollContactId||'',100),fieldRules:defaultRules()};
    check(Array.isArray(input.contacts)&&input.contacts.length<=100,'Provide up to 100 business contacts.');
    clean.contacts=input.contacts.map(c=>({id:text(c.id||randomUUID(),100),name:text(c.name,160),title:text(c.title||'',160),email:text(c.email||'',254),phone:text(c.phone||'',100)}));
    check(clean.contacts.every(c=>c.name&&(!c.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)))&&new Set(clean.contacts.map(c=>c.id)).size===clean.contacts.length,'Check contact names and business emails.');
    for(const id of [clean.hrContactId,clean.payrollContactId])check(!id||clean.contacts.some(c=>c.id===id),'Select a configured contact.');
    for(const [location,ids] of Object.entries(input.locations||{})){text(location,160);check(Object.keys(ids).every(k=>['hrContactId','payrollContactId'].includes(k)),'Invalid location contacts.');clean.locations[location]={};for(const [k,id] of Object.entries(ids)){check(!id||clean.contacts.some(c=>c.id===id),'Select a configured location contact.');clean.locations[location][k]=id;}}
    for(const [field,ruleValue] of Object.entries(input.fieldRules||{})){check(CORRECTABLE.has(field)&&['view','request','edit'].includes(ruleValue),'Invalid profile field rule.');check(ruleValue!=='edit'||EMPLOYEE_EDITABLE.has(field),'Employment and access fields require HR review.');clean.fieldRules[field]=ruleValue;}
    db.prepare('INSERT INTO company_record_settings VALUES(?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body').run(company,JSON.stringify(clean));log(db,user,company,'employee settings updated','Business contacts and field rules');return {settings:clean};
  }
  if(['review-publish','review-acknowledge'].includes(action.type)){
    const row=db.prepare('SELECT * FROM employee_reviews WHERE id=?').get(String(action.reviewId));check(row&&scoped(user,row.company),'Review unavailable.',404);const p=employeeProfile(db,state,row.company,row.employee);
    if(action.type==='review-acknowledge'){check(own(user,row.company,row.employee)&&row.status==='published','Published review unavailable.',404);check(!row.acknowledged,'Review already acknowledged.',409);db.prepare('UPDATE employee_reviews SET acknowledged=?,version=version+1 WHERE id=?').run(now(),row.id);log(db,user,row.company,'review acknowledged',row.id);return {reviewId:row.id};}
    check(mayReview(user,row.company,p)&&(user.role==='owner'||row.author===user.id),'Review unavailable.',404);check(row.status==='draft','Review already published.',409);check(action.version===row.version,'Review changed. Refresh before publishing.',409);
    db.prepare("UPDATE employee_reviews SET status='published',published=?,publisher=?,updated=?,version=version+1 WHERE id=?").run(now(),user.id,now(),row.id);log(db,user,row.company,'review published',row.id);return {reviewId:row.id};
  }
  if(action.type==='correction-decide'){
    const row=db.prepare('SELECT * FROM employee_corrections WHERE id=?').get(String(action.correctionId));check(row&&hr(user,row.company),'Correction unavailable.',404);check(row.status==='pending','Correction already decided.',409);check(['approve','reject'].includes(action.decision),'Choose a decision.');const reason=text(action.reason||'',1000);check(reason,'Record a decision reason.');
    if(action.decision==='approve')setEmployeeProfile(db,state,row.company,row.employee,{[row.field]:JSON.parse(row.value)},user.id,{effectiveDate:action.effectiveDate||today(),reason});
    db.prepare('UPDATE employee_corrections SET status=?,decided=?,decider=?,decision_reason=? WHERE id=?').run(action.decision==='approve'?'approved':'rejected',now(),user.id,reason,row.id);log(db,user,row.company,'profile correction '+action.decision,row.id);return {correctionId:row.id};
  }
  const {company,employee,profile}=scopeTarget(db,user,state,action),isOwn=own(user,company,employee);
  if(action.type==='profile-update'){
    check(hr(user,company)||isOwn,'Profile edit access denied.',403);check(action.version===profile.version,'Profile changed. Refresh before saving.',409);
    const patch=validatedPatch(db,state,company,employee,action.patch);
    if(!hr(user,company)){const rules=settings(db,company).fieldRules;check(Object.keys(patch).every(k=>EMPLOYEE_EDITABLE.has(k)&&rules[k]==='edit'),'This field requires HR correction.',403);}
    const result=setEmployeeProfile(db,state,company,employee,patch,user.id,{effectiveDate:action.effectiveDate||today(),reason:action.reason||'Profile update'});return {profile:result};
  }
  if(action.type==='profile-correction'){
    check(isOwn,'Own employee profile required.',403);const field=action.field;check(CORRECTABLE.has(field)&&settings(db,company).fieldRules[field]==='request','This field does not accept correction requests.');const clean=validatedPatch(db,state,company,employee,{[field]:action.value}),reason=text(action.reason||'',1000);check(reason,'Explain the requested correction.');const id=randomUUID();
    db.prepare("INSERT INTO employee_corrections(id,company,employee,field,value,reason,status,requested,requester) VALUES(?,?,?,?,?,?,'pending',?,?)").run(id,company,employee,field,JSON.stringify(clean[field]),reason,now(),user.id);log(db,user,company,'profile correction submitted',id);return {correctionId:id};
  }
  if(action.type==='review-save'){
    check(mayReview(user,company,profile),'Assigned manager or HR access required.',403);const title=text(action.title,200),body=text(action.body,30000);check(title&&body,'Provide a review title and text.');
    const prior=action.reviewId?db.prepare('SELECT * FROM employee_reviews WHERE id=?').get(action.reviewId):null;
    if(action.reviewId){check(prior&&prior.company===company&&prior.employee===employee,'Review unavailable.',404);check(prior.status==='draft','Published reviews are immutable.',409);check(prior.author===user.id||user.role==='owner','Review unavailable.',404);check(action.version===prior.version,'Review changed. Refresh before saving.',409);}
    const id=prior?.id||randomUUID();if(prior)db.prepare('UPDATE employee_reviews SET title=?,body=?,updated=?,version=version+1 WHERE id=?').run(title,body,now(),id);else db.prepare("INSERT INTO employee_reviews(id,company,employee,title,body,status,author,created,updated,version) VALUES(?,?,?,?,?,'draft',?,?,?,1)").run(id,company,employee,title,body,user.id,now(),now());log(db,user,company,'review draft saved',id);return {reviewId:id};
  }
  if(action.type==='paystub-import'){
    check(payroll(user,company),'Payroll publishing access required.',403);check(action.finalized===true,'Confirm the source stub is finalized.');const periodStart=date(action.periodStart),periodEnd=date(action.periodEnd),payDate=date(action.payDate);check(periodEnd>=periodStart,'Pay period end precedes its start.');const source=text(action.source||'',500);check(source,'Identify the finalized payroll source.');
    check(typeof action.data==='string'&&action.data.length<=3*1024*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(action.data),'Provide a PDF of at most 2 MiB as base64.');const bytes=Buffer.from(action.data,'base64');check(bytes.length>8&&bytes.length<=2*1024*1024&&bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-1024).includes(Buffer.from('%%EOF')),'Import a valid finalized PDF paystub of at most 2 MiB.');
    const filename=text(action.filename||'paystub.pdf',160).replace(/[^a-zA-Z0-9._-]/g,'_');check(filename.toLowerCase().endsWith('.pdf'),'Paystub filename must end in .pdf.');const id=randomUUID();db.prepare("INSERT INTO employee_paystubs VALUES(?,?,?,?,?,?,?,?,?,?,?,'finalized')").run(id,company,employee,periodStart,periodEnd,payDate,source,filename,bytes,now(),user.id);log(db,user,company,'finalized paystub published',id);return {paystubId:id};
  }
  check(false,'Unknown employee records action.');
}

export function recordFile(db,user,state,id){
  const row=db.prepare('SELECT * FROM employee_paystubs WHERE id=?').get(String(id));
  check(row&&state.companies.some(c=>c.id===row.company&&c.employees.some(e=>e.id===row.employee))&&(own(user,row.company,row.employee)||payroll(user,row.company)),'Paystub unavailable.',404);
  log(db,user,row.company,'paystub downloaded',row.id);return {bytes:Buffer.from(row.content),mime:'application/pdf',filename:row.filename};
}
