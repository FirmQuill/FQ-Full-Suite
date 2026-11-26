import {esc,btn,table,panel,input,select,mapping,money} from '/shared/views.mjs';
import {cents} from '/shared/core.mjs';

const line=(name,label,value='',max=200)=>input(name,label,'text',value,'maxlength="'+max+'"');
const note=(label='Review note')=>`<label>${esc(label)}<textarea name="note" maxlength="500"></textarea></label>`;
const today=()=>new Date().toISOString().slice(0,10);
const dec=v=>String(v).replace(/\B(?=(\d{3})+(?!\d))/g,',');
export function teamContent(page,d,session){
  if(!session.state.companies.length)return panel('Company workspace','<p>Create or open a company before using team requests.</p>');
  if(!d)return '<p>Loading team requests…</p>';
  if(d.error)return '<p class="error">'+esc(d.error)+'</p>';
  if(page==='Time off review')return panel('Employee time-off requests',
    '<p>Approve or decline employees’ requested dates. This does not adjust leave balances, hours or payroll.</p>'+
    table(['Employee','Type','Dates','Status and employee note','Action'],d.requests.map(r=>[
      esc(r.employeeName),esc(r.category),esc(r.from+' through '+r.through),
      esc(r.status)+(r.note?'<br>'+esc(r.note):'')+(r.reviewNote?'<br>Review: '+esc(r.reviewNote):''),
      r.status==='pending'?btn('team-leave-review','Review request',r.id):'']),'No employee time-off requests.'));
  return panel('Purchase requests','<p>Record a need, get it reviewed, then link an existing purchase order. Approval does not order or pay anything.</p>'+
    table(['Request','Need by','Quantity','Unit estimate','Status and history','Action'],d.requests.map(r=>{
      const linked=d.matches.find(m=>m.poId===r.poId);
      return [esc(r.description)+(r.reason?'<br>'+esc(r.reason):''),esc(r.needBy),esc(dec(r.qty)),money(r.estimatedUnit),
        esc(r.status)+' · '+esc(r.requesterName)+(r.reviewNote?'<br>Review: '+esc(r.reviewNote):'')+(linked?'<br>PO '+esc(linked.number):''),
        (r.status==='pending'&&d.mayReview?btn('team-purchase-review','Review',r.id):'')+
        (r.status==='pending'&&r.requestedBy===session.user.id?btn('team-purchase-cancel','Withdraw',r.id):'')+
        (r.status==='approved'&&d.mayReview&&d.matches.length?btn('team-purchase-link','Link PO',r.id):'')];
    }),'No purchase requests in your scope.'),d.mayRequest?btn('team-purchase-new','Request purchase','','primary'):'')+
    panel('Three-way purchase match','<p>Compare each purchase order with its posted receipts and bills. This is a reconciliation report, not a payment authorization. Vendor credits and returns are not netted here.</p>'+
      table(['Purchase order','Receipts','Bills','Result','Details'],d.matches.map(m=>[esc(m.number+' · '+m.label),esc(m.receiptCount),esc(m.billCount),esc(m.status),btn('team-purchase-detail','Compare documents',m.poId)]),'No purchase orders in your scope.'));
}
export async function teamAction(type,key,ctx){
  if(!type.startsWith('team-'))return false;
  const {auxiliary:d,companyId,session,api,formModal,closeModal,refresh,toast}=ctx;
  const c=session.state.companies.find(x=>x.id===companyId),r=d?.requests?.find(x=>x.id===key);
  const send=async(endpoint,action)=>{await api(endpoint,{action:{companyId,...action}});closeModal();await refresh();toast('Team request saved.');};
  const review=(label,r,endpoint)=>formModal(label,'<p>'+esc(r.description||r.employeeName+' · '+r.from+' to '+r.through)+'</p>'+
    select('decision','Decision',[['approved','Approve'],['declined','Decline']])+note('Review note (required when declining)'),
    'Save decision',v=>send(endpoint,{type:'review',id:r.id,version:r.version,...v}));
  if(type==='team-leave-review'&&r)review('Review time off',r,'team/time-off');
  if(type==='team-purchase-review'&&r)review('Review purchase request',r,'team/purchasing');
  if(type==='team-purchase-cancel'&&r)formModal('Withdraw purchase request','<p>'+esc(r.description)+'</p>','Withdraw',
    ()=>send('team/purchasing',{type:'cancel',id:r.id,version:r.version}));
  if(type==='team-purchase-new')formModal('New purchase request',
    line('description','What needs to be purchased?')+select('itemId','Catalog item (optional)',[['','Not in catalog'],...mapping(c.items)]).replace(' required>','>')+
    input('qty','Quantity','number',1,'min="1" step="1"')+line('estimate','Estimated unit cost (USD)','0.00')+
    input('needBy','Needed by','date',today())+note('Reason (optional)'),'Submit purchase request',
    v=>send('team/purchasing',{type:'submit',description:v.description,itemId:v.itemId,qty:Number(v.qty),estimatedUnit:cents(v.estimate),needBy:v.needBy,reason:v.note}));
  if(type==='team-purchase-link'&&r)formModal('Link purchase order','<p>Link an existing order. No new purchase is posted.</p>'+
    select('poId','Purchase order',d.matches.map(m=>[m.poId,m.number+' · '+m.label])),'Link order',
    v=>send('team/purchasing',{type:'link',id:r.id,version:r.version,...v}));
  if(type==='team-purchase-detail'){
    const m=d.matches.find(x=>x.poId===key);if(!m)return true;
    formModal('Purchase match · '+m.number,'<p>'+esc(m.label+' · '+m.status)+'</p>'+
      table(['Item','Ordered','Received','Billed','PO total','Receipt total','Bill total'],
        m.lines.map(l=>[esc(c.items.find(i=>i.id===l.item)?.name||l.item||l.id),esc(l.ordered),esc(l.received),esc(l.billed),money(l.orderCents),money(l.receivedCents),money(l.billedCents)]))+
      m.reasons.map(reason=>'<p class="error">'+esc(reason)+'</p>').join(''));
  }
  return true;
}
