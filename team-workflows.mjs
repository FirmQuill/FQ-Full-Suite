import {randomUUID} from 'node:crypto';
import {requireArea,requireWorkerFeature,accountAreas} from './access.mjs';
import {audit} from './store.mjs';
import {employeeProfile} from './records.mjs';

const check=(ok,msg,status=400)=>{if(!ok)throw Object.assign(Error(msg),{status});};
const tidy=(value,max,optional=false)=>{check(typeof value==='string'&&value.length<=max&&(optional||value.trim()),'Enter valid text.');return value.trim();};
function day(v){check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v,'Enter a valid date.');return v;}
const arithmetic=values=>{const n=values.reduce((s,v)=>s+BigInt(v),0n);check(n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(Number.MIN_SAFE_INTEGER),'Amount or quantity exceeds safe limits.');return Number(n);};
const at=()=>new Date().toISOString();
const positive=(n,min=1)=>{check(Number.isSafeInteger(n)&&n>=min,'Enter a valid positive amount or quantity.');return n;};
const row=r=>({...JSON.parse(r.body),id:r.id,version:r.version});
const belongs=(user,id)=>user.role==='owner'||user.assignments.includes(id);
export function initializeTeamWorkflows(db){
  db.exec(`CREATE TABLE IF NOT EXISTS team_requests (company TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(company,kind,id));`);
}
function company(state,u,id){
  check(typeof id==='string'&&belongs(u,id),'Company unavailable.',404);
  const c=state.companies.find(x=>x.id===id);check(c,'Company unavailable.',404);return c;
}
const read=(db,c,kind,id)=>{const r=db.prepare('SELECT * FROM team_requests WHERE company=? AND kind=? AND id=?').get(c,kind,id);return r&&row(r);};
const rows=(db,c,kind)=>db.prepare('SELECT * FROM team_requests WHERE company=? AND kind=? ORDER BY rowid DESC').all(c,kind).map(row);
function save(db,u,c,kind,body,prior=null){
  const id=prior?.id||randomUUID(),version=(prior?.version||0)+1;
  if(prior)db.prepare('UPDATE team_requests SET body=?,version=? WHERE company=? AND kind=? AND id=?').run(JSON.stringify(body),version,c,kind,id);
  else db.prepare('INSERT INTO team_requests VALUES(?,?,?,?,?)').run(c,kind,id,JSON.stringify(body),version);
  audit(db,u,c,kind+' '+body.status,id);
  return {id,version};
}
function expect(db,c,kind,a,state){
  const item=read(db,c,kind,a.id);check(item,'Request unavailable.',404);
  check(item.version===a.version,'Request changed. Refresh before saving.',409);
  check(state.includes(item.status),'This request is not in a state that allows this change.',409);
  return item;
}
const isBuyer=u=>['owner','manager','bookkeeper'].includes(u.role);
const isReviewer=u=>['owner','manager'].includes(u.role);
export function teamPages(db,u){
  const areas=accountAreas(db,u);
  return [...(u.role==='owner'||areas.includes('Purchasing')?['Purchase requests']:[]), ...(isReviewer(u)&&areas.includes('Employee records')?['Time off review']:[])];
}

const docLines=d=>d?.lines?.length?d.lines.map((l,i)=>({id:l.sourceLineId||l.parentLineId||l.lineId||l.id||String(i+1),item:l.itemId||l.item,qty:l.qty??l.quantity,total:l.total??l.totalCents??l.netCents,unit:l.unit??l.unitCents})):
  d?[{id:'legacy',item:d.item,qty:d.qty,total:d.total,unit:d.unit}]:[];
const parents=d=>[d.parent,...(d.receiptIds||[])].filter(Boolean);
// Independent snapshots, totals in cents. Matching never posts, pays, or overrides actual payable balances.
export function purchaseMatches(docs){
  const byParent=new Map();
  for(const doc of docs)for(const parent of new Set(parents(doc))){
    if(!byParent.has(parent))byParent.set(parent,[]);
    byParent.get(parent).push(doc);
  }
  return docs.filter(d=>d.kind==='purchase order').map(po=>{
    const receipts=(byParent.get(po.id)||[]).filter(d=>d.kind==='receiving');
    const bills=[...new Map([...receipts.flatMap(r=>byParent.get(r.id)||[]),...(byParent.get(po.id)||[])].filter(d=>d.kind==='bill').map(d=>[d.id,d])).values()];
    const aggregate=xs=>{
      const map=new Map();
      for(const l of xs.flatMap(docLines)){
        const key=l.id;const r=map.get(key)||{qty:0,total:0,items:new Set()};
        if(!Number.isSafeInteger(l.qty)||!Number.isSafeInteger(l.total)||l.qty<=0||l.total<0)r.invalid=true;
        else {r.qty=arithmetic([r.qty,l.qty]);r.total=arithmetic([r.total,l.total]);}
        r.items.add(l.item);map.set(key,r);
      }
      return map;
    };
    const expected=aggregate([po]),received=aggregate(receipts),billed=aggregate(bills),reasons=[];
    const lines=[...new Set([...expected.keys(),...received.keys(),...billed.keys()])].map(id=>{
      const p=expected.get(id),r=received.get(id),b=billed.get(id), item=[...(p?.items||r?.items||b.items)][0];
      if(!p||p.invalid||r?.invalid||b?.invalid||[p,r,b].some(x=>x&&[...x.items].some(i=>i!==item)))reasons.push('Unrecognized or invalid line on linked documents.');
      else if((r?.qty||0)>p.qty||(b?.qty||0)>(r?.qty||0)||(b?.total||0)>(r?.total||0))reasons.push('Received or billed quantity/amount exceeds its comparison.');
      else if(r&&((r.qty===p.qty&&r.total!==p.total)||(BigInt(r.total)*BigInt(p.qty)-BigInt(p.total)*BigInt(r.qty)>BigInt(p.qty))||(BigInt(p.total)*BigInt(r.qty)-BigInt(r.total)*BigInt(p.qty)>BigInt(p.qty))))reasons.push('Receipt value differs from the purchase order.');
      else if(b&&r&&((b.qty===r.qty&&b.total!==r.total)||(BigInt(b.total)*BigInt(r.qty)-BigInt(r.total)*BigInt(b.qty)>BigInt(r.qty))||(BigInt(r.total)*BigInt(b.qty)-BigInt(b.total)*BigInt(r.qty)>BigInt(r.qty))))reasons.push('Bill value differs from its receipt.');
      return {id,item,ordered:p?.qty||0,received:r?.qty||0,billed:b?.qty||0,orderCents:p?.total||0,receivedCents:r?.total||0,billedCents:b?.total||0};
    });
    const billedByReceipt=new Map();
    for(const bill of bills){
      const billReceipts=[...new Set(parents(bill))].map(id=>receipts.find(r=>r.id===id)).filter(Boolean);
      if(!billReceipts.length||billReceipts.some(r=>r.party!==po.party)||bill.party!==po.party)reasons.push('Bill is not linked to a receipt from the same vendor.');
      if(billReceipts.length===1)billedByReceipt.set(billReceipts[0].id,[...(billedByReceipt.get(billReceipts[0].id)||[]),bill]);
      if(billReceipts.length>1)reasons.push('Bill has multiple receipt links; reconcile allocation separately.');
    }
    for(const receipt of receipts){
      if(receipt.party!==po.party)reasons.push('Receipt vendor differs from the purchase order.');
      const local=aggregate([receipt]);for(const [id,val] of aggregate(billedByReceipt.get(receipt.id)||[])){
        const got=local.get(id);if(!got||val.qty>got.qty||val.total>got.total)reasons.push('Bill exceeds the specific linked receipt.');
      }
    }
    const status=reasons.length?'Variance':!receipts.length?'Awaiting receipt':!bills.length?'Awaiting bill':
      lines.every(l=>l.ordered===l.received&&l.received===l.billed&&l.orderCents===l.receivedCents&&l.receivedCents===l.billedCents)?'Matched':'Partial match';
    return {poId:po.id,number:po.number,label:po.label,status,receiptCount:receipts.length,billCount:bills.length,lines,reasons:[...new Set(reasons)]};
  });
}

export function purchasingView(db,u,state,visible,cid){
  requireArea(db,u,'Purchasing');const c=company(state,u,cid),safe=visible.companies.find(x=>x.id===cid);
  const matches=purchaseMatches(safe?.docs||[]),poIds=new Set(matches.map(p=>p.poId));
  const requests=rows(db,c.id,'purchase request').filter(x=>canReviewPurchase(u)||x.requestedBy===u.id).map(x=>x.poId&&!poIds.has(x.poId)?{...x,poId:''}:x);
  return {requests,matches,mayRequest:isBuyer(u),mayReview:canReviewPurchase(u)};
}
function canReviewPurchase(u){return isReviewer(u);}
export function purchasingCommand(db,u,state,visible,a){
  requireArea(db,u,'Purchasing');check(isBuyer(u),'Purchasing write access required.',403);
  const c=company(state,u,a.companyId),kind='purchase request';
  if(a.type==='submit'){
    const item=a.itemId||'';check(!item||c.items.some(i=>i.id===item),'Choose an item in this company.');
    return save(db,u,c.id,kind,{description:tidy(a.description,200),reason:tidy(a.reason||'',500,true),itemId:item,
      qty:positive(a.qty),estimatedUnit:positive(a.estimatedUnit,0),needBy:day(a.needBy),requestedBy:u.id,requesterName:u.name,status:'pending',createdAt:at()});
  }
  if(a.type==='cancel'){
    const {id,version,...old}=expect(db,c.id,kind,a,['pending']);check(old.requestedBy===u.id,'Only the requestor can withdraw this request.',403);
    return save(db,u,c.id,kind,{...old,status:'withdrawn',resolvedAt:at()},{id,version});
  }
  check(canReviewPurchase(u),'Purchase request review access required.',403);
  if(a.type==='review'){
    const {id,version,...old}=expect(db,c.id,kind,a,['pending']);
    check(['approved','declined'].includes(a.decision),'Choose a review decision.');
    return save(db,u,c.id,kind,{...old,status:a.decision,reviewNote:tidy(a.note||'',500,a.decision==='approved'),reviewedAt:at(),reviewedBy:u.id},{id,version});
  }
  check(a.type==='link','Unknown purchasing action.');
  const {id,version,...old}=expect(db,c.id,kind,a,['approved']);
  const p=visible.companies.find(x=>x.id===c.id)?.docs.find(d=>d.id===a.poId&&d.kind==='purchase order');
  check(p,'Purchase order unavailable.',404);check(!old.itemId||docLines(p).some(l=>l.item===old.itemId),'The PO does not include the requested item.');
  check(!rows(db,c.id,kind).some(r=>r.id!==id&&r.poId===p.id),'Purchase order already linked to another request.',409);
  return save(db,u,c.id,kind,{...old,status:'linked',poId:p.id,linkedAt:at(),linkedBy:u.id},{id,version});
}

const categories=['Vacation','Personal','Sick','Other paid leave'];
function myWorker(db,u,state){
  check(u.role==='worker'&&u.assignments.length===1,'Employee portal access required.',403);requireWorkerFeature(db,u,'Time off');
  const c=company(state,u,u.assignments[0]);const e=c.employees.find(x=>x.id===u.employeeId);check(e,'Employee unavailable.',404);return {c,e};
}
const publicLeave=({employeeId,requestedBy,reviewedBy,...r})=>r;
export function myLeave(db,u,state){
  const {c,e}=myWorker(db,u,state);
  return {categories,requests:rows(db,c.id,'time off').filter(r=>r.employeeId===e.id).map(publicLeave)};
}
export function workerLeaveCommand(db,u,state,a){
  const {c,e}=myWorker(db,u,state),kind='time off';
  if(a.type==='submit'){
    const from=day(a.from),through=day(a.through);check(from<=through&&Date.parse(through)-Date.parse(from)<=365*86400000,'Choose a valid date range up to one year.');
    check(categories.includes(a.category),'Choose a time-off type.');
    check(!rows(db,c.id,kind).some(r=>r.employeeId===e.id&&['pending','approved'].includes(r.status)&&from<=r.through&&through>=r.from),'You already have an overlapping request.',409);
    return save(db,u,c.id,kind,{employeeId:e.id,employeeName:e.name,from,through,category:a.category,note:tidy(a.note||'',500,true),requestedBy:u.id,status:'pending',createdAt:at()});
  }
  check(a.type==='withdraw','Unknown time-off action.');
  const {id,version,...old}=expect(db,c.id,kind,a,['pending']);check(old.employeeId===e.id,'Request unavailable.',404);
  return save(db,u,c.id,kind,{...old,status:'withdrawn',resolvedAt:at()},{id,version});
}
function reviewCompany(db,u,state,cid){
  const c=company(state,u,cid);requireArea(db,u,'Employee records');check(isReviewer(u),'Manager time-off review access required.',403);return c;
}
function canReviewEmployee(db,u,state,c,employeeId){
  if(!c.employees.some(e=>e.id===employeeId))return false;
  if(u.role==='owner')return true;
  const profile=employeeProfile(db,state,c.id,employeeId);
  return profile.managerAccountId===u.id||!!u.employeeId&&profile.managerEmployeeId===u.employeeId;
}
export function reviewLeave(db,u,state,cid){
  const c=reviewCompany(db,u,state,cid);
  return {requests:rows(db,c.id,'time off').filter(r=>canReviewEmployee(db,u,state,c,r.employeeId)).map(publicLeave)};
}
export function reviewLeaveCommand(db,u,state,a){
  const c=reviewCompany(db,u,state,a.companyId),kind='time off';
  check(a.type==='review','Unknown time-off review action.');
  const selected=read(db,c.id,kind,a.id);check(selected&&canReviewEmployee(db,u,state,c,selected.employeeId),'Request unavailable.',404);
  const {id,version,...old}=expect(db,c.id,kind,a,['pending']);
  check(u.employeeId!==old.employeeId,'Your own time off must be reviewed by another manager.',403);
  check(['approved','declined'].includes(a.decision),'Choose a review decision.');
  return save(db,u,c.id,kind,{...old,status:a.decision,reviewNote:tidy(a.note||'',500,a.decision==='approved'),reviewedAt:at(),reviewedBy:u.id},{id,version});
}
