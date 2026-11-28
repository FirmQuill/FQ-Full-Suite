// Owner-facing controls for the host's signed, declarative add-on installer.
// All package-provided labels and values are text; schemas never supply HTML.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mounted=new WeakSet();
const reserved=new Set(['constructor','prototype','__proto__']);
const schemaKeys=new Set(['key','label','type','default','min','max','maxLength']);

function settingsSchema(value){
  if(!Array.isArray(value)||value.length>32)throw Error('The add-on settings schema is unsupported.');
  const keys=new Set();
  return value.map(field=>{
    if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(key=>!schemaKeys.has(key))||
      typeof field.key!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field.key)||reserved.has(field.key)||keys.has(field.key)||
      typeof field.label!=='string'||!field.label.trim()||field.label.length>200||!['string','boolean','integer'].includes(field.type))throw Error('The add-on settings schema is unsupported.');
    keys.add(field.key);
    if(field.type==='string'){
      if(field.min!==undefined||field.max!==undefined||(field.maxLength!==undefined&&(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>4096))||
        (field.default!==undefined&&(typeof field.default!=='string'||field.default.length>(field.maxLength??4096))))throw Error('The add-on settings schema is unsupported.');
    }else if(field.type==='integer'){
      if(field.maxLength!==undefined||[field.min,field.max,field.default].some(number=>number!==undefined&&!Number.isSafeInteger(number))||
        (field.min!==undefined&&field.max!==undefined&&field.min>field.max)||
        (field.default!==undefined&&((field.min!==undefined&&field.default<field.min)||(field.max!==undefined&&field.default>field.max))))throw Error('The add-on settings schema is unsupported.');
    }else if(field.min!==undefined||field.max!==undefined||field.maxLength!==undefined||(field.default!==undefined&&typeof field.default!=='boolean'))throw Error('The add-on settings schema is unsupported.');
    return field;
  });
}

function settingsForm(addon){
  if(addon.settingsSchema===undefined||addon.settingsSchema===null)return '';
  let schema;
  try{schema=settingsSchema(addon.settingsSchema);}catch{return '<p>The add-on settings schema is unsupported. Ask the publisher for a compatible package.</p>';}
  if(!schema.length)return '';
  const values=addon.settings&&typeof addon.settings==='object'&&!Array.isArray(addon.settings)?addon.settings:{};
  const fields=schema.map((field,index)=>{
    const supplied=Object.hasOwn(values,field.key)?values[field.key]:field.default;
    const name='addon-setting-'+index;
    if(field.type==='boolean')return '<label><input type="checkbox" name="'+name+'"'+(supplied===true?' checked':'')+'> '+esc(field.label)+'</label>';
    if(field.type==='integer')return '<label>'+esc(field.label)+'<input type="number" step="1" name="'+name+'" value="'+esc(Number.isSafeInteger(supplied)?supplied:'')+'"'+(field.min!==undefined?' min="'+field.min+'"':'')+(field.max!==undefined?' max="'+field.max+'"':'')+' required></label>';
    return '<label>'+esc(field.label)+'<input type="text" name="'+name+'" value="'+esc(typeof supplied==='string'?supplied:'')+'" maxlength="'+(field.maxLength??4096)+'"></label>';
  }).join('');
  return '<form data-addon-settings-form data-addon-id="'+esc(addon.id)+'" data-addon-schema="'+esc(JSON.stringify(schema))+'"><fieldset><legend>Add-on settings</legend>'+fields+'</fieldset>'+
    '<label><input type="checkbox" data-addon-settings-approve required> I reviewed and approve these settings.</label><button type="submit" data-addon-action="settings" disabled>Save add-on settings</button></form>';
}

function installedMarkup(addon){
  const pending=addon.pendingRestart===true;
  return '<article class="card" data-addon-installed data-addon-id="'+esc(addon.id)+'"><h3>'+esc(addon.name||addon.id)+'</h3><p><code>'+esc(addon.id)+'</code> · Revision '+esc(addon.revision)+' · '+esc(addon.type)+'</p><p>'+esc(pending?'Restart required':addon.status||'Installed')+(addon.reason?': '+esc(addon.reason):'')+'</p>'+
    (pending?'<p>Apply has staged this service update. Review the reason above before approving its restart.</p><label><input type="checkbox" data-addon-restart-approve> I approve restarting this add-on service.</label><button type="button" data-addon-action="restart" disabled>Approve restart</button>':'')+
    networkMarkup(addon.network,Array.isArray(addon.permissions)&&addon.permissions.includes('network.https'),'Approved HTTPS destinations')+
    (addon.controls===true?'<button type="button" data-addon-action="controls">Open '+esc(addon.name||addon.id)+' controls</button><section data-addon-controls></section>':'')+
    writePolicyMarkup(addon)+(addon.writeMode==='automatic'?'':writeProposalsMarkup(addon.writeProposals))+settingsForm(addon)+'</article>';
}

function controlKey(key){
  return typeof key==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(key)&&!reserved.has(key);
}

function controlField(field){
  if(!controlKey(field?.key)||typeof field.label!=='string')throw Error('Unsupported add-on control field.');
  const attributes=' name="addon-control-'+esc(field.key)+'" data-addon-field="'+esc(field.key)+'"';
  const label=esc(field.label);
  if(field.type==='checkbox')return '<label><input type="checkbox"'+attributes+(field.value===true?' checked':'')+'> '+label+'</label>';
  if(field.type==='select'){
    if(!Array.isArray(field.options))throw Error('Missing add-on control choices.');
    const choices=field.options.map(choice=>{
      if(typeof choice?.value!=='string'||typeof choice.label!=='string')throw Error('Unsupported add-on control choice.');
      return '<option value="'+esc(choice.value)+'"'+(choice.value===field.value?' selected':'')+'>'+esc(choice.label)+'</option>';
    }).join('');
    return '<label>'+label+'<select'+attributes+' required>'+choices+'</select></label>';
  }
  if(!['text','integer'].includes(field.type))throw Error('Unsupported add-on control type.');
  const type=field.type==='integer'?'type="number" step="1"':'type="text"';
  return '<label>'+label+'<input '+type+attributes+' value="'+esc(field.value)+'"></label>';
}

function controlPanel(panel){
  if(typeof panel?.title!=='string'||!Array.isArray(panel.actions))throw Error('The add-on returned unsupported controls.');
  const forms=panel.actions.map(action=>{
    if(!controlKey(action?.id)||typeof action.label!=='string'||!Array.isArray(action.fields??[]))throw Error('Unsupported add-on control action.');
    return '<form data-addon-control-form="'+esc(action.id)+'">'+(action.fields??[]).map(controlField).join('')+
      '<button type="submit" data-addon-action="control-submit">'+esc(action.label)+'</button></form>';
  }).join('');
  const messages=panel.messages??[];
  if(!Array.isArray(messages)||messages.some(msg=>typeof msg!=='string'))throw Error('Unsupported add-on control message.');
  return '<h4 tabindex="-1">'+esc(panel.title)+'</h4>'+(panel.description?'<p>'+esc(panel.description)+'</p>':'')+
    messages.map(msg=>'<p>'+esc(msg)+'</p>').join('')+forms;
}

function controlValues(form){
  const values=Object.create(null);
  for(const input of form.querySelectorAll('[data-addon-field]')){
    const key=input.dataset.addonField;
    if(!controlKey(key)||Object.hasOwn(values,key))throw Error('Invalid add-on control field.');
    if(input.type==='checkbox')values[key]=input.checked;
    else if(input.type==='number'&&input.value!==''){
      if(!Number.isSafeInteger(input.valueAsNumber))throw Error('Enter a whole number.');
      values[key]=input.valueAsNumber;
    }else values[key]=input.value;
  }
  return values;
}

function networkMarkup(network,expected,title){
  if(!expected&&(!Array.isArray(network)||!network.length))return '';
  return '<p>'+title+'</p>'+(Array.isArray(network)&&network.length&&network.every(origin=>typeof origin==='string')?'<ul>'+network.map(origin=>'<li><code>'+esc(origin)+'</code></li>').join('')+'</ul>':'<p>The destination list is unavailable. Obtain a fresh review before Apply.</p>');
}

function writePolicyMarkup(addon){
  if(addon.type!=='service'||!Array.isArray(addon.permissions)||!addon.permissions.includes('workspace.write.auto'))return '';
  const automatic=addon.writeMode==='automatic';
  return '<form data-addon-write-policy data-addon-id="'+esc(addon.id)+'"><fieldset><legend>Workspace write policy</legend>'+
    (automatic?'<p><strong>Automatic workspace writes enabled</strong></p>':'<p>Workspace writes require separate approval for each operation.</p>')+
    '<p>Automatic mode permits this add-on to apply authorized workspace writes without approval for each operation. Installing a package does not enable this policy.</p>'+
    '<label><input type="checkbox" name="autoApproveWrites"'+(automatic?' checked':'')+'> Allow automatic workspace writes for this add-on</label></fieldset>'+
    '<label><input type="checkbox" data-addon-policy-approve required> I approve this write policy</label><button type="submit" data-addon-action="write-policy" disabled>Save policy</button></form>';
}

function writeProposalsMarkup(proposals){
  if(!Array.isArray(proposals)||!proposals.length)return '';
  return '<section><h4>Workspace write requests</h4><p>Each request needs separate owner approval for the exact operation and contents below.</p>'+proposals.map(proposal=>{
    let body;try{body=JSON.stringify(proposal.body,null,2);}catch{}
    const pending=proposal.status==='pending'&&typeof proposal.id==='string'&&!!proposal.id&&typeof proposal.digest==='string'&&/^[a-f0-9]{64}$/.test(proposal.digest)&&typeof body==='string';
    return '<article class="card" data-addon-write-proposal data-addon-proposal-id="'+esc(proposal.id)+'" data-addon-digest="'+esc(proposal.digest)+'"><h5>Workspace write '+esc(proposal.id)+'</h5><p>Operation: <code>'+esc(proposal.path)+'</code></p><p>'+esc(proposal.status)+(proposal.reason?': '+esc(proposal.reason):'')+'</p><pre>'+esc(body??'The request contents are unavailable.')+'</pre>'+
      '<p>Content digest: <code>'+esc(proposal.digest)+'</code></p>'+
      (pending?'<label><input type="checkbox" data-addon-write-approve> I reviewed this exact workspace write and approve it.</label><button type="button" data-addon-action="approve-write" disabled>Approve workspace write</button>':'')+'</article>';
  }).join('')+'</section>';
}

const permissionText=value=>typeof value==='string'?value:JSON.stringify(value);
function reviewMarkup(review,canApply){
  const errors=Array.isArray(review?.errors)?review.errors:[];
  const candidates=Array.isArray(review?.candidates)?review.candidates:[];
  return (errors.length?'<ul>'+errors.map(error=>'<li><code>'+esc(error.file)+'</code>: '+esc(error.reason)+'</li>').join('')+'</ul>':'')+
    (candidates.length?candidates.map(candidate=>{
      const permissions=Array.isArray(candidate.permissions)?candidate.permissions:[];
      const networkComplete=!permissions.includes('network.https')||Array.isArray(candidate.network)&&candidate.network.length>0&&candidate.network.every(origin=>typeof origin==='string');
      const eligible=canApply&&candidate.eligible===true&&typeof candidate.id==='string'&&!!candidate.id&&Array.isArray(candidate.permissions)&&networkComplete;
      const service=candidate.type==='service';
      return '<article class="card" data-addon-candidate data-addon-id="'+esc(candidate.id)+'"><h3>'+esc(candidate.name||candidate.id)+'</h3><p><code>'+esc(candidate.id)+'</code> · Revision '+esc(candidate.revision)+' · '+esc(candidate.type)+'</p><p>'+esc(candidate.reason||(eligible?'Ready for owner review':'Unavailable'))+'</p><p>Requested permissions</p>'+
        (permissions.length?'<ul>'+permissions.map(permission=>'<li>'+esc(permissionText(permission))+'</li>').join('')+'</ul>':'<p>No additional permissions requested.</p>')+
        networkMarkup(candidate.network,permissions.includes('network.https'),'Requested HTTPS destinations')+
        (service?candidate.restartRequired?'<p>This update replaces an installed service. Apply stages the update; a separate owner approval is required to restart the service.</p>':'<p>Apply installs this add-on and starts its restricted service. Review its permissions before approving.</p>':'<p>Data changes apply without restarting FirmQuill.</p>')+
        (eligible?'<label><input type="checkbox" data-addon-apply-approve> I reviewed this add-on and approve its listed permissions and Apply.</label><button type="button" data-addon-action="apply" data-addon-eligible="true" disabled>Apply add-on</button>':'<p>This package cannot be applied from this review.</p>')+'</article>';
    }).join(''):'<p>No add-on candidates found.</p>');
}

export function addonPanel(data){
  if(!data)return '<section class="panel" data-addons data-addon-configured="false"><h2>Signed add-ons</h2><p>Loading add-on status…</p></section>';
  const configured=data.configured===true;
  const installed=Array.isArray(data.installed)?data.installed:[];
  return '<section class="panel" data-addons data-addon-configured="'+configured+'"><div class="panelhead"><h2>Signed add-ons</h2><button type="button" data-addon-action="review"'+(!configured?' disabled':'')+'>Review add-on folder</button></div>'+
    (data.installationId?'<p>Installation ID (share only with your issuer): <code>'+esc(data.installationId)+'</code></p>':'')+
    (!configured?'<p>The host administrator must configure the trusted publisher and protected add-on installation directory.</p>':'<p>Place a signed, installation-bound add-on in the package folder, then review its permissions and explicitly Apply it here.</p>')+
    (data.reason||data.error?'<p>'+esc(data.reason||data.error)+'</p>':'')+
    '<p data-addon-message role="status" aria-live="polite"></p>'+
    (installed.length?installed.map(installedMarkup).join(''):'<p>No add-ons installed.</p>')+
    '<div data-addon-review>'+((Array.isArray(data.candidates)&&data.candidates.length)?reviewMarkup(data,false):'')+'</div></section>';
}

function settingsValues(form){
  const schema=settingsSchema(JSON.parse(form.dataset.addonSchema)),settings={};
  schema.forEach((field,index)=>{
    const input=form.elements.namedItem('addon-setting-'+index);
    if(!input)throw Error('Refresh Packages before saving these settings.');
    let value;
    if(field.type==='boolean')value=input.checked===true;
    else if(field.type==='integer'){
      if(typeof input.value!=='string'||!/^[-+]?\d+$/.test(input.value))throw Error(field.label+' must be a whole number.');
      value=Number(input.value);
      if(!Number.isSafeInteger(value)||(field.min!==undefined&&value<field.min)||(field.max!==undefined&&value>field.max))throw Error(field.label+' is outside the permitted range.');
    }else{
      value=input.value;
      if(typeof value!=='string'||value.length>(field.maxLength??4096))throw Error(field.label+' exceeds its permitted length.');
    }
    settings[field.key]=value;
  });
  return settings;
}

export function mountAddonActions(root,{api,refresh=async()=>{},toast=()=>{}}){
  const scope=root.querySelector('[data-addons]');
  if(!scope||mounted.has(scope))return;
  mounted.add(scope);
  const message=scope.querySelector('[data-addon-message]'),reviewSlot=scope.querySelector('[data-addon-review]');
  let busy=false,review=null;
  const report=text=>{if(message&&scope.isConnected)message.textContent=text;};
  function sync(){
    for(const button of scope.querySelectorAll('[data-addon-action]')){
      const action=button.dataset.addonAction;
      if(action==='controls'||action==='control-submit')button.disabled=busy;
      if(action==='review')button.disabled=busy||scope.dataset.addonConfigured!=='true';
      if(action==='apply')button.disabled=busy||!button.closest('[data-addon-candidate]')?.querySelector('[data-addon-apply-approve]')?.checked;
      if(action==='restart')button.disabled=busy||!button.closest('[data-addon-installed]')?.querySelector('[data-addon-restart-approve]')?.checked;
      if(action==='approve-write')button.disabled=busy||!button.closest('[data-addon-write-proposal]')?.querySelector('[data-addon-write-approve]')?.checked;
      if(action==='write-policy')button.disabled=busy||!button.closest('[data-addon-write-policy]')?.querySelector('[data-addon-policy-approve]')?.checked;
      if(action==='settings')button.disabled=busy||!button.closest('[data-addon-settings-form]')?.querySelector('[data-addon-settings-approve]')?.checked;
    }
  }
  async function reload(success,result){
    report(success);toast(success);
    try{await refresh(result);}catch{report(success+' Refresh Packages to see the current status.');}
  }
  async function showControls(card,action,values){
    const slot=card?.querySelector('[data-addon-controls]');
    if(!slot)return;
    report('Loading add-on controls…');
    try{
      const panel=await api('addons/controls',{id:card.dataset.addonId,action,values});
      if(!scope.isConnected)return;
      slot.innerHTML=controlPanel(panel);
      slot.querySelector('h4')?.focus();
      report('');
    }catch(error){
      if(scope.isConnected)slot.textContent='';
      report((error?.message||'Add-on controls are unavailable.')+' Open the controls again to refresh.');
    }
  }
  scope.addEventListener('change',sync);
  scope.addEventListener('click',async event=>{
    const button=event.target.closest?.('[data-addon-action]');
    if(!button||!scope.contains(button)||['settings','write-policy','control-submit'].includes(button.dataset.addonAction))return;
    event.preventDefault();
    if(busy||button.disabled)return;
    const action=button.dataset.addonAction;
    busy=true;sync();
    try{
      if(action==='controls'){
        await showControls(button.closest('[data-addon-installed]'),'view',{});
      }else if(action==='review'){
        review=null;report('Checking signed add-ons…');
        const result=await api('addons/review');
        if(!scope.isConnected)return;
        const usable=typeof result?.receipt==='string'&&/^[a-f0-9]{64}$/.test(result.receipt);
        review=usable?result:null;
        reviewSlot.innerHTML=reviewMarkup(result,usable);
        report(usable?'Review each package and its requested permissions before Apply.':'The folder review did not produce an approval receipt.');
      }else if(action==='apply'){
        const card=button.closest('[data-addon-candidate]'),id=card?.dataset.addonId;
        const candidate=review?.candidates?.find(item=>item.id===id&&item.eligible===true);
        if(!candidate||!card.querySelector('[data-addon-apply-approve]')?.checked)throw Error('Review this package and approve its permissions before Apply.');
        report('Applying reviewed add-on…');
        const result=await api('addons/apply',{id,receipt:review.receipt,confirm:true});
        review=null;
        if(scope.isConnected)reviewSlot.replaceChildren();
        await reload(candidate.restartRequired?'Add-on update staged. Restart required; approve the service restart separately.':'Add-on applied.',result);
      }else if(action==='restart'){
        const card=button.closest('[data-addon-installed]');
        if(!card?.querySelector('[data-addon-restart-approve]')?.checked)throw Error('Approve this add-on service restart first.');
        report('Restarting approved add-on service…');
        const result=await api('addons/restart',{id:card.dataset.addonId,confirm:true});
        const installed=result?.installed?.find(addon=>addon.id===card.dataset.addonId);
        const failed=installed&&['rolled-back','unavailable','license-required','failed'].includes(installed.status);
        await reload(failed?'Add-on restart did not complete. '+(installed.reason||'Review its current status.'):
          installed?.pendingRestart?'Restart required. '+(installed.reason||'Review the pending service change.'):'Approved add-on restart completed.',result);
      }else if(action==='approve-write'){
        const proposal=button.closest('[data-addon-write-proposal]'),addon=button.closest('[data-addon-installed]');
        if(!proposal?.querySelector('[data-addon-write-approve]')?.checked||!addon||!/^[a-f0-9]{64}$/.test(proposal.dataset.addonDigest||''))throw Error('Review and approve this exact workspace write first.');
        const id=addon.dataset.addonId,proposalId=proposal.dataset.addonProposalId,digest=proposal.dataset.addonDigest;
        report('Applying separately approved workspace write…');
        const result=await api('addons/approve-write',{id,proposalId,digest,confirm:true});
        const updated=result?.installed?.find(item=>item.id===id)?.writeProposals?.find(item=>item.id===proposalId)||result?.proposal;
        const incomplete=updated&&['pending','failed','rejected','stale','blocked'].includes(updated.status);
        await reload(incomplete?'Workspace write did not complete. '+(updated.reason||'Review the current request status.'):'Approved workspace write completed.',result);
      }
    }catch(error){report(error?.message||'The add-on operation could not be completed.');}
    finally{busy=false;if(scope.isConnected)sync();}
  });
  scope.addEventListener('submit',async event=>{
    const policy=event.target.closest?.('[data-addon-write-policy]');
    const form=event.target.closest?.('[data-addon-settings-form]');
    const controls=event.target.closest?.('[data-addon-control-form]');
    if(!(controls||form||policy)||!scope.contains(controls||form||policy))return;
    event.preventDefault();
    event.stopPropagation?.();
    if(busy)return;
    busy=true;sync();
    try{
      if(controls){
        await showControls(controls.closest('[data-addon-installed]'),controls.dataset.addonControlForm,controlValues(controls));
        return;
      }
      if(policy){
        if(!policy.querySelector('[data-addon-policy-approve]')?.checked)throw Error('Review and approve this write policy before saving.');
        const autoApproveWrites=policy.querySelector('[name=autoApproveWrites]')?.checked===true;
        report('Saving owner-approved workspace write policy…');
        const result=await api('addons/write-policy',{id:policy.dataset.addonId,autoApproveWrites,confirm:true});
        await reload(autoApproveWrites?'Automatic workspace writes enabled.':'Workspace writes now require separate approval for each operation.',result);
        return;
      }
      if(!form.querySelector('[data-addon-settings-approve]')?.checked)throw Error('Review and approve these settings before saving.');
      const settings=settingsValues(form);report('Saving approved add-on settings…');
      const result=await api('addons/settings',{id:form.dataset.addonId,settings,confirm:true});
      const installed=result?.installed?.find(addon=>addon.id===form.dataset.addonId);
      await reload(installed?.pendingRestart?'Add-on settings saved. Restart required; approve the service restart separately.':'Add-on settings saved. Check its status for any required restart.',result);
    }catch(error){report(error?.message||'The add-on settings could not be saved.');}
    finally{busy=false;if(scope.isConnected)sync();}
  });
  sync();
}
