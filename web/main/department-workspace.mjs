import {esc,btn,table,panel,input,select,choices,mapping,money} from '/shared/views.mjs';
const statuses=[['open','Open'],['in-progress','In progress'],['done','Done']];
const activeDepartments=new Map();
const pick=(name,label,rows,value='')=>`<label>${esc(label)}<select name="${esc(name)}">${[['','None'],...rows].map(([k,v])=>`<option value="${esc(k)}"${k===value?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
const text=(name,label,value='',type='text')=>input(name,label,type,value,type==='date'?'':'maxlength="200"').replace(' required>',['notes','dueDate','end','role','counterparty','reference','effectiveDate'].includes(name)?'>':' required>');
const person=(rows,id)=>rows?.find(x=>x.id===id)?.name||'Unassigned';
const readers=(data,selected=[],canGrant=true,includeWorkers=false)=>canGrant?`<fieldset><legend>Explicitly authorized readers</legend>${choices('readers',mapping(includeWorkers?(data.readerAccounts||data.accounts||[]):data.accounts||[]),selected)}</fieldset>`:'<p>Explicit reader access is configured by the owner.</p>';
const restriction=(data,row={},canGrant=true)=>`<label><input name="restricted" type="checkbox"${row.restricted?' checked':''}> Restricted record</label>`+readers(data,row.readers,canGrant);
function templateFields(t){
  const encoded=(t?.tasks||[]).map(x=>[x.title,x.days,(x.after||[]).map(n=>n+1).join(',')].join(' | ')).join('\n');
  return text('name','Template name',t?.name)+'<p>Use one ordinary task per line: <code>Task title | Days after start | Predecessor line numbers</code>. Example: <code>Final review | 7 | 1,2</code>. Optional columns may be left empty.</p><label>Task rows<textarea name="taskRows" rows="8" maxlength="8000" required>'+esc(encoded)+'</textarea></label>';
}
function parseTemplateRows(value){
  return value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map((s,i)=>{const p=s.split('|').map(v=>v.trim());if(p.length>3||!p[0]||p[1]&&!/^\d+$/.test(p[1])||p[2]&&!/^\d+(?:\s*,\s*\d+)*$/.test(p[2]))throw Error('Check template line '+(i+1)+'.');return {title:p[0],days:Number(p[1]||0),after:p[2]?p[2].split(',').map(n=>Number(n)-1):[]};});
}
function projectBoard(p,canEdit,accounts){
  return '<details class="project-board"><summary>Open Kanban task board</summary><div class="project-columns">'+statuses.map(([state,name])=>'<section class="project-lane"><h3>'+esc(name)+'</h3>'+((p.tasks||[]).filter(t=>t.status===state).map(t=>'<article class="project-ticket"><strong>'+esc(t.title)+'</strong><p>'+esc(person(accounts,t.ownerId))+(t.dueDate?' · '+esc(t.dueDate):'')+'</p>'+((t.dependencies||[]).length?'<p>After: '+esc(t.dependencies.map(id=>(p.tasks||[]).find(x=>x.id===id)?.title||'').filter(Boolean).join(', '))+'</p>':'')+(canEdit(t)?btn('desk-task-edit','Edit / move task',p.id+'|'+t.id):'')+'</article>').join('')||'<p class="quiet">No tasks.</p>')+'</section>').join('')+'</div></details>';
}
function recordRows(rows,data,canEdit){return table(['Work','Type','Owner','Due','Status',''],rows.map(r=>[esc(r.title),esc(r.kind),esc(person(data.accounts,r.ownerId)),esc(r.dueDate||'—'),esc(r.status)+(r.kind==='contract'?'<br>'+esc(r.contractStatus||'Active'):''),canEdit(r)?btn('desk-record','Edit',r.id):'']),'No records in your permission scope.');}
export function workspaceContent(page,data,session){
  if(!data)return '<p>Loading workspace…</p>';if(data.error)return `<p class="error">${esc(data.error)}</p>`;
  if(page==='Project tracker'){
    const owner=session.user.role==='owner',writable=!['viewer','worker'].includes(session.user.role),deptRights=id=>data.departments?.find(d=>d.id===id)?.rights||[],canCreate=writable&&(owner||['manager','bookkeeper'].includes(session.user.role)||data.departments?.some(d=>d.rights?.includes('manage')));
    return panel('Shared projects','<p>Project leads and task owners coordinate work. Staffing records support hours and job costing; staffing alone gives no access.</p>',canCreate?btn('desk-project','New project','','primary'):'')+
      (canCreate?panel('Project templates','<p>Reuse a checklist of ordinary project tasks with relative due dates and prerequisites. Templates are company-wide; do not enter sensitive information here.</p>'+
        table(['Template','Tasks','Actions'],(data.templates||[]).map(t=>[esc(t.name),esc(t.tasks.length),btn('desk-template-use','Start from template',t.id)+(owner?btn('desk-template-save','Edit template',t.id)+btn('desk-template-remove','Remove template',t.id):'')]),'No templates yet.'),owner?btn('desk-template-save','New template','','primary'):''):'')+
      (data.projects||[]).map(p=>{const manage=writable&&(owner||p.rights?.includes('manage')||p.visibility==='company'&&['manager','bookkeeper'].includes(session.user.role)),assign=manage&&(owner||p.rights?.includes('assign'));
        const canEdit=t=>{const rights=deptRights(t.departmentId),hr=t.kind==='onboarding'||t.kind==='termination';return manage&&(owner||rights.includes('manage')&&(!t.restricted||rights.includes('restricted'))&&(!hr||rights.includes('hr')&&session.user.areas?.some(a=>['Employee records','Benefits administration'].includes(a))));};
        return panel(p.name,`<p>Status: ${esc(p.status||'open')} · Lead: ${esc(person(data.accounts,p.leadId))} · ${esc(p.visibility||'company')} access</p><p>${esc(p.timeMinutes||0)} minutes · ${p.cost?money(p.cost.labor+p.cost.postedCost)+' costs · '+money(p.cost.revenue)+' revenue':'Cost restricted'}</p>`+
          table(['Task','Owner','Due','Status',''],(p.tasks||[]).map(t=>[esc(t.title),esc(person(data.accounts,t.ownerId)),esc(t.dueDate||'—'),esc(t.status),canEdit(t)?btn('desk-task-edit','Edit task',p.id+'|'+t.id):'']),'No visible tasks.')+
          projectBoard(p,canEdit,data.accounts)+
          table(['Staff member','Role','From','Through',''],(p.staffing||[]).map(s=>[esc(person(data.employees,s.employeeId)),esc(s.role||''),esc(s.start),esc(s.end||'Open'),assign?btn('desk-staff-remove','Remove assignment',p.id+'|'+s.id):'']),'No staffing assignments.'),(manage?btn('desk-project','Edit project',p.id):'')+(manage&&(owner||data.departments?.some(d=>d.rights?.includes('manage')))?btn('desk-task','Add task',p.id):'')+(assign?btn('desk-staff','Assign worker',p.id):''));}).join('');
  }
  const workspaces=data.workspaces||[],scope=session.user.id+'|'+(workspaces[0]?.companyId||''),selected=activeDepartments.get(scope);
  const active=workspaces.some(w=>w.id===selected)?selected:workspaces[0]?.id||'';
  activeDepartments.set(scope,active);
  return (data.ownerDeskConversions?.length?panel('Owner desk conversion review',table(['Imported','Records','Exceptions'],data.ownerDeskConversions.map(r=>[esc(r.importedAt),esc(JSON.stringify({projects:r.projects,tasks:r.tasks,contracts:r.contracts,staffing:r.staffing,assets:r.assets?.units})),esc(JSON.stringify(r.conflicts||[]))]))):'')+panel('Department workspaces','<p>Each workspace displays records allowed by your department grants. Restricted records need their own access.</p>'+(workspaces.length?`<label>Department dashboard<select id="desk-dashboard" data-scope="${esc(scope)}">${workspaces.map(w=>`<option value="${esc(w.id)}"${w.id===active?' selected':''}>${esc(w.name)}</option>`).join('')}</select></label>`:'<p>No department dashboard is assigned to this account.</p>'),(session.user.role==='owner'?btn('desk-department','New department','','primary')+btn('desk-department-grant','Department permissions'):'')+btn('desk-export','Export authorized records'))+
    workspaces.map(w=>`<section data-department-dashboard="${esc(w.id)}"${w.id===active?'':' hidden'}>`+panel(w.name,`<p>${esc(w.kind||'Department')} · Rights: ${esc(w.rights.join(', '))}</p>`+
      (w.widgets||[]).map(widget=>panel(widget.id,widget.rows?table(['Record','Details'],widget.rows.map(r=>[esc(r.title||r.name||r.id||''),esc(r.status||r.dueDate||JSON.stringify(r))])):(widget.value&&typeof widget.value==='object'?Object.entries(widget.value).map(([k,v])=>esc(k)+': '+(typeof v==='number'?money(v):esc(v))).join(' · '):esc(widget.value??0)))).join('')+
      recordRows(w.records||[],data,r=>session.user.role!=='viewer'&&w.rights.includes('manage')&&(!r.restricted||w.rights.includes('restricted')))+table(['Project','Status'],(w.projects||[]).map(p=>[esc(p.name),esc(p.status||'open')]))+
      table(['Task','Owner'],(w.tasks||[]).map(t=>[esc(t.title),esc(person(data.accounts,t.ownerId))])) ,(session.user.role!=='viewer'&&w.rights.includes('manage')?btn('desk-record','Add department record',w.id):'')+(['owner'].includes(session.user.role)?btn('desk-department','Configure',w.id):''))+'</section>').join('')+
    panel('Search authorized work','<form id="desk-search"><label>Search records<input name="q" type="search" maxlength="160"></label><button>Search</button></form><div id="desk-search-results"></div>');
}
export async function workspaceAction(type,key,ctx){
  if(!type.startsWith('desk-'))return false;
  const {auxiliary:d,companyId,session,api,formModal,closeModal,refresh,toast,download}=ctx;
  const canGrant=session.user.role==='owner',savedReaders=(form,row)=>canGrant?form.getAll('readers'):row?.readers||[];
  const departments=d.workspaces||d.departments||[],accounts=d.accounts||[];
  const deptPairs=departments.map(x=>[x.id,x.name]),accountPairs=mapping(accounts);
  const send=async(endpoint,action)=>{await api(endpoint,{action:{companyId,...action}});closeModal();await refresh();toast('Workspace saved.');};
  const status=row=>pick('status','Status',statuses,row?.status||'open');
  if(type==='desk-export'){const out=await api('workspaces/export?companyId='+encodeURIComponent(companyId));download(JSON.stringify(out,null,2),'FirmQuill-authorized-workspaces.json','application/json');return true;}
  if(type==='desk-template-save'){
    const t=d.templates.find(x=>x.id===key);
    formModal(t?'Edit project template':'New project template',templateFields(t),'Save template',v=>send('projects',{type:'template-save',...(t?{templateId:t.id,version:t.version}:{}),name:v.name,tasks:parseTemplateRows(v.taskRows)}));
  }else if(type==='desk-template-remove'){
    const t=d.templates.find(x=>x.id===key);
    if(t)formModal('Remove project template','<p>Existing projects are not affected.</p>','Remove template',()=>send('projects',{type:'template-remove',templateId:t.id,version:t.version}));
  }else if(type==='desk-template-use'){
    const t=d.templates.find(x=>x.id===key),eligible=departments.filter(dep=>canGrant||dep.rights?.includes('manage'));
    if(t)formModal('Start project from template',text('name','New project name',t.name)+select('departmentId','Owning department',eligible.map(dep=>[dep.id,dep.name]))+
      text('start','Project start date',new Date().toISOString().slice(0,10),'date')+'<p>Creates a department project and ordinary, unassigned tasks with due dates and prerequisites. No staff or access grants are copied.</p>',
      'Create project',v=>send('projects',{type:'template-use',templateId:t.id,version:t.version,...v}));
  }else if(type==='desk-department'){
    const row=departments.find(x=>x.id===key);
    formModal(row?'Configure department':'New department',text('name','Department name',row?.name)+pick('kind','Business function',['Legal','Finance','HR','Operations','Custom'].map(x=>[x,x]),row?.kind||'Custom')+`<fieldset><legend>Dashboard widgets</legend>${choices('widgets',(d.widgetTypes||[]).map(x=>[typeof x==='string'?x:x.id,typeof x==='string'?x:x.label||x.id]),row?.widgetIds||row?.widgets?.map(w=>w.id)||[])}</fieldset>`,'Save department',(v,f)=>send('departments',{type:'department-save',...(row?{id:row.id,version:row.version}:{}),...v,widgets:f.getAll('widgets')}));
  }else if(type==='desk-department-grant'){
    formModal('Department permissions',pick('departmentId','Department',deptPairs)+pick('accountId','ERP account',accountPairs)+`<fieldset><legend>Department rights</legend>${choices('rights',['view','manage','assign','restricted','finance','hr'].map(x=>[x,x]),[])}</fieldset>`,'Save permissions',(v,f)=>send('departments',{type:'department-grant',...v,rights:f.getAll('rights')}));
    const dialog=document.querySelector('dialog[open]');
    if(dialog)dialog.onchange=e=>{if(!['departmentId','accountId'].includes(e.target.name))return;const department=departments.find(w=>w.id===dialog.querySelector('[name=departmentId]').value),account=dialog.querySelector('[name=accountId]').value,rights=department?.grants?.find(g=>g.accountId===account)?.rights||[];for(const checkbox of dialog.querySelectorAll('[name=rights]'))checkbox.checked=rights.includes(checkbox.value);};
  }else if(type==='desk-record'){
    const row=departments.flatMap(w=>w.records||[]).find(r=>r.id===key),departmentId=row?.departmentId||key;
    formModal(row?'Edit department record':'Add department record',pick('departmentId','Department',deptPairs,departmentId)+text('title','Record title',row?.title)+pick('kind','Record type',['contract','close-task','onboarding','termination','benefits-work','case','record'].map(x=>[x,x]),row?.kind||'record')+text('counterparty','Contract counterparty (optional)',row?.counterparty)+text('reference','Contract file / legal reference (optional)',row?.reference)+text('effectiveDate','Contract effective date (optional)',row?.effectiveDate,'date')+pick('contractStatus','Contract status (if contract)',['Active','Expired','Terminated','Closed'].map(x=>[x,x]),row?.contractStatus||'Active')+pick('ownerId','Named owner',accountPairs,row?.ownerId)+text('dueDate','Due / renewal date',row?.dueDate,'date')+status(row)+text('notes','Notes',row?.notes)+restriction(d,row,canGrant),'Save record',(v,f)=>send('departments',{type:'record-save',...(row?{id:row.id,version:row.version}:{}),...v,restricted:f.has('restricted'),readers:savedReaders(f,row)}));
  }else if(type==='desk-project'){
    const row=d.projects.find(p=>p.id===key);
    formModal(row?'Edit project':'New project',text('name','Project name',row?.name)+pick('departmentId','Owning department',deptPairs,row?.departmentId)+pick('leadId','Project lead',accountPairs,row?.leadId)+pick('visibility','Project access',[['company','Assigned company users'],['department','Department users'],['restricted','Explicit readers']],row?.visibility||'department')+status(row)+readers(d,row?.readers,canGrant,true),'Save project',(v,f)=>send('projects',{type:'project-save',...(row?{id:row.id,version:row.version}:{}),...v,readers:savedReaders(f,row)}));
  }else if(type==='desk-task'||type==='desk-task-edit'){
    const [projectId,taskId]=key.split('|'),p=d.projects.find(p=>p.id===projectId),row=p?.tasks.find(t=>t.id===taskId);
    const dept=row?.departmentId||p?.departmentId;
    const eligible=(p?.tasks||[]).filter(t=>t.id!==taskId&&t.departmentId===dept&&t.kind==='task'&&!t.restricted);
    const dependencyField=(!row||row.kind==='task'&&!row.restricted)&&eligible.length?'<fieldset><legend>Predecessor tasks (same department)</legend>'+choices('dependencies',eligible.map(t=>[t.id,t.title]),row?.dependencies||[])+'</fieldset>':'';
    formModal(row?'Edit project task':'Add project task',text('title','Task title',row?.title)+pick('departmentId','Task department',deptPairs,row?.departmentId||p?.departmentId)+pick('ownerId','Task owner',accountPairs,row?.ownerId)+pick('kind','Task type',[['task','Task'],['onboarding','Onboarding'],['termination','Termination']],row?.kind||'task')+text('dueDate','Due date',row?.dueDate,'date')+status(row)+text('notes','Task notes',row?.notes)+dependencyField+restriction(d,row,canGrant),'Save task',(v,f)=>send('projects',{type:'project-task-save',projectId,...(row?{id:row.id,version:row.version}:{}),...v,...(dependencyField?{dependencies:f.getAll('dependencies')}:{}),restricted:f.has('restricted'),readers:savedReaders(f,row)}));
  }else if(type==='desk-staff'){
    formModal('Assign worker',pick('employeeId','Worker / employee',mapping(d.employees||[]))+text('role','Staffing role')+text('start','From date',new Date().toISOString().slice(0,10),'date')+text('end','Through date (optional)','','date')+'<p>This staffing assignment does not grant project access.</p>','Assign worker',v=>send('projects',{type:'project-staff',projectId:key,...v}));
  }else if(type==='desk-staff-remove'){
    const [projectId,assignmentId]=key.split('|');formModal('Remove staffing assignment','<p>The staffing history is retained.</p>','Remove assignment',()=>send('projects',{type:'project-staff-remove',projectId,assignmentId}));
  }
  return true;
}
export function bindWorkspaceSearch(root,api,companyId){
  const dashboard=root.querySelector('#desk-dashboard');if(dashboard)dashboard.onchange=()=>{activeDepartments.set(dashboard.dataset.scope,dashboard.value);for(const section of root.querySelectorAll('[data-department-dashboard]'))section.hidden=section.dataset.departmentDashboard!==dashboard.value;};
  const form=root.querySelector('#desk-search');if(form)form.onsubmit=async e=>{e.preventDefault();const target=root.querySelector('#desk-search-results');try{const data=await api('workspaces/search?companyId='+encodeURIComponent(companyId)+'&q='+encodeURIComponent(new FormData(form).get('q')));target.innerHTML=table(['Type','Record'],data.results.map(r=>[esc(r.type),esc(r.title)]));}catch(err){target.textContent=err.message;}};
}
