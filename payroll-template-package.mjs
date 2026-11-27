import {createHash} from 'node:crypto';
import {emptyManualPayroll,manualPayrollCommand} from './shared/manual-payroll.mjs';
import {manualPayrollView,manualPayrollStoreCommand} from './manual-payroll-store.mjs';
import {tx} from './store.mjs';
export const payrollTemplateId='payroll-rule-template';
const fail=(ok,msg,status=400)=>{if(!ok)throw Object.assign(Error(msg),{status});};
const object=o=>!!o&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(o,fields)=>object(o)&&Object.keys(o).length===fields.length&&fields.every(k=>Object.hasOwn(o,k));
const id=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const line=(s,n)=>typeof s==='string'&&s.trim()===s&&s.length>0&&s.length<=n&&!/[\p{Cc}\p{Cf}]/u.test(s);
const digest=s=>createHash('sha256').update(s).digest('hex');
const fieldNames=new Set(['key','name','effective','through','workState','locality','side','method','periodCap','annualCap','calculationVersion','jurisdiction','wageBasis','pretaxTreatment','rounding','periodPolicy']);
const methodField={percentage:'rate',flat:'amount',brackets:'brackets'};
export function validatePayrollTemplatePayload(p){
  fail(exact(p,['version','templates'])&&p.version===1&&Array.isArray(p.templates)&&p.templates.length>=1&&p.templates.length<=24,'Unsupported payroll template format or count.');
  const seen=new Set(),seenRule=new Set();
  const templates=p.templates.map(t=>{
    fail(exact(t,['templateId','revision','label','provenance','rule'])&&id(t.templateId)&&!seen.has(t.templateId)&&positive(t.revision)&&line(t.label,100)&&line(t.provenance,220),'Invalid or duplicate payroll template.');
    const r=t.rule;
    fail(object(r)&&Object.hasOwn(methodField,r.method)&&Object.keys(r).every(k=>fieldNames.has(k)||k===methodField[r.method]),'Unsupported payroll rule fields.');
    for(const k of ['name','jurisdiction','locality'])if(r[k]!==undefined&&r[k]!==null)fail(line(r[k],120),'Payroll labels must be short plain text.');
    if(r.method==='brackets')fail(Array.isArray(r.brackets)&&r.brackets.every(b=>exact(b,['start','rate'])),'Use exact progressive bands.');
    const accepted=manualPayrollCommand(emptyManualPayroll(),{}, {...r,type:'rule',revision:0}).data.rules[0];
    fail(!seenRule.has(accepted.key),'Use a unique stable rule key per pack template.');
    seen.add(t.templateId);seenRule.add(accepted.key);
    return {templateId:t.templateId,revision:t.revision,label:t.label,provenance:t.provenance,rule:accepted};
  });
  return {version:1,templates};
}
function available({allows,packageFor}){
  if(!allows(payrollTemplateId))return null;
  const p=packageFor(),raw=p?.files?.['templates.json'];
  if(!positive(p?.version)||typeof raw!=='string'||Buffer.byteLength(raw)>64*1024)return null;
  try{return {version:p.version,digest:digest(JSON.stringify([payrollTemplateId,p.version,raw])),...{templates:validatePayrollTemplatePayload(JSON.parse(raw)).templates}};}catch{return null;}
}
function evaluate({db,state,user,companyId,allows,packageFor}){
  const data=manualPayrollView(db,user,state,companyId).data;
  const pack=available({allows,packageFor});
  if(!pack)return {enabled:false};
  const templates=pack.templates.map(row=>({...row,conflict:data.rules.some(r=>r.key===row.rule.key)}));
  const remainingCodes=24-new Set(data.rules.map(r=>r.key)).size;
  return {enabled:true,companyId,payrollRevision:data.revision,packageVersion:pack.version,packageDigest:pack.digest,remainingCodes,templates};
}
export function previewPayrollTemplates(options){return evaluate(options);}
export function applyPayrollTemplates({db,active,readState,companyId,allows,packageFor,input}){
  fail(exact(input,['companyId','payrollRevision','packageVersion','packageDigest','selected','confirm'])&&input.companyId===companyId&&input.confirm===true&&Number.isSafeInteger(input.payrollRevision)&&input.payrollRevision>=0&&positive(input.packageVersion)&&typeof input.packageDigest==='string'&&/^[a-f0-9]{64}$/.test(input.packageDigest)&&Array.isArray(input.selected)&&input.selected.length>=1&&input.selected.length<=24&&input.selected.every(row=>exact(row,['id','revision'])&&id(row.id)&&positive(row.revision))&&new Set(input.selected.map(row=>row.id)).size===input.selected.length,'Review and confirm the selected payroll rules.');
  return tx(db,()=>{
    const user=active(),state=readState();
    const checked=evaluate({db,user,state,companyId,allows,packageFor});
    fail(checked.enabled, 'No active payroll-rule template package is available.',403);
    fail(input.payrollRevision===checked.payrollRevision&&input.packageVersion===checked.packageVersion&&input.packageDigest===checked.packageDigest,'Package or payroll rules changed. Open a fresh preview.',409);
    fail(input.selected.length<=checked.remainingCodes,'The company does not have enough unused rule codes.',409);
    const selected=input.selected.map(choice=>{
      const row=checked.templates.find(t=>t.templateId===choice.id&&t.revision===choice.revision);
      fail(row&&!row.conflict,'An imported rule changed or already exists. Nothing was imported.',409);return row;
    });
    let rev=checked.payrollRevision;
    for(const row of selected){const result=manualPayrollStoreCommand(db,user,state,companyId,{...row.rule,type:'rule',revision:rev});rev=result.data.revision;}
    db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),user.id,companyId,'payroll templates imported',JSON.stringify({packageVersion:checked.packageVersion,packageDigest:checked.packageDigest,rows:selected.map(r=>({templateId:r.templateId,revision:r.revision,key:r.rule.key}))}));
    return {imported:selected.length,payrollRevision:rev};
  });
}
