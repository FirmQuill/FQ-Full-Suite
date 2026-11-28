import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {activationFixture} from './fixture-activation.mjs';

const pass='Only a fictional package QA password.', sum=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{existing=false}={}){
 const root=await mkdtemp(join(tmpdir(),'fq-drop-folder-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'app');await buildPublicRelease(runtime);
 const app=n=>import(pathToFileURL(join(runtime,n)));
 const {openStore,saveBooks,putUser,passwordHash}=await app('store.mjs'),{newVault}=await app('shared/core.mjs');
 const database=join(root,'books.sqlite'),db=openStore(database);
 try{
  if(existing)saveBooks(db,newVault('Fictional retained owner books'));
  const passwordHashFixture=await passwordHash(pass);
  putUser(db,null,{username:'owner',name:'Fictional QA owner',role:'owner',assignments:[]},passwordHashFixture,{bootstrap:true});
  if(existing)putUser(db,null,{username:'manager',name:'Fictional manager',role:'manager',assignments:[]},passwordHashFixture,{bootstrap:true});
 }finally{db.close();}
 const key=generateKeyPairSync('ed25519'),verifierPath=join(root,'publisher-public.pem');
 await writeFile(verifierPath,key.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 const directory=join(runtime,'packages');await mkdir(directory,{mode:0o700,recursive:true});
 const input=join(directory,'documentation.fqpackage');
 let time=Date.now();const license=await activationFixture(root,{clock:()=>time});
 const state=join(license.options.directory,'manual-package-admission.v1.json');
 const draft=(version=1,body='# Fictional QA article\n\nFictional guide text.')=>{
  const files={'index.json':JSON.stringify({version:'0.6.5',scope:'private-customer-manual',articles:[{id:'sample',file:'sample.md',title:'Fictional QA guide',status:'verified-local',keywords:['fixture']}]}),'sample.md':body};
  return {format:'firmquill.manual-package.v1',id:'full-suite-knowledge-base',type:'knowledge-base',version,runtime:'0.6.5',installationId:license.id,entitlement:'private-support',files,hashes:Object.fromEntries(Object.entries(files).map(([n,s])=>[n,sum(s)]))};
 };
 async function stage(body,{signatureKey=key.privateKey,path=input}={}){
  const raw=Buffer.from(JSON.stringify(body)),e={signed:raw.toString('base64url'),signature:sign(null,raw,signatureKey).toString('base64url')};
  await writeFile(path,JSON.stringify(e),{mode:0o600});
 }
 return {root,runtime,app,database,license,verifierPath,directory,input,state,draft,stage,time:value=>{if(value!==undefined)time=value;return time;}};
}

async function client(base,username='owner'){
 let cookie,csrf;
 const req=async(path,data)=>{
  const r=await fetch(base+'/api/'+path,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 };
 const login=await req('login',{username,password:pass});assert.equal(login.status,200);cookie=login.cookie;csrf=login.data.csrf;
 if(login.data.termsRequired)assert.equal((await req('terms',fixtureAgreement)).status,200);
 return req;
}
const kb='full-suite-knowledge-base', payrollId='payroll-rule-template';
async function reviewApply(req,ids){
 const r=await req('package-folder');assert.equal(r.status,200);assert.equal(r.data.status,'review');
 assert.match(r.data.receipt,/^[a-f0-9]{64}$/);
 const chosen=ids??r.data.candidates.filter(p=>p.eligible).map(p=>p.id);
 const apply=await req('package-folder',{receipt:r.data.receipt,ids:chosen,confirm:true});assert.equal(apply.status,200,JSON.stringify(apply.data));
 return r.data;
}
test('real Node host uses .\\packages for owner-confirmed hot apply, then restores exactly accepted bytes after restart',async t=>{
 const x=await fixture(t);await x.stage(x.draft());
 const pair=await Promise.all([0,1].map(async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server;}));
 const [main,worker]=pair.map(s=>s.address().port);await Promise.all(pair.map(s=>new Promise(resolve=>s.close(resolve))));
 async function host(run){
  const child=spawn(process.execPath,['host.mjs','start'],{cwd:x.runtime,env:{...process.env,FIRMQUILL_DB:x.database,FIRMQUILL_MAIN_ORIGIN:'',FIRMQUILL_WORKER_ORIGIN:'',FIRMQUILL_MAIN_PORT:String(main),FIRMQUILL_WORKER_PORT:String(worker),FIRMQUILL_PACKAGES_DIR:'',FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY:x.verifierPath,FIRMQUILL_MODULE_INSTALL_DIR:x.license.options.directory,FIRMQUILL_ENTITLEMENT_PUBLIC_KEY:x.license.options.verifierPath},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const done=once(child,'exit');let out='';child.stdout.on('data',b=>out+=b);
  try{
   for(let i=0;i<100&&!out.includes('FirmQuill Worker');i++){assert.equal(child.exitCode,null);await new Promise(r=>setTimeout(r,35));}
   assert.match(out,/FirmQuill Worker/);await run(await client('http://127.0.0.1:'+main));
  }finally{child.kill('SIGTERM');await done;}
 }
 await host(async req=>{
  assert.equal((await req('support/article?id=sample')).status,404);
  assert.deepEqual((await req('module-activation')).data.upgrade,{status:'partial',reason:'missing-license'});
  await assert.rejects(stat(x.state),{code:'ENOENT'});
  assert.deepEqual((await req('module-activation/upload',{fileName:'signed.fqlicense',code:x.license.mint({modules:['private-support']})})).data.upgrade,{status:'partial',reason:'missing-packages'});
  assert.equal((await req('support/article?id=sample')).status,503,'license alone does not apply a package');
  const review=(await req('package-folder')).data;assert.deepEqual(review.candidates,[{id:kb,type:'knowledge-base',version:1,eligible:true,reason:'review-required'}]);
  assert.equal((await req('package-folder',{receipt:review.receipt,ids:[kb],confirm:false})).status,400);
  await assert.rejects(stat(x.state),{code:'ENOENT'});
  await reviewApply(req,[kb]);assert.deepEqual((await req('module-activation')).data.upgrade,{status:'complete'});assert.match((await req('support/article?id=sample')).data.body,/Fictional guide text/);
 });
 await host(async req=>{
  assert.match((await req('support/article?id=sample')).data.body,/Fictional guide text/);
  assert.equal((await req('support/article?id=sample&scope=public')).status,404);
  assert.equal((await req('support/info?scope=public')).data.scope,'public-setup-only');
 });
 assert.equal(JSON.parse(await readFile(x.state,'utf8')).packages['full-suite-knowledge-base'].version,1);
});

test('packaged app denies wrong scope and rollback, preserves signed state and existing company, rechecks live expiry',async t=>{
 const x=await fixture(t,{existing:true});
 const {createSuite}=await x.app('server.mjs'),expires=Math.floor(x.time()/1000)+240;
 const launch=async callback=>{
  const host=await createSuite({database:x.database,mainPort:0,workerPort:0,activationOptions:x.license.options,supportOptions:{packageFolder:{directory:x.directory,verifierPath:x.verifierPath}}});
  try{await callback(await client(host.mainUrl),await client(host.mainUrl,'manager'));}finally{await host.close();}
 };
 const absent=async req=>{assert.notEqual((await req('support/article?id=sample')).status,200);
  assert.equal((await req('support/info')).data.scope,'public-setup-only');
  assert.equal((await req('session')).data.state.companies[0].name,'Fictional retained owner books');
 };
 const valid=x.draft(2);
 await x.stage(valid);
 await launch(async r=>{await absent(r);assert.equal((await r('module-activation',{code:x.license.mint({modules:['manual-payroll']})})).status,200);});
 await launch(async r=>{await absent(r);assert.equal((await r('module-activation',{code:x.license.mint({modules:['private-support'],expiresAt:expires})})).status,200);});
 // A valid license cannot admit an invalid drop or advance the revision.
 for(const d of [{...valid,runtime:'0.0.0'},{...valid,installationId:'0'.repeat(64)},{...valid,entitlement:'manual-payroll'},{...valid,id:'other-addon'}, {...valid,type:'other-type'}, {...valid,hashes:{...valid.hashes,'sample.md':'0'.repeat(64)}}]){
  await x.stage(d);await launch(absent);await assert.rejects(stat(x.state),{code:'ENOENT'});
 }
 await x.stage(valid,{signatureKey:generateKeyPairSync('ed25519').privateKey});await launch(absent);await assert.rejects(stat(x.state),{code:'ENOENT'});
 await x.stage(valid);const conflict=join(x.directory,'duplicate.fqpackage');await x.stage(valid,{path:conflict});await launch(absent);await rm(conflict);
 await launch(async (r,manager)=>{
  await absent(r);
  const before=await r('package-folder');assert.equal((await manager('package-folder')).status,403);
  assert.equal((await manager('package-folder',{receipt:before.data.receipt,ids:[kb],confirm:true})).status,403);
  assert.equal((await r('package-folder',{receipt:'0'.repeat(64),ids:[kb],confirm:true})).status,409);
  await x.stage(x.draft(3,'# Candidate changed since review'));
  assert.equal((await r('package-folder',{receipt:before.data.receipt,ids:[kb],confirm:true})).status,409);
  await assert.rejects(stat(x.state),{code:'ENOENT'});
  await x.stage(valid);
  await reviewApply(r,[kb]);assert.equal((await r('support/article?id=sample')).status,200);
 });
 const accepted=await readFile(x.state,'utf8');assert.equal(JSON.parse(accepted).packages['full-suite-knowledge-base'].version,2);
 for(const d of [x.draft(1),x.draft(2,'# Changed same version')]){
  await x.stage(d);await launch(absent);assert.equal(await readFile(x.state,'utf8'),accepted);
 }
 await x.stage(valid);
 await launch(async r=>{assert.equal((await r('support/article?id=sample')).status,200);x.time(expires*1000);await absent(r);});
 const saved=await readFile(x.state,'utf8');assert.equal(saved,accepted);
 await launch(absent);
});

test('two drop IDs obey separate explicitly signed claims; reviewed typed payroll import rechecks expiry',async t=>{
 const x=await fixture(t,{existing:true}),{createSuite}=await x.app('server.mjs');
 const start=Math.floor(x.time()/1000),expiresAt=start+240;
 const one=x.draft(1),other=join(x.directory,'payroll-rules.fqpackage');
 const rule={templateId:'fixture-one',revision:1,label:'Fictional example rate',provenance:'Synthetic testing only. Not a tax rate.',rule:{key:'fixture-one',name:'Fictional test only',effective:'2027-01-01',side:'employee',method:'percentage',rate:10000,jurisdiction:'Fictional testing',wageBasis:'all'}};
 const raw=JSON.stringify({version:1,templates:[rule]});
 const payroll={...one,id:'payroll-rule-template',type:'payroll-rule-template',entitlement:'payroll-rule-template',files:{'templates.json':raw},hashes:{'templates.json':sum(raw)}};
 await x.stage(one);await x.stage(payroll,{path:other});
 const launch=async fn=>{
  const host=await createSuite({database:x.database,mainPort:0,workerPort:0,activationOptions:x.license.options,supportOptions:{packageFolder:{directory:x.directory,verifierPath:x.verifierPath}}});
  try{const r=await client(host.mainUrl),company=(await r('session')).data.state.companies[0].id;await fn(r,company);}finally{await host.close();}
 };
 const history=async()=>JSON.parse(await readFile(x.state,'utf8')).packages;
 await launch(async (r,c)=>{
  assert.equal((await r('module-activation',{code:x.license.mint({modules:['payroll-rule-template']})})).status,400,'payroll templates require a finite term');
  assert.equal((await r('module-activation',{code:x.license.mint({modules:['private-support']})})).status,200);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false});
 });
 await launch(async(r,c)=>{
  assert.notEqual((await r('support/article?id=sample')).status,200);
  const scope=(await r('package-folder')).data;
  assert.ok(scope.candidates.some(p=>p.id===payrollId&&!p.eligible&&p.reason==='license-required'));
  assert.equal((await r('package-folder',{receipt:scope.receipt,ids:[payrollId],confirm:true})).status,409);
  await reviewApply(r,[kb]);assert.equal((await r('support/article?id=sample')).status,200);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false});
  assert.deepEqual(Object.keys(await history()),[kb]);
  assert.equal((await r('module-activation',{code:x.license.mint({modules:['payroll-rule-template'],expiresAt})})).status,200);
  assert.equal((await r('support/article?id=sample')).status,404);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false},'new license does not apply formerly unentitled data by itself');
 });
 await launch(async(r,c)=>{
  assert.equal((await r('support/article?id=sample')).status,404);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false});
  await reviewApply(r,[payrollId]);
  const draft=(await r('payroll-rule-templates?companyId='+c)).data;assert.equal(draft.enabled,true);assert.equal(draft.templates[0].label,rule.label);
  const before=(await r('manual-payroll?companyId='+c)).data.data;
  assert.equal(before.rules.length,0);
  const request={companyId:c,payrollRevision:draft.payrollRevision,packageVersion:draft.packageVersion,packageDigest:draft.packageDigest,selected:[{id:rule.templateId,revision:rule.revision}],confirm:true};
  assert.equal((await r('payroll-rule-templates?companyId='+c,{...request,confirm:false})).status,400);
  assert.equal((await r('payroll-rule-templates?companyId='+c,request)).status,200);
  const after=(await r('manual-payroll?companyId='+c)).data.data;
  assert.equal(after.rules.length,1);assert.equal(after.rules[0].key,'fixture-one');assert.deepEqual(after.runs,before.runs);
  assert.equal((await r('payroll-rule-templates?companyId='+c,request)).status,409);
  const stale=(await r('payroll-rule-templates?companyId='+c)).data;
  x.time(expiresAt*1000);
  assert.equal((await r('payroll-rule-templates?companyId='+c,{...request,payrollRevision:stale.payrollRevision})).status,403);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false});
  assert.equal((await r('manual-payroll?companyId='+c)).data.data.rules.length,1);
  assert.deepEqual(Object.keys(await history()).sort(),['full-suite-knowledge-base','payroll-rule-template']);
  assert.equal((await r('module-activation',{code:x.license.mint({modules:['private-support','payroll-rule-template'],expiresAt:expiresAt+180})})).status,200);
 });
 await launch(async(r,c)=>{
  assert.equal((await r('support/article?id=sample')).status,200);
  assert.equal((await r('payroll-rule-templates?companyId='+c)).data.templates[0].conflict,true);
 });
 // A later signed revision is displayed, not applied or recorded at boot.
 await x.stage(x.draft(2,'# Owner-reviewed second revision'));
 await launch(async(r,c)=>{
  assert.notEqual((await r('support/article?id=sample')).status,200);
  assert.equal((await r('payroll-rule-templates?companyId='+c)).data.enabled,true);
  assert.equal((await history())[kb].version,1);
  await reviewApply(r,[kb]);
  assert.match((await r('support/article?id=sample')).data.body,/second revision/);
  assert.equal((await r('payroll-rule-templates?companyId='+c)).data.enabled,true);
 });
 const good=await readFile(x.state,'utf8');await x.stage(x.draft(2));await x.stage({...payroll,version:1,hashes:{'templates.json':'0'.repeat(64)}},{path:other});
 await launch(async(r,c)=>{
  assert.notEqual((await r('support/article?id=sample')).status,200);
  assert.deepEqual((await r('payroll-rule-templates?companyId='+c)).data,{enabled:false});
  assert.deepEqual((await r('module-activation')).data.upgrade,{status:'partial',reason:'package-error'});
 });
 assert.equal(await readFile(x.state,'utf8'),good,'no revision entered state when any entitled drop was invalid');
});
