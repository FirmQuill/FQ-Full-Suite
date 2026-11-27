import {esc,btn,panel,table} from '/shared/views.mjs';
const when=n=>new Date(n*1000).toISOString().replace('.000Z',' UTC');
const reasons={ 'missing-license':'Missing license.', 'missing-packages':'Missing packages. Review and apply them in Packages.', 'package-error':'Package error. Review the drop in Packages.' };
function statusText(upgrade){
  return upgrade?.status==='complete'?['Update fully complete','']:upgrade?.status==='restart'?['Restart required','']:['Update partially complete',reasons[upgrade?.reason]||'Missing license.'];
}
export function activationPanel(data){
  const [title,reason]=statusText(data?.upgrade);
  return '<section class="card" data-version-upgrade><div role="status" aria-live="polite"><strong data-upgrade-title>'+esc(data?title:'Upgrade in progress')+'</strong><span data-upgrade-reason>'+(data&&reason?' '+esc(reason):'')+'</span></div><div><input type="file" accept=".fqlicense" data-upgrade-file hidden><button type="button" class="primary" data-upload-license>Upload signed license</button></div></section>';
}
export function mountLicenseUpload(root,{api,refresh}){
  const panel=root.querySelector('[data-version-upgrade]');if(!panel)return;
  const file=panel.querySelector('[data-upgrade-file]'),button=panel.querySelector('[data-upload-license]');
  const title=panel.querySelector('[data-upgrade-title]'),reason=panel.querySelector('[data-upgrade-reason]');
  const paint=(label,message='')=>{title.textContent=label;reason.textContent=message?' '+message:'';};
  button.addEventListener('click',()=>file.click());
  file.addEventListener('change',async()=>{
    const choice=file.files?.[0];file.value='';if(!choice||button.disabled)return;
    button.disabled=true;paint('Upgrade in progress');
    try{
      if(!/\.fqlicense$/i.test(choice.name)||!choice.size||choice.size>8192)throw Error('Choose a signed .fqlicense file under 8 KiB.');
      const result=await api('module-activation/upload',{fileName:choice.name,code:await choice.text()});
      if(!panel.isConnected)return;
      paint(...statusText(result.upgrade));
      // Rehydrate session gates and the current page after actual activation.
      try{await refresh(result);}catch{}
    }catch{
      if(panel.isConnected)paint('Update partially complete','Missing valid uploaded license: the file could not be verified. Any existing license is unchanged.');
    }finally{button.disabled=false;}
  });
}
export function packagesPanel(data){
  if(!data)return panel('Package management','<p>Loading package status…</p>');
  if(data.error)return panel('Package management','<p>'+esc(data.error)+'</p>');
  const admission=data.packageAdmission,statusNames={unconfigured:'Not configured',empty:'No drop found',unentitled:'No matching active license',invalid:'Drop did not pass verification',verified:'Owner-approved package loaded','review-required':'Owner review required'};
  const current=(admission?.capabilities||[]).filter(p=>p.active);
  const enrolled=data.installationId?'<p>Installation ID (share only with your issuer):</p><p><code>'+esc(data.installationId)+'</code></p>':'<p>Your host administrator must configure the trusted public verifier and protected activation directory.</p>';
  return panel('Package management',enrolled+'<p>Manual package folder: '+esc(statusNames[admission?.status]||'Unavailable')+'.</p>'+
    (current.length?'<ul>'+current.map(p=>'<li>'+esc(p.id)+' · Revision '+esc(p.version)+'</li>').join('')+'</ul>':'<p>No eligible paid package is currently applied.</p>')+
    '<p>Place separately signed packages in the configured folder. Owner review and explicit Apply are required; a signed license alone does not apply package content.</p>',
    btn('review-package-folder','Review package folder'));
}
export function activationAction(type,{api,formModal,closeModal,refresh,toast}){
  if(type==='review-package-folder'){
    void (async ()=>{
      const review=await api('package-folder');
      const reasons={'license-required':'Matching active license required','revision-rejected':'Older or conflicting revision','already-applied':'Previously applied','review-required':'Ready for owner review'};
      const status={invalid:'The signed drop or trust configuration failed verification.',unconfigured:'The host administrator has not configured the package folder.',empty:'No supported package file was found.'};
      const rows=(review.candidates||[]).map(x=>[esc(x.id),esc(x.type),esc(x.version),esc(reasons[x.reason]||'Unavailable'),x.eligible?'<label><input type="checkbox" name="packageId" value="'+esc(x.id)+'"> Select '+esc(x.id)+'</label>':'Not selectable']);
      const allowed=!!review.receipt&&review.candidates.some(c=>c.eligible);
      formModal('Review package folder',(status[review.status]?'<p>'+esc(status[review.status])+'</p>':'')+
        (rows.length?table(['Package','Type','Revision','Eligibility','Apply'],rows):'')+
        (allowed?'<p>Choose which reviewed packages to apply. Changes become available immediately. This does not change company records or restart the host.</p><label><input type="checkbox" name="confirm" required> I reviewed the eligible packages and want to apply them.</label>':''),allowed?'Apply selected packages':'',allowed?async (v,f)=>{
        if(!f.has('confirm'))throw Error('Confirm that you reviewed the eligible packages.');
        const ids=f.getAll('packageId');if(!ids.length)throw Error('Choose one or more eligible packages.');
        await api('package-folder',{receipt:review.receipt,ids,confirm:true});closeModal();await refresh();toast('Reviewed data packages applied.');
      }:null);
    })().catch(e=>toast(e.message));
    return true;
  }

  return false;
}

const fourteenDays=14*86400000; // Presentation threshold only; never controls permissions.
export function renderRenewalNotice(slot,renewal,elapsed=0,alreadyOnActivationPage=false){
  const remaining=renewal.remainingMs-elapsed;
  if(remaining>fourteenDays){slot.replaceChildren();return remaining-fourteenDays;}
  const date=esc(when(renewal.expiresAt));
  const expired=remaining<=0,title=expired?'Paid modules expired':'Paid modules expire soon';
  slot.innerHTML='<section class="callout warn" aria-label="'+title+'"><p><strong>'+title+'.</strong> '+(expired?
    'Your activation ended on '+date+'. Paid features on that code are now locked. Employer-entered manual payroll and authorized payroll history remain available.':
    'Your activation ends on '+date+'. Renew before then to keep paid modules available.')+
    ' Ask your issuer for a renewed signed file and upload it in Version Upgrade.</p>'+
    (alreadyOnActivationPage?'':btn('nav','Version Upgrade','Version Upgrade'))+'</section>';
  return expired?null:remaining;
}
