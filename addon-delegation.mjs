import {randomUUID} from 'node:crypto';
import {readBooks,safeUser,tx,requireThat} from './store.mjs';
import {projectView} from './project-workspace.mjs';

const corporate=['owner','manager','bookkeeper','hr','payroll','viewer'],management=['owner','manager','bookkeeper'],worker=['worker'];
const catalog=new Map();
function add(id,label,roles,path,type,fields,read=false){
  catalog.set(id,{id,label,roles,path,type,fields:fields.split(' ').filter(Boolean),read});
}
add('workspace.status','Read workspace revision and selected company',corporate,'/api/session','','',true);
add('company.create','Create the first company',['owner'],'/api/action','company','revision requestId name activities');
add('projects.read','Read projects, tasks and departments in this company',corporate,'/api/projects','','',true);
add('project.save','Create or update projects',management,'/api/projects','project-save','id version name date departmentId visibility readers leadId status');
add('task.save','Create or update project tasks',management,'/api/projects','project-task-save','id version projectId departmentId title kind restricted readers ownerId dueDate status notes dependencies');
add('ledger.post','Submit a manual journal',management,'/api/action','journal','revision requestId date label lines flow');
add('worker.status','Read own clock status, shift history and available jobs',worker,'/api/session','','',true);
add('worker.leave-read','Read own leave request dates and statuses',worker,'/api/session','','',true);
add('worker.reviews-read','Read own published review titles and acknowledgments',worker,'/api/session','','',true);
add('worker.clock-in','Clock in to a job',worker,'/api/worker/action','clock-in','jobId');
add('worker.clock-out','Clock out of an open shift',worker,'/api/worker/action','clock-out','shiftId');
add('worker.clock-correction','Submit a shift correction',worker,'/api/worker/action','correction','shiftId start end reason');
add('worker.leave-submit','Submit own time-off request',worker,'/api/team/my-time-off','submit','from through category note');
add('worker.leave-withdraw','Withdraw own pending time-off request',worker,'/api/team/my-time-off','withdraw','id version');
add('worker.review-acknowledge','Acknowledge own published review',worker,'/api/records/action','review-acknowledge','reviewId');
add('admin.employees-read','List employee names and IDs in this company',['owner'],'/api/session','','',true);
add('admin.employee-features','Set employee portal features in this company',['owner'],'/api/admin/employee-features','','employeeId features');
add('admin.employee-erp','Set employee ERP access in this company',['owner'],'/api/admin/employee-erp','','employeeId enabled areas');

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const clientPattern=/^[A-Za-z0-9_.:@/-]{1,200}$/;
const publicActions=[...catalog.values()].map(({id,label,roles,read})=>({id,label,roles,read}));
const accountFor=(db,id)=>safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(id));
const hasCompany=(actor,id)=>actor.role==='owner'||actor.assignments.includes(id);

function normalRequest(spec,companyId,args){
  if(!spec.read){
    requireThat(typeof args.requestId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(args.requestId),400,'A stable request ID is required.');
    if(spec.path!=='/api/action'){const {requestId,...nativeArgs}=args;args=nativeArgs;}
  }
  requireThat(object(args)&&Object.keys(args).every(k=>spec.fields.includes(k)),400,'Unsupported arguments for this delegated operation.');
  for(const [key,value] of Object.entries(args)){
    if(['readers','activities','dependencies','features','areas'].includes(key))requireThat(Array.isArray(value)&&value.every(x=>typeof x==='string'),400,'Expected a list of identifiers or labels.');
    else if(key==='lines')requireThat(Array.isArray(value)&&value.length<=500&&value.every(x=>Array.isArray(x)&&x.length===2&&typeof x[0]==='string'&&Number.isSafeInteger(x[1])),400,'Enter journal lines as account and integer cents.');
    else requireThat(['string','boolean','number'].includes(typeof value),400,'Expected a scalar operation argument.');
  }
  const path=spec.path;
  if(spec.read)return path==='/api/projects'?{path,query:{companyId}}:{path};
  if(path==='/api/action'){
    const {revision,...action}=args;
    requireThat(Number.isSafeInteger(revision)&&typeof action.requestId==='string',400,'A books revision and stable request ID are required.');
    return {path,body:{companyId,revision,action:{...action,type:spec.type}}};
  }
  if(path.startsWith('/api/admin/'))return {path,body:{...args,companyId}};
  return {path,body:{action:{...args,companyId,type:spec.type}}};
}
const brief=(row,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
function projectEdit(db,actor,companyId,spec,args){
  if(!args.id||!['project.save','task.save'].includes(spec.id))return args;
  const {projects}=projectView(db,actor,readBooks(db).state,{companyId});
  const task=spec.id==='task.save',project=projects.find(p=>p.id===(task?args.projectId:args.id)),prior=task?project?.tasks.find(t=>t.id===args.id):project;
  requireThat(prior,404,'The selected project or task is unavailable.');
  requireThat(args.version===prior.version,409,'The selected project or task has changed.');
  // The ERP preserves unsubmitted dependencies, including a predecessor hidden by the viewer's scope.
  return {...brief(prior,spec.fields.filter(k=>k!=='dependencies')),...args};
}
function projectResult(spec,scope,actor,response){
  if(spec.id==='workspace.status'||spec.id==='company.create'){
    const companies=response.state?.companies||[];
    const company=spec.id==='company.create'?companies[0]:companies.find(c=>c.id===scope.companyId);
    return {revision:response.revision,companyId:company?.id||'',companyName:company?.name||'',role:actor.role};
  }
  if(spec.id==='projects.read'){
    return {projects:response.projects.filter(p=>p.companyId===scope.companyId).map(p=>({...brief(p,['id','name','status','version','departmentId','leadId','visibility']),tasks:p.tasks.map(t=>brief(t,['id','title','status','version','departmentId','kind','ownerId','dueDate','dependencies']))})),
      departments:response.departments.map(d=>brief(d,['id','name']))};
  }
  if(spec.id==='worker.status'){
    const {data,features}=response;
    return {role:actor.role,companyId:scope.companyId,companyName:data.company,employee:data.employee,features,
      jobs:(data.jobs||[]).map(j=>brief(j,['id','name'])),openShift:data.openShift?brief(data.openShift,['id','start']):null,
      shifts:(data.shifts||[]).map(s=>brief(s,['id','start','end']))};
  }
  if(spec.id==='worker.leave-read'){
    requireThat(response.features.includes('Time off'),403,'Time off is unavailable for this employee.');
    return {categories:response.leave.categories,requests:response.leave.requests.map(r=>brief(r,['id','version','from','through','category','status']))};
  }
  if(spec.id==='worker.reviews-read'){
    requireThat(response.features.includes('Reviews'),403,'Reviews are unavailable for this employee.');
    return {reviews:response.records.reviews.filter(r=>r.companyId===scope.companyId&&r.employeeId===actor.employeeId&&r.status==='published').map(r=>brief(r,['id','title','status','version','acknowledged']))};
  }
  if(spec.id==='admin.employees-read'){
    const company=response.state.companies.find(c=>c.id===scope.companyId);
    return {employees:(company?.employees||[]).map(e=>brief(e,['id','name']))};
  }
  if(spec.id==='ledger.post')return brief(response,['revision','pendingApproval']);
  if(spec.path==='/api/projects'||spec.id==='worker.review-acknowledge')return {result:brief(response.result,['projectId','taskId','reviewId'])};
  return {ok:true};
}

export function createAddonDelegation({db,hasAccepted,audit}){
  db.exec('CREATE TABLE IF NOT EXISTS addon_delegations (addon TEXT PRIMARY KEY, grant_json TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS addon_delegated_writes (addon TEXT, client TEXT, actor TEXT, company TEXT, request_id TEXT, proposal TEXT NOT NULL, PRIMARY KEY(addon,client,actor,company,request_id))');
  const stored=id=>JSON.parse(db.prepare('SELECT grant_json FROM addon_delegations WHERE addon=?').get(id)?.grant_json||'null');
  const revoke=id=>db.prepare('DELETE FROM addon_delegations WHERE addon=?').run(id);
  const activeGrant=(id,binding)=>{
    const g=stored(id);
    return g&&g.runtime===binding.digest&&g.ownerId===binding.ownerId&&g.ownerVersion===binding.ownerVersion?g:null;
  };
  function view(id,binding){
    const g=activeGrant(id,binding);
    return {grant:g?brief(g,['clientId','accountId','role','companyId','actions']):null,
      actions:publicActions.filter(a=>binding.permissions.includes(a.read?'workspace.read':'workspace.write')),
      accounts:db.prepare('SELECT * FROM accounts WHERE active=1 ORDER BY name,id').all().map(safeUser).map(a=>brief(a,['id','name','role','assignments'])),
      companies:readBooks(db).state.companies.map(c=>brief(c,['id','name']))};
  }
  function configure(input,binding,owner){
    const {id}=input;
    requireThat(owner.id===binding.ownerId&&owner.authVersion===binding.ownerVersion&&input.confirm===true,403,'The approving owner must confirm the delegation.');
    const revoked=exact(input,['id','confirm','revoke'])&&input.revoke===true;
    tx(db,()=>{
      if(revoked){revoke(id);audit(db,owner,'','add-on delegation revoked',JSON.stringify({addonId:id}));return;}
      requireThat(exact(input,['id','clientId','companyId','accountId','actions','confirm'])&&typeof input.clientId==='string'&&clientPattern.test(input.clientId)&&typeof input.accountId==='string'&&typeof input.companyId==='string',400,'Choose a registered client, effective account and company.');
      const actor=accountFor(db,input.accountId),companies=readBooks(db).state.companies;
      requireThat(actor,403,'Choose an active effective account.');
      const bootstrap=input.companyId==='';
      requireThat(bootstrap?!companies.length&&actor.role==='owner':companies.some(c=>c.id===input.companyId)&&hasCompany(actor,input.companyId),403,'Choose a company available to the effective account.');
      requireThat(Array.isArray(input.actions)&&input.actions.length>0&&input.actions.length<=catalog.size&&new Set(input.actions).size===input.actions.length&&input.actions.every(id=>{
        const action=catalog.get(id);
        return action?.roles.includes(actor.role)&&binding.permissions.includes(action.read?'workspace.read':'workspace.write')&&(bootstrap?['workspace.status','company.create'].includes(id):id!=='company.create');
      }),403,'Choose operations permitted for this role, scope and package.');
      const grant={grantId:randomUUID(),runtime:binding.digest,ownerId:owner.id,ownerVersion:owner.authVersion,accountId:actor.id,actorVersion:actor.authVersion,role:actor.role,companyId:input.companyId,actions:input.actions,clientId:input.clientId};
      db.prepare('INSERT INTO addon_delegations VALUES(?,?) ON CONFLICT(addon) DO UPDATE SET grant_json=excluded.grant_json').run(id,JSON.stringify(grant));
      audit(db,owner,grant.companyId,'add-on delegation granted',JSON.stringify({addonId:id,...grant}));
    });
    return view(id,binding);
  }
  function resolve(op,input,id,getBinding,expectedGrant){
    const binding=getBinding();
    const {ownerId}=binding;
    try{
      requireThat(exact(input,['clientId','operation','companyId','arguments']),403,'Select an explicitly granted operation and client.');
      const g=activeGrant(id,binding),spec=catalog.get(input.operation);
      requireThat(g&&(!expectedGrant||g.grantId===expectedGrant)&&g.clientId===input.clientId&&g.companyId===input.companyId&&g.actions.includes(input.operation)&&spec&&spec.read===(op==='workspace.read'),403,'This client, company or operation has no active delegation.');
      const owner=accountFor(db,ownerId),actor=accountFor(db,g.accountId);
      requireThat(owner?.role==='owner'&&owner.authVersion===g.ownerVersion&&hasAccepted(owner),403,'The approving owner is unavailable.');
      requireThat(actor?.role===g.role&&actor.authVersion===g.actorVersion&&spec.roles.includes(actor.role)&&(!g.companyId||hasCompany(actor,g.companyId)),403,'Effective account or company authority has changed.');
      requireThat(hasAccepted(actor),428,'The effective account must accept the current Terms.');
      requireThat(object(input.arguments),400,'Supply operation arguments.');
      const request=normalRequest(spec,g.companyId,projectEdit(db,actor,g.companyId,spec,input.arguments));
      const check=()=>{
        const current=activeGrant(id,getBinding()),a=accountFor(db,g.accountId),o=accountFor(db,ownerId);
        requireThat(current?.grantId===g.grantId&&a?.authVersion===g.actorVersion&&a.role===g.role&&o?.role==='owner'&&o.authVersion===g.ownerVersion&&hasAccepted(o)&&hasAccepted(a)&&(!g.companyId||hasCompany(a,g.companyId)),403,'Workspace delegation changed.');
      };
      function recordAttempt(proposalId){
        check();
        const keys=[id,g.clientId,actor.id,g.companyId,input.arguments.requestId];
        const previous=db.prepare('SELECT proposal FROM addon_delegated_writes WHERE addon=? AND client=? AND actor=? AND company=? AND request_id=?').get(...keys);
        requireThat(!previous,409,'This request ID was already attempted. Reconcile proposal '+(previous?.proposal||'')+' before retrying.');
        db.prepare('INSERT INTO addon_delegated_writes VALUES(?,?,?,?,?,?)').run(...keys,proposalId);
      }
      return {actor,request,grantId:g.grantId,companyId:g.companyId,clientId:g.clientId,operation:spec.id,check,recordAttempt,project:response=>projectResult(spec,g,actor,response)};
    }catch(error){
      audit(db,{id:ownerId},'','add-on delegation denied',JSON.stringify({addonId:id,clientId:String(input?.clientId||'').slice(0,200),operation:String(input?.operation||'').slice(0,100),status:error.status||400}));
      throw error;
    }
  }
  return {view,configure,resolve,revoke,isCurrent:(id,binding,grantId)=>activeGrant(id,binding)?.grantId===grantId};
}
