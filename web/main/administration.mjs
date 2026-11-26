import {esc,btn,table,panel,input,select,choices,mapping,options,money,pretty} from '/shared/views.mjs';
import {check,accounts} from '/shared/core.mjs';
import {recordsContent,recordsAction} from './record-admin.mjs';
import {benefitsContent,benefitsAction} from './benefit-admin.mjs';
import {identityContent,identityAction,employeeAccessContent} from './identity-admin.mjs';
import {connectedContent,connectedAction} from './connected-admin.mjs';

const roleLabels={owner:'Owner',manager:'Manager',bookkeeper:'Bookkeeper',viewer:'Viewer',worker:'Worker',hr:'Human Resources',payroll:'Payroll'};
const erpAreas=['Overview','Directory','Sales','Purchasing','Jobs & time','Warehouse','Assembly','Fixed assets','Accounting','Banking','Reports','Payroll','History','Company setup','Approvals','Audit trail','Employee records','Benefits administration','Identity connectors'];
const labels={cash:'Cash',receivables:'Receivables',payables:'Payables',inventory:'Inventory',netIncome:'Net income',trialDifference:'Trial balance difference'};
function selected(name,caption,pairs,current){
  return `<label>${esc(caption)}<select name="${esc(name)}">${pairs.map(([value,label])=>`<option value="${esc(value)}"${value===current?' selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
}
function textDetail(detail){
  if(detail===null||detail===undefined)return '';
  if(typeof detail==='string')return detail;
  return Object.entries(detail).map(([k,v])=>`${k}: ${typeof v==='object'?JSON.stringify(v):v}`).join(' · ');
}
function companyLabel(session,id){return session.state.companies.find(c=>c.id===id)?.name||'Workspace';}
function userAccess(data,session){
  return panel('Individual accounts',table(['Account','Role','Assigned companies','Access',''],data.users.map(u=>[
    `${esc(u.name)}<br><small>${esc(u.username)}</small>`,esc(roleLabels[u.role]||u.role),
    u.role==='owner'?'All companies':(u.assignments||[]).map(id=>esc(companyLabel(session,id))).join(', ')||'None',
    u.active?'Enabled':'Disabled',btn('edit-user','Edit',u.id)
  ])),btn('add-user','Add ERP user','','primary'))+employeeAccessContent(data,session);
}
function approvals(data,session){
  const permitted=['owner','manager'].includes(session.user.role);
  return panel('Review queue',table(['Company','Request','Requested by','Status',''],data.approvals.map(record=>[
    esc(companyLabel(session,record.companyId)),`${esc(record.label||record.kind)}<br><small>${esc(record.kind)}</small>`,esc(record.requestedBy),esc(pretty(record.status)),btn('review-approval',record.status==='pending'&&permitted?'Review':'Details',record.id)
  ]),'No approval requests in scope.'));
}
function audits(data,session){
  return panel('Access and activity',table(['When','Company','Actor','Activity','Detail'],data.events.map(event=>[
    esc(displayWhen(event.at)),esc(companyLabel(session,event.companyId)),esc(event.actor),esc(event.kind),esc(textDetail(event.detail))
  ]),'No audit events in scope.'));
}
function displayWhen(value){
  if(!value)return '—';
  const date=new Date(value);
  return Number.isNaN(date.valueOf())?String(value):date.toLocaleString();
}
function transferView(session){
  const hasBooks=session.state.companies.length>0;
  return panel('Lite to Full Suite',`<p>Inspect an encrypted FirmQuill Lite backup and reconcile company totals before importing into an empty installation.</p>${hasBooks?'<p class="small quiet">This installation already contains company books. A new empty installation is required for import.</p>':''}`,hasBooks?'':btn('portable-import','Preview Lite backup','','primary'))+
    panel('Full Suite to Lite','<p>Download an encrypted owner snapshot for restore in FirmQuill Lite. It includes all company books, linked documents, groups, history and attachments.</p>',hasBooks?btn('portable-export','Export encrypted snapshot'):'')+
    panel('Full Suite records','<p>Use a Full Suite database backup for disaster recovery. User accounts, roles, worker clock records, correction requests, server audit events and pending approvals stay with the installation. Approved time posted to company books travels in the portable snapshot.</p>');
}
function suiteContent(page,data,session,companyId){
  if(['Migration workspace','Agent access','Setup help'].includes(page))return connectedContent(page,data,session);
  if(page==='Portable transfers')return transferView(session);
  if(!data)return '<p class="quiet">Loading records…</p>';
  if(data.error)return `<div class="callout warn">${esc(data.error)}</div>`;
  if(page==='Employee records')return recordsContent(data,session,companyId);
  if(page==='Benefits administration')return benefitsContent(data,session,companyId);
  if(page==='Identity connectors')return identityContent(data,session,companyId);
  return {'User access':userAccess,'Approvals':approvals,'Audit trail':audits}[page](data,session);
}
function editUser(user,ctx){
  const {session,formModal,api,closeModal,refresh,toast}=ctx;
  const companies=session.state.companies;
  const fields=input('name','Display name','text',user?.name||'','maxlength="160"')+
    input('username','Username','text',user?.username||'','autocomplete="off" maxlength="100" autocapitalize="none" spellcheck="false"')+
    (user?'<label>Reset password (optional)<input type="password" name="password" autocomplete="new-password" minlength="12"></label>':input('password','Initial password','password','','autocomplete="new-password" minlength="12"'))+
    selected('role','Role',Object.entries(roleLabels).filter(([r])=>user?.role==='worker'?r==='worker':r!=='worker'),user?.role||'viewer')+
    `<fieldset data-company-assignments><legend>Assigned companies</legend>${choices('assignments',mapping(companies),user?.assignments||[])}</fieldset>`+
    `<label>Linked employee (optional for ERP)<select name="employeeId"><option value="">No employee link</option>${companies.map(c=>`<optgroup label="${esc(c.name)}">${c.employees.map(p=>`<option value="${esc(p.id)}"${p.id===user?.employeeId?' selected':''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>`+
    `<fieldset data-erp-areas><legend>Permitted ERP areas</legend>${choices('areas',erpAreas.map(a=>[a,a]),user?.areas||[])}</fieldset>`+
    selected('active','Account access',[['yes','Enabled'],['no','Disabled']],user?.active===false?'no':'yes');
  formModal(user?'Edit individual account':'Add individual account',fields,user?'Save account':'Create account',async(v,f)=>{
    const assignments=f.getAll('assignments'),worker=v.role==='worker';
    if(worker){
      check(assignments.length===1,'A worker needs exactly one company assignment.');
      const company=companies.find(c=>c.id===assignments[0]);
      check(company?.employees.some(p=>p.id===v.employeeId),'Choose an employee in the assigned company.');
    }
    const body={name:v.name.trim(),username:v.username.trim(),role:v.role,active:v.active==='yes',assignments:v.role==='owner'?[]:assignments,employeeId:v.employeeId||'',areas:f.getAll('areas'),revision:session.revision};
    if(user){body.id=user.id;body.version=user.version;}
    if(v.password)body.password=v.password;
    const result=await api('admin/user',body);
    closeModal();await refresh(result);toast('Account saved.');
  });
  const dialog=document.querySelector('dialog');
  const update=()=>{
    const role=dialog.querySelector('[name=role]').value;
    const emp=dialog.querySelector('[name=employeeId]');
    emp.required=role==='worker';emp.parentElement.hidden=role==='owner';
    dialog.querySelector('[data-company-assignments]').hidden=role==='owner';
    dialog.querySelector('[data-erp-areas]').hidden=['worker','owner'].includes(role);
  };
  dialog.onchange=update;update();
}
function review(record,ctx){
  const {formModal,session,api,closeModal,refresh,toast}=ctx;
  check(record,'Refresh the approval queue.');
  const decide=record.status==='pending'&&['owner','manager'].includes(session.user.role)&&record.requestedBy!==session.user.id;
  const fields=`<p><b>${esc(record.label||record.kind)}</b></p><p>${esc(companyLabel(session,record.companyId))} · ${esc(record.status)}</p>`+approvalDetail(record,session)+
    (decide?select('decision','Decision',[['','Choose a decision'],['approve','Approve'],['reject','Reject']]):'');
  formModal('Review request',fields,decide?'Save decision':'',async v=>{
    const result=await api('approve',{id:record.id,decision:v.decision,revision:session.revision});
    closeModal();await refresh(result);toast('Decision recorded.');
  });
}
function approvalDetail(record,session){
  let data;
  try{data=typeof record.detail==='string'?JSON.parse(record.detail):record.detail;}catch{}
  if(!data||typeof data!=='object')return '<p class="request-detail">'+esc(textDetail(record.detail))+'</p>';
  const c=session.state.companies.find(b=>b.id===record.companyId);
  const refs={party:c?.parties,item:c?.items,job:c?.jobs,asset:c?.assets,employee:c?.employees,parent:c?.docs,entry:c?.entries,row:c?.bank};
  const monetary=['amount','rate','unit','closing','residual'];
  const rows=[];
  for(const [key,value] of Object.entries(data)){
    if(['type','label','name','requestId','lines'].includes(key)||value==='')continue;
    const ref=refs[key]?.find(x=>x.id===value);
    const field=key==='unit'?'Unit price':pretty(key);
    const formatted=monetary.includes(key)&&Number.isSafeInteger(value)?money(value):esc(ref?.name||ref?.label||ref?.memo||ref?.description||(typeof value==='object'?JSON.stringify(value):value));
    rows.push([esc(field),formatted]);
  }
  const lines=Array.isArray(data.lines)?table(['Account','Debit','Credit'],data.lines.map(([account,value])=>[esc(account+' · '+(accounts[account]?.[0]||'')),money(Math.max(0,value)),money(Math.max(0,-value))])):'';
  return (rows.length?table(['Field','Submitted value'],rows):'')+lines;
}
function summaryTables(summary){
  return `<p>${summary.companies.length} companies · ${summary.groups} reporting groups</p>`+
    summary.companies.map(c=>`<section class="transfer-summary"><h3>${esc(c.name)}</h3><p class="small quiet source">${esc(c.id)}</p><p>${c.documents} documents · ${c.journals} journals · ${c.history} history records · ${c.employees} employees · ${c.attachments} attachments (${c.attachmentBytes.toLocaleString()} bytes)</p>`+
    table(['Account control','Amount'],Object.entries(labels).map(([key,label])=>[label,money(c.balances[key])]))+'</section>').join('');
}
function importLite(ctx){
  const {formModal,closeModal,api,refresh,toast}=ctx;
  formModal('Preview Lite backup',input('file','Encrypted backup','file','','accept=".firmquill,.fieldledger,.json"')+input('password','Backup password','password','','autocomplete="off"'),'Preview',async v=>{
    check(v.file.size>0&&v.file.size<=48*1024*1024,'Choose an encrypted backup smaller than 48 MiB.');
    const envelope=await v.file.text(),password=v.password;
    const prepared=await api('transfer/preview',{envelope,password});
    const fields=summaryTables(prepared.summary)+`<p class="small source">SHA-256 ${esc(prepared.digest)}</p><label class="checkfield"><input type="checkbox" required>I compared these balances and record counts with Lite.</label>`;
    formModal('Reconcile Lite import',fields,'Import into empty books',async()=>{
      const result=await api('transfer/import',{envelope,password,digest:prepared.digest,revision:prepared.revision});
      closeModal();await refresh(result);toast('Company books imported.');
    });
  });
}
function exportLite(ctx){
  const {formModal,api,download}=ctx;
  formModal('Export encrypted snapshot',input('password','Snapshot password (12+ characters)','password','','autocomplete="new-password" minlength="12"')+input('confirm','Confirm snapshot password','password','','autocomplete="new-password" minlength="12"'),'Create snapshot',async v=>{
    check(v.password===v.confirm,'Passwords differ.');
    const result=await api('transfer/export',{password:v.password});
    formModal('Encrypted snapshot ready',summaryTables(result.summary)+(result.deskReport?.length?panel('Owner desk transfer review',table(['Company','Warnings','Excluded from Lite','Archived rows'],result.deskReport.map(r=>[esc(r.companyName),esc(r.warnings.join(' '))||'None',esc(JSON.stringify(r.excluded)),esc(JSON.stringify(r.archived))]))+'<p>Review this transfer scope before downloading. Use a whole-database backup for Full Suite personnel, accounts and permissions.</p>'):'')+`<p class="small source">SHA-256 ${esc(result.digest)}</p>`,'Download snapshot',()=>{
      download(result.envelope,'FirmQuill-owner-'+new Date().toISOString().slice(0,10)+'.firmquill','application/json');
      ctx.closeModal();ctx.toast('Encrypted snapshot downloaded.');
    });
  });
}
async function suiteAction(type,key,ctx){
  if(await connectedAction(type,key,ctx))return true;
  if(await recordsAction(type,key,ctx)||await benefitsAction(type,key,ctx)||await identityAction(type,key,ctx))return true;
  switch(type){
    case 'add-user':editUser(null,ctx);return true;
    case 'edit-user':editUser(ctx.auxiliary.users.find(u=>u.id===key),ctx);return true;
    case 'review-approval':review(ctx.auxiliary.approvals.find(a=>a.id===key),ctx);return true;
    case 'portable-import':importLite(ctx);return true;
    case 'portable-export':exportLite(ctx);return true;
    default:return false;
  }
}

export {suiteContent,suiteAction};

