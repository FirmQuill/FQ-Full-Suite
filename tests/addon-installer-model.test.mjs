// MODEL ONLY. The supervisor below reads fictional JSON; it NEVER imports/evaluates package JS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAddonInstaller} from '../addon-installer.mjs';
import {createModuleActivation} from '../module-activation.mjs';
import {activationFixture} from './fixture-activation.mjs';

test('SIMULATED SUPERVISOR MODEL ONLY: installer proposals, automatic policy, rollback, cache restore, high-water history and expiry',{timeout:30000},async t=>{
  t.diagnostic('MODEL ONLY: no package JavaScript is executed, no child is launched, and this does not prove Windows isolation, native service startup, real AI/network or provider authentication.');
  const root=await mkdtemp(join(tmpdir(),'fq-addon-model-'));let installer;
  t.after(async()=>{try{await installer?.close();}finally{await rm(root,{recursive:true,force:true});}});
  const directory=join(root,'packages');await mkdir(directory,{mode:0o700});let now=Date.parse('2026-11-27T12:00:00Z');
  const fx=await activationFixture(root,{clock:()=>now}),activation=await createModuleActivation(fx.options),publisher=generateKeyPairSync('ed25519'),publisherKey=join(root,'publisher-public.pem');
  await writeFile(publisherKey,publisher.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const id='fictional-model',permissions=['settings','service.runtime','workspace.read','workspace.write','workspace.write.auto'],owner={id:'fictional-owner',authVersion:1},authorize=()=>owner;
  await activation.activate(fx.mint({licenseId:'a'.repeat(32),issuedAt:now/1000,expiresAt:now/1000+3600,addons:[{id,minRevision:1,maxRevision:8,permissions}]}),authorize);
  const writes=[],instances=[];
  const simulatedSupervisor=async options=>{
    const model=JSON.parse(await readFile(join(options.payloadDirectory,'model.json'),'utf8'));if(!model.healthy)throw Error('SIMULATED unhealthy startup.');
    const instance={closed:false,async health(){if(this.closed)throw Error('SIMULATED closed.');return true;},async invoke(value){if(this.closed)throw Error('SIMULATED closed.');if(value.op==='broker')return options.request(value.operation,value.input);return value.value+model.increment;},async close(){this.closed=true;},protection:{simulated:true}};instances.push(instance);return instance;
  };
  const workspaceBridge=async(op,input,{approval,addonId})=>{assert.deepEqual(approval,owner);assert.equal(addonId,id);if(op==='workspace.write'){writes.push(structuredClone(input));return {modelWrite:writes.length};}return {modelRead:true};};
  const launch=async()=>{assert.equal(installer,undefined);installer=await createAddonInstaller({directory,publisherKey,activationDirectory:fx.options.directory,activation,serviceStart:simulatedSupervisor,workspaceBridge,monitorMs:60000});const state=await installer.status();assert.equal(state.configured,true,state.reason);await installer.restore();};
  const stop=async()=>{const active=installer;installer=undefined;await active?.close();};
  const encode=content=>{const bytes=Buffer.from(content);return {sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('base64url')};};
  const stage=async(revision,{healthy=true,increment=revision,name='Fictional model'}={})=>{
    const manifest={format:'firmquill.addon.v1',id,name,revision,installationId:fx.id,compatibility:{min:'0.6.5',max:'0.6.5',hostApi:1},type:'service',permissions,network:[],settings:[],
      files:{'service.mjs':encode("// MODEL ONLY: executing this package is forbidden.\nthrow Error('MODEL_PACKAGE_MUST_NEVER_EXECUTE');\n"),'model.json':encode(JSON.stringify({healthy,increment}))}};
    const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(directory,'model.fqaddon'),JSON.stringify({signed:bytes.toString('base64url'),signature:sign(null,bytes,publisher.privateKey).toString('base64url')}),{mode:0o600});
  };
  const apply=async()=>{const review=await installer.review();return installer.apply({id,receipt:review.receipt,confirm:true},authorize);};
  const item=async()=> (await installer.status()).installed.find(p=>p.id===id);
  const invoke=value=>installer.invoke({id,value},authorize);
  await launch();await stage(1);await apply();assert.equal((await item()).status,'active');assert.deepEqual(await invoke({value:5}),{value:6});
  assert.deepEqual(await invoke({op:'broker',operation:'workspace.read',input:{path:'/api/session'}}),{value:{modelRead:true}});
  const staged=await invoke({op:'broker',operation:'workspace.write',input:{path:'/api/action',body:{fixture:'manual proposal'}}});assert.equal(staged.value.status,'pending-owner-approval');assert.equal(writes.length,0);
  const proposal=(await item()).writeProposals.find(p=>p.id===staged.value.proposalId),approval={id,proposalId:proposal.id,digest:proposal.digest,confirm:true};
  await assert.rejects(()=>installer.approveWrite({...approval,confirm:false},authorize));await assert.rejects(()=>installer.approveWrite({...approval,digest:'0'.repeat(64)},authorize));
  await installer.approveWrite(approval,authorize);assert.equal(writes.length,1);await assert.rejects(()=>installer.approveWrite(approval,authorize));assert.equal(writes.length,1);
  await assert.rejects(()=>installer.writePolicy({id,autoApproveWrites:true,confirm:false},authorize));await installer.writePolicy({id,autoApproveWrites:true,confirm:true},authorize);
  const automatic=await invoke({op:'broker',operation:'workspace.write',input:{path:'/api/action',body:{fixture:'automatic proposal'}}});assert.equal(automatic.value.status,'complete');assert.equal(writes.length,2);
  await stage(2,{healthy:false});await apply();assert.equal((await item()).pendingRestart,true);assert.deepEqual(await invoke({value:7}),{value:8});
  await assert.rejects(()=>installer.restart({id,confirm:false},authorize));await installer.restart({id,confirm:true},authorize);assert.equal((await item()).revision,1);assert.equal((await item()).status,'rolled-back');assert.deepEqual(await invoke({value:7}),{value:8});
  await stage(1);assert.equal((await installer.review()).candidates[0].eligible,false);await stage(2,{name:'Conflicting model revision'});assert.equal((await installer.review()).candidates[0].eligible,false);
  await stage(3);await apply();await installer.restart({id,confirm:true},authorize);assert.equal((await item()).revision,3);assert.deepEqual(await invoke({value:7}),{value:10});
  for(const name of await readdir(directory))await unlink(join(directory,name));await stop();await launch();assert.equal((await item()).revision,3);assert.deepEqual(await invoke({value:9}),{value:12});
  const before=writes.length;now+=3600000;assert.equal((await item()).status,'license-required');await assert.rejects(()=>invoke({op:'broker',operation:'workspace.write',input:{path:'/api/action',body:{fixture:'must not dispatch'}}}));assert.equal(writes.length,before);assert.ok(instances.every(service=>service.closed));
  await assert.rejects(()=>installer.remove({id,confirm:false},authorize));
  let revoked;
  await installer.remove({id,confirm:true},authorize,value=>{revoked=value;});
  assert.equal(revoked,id);
  await stop();await launch();
  assert.equal(await item(),undefined);
  assert.deepEqual(installer.adminPages(),[]);
  now-=3600000;
  await stage(2);assert.equal((await installer.review()).candidates[0].eligible,false);
  await stage(3);await apply();
  assert.equal((await item()).writeMode,'review');
  assert.equal((await item()).writeProposals.length,0);
});
