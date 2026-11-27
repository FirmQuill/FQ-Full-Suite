import {companyKnowledgeView,companyKnowledgeCommand} from './company-knowledge.mjs';
import {createPrivateFtps} from './ftps.mjs';
import {initializeCollaborationGroups,groupAdminView,groupAdminCommand} from './collaboration-groups.mjs';
import {initializeMessaging,messagingView,messagingCommand,latestMessageId} from './messaging.mjs';
import {catchUpPlanning,localPlanningDay,planningCommand,planningOf,planningSummary} from './shared/planning-core.mjs';
import {initializeManualPayroll,manualPayrollView,manualPayrollStoreCommand,manualPayrollPortableState} from './manual-payroll-store.mjs';
import {portableDeskState,portableDeskReport} from './portable-desk.mjs';
import {ownerDeskMigrationReports} from './desk-migration.mjs';
import {departmentView,departmentCommand} from './departments.mjs';
import {projectView,projectCommand,visibleProjectJobs,projectBusinessState} from './project-workspace.mjs';
import {assetsView,assetsCommand} from './assets-workspace.mjs';
import {createDriveService,createDriveRoutes} from './file-drives.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {termsVersion,termsText} from './web/legal/terms.mjs';
import {legacyAgreement} from './web/legal/consent.mjs';
import {openStore,tx,readBooks,saveBooks,revisionCheck,audit,safeUser,owner,scoped,passwordHash,passwordMatches,putUser,actionFor,approvalList,decide,auditEvents,requireThat,workerView,workerCommand} from './store.mjs';
import {inspectLite,exportLite,assertEmptyDestination} from './transfer.mjs';
import {recordsView,recordsCommand,recordFile,employeeProfile} from './records.mjs';
import {benefitsView,benefitsCommand,benefitFile,effectivePayrollDeductions} from './benefits.mjs';
import {createIdentityService} from './identity.mjs';
import {brandingSettings,saveWorkerBranding,workerBranding,workerBrandLogo} from './branding.mjs';
import {accountAreas,requireArea,ERP_AREAS,saveAreas,WORKER_FEATURES,workerFeatures,requireWorkerFeature,workerRecords} from './access.mjs';
import {migrationView,migrationCommand} from './migration.mjs';
import {createAgentService} from './agent-access.mjs';
import {createSupportService} from './support.mjs';
import {createSetupPackage} from './setup-package.mjs';
import {initializeTeamWorkflows,teamPages,purchasingView,purchasingCommand,myLeave,workerLeaveCommand,reviewLeave,reviewLeaveCommand} from './team-workflows.mjs';

const token=()=>randomBytes(32).toString('base64url');
const termsHash=createHash('sha256').update(termsText.replace(/\r\n?/g,'\n')).digest('hex');
const mime={html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png'};
const common=new Set(['app.css','mark.svg','headquarters.png','core.mjs','views.mjs','interop.mjs','payroll-rules.mjs','manual-payroll.mjs','manual-payroll-ui.mjs','file-drive-ui.mjs','knowledge-content.mjs','messaging-ui.mjs','planning-core.mjs','planning-views.mjs','warehouse-desk.mjs']);
const mainFiles=new Set(['index.html','app.mjs','suite.css','administration.mjs','record-admin.mjs','benefit-admin.mjs','identity-admin.mjs','connected-admin.mjs','department-workspace.mjs','assets-workspace.mjs','team-workflows.mjs','company-knowledge.mjs','private-ftps-ui.mjs','audit.html']);
const workerFiles=new Set(['index.html','app.mjs','worker.css','selfservice.mjs']);
const deny=(n,msg)=>requireThat(false,n,msg);
const publicUser=u=>{const {authVersion,...fields}=u;return {...fields,version:authVersion};};
async function jsonBody(req,max){
  requireThat(['application/json','application/scim+json'].includes(req.headers['content-type']?.split(';')[0].trim().toLowerCase()),415,'Send JSON.');
  requireThat(!req.headers['content-length']||Number(req.headers['content-length'])<=max,413,'Request exceeds size limit.');
  const parts=[];let total=0;
  for await(const p of req){total+=p.length;requireThat(total<=max,413,'Request exceeds size limit.');parts.push(p);}
  let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{deny(400,'Invalid JSON.');}
  requireThat(data&&typeof data==='object'&&!Array.isArray(data),400,'Invalid request body.');
  return data;
}
function send(res,status,value){res.writeHead(status,{'Content-Type':res.getHeader('Content-Type')||'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function createSuite({database,mainPort=4179,workerPort=4180,mainOrigin,workerOrigin,identityOptions={},supportOptions={},ftpsOptions={},ftpsTransport,driveFactory,planningClock=localPlanningDay,planningIntervalMs=60_000}){
  const db=openStore(database),sessions=new Map(),attempts=new Map();
  initializeTeamWorkflows(db);
  initializeCollaborationGroups(db);
  initializeMessaging(db);
  initializeManualPayroll(db);
  const driveService=createDriveService(db), driveRoutes=createDriveRoutes(driveService);
  if(termsVersion===legacyAgreement.version&&termsHash===legacyAgreement.hash){
    db.prepare('INSERT OR IGNORE INTO terms_acceptance_hashes(account_id,version,content_hash,accepted_at) SELECT account_id,version,?,accepted_at FROM terms_acceptances WHERE version=?').run(termsHash,termsVersion);
  }
  const agents=createAgentService({db});
  const support=createSupportService(supportOptions);
  const privateFtps=createPrivateFtps({options:ftpsOptions,drive:driveFactory?driveFactory(db):driveService,transport:ftpsTransport,onSuccess:(user,company,detail)=>audit(db,user,company,'private-ftps',detail)});
  const identity=createIdentityService({db,database,readBooks,saveBooks,passwordHash,putUser,...identityOptions});
  const dummyHash=await passwordHash(token()),servers=[];
  let expensive=0,planningTimer;
  const refreshRecurring=()=>tx(db,()=>{const next=catchUpPlanning(readBooks(db).state,planningClock());if(next.generated)saveBooks(db,next.state);});
  const runRecurring=()=>{try{refreshRecurring();}catch{process.emitWarning('FirmQuill could not refresh recurring drafts. Review the workspace and retry.');}};
  async function limited(fn){requireThat(expensive<4,429,'Server busy. Try again shortly.');expensive++;try{return await fn();}finally{expensive--;}}
  const storeSession=(id,s)=>{for(const [k,v] of sessions)if(v.until<=Date.now()||v.absolute<=Date.now())sessions.delete(k);
    requireThat(sessions.size<10000,429,'Session capacity reached.');sessions.set(id,s);};
  function userFor(session,portal){
    requireThat(session?.portal===portal&&session.until>Date.now()&&session.absolute>Date.now(),401,'Sign in again.');
    const u=safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(session.userId));
    requireThat(u&&u.authVersion===session.authVersion&&(u.role==='worker')===(portal==='worker'),401,'Sign in again.');
    if(u.employeeId&&u.assignments.length===1)requireThat(!['inactive','disabled','deactivated','terminated'].includes(employeeProfile(db,readBooks(db).state,u.assignments[0],u.employeeId).employmentStatus),401,'Employee access is disabled.');
    if(u.role!=='worker'&&u.employeeId)requireThat(db.prepare('SELECT enabled FROM employee_erp_flags WHERE company=? AND employee=?').get(u.assignments[0],u.employeeId)?.enabled,401,'ERP access is disabled.');
    session.until=Date.now()+30*60000;return u;
  }
  function workspacePagesFor(user,state){
    if(user.role==='owner')return ['Departments','Project tracker','Assets & pallets','Inventory audit','Company knowledge','Messages','Collaboration groups',...teamPages(db,user)];
    const pages=[],departments=departmentView(db,user,state),projects=projectView(db,user,state);
    if(departments.workspaces.length)pages.push('Departments');
    if(projects.projects.length||departments.workspaces.some(w=>w.rights.includes('manage')))pages.push('Project tracker');
    const rights=new Set();for(const c of state.companies){try{for(const right of assetsView(db,user,state,{companyId:c.id}).rights)rights.add(right);}catch{}}if(['view','manage'].some(r=>rights.has(r)))pages.push('Assets & pallets');
    if(['audit','approve'].some(r=>rights.has(r)))pages.push('Inventory audit');
    return [...pages,...(user.assignments.length&&accountAreas(db,user).includes('Company knowledge')?['Company knowledge']:[]),...teamPages(db,user),...(accountAreas(db,user).includes('Messages')&&state.companies.some(c=>user.assignments.includes(c.id))?['Messages']:[])];
  }
  function snapshot(user,s,extras={}){
    if(!hasAccepted(user))return {termsRequired:termsVersion,csrf:s.csrf};
    const {state,revision}=readBooks(db);
    const features=s.portal==='worker'?workerFeatures(db,user):[];
    const time=s.portal==='worker'?workerView(db,user,state):null;
    return s.portal==='worker'?{user:{id:user.id,name:user.name,role:'worker'},csrf:s.csrf,features,...(features.includes('Drives')?{driveCompanyId:user.assignments[0]}:{}),branding:workerBranding(db,state,user.assignments[0]),data:features.includes('Time')?time:{company:time.company,employee:time.employee,timezone:time.timezone},records:workerRecords(db,user,(()=>{const r=recordsView(db,user,state),allowed=new Set(state.companies.flatMap(c=>visibleProjectJobs(db,user,c)).map(j=>j.id));if(r.jobs)r.jobs=r.jobs.filter(j=>allowed.has(j.id));return r;})()),benefits:features.includes('Benefits')?benefitsView(db,user,state):null,leave:features.includes('Time off')?myLeave(db,user,state):null}:
      {user:{...publicUser(user),areas:accountAreas(db,user),workspaces:workspacePagesFor(user,state)},csrf:s.csrf,state:scoped(user,state,db),revision,portalLinks:{main:mainOrigin||'http://127.0.0.1:'+servers[0]?.address()?.port,worker:workerOrigin||'http://127.0.0.1:'+servers[1]?.address()?.port},...extras};
  }
  function hasAccepted(user){return !!db.prepare('SELECT 1 FROM terms_acceptance_hashes WHERE account_id=? AND version=? AND content_hash=?').get(user.id,termsVersion,termsHash);}
  function portalServer(portal,publicOrigin){
    return createServer(async(req,res)=>{
      const localPort=req.socket.localPort;
      const origin=publicOrigin||'http://127.0.0.1:'+localPort;
      const secure=origin.startsWith('https://');
      const cookieName=(secure?'__Host-':'')+'fq_'+portal;
      const setCookie=(value,age)=>{const existing=res.getHeader('Set-Cookie'),cookies=existing?(Array.isArray(existing)?existing:[existing]):[];res.setHeader('Set-Cookie',[...cookies,cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+age+(secure?'; Secure':'')]);};
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('X-Frame-Options','DENY');
      try{
        requireThat(req.headers.host===new URL(origin).host||req.headers.host==='127.0.0.1:'+localPort,403,'Unknown host.');
        const url=new URL(req.url,origin),path=url.pathname;
        if(!path.startsWith('/api/')){
          requireThat(req.method==='GET'||req.method==='HEAD',405,'Method unavailable.');
          let name=path==='/'?'index.html':path==='/audit'&&portal==='main'?'audit.html':path.slice(1),root='web/'+portal+'/';
          if(path.startsWith('/legal/')){
            name=path.slice(7);requireThat(['terms.mjs','consent.mjs','terms-ui.mjs','terms.css','account.mjs','privacy.html','privacy.css'].includes(name),404,'File unavailable.');root='web/legal/';
          }else if(path.startsWith('/shared/')){
            name=path.slice(8);requireThat(common.has(name)&&(portal==='main'||['app.css','mark.svg','headquarters.png','file-drive-ui.mjs','knowledge-content.mjs','messaging-ui.mjs'].includes(name)),404,'File unavailable.');root='shared/';
          }else requireThat((portal==='main'?mainFiles:workerFiles).has(name),404,'File unavailable.');
          const bytes=await readFile(new URL('./'+root+name,import.meta.url));res.writeHead(200,{'Content-Type':mime[name.split('.').pop()]});res.end(req.method==='HEAD'?undefined:bytes);return;
        }
        if(path.startsWith('/api/agents/')){
          requireThat(portal==='main',404,'Endpoint unavailable.');
          const body=req.method==='POST'?await jsonBody(req,64*1024):undefined;
          send(res,200,await agents.request(req.method,url,req.headers,body));return;
        }
        if(path.startsWith('/api/scim/')){
          requireThat(portal==='main',404,'Endpoint unavailable.');
          try{
            const body=['POST','PUT','PATCH'].includes(req.method)?await jsonBody(req,256*1024):undefined;
            const result=await identity.scim(req.method,url,req.headers,body);
            res.writeHead(result.status,result.headers);res.end(result.status===204?undefined:JSON.stringify(result.body));return;
          }catch(e){
            const status=e.status||400;res.writeHead(status,{'Content-Type':'application/scim+json; charset=utf-8'});res.end(JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],status:String(status),detail:status===500?'Identity storage unavailable.':e.message}));return;
          }
        }
        const post=req.method==='POST';requireThat(post||req.method==='GET',405,'Method unavailable.');
        if(post)requireThat(req.headers.origin===origin,403,'Origin does not match this portal.');
        const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim()),sid=cookies.find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1),s=sessions.get(sid);
        if(path==='/api/identity/providers'&&!post){send(res,200,{providers:identity.providers(portal)});return;}
        if(path==='/api/identity/invite/accept'&&post){
          const p=await jsonBody(req,4096);await limited(()=>identity.acceptInvite(p.token,p.password));send(res,200,{ok:true});return;
        }
        if(path==='/api/identity/oidc/start'&&!post){
          const result=await identity.beginOidc(url.searchParams.get('id'),origin+'/api/identity/oidc/callback',portal);
          res.setHeader('Set-Cookie','fq_oidc_binding='+result.binding+'; HttpOnly; SameSite=Lax; Path=/; Max-Age=600'+(secure?'; Secure':''));
          res.writeHead(302,{Location:result.redirect});res.end();return;
        }
        if(path==='/api/identity/oidc/callback'&&!post){
          const binding=cookies.find(x=>x.startsWith('fq_oidc_binding='))?.slice(16);
          res.setHeader('Set-Cookie','fq_oidc_binding=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'+(secure?'; Secure':''));
          const result=await identity.finishOidc(url.searchParams,origin+'/api/identity/oidc/callback',binding);
          const u=safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(result.userId));
          requireThat(u&&(u.role==='worker')===(portal==='worker'),401,'Identity is unavailable for this portal.');
          const fresh={userId:u.id,authVersion:u.authVersion,portal,csrf:token(),until:Date.now()+30*60000,absolute:Date.now()+12*3600000},key=token();
          userFor(fresh,portal);storeSession(key,fresh);setCookie(key,43200);res.writeHead(302,{Location:'/'});res.end();return;
        }
        if(path==='/api/login'&&post){
          const p=await jsonBody(req,4096),username=String(p.username??'').trim().toLowerCase();
          const now=Date.now(),ip=req.socket.remoteAddress;
          for(const [k,b] of attempts)if(b.until<=now)attempts.delete(k);
          const keys=['user/'+username,'ip/'+ip];
          for(const [i,k] of keys.entries()){
            const b=attempts.get(k)||{count:0,until:now+300000};requireThat(b.count<(i?100:10),429,'Too many attempts. Try again in five minutes.');b.count++;attempts.set(k,b);
          }
          const row=db.prepare('SELECT * FROM accounts WHERE username=? AND active=1').get(username);
          const ok=await limited(()=>passwordMatches(p.password,row?.hash||dummyHash));
          const u=row&&safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(row.id));
          requireThat(ok&&u&&row.authVersion===u.authVersion&&(u.role==='worker')===(portal==='worker'),401,'Credentials are invalid for this portal.');
          const fresh={userId:u.id,authVersion:u.authVersion,portal,csrf:token(),until:now+30*60000,absolute:now+12*3600000},key=token();
          userFor(fresh,portal);const data=snapshot(u,fresh);attempts.delete(keys[0]);if(s?.portal===portal)sessions.delete(sid);storeSession(key,fresh);setCookie(key,43200);send(res,200,data);return;
        }
        const u=userFor(s,portal);
        if(post)requireThat(req.headers['x-csrf-token']===s.csrf,403,'Reload before making changes.');
        if(path==='/api/session'&&!post){send(res,200,snapshot(u,s));return;}
        if(path==='/api/logout'&&post){sessions.delete(sid);setCookie('',0);send(res,200,{ok:true});return;}
        if(path==='/api/terms'&&post){
          const body=await jsonBody(req,512);requireThat(sessions.get(sid)===s,401,'Sign in again.');const account=userFor(s,portal);
          requireThat(body.version===termsVersion&&body.hash===termsHash,409,'Terms changed. Reload to read the current version.');
          tx(db,()=>{db.prepare('INSERT INTO terms_acceptance_hashes(account_id,version,content_hash,accepted_at) VALUES(?,?,?,?) ON CONFLICT(account_id,version,content_hash) DO NOTHING').run(account.id,termsVersion,termsHash,new Date().toISOString());});
          send(res,200,snapshot(account,s));return;
        }
        requireThat(hasAccepted(u),428,'Read and agree to the Terms of Service first.');
        if(path==='/api/company-knowledge'){
          const companyId=url.searchParams.get('companyId')||undefined;
          if(post){
            requireThat(portal==='main',403,'Employee portal is read-only.');
            const input=await jsonBody(req,192*1024);
            const result=tx(db,()=>{
              const active=userFor(s,portal),value=companyKnowledgeCommand(db,active,readBooks(db).state,companyId,input);
              audit(db,active,companyId,'company knowledge '+value.operation,value.id+(value.version?' · version '+value.version:''));
              return value;
            });send(res,200,{result});return;
          }
          send(res,200,companyKnowledgeView(db,u,readBooks(db).state,{companyId,id:url.searchParams.get('id'),q:url.searchParams.get('q'),version:url.searchParams.get('version')}));return;
        }
        if(path==='/api/private-ftps'){
          requireThat(portal==='main',404,'Endpoint unavailable.');
          const current=()=>{requireThat(sessions.get(sid)===s,401,'Sign in again.');const user=userFor(s,portal);requireThat(hasAccepted(user),428,'Read and agree to the Terms of Service first.');return user;};
          if(post){const body=await jsonBody(req,4096);send(res,200,await privateFtps.command(current,body));}
          else send(res,200,privateFtps.status(u,{companyId:url.searchParams.get('companyId'),groupId:url.searchParams.get('groupId'),folderId:url.searchParams.get('folderId')}));
          return;
        }
        if(path.startsWith('/api/drives/')){
          await driveRoutes({req,res,url,user:u,readJson:max=>jsonBody(req,max),reauthorize:()=>{
            requireThat(sessions.get(sid)===s,401,'Sign in again.');
            const active=userFor(s,portal);requireThat(hasAccepted(active),428,'Read and agree to the Terms of Service first.');return active;
          }});return;
        }
        if(path==='/api/support/info'&&!post){send(res,200,await support.info());return;}
        if(path==='/api/support/search'&&!post){send(res,200,await support.search(url.searchParams.get('q')||''));return;}
        if(path==='/api/support/article'&&!post){send(res,200,await support.article(url.searchParams.get('id')));return;}
        if(path==='/api/support/answer'&&post){const p=await jsonBody(req,4096);send(res,200,await support.answer(p.question));return;}
        if(portal==='main'&&path==='/api/planning'){
          owner(u);
          if(post){
            const p=await jsonBody(req,64*1024);requireThat(p.action&&typeof p.action==='object',400,'Choose a planning action.');
            const count=tx(db,()=>{const active=userFor(s,portal);owner(active);const {revision,state}=readBooks(db);revisionCheck(revision,p.revision);
              const next=planningCommand(state,p.companyId,p.action,planningClock());saveBooks(db,next.state);
              audit(db,active,p.companyId,'planning '+p.action.type,'Company planning workflow');return next.generated;});
            send(res,200,snapshot(userFor(s,portal),s,{generatedDrafts:count}));return;
          }
          const {state}=readBooks(db),companyId=url.searchParams.get('companyId');
          const c=state.companies.find(c=>c.id===companyId);requireThat(c,404,'Company unavailable.');
          const rows=departmentView(db,u,state,{companyId}).workspaces.flatMap(w=>(w.records||[]).filter(x=>x.kind==='contract'));
          const today=planningClock(),extra=rows.map(r=>({id:r.sourceLiteId||r.id,name:r.title,date:(r.contractStatus||r.sourceStatus||(r.status==='done'?'Closed':'Active'))==='Active'?r.dueDate:''}));
          send(res,200,{day:today,data:planningOf(c),summary:planningSummary(c,today,extra)});return;
        }
        if(portal==='main'&&path==='/api/migration'){
          const result=post?migrationCommand(db,userFor(s,portal),await jsonBody(req,4*1024*1024)):migrationView(db,u);
          send(res,200,result.packageRequested?createSetupPackage(result.dataset,result.approval):result);return;
        }
        if(portal==='main'&&path==='/api/agent-admin'&&!post){send(res,200,agents.view(u));return;}
        if(portal==='main'&&path==='/api/agent-admin/action'&&post){const p=await jsonBody(req,64*1024);send(res,200,agents.command(userFor(s,portal),p));return;}
        const {state:workforceState}=readBooks(db),scope={companyId:url.searchParams.get('companyId')||undefined,employeeId:url.searchParams.get('employeeId')||undefined};
        if(path==='/api/collaboration/messages'||portal==='main'&&path==='/api/collaboration/groups'){
          const messages=path.endsWith('/messages');
          const companyId=portal==='worker'?u.assignments[0]:scope.companyId;
          const params={companyId,state:workforceState};
          if(!post){
            send(res,200,messages?messagingView(db,u,params,{threadId:url.searchParams.get('threadId'),before:url.searchParams.get('before')}):groupAdminView(db,u,params));
            return;
          }
          const p=await jsonBody(req,48*1024);
          requireThat(sessions.get(sid)===s,401,'Sign in again.');
          const result=tx(db,()=>{
            const active=userFor(s,portal);
            requireThat(hasAccepted(active),428,'Read and agree to the Terms of Service first.');
            const fresh={companyId:portal==='worker'?active.assignments[0]:companyId,state:readBooks(db).state};
            return messages?messagingCommand(db,active,fresh,p.action):groupAdminCommand(db,active,fresh,p.action,{latestMessageId:latestMessageId(db)});
          });
          send(res,200,result);return;
        }
        if(portal==='main'&&['/api/team/purchasing','/api/team/time-off'].includes(path)){
          const purchasing=path.endsWith('/purchasing');
          if(!post){send(res,200,purchasing?purchasingView(db,u,workforceState,scoped(u,workforceState,db),scope.companyId):reviewLeave(db,u,workforceState,scope.companyId));return;}
          const p=await jsonBody(req,24*1024);requireThat(p.action&&typeof p.action==='object',400,'Specify a team request action.');
          const result=tx(db,()=>{const active=userFor(s,portal),{state}=readBooks(db);return purchasing?purchasingCommand(db,active,state,scoped(active,state,db),p.action):reviewLeaveCommand(db,active,state,p.action);});
          send(res,200,result);return;
        }
        if(portal==='worker'&&path==='/api/team/my-time-off'&&post){
          const p=await jsonBody(req,8192);requireThat(p.action&&typeof p.action==='object',400,'Specify a time-off action.');
          const active=userFor(s,portal);tx(db,()=>workerLeaveCommand(db,active,readBooks(db).state,p.action));
          send(res,200,snapshot(active,s));return;
        }
        if(portal==='worker'&&path==='/api/worker-brand/logo'&&!post){
          const logo=workerBrandLogo(db,workforceState,u.assignments[0]);requireThat(logo,404,'Company logo unavailable.');res.writeHead(200,{'Content-Type':logo.mime});res.end(logo.bytes);return;
        }
        if(portal==='main'&&path==='/api/worker-brand'){
          owner(u);if(!post){send(res,200,brandingSettings(db,workforceState,scope.companyId));return;}
          const p=await jsonBody(req,720*1024);
          const result=tx(db,()=>{const active=userFor(s,portal);owner(active);const result=saveWorkerBranding(db,readBooks(db).state,p);audit(db,active,p.companyId,'worker portal branding updated',JSON.stringify({mode:result.mode,parent:result.parent,hasLogo:result.hasLogo}));return result;});
          send(res,200,result);return;
        }
        if(portal==='main'&&['/api/departments','/api/projects','/api/assets'].includes(path)){
          const kind=path.slice(5);
          if(!post){const view=kind==='departments'?departmentView(db,u,workforceState,scope):kind==='projects'?projectView(db,u,workforceState,scope):assetsView(db,u,workforceState,{...scope,auditOnly:url.searchParams.get('auditOnly')==='true'});if(kind==='departments'&&u.role==='owner'&&scope.companyId)view.ownerDeskConversions=ownerDeskMigrationReports(db,scope.companyId);send(res,200,view);return;}
          const payload=await jsonBody(req,512*1024);requireThat(payload.action&&typeof payload.action==='object',400,'Choose a workspace action.');
          const result=tx(db,()=>{const active=userFor(s,portal),{state}=readBooks(db);const result=kind==='departments'?departmentCommand(db,active,state,payload.action):kind==='projects'?projectCommand(db,active,state,payload.action):assetsCommand(db,active,state,payload.action);if(result.state)saveBooks(db,result.state);return result.result||result;});
          send(res,200,{result});return;
        }
        if(portal==='main'&&['/api/workspaces/search','/api/workspaces/export'].includes(path)&&!post){
          const departments=departmentView(db,u,workforceState,scope),projects=projectView(db,u,workforceState,scope);
          if(path.endsWith('/export')){audit(db,u,scope.companyId||'','authorized workspace export','Permission-scoped records');send(res,200,{format:'firmquill.authorized-workspaces.v1',version:'0.4.0-preview.1',departments:departments.workspaces,projects:projects.projects});return;}
          const q=String(url.searchParams.get('q')||'').trim().toLowerCase();requireThat(q.length<=160,400,'Search within 160 characters.');
          const rows=[...departments.workspaces.flatMap(w=>(w.records||[]).map(r=>({id:r.id,type:r.kind,title:r.title}))),...projects.projects.flatMap(p=>[{id:p.id,type:'project',title:p.name},...(p.tasks||[]).map(t=>({id:t.id,type:'task',title:t.title}))])];
          send(res,200,{results:rows.filter(r=>!q||r.title.toLowerCase().includes(q)).slice(0,250)});return;
        }
        if(path==='/api/records'&&!post){if(portal==='main')requireArea(db,u,'Employee records');const r=recordsView(db,u,workforceState,scope);if(r.jobs){const allowed=new Set(workforceState.companies.flatMap(c=>visibleProjectJobs(db,u,c)).map(j=>j.id));r.jobs=r.jobs.filter(j=>allowed.has(j.id));}send(res,200,portal==='worker'?workerRecords(db,u,r):r);return;}
        if(path==='/api/benefits'&&!post){if(portal==='main')requireArea(db,u,'Benefits administration');else requireWorkerFeature(db,u,'Benefits');send(res,200,benefitsView(db,u,workforceState,scope));return;}
        if(path.startsWith('/api/records/file/')&&!post){if(portal==='main')requireArea(db,u,'Employee records');else requireWorkerFeature(db,u,'Pay');const f=recordFile(db,u,workforceState,decodeURIComponent(path.slice(18)));res.writeHead(200,{'Content-Type':f.mime,'Content-Disposition':'attachment; filename="'+f.filename.replace(/[^a-zA-Z0-9._-]/g,'_')+'"'});res.end(f.bytes);return;}
        if(path.startsWith('/api/benefits/file/')&&!post){if(portal==='main')requireArea(db,u,'Benefits administration');else requireWorkerFeature(db,u,'Benefits');const f=benefitFile(db,u,workforceState,decodeURIComponent(path.slice(19)));res.writeHead(200,{'Content-Type':f.mime,'Content-Disposition':'attachment; filename="'+f.filename.replace(/[^a-zA-Z0-9._-]/g,'_')+'"'});res.end(f.bytes);return;}
        if(post&&['/api/records/action','/api/benefits/action'].includes(path)){
          const kind=path.includes('/records/')?'records':'benefits';if(portal==='main')requireArea(db,u,kind==='records'?'Employee records':'Benefits administration');
          const p=await jsonBody(req,15*1024*1024);
          if(portal==='worker')requireWorkerFeature(db,u,kind==='benefits'?'Benefits':p.action?.type==='review-acknowledge'?'Reviews':'My Profile');
          const result=tx(db,()=>{const active=userFor(s,portal),{state}=readBooks(db);return kind==='records'?recordsCommand(db,active,state,p.action):benefitsCommand(db,active,state,p.action);});
          send(res,200,{result,...(portal==='worker'?snapshot(userFor(s,portal),s):{})});return;
        }
        if(portal==='main'&&path==='/api/identity'&&!post){requireArea(db,u,'Identity connectors');send(res,200,identity.view(u,workforceState,scope));return;}
        if(portal==='main'&&path==='/api/identity/action'&&post){requireArea(db,u,'Identity connectors');const p=await jsonBody(req,2*1024*1024);const result=await identity.command(u,workforceState,p.action);send(res,200,{result});return;}
        if(portal==='main'&&path==='/api/manual-payroll'){
          if(!post){send(res,200,manualPayrollView(db,u,workforceState,scope.companyId));return;}
          const input=await jsonBody(req,64*1024);
          const result=tx(db,()=>manualPayrollStoreCommand(db,userFor(s,portal),readBooks(db).state,scope.companyId,input));
          send(res,200,result);return;
        }
        if(portal==='main'&&path==='/api/payroll/deductions'&&!post){requireArea(db,u,'Payroll');send(res,200,{deductions:effectivePayrollDeductions(db,u,workforceState,scope.companyId,url.searchParams.get('payDate'))});return;}
        if(portal==='main'&&path==='/api/admin/employee-erp'&&post){
          owner(u);const p=await jsonBody(req,16384),c=workforceState.companies.find(c=>c.id===p.companyId);
          requireThat(c?.employees.some(e=>e.id===p.employeeId)&&typeof p.enabled==='boolean'&&Array.isArray(p.areas)&&p.areas.every(a=>ERP_AREAS.includes(a)),400,'Choose an employee and permitted ERP areas.');
          tx(db,()=>{db.prepare('INSERT INTO employee_erp_flags VALUES(?,?,?,?) ON CONFLICT(company,employee) DO UPDATE SET enabled=excluded.enabled,areas=excluded.areas').run(p.companyId,p.employeeId,Number(p.enabled),JSON.stringify(p.areas));
            for(const row of db.prepare("SELECT * FROM accounts WHERE employeeId=? AND role NOT IN ('owner','worker')").all(p.employeeId))if(JSON.parse(row.assignments).includes(p.companyId))db.prepare('UPDATE accounts SET active=?,authVersion=authVersion+1 WHERE id=?').run(Number(p.enabled),row.id);
            audit(db,u,p.companyId,'ERP access flags',JSON.stringify({employeeId:p.employeeId,enabled:p.enabled,areas:p.areas}));});send(res,200,{ok:true});return;
        }
        if(portal==='main'&&path==='/api/admin/employee-features'&&post){
          owner(u);const p=await jsonBody(req,16384),c=workforceState.companies.find(c=>c.id===p.companyId);
          requireThat(c?.employees.some(e=>e.id===p.employeeId)&&Array.isArray(p.features)&&new Set(p.features).size===p.features.length&&p.features.every(f=>WORKER_FEATURES.includes(f)),400,'Choose valid employee features.');
          requireThat(p.features.includes('Time')||!db.prepare('SELECT 1 FROM worker_shifts WHERE company=? AND employee=? AND ended IS NULL').get(p.companyId,p.employeeId),409,'Close the employee’s open shift before disabling Time.');
          tx(db,()=>{db.prepare('INSERT INTO employee_portal_flags VALUES(?,?,?) ON CONFLICT(company,employee) DO UPDATE SET features=excluded.features').run(p.companyId,p.employeeId,JSON.stringify(p.features));audit(db,u,p.companyId,'employee feature flags',JSON.stringify({employeeId:p.employeeId,features:p.features}));});send(res,200,{ok:true});return;
        }
        if(portal==='worker'){
          requireThat(post&&path==='/api/worker/action',403,'Worker portal access only.');
          requireWorkerFeature(db,u,'Time');const p=await jsonBody(req,16384);requireThat(sessions.get(sid)===s,401,'Sign in again.');const active=userFor(s,portal);
          tx(db,()=>{const {state}=readBooks(db);workerCommand(db,active,state,p.action);audit(db,active,active.assignments[0],'worker '+p.action.type,'Clock or correction event');});
          send(res,200,snapshot(active,s));return;
        }
        if(!post){
          if(path==='/api/admin/users'){owner(u);send(res,200,{workerFeatureOptions:WORKER_FEATURES,erpAreaOptions:ERP_AREAS,users:db.prepare('SELECT * FROM accounts ORDER BY name,username').all().map(r=>({...publicUser(safeUser(r)),areas:accountAreas(db,safeUser(r)),configured:!!r.hash&&!r.hash.startsWith('!pending-invite:')})),employeeErp:db.prepare('SELECT * FROM employee_erp_flags').all().map(r=>({...r,enabled:!!r.enabled,areas:JSON.parse(r.areas)})),employeeFeatures:db.prepare('SELECT * FROM employee_portal_flags').all().map(r=>({...r,features:JSON.parse(r.features)}))});return;}
          if(path==='/api/approvals'){requireArea(db,u,'Approvals');send(res,200,{approvals:approvalList(db,u)});return;}
          if(path==='/api/audit'){requireArea(db,u,'Audit trail');send(res,200,{events:auditEvents(db,u)});return;}
          deny(404,'Endpoint unavailable.');
        }
        const transfer=path.startsWith('/api/transfer/');
        if(transfer||path==='/api/admin/user')owner(u);
        const p=await jsonBody(req,transfer?48*1024*1024:3*1024*1024);
        const active=()=>{requireThat(sessions.get(sid)===s,401,'Sign in again.');return userFor(s,portal);};
        let extras={};
        if(path==='/api/action'){if(p.action&&!p.action.requestId)p.action.requestId=p.requestId;extras=tx(db,()=>actionFor(db,active(),p));}
        else if(path==='/api/approve'){requireArea(db,u,'Approvals');tx(db,()=>decide(db,active(),p));}
        else if(path==='/api/admin/user'){
          if(!['worker','owner'].includes(p.role)){
            requireThat(Array.isArray(p.areas),400,'Select the ERP areas for this login.');
            if(p.employeeId&&p.active!==false){const flag=db.prepare('SELECT * FROM employee_erp_flags WHERE company=? AND employee=?').get(p.assignments?.[0],p.employeeId);requireThat(flag?.enabled&&p.areas.every(a=>JSON.parse(flag.areas).includes(a)),403,'Enable this employee’s ERP access and areas first.');}
          }
          const hash=p.password?await limited(()=>passwordHash(p.password)):null;
          const id=tx(db,()=>putUser(db,active(),p,hash));
          for(const [key,v] of sessions)if(v.userId===id&&key!==sid)sessions.delete(key);
          if(id===s.userId)s.authVersion=db.prepare('SELECT authVersion FROM accounts WHERE id=?').get(id).authVersion;
        }else if(transfer){
          owner(active());
          if(path==='/api/transfer/export'){
            const {state}=readBooks(db);requireThat(state.companies.length,400,'Create or import books first.');
            const portable=manualPayrollPortableState(db,portableDeskState(db,state)),deskReport=portableDeskReport(portable);const result=await limited(()=>exportLite(portable,p.password));owner(active());tx(db,()=>audit(db,u,'','export','Encrypted owner snapshot'));send(res,200,{...result,deskReport});return;
          }
          requireThat(['/api/transfer/preview','/api/transfer/import'].includes(path),404,'Endpoint unavailable.');
          assertEmptyDestination(readBooks(db).state);
          const plan=await limited(()=>inspectLite(p.envelope,p.password));owner(active());
          if(path.endsWith('preview')){
            const {revision,state}=readBooks(db);assertEmptyDestination(state);s.preview={digest:plan.digest,revision};
            send(res,200,{digest:plan.digest,summary:plan.summary,revision});return;
          }
          tx(db,()=>{
            const {revision,state}=readBooks(db);assertEmptyDestination(state);revisionCheck(revision,p.revision);
            requireThat(s.preview?.revision===revision&&s.preview?.digest===plan.digest&&plan.digest===p.digest,409,'Preview this backup again.');
            saveBooks(db,plan.state);audit(db,u,'','import','Encrypted Lite migration · '+plan.digest);
          });delete s.preview;
        }else deny(404,'Endpoint unavailable.');
        send(res,200,snapshot(active(),s,extras));
      }catch(e){
        const status=e.status||((e.code||'').startsWith('ERR_SQLITE')||e.code==='ENOENT'?500:400);
        if(!res.headersSent&&!res.destroyed)send(res,status,{error:status===500?'Storage or application file unavailable.':e.message||'Request failed.'});
      }
    });
  }
  try{
    for(const [portal,port,origin] of [['main',mainPort,mainOrigin],['worker',workerPort,workerOrigin]]){
      if(origin)requireThat(new URL(origin).origin===origin&&new URL(origin).protocol==='https:',400,'Company portal origins require exact HTTPS origins.');
      const server=portalServer(portal,origin);server.requestTimeout=45000;server.headersTimeout=15000;
      await new Promise((yes,no)=>server.once('error',no).listen(port,'127.0.0.1',yes));servers.push(server);
    }
  }catch(e){for(const srv of servers)srv.close();db.close();throw e;}
  runRecurring();planningTimer=setInterval(runRecurring,planningIntervalMs);planningTimer.unref();
  return {mainUrl:'http://127.0.0.1:'+servers[0].address().port,workerUrl:'http://127.0.0.1:'+servers[1].address().port,
    async close(){clearInterval(planningTimer);await Promise.all(servers.map(srv=>new Promise(r=>{srv.close(r);srv.closeIdleConnections();})));sessions.clear();db.close();}};
}

export {createSuite};

