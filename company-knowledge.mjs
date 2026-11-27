import {randomUUID} from 'node:crypto';
import {accountAreas,workerFeatures} from './access.mjs';

export const knowledgeFeature='Company knowledge';
const roles=['reader','editor','publisher','editor and publisher'];
const need=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const now=()=>new Date().toISOString();
function text(value,max,required=true){
  need(typeof value==='string'&&value.length<=max&&!value.includes('\0'),'Invalid text or maximum length exceeded.');
  const clean=value.trim();need(!required||clean,'This field is required.');return clean;
}
function content(input){
  const title=text(input.title,160),category=text(input.category||'',80,false),body=text(input.body,24000);
  const tagText=text(input.tags||'',500,false);
  const tags=[...new Map(tagText.split(',').map(t=>t.trim()).filter(Boolean).map(t=>[t.toLowerCase(),t])).values()];
  need(tags.length<=12&&tags.every(t=>t.length<=40),'Use up to 12 tags of 40 characters each.');
  return {title,category,body,tags};
}
export function initializeCompanyKnowledge(db){
  db.exec(`CREATE TABLE IF NOT EXISTS company_knowledge_articles(
    company TEXT NOT NULL, id TEXT NOT NULL, current_revision INTEGER NOT NULL,
    working_revision INTEGER NOT NULL, published_revision INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL,
    PRIMARY KEY(company,id));
    CREATE INDEX IF NOT EXISTS company_knowledge_updated ON company_knowledge_articles(company,updated DESC,id);
    CREATE TABLE IF NOT EXISTS company_knowledge_revisions(
      company TEXT NOT NULL, article TEXT NOT NULL, revision INTEGER NOT NULL,
      event TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
      tags TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL, actor TEXT NOT NULL, created TEXT NOT NULL,
      PRIMARY KEY(company,article,revision),
      FOREIGN KEY(company,article) REFERENCES company_knowledge_articles(company,id));
    CREATE TABLE IF NOT EXISTS company_knowledge_access(
      company TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id), role TEXT NOT NULL,
      PRIMARY KEY(company,account));`);
}
function companyScope(db,user,state,companyId){
  if(user.role==='worker'){
    need(user.assignments.length===1,'Company unavailable.',404);
    need((!companyId||companyId===user.assignments[0]),'Company unavailable.',404);
    companyId=user.assignments[0];
    need(workerFeatures(db,user).includes(knowledgeFeature),'Company knowledge is not enabled for this employee account.',403);
  }else {
    need(user.role==='owner'||user.assignments.includes(companyId),'Company unavailable.',404);
    need(user.role==='owner'||accountAreas(db,user).includes(knowledgeFeature),'Company knowledge is not enabled for this ERP account.',403);
  }
  need(state.companies.some(c=>c.id===companyId),'Company unavailable.',404);
  return companyId;
}
function permissions(db,user,company){
  if(user.role==='owner')return {edit:true,publish:true,manage:true};
  if(user.role==='worker')return {edit:false,publish:false,manage:false};
  const granted=db.prepare('SELECT role FROM company_knowledge_access WHERE company=? AND account=?').get(company,user.id)?.role;
  return {edit:granted==='editor'||granted==='editor and publisher',publish:granted==='publisher'||granted==='editor and publisher',manage:false};
}
function revisionAt(db,company,article,number){
  const row=db.prepare('SELECT * FROM company_knowledge_revisions WHERE company=? AND article=? AND revision=?').get(company,article,number);
  if(row?.event!=='Withdrawn')return row;
  const prior=db.prepare("SELECT * FROM company_knowledge_revisions WHERE company=? AND article=? AND revision<? AND event<>'Withdrawn' ORDER BY revision DESC LIMIT 1").get(company,article,number);
  return prior&&{...prior,revision:row.revision,event:row.event,created:row.created};
}
function expose(row){return {title:row.title,category:row.category,tags:JSON.parse(row.tags),body:row.body,version:row.revision,updated:row.created};}
function metadata(row,admin){
  const basic={id:row.id,title:row.title,category:row.category,tags:JSON.parse(row.tags),updated:admin?row.updated:row.created};
  return admin?{...basic,version:row.current_revision,status:row.published_revision?(row.working_revision===row.published_revision?'Published':'Draft update'):'Draft'}:basic;
}
export function companyKnowledgeView(db,user,state,{companyId,id,version,q}={}){
  const company=companyScope(db,user,state,companyId),rights=permissions(db,user,company),admin=rights.edit||rights.publish;
  if(id){
    const row=db.prepare('SELECT * FROM company_knowledge_articles WHERE company=? AND id=?').get(company,id);
    need(row&&(admin||row.published_revision),'Article unavailable.',404);
    need(!version||admin,'Revision history is unavailable.',404);
    if(version)need(/^[1-9]\d{0,7}$/.test(version),'Revision unavailable.',404);
    const r=revisionAt(db,company,id,version?Number(version):admin?row.working_revision:row.published_revision);
    need(r,'Revision unavailable.',404);
    return {rights,article:{id,...expose(r),...(admin?{status:row.published_revision?(row.working_revision===row.published_revision?'Published':'Draft update'):'Draft',editVersion:row.current_revision,historical:!!version}: {})},history:admin?db.prepare('SELECT revision AS version,event,created FROM company_knowledge_revisions WHERE company=? AND article=? ORDER BY revision DESC LIMIT 100').all(company,id):[]};
  }
  const query=text(q||'',160,false).toLowerCase().trim();
  const terms=query.split(/\s+/).filter(Boolean).slice(0,8);
  const rows=db.prepare(`SELECT a.id,a.current_revision,a.working_revision,a.published_revision,a.updated,r.title,r.category,r.tags,r.created
    FROM company_knowledge_articles a JOIN company_knowledge_revisions r
    ON r.company=a.company AND r.article=a.id AND r.revision=${admin?'a.working_revision':'a.published_revision'}
    WHERE a.company=?${terms.map(()=> ' AND instr(r.search_text,?)>0').join('')}
    ORDER BY ${admin?'a.updated':'r.created'} DESC,a.id LIMIT 61`).all(company,...terms);
  const accounts=rights.manage?db.prepare("SELECT id,name,assignments FROM accounts WHERE role NOT IN ('owner','worker') AND active=1 ORDER BY name,id").all()
    .filter(a=>JSON.parse(a.assignments).includes(company)).map(a=>({id:a.id,name:a.name,role:db.prepare('SELECT role FROM company_knowledge_access WHERE company=? AND account=?').get(company,a.id)?.role||'reader'})):[];
  return {rights,articles:rows.slice(0,60).map(r=>metadata(r,admin)),more:rows.length>60,accounts};
}
export function companyKnowledgeCommand(db,user,state,companyId,input){
  const company=companyScope(db,user,state,companyId),rights=permissions(db,user,company);
  need(user.role!=='worker','Employee portal is read-only.',403);
  need(input&&typeof input==='object'&&!Array.isArray(input),'Choose an article action.');
  if(input.type==='grant'){
    need(rights.manage,'Only an owner can manage knowledge access.',403);
    const account=db.prepare("SELECT id,assignments FROM accounts WHERE id=? AND role NOT IN ('worker','owner') AND active=1").get(input.account);
    need(account&&JSON.parse(account.assignments).includes(company),'Choose an active company ERP account.',404);
    need(roles.includes(input.role),'Invalid knowledge access role.');
    if(input.role==='reader')db.prepare('DELETE FROM company_knowledge_access WHERE company=? AND account=?').run(company,account.id);
    else db.prepare('INSERT INTO company_knowledge_access VALUES(?,?,?) ON CONFLICT(company,account) DO UPDATE SET role=excluded.role').run(company,account.id,input.role);
    return {id:account.id,operation:input.type};
  }
  need(['save','publish','withdraw','restore'].includes(input.type),'Choose an article action.');
  need(['save','restore'].includes(input.type)?rights.edit:rights.publish,'This knowledge action is not granted to your account.',403);
  const id=input.id||randomUUID();
  let row=db.prepare('SELECT * FROM company_knowledge_articles WHERE company=? AND id=?').get(company,id);
  const clock=now();
  if(!row){
    need(input.type==='save'&&!input.id,'Article unavailable.',404);
    need(db.prepare('SELECT count(*) AS n FROM company_knowledge_articles WHERE company=?').get(company).n<5000,'This company has reached 5,000 articles.',413);
    db.prepare('INSERT INTO company_knowledge_articles VALUES(?,?,0,0,0,?)').run(company,id,clock);
    row={current_revision:0,working_revision:0,published_revision:0};
  }else need(Number.isSafeInteger(input.version)&&input.version===row.current_revision,'The article changed. Reopen it before editing.',409);
  let prior,snapshot,event,working=row.working_revision,published=row.published_revision;
  const version=row.current_revision+1;
  if(input.type==='save'){snapshot=content(input);event='Draft saved';working=version;}
  else{
    const source=input.type==='restore'?input.sourceVersion:row.working_revision;
    need(Number.isSafeInteger(source)&&source>0,'Revision unavailable.',404);
    prior=revisionAt(db,company,id,source);
    need(prior,'Revision unavailable.',404);snapshot=expose(prior);
    if(input.type==='publish'){need(working!==published,'This working revision is already published.',409);event='Published';working=published=version;}
    if(input.type==='withdraw'){need(published,'This article is not published.',409);event='Withdrawn';published=0;}
    if(input.type==='restore'){event='Restored as draft';working=version;}
  }
  const {title,category,tags,body}=snapshot;
  const tagsJson=JSON.stringify(tags), search=[title,category,...tags,body].join(' ').toLowerCase();
  // Limit KB contribution independently of the shared database/recovery format.
  // Withdrawal records remain available even when content capacity is reached.
  if(input.type!=='withdraw'){
    const used=db.prepare(`SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(category AS BLOB))+length(CAST(tags AS BLOB))+length(CAST(body AS BLOB))+length(CAST(search_text AS BLOB))),0) AS n FROM company_knowledge_revisions`).get().n;
    need(used+[title,category,tagsJson,body,search].reduce((n,x)=>n+Buffer.byteLength(x),0)<=8*1024*1024,
      'The local knowledge base reached its 8 MiB article revision limit. Existing articles and withdrawal remain available.',413);
  }
  const persisted=input.type==='withdraw'?['','','[]','','']:[title,category,tagsJson,body,search];
  db.prepare('INSERT INTO company_knowledge_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(company,id,version,event,...persisted,user.id,clock);
  db.prepare('UPDATE company_knowledge_articles SET current_revision=?,working_revision=?,published_revision=?,updated=? WHERE company=? AND id=?').run(version,working,published,clock,company,id);
  return {id,version,operation:input.type};
}
