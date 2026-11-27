import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,chmod,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activationFixture} from './fixture-activation.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';
import {createModuleActivation,edition} from '../module-activation.mjs';
import {createSuite} from '../server.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash,readBooks} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {INSTALLED_VERSION} from '../support.mjs';
import {inspectLite} from '../transfer.mjs';

const pass='Synthetic activation password no live records';
const day=Date.parse('2026-11-27T12:00:00Z'),second=day/1000;
const folder=async t=>{const path=await mkdtemp(join(tmpdir(),'fq-module-test-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;};
test('offline verification: invalid bits, wrong signer/install/edition/module, time windows, persistence and no public-key provisioning fallback',async t=>{
 const root=await folder(t),alternate=await folder(t),foreign=await folder(t);let now=day;
 const fx=await activationFixture(root,{clock:()=>now}),other=await activationFixture(alternate),anotherIssuer=await activationFixture(foreign);
 const app=await createModuleActivation(fx.options);
 const neither={'manual-payroll':false,'private-support':false};
 const cryptoReject=async(code)=>{await assert.rejects(()=>app.activate(code,()=>{}),/invalid for this Full Suite installation/);assert.deepEqual(app.status().modules,neither);};
 assert.ok(app.status().configured);assert.deepEqual(app.status().modules,neither);
 await cryptoReject(anotherIssuer.mint({installationId:fx.id}));await cryptoReject(fx.mint({installationId:other.id}));
 for(const fields of [{edition:'firmquill-lite'},{modules:['bank-feed']},{modules:['manual-payroll','manual-payroll']},{modules:[]},{unexpected:true},{notBefore:second,expiresAt:second},{licenseId:'not-a-valid-id'},{issuedAt:1.5},{issuedAt:second,expiresAt:second}])await cryptoReject(fx.mint(fields));
 const code=fx.mint();const [a,b]=code.split('.');
 await cryptoReject(a+'.'+(b[0]==='a'?'b':'a')+b.slice(1));
 for(const fields of [{expiresAt:second},{notBefore:second+1}])await assert.rejects(()=>app.activate(fx.mint(fields),()=>{}),/expired or is not yet valid/);
 assert.equal((await app.activate(fx.mint({expiresAt:second+10,issuedAt:second,licenseId:'b'.repeat(32)}),()=>{})).modules['manual-payroll'],true);
 assert.equal((await createModuleActivation(fx.options)).allows('manual-payroll'),true);
 assert.equal(app.renewalNotice(),null,'A legacy Manual Payroll marker alone must not prompt to renew');
 assert.equal(app.allows('private-support'),false);
 now+=10000;
 assert.equal(app.status().status,'expired');assert.deepEqual(app.status().modules,neither);
 assert.equal((await createModuleActivation(fx.options)).status().status,'expired');
 assert.equal((await createModuleActivation()).status().configured,false);
 if(process.platform!=='win32'){await chmod(fx.options.verifierPath,0o666);assert.equal((await createModuleActivation(fx.options)).status().configurationIssue,true);await chmod(fx.options.verifierPath,0o600);}
 await writeFile(join(fx.options.directory,'active-entitlement.fqlicense'),'bad');
 assert.equal((await createModuleActivation(fx.options)).status().status,'invalid saved activation');
});
async function setup(t){
 const root=await folder(t),database=join(root,'fictional.sqlite');let now=day;
 const fx=await activationFixture(root,{clock:()=>now});
 const state=sampleVault(),company=state.companies[0],other=state.companies[1],employee=company.employees[0];
 const legacy=join(root,'fictional-legacy'),contextual=join(root,'fictional-context');
 await mkdir(legacy);await mkdir(contextual);
 await writeFile(join(legacy,'index.json'),JSON.stringify({version:INSTALLED_VERSION,scope:'private-customer-manual',articles:[{id:'activation-fixture',file:'fixture.md',title:'Fixture help',status:'verified-local',keywords:['fixture']}] }));
 await writeFile(join(legacy,'fixture.md'),'PRIVATE_SYNTHETIC_HELP_ONLY');
 await writeFile(join(contextual,'contextual-index.json'),JSON.stringify({format:'firmquill.contextual-support.v1',edition:'full-suite',version:INSTALLED_VERSION,articles:[{portal:'main',page:'Directory',roles:['owner'],companyIds:[company.id],title:'Fictional support',file:'fictional.txt'}]}));
 await writeFile(join(contextual,'fictional.txt'),'PRIVATE_SYNTHETIC_CONTEXT_ONLY');
 const db=openStore(database),hash=await passwordHash(pass);
 try{tx(db,()=>{
  saveBooks(db,state);
  for(const [role,source] of [['owner',company],['manager',company],['payroll',company],['worker',company],['out-of-company',other]]){
   putUser(db,null,{username:'fixture-'+role,name:'Fixture '+role,role:role==='out-of-company'?'payroll':role,assignments:role==='owner'?[]:[source.id],...(role==='worker'?{employeeId:employee.id}:{})},hash,{bootstrap:true});
  }
 });}finally{db.close();}
 const launch=()=>createSuite({database,mainPort:0,workerPort:0,supportOptions:{documentationRoot:legacy,contextualRoot:contextual},activationOptions:fx.options});
 let suite=await launch();t.after(()=>suite.close());
 return {fx,company,employee,state,database,advance:n=>{now+=n;},get suite(){return suite;},async restart(){await suite.close();suite=await launch();}};
}
async function request(origin,route,{session,body}={}){
 const res=await fetch(origin+'/api/'+route,{method:body?'POST':'GET',headers:{...(session?{cookie:session.cookie}:{}),...(body?{origin,'content-type':'application/json','x-csrf-token':session?.csrf||''}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const type=res.headers.get('content-type')||'';
 return {status:res.status,type,result:type.includes('json')?await res.json():await res.text(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function login(origin,role,consent=true){
 const r=await request(origin,'login',{body:{username:'fixture-'+role,password:pass}});assert.equal(r.status,200);
 const session={cookie:r.cookie,csrf:r.result.csrf};
 if(consent)assert.equal((await request(origin,'terms',{session,body:fixtureAgreement})).status,200);
 return session;
}
test('live endpoints keep employer-entered payroll available before activation and after expiration while paid support stays gated',async t=>{
 const x=await setup(t);
 let {mainUrl,workerUrl}=x.suite;
 let owner=await login(mainUrl,'owner',false),worker=await login(workerUrl,'worker');
 const payroll=await login(mainUrl,'payroll'),other=await login(mainUrl,'out-of-company'),manager=await login(mainUrl,'manager');
 const route='manual-payroll?companyId='+x.company.id,legacy='support/article?id=activation-fixture',context='support/context?page=Directory&companyId='+x.company.id;
 const get=(name,session=owner)=>request(mainUrl,name,{session});
 const post=(name,body,session=owner)=>request(mainUrl,name,{session,body});
 assert.equal((await get('module-activation')).status,428);await post('terms',fixtureAgreement);
 assert.equal((await get('module-activation',manager)).status,403);
 assert.equal((await request(workerUrl,'module-activation',{session:worker})).status,404);
 assert.equal(Object.hasOwn((await get('session')).result,'moduleRenewal'),false);
 const status=await get('module-activation');assert.equal(status.result.edition,edition);assert.equal(status.result.installationId,x.fx.id);
 assert.equal((await get(route,payroll)).result.canProcess,true);
 assert.equal((await get('support/info')).result.scope,'public-setup-only');assert.deepEqual((await get(context)).result,{available:false});assert.equal((await get(legacy)).status,404);
 const rules={type:'rule',revision:0,key:'fiction',name:'Synthetic tax',effective:'2026-10-01',side:'employee',method:'percentage',rate:100000};
 assert.equal((await post(route,rules,payroll)).status,200);
 assert.equal((await post('module-activation',{code:x.fx.mint()},payroll)).status,403);
 assert.equal((await post('module-activation',{code:'not-valid'})).status,400);
 const expiringCode=x.fx.mint({expiresAt:second+60,modules:['manual-payroll','private-support']});
 const activated=await post('module-activation',{code:expiringCode});assert.equal(activated.status,200);assert.equal(activated.result.status,'active');assert.ok(!JSON.stringify(activated).includes(expiringCode));
 const projection=(await get('session')).result.moduleRenewal;
 assert.deepEqual(projection,{expiresAt:second+60,remainingMs:60000});assert.equal(Object.keys(projection).length,2);
 for(const account of [payroll,other,manager])assert.equal(Object.hasOwn((await get('session',account)).result,'moduleRenewal'),false);
 assert.equal(Object.hasOwn((await request(workerUrl,'session',{session:worker})).result,'moduleRenewal'),false);
 assert.equal((await get('support/info')).result.scope,'private-customer-manual');assert.equal((await get('support/info?scope=public')).result.scope,'public-setup-only');
 assert.match((await get(legacy)).result.body,/PRIVATE_SYNTHETIC_HELP/);assert.match((await get(context)).result.body,/PRIVATE_SYNTHETIC_CONTEXT/);
 assert.equal((await get(legacy,manager)).status,404);
 assert.equal((await post(route,rules,other)).status,404);
 assert.equal((await get(route,payroll)).result.data.rules.length,1);
 const d=await post(route,{type:'draft',id:'fixture-payroll',revision:1,employee:x.employee.id,start:'2026-11-01',end:'2026-11-09',payDate:'2026-11-10',regular:12345},payroll);assert.equal(d.status,200,JSON.stringify(d));
 assert.equal((await post(route,{type:'finalize',id:'fixture-payroll',revision:2,reviewed:true},payroll)).status,200);
 const workerState=await request(workerUrl,'session',{session:worker}),stub=workerState.result.records.paystubs.find(s=>s.source==='FirmQuill manual payroll');
 assert.ok(stub);
 x.advance(60000);
 assert.equal((await get('module-activation')).result.status,'expired');
 assert.equal((await get('session')).result.moduleRenewal.remainingMs,0);
 assert.equal((await get('support/info')).result.scope,'public-setup-only');assert.equal((await get(legacy)).status,404);
 assert.deepEqual((await get(context)).result,{available:false});
 const locked=await get(route,payroll);assert.equal(locked.result.data.runs[0].id,'fixture-payroll');assert.equal(locked.result.canProcess,true);
 assert.equal((await post(route,{...rules,revision:3,key:'after-expiry',effective:'2026-11-27'},payroll)).status,200);
 const expiredDraft=await post(route,{type:'draft',id:'expired-payroll',revision:4,employee:x.employee.id,start:'2026-11-11',end:'2026-11-19',payDate:'2026-11-20',regular:22200},payroll);
 assert.equal(expiredDraft.status,200);
 assert.equal((await post(route,{type:'finalize',id:'expired-payroll',revision:5,reviewed:true},payroll)).status,200);
 assert.equal((await request(workerUrl,'session',{session:worker})).result.records.paystubs.filter(s=>s.source==='FirmQuill manual payroll').length,2);
 assert.equal((await request(workerUrl,'records/file/'+stub.id,{session:worker})).type,'application/pdf');
 const ex=await post('transfer/export',{password:pass});assert.equal(ex.status,200);
 const data=(await inspectLite(ex.result.envelope,pass)).state.companies[0];assert.equal(data.manualPayroll.runs[0].id,'fixture-payroll');assert.deepEqual(data.entries,x.state.companies[0].entries);
 await x.restart();({mainUrl,workerUrl}=x.suite);
 owner=await login(mainUrl,'owner');worker=await login(workerUrl,'worker');
 assert.equal((await get('module-activation')).result.status,'expired');
 assert.equal((await get(route)).result.data.runs[0].id,'fixture-payroll');
 assert.equal((await request(workerUrl,'records/file/'+stub.id,{session:worker})).type,'application/pdf');
 const db=openStore(x.database);
 try{
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()),new RegExp(expiringCode.replace('.','\\.')));
  assert.deepEqual(readBooks(db).state.companies[0].entries,x.state.companies[0].entries);
 }finally{db.close();}
});
const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('actual owner UI retains Manual Payroll before and after signed paid-support activation', {skip:!executable,timeout:60000},async t=>{
 const x=await setup(t),{mainUrl}=x.suite;
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errs=[],remote=[];
 page.on('pageerror',e=>errs.push(String(e)));page.on('request',r=>{if(!r.url().startsWith(mainUrl))remote.push(r.url());});
 await page.clock.install();
 await page.goto(mainUrl);await page.locator('#login [name=username]').fill('fixture-owner');await page.locator('#login [name=password]').fill(pass);
 const b=name=>page.getByRole('button',{name,exact:true}).first(),nav=name=>page.locator('nav [data-act="nav"][data-key="'+name+'"]').first().click();
 await b('Sign in').click();await b('I agree to the Terms of Service').click();
 await nav('Banking');await b('Import CSV').waitFor();await nav('Payroll');
 assert.equal(await page.locator('#module-renewal').count(),0);
 await b('Add rule version').waitFor();await page.getByRole('heading',{name:'Free federal estimate'}).waitFor();
 assert.equal(await b('Add rule version').count(),1);
 const shots=process.env.FIRMQUILL_ACTIVATION_SHOTS;
 if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:join(shots,'01-manual-payroll-no-code.png')});}
 await nav('Module activation');await b('Enter activation code').click();
 const code=page.locator('dialog[open] [name=code]');
 await page.locator('dialog[open] [name=code]').fill('bad');await b('Activate modules').click();await page.getByText(/invalid for this Full Suite installation/).waitFor();
 await code.fill(x.fx.mint({modules:['private-support'],expiresAt:second+15*86400}));await b('Activate modules').click();
 await page.getByText('Activation status: active.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Paid modules expire soon.',{exact:true}).count(),0);
 x.advance(86400000);await b('Refresh').click();await page.getByText('Paid modules expire soon.',{exact:true}).waitFor();
 if(shots)await page.screenshot({path:join(shots,'01-approaching-renewal.png')});
 await b('Enter activation code').click();await code.fill(x.fx.mint({modules:['private-support'],expiresAt:second+86400+60}));await b('Activate modules').click();
 await page.getByText('Activation status: active.',{exact:true}).waitFor();await page.locator('dialog[open]').waitFor({state:'hidden'});
 if(shots)await page.screenshot({path:join(shots,'02-active-module-status.png')});
 await nav('Payroll');await b('Add rule version').waitFor();
 assert.equal(await page.getByText('Paid modules expire soon.',{exact:true}).count(),1);
 assert.equal(await page.locator('#module-renewal').getByText(x.fx.id).count(),0);
 x.advance(60000);await page.clock.fastForward(60000);
 await page.getByText('Paid modules expired.',{exact:true}).waitFor(); // Existing view changes without a new network call or reloading its form.
 await b('Refresh').click();await b('Add rule version').waitFor();
 await page.locator('#module-renewal').getByText(/manual payroll and authorized payroll history remain available/).waitFor();
 if(shots)await page.screenshot({path:join(shots,'02-expired-manual-payroll-still-available.png')});
 await nav('Setup help');await page.getByRole('heading',{name:'Public setup guide',exact:true}).waitFor();
 await b('Open Module activation').click();await page.getByText('Activation status: expired.',{exact:true}).waitFor();
 await b('Enter activation code').click();await code.fill(x.fx.mint());await b('Activate modules').click();await page.locator('dialog[open]').waitFor({state:'hidden'});await page.getByText('Activation status: no paid module activated.',{exact:true}).waitFor();
 assert.equal(await page.locator('#module-renewal').count(),0);
 await b('Sign out').click();assert.equal(await page.locator('#module-renewal').count(),0);

 assert.deepEqual(errs,[]);assert.deepEqual(remote,[]);
});
