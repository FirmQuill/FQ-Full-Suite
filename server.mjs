import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openStore,tx,readBooks,saveBooks,revisionCheck,audit,safeUser,owner,scoped,passwordHash,passwordMatches,putUser,actionFor,approvalList,decide,auditEvents,requireThat,workerView,workerCommand} from './store.mjs';
import {inspectLite,exportLite,assertEmptyDestination} from './transfer.mjs';

const token=()=>randomBytes(32).toString('base64url');
const mime={html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png'};
const common=new Set(['app.css','mark.svg','headquarters.png','core.mjs','views.mjs','interop.mjs','payroll-rules.mjs']);
const mainFiles=new Set(['index.html','app.mjs','suite.css','administration.mjs']);
const workerFiles=new Set(['index.html','app.mjs','worker.css']);
const deny=(n,msg)=>requireThat(false,n,msg);
const publicUser=u=>{const {authVersion,...fields}=u;return {...fields,version:authVersion};};
async function jsonBody(req,max){
  requireThat(req.headers['content-type']?.split(';')[0]==='application/json',415,'Send JSON.');
  requireThat(!req.headers['content-length']||Number(req.headers['content-length'])<=max,413,'Request exceeds size limit.');
  const parts=[];let total=0;
  for await(const p of req){total+=p.length;requireThat(total<=max,413,'Request exceeds size limit.');parts.push(p);}
  let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{deny(400,'Invalid JSON.');}
  requireThat(data&&typeof data==='object'&&!Array.isArray(data),400,'Invalid request body.');
  return data;
}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function createSuite({database,mainPort=4179,workerPort=4180,mainOrigin,workerOrigin}){
  const db=openStore(database),sessions=new Map(),attempts=new Map();
  const dummyHash=await passwordHash(token()),servers=[];
  let expensive=0;
  async function limited(fn){requireThat(expensive<4,429,'Server busy. Try again shortly.');expensive++;try{return await fn();}finally{expensive--;}}
  const storeSession=(id,s)=>{for(const [k,v] of sessions)if(v.until<=Date.now()||v.absolute<=Date.now())sessions.delete(k);
    requireThat(sessions.size<10000,429,'Session capacity reached.');sessions.set(id,s);};
  function userFor(session,portal){
    requireThat(session?.portal===portal&&session.until>Date.now()&&session.absolute>Date.now(),401,'Sign in again.');
    const u=safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(session.userId));
    requireThat(u&&u.authVersion===session.authVersion&&(u.role==='worker')===(portal==='worker'),401,'Sign in again.');
    session.until=Date.now()+30*60000;return u;
  }
  function snapshot(user,s,extras={}){
    const {state,revision}=readBooks(db);
    return s.portal==='worker'?{user:{id:user.id,name:user.name,role:'worker'},csrf:s.csrf,data:workerView(db,user,state)}:
      {user:publicUser(user),csrf:s.csrf,state:scoped(user,state),revision,...extras};
  }
  function portalServer(portal,publicOrigin){
    return createServer(async(req,res)=>{
      const localPort=req.socket.localPort;
      const origin=publicOrigin||'http://127.0.0.1:'+localPort;
      const secure=origin.startsWith('https://');
      const cookieName=(secure?'__Host-':'')+'fq_'+portal;
      const setCookie=(value,age)=>res.setHeader('Set-Cookie',cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+age+(secure?'; Secure':''));
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('X-Frame-Options','DENY');
      try{
        requireThat(req.headers.host===new URL(origin).host||req.headers.host==='127.0.0.1:'+localPort,403,'Unknown host.');
        const path=req.url;
        if(!path.startsWith('/api/')){
          requireThat(req.method==='GET'||req.method==='HEAD',405,'Method unavailable.');
          let name=path==='/'?'index.html':path.slice(1),root='web/'+portal+'/';
          if(path.startsWith('/shared/')){
            name=path.slice(8);requireThat(common.has(name)&&(portal==='main'||['app.css','mark.svg','headquarters.png'].includes(name)),404,'File unavailable.');root='shared/';
          }else requireThat((portal==='main'?mainFiles:workerFiles).has(name),404,'File unavailable.');
          const bytes=await readFile(new URL('./'+root+name,import.meta.url));res.writeHead(200,{'Content-Type':mime[name.split('.').pop()]});res.end(req.method==='HEAD'?undefined:bytes);return;
        }
        const post=req.method==='POST';requireThat(post||req.method==='GET',405,'Method unavailable.');
        if(post)requireThat(req.headers.origin===origin,403,'Origin does not match this portal.');
        const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim()),sid=cookies.find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1),s=sessions.get(sid);
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
          const data=snapshot(u,fresh);attempts.delete(keys[0]);if(s?.portal===portal)sessions.delete(sid);storeSession(key,fresh);setCookie(key,43200);send(res,200,data);return;
        }
        const u=userFor(s,portal);
        if(post)requireThat(req.headers['x-csrf-token']===s.csrf,403,'Reload before making changes.');
        if(path==='/api/session'&&!post){send(res,200,snapshot(u,s));return;}
        if(path==='/api/logout'&&post){sessions.delete(sid);setCookie('',0);send(res,200,{ok:true});return;}
        if(portal==='worker'){
          requireThat(post&&path==='/api/worker/action',403,'Worker portal access only.');
          const p=await jsonBody(req,16384);requireThat(sessions.get(sid)===s,401,'Sign in again.');const active=userFor(s,portal);
          tx(db,()=>{const {state}=readBooks(db);workerCommand(db,active,state,p.action);audit(db,active,active.assignments[0],'worker '+p.action.type,'Clock or correction event');});
          send(res,200,snapshot(active,s));return;
        }
        if(!post){
          if(path==='/api/admin/users'){owner(u);send(res,200,{users:db.prepare('SELECT * FROM accounts ORDER BY name,username').all().map(r=>publicUser(safeUser(r)))});return;}
          if(path==='/api/approvals'){send(res,200,{approvals:approvalList(db,u)});return;}
          if(path==='/api/audit'){send(res,200,{events:auditEvents(db,u)});return;}
          deny(404,'Endpoint unavailable.');
        }
        const transfer=path.startsWith('/api/transfer/');
        if(transfer||path==='/api/admin/user')owner(u);
        const p=await jsonBody(req,transfer?48*1024*1024:3*1024*1024);
        const active=()=>{requireThat(sessions.get(sid)===s,401,'Sign in again.');return userFor(s,portal);};
        let extras={};
        if(path==='/api/action'){if(p.action&&!p.action.requestId)p.action.requestId=p.requestId;extras=tx(db,()=>actionFor(db,active(),p));}
        else if(path==='/api/approve'){tx(db,()=>decide(db,active(),p));}
        else if(path==='/api/admin/user'){
          const hash=p.password?await limited(()=>passwordHash(p.password)):null;
          const id=tx(db,()=>putUser(db,active(),p,hash));
          for(const [key,v] of sessions)if(v.userId===id&&key!==sid)sessions.delete(key);
          if(id===s.userId)s.authVersion=db.prepare('SELECT authVersion FROM accounts WHERE id=?').get(id).authVersion;
        }else if(transfer){
          owner(active());
          if(path==='/api/transfer/export'){
            const {state}=readBooks(db);requireThat(state.companies.length,400,'Create or import books first.');
            const result=await limited(()=>exportLite(state,p.password));owner(active());tx(db,()=>audit(db,u,'','export','Encrypted owner snapshot'));send(res,200,result);return;
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
  return {mainUrl:'http://127.0.0.1:'+servers[0].address().port,workerUrl:'http://127.0.0.1:'+servers[1].address().port,
    async close(){await Promise.all(servers.map(srv=>new Promise(r=>{srv.close(r);srv.closeIdleConnections();})));sessions.clear();db.close();}};
}

export {createSuite};

