import {randomUUID,createHash} from 'node:crypto';
import {employeeProfile} from './records.mjs';

// All dates below are employer-configured workflow dates, never legal eligibility rules.
const requireValue=(ok,message,status=400)=>{if(!ok)throw Object.assign(new Error(message),{status});};
const parse=raw=>JSON.parse(raw);
const stamp=()=>new Date().toISOString();
const isoDate=value=>{requireValue(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value,'Enter a valid calendar date.');return value;};
const text=(value,max=4000)=>{requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=max,'Enter text within the permitted length.');return value.trim();};
const arr=value=>{requireValue(Array.isArray(value)&&value.length<=300,'Invalid configuration list.');return value;};
const id=value=>{requireValue(typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value),'Invalid identifier.');return value;};
const addDays=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const int=(value,min=0,max=100000000)=>{requireValue(Number.isSafeInteger(value)&&value>=min&&value<=max,'Enter an integer within the permitted range.');return value;};
const percent=(value,max)=>{requireValue(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max&&Math.abs(value*100-Math.round(value*100))<1e-8,'Enter a permitted percentage with at most two decimal places.');return Math.round(value*100)/100;};
const localDay=(at,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const recordAudit=(db,user,company,kind,ref)=>db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(stamp(),user.id,company,kind,String(ref));
const hasCompany=(user,company)=>user?.role==='owner'||user?.assignments?.includes(company);
const isHR=(user,company)=>hasCompany(user,company)&&['owner','hr'].includes(user?.role);
const isPayroll=(user,company)=>hasCompany(user,company)&&['owner','hr','payroll'].includes(user?.role);
const disabled=profile=>['inactive','disabled','deactivated','terminated'].includes(profile.employmentStatus);

export function initializeBenefits(db){
  db.exec(`CREATE TABLE IF NOT EXISTS benefits_configuration(company TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollment_instances(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,source_key TEXT NOT NULL,plan_year TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,UNIQUE(company,employee,source_key));
    CREATE INDEX IF NOT EXISTS enrollment_person ON enrollment_instances(company,employee,plan_year);
    CREATE TABLE IF NOT EXISTS benefits_cases(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,owner_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS benefits_evidence(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES benefits_cases(id),name TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS retirement_changes(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,plan_id TEXT NOT NULL,status TEXT NOT NULL,effective_date TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS retirement_person ON retirement_changes(company,employee,plan_id,effective_date);
    CREATE TABLE IF NOT EXISTS payroll_deduction_instructions(id TEXT PRIMARY KEY,company TEXT NOT NULL,employee TEXT NOT NULL,change_id TEXT NOT NULL UNIQUE,plan_id TEXT NOT NULL,effective_date TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS employee_feature_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT OR IGNORE INTO employee_feature_migrations VALUES('benefits-v1',datetime('now'));`);
}

function companyFor(state,company){const c=state.companies.find(c=>c.id===company);requireValue(c,'Company unavailable.',404);return c;}
function personFor(state,company,employee){const c=companyFor(state,company),p=c.employees.find(p=>p.id===employee);requireValue(p,'Employee unavailable.',404);return {company:c,employee:p};}
function context(db,user,state,options={}){
  const company=user.role==='worker'?user.assignments?.[0]:options.companyId;
  requireValue(company&&hasCompany(user,company),'Company access denied.',403);
  companyFor(state,company);
  const employee=user.role==='worker'?user.employeeId:options.employeeId;
  if(user.role==='worker'){personFor(state,company,employee);requireValue(!disabled(employeeProfile(db,state,company,employee)),'Employee access is disabled.',403);}
  else requireValue(isPayroll(user,company),'Benefits access denied.',403);
  if(employee)personFor(state,company,employee);
  return {company,employee};
}
function defaultConfiguration(){return {timezone:'America/Denver',hrOwnerId:'',defaultInitial:{opensDays:0,closesDays:30},groups:[],planYears:[],plans:[],openWindows:[],individualOverrides:[],retirementPlans:[]};}
function config(db,company){const row=db.prepare('SELECT * FROM benefits_configuration WHERE company=?').get(company);return row?{...parse(row.body),version:row.version}: {...defaultConfiguration(),version:0};}
function optionalOwner(db,company,owner){
  if(!owner)return '';
  const row=db.prepare('SELECT id,role,active,assignments FROM accounts WHERE id=?').get(owner);
  requireValue(row&&row.active&&(row.role==='owner'||(row.role==='hr'&&parse(row.assignments).includes(company))),'Choose an active HR workflow owner assigned to this company.');return row.id;
}
function policy(value){return {opensDays:int(value?.opensDays??0,-365,365),closesDays:int(value?.closesDays??30,-365,730)};}
function normalizedConfiguration(db,state,company,value){
  requireValue(value&&typeof value==='object','Benefits configuration is required.');
  const result=defaultConfiguration();result.timezone=text(value.timezone||result.timezone,100);
  try{new Intl.DateTimeFormat('en-US',{timeZone:result.timezone}).format();}catch{requireValue(false,'Use a valid IANA company time zone.');}
  result.hrOwnerId=optionalOwner(db,company,value.hrOwnerId);result.defaultInitial=policy(value.defaultInitial);
  requireValue(result.defaultInitial.opensDays<=result.defaultInitial.closesDays,'Initial enrollment close must follow opening.');
  result.groups=arr(value.groups||[]).map(g=>{const initial=g.initial?policy(g.initial):null;requireValue(!initial||initial.opensDays<=initial.closesDays,'Group initial dates are reversed.');return {id:id(g.id),name:text(g.name,160),priority:int(g.priority,0,100000),...(initial?{initial}:{})};});
  const groupIds=result.groups.map(g=>g.id);requireValue(new Set(groupIds).size===groupIds.length,'Duplicate benefit group.');
  requireValue(new Set(result.groups.map(g=>g.priority)).size===result.groups.length,'Each group needs an explicit unique priority; the lower number applies first.');
  result.planYears=arr(value.planYears||[]).map(y=>({id:id(y.id),label:text(y.label||y.id,160),startDate:isoDate(y.startDate),endDate:isoDate(y.endDate)}));
  requireValue(new Set(result.planYears.map(y=>y.id)).size===result.planYears.length&&result.planYears.every(y=>y.startDate<=y.endDate),'Check plan year identifiers and dates.');
  const validYear=year=>{requireValue(result.planYears.some(y=>y.id===year),'Select a configured plan year.');return year;};
  const validGroups=groups=>arr(groups||[]).map(g=>{requireValue(groupIds.includes(g),'Select a configured benefit group.');return g;});
  result.plans=arr(value.plans||[]).map(p=>({id:id(p.id),planYear:validYear(p.planYear),category:text(p.category,100),name:text(p.name,160),groupIds:validGroups(p.groupIds),waiverAllowed:p.waiverAllowed!==false,hrOwnerId:optionalOwner(db,company,p.hrOwnerId),tiers:arr(p.tiers||[]).map(t=>({id:id(t.id),name:text(t.name,160),employeeCostCents:int(t.employeeCostCents??0),employerCostCents:int(t.employerCostCents??0)}))}));
  requireValue(new Set(result.plans.map(p=>p.id)).size===result.plans.length&&result.plans.every(p=>p.tiers.length&&new Set(p.tiers.map(t=>t.id)).size===p.tiers.length),'Check unique plan and tier identifiers.');
  result.openWindows=arr(value.openWindows||[]).map(w=>{requireValue(groupIds.includes(w.groupId),'Open enrollment needs an eligible group.');const row={id:id(w.id),planYear:validYear(w.planYear),groupId:w.groupId,startDate:isoDate(w.startDate),endDate:isoDate(w.endDate),effectiveDate:isoDate(w.effectiveDate)};requireValue(row.startDate<=row.endDate,'Open enrollment close must follow opening.');requireValue(row.effectiveDate>=result.planYears.find(y=>y.id===row.planYear).startDate&&row.effectiveDate<=result.planYears.find(y=>y.id===row.planYear).endDate,'Coverage effective date must be within its plan year.');return row;});
  requireValue(new Set(result.openWindows.map(w=>w.id)).size===result.openWindows.length&&new Set(result.openWindows.map(w=>w.planYear+'|'+w.groupId)).size===result.openWindows.length,'Configure one open enrollment window per group and plan year.');
  result.individualOverrides=arr(value.individualOverrides||[]).map(o=>{personFor(state,company,o.employeeId);const row={employeeId:o.employeeId,planYear:validYear(o.planYear),startDate:isoDate(o.startDate),endDate:isoDate(o.endDate),effectiveDate:isoDate(o.effectiveDate)},year=result.planYears.find(y=>y.id===row.planYear);requireValue(row.startDate<=row.endDate,'Individual override close must follow opening.');requireValue(row.effectiveDate>=year.startDate&&row.effectiveDate<=year.endDate,'Override coverage effective date must be within its plan year.');return row;});
  requireValue(new Set(result.individualOverrides.map(o=>o.employeeId+'|'+o.planYear)).size===result.individualOverrides.length,'Duplicate individual enrollment override.');
  result.retirementPlans=arr(value.retirementPlans||[]).map(p=>{
    requireValue(['firmquill','provider'].includes(p.control),'Select who controls the retirement setting.');
    const schedule=p.schedule||{};requireValue(['requested','next-month'].includes(schedule.effectiveRule||'requested'),'Choose an effective date rule.');requireValue(!schedule.opensOn||!schedule.closesOn||schedule.opensOn<=schedule.closesOn,'Retirement change schedule close must follow opening.');
    const taxTreatments=arr(p.taxTreatments||['pre-tax']),units=arr(p.units||['percent']);requireValue(taxTreatments.length&&taxTreatments.every(t=>['pre-tax','roth'].includes(t))&&units.length&&units.every(u=>['percent','amount'].includes(u)),'Choose permitted contribution settings.');
    return {id:id(p.id),name:text(p.name,160),groupIds:validGroups(p.groupIds),selfService:p.selfService===true,taxTreatments,units,control:p.control,maxPercent:int(p.maxPercent??100,0,100),maxAmountCents:int(p.maxAmountCents??1000000),providerLabel:String(p.providerLabel||'').slice(0,160),hrOwnerId:optionalOwner(db,company,p.hrOwnerId),schedule:{minimumLeadDays:int(schedule.minimumLeadDays??0,0,365),effectiveRule:schedule.effectiveRule||'requested',...(schedule.opensOn?{opensOn:isoDate(schedule.opensOn)}:{}),...(schedule.closesOn?{closesOn:isoDate(schedule.closesOn)}:{})}};
  });
  requireValue(new Set(result.retirementPlans.map(p=>p.id)).size===result.retirementPlans.length,'Duplicate retirement plan.');
  return result;
}
function visiblePlans(configuration,profile,year){return configuration.plans.filter(p=>p.planYear===year&&(!p.groupIds.length||p.groupIds.some(g=>(profile.groupIds||[]).includes(g))));}
function instanceRow(row){return row&&{id:row.id,companyId:row.company,employeeId:row.employee,planYear:row.plan_year,type:row.kind,status:row.status,...parse(row.body),version:row.version};}
function putInstance(db,row){const {id:rid,companyId,employeeId,sourceKey,planYear,type,status,version,...body}=row;db.prepare('INSERT INTO enrollment_instances VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body,version=excluded.version').run(rid,companyId,employeeId,sourceKey,planYear,type,status,JSON.stringify({...body,sourceKey}),version);}
function allInstances(db,company,employee){return db.prepare('SELECT * FROM enrollment_instances WHERE company=?'+(employee?' AND employee=?':'')+' ORDER BY plan_year,kind,id').all(company,...(employee?[employee]:[])).map(instanceRow);}
function materialize(db,state,company,employee,configuration){
  const profile=employeeProfile(db,state,company,employee);if(!profile.hireDate||disabled(profile))return;
  const groups=configuration.groups.filter(g=>(profile.groupIds||[]).includes(g.id)).sort((a,b)=>a.priority-b.priority);
  const candidates=[];
  for(const year of configuration.planYears){
    const override=configuration.individualOverrides.find(o=>o.employeeId===employee&&o.planYear===year.id);
    if(override||profile.hireDate>=year.startDate&&profile.hireDate<=year.endDate){
      const group=groups.find(g=>g.initial),rule=group?.initial||configuration.defaultInitial;
      candidates.push({sourceKey:'initial:'+year.id,planYear:year.id,type:'initial',label:year.label+' Initial Enrollment',startDate:override?.startDate||addDays(profile.hireDate,rule.opensDays),endDate:override?.endDate||addDays(profile.hireDate,rule.closesDays),effectiveDate:override?.effectiveDate||(profile.hireDate>year.startDate?profile.hireDate:year.startDate),coverageEndDate:year.endDate,ruleApplied:override?'Individual override':group?'Group '+group.name+' (priority '+group.priority+')':'Company default'});
    }
    const windows=configuration.openWindows.filter(w=>w.planYear===year.id&&groups.some(g=>g.id===w.groupId)).sort((a,b)=>groups.find(g=>g.id===a.groupId).priority-groups.find(g=>g.id===b.groupId).priority);
    if(windows.length){const w=windows[0],g=groups.find(g=>g.id===w.groupId);candidates.push({sourceKey:'open:'+year.id,planYear:year.id,type:'open',label:year.label+' Open Enrollment',startDate:w.startDate,endDate:w.endDate,effectiveDate:w.effectiveDate,coverageEndDate:year.endDate,ruleApplied:'Group '+g.name+' (priority '+g.priority+')',windowId:w.id});}
  }
  for(const candidate of candidates){
    const plans=visiblePlans(configuration,profile,candidate.planYear);if(!plans.length)continue;
    const old=instanceRow(db.prepare('SELECT * FROM enrollment_instances WHERE company=? AND employee=? AND source_key=?').get(company,employee,candidate.sourceKey));
    const body={...candidate,plans,elections:[],history:[],createdAt:stamp()};
    if(!old)putInstance(db,{...body,id:'en-'+createHash('sha256').update(company+'|'+employee+'|'+candidate.sourceKey).digest('hex').slice(0,40),companyId:company,employeeId:employee,status:'draft',version:1});
    else if(old.status==='draft'&&Object.entries({...candidate,plans}).some(([key,value])=>JSON.stringify(old[key])!==JSON.stringify(value))){
      const eligibleIds=new Set(plans.map(p=>p.id));
      putInstance(db,{...old,...candidate,plans,elections:old.elections.filter(e=>eligibleIds.has(e.planId)&&((e.waived&&plans.find(p=>p.id===e.planId).waiverAllowed)||plans.find(p=>p.id===e.planId).tiers.some(t=>t.id===e.tierId))),history:[...old.history,{at:stamp(),actor:'system',event:'Draft window and available offerings refreshed from employer configuration'}],version:old.version+1});
    }
    // Submitted snapshots are immutable and retain the exact elected offerings and rule.
  }
}
function instanceFor(db,user,state,rid){const row=instanceRow(db.prepare('SELECT * FROM enrollment_instances WHERE id=?').get(String(rid)));requireValue(row,'Enrollment unavailable.',404);const ctx=context(db,user,state,{companyId:row.companyId,employeeId:row.employeeId});requireValue(isHR(user,row.companyId)||(user.role==='worker'&&ctx.company===row.companyId&&ctx.employee===row.employeeId),'Enrollment unavailable.',404);return row;}
function versionCheck(row,version){requireValue(Number.isSafeInteger(version)&&row.version===version,'The record changed. Refresh before saving.',409);}
function enrollmentState(row,today){if(row.status==='draft')return today<row.startDate?'upcoming':today>row.endDate?'closed':'available';if(['submitted','conflict'].includes(row.status))return 'pending';if(row.status==='confirmed')return today<row.effectiveDate?'future':today>row.coverageEndDate?'past':'current';return row.status;}
function electionConflicts(db,row){
  const categories=new Set((row.elections||[]).map(e=>row.plans.find(p=>p.id===e.planId)?.category).filter(Boolean));
  return allInstances(db,row.companyId,row.employeeId).filter(other=>other.id!==row.id&&['submitted','confirmed','conflict'].includes(other.status)&&row.effectiveDate<=other.coverageEndDate&&other.effectiveDate<=row.coverageEndDate&&(other.elections||[]).some(e=>categories.has(other.plans.find(p=>p.id===e.planId)?.category))).map(other=>({id:other.id,label:other.label,status:other.status,effectiveDate:other.effectiveDate,coverageEndDate:other.coverageEndDate}));
}
function caseRow(row){return row&&{id:row.id,companyId:row.company,employeeId:row.employee,ownerId:row.owner_id,status:row.status,...parse(row.body),version:row.version};}
function saveCase(db,row){const {id:rid,companyId,employeeId,ownerId,status,version,...body}=row;db.prepare('INSERT INTO benefits_cases VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,status=excluded.status,body=excluded.body,version=excluded.version').run(rid,companyId,employeeId,ownerId,status,JSON.stringify(body),version);}
function caseFor(db,user,state,rid){const row=caseRow(db.prepare('SELECT * FROM benefits_cases WHERE id=?').get(String(rid)));requireValue(row,'Special enrollment case unavailable.',404);const ctx=context(db,user,state,{companyId:row.companyId,employeeId:row.employeeId});requireValue(user.role==='owner'||user.role==='worker'&&ctx.company===row.companyId&&ctx.employee===row.employeeId||user.role==='hr'&&row.ownerId===user.id,'Special enrollment case unavailable.',404);return row;}
function workflowOwner(db,configuration,profile,company){
  for(const candidate of [profile.hrContactId,configuration.hrOwnerId]){if(candidate){try{return optionalOwner(db,company,candidate);}catch{}}}
  const rows=db.prepare("SELECT id,role,active,assignments FROM accounts WHERE active=1 AND role IN ('owner','hr') ORDER BY CASE role WHEN 'hr' THEN 0 ELSE 1 END,id").all();
  return rows.find(r=>r.role==='owner'||parse(r.assignments).includes(company))?.id||'';
}
function addEvidence(db,caseId,attachments){
  const output=[];for(const attachment of arr(attachments||[])){
    requireValue(output.length<5,'Attach at most five files per message.');
    const name=text(attachment.name,160).replace(/[\\/\r\n]/g,'_'),mime=attachment.mime;
    requireValue(['application/pdf','image/png','image/jpeg','text/plain'].includes(mime),'Evidence supports PDF, PNG, JPEG or plain text.');
    requireValue(typeof attachment.data==='string'&&attachment.data.length<=2800000&&/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data),'Invalid evidence file.');
    const bytes=Buffer.from(attachment.data,'base64');requireValue(bytes.length>0&&bytes.length<=2*1024*1024,'Evidence file must be 1 byte to 2 MiB.');
    if(mime==='application/pdf')requireValue(bytes.subarray(0,5).toString()==='%PDF-','Invalid PDF evidence.');
    if(mime==='image/png')requireValue(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Invalid PNG evidence.');
    if(mime==='image/jpeg')requireValue(bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'Invalid JPEG evidence.');
    const fid='ev-'+randomUUID();db.prepare('INSERT INTO benefits_evidence VALUES(?,?,?,?,?)').run(fid,caseId,name,mime,bytes);output.push({id:fid,name,mime,size:bytes.length});
  }return output;
}
function retirementRow(row,today){const value=row&&{id:row.id,companyId:row.company,employeeId:row.employee,planId:row.plan_id,status:row.status,effectiveDate:row.effective_date,...parse(row.body),version:row.version};if(value&&today)value.displayStatus=value.status==='confirmed'?(today<value.effectiveDate?'future':'current'):value.status==='exported'?'pending provider confirmation':value.status;return value;}
function saveRetirement(db,row){const {id:rid,companyId,employeeId,planId,status,effectiveDate,version,displayStatus,...body}=row;db.prepare('INSERT INTO retirement_changes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,effective_date=excluded.effective_date,body=excluded.body,version=excluded.version').run(rid,companyId,employeeId,planId,status,effectiveDate,JSON.stringify(body),version);}

export function benefitsView(db,user,state,options={}){
  const {company,employee}=context(db,user,state,options),configuration=config(db,company),today=localDay(options.at||new Date(),configuration.timezone);
  if(employee&&user.role!=='payroll')materialize(db,state,company,employee,configuration);
  const instances=user.role==='payroll'?[]:allInstances(db,company,employee).map(row=>({...row,displayStatus:enrollmentState(row,today),conflicts:electionConflicts(db,row)}));
  const cases=user.role==='payroll'?[]:db.prepare('SELECT * FROM benefits_cases WHERE company=?'+(employee?' AND employee=?':'')+' ORDER BY rowid DESC').all(company,...(employee?[employee]:[])).map(caseRow).filter(c=>user.role==='owner'||user.role==='worker'&&c.employeeId===employee||c.ownerId===user.id);
  const profile=employee?employeeProfile(db,state,company,employee):null;
  const retirementPlans=configuration.retirementPlans.filter(p=>!profile||!p.groupIds.length||p.groupIds.some(g=>(profile.groupIds||[]).includes(g)));
  const retirementChanges=db.prepare('SELECT * FROM retirement_changes WHERE company=?'+(employee?' AND employee=?':'')+' ORDER BY effective_date DESC,rowid DESC').all(company,...(employee?[employee]:[])).map(row=>retirementRow(row,today));
  const deductions=isPayroll(user,company)?db.prepare('SELECT * FROM payroll_deduction_instructions WHERE company=?'+(employee?' AND employee=?':'')+' ORDER BY effective_date DESC').all(company,...(employee?[employee]:[])).map(row=>({...row,...parse(row.body),body:undefined})):[];
  if(instances.length||cases.length||retirementChanges.length)recordAudit(db,user,company,'benefits access',employee||'Company benefits queue');
  for(const row of retirementChanges.filter(r=>r.status==='confirmed'&&r.effectiveDate<=today))if(retirementChanges.some(later=>later.status==='confirmed'&&later.planId===row.planId&&later.employeeId===row.employeeId&&later.taxTreatment===row.taxTreatment&&later.effectiveDate<=today&&later.effectiveDate>row.effectiveDate))row.displayStatus='historical';
  const workflowOwners=isHR(user,company)?db.prepare("SELECT * FROM accounts WHERE active=1 AND role IN ('owner','hr') ORDER BY id").all().filter(r=>r.role==='owner'||parse(r.assignments).includes(company)).map(r=>({id:r.id,name:r.name||r.id})):[];
  const projected=user.role==='worker'?{timezone:configuration.timezone,version:configuration.version}:user.role==='payroll'?{timezone:configuration.timezone,version:configuration.version,retirementPlans}:configuration;
  return {configuration:projected,instances,cases,retirementPlans,retirementChanges,deductions,workflowOwners,conflicts:instances.flatMap(i=>i.conflicts.map(c=>({instanceId:i.id,label:i.label,...c}))),today};
}

export function benefitsCommand(db,user,state,action,at=new Date()){
  requireValue(action&&typeof action==='object','Benefit action is required.');
  if(action.type==='benefits-config'){
    const company=action.companyId;requireValue(isHR(user,company),'HR configuration access required.',403);companyFor(state,company);
    const previous=config(db,company);requireValue(action.version===previous.version,'The configuration changed. Refresh before saving.',409);
    const configuration=normalizedConfiguration(db,state,company,action.configuration);
    db.prepare('INSERT INTO benefits_configuration VALUES(?,?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body,version=excluded.version').run(company,JSON.stringify(configuration),previous.version+1);
    recordAudit(db,user,company,'benefits configuration','Plan and workflow settings updated');return {ok:true};
  }
  if(['enrollment-open','enrollment-save','enrollment-submit','enrollment-review'].includes(action.type)){
    if(action.type==='enrollment-open'){
      const {company,employee}=context(db,user,state,action);requireValue(employee&&user.role!=='payroll','Employee enrollment access required.',403);materialize(db,state,company,employee,config(db,company));
      const row=allInstances(db,company,employee).find(row=>row.planYear===action.planYear&&row.type===action.enrollmentType);requireValue(row,'No configured enrollment instance is available.',404);return {id:row.id};
    }
    const row=instanceFor(db,user,state,action.instanceId);versionCheck(row,action.version);
    const configuration=config(db,row.companyId),today=localDay(at,configuration.timezone);
    if(action.type==='enrollment-review'){
      requireValue(isHR(user,row.companyId),'HR review access required.',403);requireValue(['submitted','conflict'].includes(row.status),'Only submitted elections can be reviewed.',409);requireValue(['confirm','reject'].includes(action.decision),'Choose confirm or reject.');
      const reason=text(action.reason,2000),conflicts=electionConflicts(db,row);
      requireValue(action.decision!=='confirm'||!conflicts.length||action.resolveConflict===true,'Coverage periods conflict. Review the other elections and explicitly resolve the conflict.',409);
      if(action.decision==='confirm'&&conflicts.length){for(const conflict of conflicts){const previous=instanceRow(db.prepare('SELECT * FROM enrollment_instances WHERE id=?').get(conflict.id));previous.status='superseded';previous.history.push({at:at.toISOString(),actor:user.id,event:'Superseded after explicit HR conflict review',replacementId:row.id,reason});previous.version++;putInstance(db,previous);}}
      row.status=action.decision==='confirm'?'confirmed':'rejected';row.history.push({at:at.toISOString(),actor:user.id,event:row.status,reason,resolvedConflicts:conflicts.map(c=>c.id)});row.version++;putInstance(db,row);recordAudit(db,user,row.companyId,'benefits decision',row.id);return {id:row.id};
    }
    requireValue(user.role==='worker'&&user.employeeId===row.employeeId&&user.assignments[0]===row.companyId,'Only the employee may elect benefits.',403);
    requireValue(row.status==='draft','Submitted elections are immutable. Request an HR correction.',409);requireValue(today>=row.startDate&&today<=row.endDate,'This enrollment instance is outside its election window.',409);
    const eligible=visiblePlans(configuration,employeeProfile(db,state,row.companyId,row.employeeId),row.planYear);requireValue(row.plans.every(p=>eligible.some(e=>e.id===p.id)),'Plan eligibility changed. Ask HR to review this enrollment instance.',409);
    const elections=arr(action.elections||[]).map(e=>{const plan=row.plans.find(p=>p.id===e.planId);requireValue(plan,'Select a plan offered by this enrollment instance.');const waived=e.waived===true;requireValue(!waived||plan.waiverAllowed,'This plan does not permit a waiver.');requireValue(waived||plan.tiers.some(t=>t.id===e.tierId),'Select a configured coverage tier.');return {planId:plan.id,waived,tierId:waived?'':e.tierId};});
    requireValue(new Set(elections.map(e=>e.planId)).size===elections.length,'Select each plan once.');row.elections=elections;
    if(action.type==='enrollment-submit'){
      requireValue(row.plans.every(p=>elections.some(e=>e.planId===p.id)),'Elect or waive each offered plan before submitting.');
      const conflicts=electionConflicts(db,row);row.status=conflicts.length?'conflict':'submitted';row.receipt='FQ-'+randomUUID();row.submittedAt=at.toISOString();row.history.push({at:at.toISOString(),actor:user.id,event:'submitted',receipt:row.receipt,conflictIds:conflicts.map(c=>c.id)});
    }else row.history.push({at:at.toISOString(),actor:user.id,event:'draft saved'});
    row.version++;putInstance(db,row);recordAudit(db,user,row.companyId,action.type,row.id);return {id:row.id,receipt:row.receipt||null};
  }
  if(action.type==='special-request'){
    const {company,employee}=context(db,user,state,action);requireValue(user.role==='worker','Employee access required.',403);
    const configuration=config(db,company),profile=employeeProfile(db,state,company,employee),ownerId=workflowOwner(db,configuration,profile,company);
    requireValue(ownerId,'Ask an administrator to assign an HR workflow contact before sending this request.',409);
    const event=text(action.event,160),eventDate=isoDate(action.eventDate),requestedChange=text(action.requestedChange),today=localDay(at,configuration.timezone);requireValue(eventDate<=today,'Event date cannot be in the future.');
    const row={id:'case-'+randomUUID(),companyId:company,employeeId:employee,ownerId,status:'received',event,eventDate,requestedChange,createdAt:at.toISOString(),receipt:'FQ-'+randomUUID(),attachments:[],history:[{at:at.toISOString(),actor:user.id,event:'received in assigned HR queue'}],version:1};
    saveCase(db,row);row.attachments=addEvidence(db,row.id,action.attachments);saveCase(db,row);recordAudit(db,user,company,'special enrollment received',row.id);return {id:row.id,receipt:row.receipt};
  }
  if(['special-update','special-review'].includes(action.type)){
    const row=caseFor(db,user,state,action.caseId);versionCheck(row,action.version);requireValue(!['approved','denied'].includes(row.status),'Case has already been decided.',409);
    if(action.type==='special-update'){
      requireValue(user.role==='worker'&&row.employeeId===user.employeeId,'Employee response access required.',403);const message=text(action.message);row.attachments.push(...addEvidence(db,row.id,action.attachments));requireValue(row.attachments.length<=20,'Case attachment limit reached.');row.status='received';row.history.push({at:at.toISOString(),actor:user.id,event:'Employee response',message});
    }else{
      requireValue(isHR(user,row.companyId),'HR review access required.',403);requireValue(['information_requested','approved','denied'].includes(action.status),'Choose the case status.');
      const reason=text(action.reason),configuration=config(db,row.companyId),today=localDay(at,configuration.timezone);row.status=action.status;
      if(action.status==='approved'){
        const year=configuration.planYears.find(y=>y.id===action.planYear);requireValue(year,'Choose a plan year for the approved adjustment.');
        row.deadline=isoDate(action.deadline);row.effectiveDate=isoDate(action.effectiveDate);requireValue(row.deadline>=today&&row.effectiveDate>=year.startDate&&row.effectiveDate<=year.endDate,'Check the approved deadline and effective date.');
        const plans=visiblePlans(configuration,employeeProfile(db,state,row.companyId,row.employeeId),year.id);requireValue(plans.length,'No eligible plans are configured for this employee.');
        const enrollment={id:'en-'+randomUUID(),companyId:row.companyId,employeeId:row.employeeId,sourceKey:'special:'+row.id,planYear:year.id,type:'special',status:'draft',label:year.label+' Special Enrollment',caseId:row.id,startDate:today,endDate:row.deadline,effectiveDate:row.effectiveDate,coverageEndDate:year.endDate,ruleApplied:'HR case decision '+row.id,plans,elections:[],history:[],createdAt:at.toISOString(),version:1};putInstance(db,enrollment);row.instanceId=enrollment.id;
      }
      row.history.push({at:at.toISOString(),actor:user.id,event:action.status,reason,deadline:row.deadline||null,effectiveDate:row.effectiveDate||null});
    }
    row.version++;saveCase(db,row);recordAudit(db,user,row.companyId,'special enrollment update',row.id);return {id:row.id};
  }
  if(action.type==='retirement-change'){
    const {company,employee}=context(db,user,state,action);requireValue(user.role==='worker','Employee access required.',403);const configuration=config(db,company),profile=employeeProfile(db,state,company,employee),plan=configuration.retirementPlans.find(p=>p.id===action.planId);
    requireValue(plan&&plan.selfService&&(!plan.groupIds.length||plan.groupIds.some(g=>(profile.groupIds||[]).includes(g))),'Self-service is unavailable for this plan.',403);
    const today=localDay(at,configuration.timezone),schedule=plan.schedule;requireValue((!schedule.opensOn||today>=schedule.opensOn)&&(!schedule.closesOn||today<=schedule.closesOn),'The retirement plan is outside its own change schedule.',409);
    requireValue(plan.taxTreatments.includes(action.taxTreatment)&&plan.units.includes(action.unit),'Select a permitted contribution setting.');
    const value=action.unit==='percent'?percent(action.value,plan.maxPercent):int(action.value,0,plan.maxAmountCents);let effectiveDate=isoDate(action.effectiveDate);
    requireValue(effectiveDate>=addDays(today,schedule.minimumLeadDays),'Effective date is earlier than the plan permits.');
    if(schedule.effectiveRule==='next-month'){const [year,month]=today.split('-').map(Number),minimum=new Date(Date.UTC(year,month,1,12)).toISOString().slice(0,10);requireValue(effectiveDate>=minimum&&effectiveDate.endsWith('-01'),'This plan requires the first of a future month.');}
    const c=companyFor(state,company);requireValue(!c.closedThrough||effectiveDate>c.closedThrough,'Effective date belongs to closed payroll/books.',409);
    const row={id:'ret-'+randomUUID(),companyId:company,employeeId:employee,planId:plan.id,status:'pending',effectiveDate,planName:plan.name,control:plan.control,taxTreatment:action.taxTreatment,unit:action.unit,value,receipt:'FQ-'+randomUUID(),submittedAt:at.toISOString(),history:[{at:at.toISOString(),actor:user.id,event:'Change received; pending '+(plan.control==='provider'?'provider confirmation':'payroll review')}],version:1};saveRetirement(db,row);recordAudit(db,user,company,'retirement request',row.id);return {id:row.id,receipt:row.receipt};
  }
  if(action.type==='retirement-review'){
    const row=retirementRow(db.prepare('SELECT * FROM retirement_changes WHERE id=?').get(String(action.changeId)));requireValue(row,'Retirement request unavailable.',404);requireValue(isPayroll(user,row.companyId),'Payroll review access required.',403);versionCheck(row,action.version);requireValue(['pending','exported'].includes(row.status),'Request is already decided.',409);requireValue(['confirm','reject','export'].includes(action.decision),'Choose a review decision.');
    const reason=text(action.reason,2000);if(action.effectiveDate)row.effectiveDate=isoDate(action.effectiveDate);const c=companyFor(state,row.companyId);requireValue(!c.closedThrough||row.effectiveDate>c.closedThrough,'Cannot change closed payroll/books.',409);
    if(action.decision==='export'){
      row.status='exported';row.history.push({at:at.toISOString(),actor:user.id,event:'Exported for provider/payroll handoff; awaiting confirmation',reason});row.version++;saveRetirement(db,row);recordAudit(db,user,row.companyId,'retirement handoff',row.id);
      const fields=['request_id','employee_id','plan_id','tax_treatment','unit','value','effective_date'],values=[row.id,row.employeeId,row.planId,row.taxTreatment,row.unit,row.value,row.effectiveDate],csv=fields.join(',')+'\r\n'+values.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')+'\r\n';
      return {id:row.id,export:{filename:'FirmQuill-retirement-'+row.id+'.csv',mime:'text/csv',data:Buffer.from(csv).toString('base64')}};
    }
    const peers=db.prepare("SELECT * FROM retirement_changes WHERE company=? AND employee=? AND plan_id=? AND id<>? AND status='confirmed' AND effective_date=?").all(row.companyId,row.employeeId,row.planId,row.id,row.effectiveDate).filter(p=>parse(p.body).taxTreatment===row.taxTreatment);
    requireValue(action.decision!=='confirm'||!peers.length||action.resolveConflict===true,'Another confirmed election has this effective date. Explicit HR/payroll conflict review is required.',409);
    if(action.decision==='confirm'){
      for(const prior of peers){const previous=retirementRow(prior);previous.status='superseded';previous.history.push({at:at.toISOString(),actor:user.id,event:'Superseded after explicit conflict review',reason,replacementId:row.id});previous.version++;saveRetirement(db,previous);db.prepare("UPDATE payroll_deduction_instructions SET status='superseded' WHERE change_id=?").run(previous.id);}
      row.status='confirmed';row.confirmedAt=at.toISOString();row.confirmedBy=user.id;
      if(row.control==='firmquill'){
        const instruction={taxTreatment:row.taxTreatment,unit:row.unit,value:row.value,planName:row.planName,receipt:row.receipt,source:'Confirmed employee election',appliedToClosedPayroll:false};
        db.prepare('INSERT INTO payroll_deduction_instructions VALUES(?,?,?,?,?,?,?,?)').run('ded-'+randomUUID(),row.companyId,row.employeeId,row.id,row.planId,row.effectiveDate,'ready',JSON.stringify(instruction));
      }
    }else row.status='rejected';
    row.history.push({at:at.toISOString(),actor:user.id,event:row.status+(row.control==='provider'&&row.status==='confirmed'?' by recorded provider confirmation':''),reason});row.version++;saveRetirement(db,row);recordAudit(db,user,row.companyId,'retirement decision',row.id);return {id:row.id};
  }
  requireValue(false,'Unknown benefits action.');
}

export function benefitFile(db,user,state,fileId){
  const file=db.prepare('SELECT * FROM benefits_evidence WHERE id=?').get(String(fileId));requireValue(file,'File unavailable.',404);const row=caseFor(db,user,state,file.case_id);
  recordAudit(db,user,row.companyId,'benefits evidence access',file.id);return {bytes:Buffer.from(file.bytes),mime:file.mime,filename:file.name};
}

// Read-only payroll bridge. The existing worksheet asks for taxable wages; these
// instructions are displayed/exported for payroll and never rewrite closed payroll.
export function effectivePayrollDeductions(db,user,state,companyId,payDate){
  requireValue(isPayroll(user,companyId),'Payroll access required.',403);companyFor(state,companyId);isoDate(payDate);
  const rows=db.prepare("SELECT * FROM payroll_deduction_instructions WHERE company=? AND effective_date<=? AND status='ready' ORDER BY effective_date DESC,rowid DESC").all(companyId,payDate),seen=new Set();
  return rows.filter(r=>{const key=r.employee+'|'+r.plan_id+'|'+parse(r.body).taxTreatment;if(seen.has(key))return false;seen.add(key);return true;}).map(r=>({...r,...parse(r.body),body:undefined}));
}
