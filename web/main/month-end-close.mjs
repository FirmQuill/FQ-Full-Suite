import {btn,esc,panel,table,money,select} from '/shared/views.mjs';
const show=(s)=>esc(s??'');
const balance=(n)=>money(n??0);
const statuses={prepared:'Prepared · awaiting sign-off',withdrawn:'Withdrawn',signed:'Signed and locked'};
const title='Month-end close';

export function monthEndContent(data,company){
  if(!company)return panel(title,'<p>Create or select a company first.</p>');
  if(data?.error)return panel('Close unavailable','<p>'+show(data.error)+'</p>',btn('close-period-select','Choose month'));
  if(!data)return panel(title,'<p>Loading the company close workspace…</p>');
  const {status,packet:p,closedThrough,stale,legacyClosed,dateReady,allowedSign}=data;
  const closed=status?.status==='signed',ready=packetReady(data);
  const summary='<p><b>'+show(data.period)+'</b> · through '+show(p.cutoff)+' · '+show(status?statuses[status.status]:'Not yet prepared')+'</p>'+
    '<p>Locked through: '+show(closedThrough||'No locked periods')+'</p>'+
    (stale?'<p class="callout warn">Relevant books or approval records changed after preparation. Review and prepare again.</p>':'')+
    (legacyClosed?'<p class="callout warn">Already locked through the earlier period controls. No signed packet was created through this workflow.</p>':'')+
    (!dateReady?'<p>This month has not ended. You can inspect working figures but cannot prepare or sign it yet.</p>':'')+
    (status?'<p>Prepared at '+show(status.prepared_at)+': '+show(status.prepare_note)+'</p>':'')+
    (status?.status==='withdrawn'?'<p>Withdrawal: '+show(status.sign_note)+'</p>':'')+
    (closed?'<p>Signed at '+show(status.signed_at)+': '+show(status.sign_note)+'</p>':'')+
    (!closed&&!legacyClosed&&p.approvals.length?'<p class="callout warn">Pending financial approvals must be resolved before sign-off.</p>':'')+
    '<p class="small quiet">A preparer stores the figures without posting or locking. An authorized owner or manager can sign off and lock the books.</p>';
  const controls=btn('close-period-select','Choose month')+
    (closed?btn('close-packet-html','Download printable close packet')+btn('close-packet-json','Download JSON close packet'):'')+
    (!closed&&!legacyClosed&&dateReady?btn('close-prepare',status?.status==='prepared'?'Prepare again':'Prepare close'):'')+
    (ready&&allowedSign?btn('close-sign','Sign and lock period','','primary'):'')+
    (status?.status==='prepared'?btn('close-withdraw','Withdraw prepared close'):'');
  const r=p.report;
  const values=[['Opening cash',r.openingCash],['Closing cash',r.closingCash],['Period revenue',r.revenue],['Period expenses',r.expenses],['Period net income',r.income],['Assets',r.assets],['Liabilities',r.liabilities],['Contributed capital',r.capital],['Cumulative earnings',r.earnings],...Object.entries(r.cashFlow).map(([name,value])=>['Cash flow · '+name,value])];
  const aging=(rows)=>table(['No.','Date','Contact','Original','Open at cutoff'],rows.map(d=>[show(d.number),show(d.date),show(d.party),balance(d.amount),balance(d.open)]),'No open records at the cutoff.');
  return panel('Close review',summary,controls)+
    panel('Trial balance at cutoff',table(['Account','Debit','Credit'],p.trial.map(t=>[show(t.account+' · '+t.name),balance(t.debit),balance(t.credit)]))+'<p><b>Trial balance difference:</b> '+balance(r.trialDifference)+'</p>')+
    panel('Dated statements',table(['Measure','Amount'],values.map(([k,v])=>[show(k),balance(v)])))+
    panel('Outstanding invoices','<p>Open: '+balance(p.arTotal)+' · Difference from ledger A/R: '+balance(p.arVariance)+'</p>'+aging(p.invoices))+
    panel('Unpaid bills','<p>Open: '+balance(p.apTotal)+' · Difference from ledger A/P: '+balance(p.apVariance)+'</p>'+aging(p.bills))+
    panel('Bank reconciliation','<p>Latest saved reconciliation through this cutoff: '+(p.bank.latest?show(p.bank.latest.date)+' · statement close '+balance(p.bank.latest.closing):'None recorded')+'.</p>'+
      '<p>Current links are shown when both records are dated within the cutoff. Only a saved reconciliation through the cutoff counts as reconciled.</p>'+
      table(['Date','Statement line','Amount','Status'],p.bank.rows.map(b=>[show(b.date),show(b.description),balance(b.amount),show(b.status)]),'No unreconciled statement lines in the imported data.')+
      '<h3>Unmatched cash ledger entries</h3>'+table(['Date','Memo','Cash effect'],p.bank.unmatchedCash.map(e=>[show(e.date),show(e.memo),balance(e.amount)]),'No unmatched cash entries at the cutoff.'))+
    panel('Held financial approvals',table(['Entry type','Posting date','Approval reference'],p.approvals.map(a=>[show(a.kind),show(a.date),show(a.id)]),'No financial approvals pending through the cutoff.'),btn('nav','Open Approvals','Approvals'))+
    panel('Prior close reviews',table(['Month','Cutoff','Status','Signed at'],data.history.map(h=>[show(h.period),show(h.cutoff),show(statuses[h.status]),show(h.signed_at||'—')]),'No prior close reviews.'));
}
function packetReady(data){return data.status?.status==='prepared'&&data.dateReady&&!data.stale&&!data.legacyClosed&&data.packet.approvals.length===0&&data.packet.report.trialDifference===0;}
function htmlCopy(p){
  const cols=(v)=>v.map(x=>'<td>'+show(x)+'</td>').join('');
  const t=(headers,rows)=>'<table><thead><tr>'+headers.map(x=>'<th>'+show(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols(r)+'</tr>').join('')+'</tbody></table>';
  const dollar=n=>Number(n/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
  const party=rows=>t(['No.','Date','Contact','Original','Open'],rows.map(r=>[r.number,r.date,r.party,dollar(r.amount),dollar(r.open)]));
  const s=p.signOff;
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>FirmQuill close packet</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:3% auto;max-width:850px;padding:1rem;color:#18333a}table{width:100%;border-collapse:collapse}td,th{padding:.35rem;text-align:left;border-bottom:1px solid #8b9da5}h2{margin-top:1.5rem}p{overflow-wrap:anywhere;white-space:pre-wrap}tr{break-inside:avoid}@media print{body{margin:0}h2{break-after:avoid}}</style>'+
    '<h1>FirmQuill month-end close packet</h1><p>'+show(p.company.name)+' · '+show(p.period)+' · '+show(p.from)+' through '+show(p.cutoff)+'</p>'+
    '<p>Private company records. Signed by account '+show(s.signer)+' at '+show(s.signed_at)+'. Prepared by '+show(s.preparer)+' at '+show(s.prepared_at)+'.</p>'+
    '<p>Preparation: '+show(s.prepare_note)+'</p><p>Sign-off: '+show(s.sign_note)+'</p><p>Snapshot SHA-256: '+show(s.digest)+'</p>'+
    '<h2>Trial balance</h2>'+t(['Account','Debit','Credit'],p.trial.map(a=>[a.account+' · '+a.name,dollar(a.debit),dollar(a.credit)]))+
    '<p>Trial balance difference: '+show(dollar(p.report.trialDifference))+'</p>'+
    '<h2>Statements</h2>'+t(['Measure','Amount'],['openingCash','closingCash','revenue','expenses','income','assets','liabilities','capital','earnings'].map(k=>[k,dollar(p.report[k])]).concat(Object.entries(p.report.cashFlow).map(([k,v])=>['Cash flow: '+k,dollar(v)])))+
    '<h2>Outstanding invoices</h2><p>Ledger variance: '+show(dollar(p.arVariance))+'</p>'+party(p.invoices)+
    '<h2>Unpaid bills</h2><p>Ledger variance: '+show(dollar(p.apVariance))+'</p>'+party(p.bills)+
    '<h2>Bank reconciliation</h2><p>Latest reconciliation through cutoff: '+show(p.bank.latest?p.bank.latest.date+' · '+dollar(p.bank.latest.closing):'None recorded')+'</p>'+
    t(['Date','Description','Amount','Status'],p.bank.rows.map(b=>[b.date,b.description,dollar(b.amount),b.status]))+
    '<h3>Unmatched cash ledger entries</h3>'+t(['Date','Memo','Cash effect'],p.bank.unmatchedCash.map(e=>[e.date,e.memo,dollar(e.amount)]))+
    '<h2>Held financial approvals</h2><p>'+show(p.approvals.length)+' unresolved at sign-off.</p></html>';
}
export async function monthEndAction(type,key,ctx,setPeriod,setData){
  if(!['close-period-select','close-prepare','close-sign','close-withdraw','close-packet-html','close-packet-json'].includes(type))return false;
  const d=ctx.auxiliary;
  const path='month-end-close?companyId='+encodeURIComponent(ctx.companyId);
  if(type==='close-period-select'){
    ctx.formModal('Choose closing month','<label>Closing month (YYYY-MM)<input name="period" type="month" value="'+show(d?.period||'')+'" required pattern="[0-9]{4}-[0-9]{2}"></label>','View month',async v=>{
      const data=await ctx.api(path+'&period='+encodeURIComponent(v.period));setPeriod(v.period);ctx.closeModal();setData(data);
    });return true;
  }
  if(type.startsWith('close-packet-')){
    const packet=await ctx.api('month-end-close/packet?companyId='+encodeURIComponent(ctx.companyId)+'&period='+encodeURIComponent(d.period));
    const html=type.endsWith('-html');ctx.download(html?htmlCopy(packet):JSON.stringify(packet,null,2),'FirmQuill-month-end-'+d.period+(html?'.html':'.json'),html?'text/html':'application/json');return true;
  }
  const sign=type==='close-sign',withdraw=type==='close-withdraw';
  const name=sign?'Sign and lock '+d.period:withdraw?'Withdraw prepared close':'Prepare month-end close';
  ctx.formModal(name,(sign?'<p class="callout warn">This locks postings through '+show(d.packet.cutoff)+'. Explain how any open cash, reconciliation or subledger exceptions were addressed.</p><label class="checkfield"><input type="checkbox" name="reviewed" required> I reviewed the dated statements, balances, and reconciliation.</label>':'')+
    '<label>'+(withdraw?'Withdrawal reason':sign?'Sign-off notes':'Preparation notes')+'<textarea name="note" maxlength="1200" required></textarea></label>',
    sign?'Sign and lock period':withdraw?'Withdraw close':'Save prepared close',async(v,f)=>{
      const action={type:sign?'sign':withdraw?'withdraw':'prepare',period:d.period,version:d.status?.version??0,digest:d.digest,note:v.note,...(sign?{reviewed:f.get('reviewed')==='on'}:{})};
      const out=await ctx.api(path,{action});setPeriod(out.period);ctx.closeModal();setData(out);
      if(sign)await ctx.refresh();
      ctx.toast(sign?'Period signed and locked.':withdraw?'Prepared close withdrawn.':'Close prepared for review.');
    });return true;
}
