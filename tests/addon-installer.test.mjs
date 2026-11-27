import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connect} from 'node:net';
import {fixtureAddon,settingsId,serviceId,baseFileHashes} from './fixture-addon.mjs';

const settingsOnly=process.env.FIRMQUILL_ADDON_SETTINGS_ONLY==='1';
test(settingsOnly?'packaged settings-only Windows proof: signed data apply preserves base files and books; native service gates NOT RUN':'required Windows native Node service installation, workspace writes, restart and rollback gates',{timeout:180000},async t=>{
  const x=await fixtureAddon(t,{settingsOnly}),api=(path,body)=>x.request('owner',path,body),status=async()=>{
    const result=await api('addons');assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.configured,true,result.data.reason);return result.data;
  };
  t.diagnostic('platform='+process.platform+'; Node='+process.versions.node+'; one public runtime build; '+x.build.files+' runtime files; '+(settingsOnly?'DATA-ONLY SETTINGS; no native service started.':'Native Node service gate; fictional injected HTTPS transport, no external provider or browser.'));
  const baseHashes=await baseFileHashes(x.runtime);
  await x.login('owner',{accept:false});assert.equal((await api('addons/review')).status,428);await x.login('owner');await x.login('manager');await x.login('worker');
  let before=(await api('session')).data.state;
  await x.stage('settings.fqaddon',x.manifest());await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service'}));
  const review=async()=>{const result=await api('addons/review');assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
  const apply=async(id,confirmation=true,receipt)=>{const current=receipt??(await review()).receipt;return api('addons/apply',{id,receipt:current,confirm:confirmation});};
  const installed=(value,id)=>value.installed.find(p=>p.id===id);

  await t.test('unsigned eligibility, strict verification and owner/Terms boundaries',async()=>{
    assert.equal((await status()).installed.length,0);const initial=await review();assert.equal(initial.candidates.length,2);assert.ok(initial.candidates.every(p=>!p.eligible&&/license/.test(p.reason)));
    assert.equal((await apply(settingsId)).status,409);
    const badHash=x.manifest({id:'fictional-bad-hash',type:'service'});badHash.files['service.mjs'].sha256='0'.repeat(64);
    const invalid=[['bad-signature.fqaddon',x.manifest({id:'fictional-bad-signature'}),{badSignature:true}],['bad-hash.fqaddon',badHash],
      ['bad-install.fqaddon',x.manifest({id:'fictional-bad-install',installationId:'0'.repeat(64)})],
      ['bad-version.fqaddon',x.manifest({id:'fictional-bad-version',compatibility:{min:'9.0.0',max:'9.0.0',hostApi:1}})],
      ['bad-permissions.fqaddon',x.manifest({id:'fictional-bad-permissions',permissions:['settings','network']})]];
    for(const [name,manifest,options] of invalid)await x.stage(name,manifest,options);
    const rejected=await review();assert.equal(rejected.errors.length,5);for(const [name] of invalid)assert.ok(rejected.errors.some(e=>e.file===name),name);
    assert.equal((await status()).installed.length,0);assert.deepEqual((await api('session')).data.state,before);
    for(const [name] of invalid)await unlink(join(x.directory,name));
    for(const role of ['manager','worker'])for(const [path,body] of [['addons'],['addons/review'],['addons/apply',{id:settingsId,receipt:initial.receipt,confirm:true}],['addons/settings',{id:settingsId,settings:{label:'Forbidden'},confirm:true}],['addons/restart',{id:serviceId,confirm:true}],['addons/invoke',{id:serviceId,value:1}]])assert.equal((await x.request(role,path,body)).status,role==='worker'?404:403,role+' '+path);
  });

  await t.test('matching actual license upload enables review; stale review and missing approval cannot apply',async()=>{
    const activated=await api('module-activation/upload',{fileName:'fictional.fqlicense',code:x.signedLicense()});assert.equal(activated.status,200,JSON.stringify(activated.data));
    const eligible=await review();assert.equal(eligible.candidates.length,2);assert.ok(eligible.candidates.find(p=>p.id===settingsId).eligible);assert.equal(eligible.candidates.find(p=>p.id===serviceId).eligible,!settingsOnly);
    assert.equal((await apply(settingsId,false,eligible.receipt)).status,409);assert.equal((await status()).installed.length,0);
    await x.stage('settings.fqaddon',x.manifest({name:'Changed after review'}));assert.equal((await apply(settingsId,true,eligible.receipt)).status,409);assert.equal((await status()).installed.length,0);
    await x.stage('settings.fqaddon',x.manifest());
    const settings=await apply(settingsId);assert.equal(settings.status,200,JSON.stringify(settings.data));assert.equal(installed(settings.data,settingsId).revision,1);assert.equal(installed(settings.data,settingsId).settings.label,'Fictional default');
    assert.equal((await api('addons/settings',{id:settingsId,settings:{label:'Owner reviewed value'},confirm:false})).status,409);
    const saved=await api('addons/settings',{id:settingsId,settings:{label:'Owner reviewed value'},confirm:true});assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(installed(saved.data,settingsId).settings.label,'Owner reviewed value');
    if(settingsOnly)return;
    const service=await apply(serviceId);assert.equal(service.status,200,JSON.stringify(service.data));assert.equal(installed(service.data,serviceId).status,'active');assert.equal(installed(service.data,serviceId).pendingRestart,false);
    assert.deepEqual((await api('addons/invoke',{id:serviceId,value:{value:41}})).data,{value:42});
    assert.deepEqual((await api('addons/invoke',{id:serviceId,value:{kind:'prompt',prompt:'Explain the fictional books.'}})).data,{value:{text:'Fictional response: Explain the fictional books.',label:'Fictional default'}});
    const isolation=installed(service.data,serviceId).runtimeIsolation;assert.equal(isolation.appContainer,true);assert.equal(isolation.capabilities,0);assert.equal(isolation.noNetworkCapabilities,true);assert.equal(isolation.activeProcessLimit,1);assert.equal(isolation.killOnClose,true);assert.ok(isolation.protectedPathsDenied>=2);assert.equal((await api('addons/invoke',{id:serviceId,value:{op:'runtime-identity'}})).data.value.pid,isolation.pid);
    const hostControl=()=>new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:x.probe.port});let text='';socket.setTimeout(1500,()=>{socket.destroy();reject(Error('Trusted direct-network positive control timed out.'));});socket.on('data',chunk=>text+=chunk);socket.once('error',reject);socket.once('end',()=>resolve(text));});
    const controls=x.probeConnections;assert.equal(await hostControl(),x.probeNonce);assert.equal(x.probeConnections,controls+1);const guestBaseline=x.probeConnections;
    const probe=await api('addons/invoke',{id:serviceId,value:{op:'sandbox-probes',...x.probe}});assert.equal(probe.status,200,JSON.stringify(probe.data));
    for(const [name,result] of Object.entries(probe.data.value.reads))assert.equal(result.denied,true,name+' must not be readable by the service.');
    for(const name of ['write','process','shell'])assert.equal(probe.data.value[name].denied,true,name+' must be denied to the service.');
    assert.equal(x.probeConnections,guestBaseline,'Guest direct-network attempt must not reach the live listener.');assert.ok(['EACCES','EPERM','ERR_ACCESS_DENIED','ETIMEDOUT'].includes(probe.data.value.network.code));assert.equal(await hostControl(),x.probeNonce);assert.equal(x.probeConnections,guestBaseline+1);await new Promise(resolve=>setTimeout(resolve,250));assert.equal(x.probeConnections,guestBaseline+1,'No delayed guest connection may arrive.');t.diagnostic('DIRECT_CONNECTION_NOT_DELIVERED: observed '+probe.data.value.network.code+'; verified zero-capability AppContainer; successful live nonce controls before/after; zero guest accepts.');
    const provider=await api('addons/invoke',{id:serviceId,value:{kind:'https',prompt:'Fictional provider prompt.'}});assert.equal(provider.status,200,JSON.stringify(provider.data));assert.equal(provider.data.value.status,200);assert.match(provider.data.value.body,/Fictional provider response/);assert.equal(x.httpsRequests.length,1);
    assert.deepEqual(await baseFileHashes(x.runtime),baseHashes,'Installing a second package does not rebuild or overwrite any base file.');
  });

  if(settingsOnly){
    assert.deepEqual(await baseFileHashes(x.runtime),baseHashes);assert.deepEqual((await api('session')).data.state,before);
    t.diagnostic('SETTINGS-ONLY EVIDENCE: native service installation, AppContainer service probes, HTTPS broker integration, write proposals/automatic execution, service restart/rollback/cache restoration and service expiry gates were NOT EXECUTED. Required native gate is blocked; this run cannot approve publication.');
    return;
  }

  await t.test('service workspace read and explicit write review precede owner-enabled automatic ledger and employee actions',async()=>{
    const read=await api('addons/invoke',{id:serviceId,value:{op:'workspace-read',path:'/api/session'}});assert.equal(read.status,200,JSON.stringify(read.data));assert.equal(read.data.value.user.role,'owner');assert.equal(Object.hasOwn(read.data.value,'csrf'),false);
    const companyId=before.companies[0].id,revision=read.data.value.revision;
    const staged=await api('addons/invoke',{id:serviceId,value:{op:'workspace-write',path:'/api/action',body:{companyId,revision,action:{type:'journal',requestId:randomUUID(),date:'2026-11-27',label:'Fictional service approved journal',lines:[['1000',2345],['3000',-2345]],flow:'Financing'}}}});
    assert.equal(staged.status,200,JSON.stringify(staged.data));assert.equal(staged.data.value.status,'pending-owner-approval');assert.deepEqual((await api('session')).data.state,before,'Review mode never writes before owner approval.');
    const proposal=installed(await status(),serviceId).writeProposals.find(p=>p.id===staged.data.value.proposalId);assert.ok(proposal);
    const approval={id:serviceId,proposalId:proposal.id,digest:proposal.digest,confirm:true};
    assert.equal((await x.request('manager','addons/approve-write',approval)).status,403);assert.equal((await api('addons/approve-write',{...approval,confirm:false})).status,409);assert.equal((await api('addons/approve-write',{...approval,digest:'0'.repeat(64)})).status,409);
    assert.equal((await api('addons/approve-write',approval)).status,200);assert.equal((await api('addons/approve-write',approval)).status,409,'An approved proposal is not replayable.');
    assert.equal((await api('addons/write-policy',{id:serviceId,autoApproveWrites:true,confirm:false})).status,409);
    assert.equal((await x.request('manager','addons/write-policy',{id:serviceId,autoApproveWrites:true,confirm:true})).status,403);
    const policy=await api('addons/write-policy',{id:serviceId,autoApproveWrites:true,confirm:true});assert.equal(policy.status,200,JSON.stringify(policy.data));assert.equal(installed(policy.data,serviceId).writeMode,'automatic');
    const beforeAutomatic=(await api('session')).data;
    const automaticJournal=await api('addons/invoke',{id:serviceId,value:{op:'workspace-write',path:'/api/action',body:{companyId,revision:beforeAutomatic.revision,action:{type:'journal',requestId:randomUUID(),date:'2026-11-27',label:'Fictional service automatic journal',lines:[['1000',3456],['3000',-3456]],flow:'Financing'}}}});
    assert.equal(automaticJournal.status,200,JSON.stringify(automaticJournal.data));assert.equal(automaticJournal.data.value.status,'complete');
    const afterJournal=(await api('session')).data;
    const automatic=await api('addons/invoke',{id:serviceId,value:{op:'workspace-write',path:'/api/action',body:{companyId,revision:afterJournal.revision,action:{type:'employee',requestId:randomUUID(),date:'2026-11-27',name:'Fictional service-created employee',rate:2500,state:'CO',locality:'Fictional'}}}});
    assert.equal(automatic.status,200,JSON.stringify(automatic.data));assert.equal(automatic.data.value.status,'complete');assert.ok((await api('session')).data.state.companies[0].employees.some(e=>e.name==='Fictional service-created employee'));
    const audit=(await api('audit')).data.events;assert.ok(audit.some(e=>e.kind==='add-on workspace write'&&JSON.parse(e.detail).addonId===serviceId&&JSON.parse(e.detail).outcome==='success'));
    assert.equal((await api('addons/write-policy',{id:serviceId,autoApproveWrites:false,confirm:true})).status,200);before=(await api('session')).data.state;
  });

  await t.test('bad service update requires restart approval and retains last working service',async()=>{
    await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service',revision:2,healthy:false}));const staged=await apply(serviceId);assert.equal(staged.status,200,JSON.stringify(staged.data));
    assert.equal(installed(staged.data,serviceId).revision,1);assert.equal(installed(staged.data,serviceId).pendingRestart,true);
    assert.equal((await api('module-activation')).data.upgrade.status,'restart');assert.deepEqual((await api('addons/invoke',{id:serviceId,value:8})).data,{value:9});
    assert.equal((await api('addons/restart',{id:serviceId,confirm:false})).status,409);
    const failed=await api('addons/restart',{id:serviceId,confirm:true});assert.equal(failed.status,200,JSON.stringify(failed.data));const retained=installed(failed.data,serviceId);
    assert.equal(retained.revision,1);assert.equal(retained.status,'rolled-back');assert.equal(retained.pendingRestart,false);assert.match(retained.reason,/retained last working/i);
    assert.deepEqual((await api('addons/invoke',{id:serviceId,value:8})).data,{value:9});assert.deepEqual((await api('session')).data.state,before);
    await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service',revision:1}));assert.match((await review()).candidates.find(p=>p.id===serviceId).reason,/Older or conflicting/);
    await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service',revision:2,name:'Same revision different package'}));assert.match((await review()).candidates.find(p=>p.id===serviceId).reason,/Older or conflicting/);
  });

  await t.test('higher healthy service update restarts under approval and restores accepted cache after sequential host restart',async()=>{
    await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service',revision:3,increment:3}));assert.equal((await apply(serviceId)).status,200);
    const restarted=await api('addons/restart',{id:serviceId,confirm:true});assert.equal(restarted.status,200,JSON.stringify(restarted.data));assert.equal(installed(restarted.data,serviceId).revision,3);
    assert.deepEqual((await api('addons/invoke',{id:serviceId,value:10})).data,{value:13});
    for(const name of await readdir(x.directory))await unlink(join(x.directory,name));
    assert.deepEqual(await baseFileHashes(x.runtime),baseHashes);await x.stop();await x.launch();
    assert.equal((await x.login('owner',{accept:false})).termsRequired,undefined,'Owner Terms acceptance survives.');assert.equal((await x.login('manager',{accept:false})).termsRequired,undefined,'Manager Terms acceptance survives.');assert.equal((await x.login('worker',{accept:false})).termsRequired,undefined,'Worker Terms acceptance survives.');
    const restored=await status();assert.equal(installed(restored,settingsId).settings.label,'Owner reviewed value');assert.equal(installed(restored,serviceId).revision,3);assert.deepEqual((await api('addons/invoke',{id:serviceId,value:20})).data,{value:23});
    assert.deepEqual((await api('session')).data.state,before,'Ledger books survive install, failed restart and host restart.');
    assert.equal((await x.request('manager','session')).data.user.role,'manager');assert.equal((await x.request('worker','session')).data.user.role,'worker');
    await x.stage('compute.fqaddon',x.manifest({id:serviceId,type:'service',revision:2}));assert.match((await review()).candidates.find(p=>p.id===serviceId).reason,/Older or conflicting/);
  });

  await t.test('expired license disables settings and compute while ordinary ERP books remain usable',async()=>{
    const writes=(await api('audit')).data.events.filter(e=>e.kind==='add-on workspace write').length;
    x.advance(3600000);const expired=await status();assert.ok(expired.installed.every(p=>p.status==='license-required'));assert.ok(expired.installed.every(p=>p.settingsSchema.length===0&&Object.keys(p.settings).length===0));
    assert.equal((await api('addons/invoke',{id:serviceId,value:1})).status,409);assert.equal((await api('addons/settings',{id:settingsId,settings:{label:'Expired edit'},confirm:true})).status,409);
    const current=(await api('session')).data;assert.equal((await api('addons/invoke',{id:serviceId,value:{op:'workspace-write',path:'/api/action',body:{companyId:before.companies[0].id,revision:current.revision,action:{type:'employee',requestId:randomUUID(),date:'2026-11-27',name:'Must never be created',rate:2500,state:'CO',locality:'Fictional'}}}})).status,409);
    assert.equal((await api('audit')).data.events.filter(e=>e.kind==='add-on workspace write').length,writes,'Expired packages are rejected before workspace write dispatch.');
    assert.equal((await api('session')).status,200);assert.deepEqual((await api('session')).data.state,before);assert.deepEqual(await baseFileHashes(x.runtime),baseHashes);
  });
});
