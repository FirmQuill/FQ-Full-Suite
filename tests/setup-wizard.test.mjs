import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createSetupWizard} from '../setup-wizard.mjs';
import {openStore,readBooks,passwordMatches} from '../store.mjs';
import {migrationCommand} from '../migration.mjs';
import {createSetupPackage,MAX_SETUP_BYTES} from '../setup-package.mjs';
import {createSuite} from '../server.mjs';
import {fictionalSources,fictionalBatches} from '../fixtures/migration-fixture.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

const password='FICTIONAL setup wizard password only.';
const credentials={username:'fictional-owner',name:'FICTIONAL Setup Owner',password,confirmPassword:password,confirm:true};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fictionalPackage(name='FICTIONAL Wizard Company'){
 const db=openStore(':memory:'),user={id:'fictional-operator',role:'owner'};
 try{const call=p=>migrationCommand(db,user,p),runId=call({type:'create',companyName:name}).runId;for(const batch of fictionalBatches)call({...batch,type:'stage',runId,source:fictionalSources[batch.source]});const p=call({type:'preview',runId});call({type:'approve',runId,previewDigest:p.digest,acceptExceptions:true});const approved=call({type:'package',runId,approvedDigest:p.digest});return createSetupPackage(approved.dataset,approved.approval);}finally{db.close();}
}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'fq-wizard-fictional-')),destination=join(dir,'customer.sqlite'),wizard=await createSetupWizard({destination});
 t.after(async()=>{await wizard.close();await rm(dir,{recursive:true,force:true});});return {dir,destination,wizard,post:(path,p,headers)=>request(wizard,path,p,headers)};
}
async function request(wizard,path,p,headers={}){
 const token=new URL(wizard.url).hash.slice(1),response=await fetch(wizard.origin+'/api/'+path,{method:'POST',headers:{Origin:wizard.origin,'Content-Type':'application/json','X-Setup-Token':token,...headers},body:JSON.stringify(p)});
 return {status:response.status,data:await response.json(),headers:response.headers};
}
async function noDestination(destination){await assert.rejects(stat(destination),{code:'ENOENT'});}
async function ownerLogin(suite){
 const response=await fetch(suite.mainUrl+'/api/login',{method:'POST',headers:{Origin:suite.mainUrl,'Content-Type':'application/json'},body:JSON.stringify({username:credentials.username,password})}),data=await response.json();assert.equal(response.status,200);assert.ok(data.termsRequired,'setup must not silently accept terms for the owner');
 const accepted=await fetch(suite.mainUrl+'/api/terms',{method:'POST',headers:{Origin:suite.mainUrl,'Content-Type':'application/json','X-CSRF-Token':data.csrf,Cookie:response.headers.get('set-cookie').split(';')[0]},body:JSON.stringify(fixtureAgreement)});assert.equal(accepted.status,200);return accepted.json();
}

test('private wizard serves inert setup UI and rejects missing tokens, hostile origins, hosts and malformed JSON',async t=>{
 const {wizard,post,destination}=await fixture(t),page=await fetch(wizard.origin+'/');assert.equal(page.status,200);const html=await page.text();assert.match(html,/id="account" hidden/);assert.equal(html.includes(new URL(wizard.url).hash.slice(1)),false);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 for(const headers of [{'X-Setup-Token':''},{'X-Setup-Token':'invalid'},{'X-Setup-Token':'é'.repeat(43)},{Origin:'https://fictional.invalid'}])assert.equal((await post('preview',{},headers)).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(wizard.origin+'/api/preview',{method:'POST',headers:{Host:'hostile.invalid',Origin:wizard.origin,'Content-Type':'application/json','X-Setup-Token':new URL(wizard.url).hash.slice(1)}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end('{}');});assert.equal(wrongHost,403);
 assert.equal((await post('preview',{}, {'Content-Type':'text/plain'})).status,415);
 const malformed=await fetch(wizard.origin+'/api/preview',{method:'POST',headers:{Origin:wizard.origin,'Content-Type':'application/json','X-Setup-Token':new URL(wizard.url).hash.slice(1)},body:'{'});assert.equal(malformed.status,400);assert.equal((await post('unknown',{})).status,404);await noDestination(destination);
});

test('wizard shutdown closes unused browser preconnections promptly and remains safe to repeat',async t=>{
 const {wizard,destination}=await fixture(t),socket=connect(new URL(wizard.origin).port,'127.0.0.1');let deadline;
 try{await once(socket,'connect');const closed=once(socket,'close');socket.resume();await Promise.race([(async()=>{await wizard.close();await closed;})(),new Promise((_,reject)=>{deadline=setTimeout(()=>{socket.destroy();reject(Error('Wizard shutdown left an unused TCP preconnection open.'));},2000);})]);await wizard.close();await noDestination(destination);}
 finally{clearTimeout(deadline);socket.destroy();}
});

test('wizard shutdown drains an accepted initialization request and completes durable setup before returning',async t=>{
 const {wizard,destination,post}=await fixture(t);await post('preview',{});const body=JSON.stringify(credentials);let req,deadline;
 const response=new Promise((resolve,reject)=>{req=httpRequest(wizard.origin+'/api/initialize',{method:'POST',headers:{Origin:wizard.origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Setup-Token':new URL(wizard.url).hash.slice(1),Expect:'100-continue'}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.once('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.once('error',reject);});
 try{const accepted=once(req,'continue');req.flushHeaders();await accepted;const closing=wizard.close();req.end(body);const result=await Promise.race([response,new Promise((_,reject)=>{deadline=setTimeout(()=>{req.destroy();reject(Error('Accepted initialization was not drained.'));},5000);})]);assert.equal(result.status,200);assert.equal(result.data.initialized,true);await closing;const db=openStore(destination);try{assert.equal(db.prepare("SELECT username FROM accounts WHERE role='owner'").get().username,credentials.username);}finally{db.close();}}
 finally{clearTimeout(deadline);req.destroy();}
});
test('empty setup requires preview and confirmation, validates credentials, retries safely and supports ordinary login',async t=>{
 const {post,destination,dir}=await fixture(t);assert.equal((await post('initialize',credentials)).status,409);assert.equal((await post('preview',{})).data.mode,'empty');
 assert.equal((await post('initialize',{...credentials,confirm:false})).status,400);assert.equal((await post('initialize',{...credentials,confirmPassword:'different'})).status,400);assert.equal((await post('initialize',{...credentials,password:'short',confirmPassword:'short'})).status,400);await noDestination(destination);
 assert.equal((await post('initialize',{...credentials,username:'not a valid username'})).status,400);await noDestination(destination);assert.equal((await readdir(dir)).some(name=>name.endsWith('.partial')),false);
 const done=await post('initialize',credentials);assert.equal(done.status,200);assert.deepEqual(done.data.companies,[]);assert.equal(JSON.stringify(done.data).includes(password),false);
 const db=openStore(destination);try{const owner=db.prepare("SELECT * FROM accounts WHERE role='owner'").get();assert.equal(owner.username,credentials.username);assert.notEqual(owner.hash,password);assert.equal(await passwordMatches(password,owner.hash),true);assert.deepEqual(readBooks(db).state.companies,[]);}finally{db.close();}
 assert.equal((await post('initialize',credentials)).status,409);assert.equal((await post('preview',{})).status,409);
 const suite=await createSuite({database:destination,mainPort:0,workerPort:0});try{const session=await ownerLogin(suite);assert.deepEqual(session.state.companies,[]);}finally{await suite.close();}
});
test('package setup rejects schema/tamper/digest errors then installs approved records with private credentials and one receipt',async t=>{
 const {post,destination}=await fixture(t),pkg=fictionalPackage(),schema=JSON.parse(pkg.packageText);schema.schema=999;assert.equal((await post('preview',{packageText:JSON.stringify(schema)})).status,400);await noDestination(destination);
 const tampered=JSON.parse(pkg.packageText);tampered.files[0].content+=' ';assert.equal((await post('preview',{packageText:JSON.stringify(tampered)})).status,400);assert.equal((await post('initialize',credentials)).status,409);
 const preview=await post('preview',{packageText:pkg.packageText});assert.equal(preview.status,200);assert.equal(preview.data.preview.digest,pkg.digest);assert.equal(preview.data.preview.dataset,undefined);assert.equal(preview.data.preview.approval,undefined);assert.equal(preview.data.preview.counts.accepted,10);
 assert.equal((await post('initialize',{...credentials,digest:'wrong'})).status,409);assert.equal((await post('initialize',{...credentials,digest:pkg.digest,password:'short',confirmPassword:'short'})).status,400);await noDestination(destination);
 const done=await post('initialize',{...credentials,digest:pkg.digest});assert.equal(done.status,200);assert.equal(done.data.companies[0].name,'FICTIONAL Wizard Company');let saved;
 const db=openStore(destination);try{saved=readBooks(db).state;assert.equal(saved.companies[0].employees.length,0);assert.equal(saved.companies[0].parties.length,2);assert.equal(db.prepare('SELECT count(*) AS n FROM migration_historical').get().n,2);assert.equal(db.prepare('SELECT count(*) AS n FROM migration_setup_receipts').get().n,1);}finally{db.close();}
 for(let n=0;n<2;n++){const suite=await createSuite({database:destination,mainPort:0,workerPort:0});try{if(n===0)assert.deepEqual((await ownerLogin(suite)).state,saved);}finally{await suite.close();}const reopened=openStore(destination);try{assert.deepEqual(readBooks(reopened).state,saved);assert.equal(reopened.prepare('SELECT count(*) AS n FROM migration_setup_receipts').get().n,1);}finally{reopened.close();}}
 await assert.rejects(createSetupWizard({destination}),/already exists/);
});
test('concurrent preview and duplicate initialize cannot change the reviewed package during password hashing',async t=>{
 const {post,destination,dir}=await fixture(t),first=fictionalPackage('FICTIONAL Selected Company'),other=fictionalPackage('FICTIONAL Other Company');assert.equal((await post('preview',{packageText:first.packageText})).status,200);
 const initializing=post('initialize',{...credentials,digest:first.digest});await pause(5);const competing=await Promise.all([post('preview',{packageText:other.packageText}),post('initialize',{...credentials,digest:first.digest})]);for(const result of competing)assert.equal(result.status,409);const completed=await initializing;assert.equal(completed.status,200);assert.equal(completed.data.companies[0].name,'FICTIONAL Selected Company');
 const db=openStore(destination);try{assert.equal(readBooks(db).state.companies[0].name,'FICTIONAL Selected Company');assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n,1);}finally{db.close();}assert.equal((await readdir(dir)).some(name=>name.endsWith('.partial')),false);
});

test('wizard accepts bounded package JSON when its outer request requires additional escaping',async t=>{
 const {post,destination}=await fixture(t),pkg=fictionalPackage();
 const packageText='\n'.repeat(MAX_SETUP_BYTES/2+65536)+pkg.packageText;
 assert.ok(Buffer.byteLength(packageText)<MAX_SETUP_BYTES);
 assert.ok(Buffer.byteLength(JSON.stringify({packageText}))>MAX_SETUP_BYTES+65536);
 const preview=await post('preview',{packageText});assert.equal(preview.status,200);assert.equal(preview.data.preview.company.name,'FICTIONAL Wizard Company');await noDestination(destination);
 assert.equal((await post('preview',{packageText:' '.repeat(MAX_SETUP_BYTES+1)})).status,413);await noDestination(destination);
});
test('a competing destination creator wins without overwrite and failed publication can be retried',async t=>{
 const {post,destination,dir}=await fixture(t);await post('preview',{});const initializing=post('initialize',credentials);await pause(5);const marker=Buffer.from('FICTIONAL preexisting workspace marker');await writeFile(destination,marker,{flag:'wx'});const conflict=await initializing;assert.equal(conflict.status,409);assert.deepEqual(await readFile(destination),marker);assert.equal((await readdir(dir)).some(name=>name.endsWith('.partial')),false);
 await rm(destination);assert.equal((await post('preview',{})).status,200);assert.equal((await post('initialize',credentials)).status,200);
});
test('host configure exposes only a private loopback setup and refuses an existing destination without mutation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fq-host-configure-')),destination=join(dir,'configured.sqlite'),host=fileURLToPath(new URL('../host.mjs',import.meta.url));let child;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('close',resolve);setTimeout(resolve,1000).unref();});}await rm(dir,{recursive:true,force:true});});
 child=spawn(process.execPath,[host,'configure'],{env:{...process.env,FIRMQUILL_DB:destination},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',errors='';child.stderr.on('data',b=>{errors+=b;});
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Configure link did not arrive. '+errors)),15000);child.stdout.on('data',b=>{output+=b;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#([A-Za-z0-9_-]+)/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('exit',code=>{if(!output.includes('http://')){clearTimeout(timer);reject(Error('Configure exited '+code+': '+errors));}});});
 const wizard={url,origin:new URL(url).origin};assert.equal((await request(wizard,'preview',{})).status,200);assert.equal((await request(wizard,'initialize',credentials)).status,200);child.kill();await new Promise(resolve=>child.once('close',resolve));
 const before=await readFile(destination),again=spawnSync(process.execPath,[host,'configure'],{env:{...process.env,FIRMQUILL_DB:destination},encoding:'utf8',windowsHide:true});assert.equal(again.status,1);assert.match(again.stderr,/fresh FIRMQUILL_DB/);assert.deepEqual(await readFile(destination),before);
 const sidecar=join(dir,'sidecar.sqlite');await writeFile(sidecar+'-wal','FICTIONAL');await assert.rejects(createSetupWizard({destination:sidecar}),/already exists/);
});
