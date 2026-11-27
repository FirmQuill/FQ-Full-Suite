import {randomUUID} from 'node:crypto';
import {workerFeatures,requireArea} from './access.mjs';
import {employeeProfile} from './records.mjs';
import {initializeCollaborationGroups,companyGroups,activeGroupMember} from './collaboration-groups.mjs';
import {MAX_DATABASE_BYTES} from './recovery.mjs';

export const MAX_DRIVE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DRIVE_TOTAL_BYTES = 16 * 1024 * 1024;
const RECOVERY_HEADROOM = 8 * 1024 * 1024;
const MAX_DRIVE_ENTRIES = 4096, MAX_FOLDER_DEPTH = 12;
const inactive = new Set(['inactive','disabled','deactivated','terminated']);
function check(ok,status,message){if(!ok)throw Object.assign(new Error(message),{status});}
function unavailable(){check(false,404,'Drive item or scope is unavailable.');}
export function safeDriveName(value) {
  check(typeof value==='string',400,'Enter a file or folder name.');
  const name=value.normalize('NFC').trim();
  check(name && name.isWellFormed() && Buffer.byteLength(name)<=200 &&
    !/^[. ]|[. ]$|[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name),400,
    'Use a name without path separators, reserved characters, or device names (200 UTF-8 bytes maximum).');
  return name;
}
export function driveDownloadHeaders(name,size) {
  const filename=safeDriveName(name);
  const fallback=filename.replace(/[^a-z0-9_. -]/gi,'_');
  const extended=encodeURIComponent(filename).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return {'Content-Type':'application/octet-stream','Content-Length':String(size),
    'Cross-Origin-Resource-Policy':'same-origin','Content-Disposition':`attachment; filename="${fallback}"; filename*=UTF-8''${extended}`};
}

// Tables are owned by the drive subsystem. Keeping them in the same physical database
// gives the offline .fqdb recovery tool a consistent snapshot of files, groups and accounts.
function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_entries(
      id TEXT PRIMARY KEY, company TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','group')),
      scope_id TEXT NOT NULL, uploader TEXT NOT NULL REFERENCES accounts(id), parent TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('folder','file')), name TEXT NOT NULL, name_key TEXT NOT NULL,
      created_at TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 4194304), blob BLOB,
      CHECK((kind='folder' AND size=0 AND blob IS NULL) OR
            (kind='file' AND typeof(blob)='blob' AND length(blob)=size)),
      UNIQUE(company,scope,scope_id,parent,name_key)
    );
    CREATE INDEX IF NOT EXISTS drive_entries_parent ON drive_entries(company,scope,scope_id,parent);
  `);
}
export function createDriveService(db) {
  initializeCollaborationGroups(db);
  initialize(db);
  function scope(access,options={}){
    const {userId,companyId,groupId=''}=access||{};
    if(typeof userId!=='string'||typeof companyId!=='string'||typeof groupId!=='string'||!userId||!companyId||
      userId.length>160||companyId.length>160||groupId.length>160)unavailable();
    const row=db.prepare('SELECT id,role,assignments,employeeId,authVersion FROM accounts WHERE id=? AND active=1').get(userId);
    if(!row)unavailable();
    if(options.expectedAuthVersion!==undefined)check(row.authVersion===options.expectedAuthVersion,401,'Sign in again.');
    const assignments=JSON.parse(row.assignments);
    const state=JSON.parse(db.prepare('SELECT body FROM books WHERE id=1').get().body);
    if(!state.companies.some(c=>c.id===companyId)||(row.role!=='owner'&&!assignments.includes(companyId)))unavailable();
    if(row.employeeId&&assignments.length===1){
      if(inactive.has(employeeProfile(db,state,assignments[0],row.employeeId).employmentStatus))unavailable();
      if(row.role!=='worker'&&!db.prepare('SELECT enabled FROM employee_erp_flags WHERE company=? AND employee=?').get(assignments[0],row.employeeId)?.enabled)unavailable();
    }
    if(row.role==='worker'&&!workerFeatures(db,{assignments,employeeId:row.employeeId}).includes('Drives'))unavailable();
    if(row.role!=='worker')requireArea(db,row,'Drives');
    if(groupId&&!activeGroupMember(db,{companyId,groupId,userId,state}))unavailable();
    return {companyId,userId,groupId,kind:groupId?'group':'personal',scopeId:groupId||userId,state};
  }
  function lookup(s,id,kind='',withContents=false){
    if(typeof id!=='string'||id.length>160||!id)unavailable();
    const entry=db.prepare(`SELECT id,name,kind,parent,uploader,created_at AS createdAt,size${withContents?',blob':''}
      FROM drive_entries WHERE company=? AND scope=? AND scope_id=? AND id=?`).get(s.companyId,s.kind,s.scopeId,id);
    if(!entry||(kind&&entry.kind!==kind))unavailable();
    return entry;
  }
  function breadcrumbs(s,folderId){
    const crumbs=[];let id=folderId;
    if(typeof id!=='string')unavailable();
    while(id){check(crumbs.length<MAX_FOLDER_DEPTH,409,'Folder nesting is too deep.');const f=lookup(s,id,'folder');crumbs.unshift({id:f.id,name:f.name});id=f.parent;}
    return crumbs;
  }
  function metadata(s,r){return {id:r.id,name:r.name,kind:r.kind,createdAt:r.createdAt,size:r.size,canDelete:r.uploader===s.userId};}
  function list(access,folderId='',options){
    const s=scope(access,options),path=breadcrumbs(s,folderId);
    const entries=db.prepare(`SELECT id,name,kind,uploader,created_at AS createdAt,size FROM drive_entries
      WHERE company=? AND scope=? AND scope_id=? AND parent=? ORDER BY kind DESC,name_key,id`)
      .all(s.companyId,s.kind,s.scopeId,folderId).map(r=>metadata(s,r));
    return {companyId:s.companyId,groupId:s.groupId,folderId,path,entries,
      groups:companyGroups(db,{companyId:s.companyId,userId:s.userId,state:s.state}).filter(g=>typeof g.id==='string'&&typeof g.name==='string').map(({id,name})=>({id,name})),
      maxBytes:MAX_DRIVE_FILE_BYTES};
  }
  function authorizeCreate(access,folderId='',options){const s=scope(access,options);breadcrumbs(s,folderId);}
  function authorizeRead(access,fileId,options){const s=scope(access,options),r=lookup(s,fileId,'file',true);return {filename:r.name,data:Buffer.from(r.blob)};}
  function write(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
  function create(access,folderId,{filename,data},kind,options) {
    const name=safeDriveName(filename), key=name.toLowerCase().normalize('NFC');
    if(kind==='file')check(Buffer.isBuffer(data)&&data.length<=MAX_DRIVE_FILE_BYTES,413,'Files are limited to 4 MiB each.');
    return write(()=>{
      const s=scope(access,options),path=breadcrumbs(s,folderId);
      if(kind==='folder')check(path.length<MAX_FOLDER_DEPTH,400,'Folders can be nested up to 12 levels.');
      const totals=db.prepare('SELECT count(*) AS entries,coalesce(sum(size),0) AS bytes FROM drive_entries').get();
      const size=data?.length||0;
      check(totals.entries<MAX_DRIVE_ENTRIES&&totals.bytes+size<=MAX_DRIVE_TOTAL_BYTES,413,'The server drive storage limit has been reached.');
      const pageCount=db.prepare('PRAGMA page_count').get().page_count;
      const pageSize=db.prepare('PRAGMA page_size').get().page_size;
      const free=db.prepare('PRAGMA freelist_count').get().freelist_count;
      check(pageCount*pageSize+Math.max(0,size+16*pageSize-free*pageSize)<=MAX_DATABASE_BYTES-RECOVERY_HEADROOM,413,
        'Drives cannot add to this database without reducing encrypted recovery headroom.');
      check(!db.prepare('SELECT 1 FROM drive_entries WHERE company=? AND scope=? AND scope_id=? AND parent=? AND name_key=?')
        .get(s.companyId,s.kind,s.scopeId,folderId,key),409,'An item with this name already exists in this folder.');
      const r={id:randomUUID(),name,kind,createdAt:new Date().toISOString(),uploader:s.userId,size};
      db.prepare('INSERT INTO drive_entries(id,company,scope,scope_id,uploader,parent,kind,name,name_key,created_at,size,blob) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.id,s.companyId,s.kind,s.scopeId,s.userId,folderId,kind,name,key,r.createdAt,size,data??null);
      return metadata(s,r);
    });
  }
  function createFromBytes(access,folderId,{filename,data},options){return create(access,folderId,{filename,data},'file',options);}
  function createFolder(access,folderId,filename,options){return create(access,folderId,{filename},'folder',options);}
  function remove(access,id,options){
    return write(()=>{
      const s=scope(access,options),r=lookup(s,id);
      if(r.uploader!==s.userId)unavailable();
      check(!db.prepare('SELECT 1 FROM drive_entries WHERE company=? AND scope=? AND scope_id=? AND parent=? LIMIT 1')
        .get(s.companyId,s.kind,s.scopeId,r.id),409,'Empty this folder first.');
      db.prepare('DELETE FROM drive_entries WHERE id=? AND company=? AND scope=? AND scope_id=?').run(r.id,s.companyId,s.kind,s.scopeId);
      return {ok:true};
    });
  }
  // Intentionally no public URLs, MIME sniffing, previews, shared-link tokens, or document editor.
  // A future editor must use separately authorized, scoped read/versioned write operations.
  return {list,authorizeCreate,authorizeRead,createFromBytes,createFolder,remove};
}

// Binary transport is separate from the JSON actions, so uploads cannot expand base64
// or use a browser-selected MIME type to influence rendering on the company origin.
export function createDriveRoutes(drives) {
  let uploads=0;
  const done=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  return async function handleDriveRoute({req,res,url,user,readJson,reauthorize}){
    const {pathname:path,searchParams:q}=url;
    if(!path.startsWith('/api/drives/'))return false;
    const access={userId:user.id,companyId:q.get('companyId')||'',groupId:q.get('groupId')||''};
    const folder=q.get('folderId')||'';
    const verify=()=>{const now=reauthorize();check(now.id===user.id,401,'Sign in again.');return {expectedAuthVersion:now.authVersion};};
    if(path==='/api/drives/list'&&req.method==='GET'){done(res,drives.list(access,folder,verify()));return true;}
    if(path==='/api/drives/download'&&req.method==='GET'){
      const {filename,data}=drives.authorizeRead(access,q.get('id'),verify());
      res.writeHead(200,driveDownloadHeaders(filename,data.length));res.end(data);return true;
    }
    if(path==='/api/drives/upload'&&req.method==='POST'){
      drives.authorizeCreate(access,folder,verify());
      check(req.headers['content-type']==='application/octet-stream',415,'Send raw file bytes.');
      const declared=req.headers['content-length'];
      if(declared!==undefined)check(/^\d+$/.test(declared)&&Number(declared)<=MAX_DRIVE_FILE_BYTES,413,'Files are limited to 4 MiB each.');
      let filename;
      try{filename=safeDriveName(decodeURIComponent(req.headers['x-drive-filename']||''));}
      catch{check(false,400,'Check the file name before uploading.');}
      check(uploads<4,429,'The file server is busy. Try again shortly.');
      uploads++;
      try{
        const parts=[];let size=0;
        for await(const part of req){size+=part.length;check(size<=MAX_DRIVE_FILE_BYTES,413,'Files are limited to 4 MiB each.');parts.push(part);}
        if(declared!==undefined)check(Number(declared)===size,400,'The upload did not finish.');
        done(res,drives.createFromBytes(access,folder,{filename,data:Buffer.concat(parts,size)},verify()));return true;
      }finally{uploads--;}
    }
    if(path==='/api/drives/action'&&req.method==='POST'){
      drives.authorizeCreate(access,folder,verify());
      const action=await readJson(2048),options=verify();
      if(action.type==='folder')done(res,drives.createFolder(access,folder,action.name,options));
      else if(action.type==='delete')done(res,drives.remove(access,action.id,options));
      else check(false,400,'Choose a drive action.');
      return true;
    }
    unavailable();
  };
}
