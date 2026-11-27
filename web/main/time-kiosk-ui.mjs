import {esc,btn,panel,select,table} from '/shared/views.mjs';

export function kioskPanel(data){
  if(!data)return panel('Time clock kiosk','<p>Loading stations…</p>');
  if(data.error)return panel('Time clock kiosk','<p>'+esc(data.error)+'</p>');
  const rows=data.kiosks.map(k=>[esc(k.label),esc(data.jobs.find(j=>j.id===k.job)?.name??'Job unavailable'),esc(k.status),
    k.status==='revoked'?'—':(k.staff.map(w=>'<p>'+esc(w.name)+' '+btn('kiosk-remove','Remove worker',k.id+'~'+w.id)+'</p>').join('')||'No assigned workers'),
    ['awaiting pairing','paired'].includes(k.status)?btn('kiosk-pin','Issue worker PIN',k.id)+' '+btn('kiosk-re-pair','Replace pairing',k.id)+' '+btn('kiosk-revoke','Revoke station',k.id):k.status==='expired'?btn('kiosk-re-pair','Replace pairing',k.id)+' '+btn('kiosk-revoke','Revoke station',k.id):'—']);
  return panel('Time clock kiosk',
    '<p>Give a shared computer one company and one job. Employees use their own station PIN to clock in and out without opening their records. Punches go to the usual timesheet review.</p><p>Open <code>/kiosk</code> on the employee portal in a dedicated browser profile. Keep the profile separate from signed-in admin or employee sessions. Each worker must accept the current Terms in their ordinary portal before a PIN can be issued.</p>'+
    table(['Station','Job','Status','Workers','Actions'],rows),data.jobs.length?btn('kiosk-create','Create station'):'');
}
export function kioskAction(type,key,{auxiliary:data,companyId,api,formModal,closeModal,refresh}){
  if(!data)return;
  const endpoint='time-kiosk-admin';
  const reveal=(heading,label,value,summary)=>formModal(heading,'<p>'+esc(summary)+'</p><label>'+esc(label)+'<input readonly value="'+esc(value)+'" autocomplete="off" spellcheck="false"></label>',null);
  if(type==='kiosk-create'){
    return formModal('Create kiosk station','<label>Station label<input required name="label" maxlength="80"></label>'+select('job','Company job',data.jobs.map(j=>[j.id,j.name])),'Create station',async v=>{
      const out=await api(endpoint,{type:'create',company:companyId,label:v.label,job:v.job});
      closeModal();await refresh();
      reveal('Pair this station','One-time pairing code',out.pairCode,'On the shared computer, open the employee portal’s /kiosk page and enter this code. It expires after 15 minutes. It will not be displayed again; do not post it publicly.');
    });
  }
  const [id,account]=key.split('~'),station=data.kiosks.find(k=>k.id===id);
  if(!station)return;
  if(type==='kiosk-re-pair')return formModal('Replace station pairing','<p>This immediately disconnects the old browser. Pair the replacement computer with the new code. Existing station PINs and punches are unchanged.</p>','Replace pairing',async()=>{
    const out=await api(endpoint,{type:'re-pair',id});closeModal();await refresh();
    reveal('Pair this station','One-time pairing code',out.pairCode,'Use this code on the station’s /kiosk page within 15 minutes. It will not be displayed again.');
  });
  if(type==='kiosk-pin'){
    const available=data.workers.filter(w=>w.termsCurrent);
    if(!available.length)return formModal('No workers available','<p>Set up an active worker with Time enabled and have them accept the current Terms in their worker portal first.</p>',null);
    return formModal('Issue worker PIN',select('account','Worker',available.map(w=>[w.id,w.name+' ('+w.username+')']))+'<p>This replaces any prior PIN for this worker on this station.</p>','Generate PIN',async v=>{
      const out=await api(endpoint,{type:'pin',id,account:v.account});
      closeModal();await refresh();
      reveal('Share the PIN privately','Worker PIN',out.pin,'Worker ID: '+out.workerId+'. The PIN is station-specific and shown only now. Do not post it publicly.');
    });
  }
  if(type==='kiosk-revoke'||type==='kiosk-remove'){
    const revoke=type==='kiosk-revoke';
    return formModal(revoke?'Revoke station':'Remove worker','<p>This removes kiosk access. It does not change prior punches or close an open shift. The ordinary worker portal is unaffected.</p>',revoke?'Revoke station':'Remove worker',async()=>{
      await api(endpoint,revoke?{type:'revoke',id}:{type:'remove-worker',id,account});
      closeModal();await refresh();
    });
  }
}
