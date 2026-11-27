import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstat,realpath,readFile,readdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,join,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupDatabase,MAX_DATABASE_BYTES} from './recovery.mjs';
import {audit,owner,requireThat,tx} from './store.mjs';

const app=dirname(fileURLToPath(import.meta.url)), noPolicy={scope:'',dailyUTC:'',beforeCommit:false,retain:3};
const inside=(where,path)=>{const rel=relative(where,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'));};
const iso=d=>d.toISOString();
const retryAfter=15*60*1000;
const allowedCode=new Set(['backup-unavailable','size-limit','storage-failure','encrypted-archive-present']);
const eventType=new Set(['reviewed-lite-import']);
export function backupOptionsFromEnv(env=process.env){return {directory:env.FIRMQUILL_BACKUP_DIRECTORY,keyFile:env.FIRMQUILL_BACKUP_KEY_FILE};}

export function createScheduledBackups({db,database,options={},clock=()=>new Date(),archive=backupDatabase}){
  db.exec(`CREATE TABLE IF NOT EXISTS full_backup_policy(
    id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,daily_utc TEXT NOT NULL,
    before_commit INTEGER NOT NULL,retain INTEGER NOT NULL,version INTEGER NOT NULL
  )`);
  const dbPolicy=()=>db.prepare('SELECT scope,daily_utc AS dailyUTC,before_commit AS beforeCommit,retain,version FROM full_backup_policy WHERE id=1').get();
  const policy=()=>{
    const p=dbPolicy();
    if(p)requireThat(/^[a-f0-9-]{36}$/.test(p.scope)&&[0,1].includes(p.beforeCommit)&&Number.isInteger(p.retain)&&p.retain>=2&&p.retain<=10&&(!p.dailyUTC||/^([01]\d|2[0-3]):[0-5]\d$/.test(p.dailyUTC)),500,'The stored backup policy could not be loaded.');
    return p?{...p,beforeCommit:!!p.beforeCommit}:{...noPolicy,version:0};
  };
  const configured=()=>[options.directory,options.keyFile].every(p=>typeof p==='string'&&isAbsolute(p))&&database!==':memory:';
  let work=null,observer=null,cachedStatus={},stopped=false;const failures=new Map();

  async function provisionPrivate(){
    requireThat(configured(),503,'The host has not configured managed backup storage and a recovery key.');
    const paths=await Promise.all([realpath(options.directory),realpath(options.keyFile),realpath(database)]);
    const [directory,keyPath,source]=paths;
    const [dirInfo,keyInfo,keyOriginal]=await Promise.all([lstat(directory),lstat(keyPath),lstat(options.keyFile)]);
    requireThat(!inside(app,directory)&&!inside(directory,keyPath)&&!inside(app,keyPath)&&source!==keyPath&&!inside(directory,source)&&
      dirInfo.isDirectory()&&keyInfo.isFile()&&!keyOriginal.isSymbolicLink()&&keyInfo.size>=32&&keyInfo.size<=512,503,'The host backup directory or recovery key does not meet the private storage requirements.');
    if(process.platform!=='win32')requireThat((dirInfo.mode&0o077)===0&&(keyInfo.mode&0o077)===0,503,'The backup directory and recovery key must not be accessible to other operating-system users.');
    const keyHandle=await open(keyPath,'r');
    try{
      const info=await keyHandle.stat();
      requireThat(info.isFile()&&info.size>=32&&info.size<=512,503,'The host recovery key file is unavailable.');
      const raw=await keyHandle.readFile({encoding:'utf8'});
      const password=raw.replace(/\r?\n$/,'');
      requireThat(/^[\x21-\x7e]{32,256}$/.test(password),503,'The host recovery key must contain 32–256 printable non-space characters.');
      return {directory,password};
    }finally{await keyHandle.close();}
  }
  async function provision(){
    try{return await provisionPrivate();}
    catch(e){requireThat(false,503,e.status===503?e.message:'The host backup directory or recovery key is unavailable. Ask your host operator.');}
  }
  const prefix=p=>'firmquill-managed-'+p.scope+'-';
  // Recognize previously created archives for status/retention only. No old event trigger is registered.
  const valid=p=>new RegExp('^'+prefix(p)+'(daily-\\d{4}-\\d{2}-\\d{2}|before-(agent-approval|reviewed-lite-import)-[a-f0-9-]{36})\\.fqdb$');
  const metaPath=(directory,p)=>join(directory,prefix(p)+'status.json');
  async function readStatus(directory,p){
    if(!p.scope)return {};
    try{
      const path=metaPath(directory,p),info=await lstat(path);if(!info.isFile()||info.size>4096)return {};
      const raw=JSON.parse(await readFile(path,'utf8')),safe={};
      if(typeof raw.dailySlot==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.dailySlot))safe.dailySlot=raw.dailySlot;
      if(typeof raw.attemptedAt==='string'&&raw.attemptedAt===new Date(raw.attemptedAt).toJSON())safe.attemptedAt=raw.attemptedAt;
      if(raw.lastArchive&&valid(p).test(raw.lastArchive.name)&&typeof raw.lastArchive.at==='string'&&raw.lastArchive.at===new Date(raw.lastArchive.at).toJSON()&&['daily',...eventType].includes(raw.lastArchive.reason)&&Number.isSafeInteger(raw.lastArchive.databaseBytes)&&raw.lastArchive.databaseBytes>0&&raw.lastArchive.databaseBytes<=MAX_DATABASE_BYTES)safe.lastArchive={name:raw.lastArchive.name,reason:raw.lastArchive.reason,at:raw.lastArchive.at,databaseBytes:raw.lastArchive.databaseBytes};
      if(allowedCode.has(raw.lastError))safe.lastError=raw.lastError;
      return safe;
    }catch(e){if(e.code==='ENOENT')return {};throw e;}
  }
  async function persist(directory,p,value){
    const path=metaPath(directory,p),stage=path+'.'+randomUUID()+'.partial';
    const file=await open(stage,'wx',0o600);
    try{try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}await rename(stage,path);if(process.platform!=='win32'){const d=await open(directory,'r');try{await d.sync();}finally{await d.close();}}}
    finally{await unlink(stage).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
  async function retained(directory,p,keep,name){
    const matches=(await readdir(directory,{withFileTypes:true})).filter(e=>e.isFile()&&valid(p).test(e.name));
    const dated=await Promise.all(matches.map(async e=>({name:e.name,time:(await lstat(join(directory,e.name))).mtimeMs})));
    // Never prune the newly published archive or reduce below two managed copies.
    dated.sort((x,y)=>(x.name===name?-1:y.name===name?1:y.time-x.time||y.name.localeCompare(x.name)));
    for(const entry of dated.slice(keep))await unlink(join(directory,entry.name));
  }
  function dataVersion(){
    if(!observer)observer=new DatabaseSync(database,{readOnly:true,timeout:4000});
    return observer.prepare('PRAGMA data_version').get().data_version;
  }
  async function view(user){
    owner(user);
    const p=policy();let ready=false,last=cachedStatus;
    if(configured()){
      try{
        const {directory}=await provision();
        ready=true; last={...await readStatus(directory,p),...cachedStatus};
        if(last.lastArchive){
          const info=await lstat(join(directory,last.lastArchive.name)).catch(()=>null);
          if(!info?.isFile())last={...last,lastArchive:undefined};
        }
      }catch{ready=false;last={...cachedStatus,lastArchive:undefined};}
    }
    return {configured:configured(),ready,policy:{dailyUTC:p.dailyUTC,beforeCommit:p.beforeCommit,retain:p.retain,version:p.version},running:!!work,
      lastArchive:last.lastArchive?{...last.lastArchive}:null,lastError:last.lastError||null};
  }
  async function save(user,input,renew=()=>user){
    owner(user);
    const p=policy(),{dailyUTC,beforeCommit,retain,version}=input||{};
    requireThat(typeof dailyUTC==='string'&&(!dailyUTC||/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyUTC))&&typeof beforeCommit==='boolean'&&Number.isInteger(retain)&&retain>=2&&retain<=10,400,'Choose a daily UTC time or leave it blank, and retain 2–10 managed archives.');
    if(dailyUTC||beforeCommit)await provision();
    tx(db,()=>{
      const operator=renew();owner(operator);
      const latest=policy();
      requireThat(version===p.version&&latest.version===p.version,409,'Backup policy changed. Refresh before saving.');
      db.prepare(`INSERT INTO full_backup_policy VALUES(1,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
        daily_utc=excluded.daily_utc,before_commit=excluded.before_commit,retain=excluded.retain,version=full_backup_policy.version+1`)
        .run(p.scope||randomUUID(),dailyUTC,Number(beforeCommit),retain);
      audit(db,operator,'','managed backup policy updated',dailyUTC?'daily UTC enabled':'daily disabled');
    });
    return view(user);
  }
  function startWork(task,{event=false}={}){
    if(work||stopped){
      if(event)requireThat(false,503,'A managed backup is busy. Nothing was applied; retry after it finishes.');
      return null;
    }
    const running=Promise.resolve().then(task);
    work=running;
    running.then(()=>{if(work===running)work=null;},()=>{if(work===running)work=null;});
    return running;
  }
  async function run(p,reason,slot){
    let directory,previous={},attemptedAt=iso(clock()),didPublish=false;
    const scopeKey=p.scope;
    try{
      const ctx=await provision();directory=ctx.directory;previous=await readStatus(directory,p);
      const name=prefix(p)+(slot?'daily-'+slot:'before-'+reason+'-'+randomUUID())+'.fqdb';
      const destination=join(directory,name);
      if(slot){
        if(previous.dailySlot===slot)return;
        // An archive was published before a crash but its status was not recorded.
        const files=await lstat(destination).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
        if(files){
          const next={...previous,dailySlot:slot,lastError:'encrypted-archive-present',attemptedAt};
          await persist(directory,p,next);cachedStatus=next;return;
        }
        if(Date.parse(attemptedAt)-Date.parse(previous.attemptedAt||'')<retryAfter&&previous.lastError)return;
      }
      const {databaseBytes}=await archive(database,destination,ctx.password);didPublish=true;
      const success={...previous,...slot?{dailySlot:slot}:{},attemptedAt,lastError:null,
        lastArchive:{name,reason,at:iso(clock()),databaseBytes}};
      await persist(directory,p,success);
      cachedStatus=success;failures.delete(scopeKey);
      try{await retained(directory,p,p.retain,name);}catch{cachedStatus={...success,lastError:'storage-failure'};await persist(directory,p,cachedStatus).catch(()=>{});}
      return success.lastArchive;
    }catch(error){
      const val={...previous,attemptedAt,lastError:error.status===503?'backup-unavailable':/64 MiB/.test(error.message||'')?'size-limit':'storage-failure'};
      // Never delete a previous usable file because a new backup, verification or status update failed.
      if(directory)await persist(directory,p,val).catch(()=>{});
      failures.set(scopeKey,clock().getTime());
      cachedStatus={...cachedStatus,...val};
      requireThat(false,503,didPublish?'The archive was created but its status could not be saved. Nothing was applied; contact your host operator and retry.':'The required encrypted backup could not finish. Nothing was applied; resolve host backup storage and retry.');
    }
  }
  function tick(){
    let p;try{p=policy();}catch{return;}
    const now=clock(),timestamp=iso(now),slot=timestamp.slice(0,10);
    if(!p.dailyUTC||timestamp.slice(11,16)<p.dailyUTC||cachedStatus.dailySlot===slot||now.getTime()-(failures.get(p.scope)??-Infinity)<retryAfter)return;
    const pending=startWork(()=>run(p,'daily',slot));
    return pending?.catch(()=>{});
  }
  // The caller checks this guard again INSIDE its own IMMEDIATE transaction,
  // after validation and before writing any approved company records.
  function preWrite(reason){
    requireThat(eventType.has(reason),500,'Unsupported managed backup trigger.');
    const p=policy();if(!p.beforeCommit)return null;
    let expected;try{expected=dataVersion();}catch{requireThat(false,503,'The backup could not read the current database. Nothing was applied.');}
    return startWork(async()=>{
      await run(p,reason);
      return ()=>{
        let changed=true;try{changed=dataVersion()!==expected;}catch{}
        requireThat(!changed,409,'The database changed while the backup was running. Your approval is still pending; review the latest records and retry.');
      };
    },{event:true});
  }
  async function close(){stopped=true;await work?.catch(()=>{});observer?.close();}
  return {view,save,tick,preWrite,close,enabled:()=>policy().beforeCommit};
}
