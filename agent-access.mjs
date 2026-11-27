import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {tx,readBooks,revisionCheck,audit,safeUser,actionFor,requireThat} from './store.mjs';
import {apply} from './shared/core.mjs';
import {termsVersion,termsText} from './web/legal/terms.mjs';

export const AGENT_API_VERSION='1';
export const AGENT_RECORD_TYPES=Object.freeze(['contacts','items','invoices','bills']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const termsHash=digest(termsText.replace(/\r\n?/g,'\n'));
const fail=(ok,status,message)=>requireThat(ok,status,message);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>fail(object(value)&&Object.keys(value).every(k=>allowed.includes(k)),400,'Unsupported request fields.');
const text=(value,max=160)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const project=(record,fields)=>Object.fromEntries(fields.filter(k=>Object.hasOwn(record,k)).map(k=>[k,record[k]]));

/** No provider calls are made here. A bearer token grants one company and explicit record types. */
export function createAgentService({db}){
  db.exec(`CREATE TABLE IF NOT EXISTS agent_grants(
    id TEXT PRIMARY KEY,issuer TEXT NOT NULL REFERENCES accounts(id),issuer_version INTEGER NOT NULL,
    company TEXT NOT NULL,name TEXT NOT NULL,types TEXT NOT NULL,proposals INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,created TEXT NOT NULL,revoked TEXT);
    CREATE TABLE IF NOT EXISTS agent_proposals(
    id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES agent_grants(id),company TEXT NOT NULL,
    request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,base_revision INTEGER NOT NULL,
    action TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,decided_by TEXT,decided_at TEXT,
    UNIQUE(grant_id,request_id));`);
  const attempts=new Map();
  function principal(user){
    fail(user&&typeof user.id==='string',403,'Owner access required.');
    const current=safeUser(db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(user.id));
    fail(current?.role==='owner'&&current.authVersion===user.authVersion,403,'Owner access required.');
    return current;
  }
  function publicGrant(row){
    const {token_hash,issuer_version,types,proposals,...rest}=row;
    return {...rest,recordTypes:JSON.parse(types),allowProposals:!!proposals};
  }
  function liveGrant(row){
    fail(row&&!row.revoked,401,'Agent access is unavailable or revoked.');
    const issuer=db.prepare('SELECT role,active,authVersion FROM accounts WHERE id=?').get(row.issuer);
    fail(issuer?.active&&issuer.role==='owner'&&issuer.authVersion===row.issuer_version,401,'Agent access is unavailable or revoked.');
    fail(db.prepare('SELECT 1 FROM terms_acceptance_hashes WHERE account_id=? AND version=? AND content_hash=?').get(row.issuer,termsVersion,termsHash),428,'The grant owner must review the current Terms of Service in FirmQuill.');
    fail(readBooks(db).state.companies.some(c=>c.id===row.company),403,'Granted company is unavailable.');
    return row;
  }
  function authenticate(headers){
    fail(!headers.origin,403,'Agent bearer requests must come from a non-browser client.');
    const auth=headers.authorization;
    fail(typeof auth==='string'&&/^Bearer fqag_[A-Za-z0-9_-]{43}$/.test(auth),401,'A valid agent bearer token is required.');
    const hash=digest(auth.slice(7)),now=Date.now();
    for(const [key,b] of attempts)if(b.until<=now)attempts.delete(key);
    fail(attempts.size<10000||attempts.has(hash),429,'Agent request capacity reached.');
    const bucket=attempts.get(hash)||{count:0,until:now+60000};
    fail(bucket.count++<120,429,'Agent request limit reached. Retry after one minute.');attempts.set(hash,bucket);
    return liveGrant(db.prepare('SELECT * FROM agent_grants WHERE token_hash=?').get(hash));
  }
  function view(user){
    principal(user);
    return {apiVersion:AGENT_API_VERSION,recordTypes:AGENT_RECORD_TYPES,
      grants:db.prepare('SELECT * FROM agent_grants ORDER BY revoked IS NOT NULL,created DESC LIMIT 1500').all().map(publicGrant),
      proposals:db.prepare("SELECT * FROM agent_proposals ORDER BY status!='pending',created DESC LIMIT 5500").all().map(r=>{
        const {fingerprint,action,...fields}=r;return {...fields,action:JSON.parse(action)};
      })};
  }
  function validateProposal(grant,p,state,revision){
    keys(p,['companyId','requestId','revision','action']);
    fail(p.companyId===grant.company,403,'Company access denied.');
    fail(grant.proposals,403,'This grant cannot propose changes.');
    fail(typeof p.requestId==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(p.requestId),400,'A stable request ID is required.');
    keys(p.action,['type','name','kind','date']);
    const a=p.action,type=a.type==='contact'?'contacts':a.type==='item'?'items':null;
    fail(type&&JSON.parse(grant.types).includes(type),403,'This record type is outside the grant.');
    fail(text(a.name)&&typeof a.date==='string',400,'Provide a name and calendar date.');
    fail((type==='contacts'?['Customer','Vendor']:['Product','Service']).includes(a.kind),400,'Choose a valid record kind.');
    revisionCheck(revision,p.revision);
    const c=state.companies.find(c=>c.id===grant.company),records=type==='contacts'?c.parties:c.items;
    fail(!records.some(r=>r.kind===a.kind&&r.name.trim().toLocaleLowerCase('en-US')===a.name.trim().toLocaleLowerCase('en-US')),409,'A matching record already exists. Review the existing record.');
    const clean={type:a.type,name:a.name.trim(),kind:a.kind,date:a.date};
    apply(state,grant.company,clean); // Existing business validation; no books are written.
    return clean;
  }
  function approvalFor(p){
    keys(p,['type','id','decision','revision']);
    fail(text(p.id,80),400,'Select an agent proposal.');
    fail(['approve','reject'].includes(p.decision),400,'Choose approve or reject.');
    const proposal=db.prepare('SELECT * FROM agent_proposals WHERE id=?').get(p.id);
    fail(proposal,404,'Agent proposal is unavailable.');
    fail(proposal.status==='pending',409,'This proposal has already been decided.');
    const {state,revision}=readBooks(db);revisionCheck(revision,p.revision);
    if(p.decision!=='approve')return {proposal,revision};
    const grant=liveGrant(db.prepare('SELECT * FROM agent_grants WHERE id=?').get(proposal.grant_id));
    const action=JSON.parse(proposal.action);
    validateProposal(grant,{companyId:proposal.company,requestId:proposal.request_id,revision:proposal.base_revision,action},state,revision);
    return {proposal,revision,action};
  }
  function preflightApproval(user,p){principal(user);approvalFor(p);}
  function command(user,p,{preWrite}={}){
    const active=principal(user);
    fail(object(p),400,'Invalid agent administration request.');
    return tx(db,()=>{
      principal(active);
      if(p.type==='grant'){
        keys(p,['type','companyId','name','recordTypes','allowProposals']);
        fail(text(p.name,100)&&typeof p.companyId==='string'&&readBooks(db).state.companies.some(c=>c.id===p.companyId),400,'Choose a company and agent name.');
        const types=p.recordTypes??['contacts'];
        fail(Array.isArray(types)&&types.length>0&&new Set(types).size===types.length&&types.every(t=>AGENT_RECORD_TYPES.includes(t)),400,'Choose supported business record types.');
        fail(p.allowProposals===undefined||typeof p.allowProposals==='boolean',400,'Choose whether proposals are enabled.');
        fail(db.prepare('SELECT count(*) AS n FROM agent_grants WHERE revoked IS NULL').get().n<1000,409,'Revoke unused grants before adding another.');
        const id=randomUUID(),token='fqag_'+randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO agent_grants VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id,active.id,active.authVersion,p.companyId,p.name.trim(),JSON.stringify(types),Number(!!p.allowProposals),digest(token),new Date().toISOString());
        audit(db,active,p.companyId,'agent grant created',JSON.stringify({grantId:id,recordTypes:types,allowProposals:!!p.allowProposals}));
        return {grant:publicGrant(db.prepare('SELECT * FROM agent_grants WHERE id=?').get(id)),token};
      }
      if(p.type==='revoke'){
        keys(p,['type','id']);
        fail(text(p.id,80),400,'Select an agent grant.');
        const row=db.prepare('SELECT * FROM agent_grants WHERE id=?').get(p.id);
        fail(row,404,'Agent grant is unavailable.');
        db.prepare('UPDATE agent_grants SET revoked=COALESCE(revoked,?) WHERE id=?').run(new Date().toISOString(),row.id);
        audit(db,active,row.company,'agent grant revoked',JSON.stringify({grantId:row.id}));return {ok:true};
      }
      if(p.type==='decide'){
        const {proposal,revision,action}=approvalFor(p);
        if(p.decision==='approve'){
          preWrite?.();
          actionFor(db,active,{companyId:proposal.company,revision,action:{...action,requestId:'agent_'+proposal.id}});
        }
        const status=p.decision==='approve'?'approved':'rejected';
        db.prepare('UPDATE agent_proposals SET status=?,decided_by=?,decided_at=? WHERE id=?').run(status,active.id,new Date().toISOString(),proposal.id);
        audit(db,active,proposal.company,'agent proposal '+status,JSON.stringify({proposalId:proposal.id,grantId:proposal.grant_id}));
        return {ok:true,status,revision:readBooks(db).revision};
      }
      fail(false,400,'Unsupported agent administration command.');
    });
  }
  function request(method,url,headers,body){
    fail(method==='GET'||method==='POST',405,'Method unavailable.');
    const grant=authenticate(headers),base='/api/agents/v1/',path=url.pathname.slice(base.length);
    fail(url.pathname.startsWith(base),404,'Agent endpoint unavailable.');
    if(path==='capabilities'&&method==='GET')return {apiVersion:AGENT_API_VERSION,grant:publicGrant(grant),
      proposalTypes:grant.proposals?JSON.parse(grant.types).filter(t=>['contacts','items'].includes(t)).map(t=>t==='contacts'?'contact':'item'):[],
      excluded:['payroll','personnel','time','benefits','files','bank','journals','history'],revision:readBooks(db).revision};
    if(path==='records'&&method==='GET'){
      const type=url.searchParams.get('recordType'),companyId=url.searchParams.get('companyId');
      fail(companyId===grant.company,403,'Company access denied.');
      fail(AGENT_RECORD_TYPES.includes(type)&&JSON.parse(grant.types).includes(type),403,'This record type is outside the grant.');
      const limit=Number(url.searchParams.get('limit')||50),offset=Number(url.searchParams.get('cursor')||0);
      fail(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0,400,'Invalid pagination.');
      const {state,revision}=readBooks(db),c=state.companies.find(c=>c.id===companyId);
      const source=type==='contacts'?c.parties:type==='items'?c.items:c.docs.filter(r=>r.kind===(type==='invoices'?'invoice':'bill'));
      const fields=type==='contacts'||type==='items'?['id','name','kind']:['id','number','kind','date','party','item','qty','unit','total','parent'];
      const records=source.slice(offset,offset+limit).map(r=>project(r,fields));
      audit(db,{id:'agent:'+grant.id},companyId,'agent read',JSON.stringify({grantId:grant.id,recordType:type,count:records.length}));
      return {apiVersion:AGENT_API_VERSION,company:{id:c.id,name:c.name,currency:state.currency},recordType:type,revision,records,nextCursor:offset+limit<source.length?String(offset+limit):null};
    }
    if(path==='proposals'&&method==='POST'){
      fail(object(body)&&Buffer.byteLength(JSON.stringify(body))<=4096,413,'Agent proposal exceeds 4 KiB or is invalid.');
      return tx(db,()=>{
        liveGrant(grant);const {state,revision}=readBooks(db);
        keys(body,['companyId','requestId','revision','action']);
        fail(body.companyId===grant.company,403,'Company access denied.');
        const fingerprint=digest(JSON.stringify(body));
        const prior=typeof body.requestId==='string'?db.prepare('SELECT * FROM agent_proposals WHERE grant_id=? AND request_id=?').get(grant.id,body.requestId):null;
        if(prior){fail(prior.fingerprint===fingerprint,409,'That request ID belongs to a different proposal.');return {id:prior.id,status:prior.status,revision};}
        const action=validateProposal(grant,body,state,revision);
        fail(db.prepare("SELECT count(*) AS n FROM agent_proposals WHERE status='pending'").get().n<5000,409,'Review pending proposals before submitting more.');
        const id=randomUUID();
        db.prepare('INSERT INTO agent_proposals VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)').run(id,grant.id,grant.company,body.requestId,fingerprint,revision,JSON.stringify(action),'pending',new Date().toISOString());
        audit(db,{id:'agent:'+grant.id},grant.company,'agent proposal submitted',JSON.stringify({proposalId:id,grantId:grant.id,recordType:action.type}));
        return {id,status:'pending',revision};
      });
    }
    if(path==='proposal'&&method==='GET'){
      const p=db.prepare('SELECT id,status,base_revision FROM agent_proposals WHERE id=? AND grant_id=?').get(url.searchParams.get('id'),grant.id);
      fail(p,404,'Agent proposal is unavailable.');return p;
    }
    fail(false,404,'Agent endpoint unavailable.');
  }
  return {view,command,request,preflightApproval};
}
