import {randomBytes,randomUUID,createHash,timingSafeEqual,createCipheriv,createDecipheriv,createPublicKey,verify} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {employeeProfile,setEmployeeProfile} from './records.mjs';
import {accountAreas} from './access.mjs';

const USER='urn:ietf:params:scim:schemas:core:2.0:User',ENTERPRISE='urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',LIST='urn:ietf:params:scim:api:messages:2.0:ListResponse',ERROR='urn:ietf:params:scim:api:messages:2.0:Error';
const approvedFields=new Set(['name','workEmail','department','title','location','businessPhone','hireDate','managerExternalId','groups','externalId','active']);
const approvedRoles=new Set(['worker','viewer','bookkeeper','manager','hr','payroll']);
const token=()=>randomBytes(32).toString('base64url');
const digest=s=>createHash('sha256').update(s).digest('hex');
const text=(v,max=250)=>typeof v==='string'?v.trim().slice(0,max):'';
function requireValue(ok,message,status=400){if(!ok)throw Object.assign(new Error(message),{status});}
function atomic(db,fn){if(db.isTransaction)return fn();db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
function audit(db,user,company,kind,id){db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),user.id,company,kind,String(id));}
function owner(user){requireValue(user?.role==='owner','Owner access required.',403);}
function freshActor(db,user){const row=db.prepare('SELECT active,authVersion,role FROM accounts WHERE id=?').get(user.id);requireValue(row?.active&&row.role==='owner'&&(!Number.isInteger(user.authVersion)||row.authVersion===user.authVersion),'Sign in again.',401);owner(user);}
function company(state,id){const c=state.companies.find(c=>c.id===id);requireValue(c,'Company unavailable.',404);return c;}
function safeJson(raw){try{return JSON.parse(raw);}catch{return {};}}
function invalidPassword(){return '!pending-invite:'+randomBytes(32).toString('hex');}
function secureUrl(value){let u;try{u=new URL(value);}catch{requireValue(false,'Enter a valid HTTPS URL.');}requireValue(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'HTTPS with certificate validation is required.');return u;}

export function initializeIdentity(db){
  db.exec(`CREATE TABLE IF NOT EXISTS identity_connectors(id TEXT PRIMARY KEY,company TEXT NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,config TEXT NOT NULL,secrets TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS identity_bindings(id TEXT PRIMARY KEY,connector TEXT NOT NULL REFERENCES identity_connectors(id),company TEXT NOT NULL,external_id TEXT NOT NULL,employee TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(connector,company,external_id));
    CREATE TABLE IF NOT EXISTS identity_previews(id TEXT PRIMARY KEY,connector TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_syncs(id TEXT PRIMARY KEY,connector TEXT NOT NULL,company TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_invites(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,company TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,consumed INTEGER);
    CREATE TABLE IF NOT EXISTS identity_scim_tokens(connector TEXT PRIMARY KEY REFERENCES identity_connectors(id),token_hash TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_login_links(connector TEXT NOT NULL REFERENCES identity_connectors(id),company TEXT NOT NULL,external_id TEXT NOT NULL,portal TEXT NOT NULL CHECK(portal IN ('worker','main')),user_id TEXT NOT NULL REFERENCES accounts(id),reviewed_by TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(connector,company,external_id,portal));
    CREATE INDEX IF NOT EXISTS identity_employee ON identity_bindings(company,employee);
  `);
}

// The script sends only LDAP Bind and Search operations. AD permissions belong to the
// explicitly configured read-only service account. TLS uses Windows trust validation;
// there is deliberately no certificate-validation override or plaintext fallback.
const directoryScript=String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Add-Type -AssemblyName System.DirectoryServices.Protocols
  $cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $identifier = [System.DirectoryServices.Protocols.LdapDirectoryIdentifier]::new([string]$cfg.host,[int]$cfg.port,$false,$false)
  $connection = [System.DirectoryServices.Protocols.LdapConnection]::new($identifier)
  $connection.AuthType = [System.DirectoryServices.Protocols.AuthType]::Basic
  $connection.Credential = [System.Net.NetworkCredential]::new([string]$cfg.bindUser,[string]$cfg.bindPassword)
  $connection.SessionOptions.ProtocolVersion = 3
  $connection.SessionOptions.SecureSocketLayer = $true
  $connection.SessionOptions.ReferralChasing = [System.DirectoryServices.Protocols.ReferralChasingOptions]::None
  $connection.Timeout = [TimeSpan]::FromSeconds(15)
  $connection.Bind()
  $names = [string[]]$cfg.attributes
  $request = [System.DirectoryServices.Protocols.SearchRequest]::new([string]$cfg.baseDn,[string]$cfg.filter,[System.DirectoryServices.Protocols.SearchScope]::Subtree,$names)
  $page = [System.DirectoryServices.Protocols.PageResultRequestControl]::new(500)
  [void]$request.Controls.Add($page)
  $rows = [System.Collections.Generic.List[object]]::new()
  do {
    $response = [System.DirectoryServices.Protocols.SearchResponse]$connection.SendRequest($request)
    foreach ($entry in $response.Entries) {
      $row = @{ distinguishedName = $entry.DistinguishedName }
      foreach ($attribute in $names) {
        $values = $entry.Attributes[$attribute]
        if ($null -ne $values) {
          if ($attribute -ieq 'objectGUID') { $row[$attribute] = [Convert]::ToBase64String([byte[]]$values[0]) }
          elseif ($attribute -ieq 'memberOf') { $row[$attribute] = @($values.GetValues([string])) }
          else { $row[$attribute] = [string]$values[0] }
        }
      }
      if ($null -ne $row['userAccountControl']) { $row['active'] = (([int]$row['userAccountControl'] -band 2) -eq 0) }
      $rows.Add($row)
      if ($rows.Count -gt 10000) { throw 'Directory row limit.' }
    }
    $cookie = [byte[]]@()
    foreach ($control in $response.Controls) { if ($control -is [System.DirectoryServices.Protocols.PageResultResponseControl]) { $cookie = $control.Cookie } }
    $page.Cookie = $cookie
  } while ($page.Cookie.Length -gt 0)
  $connection.Dispose()
  ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 8 -Compress
} catch { [Console]::Error.WriteLine('Encrypted directory connection or search failed. Check certificate trust, read-only credentials, and directory settings.'); exit 1 }
`;
export async function readActiveDirectory(config,secrets){
  requireValue(process.platform==='win32','The built-in AD adapter requires Windows.');
  const encoded=Buffer.from(directoryScript,'utf16le').toString('base64');
  const input={host:config.host,port:config.port||636,bindUser:config.bindUser,bindPassword:secrets.bindPassword,baseDn:config.baseDn,filter:config.filter||'(&(objectCategory=person)(objectClass=user))',attributes:[...new Set(['objectGUID','userAccountControl','distinguishedName',...Object.values(config.fieldMap||{}).filter(v=>typeof v==='string')])]};
  return await new Promise((yes,no)=>{
    const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,failed=false;const timer=setTimeout(()=>{failed=true;proc.kill();},45000);
    proc.stdout.on('data',bytes=>{size+=bytes.length;if(size>12*1024*1024){failed=true;proc.kill();}else chunks.push(bytes);});
    proc.stderr.resume();proc.on('error',()=>{clearTimeout(timer);no(Object.assign(Error('Windows directory adapter is unavailable.'),{status:400}));});
    proc.on('close',code=>{clearTimeout(timer);if(code||failed)return no(Object.assign(Error('Encrypted directory connection or search failed. Check certificate trust and read-only credentials.'),{status:400}));try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));yes(Array.isArray(result)?result:[result]);}catch{no(Error('Directory returned an invalid response.'));}});
    proc.stdin.end(JSON.stringify(input));
  });
}

export function createIdentityService({db,database,readBooks,saveBooks,passwordHash,putUser,secretKey,directoryReader=readActiveDirectory,fetcher=fetch}){
  const pendingOidc=new Map();
  function key(){
    if(secretKey){requireValue(Buffer.from(secretKey).length===32,'Connector key must be 32 bytes.');return Buffer.from(secretKey);}
    const configured=process.env.FIRMQUILL_CONNECTOR_KEY;
    if(configured){const bytes=Buffer.from(configured,'base64');requireValue(bytes.length===32,'FIRMQUILL_CONNECTOR_KEY must contain 32 base64-encoded bytes.');return bytes;}
    requireValue(database&&database!==':memory:','Set FIRMQUILL_CONNECTOR_KEY or an on-disk database for connector secrets.');
    const path=resolve(database+'.connectors.key'),app=dirname(fileURLToPath(import.meta.url)),rel=relative(app,path);
    requireValue(rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel),'Store connector keys outside the program folder.');
    if(!existsSync(path)){try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}try{chmodSync(path,0o600);}catch{}}
    const bytes=readFileSync(path);requireValue(bytes.length===32,'Connector key is unavailable or invalid.');return bytes;
  }
  function encrypt(value){if(!Object.keys(value).length)return '{}';const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:bytes.toString('base64')});}
  function decrypt(value){const v=safeJson(value);if(!v.iv)return {};try{const d=createDecipheriv('aes-256-gcm',key(),Buffer.from(v.iv,'base64'));d.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(v.body,'base64')),d.final()]).toString('utf8'));}catch{requireValue(false,'Connector secrets cannot be opened. Restore the original connector key.');}}
  function connector(id){const row=db.prepare('SELECT * FROM identity_connectors WHERE id=?').get(String(id));requireValue(row,'Connector unavailable.',404);return {...row,config:safeJson(row.config)};}
  function publicConnector(c){return {id:c.id,companyId:c.company,type:c.type,name:c.name,enabled:!!c.enabled,version:c.version,config:c.config,hasSecrets:c.secrets!=='{}',hasScimToken:!!db.prepare('SELECT 1 FROM identity_scim_tokens WHERE connector=?').get(c.id)};}
  function view(user,state,{companyId}={}){owner(user);if(companyId)company(state,companyId);const connectors=db.prepare('SELECT * FROM identity_connectors ORDER BY name').all().filter(c=>!companyId||c.company===companyId).map(c=>publicConnector({...c,config:safeJson(c.config)}));return {connectors,bindings:db.prepare('SELECT id,connector,company,external_id AS externalId,employee,user_id AS userId,updated FROM identity_bindings').all().filter(r=>!companyId||r.company===companyId),loginLinks:db.prepare('SELECT l.connector,l.company,l.external_id AS externalId,l.portal,l.user_id AS userId,l.reviewed_by AS reviewedBy,l.reviewed_at AS reviewedAt,a.username,a.employeeId FROM identity_login_links l JOIN accounts a ON a.id=l.user_id').all().filter(r=>!companyId||r.company===companyId),history:db.prepare('SELECT * FROM identity_syncs ORDER BY at DESC LIMIT 100').all().filter(r=>!companyId||r.company===companyId).map(r=>({...r,summary:safeJson(r.summary)}))};}
  function saveConnector(user,state,action){
    const p=action.config;requireValue(p&&typeof p==='object','Connector configuration required.');company(state,p.companyId);requireValue(['ldaps','oidc','scim','fixture'].includes(p.type),'Select a supported connector type.');
    const old=action.id?connector(action.id):null;requireValue(!old||(old.company===p.companyId&&old.type===p.type),'A connector cannot change company or protocol.');if(old&&action.version!==undefined)requireValue(old.version===action.version,'Connector changed. Refresh.',409);
    const config={};for(const name of ['host','bindUser','baseDn','filter','issuer','clientId','loginLabel'])if(p[name]!==undefined)config[name]=text(p[name],2000);
    if(p.type==='ldaps'){requireValue(/^[a-zA-Z0-9.-]+$/.test(config.host)&&config.bindUser&&config.baseDn,'Host, bind user and base DN are required.');config.port=Number(p.port||636);requireValue(Number.isInteger(config.port)&&config.port>0&&config.port<=65535,'Invalid LDAPS port.');}
    if(p.type==='oidc'){config.issuer=secureUrl(config.issuer).href.replace(/\/$/,'');requireValue(config.clientId,'Client ID required.');}
    config.fieldMap=p.fieldMap||{externalId:'objectGUID',name:'displayName',workEmail:'mail',department:'department',title:'title',location:'physicalDeliveryOfficeName',managerExternalId:'manager',groups:'memberOf'};
    requireValue(config.fieldMap&&typeof config.fieldMap==='object'&&!Array.isArray(config.fieldMap)&&Object.keys(config.fieldMap).every(k=>approvedFields.has(k))&&Object.values(config.fieldMap).every(v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(v)&&!/(password|pwd|unicodepwd|supplementalcredentials|ntlm|unicodepassword)/i.test(v)),'Map only approved profile fields; password and credential attributes cannot be read.');
    config.groupMap=Array.isArray(p.groupMap)?p.groupMap:[];requireValue(config.groupMap.length<=100&&config.groupMap.every(g=>g&&text(g.externalGroup)&&(!g.role||approvedRoles.has(g.role))&&(!g.groupId||/^[a-zA-Z0-9_-]{1,100}$/.test(g.groupId))),'Group mappings must name approved internal roles or benefits groups; owner access cannot be mapped.');
    config.groupMap=config.groupMap.map(g=>({externalGroup:text(g.externalGroup,2000),role:g.role||'',groupId:g.groupId||'',priority:Number.isFinite(g.priority)?g.priority:100}));
    if(p.newEmployeeDefaults){const d=p.newEmployeeDefaults;requireValue(Number.isSafeInteger(d.rate)&&d.rate>0&&/^[A-Z]{2}$/.test(d.state)&&text(d.locality),'Approve positive hourly cents, work state and locality for new employee records.');config.newEmployeeDefaults={rate:d.rate,state:d.state,locality:text(d.locality,160)};}
    const secrets=old?decrypt(old.secrets):{};for(const k of ['bindPassword','clientSecret'])if(p[k]!==undefined){requireValue(typeof p[k]==='string'&&p[k].length<=4096,'Secret too long.');if(p[k])secrets[k]=p[k];else delete secrets[k];}
    const id=old?.id||randomUUID();db.prepare('INSERT INTO identity_connectors VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,secrets=excluded.secrets,enabled=excluded.enabled,version=excluded.version').run(id,p.companyId,p.type,text(p.name,160)||p.type,JSON.stringify(config),encrypt(secrets),Number(p.enabled!==false),(old?.version||0)+1);audit(db,user,p.companyId,'identity connector configuration',id);return {connectorId:id};
  }
  async function jsonFetch(url,options={}){secureUrl(url);let response;try{response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{requireValue(false,'Identity provider connection failed. Verify certificate trust and configured endpoints.');}requireValue(response.ok,'Identity provider rejected the request.');const raw=await response.text();requireValue(Buffer.byteLength(raw)<=1024*1024,'Identity provider response too large.');try{return JSON.parse(raw);}catch{requireValue(false,'Identity provider returned invalid JSON.');}}
  async function discovery(c){const d=await jsonFetch(c.config.issuer+'/.well-known/openid-configuration');requireValue(d.issuer===c.config.issuer,'Identity provider issuer does not match configuration.');for(const k of ['authorization_endpoint','token_endpoint','jwks_uri'])secureUrl(d[k]);requireValue(d.response_types_supported?.includes('code')&&d.id_token_signing_alg_values_supported?.includes('RS256'),'Provider must support authorization code and RS256 ID tokens.');return d;}
  function normalized(c,row){
    const out={};for(const [field,attr]of Object.entries(c.config.fieldMap||{})){const value=row[attr];if(value!==undefined)out[field]=value;}
    if(c.type==='fixture')for(const field of approvedFields)if(row[field]!==undefined)out[field]=row[field];
    if(row.active!==undefined)out.active=row.active;
    requireValue(text(out.externalId,512)&&text(out.name,160),'Every directory row needs a stable external ID and name.');
    const groups=Array.isArray(out.groups)?out.groups.map(g=>text(g,2000)):out.groups?[String(out.groups)]:[];
    const mapped=c.config.groupMap.filter(g=>groups.includes(g.externalGroup)).sort((a,b)=>a.priority-b.priority||a.externalGroup.localeCompare(b.externalGroup));
    requireValue(!mapped.length||!mapped[1]||mapped[0].priority!==mapped[1].priority||mapped[0].role===mapped[1].role,'Equal-priority group role mappings conflict.');
    return {externalId:text(out.externalId,512),name:text(out.name,160),workEmail:text(out.workEmail,250).toLowerCase(),department:text(out.department),title:text(out.title),location:text(out.location),businessPhone:text(out.businessPhone),hireDate:text(out.hireDate,10),managerExternalId:text(out.managerExternalId,2000),groups,groupIds:[...new Set(mapped.map(g=>g.groupId).filter(Boolean))],role:'worker',suggestedErpRole:mapped.find(g=>g.role)?.role||'',active:out.active!==false,distinguishedName:text(row.distinguishedName,2000)};
  }
  function conflict(c,state,row){
    const binding=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,row.externalId);if(binding)return null;
    const matches=[];for(const p of company(state,c.company).employees){const profile=employeeProfile(db,state,c.company,p.id);if(row.workEmail&&profile.workEmail?.toLowerCase()===row.workEmail)matches.push({employeeId:p.id,name:p.name});}
    if(row.workEmail){for(const a of db.prepare('SELECT id,name,employeeId,assignments FROM accounts WHERE lower(username)=?').all(row.workEmail)){if(JSON.parse(a.assignments).includes(c.company)&&!matches.some(m=>m.employeeId===a.employeeId))matches.push({employeeId:a.employeeId,name:a.name});}}
    return matches.length?{externalId:row.externalId,reason:'A matching email requires explicit identity review; no automatic link.',matches}:null;
  }
  function accountFor(c,employee){return db.prepare("SELECT * FROM accounts WHERE employeeId=? AND role='worker'").all(employee).find(a=>JSON.parse(a.assignments).includes(c.company));}
  function applyRow(user,c,state,row){
    requireValue(!conflict(c,state,row),'Identity conflict requires review before syncing.',409);
    let binding=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,row.externalId),employee=binding?.employee;
    const book=company(state,c.company);if(!employee){const defaults=c.config.newEmployeeDefaults;requireValue(defaults,'New employees require HR-approved payroll defaults before import.');employee=randomUUID();book.employees.push({id:employee,name:row.name,...defaults});}
    const person=book.employees.find(p=>p.id===employee);requireValue(person,'Linked employee unavailable.',409);person.name=row.name;
    let account=binding?db.prepare('SELECT * FROM accounts WHERE id=?').get(binding.user_id):accountFor(c,employee);
    if(!account){const id=putUser(db,user,{username:'fq.'+randomUUID().replaceAll('-',''),name:row.name,role:row.role,assignments:[c.company],employeeId:employee,active:row.active},invalidPassword());account=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);}
    else {
      requireValue(account.role!=='owner','Provider cannot manage owner access.',403);
      // Stable identity mappings retain local password hashes on update and rehire.
      requireValue(account.role==='worker','Provisioning manages worker identities; ERP access requires a separate owner-approved account.',403);
      const changed=account.name!==row.name||!!account.active!==row.active;
      if(changed)db.prepare('UPDATE accounts SET name=?,active=?,authVersion=authVersion+1 WHERE id=?').run(row.name,Number(row.active),account.id);
    }
    const patch={workEmail:row.workEmail,department:row.department,title:row.title,location:row.location,businessPhone:row.businessPhone||'',employmentStatus:row.active?'active':'inactive',groupIds:row.groupIds};if(row.hireDate)patch.hireDate=row.hireDate;
    setEmployeeProfile(db,state,c.company,employee,patch,user.id);
    const now=new Date().toISOString(),id=binding?.id||randomUUID();
    db.prepare('INSERT INTO identity_bindings VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connector,company,external_id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(id,c.id,c.company,row.externalId,employee,account.id,JSON.stringify(row),binding?.created||now,now);
    if(!row.active){for(const a of db.prepare('SELECT id,assignments FROM accounts WHERE employeeId=? AND active=1').all(employee))if(JSON.parse(a.assignments).includes(c.company))db.prepare('UPDATE accounts SET active=0,authVersion=authVersion+1 WHERE id=?').run(a.id);}
    audit(db,user,c.company,row.active?'identity provisioned':'identity deactivated',id);return id;
  }
  function resolveManagers(user,c,state,rows){for(const row of rows){if(!row.managerExternalId)continue;const binding=db.prepare('SELECT employee FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,row.externalId);const manager=db.prepare('SELECT employee,body FROM identity_bindings WHERE connector=? AND company=?').all(c.id,c.company).find(r=>{const body=safeJson(r.body);return body.externalId===row.managerExternalId||body.distinguishedName===row.managerExternalId;});if(binding&&manager&&binding.employee!==manager.employee)setEmployeeProfile(db,state,c.company,binding.employee,{managerEmployeeId:manager.employee},user.id);}}
  async function executeCommand(user,ignoredState,action){
    owner(user);requireValue(action&&typeof action.type==='string','Identity action required.');
    if(action.type==='connector-save')return atomic(db,()=>{freshActor(db,user);return saveConnector(user,readBooks(db).state,action);});
    if(action.type==='invite-create')return atomic(db,()=>{
      freshActor(db,user);const state=readBooks(db).state,book=company(state,action.companyId),employee=book.employees.find(e=>e.id===action.employeeId);requireValue(employee,'Employee unavailable.',404);
      const portal=action.portal||'worker';requireValue(['worker','main'].includes(portal),'Choose the worker or ERP portal.');
      const main=portal==='main';let approvedAreas=[];
      if(main){const flags=db.prepare('SELECT * FROM employee_erp_flags WHERE company=? AND employee=?').get(book.id,employee.id);requireValue(flags?.enabled,'Enable ERP areas for this employee before issuing a separate ERP invitation.',403);approvedAreas=JSON.parse(flags.areas);requireValue(approvedRoles.has(action.role||'viewer')&&(action.role||'viewer')!=='worker','Choose an ERP duty.');requireValue(Array.isArray(action.areas)&&action.areas.length>0&&action.areas.every(a=>approvedAreas.includes(a)),'Select only owner-approved ERP areas.',403);}
      let account=db.prepare('SELECT * FROM accounts WHERE employeeId=?').all(employee.id).find(a=>(main?a.role!=='worker'&&a.role!=='owner':a.role==='worker')&&JSON.parse(a.assignments).includes(book.id));
      if(!account){const id=putUser(db,user,{username:text(action.username,80).toLowerCase()||'fq.'+randomUUID().replaceAll('-',''),name:employee.name,role:main?(action.role||'viewer'):'worker',assignments:[book.id],employeeId:employee.id,active:true,...(main?{areas:action.areas}: {})},invalidPassword());account=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);}
      else if(main){putUser(db,user,{id:account.id,version:account.authVersion,username:text(action.username,80).toLowerCase()||account.username,name:employee.name,role:action.role||'viewer',assignments:[book.id],employeeId:employee.id,active:true,areas:action.areas},null);account=db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);}
      else if(action.username&&action.username!==account.username){requireValue(/^[a-z0-9][a-z0-9_.@-]{1,79}$/.test(action.username),'Choose a valid username.');requireValue(!db.prepare('SELECT 1 FROM accounts WHERE username=? AND id<>?').get(action.username,account.id),'Username already in use.',409);db.prepare('UPDATE accounts SET username=?,authVersion=authVersion+1 WHERE id=?').run(action.username,account.id);account.username=action.username;}
      requireValue(account.active,'Re-enable this employee before inviting.',409);const hours=Number(action.hours||48);requireValue(Number.isFinite(hours)&&hours>=1&&hours<=168,'Invite expiration must be 1–168 hours.');
      db.prepare('DELETE FROM identity_invites WHERE user_id=? AND consumed IS NULL').run(account.id);const raw=token(),expires=Date.now()+hours*3600000;db.prepare('INSERT INTO identity_invites VALUES(?,?,?,?,?,?,NULL)').run(randomUUID(),digest(raw),account.id,book.id,Date.now(),expires);audit(db,user,book.id,'local invite created',account.id);return {inviteToken:raw,username:account.username,portal,expires:new Date(expires).toISOString()};
    });
    const c=connector(action.id);requireValue(c.enabled||action.type==='scim-token','Enable the connector first.');
    if(action.type==='scim-token')return atomic(db,()=>{freshActor(db,user);requireValue(c.type==='scim','SCIM connector required.');const raw=token();db.prepare('INSERT INTO identity_scim_tokens VALUES(?,?,?) ON CONFLICT(connector) DO UPDATE SET token_hash=excluded.token_hash,created=excluded.created').run(c.id,digest(raw),new Date().toISOString());audit(db,user,c.company,'SCIM token rotated',c.id);return {scimToken:raw};});
    if(action.type==='identity-link')return atomic(db,()=>{
      freshActor(db,user);const state=readBooks(db).state;requireValue(company(state,c.company).employees.some(e=>e.id===action.employeeId),'Employee unavailable.',404);requireValue(text(action.externalId,512),'Stable provider identifier required.');
      const portal=action.portal||'worker';requireValue(['worker','main'].includes(portal),'Choose the worker or ERP portal.');
      if(portal==='main'){
        requireValue(c.type==='oidc','ERP federation links require an OpenID Connect connector.');
        const workerLink=db.prepare('SELECT employee FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,text(action.externalId,512));requireValue(!workerLink||workerLink.employee===action.employeeId,'This provider subject is linked to a different employee. Review the conflict first.',409);
        const flags=db.prepare('SELECT * FROM employee_erp_flags WHERE company=? AND employee=?').get(c.company,action.employeeId);requireValue(flags?.enabled,'Enable employee ERP eligibility and approve areas first.',403);
        const candidates=db.prepare("SELECT * FROM accounts WHERE employeeId=? AND active=1 AND role NOT IN ('worker','owner')").all(action.employeeId).filter(a=>JSON.parse(a.assignments).includes(c.company));
        const account=action.accountId?candidates.find(a=>a.id===action.accountId):candidates.length===1?candidates[0]:null;requireValue(account,'Select an existing active separate ERP account for this employee; federation does not create ERP access.',403);
        requireValue(accountAreas(db,{...account,assignments:JSON.parse(account.assignments)}).length>0,'Approve at least one ERP area for this separate account.',403);
        const existing=db.prepare('SELECT user_id FROM identity_login_links WHERE connector=? AND company=? AND external_id=? AND portal=?').get(c.id,c.company,text(action.externalId,512),'main');requireValue(!existing||existing.user_id===account.id,'This ERP provider subject is already linked to a different account.',409);
        db.prepare('INSERT INTO identity_login_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(connector,company,external_id,portal) DO UPDATE SET reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at').run(c.id,c.company,text(action.externalId,512),'main',account.id,user.id,new Date().toISOString());audit(db,user,c.company,'ERP federation identity reviewed',account.id);return {linked:true,portal:'main',username:account.username};
      }
      const old=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,action.externalId);requireValue(!old||old.employee===action.employeeId,'Provider identifier already linked to a different employee.',409);
      let account=accountFor(c,action.employeeId);if(!account){const employee=company(state,c.company).employees.find(e=>e.id===action.employeeId);const id=putUser(db,user,{username:'fq.'+randomUUID().replaceAll('-',''),name:employee.name,role:'worker',assignments:[c.company],employeeId:employee.id,active:true},invalidPassword());account=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);}
      requireValue(account.role==='worker','Select the employee worker identity.',403);const now=new Date().toISOString();db.prepare('INSERT OR IGNORE INTO identity_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),c.id,c.company,text(action.externalId,512),action.employeeId,account.id,'{}',now,now);db.prepare('INSERT INTO identity_login_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(connector,company,external_id,portal) DO UPDATE SET reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at').run(c.id,c.company,text(action.externalId,512),'worker',account.id,user.id,now);audit(db,user,c.company,'identity manually linked',c.id);return {linked:true,portal:'worker',username:account.username};
    });
    if(action.type==='connector-test'){
      if(c.type==='oidc')await discovery(c);else if(c.type==='ldaps')await directoryReader(c.config,decrypt(c.secrets));
      freshActor(db,user);audit(db,user,c.company,'identity connection tested',c.id);return {connection:{ok:true,mode:c.type,message:c.type==='scim'?'SCIM endpoint configured; rotate a bearer token and test from the provisioning client.':c.type==='fixture'?'Local fixture adapter is ready.':'Encrypted connection and read access succeeded.'}};
    }
    if(action.type==='connector-preview'){
      requireValue(['ldaps','fixture'].includes(c.type),'Preview is available for directory or local fixture imports.');const raw=c.type==='fixture'?action.rows:await directoryReader(c.config,decrypt(c.secrets));requireValue(Array.isArray(raw)&&raw.length<=10000,'Provide up to 10,000 directory records.');const rows=raw.map(r=>normalized(c,r));requireValue(new Set(rows.map(r=>r.externalId)).size===rows.length,'Duplicate stable IDs in import.');
      return atomic(db,()=>{freshActor(db,user);const state=readBooks(db).state,conflicts=rows.map(r=>conflict(c,state,r)).filter(Boolean),id=randomUUID();db.prepare('DELETE FROM identity_previews WHERE created<?').run(Date.now()-3600000);db.prepare('INSERT INTO identity_previews VALUES(?,?,?,?,?)').run(id,c.id,user.id,Date.now(),JSON.stringify({version:c.version,rows}));return {preview:{id,companyId:c.company,rows,conflicts,requiresPayrollDefaults:!c.config.newEmployeeDefaults&&rows.some(r=>!db.prepare('SELECT 1 FROM identity_bindings WHERE connector=? AND external_id=?').get(c.id,r.externalId))}};});
    }
    requireValue(action.type==='connector-sync','Unknown identity action.');
    return atomic(db,()=>{freshActor(db,user);const preview=db.prepare('SELECT * FROM identity_previews WHERE id=? AND connector=? AND actor=?').get(String(action.previewId),c.id,user.id);requireValue(preview&&Date.now()-preview.created<3600000,'Preview the import again.',409);const plan=safeJson(preview.body);requireValue(plan.version===connector(c.id).version,'Connector changed. Preview again.',409);const state=readBooks(db).state;const conflicts=plan.rows.map(r=>conflict(c,state,r)).filter(Boolean);requireValue(!conflicts.length,'Resolve the visible identity conflicts before syncing.',409);
      // Save employee additions before putUser validates its existing employee links.
      for(const row of plan.rows){if(!db.prepare('SELECT 1 FROM identity_bindings WHERE connector=? AND external_id=?').get(c.id,row.externalId)){requireValue(c.config.newEmployeeDefaults,'Approve payroll defaults for new employees.');}}
      for(const row of plan.rows){const before=company(state,c.company).employees.length;const binding=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND external_id=?').get(c.id,row.externalId);if(!binding){const employee=randomUUID();company(state,c.company).employees.push({id:employee,name:row.name,...c.config.newEmployeeDefaults});saveBooks(db,state);const id=putUser(db,user,{username:'fq.'+randomUUID().replaceAll('-',''),name:row.name,role:row.role,assignments:[c.company],employeeId:employee,active:row.active},invalidPassword()),now=new Date().toISOString();db.prepare('INSERT INTO identity_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),c.id,c.company,row.externalId,employee,id,JSON.stringify(row),now,now);}applyRow(user,c,state,row);}
      resolveManagers(user,c,state,plan.rows);saveBooks(db,state);db.prepare('DELETE FROM identity_previews WHERE id=?').run(preview.id);const summary={processed:plan.rows.length,active:plan.rows.filter(r=>r.active).length,inactive:plan.rows.filter(r=>!r.active).length};db.prepare('INSERT INTO identity_syncs VALUES(?,?,?,?,?,?,?)').run(randomUUID(),c.id,c.company,user.id,new Date().toISOString(),'completed',JSON.stringify(summary));return {sync:summary};});
  }
  async function command(user,state,action){
    try{return await executeCommand(user,state,action);}catch(e){
      // Persist only operation/count metadata outside the rolled-back sync. Profile
      // values, LDAP diagnostic responses, credentials and tokens never enter history.
      if(user?.role==='owner'&&['connector-test','connector-preview','connector-sync'].includes(action?.type)){
        const c=db.prepare('SELECT id,company FROM identity_connectors WHERE id=?').get(String(action.id));
        if(c)atomic(db,()=>{const id=randomUUID();db.prepare('INSERT INTO identity_syncs VALUES(?,?,?,?,?,?,?)').run(id,c.id,c.company,user.id,new Date().toISOString(),'failed',JSON.stringify({operation:action.type,reason:e.status===409?'Review or configuration conflict':e.status===401||e.status===403?'Access unavailable':'Connection or validation failed'}));audit(db,user,c.company,'identity operation failed',id);});
      }
      throw e;
    }
  }
  async function acceptInvite(raw,password){requireValue(typeof raw==='string'&&raw.length<=200,'Invalid or expired invitation.',400);const invite=db.prepare('SELECT * FROM identity_invites WHERE token_hash=?').get(digest(raw));requireValue(invite&&!invite.consumed&&invite.expires>Date.now(),'Invalid or expired invitation.',400);const hash=await passwordHash(password);return atomic(db,()=>{const current=db.prepare('SELECT * FROM identity_invites WHERE id=?').get(invite.id),account=db.prepare('SELECT * FROM accounts WHERE id=?').get(invite.user_id);requireValue(current&&!current.consumed&&current.expires>Date.now()&&account?.active,'Invalid or expired invitation.',400);db.prepare('UPDATE accounts SET hash=?,authVersion=authVersion+1 WHERE id=?').run(hash,account.id);db.prepare('UPDATE identity_invites SET consumed=? WHERE id=?').run(Date.now(),invite.id);audit(db,{id:account.id},invite.company,'local password setup',account.id);return {userId:account.id};});}
  function providers(portal){return db.prepare("SELECT * FROM identity_connectors WHERE type='oidc' AND enabled=1 ORDER BY name").all().map(c=>({id:c.id,name:c.name,companyId:c.company}));}
  async function beginOidc(id,redirectUri,portal){const c=connector(id);requireValue(c.type==='oidc'&&c.enabled,'Federation provider unavailable.',404);requireValue(['worker','main'].includes(portal),'Invalid portal.');const origin=new URL(redirectUri);requireValue(origin.protocol==='https:'||(origin.hostname==='127.0.0.1'&&origin.protocol==='http:'),'Use HTTPS or local loopback for the callback.');const d=await discovery(c),state=token(),nonce=token(),verifier=token(),binding=token();for(const[k,v]of pendingOidc)if(v.expires<Date.now())pendingOidc.delete(k);requireValue(pendingOidc.size<1000,'Federation busy. Try again.',429);pendingOidc.set(state,{connector:c.id,nonce,verifier,binding,portal,redirectUri,expires:Date.now()+300000});const url=new URL(d.authorization_endpoint);for(const[k,v]of Object.entries({client_id:c.config.clientId,response_type:'code',scope:'openid profile email',redirect_uri:redirectUri,state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(k,v);return {redirect:url.href,binding};}
  async function finishOidc(query,redirectUri,binding){const state=query instanceof URLSearchParams?query.get('state'):query.state,code=query instanceof URLSearchParams?query.get('code'):query.code,pending=pendingOidc.get(state);pendingOidc.delete(state);requireValue(pending&&pending.expires>Date.now()&&pending.redirectUri===redirectUri&&typeof binding==='string'&&digest(binding)===digest(pending.binding),'Federation state expired or invalid.',401);requireValue(typeof code==='string'&&code.length<=4000,'Federation authorization code missing.',401);const c=connector(pending.connector);requireValue(c.enabled,'Federation provider disabled.',401);const d=await discovery(c),secrets=decrypt(c.secrets),body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,client_id:c.config.clientId,code_verifier:pending.verifier});if(secrets.clientSecret)body.set('client_secret',secrets.clientSecret);const tokens=await jsonFetch(d.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});const claims=await validateIdToken(tokens.id_token,{issuer:c.config.issuer,audience:c.config.clientId,nonce:pending.nonce,jwks:await jsonFetch(d.jwks_uri)});const explicit=db.prepare('SELECT * FROM identity_login_links WHERE connector=? AND company=? AND external_id=? AND portal=?').get(c.id,c.company,claims.sub,pending.portal),match=explicit||(pending.portal==='worker'?db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND company=? AND external_id=?').get(c.id,c.company,claims.sub):null);requireValue(match,'This provider identity requires an explicit owner-reviewed link for this portal before sign-in.',403);const account=db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(match.user_id);requireValue(account&&(account.role==='worker')===(pending.portal==='worker')&&JSON.parse(account.assignments).includes(c.company),'Account unavailable for this portal.',403);if(pending.portal==='main'){const flags=db.prepare('SELECT enabled FROM employee_erp_flags WHERE company=? AND employee=?').get(c.company,account.employeeId);requireValue(flags?.enabled&&accountAreas(db,{...account,assignments:JSON.parse(account.assignments)}).length>0,'Employee ERP access is disabled or has no approved areas.',403);}audit(db,{id:account.id},c.company,'federated sign-in',c.id);return {userId:account.id,portal:pending.portal};}

  function scimResource(c,b){const row=safeJson(b.body),account=db.prepare('SELECT active FROM accounts WHERE id=?').get(b.user_id);return {schemas:[USER,ENTERPRISE],id:b.id,externalId:b.external_id,userName:row.userName||row.workEmail||b.external_id,displayName:row.name||'',name:{formatted:row.name||''},active:!!account?.active,emails:row.workEmail?[{value:row.workEmail,type:'work',primary:true}]:[],[ENTERPRISE]:{department:row.department||'',organization:c.company,manager:row.managerExternalId?{value:row.managerExternalId}:undefined},meta:{resourceType:'User',created:b.created,lastModified:b.updated,version:'W/"'+digest(b.updated+b.body).slice(0,16)+'"'}};}
  function fromScim(c,data,old={}){requireValue(data.schemas?.includes(USER),'SCIM User schema is required.');const ent=data[ENTERPRISE]||{},email=data.emails?.find(e=>e.primary)?.value||data.emails?.find(e=>e.type==='work')?.value||data.emails?.[0]?.value;requireValue(!('password'in data),'Directory passwords must never be supplied to FirmQuill.');if(data.active!==undefined)requireValue(typeof data.active==='boolean','active must be boolean.');const name=data.displayName||data.name?.formatted||[data.name?.givenName,data.name?.familyName].filter(Boolean).join(' ')||old.name;const normalizedRow={...old,externalId:text(data.externalId||old.externalId,512),userName:text(data.userName||old.userName,250),name:text(name,160),workEmail:text(email??old.workEmail,250).toLowerCase(),department:text(ent.department??old.department),title:text(data.title??old.title),location:text(ent.costCenter??old.location),managerExternalId:text(ent.manager?.value??old.managerExternalId,512),groups:Array.isArray(data.groups)?data.groups.map(g=>g.value):old.groups||[],active:data.active??old.active??true};const mapped=c.config.groupMap.filter(g=>normalizedRow.groups.includes(g.externalGroup)).sort((a,b)=>a.priority-b.priority);normalizedRow.groupIds=[...new Set(mapped.map(g=>g.groupId).filter(Boolean))];normalizedRow.suggestedErpRole=mapped.find(g=>g.role)?.role||'';normalizedRow.role='worker';requireValue(normalizedRow.externalId&&normalizedRow.userName&&normalizedRow.name,'externalId, userName and displayName/name are required.');return normalizedRow;}
  async function scim(method,url,headers,body){
    try{
      const parsed=typeof url==='string'?new URL(url,'https://firmquill.invalid'):url,parts=parsed.pathname.split('/').filter(Boolean),index=parts.indexOf('scim'),id=parts[index+1],resource=parts[index+2],resourceId=parts[index+3],c=connector(id);requireValue(c.type==='scim'&&c.enabled,'SCIM connector unavailable.',404);const auth=headers?.authorization||headers?.get?.('authorization')||'',raw=/^Bearer (.+)$/.exec(auth)?.[1],saved=db.prepare('SELECT token_hash FROM identity_scim_tokens WHERE connector=?').get(c.id);requireValue(raw&&saved&&digest(raw)===saved.token_hash,'SCIM bearer token invalid.',401);
      const ok=(status,result,extra={})=>({status,body:result,headers:{'Content-Type':'application/scim+json; charset=utf-8',...extra}});
      const base='/api/scim/'+c.id;
      if(method==='GET'&&resource==='ServiceProviderConfig')return ok(200,{schemas:['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],patch:{supported:true},bulk:{supported:false,maxOperations:0,maxPayloadSize:0},filter:{supported:true,maxResults:200},changePassword:{supported:false},sort:{supported:false},etag:{supported:true},authenticationSchemes:[{type:'oauthbearertoken',name:'Bearer token',description:'Company and connector scoped token',primary:true}]});
      if(method==='GET'&&resource==='ResourceTypes')return ok(200,{schemas:[LIST],totalResults:1,startIndex:1,itemsPerPage:1,Resources:[{schemas:['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],id:'User',name:'User',endpoint:'/Users',schema:USER,schemaExtensions:[{schema:ENTERPRISE,required:false}]}]});
      if(method==='GET'&&resource==='Schemas')return ok(200,{schemas:[LIST],totalResults:2,startIndex:1,itemsPerPage:2,Resources:[{schemas:['urn:ietf:params:scim:schemas:core:2.0:Schema'],id:USER,name:'User',attributes:[{name:'userName',type:'string',multiValued:false,required:true,caseExact:false,mutability:'readWrite',returned:'default',uniqueness:'server'},{name:'externalId',type:'string',multiValued:false,required:true,caseExact:true,mutability:'immutable',returned:'default',uniqueness:'server'},{name:'active',type:'boolean',multiValued:false,required:false,mutability:'readWrite',returned:'default'}]},{schemas:['urn:ietf:params:scim:schemas:core:2.0:Schema'],id:ENTERPRISE,name:'EnterpriseUser',attributes:[{name:'department',type:'string',multiValued:false,required:false,mutability:'readWrite',returned:'default'}]}]});
      requireValue(resource==='Users','SCIM resource unavailable.',404);
      if(method==='GET'&&!resourceId){let all=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND company=? ORDER BY created,id').all(c.id,c.company);const filter=parsed.searchParams.get('filter');if(filter){const match=/^(userName|externalId|id)\s+eq\s+"([^"\\]*)"$/i.exec(filter);requireValue(match,'Only equality filters on userName, externalId or id are supported.');all=all.filter(r=>{const v=scimResource(c,r),field={username:'userName',externalid:'externalId',id:'id'}[match[1].toLowerCase()];return field==='userName'?v[field].toLowerCase()===match[2].toLowerCase():v[field]===match[2];});}const start=Number(parsed.searchParams.get('startIndex')||1),count=Number(parsed.searchParams.get('count')??100);requireValue(Number.isInteger(start)&&start>=1&&Number.isInteger(count)&&count>=0&&count<=200,'Invalid SCIM pagination.');return ok(200,{schemas:[LIST],totalResults:all.length,startIndex:start,itemsPerPage:all.slice(start-1,start-1+count).length,Resources:all.slice(start-1,start-1+count).map(b=>scimResource(c,b))});}
      let existing=resourceId?db.prepare('SELECT * FROM identity_bindings WHERE id=? AND connector=? AND company=?').get(resourceId,c.id,c.company):null;if(resourceId)requireValue(existing,'User unavailable.',404);
      if(method==='GET')return ok(200,scimResource(c,existing),{ETag:scimResource(c,existing).meta.version});
      requireValue(['POST','PUT','PATCH','DELETE'].includes(method),'SCIM method unavailable.',405);requireValue(method==='POST'?!resourceId:!!resourceId,'Invalid SCIM resource path.');
      return atomic(db,()=>{
        const current=connector(c.id);requireValue(current.enabled&&current.version===c.version,'Connector changed. Retry.',409);const currentToken=db.prepare('SELECT token_hash FROM identity_scim_tokens WHERE connector=?').get(c.id);requireValue(currentToken?.token_hash===saved.token_hash,'SCIM token revoked.',401);const actor={id:'scim:'+c.id,role:'owner'},state=readBooks(db).state;let payload=body;
        if(existing){existing=db.prepare('SELECT * FROM identity_bindings WHERE id=?').get(existing.id);const match=headers?.['if-match']||headers?.get?.('if-match');if(match)requireValue(match===scimResource(c,existing).meta.version,'SCIM resource changed.',412);}
        if(method==='DELETE'){const row=safeJson(existing.body);applyRow(actor,c,state,{...row,active:false});saveBooks(db,state);return ok(204,null);}
        if(method==='PATCH'){
          requireValue(body?.schemas?.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp')&&Array.isArray(body.Operations)&&body.Operations.length>0&&body.Operations.length<=100,'Invalid SCIM PatchOp.');const old=scimResource(c,existing);payload=structuredClone(old);for(const op of body.Operations){requireValue(op&&['add','replace','remove'].includes(String(op.op).toLowerCase()),'Unsupported SCIM patch operation.');const kind=op.op.toLowerCase();if(!op.path){requireValue(kind!=='remove'&&op.value&&typeof op.value==='object'&&!Array.isArray(op.value),'Patch value required.');Object.assign(payload,op.value);continue;}const paths=new Set(['active','userName','displayName','name','emails','title','groups','externalId',ENTERPRISE,ENTERPRISE+':department',ENTERPRISE+':manager']);requireValue(paths.has(op.path),'Unsupported SCIM patch path.');if(op.path.startsWith(ENTERPRISE+':')){const field=op.path.slice(ENTERPRISE.length+1);payload[ENTERPRISE]??={};if(kind==='remove')delete payload[ENTERPRISE][field];else payload[ENTERPRISE][field]=op.value;}else if(kind==='remove')delete payload[op.path];else payload[op.path]=op.value;}
        }
        requireValue(payload&&typeof payload==='object'&&!Array.isArray(payload),'SCIM User body required.');const old=existing?safeJson(existing.body):{},row=fromScim(c,payload,old);if(existing)requireValue(row.externalId===existing.external_id,'externalId is immutable.',400);
        const sameId=db.prepare('SELECT * FROM identity_bindings WHERE connector=? AND external_id=?').get(c.id,row.externalId);if(method==='POST')requireValue(!sameId,'Stable externalId already exists; update the existing resource.',409);
        const duplicate=db.prepare('SELECT * FROM identity_bindings WHERE connector=?').all(c.id).find(r=>r.id!==existing?.id&&safeJson(r.body).userName?.toLowerCase()===row.userName.toLowerCase());requireValue(!duplicate,'userName already exists.',409);requireValue(!conflict(c,state,row),'An email conflict requires explicit owner review.',409);
        if(!existing){requireValue(c.config.newEmployeeDefaults,'Approve payroll defaults before provisioning new employees.');const employee=randomUUID();company(state,c.company).employees.push({id:employee,name:row.name,...c.config.newEmployeeDefaults});saveBooks(db,state);const account=putUser(db,actor,{username:'fq.'+randomUUID().replaceAll('-',''),name:row.name,role:row.role,assignments:[c.company],employeeId:employee,active:row.active},invalidPassword()),now=new Date().toISOString();existing={id:randomUUID(),employee,user_id:account,created:now};db.prepare('INSERT INTO identity_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(existing.id,c.id,c.company,row.externalId,employee,account,JSON.stringify(row),now,now);}
        const applied=applyRow(actor,c,state,row);saveBooks(db,state);const result=scimResource(c,db.prepare('SELECT * FROM identity_bindings WHERE id=?').get(applied));audit(db,actor,c.company,'SCIM '+method,applied);return ok(method==='POST'?201:200,result,{ETag:result.meta.version,Location:base+'/Users/'+result.id});
      });
    }catch(e){return {status:e.status||400,body:{schemas:[ERROR],status:String(e.status||400),detail:e.status===500?'Identity storage unavailable.':e.message,scimType:e.status===409?'uniqueness':e.status===412?'invalidVers':undefined},headers:{'Content-Type':'application/scim+json; charset=utf-8'}};}
  }
  return {view,command,acceptInvite,providers,beginOidc,finishOidc,scim};
}

export async function validateIdToken(raw,{issuer,audience,nonce,jwks,now=Date.now()}){
  requireValue(typeof raw==='string'&&raw.length<=32768,'Missing or oversized ID token.',401);const parts=raw.split('.');requireValue(parts.length===3,'Invalid ID token.',401);let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{requireValue(false,'Invalid ID token encoding.',401);}
  requireValue(header.alg==='RS256'&&!header.crit,'Unsupported ID token signing algorithm.',401);const keys=jwks?.keys?.filter(k=>k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256')&&(!header.kid||k.kid===header.kid));requireValue(keys?.length===1,'Signing key unavailable or ambiguous.',401);let valid=false;try{valid=verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:keys[0],format:'jwk'}),Buffer.from(parts[2],'base64url'));}catch{}
  requireValue(valid,'ID token signature invalid.',401);const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];requireValue(claims.iss===issuer&&audiences.includes(audience)&&audiences.length===1&&(!claims.azp||claims.azp===audience),'ID token issuer or audience invalid.',401);requireValue(typeof claims.sub==='string'&&claims.sub.length>0&&claims.sub.length<=512&&claims.nonce===nonce,'ID token subject or nonce invalid.',401);const seconds=now/1000;requireValue(Number.isFinite(claims.exp)&&claims.exp>seconds&&Number.isFinite(claims.iat)&&claims.iat<=seconds+60&&(!claims.nbf||claims.nbf<=seconds+60),'ID token expired or not yet valid.',401);return claims;
}
