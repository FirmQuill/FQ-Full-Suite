import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModuleActivation} from '../module-activation.mjs';
import {activationFixture} from './fixture-activation.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {createSuite} from '../server.mjs';
import {openStore,saveBooks,putUser,passwordHash} from '../store.mjs';
import {newVault} from '../shared/core.mjs';

const second=Date.parse('2026-11-27T12:00:00Z')/1000;
const grant=(fields={})=>({id:'fictional-settings',minRevision:2,maxRevision:4,permissions:['settings'],...fields});
const dated=(fields={})=>({licenseId:'a'.repeat(32),issuedAt:second,expiresAt:second+3600,addons:[grant()],...fields});
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'fq-addon-license-')),cleanup=[];t.after(async()=>{for(const close of cleanup)await close();await rm(root,{recursive:true,force:true});});
  let now=second*1000;const fx=await activationFixture(root,{clock:()=>now}),app=await createModuleActivation(fx.options);
  return {root,fx,app,cleanup:close=>cleanup.push(close),advance:ms=>{now+=ms;}};
}

test('add-on-only signed licenses require a modules array but do not need a legacy module marker',async t=>{
  const x=await setup(t);
  for(const fields of [{modules:[]},{...dated(),modules:undefined},{...dated(),modules:null},{...dated(),modules:[],addons:[]},{...dated(),modules:[],addons:null}])await assert.rejects(()=>x.app.activate(x.fx.mint(fields),()=>{}),{status:400});
  const code=x.fx.mint(dated({modules:[]})),result=await x.app.activate(code,()=>{});
  assert.ok(Object.values(result.modules).every(active=>active===false));assert.deepEqual(result.addons,[grant()]);assert.equal(x.app.addonAllows('fictional-settings',2,['settings']),true);
  assert.equal(x.app.allows('manual-payroll'),false);assert.ok(x.app.renewalNotice());
  assert.equal((await createModuleActivation(x.fx.options)).addonAllows('fictional-settings',4,['settings']),true);
});

test('signed add-on grants bind installation, revision range, permissions and live expiry without exposing mutable grants',async t=>{
  const x=await setup(t),code=x.fx.mint(dated());
  assert.deepEqual(x.app.addonGrants(),[]);assert.equal(x.app.addonAllows('fictional-settings',2,['settings']),false);
  await x.app.activate(code,()=>{});
  for(const revision of [2,3,4])assert.equal(x.app.addonAllows('fictional-settings',revision,['settings']),true);
  for(const revision of [1,5,0,-1,2.5,Number.MAX_SAFE_INTEGER+1])assert.equal(x.app.addonAllows('fictional-settings',revision,['settings']),false);
  assert.equal(x.app.addonAllows('fictional-settings',2,[]),true);
  for(const permissions of [['service.runtime'],['network.https'],['workspace.read'],['workspace.write'],['workspace.write.auto'],['firmquill.read'],['service.compute'],['network'],['settings','settings'],'settings',null])assert.equal(x.app.addonAllows('fictional-settings',2,permissions),false);
  assert.equal(x.app.addonAllows('fictional-other',2,['settings']),false);
  assert.deepEqual(x.app.status().addons,[grant()]);assert.equal(x.app.status().paidScopePresent,true);
  assert.throws(()=>x.app.addonGrants()[0].permissions.push('service.runtime'),TypeError);
  assert.throws(()=>{x.app.status().addons[0].maxRevision=100;},TypeError);
  assert.deepEqual((await createModuleActivation(x.fx.options)).addonGrants(),[grant()]);
  await assert.rejects(()=>x.app.activate(x.fx.mint(dated({installationId:'0'.repeat(64)})),()=>{}),{status:400});
  x.advance(3600000);
  assert.deepEqual(x.app.addonGrants(),[]);assert.deepEqual(x.app.status().addons,[]);
  assert.equal(x.app.addonAllows('fictional-settings',2,['settings']),false);
  assert.equal(x.app.status().modules['manual-payroll'],false);
});

test('add-on license schema rejects missing freshness fields, malformed grants and unknown or duplicate permissions',async t=>{
  const x=await setup(t),bad=[
    {addons:[]},{addons:null},{addons:{}},{addons:[grant(),grant()]},
    {licenseId:undefined},{issuedAt:undefined},{expiresAt:undefined},
    {licenseId:'not-a-license'},{issuedAt:1.5},{expiresAt:second},
    ...[null,[],{},grant({extra:true}),grant({id:'UPPER'}),grant({id:'ab'}),grant({id:'a'.repeat(65)}),
      grant({minRevision:0}),grant({maxRevision:Number.MAX_SAFE_INTEGER+1}),grant({minRevision:5}),grant({permissions:null}),grant({permissions:['unknown']}),grant({permissions:['service.compute']}),grant({permissions:['settings','settings']}),grant({permissions:['settings','service.runtime','settings']})].map(g=>({addons:[g]})),
    {addons:Array.from({length:17},(_,i)=>grant({id:'fictional-'+i}))}
  ];
  for(const fields of bad){await assert.rejects(()=>x.app.activate(x.fx.mint(dated(fields)),()=>{}),{status:400},JSON.stringify(fields));assert.deepEqual(x.app.addonGrants(),[]);}
  const grants=Array.from({length:16},(_,i)=>grant({id:i===0?'full-suite-knowledge-base':i===1?'payroll-rule-template':'a'+String(i).padStart(2,'0')+'x'.repeat(61),minRevision:Number.MAX_SAFE_INTEGER,maxRevision:Number.MAX_SAFE_INTEGER,permissions:['settings','service.runtime','network.https','workspace.read','workspace.write','workspace.write.auto']}));
  const largest=x.fx.mint(dated({addons:grants}));assert.ok(largest.length>4096,'Full supported grant count exercises expanded signed-file bound.');
  await x.app.upload(largest,()=>{});assert.equal(x.app.addonGrants().length,16);
  assert.equal(x.app.addonAllows(grants[0].id,Number.MAX_SAFE_INTEGER,['service.runtime','network.https','workspace.read','workspace.write','workspace.write.auto']),true);
});

test('an exact client route belongs to one licensed service revision and cannot claim a host route',async t=>{
  const x=await setup(t);
  const permissions=['settings','service.runtime','service.controls','route:/fictional/status','route:/api/addons/fictional-panel'];
  const assigned=grant({permissions});
  for(const reserved of ['/api/session','/api/addons/controls','/api/addons/apply','/shared/app.mjs','/audit','/fictional/*']){
    await assert.rejects(()=>x.app.activate(x.fx.mint(dated({addons:[grant({permissions:['route:'+reserved]})]})),()=>{}),{status:400});
  }
  const other=grant({id:'fictional-other',permissions:['route:/fictional/status']});
  await assert.rejects(()=>x.app.activate(x.fx.mint(dated({addons:[assigned,other]})),()=>{}),{status:400});
  await x.app.activate(x.fx.mint(dated({addons:[assigned]})),()=>{});
  assert.equal(x.app.addonAllows(assigned.id,2,permissions),true);
  assert.equal(x.app.addonAllows(other.id,2,permissions),false);
  assert.equal(x.app.addonAllows(assigned.id,1,permissions),false);
  assert.equal(x.app.addonAllows(assigned.id,2,['route:/fictional/other']),false);
  x.advance(3600000);
  assert.equal(x.app.addonAllows(assigned.id,2,permissions),false);
});

test('all activation entry points reject stale, undated and conflicting add-on replacement even after old grant expires',async t=>{
  const x=await setup(t),original=x.fx.mint(dated());await x.app.activate(original,()=>{});
  const filename=join(x.fx.options.directory,'active-entitlement.fqlicense');
  const rejected=[x.fx.mint(),x.fx.mint(dated({issuedAt:second-1})),x.fx.mint(dated({addons:[grant({maxRevision:5})]})),x.fx.mint({issuedAt:second,expiresAt:second+3600})];
  for(const method of ['activate','upload'])for(const code of rejected){await assert.rejects(()=>x.app[method](code,()=>{}),{status:409});assert.equal(await readFile(filename,'utf8'),original);}
  await x.app.activate(original,()=>{});await x.app.upload(original,()=>{});
  x.advance(3600000);
  await assert.rejects(()=>x.app.activate(x.fx.mint(),()=>{}),{status:409});
  await assert.rejects(()=>x.app.upload(x.fx.mint(dated({issuedAt:second-1,expiresAt:second+7200})),()=>{}),{status:409});
  await x.app.activate(x.fx.mint(dated({issuedAt:second+3600,expiresAt:second+7200,licenseId:'b'.repeat(32),addons:[grant({maxRevision:6})]})),()=>{});
  assert.equal(x.app.addonAllows('fictional-settings',6,['settings']),true);
});

test('add-on freshness guards respect earlier dated legacy licenses while legacy-only direct replacements remain unchanged',async t=>{
  const x=await setup(t);
  await x.app.activate(x.fx.mint({issuedAt:second+1,expiresAt:second+3600}),()=>{});
  await assert.rejects(()=>x.app.activate(x.fx.mint(dated()),()=>{}),{status:409});
  await x.app.activate(x.fx.mint(),()=>{});
  await x.app.activate(x.fx.mint(dated()),()=>{});
  await assert.rejects(()=>x.app.activate(x.fx.mint(),()=>{}),{status:409});
  await x.app.activate(x.fx.mint({issuedAt:second+1,expiresAt:second+3600}),()=>{});
  assert.deepEqual(x.app.addonGrants(),[]);
  await x.app.activate(x.fx.mint(),()=>{});
  assert.equal(x.app.allows('manual-payroll'),true);
});

test('owner direct activation HTTP endpoint cannot bypass add-on freshness checks used by upload',async t=>{
  const x=await setup(t),database=join(x.root,'fictional.sqlite'),password='Fictional add-on license API verification.';
  const db=openStore(database);try{saveBooks(db,newVault('Fictional add-on license books'));putUser(db,null,{username:'owner',name:'Fictional owner',role:'owner',assignments:[]},await passwordHash(password),{bootstrap:true});}finally{db.close();}
  const suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions:x.fx.options});x.cleanup(()=>suite.close());
  let cookie,csrf;
  const post=async(path,body)=>{const r=await fetch(suite.mainUrl+'/api/'+path,{method:'POST',headers:{Origin:suite.mainUrl,'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const login=await post('login',{username:'owner',password});assert.equal(login.status,200);cookie=login.cookie;csrf=login.body.csrf;
  assert.equal((await post('terms',fixtureAgreement)).status,200);
  const code=x.fx.mint(dated());assert.equal((await post('module-activation/upload',{fileName:'fictional.fqlicense',code})).status,200);
  for(const stale of [x.fx.mint(),x.fx.mint(dated({issuedAt:second-1})),x.fx.mint(dated({addons:[grant({maxRevision:9})]}))])assert.equal((await post('module-activation',{code:stale})).status,409);
  assert.equal(await readFile(join(x.fx.options.directory,'active-entitlement.fqlicense'),'utf8'),code);
});
