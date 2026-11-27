import {esc,btn,panel,table} from '/shared/views.mjs';
const names={'private-support':'Private support documentation',expanded_agent:'Expanded agent tools',software_updates:'Software updates'};
const when=n=>new Date(n*1000).toISOString().replace('.000Z',' UTC');
export function activationPanel(data){
  if(!data)return panel('Module activation','<p>Loading module status…</p>');
  if(data.error)return panel('Module activation','<p>'+esc(data.error)+'</p>');
  const legacyManualOnly=data.paidScopePresent===false&&['active','expired','not yet valid'].includes(data.status);
  const rows=Object.entries(data.modules).filter(([m])=>m!=='manual-payroll').map(([m,on])=>[esc(names[m]||m),on?'Active':'Locked']);
  return panel('Module activation',
    '<p>Paid modules unlock for this installation after the owner provides a signed activation code. Ordinary bookkeeping, employer-entered manual payroll and public setup help remain available without a code.</p>'+
    '<p>Activation status: '+esc(legacyManualOnly?'no paid module activated':data.status)+'.</p>'+
    (data.installationId?'<p>Installation ID (share with your authorized issuer):</p><p><code>'+esc(data.installationId)+'</code></p>':
    '<p>Your host has not configured the trusted public verifier and private activation directory. Ask your host administrator to set them up.</p>')+
    (data.configured&&!data.upgradePreviewConfigured?'<p>Ask your host administrator to configure this installation for encrypted license uploads.</p>':'')+
    (data.expiresAt===null||legacyManualOnly?'':'<p>Expires: '+esc(when(data.expiresAt))+'</p>')+
    table(['Module','Status'],rows),data.configured?(data.upgradePreviewConfigured?btn('preview-paid-upgrade','Upgrade to Paid: preview'):'')+btn('activate-modules','Enter activation code'):'');
}
export function activationAction(type,{api,formModal,closeModal,refresh,toast}){
  if(type==='preview-paid-upgrade'){
    formModal('Preview a paid upgrade',
      '<p>Select an encrypted, issuer-signed .fqlicense file. This host can verify it without activating it or altering your records.</p>'+
      '<label>Signed license file<input type="file" name="license" accept=".fqlicense,text/plain" required></label>'+
      '<p>If the issuer included an update server in the signed file, this preview shows it without connecting to it.</p>',
      'Review license',async(v,f,form)=>{
        const file=f.get('license');
        if(!(file instanceof File)||!file.size||file.size>8192)throw Error('Choose an encrypted license file no larger than 8 KB.');
        const result=await api('paid-upgrade-preview',{code:await file.text()});
        form.reset();
        const rows=result.entitlements.map(m=>[esc(names[m.id]||m.id),m.requiresPaidBuild?'Requires paid build':'Available after separate activation']);
        formModal('Paid upgrade review','<p>License status: '+esc(result.status)+'.</p>'+
          '<p>Bound to this installation: <code>'+esc(result.installationId)+'</code></p>'+
          (result.notBefore===null?'':'<p>Valid from: '+esc(when(result.notBefore))+'</p>')+
          (result.expiresAt===null?'':'<p>Expires: '+esc(when(result.expiresAt))+'</p>')+
          (rows.length?table(['Signed entitlement','Where it can be used'],rows):'<p>No paid entitlements in this file. Manual Payroll does not need a license.</p>')+
          (result.updateFeed?'<p>Issuer-approved update source: <code>'+esc(result.updateFeed.origin)+'</code> ('+esc(result.updateFeed.channel)+'). Server not contacted.</p>':'<p>No update source was included in this license.</p>')+
          '<p>Nothing was activated, saved, downloaded or installed. For paid features that need another build, obtain it separately from your issuer.</p>');
      });
    return true;
  }
  if(type!=='activate-modules')return false;
  formModal('Activate Full Suite modules',
    '<p>Paste the signed code issued for this installation only. Replacing a code also replaces its module list. Codes are verified here on your host; nothing is sent to the issuer.</p>'+
    '<label>Signed activation code<textarea name="code" rows="4" maxlength="4096" spellcheck="false" autocomplete="off" required></textarea></label>',
    'Activate modules',async v=>{
      await api('module-activation',{code:v.code});closeModal();await refresh();toast('Full Suite activation verified.');
    });
  return true;
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
    ' Ask your issuer for a renewed code and enter it in Module activation.</p>'+
    (alreadyOnActivationPage?'':btn('nav','Open Module activation','Module activation'))+'</section>';
  return expired?null:remaining;
}
