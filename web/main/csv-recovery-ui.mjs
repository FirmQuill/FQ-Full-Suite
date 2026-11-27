import {esc,btn,money,panel,table} from '/shared/views.mjs';

export function csvRecoveryPanel(data){
  if(!data)return panel('CSV import recovery','<p>Loading tracked CSV imports…</p>');
  if(data.error)return panel('CSV import recovery','<p>'+esc(data.error)+'</p><p>Normal Banking is still available.</p>');
  return panel('CSV import recovery','<p>Review which rows one of the 50 most recent tracked CSV imports added. An owner can remove still-unmatched and unprotected rows from a batch once. Earlier untracked imports and ledger entries are never changed.</p>'+
    table(['Imported at','Batch','Rows added','Recovery status','Review'],data.batches.map(b=>[esc(new Date(b.createdAt).toLocaleString()),esc(b.id.slice(0,8)),esc(b.rowCount),b.removed===null?'Available for review':esc(b.removed)+' rows removed',btn('csv-recovery-preview','Review CSV batch',b.id)]),'No tracked CSV imports yet.'));
}
export async function csvRecoveryAction(type,batch,{api,companyId,formModal,closeModal,refresh,toast,isCurrent,companyName}){
  if(type!=='csv-recovery-preview')return false;
  const path='csv-import-recovery?companyId='+encodeURIComponent(companyId);
  const p=await api(path+'&batch='+encodeURIComponent(batch));
  if(!isCurrent())return true;
  const title='Review CSV import recovery';
  const contents='<p>Company: '+esc(companyName)+'. Imported '+esc(new Date(p.createdAt).toLocaleString())+'. Review the exact rows this import created. This does not remove journals or undo matching or reconciliation.</p>'+
    table(['Date','Description','Amount','Recovery decision'],p.rows.map(r=>[esc(r.date),esc(r.description),money(r.amountCents),esc(r.status||'Will remove this unmatched row')]))+
    (p.eligible?'<p>Eligible unmatched rows: '+esc(p.eligible)+'</p><label class="checkfield"><input type="checkbox" name="confirm" required> I reviewed this import and want to remove only the listed eligible rows.</label>':'<p>No rows can be removed from this batch.</p>');
  formModal(title,contents,p.eligible?'Remove eligible rows':'',async values=>{
    if(!isCurrent())throw Error('The selected company changed. Open its recovery review again.');
    const result=await api(path,{batch,reviewToken:p.reviewToken,confirm:values.confirm==='on'});
    closeModal();await refresh();toast(result.removed+(result.removed===1?' unmatched CSV row removed.':' unmatched CSV rows removed.')+' No journal changed.');
  });
  return true;
}
