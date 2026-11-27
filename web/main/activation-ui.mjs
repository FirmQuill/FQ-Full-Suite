import {esc,btn,panel,table} from '/shared/views.mjs';
const names={'manual-payroll':'Manual payroll processing','private-support':'Private support documentation'};
const when=n=>new Date(n*1000).toISOString().replace('.000Z',' UTC');
export function activationPanel(data){
  if(!data)return panel('Module activation','<p>Loading module status…</p>');
  if(data.error)return panel('Module activation','<p>'+esc(data.error)+'</p>');
  const rows=Object.entries(data.modules).map(([m,on])=>[esc(names[m]||m),on?'Active':'Locked']);
  return panel('Module activation',
    '<p>Paid modules unlock for this installation after the owner provides a signed activation code. Ordinary bookkeeping, public setup help and authorized payroll history remain available without a code.</p>'+
    '<p>Activation status: '+esc(data.status)+'.</p>'+
    (data.installationId?'<p>Installation ID (share with your authorized issuer):</p><p><code>'+esc(data.installationId)+'</code></p>':
    '<p>Your host has not configured the trusted public verifier and private activation directory. Ask your host administrator to set them up.</p>')+
    (data.expiresAt===null?'':'<p>Expires: '+esc(when(data.expiresAt))+'</p>')+
    table(['Module','Status'],rows),data.configured?btn('activate-modules','Enter activation code'):'');
}
export function activationAction(type,{api,formModal,closeModal,refresh,toast}){
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
    'Your activation ended on '+date+'. Previously activated paid features are now locked. Your authorized payroll history and downloads are still available.':
    'Your activation ends on '+date+'. Renew before then to keep paid modules available.')+
    ' Ask your issuer for a renewed code and enter it in Module activation.</p>'+
    (alreadyOnActivationPage?'':btn('nav','Open Module activation','Module activation'))+'</section>';
  return expired?null:remaining;
}
