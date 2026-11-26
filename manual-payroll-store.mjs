import {requireArea} from './access.mjs';
import {emptyManualPayroll,manualPaystubPdf,manualPayrollCommand,validateManualPayroll} from './shared/manual-payroll.mjs';
import {randomUUID} from 'node:crypto';
const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
export function initializeManualPayroll(db){
  db.exec(`CREATE TABLE IF NOT EXISTS manual_payroll(company_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS manual_payroll_published(company_id TEXT NOT NULL, run_id TEXT NOT NULL, stub_id TEXT NOT NULL, PRIMARY KEY(company_id, run_id));`);
}
function scopedCompany(db,user,state,companyId){
  fail(user?.role==='owner'||user?.role==='payroll','Only the owner or assigned payroll staff can open manual payroll.',403);
  requireArea(db,user,'Payroll');
  const c=state.companies.find(c=>c.id===companyId&&(user.role==='owner'||user.assignments.includes(c.id)));
  fail(c,'Payroll company is not assigned.',404);return c;
}
const current=(db,c)=>{const row=db.prepare('SELECT body FROM manual_payroll WHERE company_id=?').get(c.id);return row?JSON.parse(row.body):c.manualPayroll??emptyManualPayroll();};
export function manualPayrollPortableState(db,state){
  return {...state,companies:state.companies.map(c=>{
    const data=current(db,c);
    if(!data.revision)return c;
    validateManualPayroll(data,c);
    const portable=structuredClone(data);
    for(const d of portable.drafts)d.savedBy='prior authorized payroll operator';
    for(const r of portable.runs)r.finalizedBy='prior authorized payroll operator';
    return {...c,manualPayroll:portable};
  })};
}
const output=(c,data)=>({employees:c.employees.map(({id,name})=>({id,name})),data});
function approvedTime(c,{employee,start,end}){
  const rows=c.time.filter(t=>t.approved===true&&t.employee===employee&&t.date>=start&&t.date<=end).sort((a,b)=>a.id.localeCompare(b.id));
  fail(rows.length,'There are no approved time entries for the selected employee and dates.');
  const cents=rows.reduce((n,t)=>n+t.cost,0),minutes=rows.reduce((n,t)=>n+t.minutes,0);
  fail(Number.isSafeInteger(cents)&&cents>=0&&Number.isSafeInteger(minutes)&&minutes>=0,'Approved time totals are outside the supported range.');
  return {minutes,count:rows.length,cents,entries:rows.map(({id,date,minutes,rate,cost,approval})=>({id,date,minutes,rate,cost,approval}))};
}
export function manualPayrollView(db,user,state,companyId){
  const c=scopedCompany(db,user,state,companyId);
  return output(c,current(db,c));
}
export function manualPayrollStoreCommand(db,user,state,companyId,input){
  const c=scopedCompany(db,user,state,companyId),data=current(db,c),a={...input};
  delete a.timeSource;
  if(a.type==='draft'&&a.fromApprovedTime){a.timeSource=approvedTime(c,a);a.regular=a.timeSource.cents;}
  if(a.type==='finalize'&&!data.runs.some(r=>r.id===a.id)){
    const draft=data.drafts.find(d=>d.id===a.id);
    if(draft?.timeSource){
      const actual=approvedTime(c,draft.input);
      fail(JSON.stringify(draft.timeSource)===JSON.stringify(actual),'Approved time changed. Recalculate the draft before finalizing.',409);
    }
  }
  const now=new Date().toISOString();
  const result=manualPayrollCommand(data,c,a,user.id,now);
  if(!result.replayed){
    validateManualPayroll(result.data,c);
    db.prepare('INSERT INTO manual_payroll(company_id,body) VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET body=excluded.body').run(c.id,JSON.stringify(result.data));
    // Publish exactly the finalized PDF to the existing worker Pay feature.
    // Server assembles both company and employee from the authorized book, not caller-supplied PDF bytes.
    if(result.run){
      const r=result.run,stubId=randomUUID(),filename='manual-paystatement-'+r.payDate+'.pdf';
      db.prepare('INSERT INTO manual_payroll_published VALUES(?,?,?)').run(c.id,r.id,stubId);
      db.prepare("INSERT INTO employee_paystubs VALUES(?,?,?,?,?,?,?,?,?,?,?,'finalized')").run(stubId,c.id,r.employee,r.start,r.end,r.payDate,'FirmQuill manual payroll',filename,Buffer.from(manualPaystubPdf(r)),now,user.id);
      db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(now,user.id,c.id,'manual payroll finalized',r.id);
    }else db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(now,user.id,c.id,'manual payroll '+a.type,'Manual payroll updated');
  }
  return {...output(c,result.data),finalized:!!result.run,replayed:!!result.replayed};
}
