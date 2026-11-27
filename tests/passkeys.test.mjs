import test from 'node:test';
import assert from 'node:assert/strict';
import {request as nodeRequest} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {createSuite} from '../server.mjs';
import {openStore,saveBooks,putUser,passwordHash,tx} from '../store.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';
import {fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';
import {passkeyOrigin} from '../passkeys.mjs';

const password='Synthetic passkey account only.';
async function fixture(t,{packaged=false,...options}={}){
  const dir=await mkdtemp(join(tmpdir(),'fq-passkey-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'fictional.sqlite'),db=openStore(file),state=sampleVault(),c=state.companies[0],hash=await passwordHash(password);
  try{tx(db,()=>{
    saveBooks(db,state);
    for(const [role,name,employeeId] of [['owner','host-owner'],['manager','host-manager'],['viewer','host-viewer'],['worker','host-worker',c.employees[0].id]])
      putUser(db,null,{role,username:name,name,employeeId,assignments:role==='owner'?[]:[c.id]},hash,{bootstrap:true});
  });}finally{db.close();}
  const distribution=join(dir,'distributed');
  if(packaged)await buildPublicRelease(distribution);
  const serve=packaged?(await import(pathToFileURL(join(distribution,'server.mjs')))).createSuite:createSuite;
  let suite=await serve({database:file,mainPort:0,workerPort:0,...options});
  t.after(()=>suite.close());return {file,dir,state,get suite(){return suite;},async restart(){await suite.close();suite=await serve({database:file,mainPort:0,workerPort:0,...options});}};
}
async function request(origin,path,{body,cookie,csrf,headers={}}={}){
 const r=await fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{...(body?{origin,'content-type':'application/json','x-csrf-token':csrf||''}:{}),...(cookie?{cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 return {code:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};
}
test('closed option/malformed and replay checks, password and Terms preservation, production exact HTTPS RP/Host',async t=>{
 assert.equal(passkeyOrigin('main','http://192.168.1.4:123','192.168.1.4:123'),null);
 assert.equal(passkeyOrigin('main','https://books.example.test','127.0.0.1:4179'),null);
 assert.deepEqual(passkeyOrigin('worker','https://employee.example.test','employee.example.test'),{portal:'worker',rpID:'employee.example.test',origin:'https://employee.example.test'});
 const {suite:s}=await fixture(t);
 assert.equal((await request(s.mainUrl,'passkeys/available')).data.available,false);
 const mainUrl=s.mainUrl.replace('127.0.0.1','localhost'),workerUrl=s.workerUrl.replace('127.0.0.1','localhost');
 const front=(path,x)=>request(mainUrl,'passkeys/'+path,x);
 assert.equal((await front('available')).data.available,true);
 assert.equal((await front('sign-in/start',{body:{},headers:{origin:workerUrl}})).code,403);
 assert.equal((await front('list')).code,401);
 const login=await request(mainUrl,'login',{body:{username:'host-owner',password}});assert.equal(login.code,200);
 const auth={cookie:login.cookie,csrf:login.data.csrf};
 assert.equal((await front('list',auth)).code,428);
 assert.equal((await request(mainUrl,'terms',{...auth,body:fixtureAgreement})).code,200);
 assert.equal((await front('register/start',{...auth,body:{password:'bad',label:'Fake'}})).code,403);
 const start=await front('register/start',{...auth,body:{password,label:'Local fixture'}});
 assert.equal(start.code,200,JSON.stringify(start.data));assert.equal(start.data.options.authenticatorSelection.userVerification,'required');assert.equal(start.data.options.authenticatorSelection.residentKey,'required');
 assert.equal((await front('register/finish',{...auth,body:{ticket:start.data.ticket,response:{id:'fictional-id'}}})).code,400);
 assert.match((await front('register/finish',{...auth,body:{ticket:start.data.ticket,response:{id:'fictional-id'}}})).data.error,/expired/);
 const tryLogin=await front('sign-in/start',{body:{}});assert.equal(tryLogin.code,200);assert.match(tryLogin.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 assert.equal((await request(workerUrl,'passkeys/sign-in/finish',{cookie:tryLogin.cookie,body:{response:{id:'fictional-id'}}})).code,400);
 assert.equal((await front('sign-in/finish',{cookie:tryLogin.cookie,body:{response:{id:'fictional-id'}}})).code,401);
 assert.equal((await front('sign-in/finish',{cookie:tryLogin.cookie,body:{response:{id:'fictional-id'}}})).code,400);
 assert.equal((await request(mainUrl,'session',auth)).code,200,'existing password session stays active');
 const viewer=await request(mainUrl,'login',{body:{username:'host-viewer',password}}),v={cookie:viewer.cookie,csrf:viewer.data.csrf};
 assert.equal((await request(mainUrl,'terms',{...v,body:fixtureAgreement})).code,200);
 assert.equal((await front('list',v)).data.available,false);
 assert.equal((await front('register/start',{...v,body:{password,label:'Not eligible'}})).code,403);
 const {suite:prod}=await fixture(t,{mainOrigin:'https://erp.example.test',workerOrigin:'https://employee.example.test'});
 const configured=await new Promise((resolve,reject)=>{
   const q=nodeRequest(prod.mainUrl+'/api/passkeys/sign-in/start',{method:'POST',headers:{Host:'erp.example.test',Origin:'https://erp.example.test','Content-Type':'application/json'}},res=>{
     let raw='';res.on('data',d=>raw+=d);res.on('end',()=>resolve({code:res.statusCode,data:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]}));
   });q.on('error',reject);q.end('{}');
 });
 assert.equal(configured.code,200);assert.equal(configured.data.options.rpId,'erp.example.test');
 assert.match(configured.cookie,/^__Host-fq_pk_main=.*; Secure$/);
 assert.equal((await request(prod.mainUrl,'passkeys/sign-in/start',{body:{},headers:{origin:'https://erp.example.test'}})).code,403);
});
const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('virtual passkey provider in actual owner and employee portals: multiple passkeys, fallback, restart, revoke', {skip:!executable,timeout:90000},async t=>{
 const work=await fixture(t,{packaged:true}),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
 const p=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 p.on('pageerror',err=>{errors.push(err.message);console.log('page error:',err.message);});p.setDefaultTimeout(8000);
 const dev=await p.context().newCDPSession(p);await dev.send('WebAuthn.enable');
 const newAuthenticator=()=>dev.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,defaultBackupEligibility:true,defaultBackupState:true}});
 let {authenticatorId}=await newAuthenticator();
 const tap=name=>p.getByRole('button',{name,exact:true}).first().click(),m=p.getByRole('dialog',{name:'Manage passkeys'});
 async function enter(base,name){await p.goto(base);await p.locator('#login [name=username]').fill(name);await p.locator('#login [name=password]').fill(password);await tap('Sign in');await acceptFixtureBrowser(p);}
 async function enroll(label){await tap('Manage passkeys');await tap('Add passkey');await m.getByLabel('Current password').fill(password);await m.getByLabel('Passkey name').fill(label);await tap('Verify password and continue');try{await m.getByRole('button',{name:'Remove '+label}).waitFor();}catch(e){throw Error(await m.innerText());}}
 async function passwordless(base){await p.goto(base);await tap('Sign in with a passkey');await p.getByRole('button',{name:'Manage passkeys',exact:true}).waitFor();}
 const local=url=>url.replace('127.0.0.1','localhost');
 const suite={mainUrl:local(work.suite.mainUrl),workerUrl:local(work.suite.workerUrl)};
 await enter(suite.mainUrl,'host-owner');await enroll('Laptop fixture');
 const shots=process.env.FIRMQUILL_PASSKEY_SHOTS;
 if(shots){await mkdir(shots,{recursive:true});await p.screenshot({path:join(shots,'owner-enrolled.png')});}
 await dev.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId});
 ({authenticatorId}=await newAuthenticator());
 await tap('Close passkey management');await enroll('Backup fixture');
 assert.equal(await m.getByRole('button',{name:'Remove Laptop fixture'}).count(),1);
 const [backup]=(await dev.send('WebAuthn.getCredentials',{authenticatorId})).credentials;
 await tap('Close passkey management');await tap('Sign out');await passwordless(suite.mainUrl);
 await tap('Sign out');await enter(suite.workerUrl,'host-worker');await enroll('Worker fixture');
 if(shots)await p.screenshot({path:join(shots,'employee-enrolled.png')});
 await tap('Close passkey management');await tap('Sign out');
 await dev.send('WebAuthn.removeCredential',{authenticatorId,credentialId:backup.credentialId});
 await p.goto(suite.mainUrl);await tap('Sign in with a passkey');await p.getByText(/Passkey could not be verified/).waitFor();
 await passwordless(suite.workerUrl);await tap('Sign out');
 await work.restart();
 await passwordless(local(work.suite.workerUrl));await tap('Sign out');
 const backupFile=join(work.dir,'fictional-passkey.fqdb'),restored=join(work.dir,'fictional-restored.sqlite');
 const backupSecret='Synthetic private archive fixture.';
 await backupDatabase(work.file,backupFile,backupSecret);await restoreDatabase(backupFile,restored,backupSecret);
 const replay=await createSuite({database:restored,mainPort:0,workerPort:0});
 try{await passwordless(local(replay.workerUrl));await tap('Sign out');}finally{await replay.close();}
 await passwordless(local(work.suite.workerUrl));
 await tap('Manage passkeys');await tap('Remove Worker fixture');await m.getByLabel('Current password').fill(password);await tap('Confirm removal');await m.getByText('No passkeys are registered for this account and portal.').waitFor();
 await tap('Close passkey management');
 // Revoked passkey session can no longer refresh or sign out; password still works next login.
 await tap('Refresh');await p.locator('#login').waitFor();await enter(local(work.suite.workerUrl),'host-worker');
 await p.getByRole('button',{name:'Manage passkeys',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
});
