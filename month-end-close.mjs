import {createHash,randomUUID} from 'node:crypto';
import {accounts,statements,sum} from './shared/core.mjs';
import {accountAreas} from './access.mjs';
import {actionFor,audit,readBooks,requireThat,scoped} from './store.mjs';

const needed=['Accounting','Banking','Reports','Purchasing','Sales','Approvals'];
const financeKinds=new Set(['fulfillment','invoice','collection','sales credit','receiving','bill','payment','vendor credit','transfer','adjust in','adjust out','assemble','asset','depreciate','journal','reverse journal','close','intercompany','statement import','match','reconcile']);
const statuses=['prepared','withdrawn','signed'];
const localDay=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
export function initializeMonthEndClose(db){
  db.exec(`CREATE TABLE IF NOT EXISTS month_end_close (
    company TEXT NOT NULL,period TEXT NOT NULL,cutoff TEXT NOT NULL,version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','withdrawn','signed')),
    preparer TEXT NOT NULL REFERENCES accounts(id),prepared_at TEXT NOT NULL,prepared_revision INTEGER NOT NULL,
    prepare_note TEXT NOT NULL,digest TEXT NOT NULL,packet TEXT NOT NULL,
    signer TEXT REFERENCES accounts(id),signed_at TEXT,sign_note TEXT,
    PRIMARY KEY(company,period)
  );
  CREATE INDEX IF NOT EXISTS month_end_prepared ON month_end_close(company,status,cutoff);`);
}
function allowed(db,u,state,company){
  if(!['owner','manager','bookkeeper'].includes(u.role))return false;
  if(u.role==='owner')return true;
  if(!u.assignments.includes(company)||!needed.every(a=>accountAreas(db,u).includes(a)))return false;
  const scopedCompany=scoped(u,state,db).companies.find(c=>c.id===company);
  return !!scopedCompany&&scopedCompany.projectScope!=='permitted-records';
}
export function canSeeMonthEnd(db,user,state){return user.role==='owner'||state.companies.some(c=>allowed(db,user,state,c.id));}
function access(db,user,state,id){
  const c=state.companies.find(c=>c.id===id);
  requireThat(c&&allowed(db,user,state,id),403,'Month-end close requires full financial and protected-project visibility for this company.');
  return c;
}
function periodBounds(period){
  requireThat(typeof period==='string'&&/^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$/.test(period),400,'Choose a valid month.');
  const [year,month]=period.split('-').map(Number),n=new Date(Date.UTC(year,month,0)).getUTCDate();
  return {period,from:period+'-01',cutoff:period+'-'+n};
}
const defaultPeriod=()=>{
  const [y,m]=localDay().split('-').map(Number),before=new Date(Date.UTC(y,m-1,0));
  return before.toISOString().slice(0,7);
};
function note(value,message){
  requireThat(typeof value==='string'&&value.trim().length>0&&value.length<=1200&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),400,message);
  return value.trim();
}
const digest=packet=>createHash('sha256').update(JSON.stringify(packet)).digest('hex');
function serialize(packet){
  const value=JSON.stringify(packet);requireThat(Buffer.byteLength(value)<=12*1024*1024,413,'The detailed close packet exceeds 12 MiB. Review this company close outside the workspace.');return value;
}
export function closeSnapshot(db,c,period){
  const {from,cutoff}=periodBounds(period),dated=statements(c.entries,from,cutoff);
  const trial=Object.entries(accounts).map(([account,[name]])=>{
    const amount=dated.balances[account];return {account,name,debit:Math.max(amount,0),credit:Math.max(-amount,0)};
  });
  const settlements=new Map();
  for(const document of c.docs){
    if(document.date>cutoff||!['collection','payment','sales credit','vendor credit'].includes(document.kind))continue;
    settlements.set(document.parent,sum([settlements.get(document.parent)||0,document.applied||0]));
  }
  const party=new Map(c.parties.map(p=>[p.id,p.name]));
  const open=kind=>c.docs.filter(d=>d.kind===kind&&d.date<=cutoff).flatMap(d=>{
    const openCents=sum([d.total,-(settlements.get(d.id)||0)]);
    return openCents!==0?[{id:d.id,number:d.number,date:d.date,party:party.get(d.party)||'Unknown contact',amount:d.total,open:openCents}]:[];
  });
  const invoices=open('invoice'),bills=open('bill'),arTotal=sum(invoices.map(r=>r.open)),apTotal=sum(bills.map(r=>r.open));
  const latest=c.reconciliations.filter(r=>r.date<=cutoff).at(-1)||null;
  const clearedRows=new Set(c.reconciliations.filter(r=>r.date<=cutoff).flatMap(r=>r.rows));
  const entry=new Map(c.entries.filter(e=>e.date<=cutoff).map(e=>[e.id,e]));
  const initial=c.reconciliations.find(r=>r.date<=cutoff);
  const matched=new Set(initial?.openingBasis?.cleared??[]);
  const bankRows=c.bank.filter(r=>r.date<=cutoff).flatMap(r=>{
    const match=entry.get(r.match);if(match)matched.add(match.id);
    if(clearedRows.has(r.id))return [];
    return [{id:r.id,date:r.date,description:r.description,amount:r.amountCents,status:match?'Matched, not reconciled':'Unmatched at cutoff'}];
  });
  const unreconciledCash=[...entry.values()].flatMap(e=>{
    if(matched.has(e.id))return [];
    const amount=sum(e.lines.filter(l=>l.account==='1000').map(l=>l.cents));
    return amount?[{id:e.id,date:e.date,memo:e.memo,amount}]:[];
  });
  const approvals=db.prepare("SELECT id,kind,action FROM approvals WHERE companyId=? AND status='pending' ORDER BY rowid").all(c.id).flatMap(r=>{
    if(!financeKinds.has(r.kind))return [];
    const date=JSON.parse(r.action).date;
    return typeof date==='string'&&date>cutoff?[]:[{id:r.id,kind:r.kind,date:typeof date==='string'?date:'Unknown'}];
  });
  return {format:'firmquill.month-end.v1',company:{id:c.id,name:c.name},period,from,cutoff,
    report:dated,trial,invoices,bills,arTotal,apTotal,
    arVariance:sum([dated.balances['1100'],-arTotal]),apVariance:sum([-dated.balances['2000'],-apTotal]),
    bank:{latest:latest&&{date:latest.date,opening:latest.opening,closing:latest.closing,bookCash:latest.bookCash,outstandingCash:latest.outstandingCash},rows:bankRows,unmatchedCash:unreconciledCash},approvals};
}
function record(db,c,period){
  const row=db.prepare('SELECT * FROM month_end_close WHERE company=? AND period=?').get(c.id,period);
  if(!row)return null;
  requireThat(statuses.includes(row.status),500,'The close status could not be read.');
  return row;
}
function metadata(row){
  if(!row)return null;
  const {company,packet,digest,...display}=row;
  return display;
}
export function monthEndView(db,user,scope,period=defaultPeriod()){
  const c=access(db,user,scope.state,scope.companyId),date=periodBounds(period).cutoff,row=record(db,c,period);
  const history=db.prepare('SELECT period,cutoff,version,status,prepared_at,signed_at FROM month_end_close WHERE company=? ORDER BY period DESC').all(c.id);
  const packet=row?.status==='signed'?JSON.parse(row.packet):closeSnapshot(db,c,period);
  const stale=row?.status==='prepared'&&row.digest!==digest(packet);
  const legacyClosed=!!c.closedThrough&&date<=c.closedThrough&&row?.status!=='signed';
  return {period,closedThrough:c.closedThrough,allowedSign:['owner','manager'].includes(user.role),legacyClosed,
    dateReady:date<localDay(),digest:digest(packet),history,status:metadata(row),stale:!!stale,packet};
}
export function monthEndCommand(db,user,scope,cmd){
  const {period,cutoff}=periodBounds(cmd?.period), c=access(db,user,scope.state,scope.companyId), old=record(db,c,period);
  requireThat(cutoff<localDay(),400,'The selected month has not ended.');
  requireThat(!c.closedThrough||cutoff>c.closedThrough,409,'This month was already closed. A signed packet cannot be changed.');
  requireThat(Number.isSafeInteger(cmd.version)&&cmd.version===(old?.version||0),409,'This review was changed. Reload before proceeding.');
  if(cmd.type==='withdraw'){
    requireThat(old?.status==='prepared',400,'Only a prepared close can be withdrawn.');
    requireThat(old.preparer===user.id||['owner','manager'].includes(user.role),403,'Only its preparer, owner or authorized manager can withdraw this review.');
    const why=note(cmd.note,'Add a withdrawal reason.');
    db.prepare("UPDATE month_end_close SET status='withdrawn',version=version+1,sign_note=? WHERE company=? AND period=?").run(why,c.id,period);
    audit(db,user,c.id,'month-end withdrawn',period+' · revision '+old.version);
    return monthEndView(db,user,scope,period);
  }
  requireThat(['prepare','sign'].includes(cmd.type),400,'Select prepare or sign off.');
  const packet=closeSnapshot(db,c,period),hash=digest(packet);
  if(cmd.type==='prepare'){
    const prepNote=note(cmd.note,'Add preparation notes and document any exceptions.');
    requireThat(typeof cmd.digest==='string'&&cmd.digest===hash,409,'The visible close data changed. Reload and review before preparing.');
    requireThat(!old||old.status!=='signed',409,'A signed packet cannot be replaced.');
    requireThat(!old||old.status!=='prepared'||old.preparer===user.id||['owner','manager'].includes(user.role),403,'Another preparer owns this review; ask an authorized manager to update it.');
    db.prepare(`INSERT INTO month_end_close(company,period,cutoff,version,status,preparer,prepared_at,prepared_revision,prepare_note,digest,packet)
      VALUES(?,?,?,1,'prepared',?,?,?,?,?,?)
      ON CONFLICT(company,period) DO UPDATE SET version=version+1,status='prepared',preparer=excluded.preparer,
      prepared_at=excluded.prepared_at,prepared_revision=excluded.prepared_revision,prepare_note=excluded.prepare_note,digest=excluded.digest,packet=excluded.packet,signer=NULL,signed_at=NULL,sign_note=NULL`)
      .run(c.id,period,cutoff,user.id,new Date().toISOString(),scope.revision,prepNote,hash,serialize(packet));
    audit(db,user,c.id,'month-end prepared',period+' · '+hash);
    return monthEndView(db,user,scope,period);
  }
  requireThat(['owner','manager'].includes(user.role),403,'Only an authorized owner or manager can sign and lock the period.');
  requireThat(old?.status==='prepared'&&old.digest===hash,409,'Prepare the current period data again before signing.');
  requireThat(!db.prepare("SELECT 1 FROM month_end_close WHERE company=? AND status='prepared' AND cutoff<?").get(c.id,cutoff),409,'Resolve the earlier prepared close before locking this month.');
  requireThat(packet.report.trialDifference===0,409,'The trial balance does not balance.');
  requireThat(packet.approvals.length===0,409,'Resolve pending dated financial approvals before signing.');
  requireThat(cmd.reviewed===true,400,'Confirm review of the statements, balances and reconciliation before locking.');
  const signNote=note(cmd.note,'Add sign-off notes including how you addressed any cash, reconciliation or subledger exceptions.');
  const sealed=serialize(packet);
  actionFor(db,user,{companyId:c.id,revision:scope.revision,action:{type:'close',date:cutoff,requestId:randomUUID(),label:'Month-end sign-off · '+period}},{monthEnd:true});
  db.prepare("UPDATE month_end_close SET status='signed',version=version+1,signer=?,signed_at=?,sign_note=?,packet=? WHERE company=? AND period=?")
    .run(user.id,new Date().toISOString(),signNote,sealed,c.id,period);
  audit(db,user,c.id,'month-end signed',period+' · '+hash+(old.preparer===user.id?' · same preparer and signer':' · separate preparer and signer'));
  return monthEndView(db,user,readBooksScope(db,c.id),period);
}
function readBooksScope(db,companyId){return {companyId,...readBooks(db)};}
export function monthEndPacket(db,user,scope,period){
  periodBounds(period);const c=access(db,user,scope.state,scope.companyId),row=record(db,c,period);
  requireThat(row?.status==='signed',404,'A downloadable packet is available after authorized sign-off.');
  return {...JSON.parse(row.packet),signOff:{...metadata(row),digest:row.digest}};
}
export const currentCloseDigest=packet=>digest(packet);
