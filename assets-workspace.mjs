import {randomUUID,createHash} from 'node:crypto';
import {apply,position,validateState} from './shared/core.mjs';

export const ASSET_RIGHTS=['view','manage','audit','approve'];
const check=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const now=()=>new Date().toISOString();
const text=(value,max=160,optional=false)=>{check(typeof value==='string'&&value.trim().length<=max&&(optional||value.trim()),'Enter a valid text value.');return value.trim();};
const date=value=>{check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Enter a valid calendar date.');return value;};
const integer=(value,min=0)=>{check(Number.isSafeInteger(value)&&value>=min,'Enter a whole quantity or exact cent value in range.');return value;};
const decode=row=>row?{...JSON.parse(row.body),version:row.version}:null;
function atomic(db,fn){const save='asset_'+randomUUID().replaceAll('-','');db.exec('SAVEPOINT '+save);try{const result=fn();db.exec('RELEASE '+save);return result;}catch(e){db.exec('ROLLBACK TO '+save);db.exec('RELEASE '+save);throw e;}}
function bookFor(state,id){const book=state.companies.find(c=>c.id===id);check(book,'Asset workspace unavailable.',404);return book;}
function freshAccount(db,user,company){
  const row=user?.id&&db.prepare('SELECT id,role,assignments,active FROM accounts WHERE id=?').get(user.id);
  check(row&&row.active&&row.role!=='worker'&&(row.role==='owner'||JSON.parse(row.assignments).includes(company)),'Asset workspace unavailable.',403);return row;
}
export function assetRights(db,user,company){
  const row=freshAccount(db,user,company);if(row.role==='owner')return [...ASSET_RIGHTS];
  const grants=db.prepare('SELECT rights FROM asset_workspace_grants WHERE company=? AND account=?').get(company,row.id);return grants?JSON.parse(grants.rights):[];
}
function requireRight(db,user,company,right){const rights=assetRights(db,user,company);check(rights.includes(right),'Asset '+right+' permission required.',403);return rights;}
function mayView(rights){return rights.some(r=>ASSET_RIGHTS.includes(r));}
function units(db,company){return db.prepare('SELECT body,version FROM tracked_units WHERE company=? ORDER BY identifier COLLATE NOCASE').all(company).map(decode);}
function unit(db,company,id){const row=decode(db.prepare('SELECT body,version FROM tracked_units WHERE company=? AND id=?').get(company,id));check(row,'Tracked asset unavailable.',404);return row;}
function session(db,company,id){const row=decode(db.prepare('SELECT body,version FROM asset_count_sessions WHERE company=? AND id=?').get(company,id));check(row,'Count session unavailable.',404);return row;}
function version(row,value){check(Number.isSafeInteger(value)&&row.version===value,'This record changed. Refresh before saving.',409);}
function contents(book,rows){
  check(Array.isArray(rows)&&rows.length<=200,'Use at most 200 content rows.');
  const seen=new Set();return rows.map(row=>{check(row&&book.items.some(i=>i.id===row.itemId&&i.kind==='Product'),'Select a stock product in this company.');check(!seen.has(row.itemId),'List each product once.');seen.add(row.itemId);return {itemId:row.itemId,quantity:integer(row.quantity,1)};}).sort((a,b)=>a.itemId.localeCompare(b.itemId));
}
function stockSnapshot(book,location,rows){return [...new Set(rows.map(r=>r.itemId))].sort().map(itemId=>({itemId,...position(book,itemId,location)}));}
function allocated(db,company,itemId,location,except=''){return units(db,company).filter(u=>u.id!==except&&u.location===location&&u.status!=='retired').reduce((sum,u)=>sum+(u.contents.find(c=>c.itemId===itemId)?.quantity||0),0);}
function allocationCheck(db,book,location,rows,except=''){
  for(const row of rows)check(allocated(db,book.id,row.itemId,location,except)+row.quantity<=position(book,row.itemId,location).qty,'Tracked contents exceed available stock at this location. Register or reconcile stock first.',409);
}
export function validateAssetAllocations(db,state){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tracked_units'").get())return true;
  const totals=new Map();
  for(const row of db.prepare('SELECT company,body FROM tracked_units').all()){
    const tracked=JSON.parse(row.body),book=state.companies.find(c=>c.id===row.company);
    check(book,'Tracked asset company is missing. Restore its workspace before replacing books.',409);
    if(tracked.status==='retired')continue;
    for(const content of tracked.contents){const key=JSON.stringify([book.id,tracked.location,content.itemId]);let total=totals.get(key);if(!total){total={book,location:tracked.location,itemId:content.itemId,quantity:0};totals.set(key,total);}total.quantity+=content.quantity;check(Number.isSafeInteger(total.quantity),'Tracked quantity exceeds the exact integer range.');}
  }
  for(const {book,location,itemId,quantity} of totals.values())check(book.items.some(i=>i.id===itemId&&i.kind==='Product')&&quantity<=position(book,itemId,location).qty,'This stock is packed in tracked pallets. Unpack the affected contents in Assets & pallets before consuming or replacing their stock.',409);
  return true;
}
function saveUnit(db,company,row){const {version:ver,...body}=row;db.prepare('INSERT INTO tracked_units(company,id,identifier,body,version) VALUES(?,?,?,?,?) ON CONFLICT(company,id) DO UPDATE SET identifier=excluded.identifier,body=excluded.body,version=excluded.version').run(company,row.id,row.identifier,JSON.stringify(body),ver);}
function saveSession(db,company,row){const {version:ver,...body}=row;db.prepare('INSERT INTO asset_count_sessions(company,id,body,version) VALUES(?,?,?,?) ON CONFLICT(company,id) DO UPDATE SET body=excluded.body,version=excluded.version').run(company,row.id,JSON.stringify(body),ver);}
function movement(db,user,company,row,kind,when,from,to,prior,next,note,stockSources=[],statusAfter=row.status){
  const entry={id:randomUUID(),unitId:row.id,identifier:row.identifier,kind,date:when,at:now(),actor:user.id,from,to,statusBefore:row.status,statusAfter,before:structuredClone(prior),after:structuredClone(next),note,stockSources};
  db.prepare('INSERT INTO asset_movements(company,id,unit,body) VALUES(?,?,?,?)').run(company,entry.id,row.id,JSON.stringify(entry));return entry;
}
function log(db,user,company,kind,id){db.prepare('INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)').run(now(),user.id,company,kind,id);}

export function initializeAssets(db){
  db.exec(`CREATE TABLE IF NOT EXISTS asset_workspace_grants(company TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id),rights TEXT NOT NULL,PRIMARY KEY(company,account));
    CREATE TABLE IF NOT EXISTS tracked_units(company TEXT NOT NULL,id TEXT NOT NULL,identifier TEXT NOT NULL COLLATE NOCASE,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(company,id),UNIQUE(company,identifier));
    CREATE TABLE IF NOT EXISTS asset_movements(company TEXT NOT NULL,id TEXT PRIMARY KEY,unit TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS asset_movements_scope ON asset_movements(company,unit);
    CREATE TABLE IF NOT EXISTS asset_count_sessions(company TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(company,id));
    CREATE TABLE IF NOT EXISTS asset_commands(company TEXT NOT NULL,actor TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(company,actor,request_id));
    CREATE TABLE IF NOT EXISTS asset_migrations(version INTEGER PRIMARY KEY,applied TEXT NOT NULL);
    INSERT OR IGNORE INTO asset_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TRIGGER IF NOT EXISTS asset_movements_immutable_update BEFORE UPDATE ON asset_movements BEGIN SELECT RAISE(ABORT,'Asset movement history is immutable');END;
    CREATE TRIGGER IF NOT EXISTS asset_movements_immutable_delete BEFORE DELETE ON asset_movements BEGIN SELECT RAISE(ABORT,'Asset movement history is immutable');END;`);
}

export function assetsView(db,user,state,{companyId,auditOnly=false}={}){
  const available=state.companies.filter(c=>{try{return mayView(assetRights(db,user,c.id));}catch{return false;}});
  if(companyId)check(available.some(c=>c.id===companyId),'Asset workspace unavailable.',403);
  const selected=companyId||available[0]?.id;
  if(!selected)return {companies:[],companyId:null,rights:[],units:[],sessions:[],movements:[],items:[],fixedAssets:[],grants:[],accounts:[]};
  const book=bookFor(state,selected),rights=assetRights(db,user,selected);
  check(mayView(rights),'Asset workspace unavailable.',403);
  if(auditOnly)check(rights.includes('audit')||rights.includes('approve'),'Audit portal access required.',403);
  const rows=units(db,selected),sessions=db.prepare('SELECT body,version FROM asset_count_sessions WHERE company=? ORDER BY rowid DESC').all(selected).map(decode);
  const owner=freshAccount(db,user,selected).role==='owner';
  // Stock snapshots are integrity controls, not information needed to count a
  // pallet. Cost values remain unavailable to observation-only audit accounts.
  for(const row of [...rows,...sessions])if(!owner)delete row.sourceOwnerRecord;
  if(!rights.includes('approve'))for(const row of sessions)for(const snapshot of [...row.expected,...row.observations])if(snapshot.stock)snapshot.stock=snapshot.stock.map(({value,...quantity})=>quantity);
  return {companies:available.map(({id,name})=>({id,name})),companyId:selected,rights,units:rows,sessions,
    movements:db.prepare('SELECT body FROM asset_movements WHERE company=? ORDER BY rowid DESC').all(selected).map(r=>JSON.parse(r.body)),
    items:book.items.filter(i=>i.kind==='Product').map(({id,name})=>({id,name})),fixedAssets:book.assets.map(({id,name})=>({id,name})),
    grants:owner&&!auditOnly?db.prepare('SELECT account,rights FROM asset_workspace_grants WHERE company=?').all(selected).map(r=>({accountId:r.account,rights:JSON.parse(r.rights)})):[],
    accounts:owner&&!auditOnly?db.prepare("SELECT id,name,role,assignments FROM accounts WHERE active=1 AND role!='worker'").all().filter(r=>r.role==='owner'||JSON.parse(r.assignments).includes(selected)).map(({id,name,role})=>({id,name,role})):[]};
}

export function assetsCommand(db,user,state,action){
  check(action&&typeof action==='object','Provide an asset action.');
  const company=action.companyId,book=bookFor(state,company),account=freshAccount(db,user,company);
  const required={register:'manage',move:'manage',contents:'manage','count-start':'audit','count-observe':'audit','count-submit':'audit','count-review':'approve'}[action.type];
  if(required)requireRight(db,user,company,required);
  if(action.type==='grant')check(account.role==='owner','Owner access required.',403);
  check(typeof action.requestId==='string'&&/^[a-zA-Z0-9_-]{8,120}$/.test(action.requestId),'A stable request ID is required.');
  const fingerprint=createHash('sha256').update(JSON.stringify(action)).digest('hex');
  const old=db.prepare('SELECT fingerprint,result FROM asset_commands WHERE company=? AND actor=? AND request_id=?').get(company,user.id,action.requestId);
  if(old){check(old.fingerprint===fingerprint,'Request ID belongs to a different operation.',409);return {result:{...JSON.parse(old.result),duplicate:true}};}
  return atomic(db,()=>{
    let result={},nextState;
    if(action.type==='grant'){
      check(account.role==='owner','Owner access required.',403);
      const target=freshAccount(db,{id:action.accountId},company);check(target.role!=='owner','Owner already has all asset rights.');
      check(Array.isArray(action.rights)&&action.rights.every(r=>ASSET_RIGHTS.includes(r))&&new Set(action.rights).size===action.rights.length,'Choose valid asset rights.');
      db.prepare('INSERT INTO asset_workspace_grants VALUES(?,?,?) ON CONFLICT(company,account) DO UPDATE SET rights=excluded.rights').run(company,target.id,JSON.stringify(action.rights));result={accountId:target.id};
    }else if(action.type==='register'){
      requireRight(db,user,company,'manage');
      const identifier=text(action.identifier,100);check(/^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]*$/.test(identifier),'Use a manual or barcode ID containing letters, numbers, spaces or . _ : / -.');
      check(!db.prepare('SELECT 1 FROM tracked_units WHERE company=? AND identifier=? COLLATE NOCASE').get(company,identifier),'This asset or pallet ID already exists.',409);
      check(['asset','pallet'].includes(action.kind),'Choose asset or pallet.');
      const when=date(action.date),location=text(action.location),rows=contents(book,action.contents||[]);
      allocationCheck(db,book,location,rows);
      const fixedAssetId=action.fixedAssetId||'';check(!fixedAssetId||(action.kind==='asset'&&book.assets.some(a=>a.id===fixedAssetId)),'Only an individual asset can link to an existing fixed asset.');
      check(!fixedAssetId||!units(db,company).some(u=>u.fixedAssetId===fixedAssetId),'This fixed asset already has a tracking ID.',409);
      const row={id:randomUUID(),identifier,kind:action.kind,name:text(action.name),location,status:'active',contents:rows,fixedAssetId,created:now(),lastDate:when,version:1};
      saveUnit(db,company,row);movement(db,user,company,row,'registered',when,'',location,[],rows,text(action.note||'',1000,true));result={unitId:row.id};
    }else if(action.type==='move'){
      requireRight(db,user,company,'manage');const row=unit(db,company,action.unitId);version(row,action.version);
      const when=date(action.date),location=text(action.location),note=text(action.note||'',1000,true),status=action.status||row.status;
      check(['active','in-transit','quarantine','retired'].includes(status),'Choose a valid tracking status.');
      check(when>=row.lastDate,'Movement date precedes this asset history.',409);
      check(location!==row.location||status!==row.status,'Choose a new location or status.');
      check(status!=='retired'||!row.contents.length,'Reconcile contents to zero before retiring a container.');
      const stockSources=[];
      if(location!==row.location){
        let next=state;for(const content of row.contents){next=apply(next,company,{type:'transfer',item:content.itemId,qty:content.quantity,location:row.location,to:location,date:when,label:'Tracked movement '+row.identifier,requestId:'asset-'+randomUUID()});stockSources.push(next.companies.find(c=>c.id===company).history.at(-1).id);}
        if(stockSources.length){validateState(next);nextState=next;}
      }
      movement(db,user,company,row,'moved',when,row.location,location,row.contents,row.contents,note,stockSources,status);
      saveUnit(db,company,{...row,location,status,lastDate:when,version:row.version+1});result={unitId:row.id,stockSources};
    }else if(action.type==='contents'){
      requireRight(db,user,company,'manage');const row=unit(db,company,action.unitId);version(row,action.version);
      const when=date(action.date),rows=contents(book,action.contents||[]),note=text(action.note,1000);
      check(row.status!=='retired','A retired asset cannot receive contents.',409);check(when>=row.lastDate,'Content date precedes this asset history.',409);
      check(JSON.stringify(rows)!==JSON.stringify(row.contents),'Change at least one packed quantity.');allocationCheck(db,book,row.location,rows,row.id);
      movement(db,user,company,row,'packed-unpacked',when,row.location,row.location,row.contents,rows,note);
      saveUnit(db,company,{...row,contents:rows,lastDate:when,version:row.version+1});result={unitId:row.id};
    }else if(action.type==='count-start'){
      requireRight(db,user,company,'audit');check(Array.isArray(action.unitIds)&&action.unitIds.length&&action.unitIds.length<=200&&new Set(action.unitIds).size===action.unitIds.length,'Choose 1–200 different tracked assets.');
      const when=date(action.date),expected=action.unitIds.map(id=>{const row=unit(db,company,id);check(when>=row.lastDate,'Count date precedes asset movement history.',409);return {unitId:row.id,identifier:row.identifier,version:row.version,location:row.location,status:row.status,contents:structuredClone(row.contents),stock:stockSnapshot(book,row.location,row.contents)};});
      const row={id:randomUUID(),name:text(action.name),date:when,status:'open',created:now(),createdBy:user.id,expected,observations:[],version:1};saveSession(db,company,row);result={sessionId:row.id};
    }else if(action.type==='count-observe'){
      requireRight(db,user,company,'audit');const row=session(db,company,action.sessionId);version(row,action.version);
      check(row.status==='open','This count was already submitted.',409);
      check(row.createdBy===user.id||account.role==='owner','Only the count creator can record its observations.',403);
      check(row.expected.some(e=>e.unitId===action.unitId),'This asset is outside the count session.');
      const clean=contents(book,action.contents||[]),expected=row.expected.find(e=>e.unitId===action.unitId);
      const observed={unitId:action.unitId,location:text(action.location),contents:clean,stock:stockSnapshot(book,expected.location,[...expected.contents,...clean]),unknownContents:text(action.unknownContents||'',1000,true),note:text(action.note||'',1000,true),observedAt:now(),observedBy:user.id};
      const observations=[...row.observations.filter(o=>o.unitId!==action.unitId),observed];saveSession(db,company,{...row,observations,version:row.version+1});result={sessionId:row.id};
    }else if(action.type==='count-submit'){
      requireRight(db,user,company,'audit');const row=session(db,company,action.sessionId);version(row,action.version);
      check(row.status==='open','This count was already submitted.',409);check(row.createdBy===user.id||account.role==='owner','Only the count creator can submit it.',403);
      check(row.observations.length===row.expected.length,'Record an observation for every selected asset.');
      saveSession(db,company,{...row,status:'submitted',submitted:now(),submittedBy:user.id,version:row.version+1});result={sessionId:row.id};
    }else if(action.type==='count-review'){
      requireRight(db,user,company,'approve');const row=session(db,company,action.sessionId);version(row,action.version);
      check(row.status==='submitted','Only a submitted count can be reviewed.',409);check(['approve','reject'].includes(action.decision),'Choose approve or reject.');
      const reason=text(action.reason,1000);let corrections=[];
      if(action.decision==='approve'){
        const when=date(action.date);check(when>=row.date,'Adjustment date precedes count date.');
        let next=state;
        for(const expected of row.expected){
          const current=unit(db,company,expected.unitId);check(current.version===expected.version&&current.location===expected.location,'A counted asset changed. Reject this count and start a fresh count.',409);
          const observed=row.observations.find(o=>o.unitId===expected.unitId);check(observed.location===expected.location,'Location discrepancies need a separately authorized movement before a fresh count.',409);
          check(JSON.stringify(observed.stock||expected.stock)===JSON.stringify(stockSnapshot(book,expected.location,[...expected.contents,...observed.contents])),'Stock changed since the observation. Reject this count and start a fresh count.',409);
          check(!observed.unknownContents,'Identify unknown contents before starting a fresh count. This count remains in history.',409);
          check(when>=current.lastDate,'Adjustment date precedes movement history.');
          const itemIds=new Set([...expected.contents,...observed.contents].map(c=>c.itemId)),stockSources=[];
          for(const itemId of itemIds){
            const before=expected.contents.find(c=>c.itemId===itemId)?.quantity||0,after=observed.contents.find(c=>c.itemId===itemId)?.quantity||0,delta=after-before;
            if(!delta)continue;
            const value=delta>0?integer(action.values?.[expected.unitId]?.[itemId],1):undefined;
            next=apply(next,company,{type:delta>0?'adjust in':'adjust out',item:itemId,qty:Math.abs(delta),amount:value,location:current.location,date:when,label:'Approved count '+current.identifier,requestId:'asset-'+randomUUID()});
            stockSources.push(next.companies.find(c=>c.id===company).history.at(-1).id);
          }
          const correction={unitId:current.id,before:structuredClone(expected.contents),after:structuredClone(observed.contents),stockSources};corrections.push(correction);
          movement(db,user,company,current,'count-approved',when,current.location,current.location,expected.contents,observed.contents,reason,stockSources);
          saveUnit(db,company,{...current,contents:observed.contents,lastDate:when,version:current.version+1});
        }
        const nextBook=bookFor(next,company);for(const expected of row.expected){const current=unit(db,company,expected.unitId);allocationCheck(db,nextBook,current.location,current.contents,current.id);}
        validateState(next);if(corrections.some(c=>c.stockSources.length))nextState=next;
      }
      saveSession(db,company,{...row,status:action.decision==='approve'?'approved':'rejected',reviewed:now(),reviewedBy:user.id,reason,corrections,adjustmentDate:action.decision==='approve'?action.date:null,version:row.version+1});result={sessionId:row.id,corrections};
    }else check(false,'Unknown asset operation.');
    log(db,user,company,'asset '+action.type,result.unitId||result.sessionId||result.accountId||'');
    db.prepare('INSERT INTO asset_commands VALUES(?,?,?,?,?)').run(company,user.id,action.requestId,fingerprint,JSON.stringify(result));
    return {result,...(nextState?{state:nextState}:{})};
  });
}
