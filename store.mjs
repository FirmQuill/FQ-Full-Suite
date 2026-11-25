import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {newVault,apply,validateState} from './shared/core.mjs';
import {initializeWorker,workerPending,workerReview,workerView,workerCommand} from './worker.mjs';

const kdf=promisify(scrypt);
const empty={format:'fieldledger.erp',edition:'Lite',schema:1,currency:'USD',companies:[],groups:[]};
const roles=['owner','manager','bookkeeper','viewer','worker'];
function requireThat(ok,status,message){if(!ok)throw Object.assign(new Error(message),{status});}
function openStore(filename){
  const db=new DatabaseSync(filename);
  try{
    const marker=db.prepare('PRAGMA application_id').get().application_id,ver=db.prepare('PRAGMA user_version').get().user_version;
    const occupied=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    requireThat((marker===1179735372&&ver===1)||(!occupied&&!marker&&!ver),400,'Unsupported database. Select a FirmQuill version 1 database or a new file.');
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    tx(db,()=>{
      db.exec(`PRAGMA application_id=1179735372; PRAGMA user_version=1;
        CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,assignments TEXT NOT NULL,employeeId TEXT NOT NULL,active INTEGER NOT NULL,hash TEXT NOT NULL,authVersion INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,companyId TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,companyId TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,requestedBy TEXT NOT NULL,action TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL,requestId TEXT NOT NULL,fingerprint TEXT NOT NULL,approval TEXT,PRIMARY KEY(actor,requestId));`);
      db.prepare('INSERT OR IGNORE INTO books VALUES(1,0,?)').run(JSON.stringify(empty));
      initializeWorker(db);
    });
    return db;
  }catch(e){db.close();throw e;}
}
function tx(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
function readBooks(db){const r=db.prepare('SELECT revision,body FROM books WHERE id=1').get();return {revision:r.revision,state:JSON.parse(r.body)};}
function revisionCheck(n,expected){requireThat(Number.isSafeInteger(expected)&&n===expected,409,'The workspace changed. Refresh and review before saving.');}
function saveBooks(db,state){
  validateState(state);
  const raw=JSON.stringify(state);requireThat(Buffer.byteLength(raw)<=32*1024*1024,413,'The portable books exceed 32 MiB.');
  db.prepare('UPDATE books SET body=?,revision=revision+1 WHERE id=1').run(raw);
}
function audit(db,user,company,kind,detail){db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),user.id,company||'',kind,detail);}
function safeUser(row){return row&&{id:row.id,username:row.username,name:row.name,role:row.role,assignments:JSON.parse(row.assignments),employeeId:row.employeeId,active:!!row.active,authVersion:row.authVersion};}
function canAccess(u,c){return u.role==='owner'||u.assignments.includes(c);}
function owner(u){requireThat(u.role==='owner',403,'Owner access required.');}
function manager(u){requireThat(['owner','manager'].includes(u.role),403,'Manager access required.');}
function scoped(u,state){
  const allowed=state.companies.filter(c=>canAccess(u,c.id));
  return {...state,companies:allowed,groups:state.groups.filter(g=>g.members.every(k=>canAccess(u,k)))};
}
async function passwordHash(password){
  requireThat(typeof password==='string'&&password.length>=12&&Buffer.byteLength(password)<=512,400,'Choose a password of 12–512 characters within 512 UTF-8 bytes.');
  const salt=randomBytes(16).toString('hex'),key=await kdf(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return salt+':'+key.toString('hex');
}
async function passwordMatches(password,encoded){
  if(typeof password!=='string'||Buffer.byteLength(password)>512)return false;
  const [salt,hex]=encoded.split(':');const key=await kdf(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return timingSafeEqual(key,Buffer.from(hex,'hex'));
}
function putUser(db,actor,input,hashed,{bootstrap=false}={}){
  if(!bootstrap)owner(actor);
  const existing=input.id?db.prepare('SELECT * FROM accounts WHERE id=?').get(input.id):null;
  requireThat(!input.id||existing,404,'Account does not exist.');
  if(existing)revisionCheck(existing.authVersion,input.version);
  const username=String(input.username??'').trim().toLowerCase(),name=String(input.name??'').trim(),role=input.role;
  requireThat(/^[a-z0-9][a-z0-9_.@-]{1,79}$/.test(username)&&name&&name.length<=160&&roles.includes(role),400,'Check username, display name and role.');
  requireThat(hashed||existing,400,'New accounts need an individual password.');
  const active=input.active??true;requireThat(typeof active==='boolean',400,'Invalid account status.');
  requireThat(!existing||existing.id!==actor.id||(active&&role==='owner'),400,'An owner cannot remove their own access.');
  const assignments=role==='owner'?[]:input.assignments;
  const {state}=readBooks(db);requireThat(Array.isArray(assignments)&&assignments.every(k=>state.companies.some(c=>c.id===k))&&new Set(assignments).size===assignments.length,400,'Select valid companies.');
  const employeeId=role==='worker'?input.employeeId:'';
  if(existing?.role==='worker'&&(employeeId!==existing.employeeId||JSON.stringify(assignments)!==existing.assignments)){
    requireThat(!db.prepare('SELECT 1 FROM worker_shifts WHERE user_id=? AND ended IS NULL').get(existing.id),409,'Close the original worker shift before changing its employee or company assignment.');
  }
  if(role==='worker'){
    requireThat(assignments.length===1&&state.companies.find(c=>c.id===assignments[0])?.employees.some(p=>p.id===employeeId),400,'Select one company and a linked employee.');
    const linked=db.prepare("SELECT id,assignments FROM accounts WHERE role='worker' AND employeeId=? AND active=1").all(employeeId);
    requireThat(!active||!linked.some(r=>r.id!==existing?.id&&JSON.parse(r.assignments)[0]===assignments[0]),409,'This employee already has an active worker login.');
    const open=db.prepare('SELECT user_id FROM worker_shifts WHERE company=? AND employee=? AND ended IS NULL').get(assignments[0],employeeId);
    requireThat(!active||!open||open.user_id===existing?.id,409,'Resolve the open shift under the original worker account.');
  }
  const taken=db.prepare('SELECT id FROM accounts WHERE username=?').get(username);
  requireThat(!taken||taken.id===existing?.id,409,'This username already exists.');
  const id=existing?.id||randomUUID();
  db.prepare(`INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,role=excluded.role,assignments=excluded.assignments,employeeId=excluded.employeeId,active=excluded.active,hash=excluded.hash,authVersion=excluded.authVersion`)
    .run(id,username,name,role,JSON.stringify(assignments),employeeId,Number(active),hashed||existing.hash,(existing?.authVersion||0)+1);
  audit(db,actor||{id},'','access',existing?'Updated account '+id:'Created account '+id);
  return id;
}
function authorizeAction(user,state,companyId,a){
  const isEmpty=!state.companies.length;
  requireThat(['owner','manager','bookkeeper'].includes(user.role),403,'Write access required.');
  requireThat(a&&typeof a.type==='string'&&typeof a.requestId==='string'&&/^[a-zA-Z0-9_-]{8,120}$/.test(a.requestId),400,'A stable request ID is required.');
  requireThat((isEmpty&&a.type==='company'&&companyId==='')||(state.companies.some(c=>c.id===companyId)&&canAccess(user,companyId)),403,'Company access denied.');
  if(['company','intercompany','group'].includes(a.type))owner(user);
  if(['settings','close','approve time'].includes(a.type))manager(user);
}
const directBookkeeper=new Set(['contact','item','job','time','quote','sales order','purchase order','attachment']);
function actionFor(db,user,payload){
  const {state,revision}=readBooks(db),{companyId,action}=payload;
  authorizeAction(user,state,companyId,action);
  const signature=createHash('sha256').update(JSON.stringify([companyId,action])).digest('hex');
  const old=db.prepare('SELECT * FROM requests WHERE actor=? AND requestId=?').get(user.id,action.requestId);
  if(old){requireThat(old.fingerprint===signature,409,'That request ID belongs to a different operation.');return old.approval?{pendingApproval:old.approval}:{};}
  revisionCheck(revision,payload.revision);
  const next=state.companies.length?apply(state,companyId,action):newVault(action.name,action.activities||[]);
  validateState(next);
  let approval=null;
  if(user.role==='bookkeeper'&&!directBookkeeper.has(action.type)){
    approval=randomUUID();db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run(approval,companyId,action.type,String(action.label||action.name||action.type),'pending',user.id,JSON.stringify(action));
    db.prepare('UPDATE books SET revision=revision+1').run();
    audit(db,user,companyId,'submitted',action.type+' · '+approval);
  }else{
    saveBooks(db,next);audit(db,user,companyId||next.companies[0].id,'posted',action.type+' · '+action.requestId);
    if(action.type==='intercompany')audit(db,user,action.other,'posted','Incoming intercompany charge · '+action.requestId);
  }
  db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(user.id,action.requestId,signature,approval);
  return approval?{pendingApproval:approval}:{};
}
function approvalList(db,u){
  requireThat(['owner','manager','bookkeeper'].includes(u.role),403,'Approval access denied.');
  const list=db.prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY rowid").all().filter(r=>canAccess(u,r.companyId)&&(u.role!=='bookkeeper'||r.requestedBy===u.id)).map(r=>{
    const {action,...fields}=r;const a=JSON.parse(action);
    const detail=JSON.stringify(a,(k,v)=>k==='data'?'[attachment]':v);
    return {...fields,detail};
  });
  return u.role==='bookkeeper'?list:[...list,...workerPending(db,u,readBooks(db).state)];
}
function decide(db,user,p){
  manager(user);const {revision,state}=readBooks(db);revisionCheck(revision,p.revision);
  requireThat(typeof p.id==='string'&&['approve','reject'].includes(p.decision),400,'Select a request and decision.');
  if(p.id.startsWith('w-')){
    const pending=workerPending(db,user,state).find(r=>r.id===p.id);requireThat(pending,404,'No visible pending worker request.');
    const next=workerReview(db,user,state,p.id,p.decision);saveBooks(db,next);audit(db,user,pending.companyId,'time '+p.decision,p.id);return;
  }
  const r=db.prepare('SELECT * FROM approvals WHERE id=?').get(p.id);
  requireThat(r&&canAccess(user,r.companyId),404,'Approval is unavailable.');
  requireThat(r.status==='pending'&&r.requestedBy!==user.id,409,'Approval already decided or requested by this user.');
  if(p.decision==='approve')saveBooks(db,apply(state,r.companyId,JSON.parse(r.action)));
  else db.prepare('UPDATE books SET revision=revision+1').run();
  db.prepare('UPDATE approvals SET status=? WHERE id=?').run(p.decision==='approve'?'approved':'rejected',r.id);
  audit(db,user,r.companyId,p.decision,r.kind+' · '+r.id);
}
function auditEvents(db,u){manager(u);const cols='SELECT at,actor,companyId,kind,detail FROM audit';
  if(u.role==='owner')return db.prepare(cols+' ORDER BY id DESC LIMIT 500').all();
  if(!u.assignments.length)return [];
  return db.prepare(cols+' WHERE companyId IN ('+u.assignments.map(()=>'?').join(',')+') ORDER BY id DESC LIMIT 500').all(...u.assignments);
}

export {openStore,tx,readBooks,saveBooks,revisionCheck,audit,safeUser,owner,scoped,passwordHash,passwordMatches,putUser,actionFor,approvalList,decide,auditEvents,requireThat,workerView,workerCommand};

