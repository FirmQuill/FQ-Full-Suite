import test from 'node:test';
import assert from 'node:assert/strict';
import {addonPanel,mountAddonActions} from '../web/main/addon-ui.mjs';

const receipt='a'.repeat(64);
const candidate={id:'fictional-service',name:'Fictional service',revision:2,type:'service',permissions:['read:fictional-report'],eligible:true,reason:'Ready for review',restartRequired:true};

function fixture({configured=true,review={receipt,candidates:[candidate],errors:[]}}={}){
  const handlers={},buttons=[],calls=[],refreshes=[],toasts=[];
  const message={textContent:''},reviewSlot={innerHTML:'',replaceChildren(){this.innerHTML='';}};
  const scope={
    isConnected:true,dataset:{addonConfigured:String(configured)},handlers,
    querySelector(selector){return selector==='[data-addon-message]'?message:selector==='[data-addon-review]'?reviewSlot:null;},
    querySelectorAll(){return buttons;},contains(element){return !!element;},
    addEventListener(name,handler){assert.equal(handlers[name],undefined,'one handler per mounted scope');handlers[name]=handler;}
  };
  const root={querySelector:()=>scope};
  const button=(action,card)=>{
    const node={dataset:{addonAction:action},disabled:false,closest(selector){return selector==='[data-addon-action]'?node:card;}};
    buttons.push(node);return node;
  };
  const reviewButton=button('review');
  const opts={api:async(path,body)=>{calls.push({path,body});return path==='addons/review'?review:{status:'applied'};},refresh:async result=>{refreshes.push(result);},toast:text=>toasts.push(text)};
  const mount=()=>mountAddonActions(root,opts);
  const change=()=>handlers.change();
  const click=node=>handlers.click({target:node,preventDefault(){}});
  const submit=form=>handlers.submit({target:form,preventDefault(){}});
  function card(kind,id){
    const approve={checked:false};
    return {dataset:{addonId:id},approve,querySelector(selector){return selector===`[data-addon-${kind}-approve]`?approve:null;}};
  }
  function settings(schema,values){
    const form=card('settings','fictional-service');form.dataset.addonSchema=JSON.stringify(schema);
    form.elements={namedItem:name=>values[Number(name.replace('addon-setting-',''))]};
    form.closest=selector=>selector==='[data-addon-settings-form]'?form:null;
    const saveButton=button('settings',form);
    return {form,saveButton};
  }
  return {root,scope,opts,mount,button,card,settings,change,click,submit,reviewButton,message,reviewSlot,calls,refreshes,toasts};
}

test('add-on panel escapes package metadata, reasons, settings and installation identifiers',()=>{
  const malicious='"><img src=x onerror="alert(1)"><script>bad()</script>';
  const markup=addonPanel({configured:true,installationId:malicious,reason:malicious,installed:[{
    id:malicious,name:malicious,revision:1,type:malicious,status:malicious,reason:malicious,
    settingsSchema:[{key:'message',label:malicious,type:'string',default:malicious,maxLength:300}],settings:{message:malicious}
  }],candidates:[{...candidate,name:malicious,permissions:[malicious,{scope:malicious}]}]});
  assert.doesNotMatch(markup,/<(?:script|img)\b/);
  assert.match(markup,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(markup,/value="&quot;&gt;&lt;img/);
  assert.match(markup,/data-addon-id="&quot;&gt;&lt;img/);
  assert.match(markup,/&quot;scope&quot;:&quot;/);
  assert.doesNotMatch(markup,/data-addon-action="apply"/,'unreviewed candidates cannot be applied');
});

test('only bounded declarative settings types create controls; unsupported schemas fail closed',()=>{
  const valid=[{key:'label',label:'Report label',type:'string',default:'Fictional',maxLength:80},{key:'enabled',label:'Enabled',type:'boolean',default:true},{key:'interval',label:'Interval',type:'integer',default:4,min:1,max:10}];
  const render=schema=>addonPanel({configured:true,installed:[{id:'fixture',revision:1,type:'data',settingsSchema:schema}]});
  const markup=render(valid);
  assert.match(markup,/type="text" name="addon-setting-0" value="Fictional" maxlength="80"/);
  assert.match(markup,/type="checkbox" name="addon-setting-1" checked/);
  assert.match(markup,/type="number" step="1" name="addon-setting-2" value="4" min="1" max="10" required/);
  assert.match(markup,/data-addon-settings-approve required/);
  assert.match(markup,/data-addon-action="settings" disabled/);
  for(const schema of [
    [{key:'run',label:'Run',type:'script',default:'alert(1)'}],
    [{key:'constructor',label:'Invalid key',type:'string'}],
    [{key:'safe',label:'Safe',type:'string',html:'<button>run</button>'}],
    [{key:'same',label:'One',type:'string'},{key:'same',label:'Two',type:'boolean'}],
    [{key:'rate',label:'Rate',type:'integer',default:1.5}],
    [{key:'rate',label:'Rate',type:'integer',min:5,max:2}],
    [{key:'name',label:'Name',type:'string',maxLength:4097}],
    [{key:'enabled',label:'Enabled',type:'boolean',default:'true'}]
  ]){
    const rejected=render(schema);
    assert.match(rejected,/settings schema is unsupported/);
    assert.doesNotMatch(rejected,/<form\b|data-addon-action="settings"/);
  }
});

test('review shows escaped permissions and errors, but sends no Apply without fresh explicit approval',async()=>{
  const x=fixture({review:{receipt,candidates:[{...candidate,permissions:['read:<report>'],reason:'Ready <now>'}],errors:[{file:'<broken>.fqpackage',reason:'Rejected <signature>'}]}});
  x.mount();x.mount();assert.deepEqual(x.calls,[]);
  await x.click(x.reviewButton);
  assert.deepEqual(x.calls,[{path:'addons/review',body:undefined}]);
  assert.match(x.reviewSlot.innerHTML,/read:&lt;report&gt;/);
  assert.match(x.reviewSlot.innerHTML,/&lt;broken&gt;\.fqpackage/);
  assert.match(x.reviewSlot.innerHTML,/Rejected &lt;signature&gt;/);
  assert.match(x.reviewSlot.innerHTML,/separate owner approval is required to restart/);
  assert.match(x.reviewSlot.innerHTML,/data-addon-apply-approve/);
  const card=x.card('apply',candidate.id),apply=x.button('apply',card);x.change();
  assert.equal(apply.disabled,true);await x.click(apply);assert.equal(x.calls.length,1);
  card.approve.checked=true;x.change();assert.equal(apply.disabled,false);
  await x.click(apply);
  assert.deepEqual(x.calls[1],{path:'addons/apply',body:{id:candidate.id,receipt,confirm:true}});
  assert.equal(x.calls.some(call=>call.path==='addons/restart'),false,'Apply does not approve restart');
  assert.match(x.message.textContent,/Restart required/);
  assert.equal(x.refreshes.length,1);assert.equal(x.reviewSlot.innerHTML,'');
});

test('invalid review receipts expose no Apply controls and unconfigured hosts cannot review',async()=>{
  const x=fixture({review:{receipt:'untrusted',candidates:[candidate],errors:[]}});x.mount();await x.click(x.reviewButton);
  assert.doesNotMatch(x.reviewSlot.innerHTML,/data-addon-action="apply"/);
  assert.match(x.message.textContent,/did not produce an approval receipt/);
  const unconfigured=fixture({configured:false});unconfigured.mount();await unconfigured.click(unconfigured.reviewButton);assert.deepEqual(unconfigured.calls,[]);
});

test('service restart requires its own owner checkbox and explicit restart API call',async()=>{
  const markup=addonPanel({configured:true,installed:[{id:candidate.id,name:candidate.name,revision:1,type:'service',status:'running',pendingRestart:true}]});
  assert.match(markup,/Restart required/);assert.match(markup,/data-addon-restart-approve/);assert.match(markup,/data-addon-action="restart" disabled/);
  const x=fixture(),card=x.card('restart',candidate.id),restart=x.button('restart',card);x.mount();
  await x.click(restart);assert.deepEqual(x.calls,[]);
  card.approve.checked=true;x.change();await x.click(restart);
  assert.deepEqual(x.calls,[{path:'addons/restart',body:{id:candidate.id,confirm:true}}]);
  assert.equal(x.refreshes.length,1);
});

test('settings save requires approval, validates types and bounds, and sends only typed schema fields',async()=>{
  const x=fixture();
  const schema=[{key:'title',label:'Title',type:'string',maxLength:12},{key:'enabled',label:'Enabled',type:'boolean'},{key:'interval',label:'Interval',type:'integer',min:1,max:30}];
  const values=[{value:'Fictional'},{checked:true},{value:'3.5'}];
  const {form,saveButton}=x.settings(schema,values);x.mount();assert.equal(saveButton.disabled,true);
  await x.submit(form);assert.equal(x.calls.length,0);assert.match(x.message.textContent,/Review and approve/);
  form.approve.checked=true;x.change();assert.equal(saveButton.disabled,false);
  await x.submit(form);assert.equal(x.calls.length,0);assert.match(x.message.textContent,/whole number/);
  values[2].value='31';await x.submit(form);assert.equal(x.calls.length,0);assert.match(x.message.textContent,/outside the permitted range/);
  values[2].value='3';values[0].value='A title that exceeds its bound';await x.submit(form);assert.equal(x.calls.length,0);assert.match(x.message.textContent,/permitted length/);
  values[0].value='Fictional';await x.submit(form);
  assert.deepEqual(x.calls,[{path:'addons/settings',body:{id:candidate.id,settings:{title:'Fictional',enabled:true,interval:3},confirm:true}}]);
  assert.equal(x.refreshes.length,1);
});

test('server rejection reason stays visible and never causes an automatic restart or retry',async()=>{
  const x=fixture(),card=x.card('restart',candidate.id),restart=x.button('restart',card);card.approve.checked=true;
  x.opts.api=async(path,body)=>{x.calls.push({path,body});throw Error('Verified supervisor unavailable.');};x.mount();
  await x.click(restart);
  assert.equal(x.calls.length,1);assert.equal(x.refreshes.length,0);assert.equal(x.message.textContent,'Verified supervisor unavailable.');
});

test('a failed restart reported with rollback is shown as incomplete rather than successful',async()=>{
  const x=fixture(),card=x.card('restart',candidate.id),restart=x.button('restart',card);card.approve.checked=true;
  x.opts.api=async()=>({installed:[{id:candidate.id,status:'rolled-back',reason:'Health check failed; retained working revision.'}]});x.mount();
  await x.click(restart);
  assert.match(x.message.textContent,/restart did not complete/);
  assert.match(x.message.textContent,/Health check failed/);
  assert.doesNotMatch(x.message.textContent,/restart completed/);
  assert.equal(x.refreshes.length,1);
});

test('workspace write preview renders exact path and JSON as escaped text and offers approval only for pending requests',()=>{
  const body={companyId:'fictional-company',action:{type:'note',text:'<script>never run()</script> & "review"'}};
  const render=status=>addonPanel({configured:true,installed:[{id:candidate.id,name:candidate.name,revision:1,type:'service',status:'active',writeProposals:[{id:'fictional-proposal',path:'action?scope=<fictional>',body,digest:receipt,status,reason:'Owner must review <exact> contents.'}]}]});
  const markup=render('pending');
  assert.match(markup,/Operation: <code>action\?scope=&lt;fictional&gt;<\/code>/);
  assert.match(markup,/&quot;companyId&quot;: &quot;fictional-company&quot;/);
  assert.match(markup,/&lt;script&gt;never run\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup,/<script\b/);
  assert.match(markup,/Owner must review &lt;exact&gt; contents\./);
  assert.match(markup,/data-addon-write-approve/);
  assert.match(markup,/data-addon-action="approve-write" disabled>Approve workspace write/);
  assert.doesNotMatch(render('applied'),/data-addon-action="approve-write"/);
  assert.doesNotMatch(render('rejected'),/data-addon-action="approve-write"/);
});

test('workspace writes require separate proposal-specific approval and send the immutable digest without a new body',async()=>{
  const x=fixture(),proposal=x.card('write','unused'),addon=x.card('installed',candidate.id);
  proposal.dataset.addonProposalId='fictional-proposal';proposal.dataset.addonDigest=receipt;
  const approve=x.button('approve-write',proposal);
  approve.closest=selector=>selector==='[data-addon-action]'?approve:selector==='[data-addon-installed]'?addon:proposal;
  x.mount();assert.equal(approve.disabled,true);await x.click(approve);assert.deepEqual(x.calls,[]);
  proposal.approve.checked=true;x.change();assert.equal(approve.disabled,false);await x.click(approve);
  assert.deepEqual(x.calls,[{path:'addons/approve-write',body:{id:candidate.id,proposalId:'fictional-proposal',digest:receipt,confirm:true}}]);
  assert.equal(x.refreshes.length,1);assert.match(x.message.textContent,/workspace write completed/);
});

test('a workspace broker rejection stays visible and is never retried automatically',async()=>{
  const x=fixture(),proposal=x.card('write','unused'),addon=x.card('installed',candidate.id);
  proposal.dataset.addonProposalId='fictional-proposal';proposal.dataset.addonDigest=receipt;proposal.approve.checked=true;
  const approve=x.button('approve-write',proposal);
  approve.closest=selector=>selector==='[data-addon-action]'?approve:selector==='[data-addon-installed]'?addon:proposal;
  x.opts.api=async(path,body)=>{x.calls.push({path,body});return {installed:[{id:candidate.id,writeProposals:[{id:'fictional-proposal',status:'stale',reason:'Company revision changed; obtain a new proposal.'}]}]};};
  x.mount();await x.click(approve);
  assert.equal(x.calls.length,1);assert.match(x.message.textContent,/write did not complete/);assert.match(x.message.textContent,/Company revision changed/);assert.equal(x.refreshes.length,1);
});

test('automatic workspace write policy defaults to review despite package permission and clearly displays enabled state',()=>{
  const addon={id:candidate.id,name:candidate.name,revision:1,type:'service',status:'active',permissions:['settings','workspace.write.auto']};
  const markup=addonPanel({configured:true,installed:[addon]});
  assert.match(markup,/name="autoApproveWrites"> Allow automatic workspace writes for this add-on/);
  assert.doesNotMatch(markup,/name="autoApproveWrites" checked/);
  assert.match(markup,/data-addon-policy-approve required> I approve this write policy/);
  assert.match(markup,/data-addon-action="write-policy" disabled>Save policy/);
  assert.doesNotMatch(markup,/<strong>Automatic workspace writes enabled/);
  const enabled=addonPanel({configured:true,installed:[{...addon,writeMode:'automatic',writeProposals:[{id:'old-request',path:'action',body:{},digest:receipt,status:'pending'}]}]});
  assert.match(enabled,/<strong>Automatic workspace writes enabled<\/strong>/);
  assert.match(enabled,/name="autoApproveWrites" checked/);
  assert.doesNotMatch(enabled,/data-addon-action="approve-write"/,'per-operation approval controls are used in review mode');
  assert.doesNotMatch(addonPanel({configured:true,installed:[{...addon,permissions:['settings','workspace.write']}]}),/data-addon-write-policy/);
});

test('automatic write policy requires separate owner confirmation and never submits on checkbox change',async()=>{
  const x=fixture(),approved={checked:false},automatic={checked:false};
  const policy={dataset:{addonId:candidate.id},querySelector:selector=>selector==='[data-addon-policy-approve]'?approved:selector==='[name=autoApproveWrites]'?automatic:null,closest:selector=>selector==='[data-addon-write-policy]'?policy:null};
  const save=x.button('write-policy',policy);x.mount();
  assert.equal(save.disabled,true);automatic.checked=true;x.change();assert.deepEqual(x.calls,[]);assert.equal(save.disabled,true);
  await x.submit(policy);assert.deepEqual(x.calls,[]);assert.match(x.message.textContent,/approve this write policy/);
  approved.checked=true;x.change();assert.equal(save.disabled,false);await x.submit(policy);
  assert.deepEqual(x.calls,[{path:'addons/write-policy',body:{id:candidate.id,autoApproveWrites:true,confirm:true}}]);
  assert.match(x.message.textContent,/Automatic workspace writes enabled/);assert.equal(x.refreshes.length,1);
  automatic.checked=false;x.change();assert.equal(x.calls.length,1);await x.submit(policy);
  assert.deepEqual(x.calls[1],{path:'addons/write-policy',body:{id:candidate.id,autoApproveWrites:false,confirm:true}});
  assert.match(x.message.textContent,/require separate approval/);
});

test('review includes escaped signed HTTPS destinations and withholds Apply when destination scope is missing',async()=>{
  const network=['https://api.fictional.example','https://<script>never-run</script>'];
  const x=fixture({review:{receipt,candidates:[{...candidate,permissions:['settings','network.https'],network}],errors:[]}});x.mount();await x.click(x.reviewButton);
  assert.match(x.reviewSlot.innerHTML,/Requested HTTPS destinations/);
  assert.match(x.reviewSlot.innerHTML,/https:\/\/api\.fictional\.example/);
  assert.match(x.reviewSlot.innerHTML,/https:\/\/&lt;script&gt;never-run&lt;\/script&gt;/);
  assert.doesNotMatch(x.reviewSlot.innerHTML,/<script\b|href=/);
  const missing=fixture({review:{receipt,candidates:[{...candidate,permissions:['settings','network.https']}],errors:[]}});missing.mount();await missing.click(missing.reviewButton);
  assert.match(missing.reviewSlot.innerHTML,/destination list is unavailable/);
  assert.doesNotMatch(missing.reviewSlot.innerHTML,/data-addon-action="apply"/);
  const installed=addonPanel({configured:true,installed:[{...candidate,status:'active',permissions:['network.https'],network}]});
  assert.match(installed,/Approved HTTPS destinations/);assert.match(installed,/https:\/\/api\.fictional\.example/);
});
