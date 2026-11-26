import {esc,btn,table,panel,input,select,choices,mapping,money} from '/shared/views.mjs';
const statuses=[['open','Open'],['in-progress','In progress'],['done','Done']];
const pick=(name,label,rows,value='')=>`<label>${esc(label)}<select name="${esc(name)}">${[['','None'],...rows].map(([k,v])=>`<option value="${esc(k)}"${k===value?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
const text=(name,label,value='',type='text')=>input(name,label,type,value,type==='date'?'':'maxlength="200"').replace(' required>',['notes','dueDate','end','role','counterparty','reference','effectiveDate'].includes(name)?'>':' required>');
const person=(rows,id)=>rows?.find(x=>x.id===id)?.name||'Unassigned';
const readers=(data,selected=[])=>`<fieldset><legend>Explicitly authorized readers</legend>${choices('readers',mapping(data.accounts||[]),selected)}</fieldset>`;
const restriction=(data,row={})=>`<label><input name="restricted" type="checkbox"${row.restricted?' checked':''}> Restricted record</label>`+readers(data,row.readers);
function recordRows(rows,data){return table(['Work','Type','Owner','Due','Status',''],rows.map(r=>[esc(r.title),esc(r.kind),esc(person(data.accounts,r.ownerId)),esc(r.dueDate||'—'),esc(r.status)+(r.kind==='contract'?'<br>'+esc(r.contractStatus||'Active'):''),btn('desk-record','Edit',r.id)]),'No records in your permission scope.');}
export function workspaceContent(page,data,session){
  if(!data)return '<p>Loading workspace…</p>';if(data.error)return `<p class="error">${esc(data.error)}</p>`;
  if(page==='Project tracker')return panel('Shared projects','<p>Project leads and task owners coordinate work. Staffing records support hours and job costing; staffing alone gives no access.</p>',btn('desk-project','New project','','primary'))+
    (data.projects||[]).map(p=>panel(p.name,`<p>Status: ${esc(p.status||'open')} · Lead: ${esc(person(data.accounts,p.leadId))} · ${esc(p.visibility||'company')} access</p><p>${esc(p.timeMinutes||0)} minutes · ${p.cost?money(p.cost.labor+p.cost.postedCost)+' costs · '+money(p.cost.revenue)+' revenue':'Cost restricted'}</p>`+
      table(['Task','Owner','Due','Status',''],(p.tasks||[]).map(t=>[esc(t.title),esc(person(data.accounts,t.ownerId)),esc(t.dueDate||'—'),esc(t.status),btn('desk-task-edit','Edit task',p.id+'|'+t.id)]),'No visible tasks.')+
      table(['Staff member','Role','From','Through',''],(p.staffing||[]).map(s=>[esc(person(data.employees,s.employeeId)),esc(s.role||''),esc(s.start),esc(s.end||'Open'),btn('desk-staff-remove','Remove assignment',p.id+'|'+s.id)]),'No staffing assignments.'),btn('desk-project','Edit project',p.id)+btn('desk-task','Add task',p.id)+btn('desk-staff','Assign worker',p.id))).join('');
  return (data.ownerDeskConversions?.length?panel('Owner desk conversion review',table(['Imported','Records','Exceptions'],data.ownerDeskConversions.map(r=>[esc(r.importedAt),esc(JSON.stringify({projects:r.projects,tasks:r.tasks,contracts:r.contracts,staffing:r.staffing,assets:r.assets?.units})),esc(JSON.stringify(r.conflicts||[]))]))):'')+panel('Department workspaces','<p>Each workspace displays records allowed by your department grants. Restricted records need their own access.</p>',(session.user.role==='owner'?btn('desk-department','New department','','primary')+btn('desk-department-grant','Department permissions'):'')+btn('desk-export','Export authorized records'))+
    (data.workspaces||[]).map(w=>panel(w.name,`<p>${esc(w.kind||'Department')} · Rights: ${esc(w.rights.join(', '))}</p>`+
      (w.widgets||[]).map(widget=>panel(widget.id,widget.rows?table(['Record','Details'],widget.rows.map(r=>[esc(r.title||r.name||r.id||''),esc(r.status||r.dueDate||JSON.stringify(r))])):(widget.value&&typeof widget.value==='object'?Object.entries(widget.value).map(([k,v])=>esc(k)+': '+(typeof v==='number'?money(v):esc(v))).join(' · '):esc(widget.value??0)))).join('')+
      recordRows(w.records||[],data)+table(['Project','Status'],(w.projects||[]).map(p=>[esc(p.name),esc(p.status||'open')]))+
      table(['Task','Owner'],(w.tasks||[]).map(t=>[esc(t.title),esc(person(data.accounts,t.ownerId))])) ,btn('desk-record','Add department record',w.id)+(['owner'].includes(session.user.role)?btn('desk-department','Configure',w.id):''))).join('')+
    panel('Search authorized work','<form id="desk-search"><label>Search records<input name="q" type="search" maxlength="160"></label><button>Search</button></form><div id="desk-search-results"></div>');
}
export async function workspaceAction(type,key,ctx){
  if(!type.startsWith('desk-'))return false;
  const {auxiliary:d,companyId,session,api,formModal,closeModal,refresh,toast,download}=ctx;
  const departments=d.workspaces||d.departments||[],accounts=d.accounts||[];
  const deptPairs=departments.map(x=>[x.id,x.name]),accountPairs=mapping(accounts);
  const send=async(endpoint,action)=>{await api(endpoint,{action:{companyId,...action}});closeModal();await refresh();toast('Workspace saved.');};
  const status=row=>pick('status','Status',statuses,row?.status||'open');
  if(type==='desk-export'){const out=await api('workspaces/export?companyId='+encodeURIComponent(companyId));download(JSON.stringify(out,null,2),'FirmQuill-authorized-workspaces.json','application/json');return true;}
  if(type==='desk-department'){
    const row=departments.find(x=>x.id===key);
    formModal(row?'Configure department':'New department',text('name','Department name',row?.name)+pick('kind','Business function',['Legal','Finance','HR','Operations','Custom'].map(x=>[x,x]),row?.kind||'Custom')+`<fieldset><legend>Dashboard widgets</legend>${choices('widgets',(d.widgetTypes||[]).map(x=>[typeof x==='string'?x:x.id,typeof x==='string'?x:x.label||x.id]),row?.widgetIds||row?.widgets?.map(w=>w.id)||[])}</fieldset>`,'Save department',(v,f)=>send('departments',{type:'department-save',...(row?{id:row.id,version:row.version}:{}),...v,widgets:f.getAll('widgets')}));
  }else if(type==='desk-department-grant'){
    formModal('Department permissions',pick('departmentId','Department',deptPairs)+pick('accountId','ERP account',accountPairs)+`<fieldset><legend>Department rights</legend>${choices('rights',['view','manage','assign','restricted','finance','hr'].map(x=>[x,x]),[])}</fieldset>`,'Save permissions',(v,f)=>send('departments',{type:'department-grant',...v,rights:f.getAll('rights')}));
  }else if(type==='desk-record'){
    const row=departments.flatMap(w=>w.records||[]).find(r=>r.id===key),departmentId=row?.departmentId||key;
    formModal(row?'Edit department record':'Add department record',pick('departmentId','Department',deptPairs,departmentId)+text('title','Record title',row?.title)+pick('kind','Record type',['contract','close-task','onboarding','termination','benefits-work','case','record'].map(x=>[x,x]),row?.kind||'record')+text('counterparty','Contract counterparty (optional)',row?.counterparty)+text('reference','Contract file / legal reference (optional)',row?.reference)+text('effectiveDate','Contract effective date (optional)',row?.effectiveDate,'date')+pick('contractStatus','Contract status (if contract)',['Active','Expired','Terminated','Closed'].map(x=>[x,x]),row?.contractStatus||'Active')+pick('ownerId','Named owner',accountPairs,row?.ownerId)+text('dueDate','Due / renewal date',row?.dueDate,'date')+status(row)+text('notes','Notes',row?.notes)+restriction(d,row),'Save record',(v,f)=>send('departments',{type:'record-save',...(row?{id:row.id,version:row.version}:{}),...v,restricted:f.has('restricted'),readers:f.getAll('readers')}));
  }else if(type==='desk-project'){
    const row=d.projects.find(p=>p.id===key);
    formModal(row?'Edit project':'New project',text('name','Project name',row?.name)+pick('departmentId','Owning department',deptPairs,row?.departmentId)+pick('leadId','Project lead',accountPairs,row?.leadId)+pick('visibility','Project access',[['company','Assigned company users'],['department','Department users'],['restricted','Explicit readers']],row?.visibility||'department')+status(row)+readers(d,row?.readers),'Save project',(v,f)=>send('projects',{type:'project-save',...(row?{id:row.id,version:row.version}:{}),...v,readers:f.getAll('readers')}));
  }else if(type==='desk-task'||type==='desk-task-edit'){
    const [projectId,taskId]=key.split('|'),p=d.projects.find(p=>p.id===projectId),row=p?.tasks.find(t=>t.id===taskId);
    formModal(row?'Edit project task':'Add project task',text('title','Task title',row?.title)+pick('departmentId','Task department',deptPairs,row?.departmentId||p?.departmentId)+pick('ownerId','Task owner',accountPairs,row?.ownerId)+pick('kind','Task type',[['task','Task'],['onboarding','Onboarding'],['termination','Termination']],row?.kind||'task')+text('dueDate','Due date',row?.dueDate,'date')+status(row)+text('notes','Task notes',row?.notes)+restriction(d,row),'Save task',(v,f)=>send('projects',{type:'project-task-save',projectId,...(row?{id:row.id,version:row.version}:{}),...v,restricted:f.has('restricted'),readers:f.getAll('readers')}));
  }else if(type==='desk-staff'){
    formModal('Assign worker',pick('employeeId','Worker / employee',mapping(d.employees||[]))+text('role','Staffing role')+text('start','From date',new Date().toISOString().slice(0,10),'date')+text('end','Through date (optional)','','date')+'<p>This staffing assignment does not grant project access.</p>','Assign worker',v=>send('projects',{type:'project-staff',projectId:key,...v}));
  }else if(type==='desk-staff-remove'){
    const [projectId,assignmentId]=key.split('|');formModal('Remove staffing assignment','<p>The staffing history is retained.</p>','Remove assignment',()=>send('projects',{type:'project-staff-remove',projectId,assignmentId}));
  }
  return true;
}
export function bindWorkspaceSearch(root,api,companyId){const form=root.querySelector('#desk-search');if(form)form.onsubmit=async e=>{e.preventDefault();const target=root.querySelector('#desk-search-results');try{const data=await api('workspaces/search?companyId='+encodeURIComponent(companyId)+'&q='+encodeURIComponent(new FormData(form).get('q')));target.innerHTML=table(['Type','Record'],data.results.map(r=>[esc(r.type),esc(r.title)]));}catch(err){target.textContent=err.message;}};}
