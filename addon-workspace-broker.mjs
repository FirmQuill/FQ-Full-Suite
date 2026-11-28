// Trusted host bridge: delegated business requests use the ERP's existing HTTP authorization.
// No session, CSRF value, database handle or direct storage primitive is exposed to an add-on.
import {randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {safeUser} from './store.mjs';

const requestMax=4*1024*1024,responseMax=8*1024*1024,timeoutMs=10000;
const readRoutes=new Set(['/api/session','/api/csv-import-recovery','/api/company-knowledge','/api/drives/list','/api/drives/download',
  '/api/report-packets','/api/month-end-close','/api/month-end-close/packet','/api/planning','/api/migration','/api/collaboration/messages','/api/collaboration/groups',
  '/api/team/purchasing','/api/team/time-off','/api/worker-brand','/api/departments','/api/projects','/api/assets','/api/workspaces/search','/api/workspaces/export',
  '/api/records','/api/benefits','/api/payroll-rule-templates','/api/manual-payroll','/api/payroll/deductions','/api/approvals','/api/audit','/api/admin/users']);
const writeRoutes=new Set(['/api/action','/api/approve','/api/csv-import-recovery','/api/company-knowledge','/api/drives/upload','/api/drives/action',
  '/api/report-packets','/api/month-end-close','/api/planning','/api/migration','/api/collaboration/messages','/api/collaboration/groups','/api/team/purchasing','/api/team/time-off',
  '/api/worker-brand','/api/departments','/api/projects','/api/assets','/api/records/action','/api/benefits/action','/api/payroll-rule-templates','/api/manual-payroll',
  '/api/transfer/export','/api/transfer/preview','/api/transfer/import','/api/admin/user','/api/admin/employee-erp','/api/admin/employee-features']);
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const need=(value,status,message)=>{if(!value)fail(status,message);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const token=()=>randomBytes(32).toString('base64url');
function targetFor(input,write,delegated){
  need(plain(input)&&Object.keys(input).every(k=>(write?['path','body']:['path','query']).includes(k))&&typeof input.path==='string'&&input.path.length<=8192,400,'Choose a bounded workspace API request.');
  need(input.path.startsWith('/api/')&&!/[\\#\x00-\x20\x7f]/.test(input.path),400,'Invalid workspace API path.');
  const target=new URL(input.path,'http://127.0.0.1');
  need(target.origin==='http://127.0.0.1'&&target.pathname===input.path.split('?')[0]&&!/%/.test(target.pathname),400,'Invalid workspace API path.');
  const dynamicFile=!write&&/^\/api\/(records|benefits)\/file\/[A-Za-z0-9_-]{1,128}$/.test(target.pathname);
  const workerWrite=delegated&&write&&['/api/worker/action','/api/team/my-time-off'].includes(target.pathname);
  need((write?writeRoutes:readRoutes).has(target.pathname)||dynamicFile||workerWrite,403,'This route belongs to the host security plane or is not a supported business API.');
  if(input.query!==undefined){
    need(!write&&plain(input.query)&&Object.keys(input.query).length<=32,400,'Invalid workspace query.');
    for(const [key,value] of Object.entries(input.query)){need(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)&&typeof value==='string'&&value.length<=2048&&!target.searchParams.has(key),400,'Invalid workspace query.');target.searchParams.append(key,value);}
  }
  need(target.search.length<=8192&&[...target.searchParams].length<=32,413,'Workspace query exceeds its limit.');
  return target;
}
function redact(value,secrets,depth=0){
  need(depth<=64,413,'Workspace response is too deeply nested.');
  if(Array.isArray(value))return value.map(v=>redact(v,secrets,depth+1));
  if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!['csrf','csrftoken','xcsrftoken'].includes(key.toLowerCase().replaceAll(/[-_]/g,''))).map(([key,v])=>[key,redact(v,secrets,depth+1)]));
  if(typeof value==='string')for(const secret of secrets)value=value.replaceAll(secret,'[redacted]');
  return value;
}
export function createAddonWorkspaceBridge({db,sessions,getUrl,mainOrigin,workerOrigin,hasAccepted,audit}={}){
  need(db&&sessions instanceof Map&&typeof getUrl==='function'&&typeof hasAccepted==='function'&&typeof audit==='function',500,'Workspace bridge is not configured.');
  let pending=0;
  return async function bridge(op,input,{approval,addonId,delegated}={}){
    const requestId=randomUUID();let actor,route='/unsupported',outcome='rejected',outcomeStatus=403,lastStatus=0;
    const record=(result,status)=>{if(actor&&typeof addonId==='string'&&/^[a-z][a-z0-9-]{2,63}$/.test(addonId))audit(db,actor,delegated?.companyId||'','add-on workspace '+(op==='workspace.write'?'write':'read'),JSON.stringify({addonId,ownerId:approval.id,route,requestId,operation:op,...(delegated?{clientId:delegated.clientId,accountId:actor.id,role:actor.role,action:delegated.operation,grantId:delegated.grantId}:{}),outcome:result,status}));};
    async function perform(){
    need(['workspace.read','workspace.write'].includes(op),403,'Unsupported workspace operation.');
    need(typeof addonId==='string'&&/^[a-z][a-z0-9-]{2,63}$/.test(addonId),400,'Invalid add-on identity.');
    const write=op==='workspace.write';
    const authorize=()=>{
      need(exact(approval,['id','authVersion'])&&typeof approval.id==='string'&&Number.isSafeInteger(approval.authVersion),403,'A current owner approval is required.');
      const owner=safeUser(db.prepare('SELECT * FROM accounts WHERE id=?').get(approval.id));
      actor=delegated?.actor||owner;
      need(owner?.active&&owner.role==='owner'&&owner.authVersion===approval.authVersion,403,'The approving owner is no longer authorized.');
      need(hasAccepted(owner),428,'The approving owner must accept the current Terms.');delegated?.check();return actor;
    };
    const effective=authorize(),portal=effective.role==='worker'?'worker':'main',origin=portal==='worker'?workerOrigin:mainOrigin;
    const target=targetFor(input,write,delegated),base=new URL(getUrl(portal));route=target.pathname;
    need(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.pathname==='/'&&!base.search&&!base.hash&&!base.username&&!base.password,500,'Workspace bridge requires its own loopback portal.');
    const publicUrl=new URL(origin||base.origin);need(publicUrl.origin===(origin||base.origin)&&(!origin||publicUrl.protocol==='https:'),500,'Invalid portal origin.');
    need(pending<4&&sessions.size<10000,429,'Workspace bridge is busy.');pending++;
    const sid=token(),csrf=token(),now=Date.now(),session={userId:effective.id,authVersion:effective.authVersion,portal,csrf,until:now+30000,absolute:now+30000,...(delegated?{checkDelegation:delegated.check}:{})};
    sessions.set(sid,session);
    const headers={Host:publicUrl.host,Origin:publicUrl.origin,Cookie:(publicUrl.protocol==='https:'?'__Host-fq_':'fq_')+portal+'='+sid,'X-FirmQuill-Addon-Request':requestId};
    async function call(path,body,rawHeaders){
      authorize();let payload;
      if(body!==undefined){payload=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));need(payload.length<=requestMax,413,'Workspace request exceeds 4 MiB.');}
      const response=await new Promise((resolve,reject)=>{
        const req=httpRequest({hostname:'127.0.0.1',port:base.port,path,method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json','Content-Length':payload.length,'X-CSRF-Token':csrf}),...rawHeaders}},res=>{
          const parts=[];let size=0;
          res.on('data',chunk=>{size+=chunk.length;if(size>responseMax){res.destroy();req.destroy(Object.assign(Error('Workspace response exceeds 8 MiB.'),{status:413}));}else parts.push(chunk);});
          res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(parts)}));res.on('error',reject);
        });
        const deadline=setTimeout(()=>req.destroy(Object.assign(Error('Workspace request timed out.'),{status:504})),timeoutMs);req.once('close',()=>clearTimeout(deadline));
        req.setTimeout(timeoutMs,()=>req.destroy(Object.assign(Error('Workspace request timed out.'),{status:504})));req.on('error',reject);if(payload)req.write(payload);req.end();
      });
      lastStatus=response.status;authorize();const contentType=String(response.headers['content-type']||'application/octet-stream');let value;
      if(contentType.toLowerCase().startsWith('application/json')){try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));}catch{fail(502,'Workspace returned invalid JSON.');}}
      else value={contentType,content:response.bytes.toString('base64url')};
      if(response.status<200||response.status>=300)fail(response.status,typeof value?.error==='string'?redact(value.error,[sid,csrf]):'Workspace request was rejected.');
      return redact(value,[sid,csrf]);
    }
    try{
      let body=input.body,rawHeaders;
      if(write){
        need(plain(body),400,'Workspace writes require a JSON object.');
        if(target.pathname==='/api/drives/upload'){
          need(exact(body,['filename','content'])&&typeof body.filename==='string'&&body.filename.length<=200&&typeof body.content==='string'&&/^[A-Za-z0-9_-]*$/.test(body.content),400,'Drive upload requires filename and base64url content.');
          const bytes=Buffer.from(body.content,'base64url');need(bytes.toString('base64url')===body.content&&bytes.length<=requestMax,413,'Invalid or oversized drive upload.');
          rawHeaders={'Content-Type':'application/octet-stream','X-Drive-Filename':encodeURIComponent(body.filename)};body=bytes;
        }
        if(target.pathname==='/api/transfer/import'){
          const preview=await call('/api/transfer/preview',{envelope:body.envelope,password:body.password});
          need(preview.digest===body.digest&&preview.revision===body.revision,409,'The migration preview changed; review this proposal again.');
        }
        // A durable attempt precedes dispatch; the target API also audits its committed action.
        authorize();record('started',0);
      }
      const result=await call(target.pathname+target.search,write?body:undefined,rawHeaders);
      return delegated?delegated.project(result):result;
    }finally{sessions.delete(sid);pending--;}
    }
    try{const value=await perform();outcome='success';outcomeStatus=lastStatus||200;return value;}
    catch(error){outcomeStatus=Number.isInteger(error.status)?error.status:502;throw error;}
    finally{record(outcome,outcomeStatus);}
  };
}
