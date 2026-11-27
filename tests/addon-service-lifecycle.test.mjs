// Required positive acceptance. This never injects or mocks the service supervisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from 'node:net';
import {fixtureAddon,serviceId,baseFileHashes,hash} from './fixture-addon.mjs';

test('required signed Windows service: v1 restart and v2 health rollback preserve settings and unrelated ledger',{timeout:180000},async t=>{
  const proof={kind:'REQUIRED_REAL_WINDOWS_SIGNED_SERVICE',platform:process.platform,node:process.versions.node,supervisorMocked:false,passed:[],failed:null,packageExecutionProven:false};
  const record=name=>{proof.passed.push(name);t.diagnostic('PASS '+name);};
  const proofPath=fileURLToPath(new URL('../../addon-service-lifecycle-proof.json',import.meta.url));
  try{
    assert.equal(process.platform,'win32','This required gate must run on disposable Windows.');
    const x=await fixtureAddon(t),api=(path,body)=>x.request('owner',path,body);
    const session=async()=>{const r=await api('session');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
    const status=async()=>{const r=await api('addons');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.configured,true,r.data.reason);return r.data;};
    const row=async()=>{const r=(await status()).installed.find(p=>p.id===serviceId);assert.ok(r,'Signed fictional service must be installed.');return r;};
    const invoke=async value=>{const r=await api('addons/invoke',{id:serviceId,value});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.value;};
    const reviewApply=async()=>{const r=await api('addons/review');assert.equal(r.status,200,JSON.stringify(r.data));const candidate=r.data.candidates.find(p=>p.id===serviceId);assert.ok(candidate?.eligible,JSON.stringify(r.data));const a=await api('addons/apply',{id:serviceId,receipt:r.data.receipt,confirm:true});assert.equal(a.status,200,JSON.stringify(a.data));return a.data;};
    await x.login('owner');await x.login('manager');
    const baseHashes=await baseFileHashes(x.runtime),initial=await session(),companyId=initial.state.companies[0].id;
    const seed=await api('action',{companyId,revision:initial.revision,action:{type:'journal',requestId:randomUUID(),date:'2026-11-27',label:'UNRELATED fictional control ledger entry',lines:[['1000',78901],['3000',-78901]],flow:'Financing'}});
    assert.equal(seed.status,200,JSON.stringify(seed.data));
    const seeded=await session(),unrelated=structuredClone(seeded.state.companies[0].entries.find(e=>e.memo==='UNRELATED fictional control ledger entry'));
    assert.ok(unrelated);assert.equal(unrelated.lines.reduce((n,line)=>n+line.cents,0),0);
    const retainUnrelated=async()=>assert.deepEqual((await session()).state.companies[0].entries.find(e=>e.id===unrelated.id),unrelated,'Unrelated ledger entry must remain byte-for-byte equivalent.');
    record('unrelated balanced fictional ledger entry seeded through human owner workflow');

    const v1Manifest=x.manifest({id:serviceId,type:'service',revision:1}),v1Package=await x.stage('fictional-service.fqaddon',v1Manifest);proof.packages={v1Sha256:hash(v1Package)};
    const code=x.signedLicense({addons:[{id:serviceId,minRevision:1,maxRevision:2,permissions:v1Manifest.permissions}]});
    const license=await api('module-activation/upload',{fileName:'fictional-service.fqlicense',code});assert.equal(license.status,200,JSON.stringify(license.data));
    await reviewApply();assert.equal((await row()).revision,1);assert.equal((await row()).status,'active');
    assert.equal(await invoke({value:41}),42);assert.equal((await api('module-activation')).data.upgrade.status,'complete');proof.packageExecutionProven=true;
    record('signed v1 installed and actual contained Node service executed');

    const originalPid=(await invoke({op:'runtime-identity'})).pid;assert.ok(Number.isInteger(originalPid));
    const isolation=(await row()).runtimeIsolation;assert.ok(isolation,'Only trusted native evidence may identify an active service.');assert.equal(isolation.appContainer,true);assert.equal(isolation.capabilities,0);assert.equal(isolation.noNetworkCapabilities,true);assert.equal(isolation.activeProcessLimit,1);assert.equal(isolation.killOnClose,true);assert.ok(isolation.protectedPathsDenied>=2);assert.equal(isolation.pid,originalPid);proof.nativeIsolation=isolation;
    const rejected=await api('addons/invoke',{id:serviceId,value:{kind:'fictional-invalid-request'}});assert.equal(rejected.status,409,JSON.stringify(rejected.data));assert.match(rejected.data.error,/integer|prompt/i);assert.equal(await invoke({value:41}),42,'A rejected request must not kill a healthy service.');assert.equal((await invoke({op:'runtime-identity'})).pid,originalPid,'Ordinary request rejection does not replace the service process.');
    record('ordinary rejected service request left v1 healthy and usable');

    const hostControl=()=>new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:x.probe.port});let text='';socket.setTimeout(1500,()=>{socket.destroy();reject(Error('Trusted host listener positive control timed out.'));});socket.on('data',chunk=>text+=chunk);socket.once('error',reject);socket.once('end',()=>resolve(text));});
    const initialConnections=x.probeConnections;assert.equal(await hostControl(),x.probeNonce);assert.equal(x.probeConnections,initialConnections+1,'Trusted host must reach and read the exact live listener nonce before the guest attempt.');
    const guestBaseline=x.probeConnections,probe=await invoke({op:'sandbox-probes',...x.probe});
    for(const [name,result] of Object.entries(probe.reads))assert.equal(result.denied,true,'Service must not read '+name+': '+JSON.stringify(result));
    for(const name of ['write','process','shell'])assert.equal(probe[name].denied,true,name+': '+JSON.stringify(probe[name]));
    assert.equal(x.probeConnections,guestBaseline,'No guest connection may reach the trusted live listener.');
    assert.ok(['EACCES','EPERM','ERR_ACCESS_DENIED','ETIMEDOUT'].includes(probe.network.code),'Unexpected direct-network result: '+JSON.stringify(probe.network));
    assert.equal(await hostControl(),x.probeNonce);assert.equal(x.probeConnections,guestBaseline+1,'The same trusted live listener must remain reachable after the guest attempt.');
    await new Promise(resolve=>setTimeout(resolve,250));assert.equal(x.probeConnections,guestBaseline+1,'No delayed guest connection may arrive after the socket is destroyed.');
    proof.directNetwork={classification:'DIRECT_CONNECTION_NOT_DELIVERED',observedCode:probe.network.code,hostNonceControlsPassed:2,guestAcceptedConnections:0};
    record('contained service denied core/database/outside reads, overwrite, process and shell; direct network delivered no connection between successful nonce controls');

    const settings={label:'Owner preserved v1 service settings'};
    const settingChange=await api('addons/settings',{id:serviceId,settings,confirm:true});assert.equal(settingChange.status,200,JSON.stringify(settingChange.data));assert.equal((await row()).pendingRestart,true);
    assert.equal((await api('addons/restart',{id:serviceId,confirm:false})).status,409);
    const settingsRestart=await api('addons/restart',{id:serviceId,confirm:true});assert.equal(settingsRestart.status,200,JSON.stringify(settingsRestart.data));
    assert.deepEqual((await row()).settings,settings);assert.equal((await row()).pendingRestart,false);
    assert.equal((await invoke({kind:'prompt',prompt:'FICTIONAL'})).label,settings.label);
    assert.deepEqual(await invoke({op:'private-state',value:'FICTIONAL v1 private state'}),{value:'FICTIONAL v1 private state'});
    await retainUnrelated();const beforeHostRestartPid=(await invoke({op:'runtime-identity'})).pid;
    await x.stop();await x.launch();assert.equal((await x.login('owner',{accept:false})).termsRequired,undefined,'Previously accepted Terms survive host restart.');
    assert.equal((await row()).revision,1);assert.deepEqual((await row()).settings,settings);assert.equal(await invoke({value:8}),9);assert.notEqual((await invoke({op:'runtime-identity'})).pid,beforeHostRestartPid,'A new restricted process restores the accepted service after host restart.');
    assert.deepEqual(await invoke({op:'private-state'}),{value:'FICTIONAL v1 private state'});await retainUnrelated();
    record('v1, owner settings and private state survived a sequential full host restart');

    const beforeUpdate=await session();
    const v2Package=await x.stage('fictional-service.fqaddon',x.manifest({id:serviceId,type:'service',revision:2,healthy:false,increment:500}));proof.packages.v2Sha256=hash(v2Package);
    await reviewApply();assert.equal((await row()).revision,1);assert.equal((await row()).pendingRestart,true);assert.equal(await invoke({value:10}),11);
    assert.equal((await api('addons/restart',{id:serviceId,confirm:false})).status,409);
    const rollback=await api('addons/restart',{id:serviceId,confirm:true});assert.equal(rollback.status,200,JSON.stringify(rollback.data));
    const retained=await row();assert.equal(retained.revision,1);assert.equal(retained.status,'rolled-back');assert.equal(retained.pendingRestart,false);assert.deepEqual(retained.settings,settings);assert.match(retained.reason,/health|start|working/i);
    assert.equal(await invoke({value:10}),11);assert.equal((await invoke({kind:'prompt',prompt:'FICTIONAL rollback'})).label,settings.label);assert.deepEqual(await invoke({op:'private-state'}),{value:'FICTIONAL v1 private state'});
    assert.deepEqual((await session()).state,beforeUpdate.state);await retainUnrelated();assert.deepEqual(await baseFileHashes(x.runtime),baseHashes,'No add-on installation/update rebuilt or overlaid the copied base.');
    record('signed v2 failed real health check; v1, settings, private state and all existing books restored');

    for(const name of await readdir(x.directory))await unlink(join(x.directory,name));
    await x.stop();await x.launch();await x.login('owner',{accept:false});assert.equal((await row()).revision,1);assert.deepEqual((await row()).settings,settings);assert.equal(await invoke({value:10}),11);await retainUnrelated();assert.deepEqual((await session()).state,beforeUpdate.state);
    record('accepted cached v1 restored after rollback and another host restart without dropped package files');
    await x.stop();record('actual service and host closed before test data cleanup');
    proof.result='PASS_REAL_WINDOWS_SIGNED_SERVICE_LIFECYCLE';proof.runtimeFiles=x.build.files;proof.unrelatedLedgerEntryId=unrelated.id;
  }catch(error){proof.result='FAIL_REQUIRED_SERVICE_GATE';proof.failed=String(error.message||error);throw error;}
  finally{await writeFile(proofPath,JSON.stringify(proof,null,2)+'\n');}
});
