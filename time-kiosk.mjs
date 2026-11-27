import {randomBytes,randomInt,randomUUID,createHash} from 'node:crypto';
import {owner,tx,readBooks,safeUser,passwordHash,passwordMatches,audit,requireThat,workerCommand} from './store.mjs';
import {requireWorkerFeature} from './access.mjs';
import {employeeProfile} from './records.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const token=/^[A-Za-z0-9_-]{43}$/;
const isToken=value=>typeof value==='string'&&token.test(value);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const minute=60_000,day=24*60*minute,pairedLifetime=30*day;
const unavailable='Punch unavailable. Check your worker ID and PIN, or ask your supervisor.';
const only=(p,keys)=>requireThat(p&&Object.keys(p).every(k=>keys.includes(k)),400,'Unexpected kiosk input.');
export function initializeTimeKiosk(db){
  db.exec(`CREATE TABLE IF NOT EXISTS time_kiosks(id TEXT PRIMARY KEY, company TEXT NOT NULL, job TEXT NOT NULL, label TEXT NOT NULL,
  pair_hash TEXT UNIQUE, pair_until INTEGER, device_hash TEXT UNIQUE, device_until INTEGER, revoked INTEGER);
  CREATE TABLE IF NOT EXISTS time_kiosk_workers(device TEXT NOT NULL REFERENCES time_kiosks(id),account TEXT NOT NULL REFERENCES accounts(id),
  auth_version INTEGER NOT NULL, pin_hash TEXT NOT NULL, PRIMARY KEY(device,account));
  CREATE TABLE IF NOT EXISTS time_kiosk_receipts(device TEXT NOT NULL, request TEXT NOT NULL, account TEXT NOT NULL,
  action TEXT NOT NULL, requested_at INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(device,request));
  CREATE TABLE IF NOT EXISTS time_kiosk_limits(device TEXT NOT NULL, span INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(device,span));`);
}
export function createTimeKiosk({db,accepted,pinWork}){
  const get=id=>db.prepare('SELECT * FROM time_kiosks WHERE id=? AND revoked IS NULL').get(id);
  const device=code=>isToken(code)&&db.prepare('SELECT * FROM time_kiosks WHERE device_hash=? AND revoked IS NULL AND device_until>?').get(hash(code),Date.now());
  const book=company=>readBooks(db).state.companies.find(c=>c.id===company);
  const accounts=()=>db.prepare("SELECT * FROM accounts WHERE active=1 AND role='worker'").all();
  function worker(r,k,{requireTerms=true}={}){
    const u=safeUser(r);
    requireThat(u?.role==='worker'&&u.active&&u.assignments.length===1&&u.assignments[0]===k.company,403,unavailable);
    requireThat(!['inactive','disabled','deactivated','terminated'].includes(employeeProfile(db,readBooks(db).state,k.company,u.employeeId).employmentStatus),403,unavailable);
    requireWorkerFeature(db,u,'Time');
    if(requireTerms)requireThat(accepted(u),403,unavailable);
    return u;
  }
  function usable(k){return !!k&&!!book(k.company)?.jobs.some(j=>j.id===k.job);}
  function view(u,companyId){
    owner(u);const c=book(companyId);requireThat(c,404,'Company unavailable.');
    const jobs=c.jobs.map(j=>({id:j.id,name:j.name}));
    const workers=accounts().flatMap(row=>{try{const u=worker(row,{company:companyId},{requireTerms:false});return [{id:u.id,name:u.name,username:u.username,termsCurrent:accepted(u)}];}catch{return [];}});
    const names=new Map(workers.map(w=>[w.id,w]));
    const kiosks=db.prepare('SELECT id,job,label,pair_until,device_until,revoked FROM time_kiosks WHERE company=? ORDER BY label,id').all(companyId).map(({id,job,label,pair_until,device_until,revoked})=>({id,job,label,
      status:revoked?'revoked':device_until>Date.now()?'paired':pair_until>Date.now()?'awaiting pairing':'expired',
      staff:db.prepare('SELECT account FROM time_kiosk_workers WHERE device=?').all(id).map(row=>names.get(row.account)??{id:row.account,name:'Unavailable worker'})}));
    return {jobs,workers,kiosks};
  }
  async function admin(p,live){
    let u=live();owner(u);const now=Date.now();
    if(p.type==='create'){
      only(p,['type','company','job','label']);
      const c=book(p.company),label=typeof p.label==='string'?p.label.trim():'';
      requireThat(c?.jobs.some(j=>j.id===p.job)&&label.length>0&&label.length<=80,400,'Choose a company job and a station label of 1–80 characters.');
      const id=randomUUID(),pairCode=secret();
      return tx(db,()=>{
        requireThat(db.prepare('SELECT count(*) AS n FROM time_kiosks WHERE company=? AND revoked IS NULL').get(c.id).n<50,409,'Revoke an unused station first.');
        db.prepare('INSERT INTO time_kiosks(id,company,job,label,pair_hash,pair_until) VALUES(?,?,?,?,?,?)').run(id,c.id,p.job,label,hash(pairCode),now+15*minute);
        audit(db,u,c.id,'kiosk created','Station '+id);return {pairCode};
      });
    }
    only(p,['type','id',...(p.type==='pin'||p.type==='remove-worker'?['account']:[])]);
    requireThat(typeof p.id==='string'&&uuid.test(p.id),400,'Choose a station.');
    const k=get(p.id);requireThat(k,404,'Station unavailable.');
    if(p.type==='re-pair')return tx(db,()=>{
      requireThat(usable(k),409,'The assigned job is unavailable.');const pairCode=secret();
      db.prepare('UPDATE time_kiosks SET pair_hash=?,pair_until=?,device_hash=NULL,device_until=NULL WHERE id=?').run(hash(pairCode),now+15*minute,k.id);
      audit(db,u,k.company,'kiosk pairing rotated','Station '+k.id);return {pairCode};
    });
    if(p.type==='revoke')return tx(db,()=>{
      db.prepare('UPDATE time_kiosks SET revoked=?,pair_hash=NULL,device_hash=NULL WHERE id=?').run(now,k.id);
      db.prepare('DELETE FROM time_kiosk_workers WHERE device=?').run(k.id);
      audit(db,u,k.company,'kiosk revoked','Station '+k.id);return {ok:true};
    });
    if(p.type==='remove-worker')return tx(db,()=>{
      requireThat(typeof p.account==='string'&&p.account.length<=120,400,'Choose an assigned worker.');
      db.prepare('DELETE FROM time_kiosk_workers WHERE device=? AND account=?').run(k.id,p.account);
      audit(db,u,k.company,'kiosk worker removed','Station '+k.id+' account '+p.account);return {ok:true};
    });
    requireThat(p.type==='pin'&&usable(k),400,'Choose a valid station action.');
    requireThat(typeof p.account==='string'&&p.account.length<=120,400,'Choose an active worker.');
    const find=()=>worker(db.prepare('SELECT * FROM accounts WHERE id=?').get(p.account),k);
    const w=find(),pin=String(randomInt(10_000_000_000)).padStart(10,'0');
    const digest=await pinWork(()=>passwordHash(k.id+':'+pin));
    return tx(db,()=>{u=live();owner(u);
      requireThat(usable(get(k.id))&&find().authVersion===w.authVersion,409,'Station or worker access changed. Refresh and try again.');
      db.prepare(`INSERT INTO time_kiosk_workers(device,account,auth_version,pin_hash) VALUES(?,?,?,?)
      ON CONFLICT(device,account) DO UPDATE SET auth_version=excluded.auth_version,pin_hash=excluded.pin_hash`).run(k.id,w.id,w.authVersion,digest);
      audit(db,u,k.company,'kiosk PIN issued','Station '+k.id+' account '+w.id);
      return {workerId:w.username,pin};
    });
  }
  const peers=new Map();
  function pair(p,peer){
    only(p,['code']);const now=Date.now();
    for(const [key,value] of peers)if(value.until<=now)peers.delete(key);
    requireThat(peers.has(peer)||peers.size<1024,429,'Too many pairing attempts. Try again shortly.');
    const item=peers.get(peer)??{count:0,until:now+5*minute};item.count++;peers.set(peer,item);
    requireThat(item.count<=15,429,'Too many pairing attempts. Try again shortly.');
    return tx(db,()=>{
      const k=isToken(p.code)&&db.prepare('SELECT * FROM time_kiosks WHERE pair_hash=? AND revoked IS NULL AND pair_until>?').get(hash(p.code),now);
      requireThat(usable(k),403,'Pairing code is unavailable.');
      const value=secret(),until=now+pairedLifetime;
      db.prepare('UPDATE time_kiosks SET pair_hash=NULL,pair_until=NULL,device_hash=?,device_until=? WHERE id=?').run(hash(value),until,k.id);
      audit(db,{id:'time-kiosk:'+k.id},k.company,'kiosk paired','Station '+k.id);
      return {value,maxAge:pairedLifetime/1000,label:k.label};
    });
  }
  async function punch(code,p,dummyHash){
    const k=device(code);requireThat(usable(k),401,'This station is not paired. Ask your supervisor.');
    only(p,['workerId','pin','action','request','requestedAt']);
    const start=Date.now();
    function timeOK(now){return Number.isSafeInteger(p.requestedAt)&&p.requestedAt>=now-2*minute&&p.requestedAt<=now+30_000;}
    requireThat(typeof p.request==='string'&&uuid.test(p.request)&&timeOK(start)&&['clock-in','clock-out'].includes(p.action)&&typeof p.workerId==='string'&&p.workerId.length<=120&&typeof p.pin==='string'&&/^\d{10}$/.test(p.pin),400,'Enter a worker ID and 10-digit PIN, then choose a punch.');
    const span=Math.floor(start/(5*minute));
    tx(db,()=>{
      db.prepare('DELETE FROM time_kiosk_limits WHERE span<?').run(span-2);
      db.prepare('DELETE FROM time_kiosk_receipts WHERE created<?').run(start-10*minute);
      const used=db.prepare('SELECT attempts FROM time_kiosk_limits WHERE device=? AND span=?').get(k.id,span)?.attempts??0;
      requireThat(used<60,429,'Station temporarily paused. Try again in five minutes or use your usual time clock.');
      db.prepare('INSERT INTO time_kiosk_limits VALUES(?,?,1) ON CONFLICT(device,span) DO UPDATE SET attempts=attempts+1').run(k.id,span);
    });
    const find=()=>db.prepare("SELECT a.*, w.auth_version, w.pin_hash FROM accounts a JOIN time_kiosk_workers w ON w.account=a.id WHERE w.device=? AND a.username=?").get(k.id,p.workerId.trim().toLowerCase());
    const r=find();
    const open=row=>row&&db.prepare('SELECT id,job FROM worker_shifts WHERE company=? AND employee=? AND user_id=? AND ended IS NULL').get(k.company,row.employeeId,row.id);
    const initialOpen=p.action==='clock-out'?open(r):null;
    const valid=await pinWork(()=>passwordMatches(k.id+':'+p.pin,r?.pin_hash??dummyHash));
    return tx(db,()=>{
      const now=Date.now(),station=device(code),fresh=find();
      requireThat(usable(station)&&station.id===k.id,401,'This station is not paired. Ask your supervisor.');
      requireThat(timeOK(now),409,'That attempt timed out. Enter your worker ID and PIN again.');
      requireThat(valid&&fresh&&fresh.id===r?.id&&fresh.pin_hash===r.pin_hash&&fresh.authVersion===fresh.auth_version,403,unavailable);
      const u=worker(fresh,k);
      const cached=db.prepare('SELECT * FROM time_kiosk_receipts WHERE device=? AND request=?').get(k.id,p.request);
      if(cached){
        requireThat(cached.account===u.id&&cached.action===p.action&&cached.requested_at===p.requestedAt,409,'This attempt no longer matches. Try again.');
        return {action:p.action};
      }
      if(p.action==='clock-out')requireThat(initialOpen?.job===k.job&&open(fresh)?.id===initialOpen.id,409,'No matching shift at this station. Use the original station or your usual time clock.');
      const action=p.action==='clock-in'?{type:p.action,jobId:k.job}:{type:p.action,shiftId:initialOpen.id};
      workerCommand(db,u,readBooks(db).state,action,new Date(now));
      db.prepare('INSERT INTO time_kiosk_receipts VALUES(?,?,?,?,?,?)').run(k.id,p.request,u.id,p.action,p.requestedAt,now);
      audit(db,u,k.company,'worker '+p.action,'Shared time kiosk '+k.id);
      return {action:p.action};
    });
  }
  return {view,admin,pair,punch,status:code=>{const k=device(code);return usable(k)?{paired:true,label:k.label}:{paired:false};}};
}
