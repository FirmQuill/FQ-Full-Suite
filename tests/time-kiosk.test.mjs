import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {createSuite} from '../server.mjs';
import {openStore,saveBooks,putUser,passwordHash,tx} from '../store.mjs';
import {apply} from '../shared/core.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';

const password='Synthetic kiosk role password.';
async function fixture(t,{packaged=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'fq-kiosk-'));
  const file=join(dir,'fictional.sqlite'),initial=sampleVault();
  let state=apply(initial,initial.companies[1].id,{type:'employee',name:'Fictional Worker B',rate:2400,state:'WA',locality:'Seattle',date:'2026-11-01',requestId:randomUUID()});
  state=apply(state,state.companies[0].id,{type:'job',name:'Separate synthetic workplace',date:'2026-11-01',requestId:randomUUID()});
  const [c,other]=state.companies,hash=await passwordHash(password);
  assert(c.jobs.length&&other.employees.length>=1);
  const info={};
  const db=openStore(file);
  try{tx(db,()=>{
    saveBooks(db,state);
    for(const [role,name,company,employeeId] of [['owner','fixture-owner',c,''],['manager','fixture-manager',c,''],['worker','fixture-worker',c,c.employees[0].id],['worker','fixture-foreign',other,other.employees[0].id]])
      info[name]=putUser(db,null,{role,username:name,name,employeeId,assignments:role==='owner'?[]:[company.id]},hash,{bootstrap:true});
  });}finally{db.close();}
  const distribution=join(dir,'distributed');if(packaged)await buildPublicRelease(distribution);
  const serve=packaged?(await import(pathToFileURL(join(distribution,'server.mjs')))).createSuite:createSuite;
  let suite=await serve({database:file,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
  return {file,c,other,info,get suite(){return suite;},async restart(){await suite.close();suite=await serve({database:file,mainPort:0,workerPort:0});}};
}
async function api(origin,path,{body,cookie,csrf,headers={}}={}){
  const r=await fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{...(body?{origin,'content-type':'application/json','x-csrf-token':csrf||''}:{}),...(cookie?{cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {code:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};
}
async function signIn(origin,username,accept=true){
  const login=await api(origin,'login',{body:{username,password}});assert.equal(login.code,200,JSON.stringify(login.data));
  const session={cookie:login.cookie,csrf:login.data.csrf};
  if(accept&&login.data.termsRequired)assert.equal((await api(origin,'terms',{...session,body:fixtureAgreement})).code,200);
  return session;
}
const dba=(file,fn)=>{const db=openStore(file);try{return fn(db);}finally{db.close();}};
const data=(profile,action)=>({...profile,action,request:randomUUID(),requestedAt:Date.now()});

test('station grant, Terms, scope, restart, retry and limits with synthetic workers', {timeout:40000},async t=>{
 const x=await fixture(t),s=x.suite,admin='time-kiosk-admin';
 const owner=await signIn(s.mainUrl,'fixture-owner'),manager=await signIn(s.mainUrl,'fixture-manager');
 const worker=await signIn(s.workerUrl,'fixture-worker',false),foreign=await signIn(s.workerUrl,'fixture-foreign');
 const view=(id=x.c.id)=>api(s.mainUrl,admin+'?companyId='+id,owner);
 const cmd=body=>api(s.mainUrl,admin,{...owner,body});
 const kiosk=(path,body,cookie,headers)=>api(x.suite.workerUrl,'time-kiosk/'+path,{body,cookie,headers});
 assert.equal((await api(s.mainUrl,admin,{...manager,body:{type:'create'}})).code,403);
 assert.equal((await api(s.mainUrl,admin,{...owner,csrf:'',body:{type:'create'}})).code,403);
 assert.equal((await api(s.workerUrl,admin,foreign)).code,404);
 assert.equal((await api(s.mainUrl,'time-kiosk/status')).code,404);
 const make=await cmd({type:'create',company:x.c.id,job:x.c.jobs[0].id,label:'Fictional Warehouse A'});assert.equal(make.code,200,JSON.stringify(make.data));
 const id=(await view()).data.kiosks[0].id;
 assert.deepEqual((await view(x.other.id)).data.kiosks,[]);
 assert.equal((await cmd({type:'pin',id,account:x.info['fixture-worker']})).code,403,'owner cannot bypass worker Terms');
 assert.equal((await cmd({type:'pin',id,account:x.info['fixture-foreign']})).code,403,'other company cannot use this station');
 assert.equal((await api(s.workerUrl,'terms',{...worker,body:fixtureAgreement})).code,200);
 const issued=await cmd({type:'pin',id,account:x.info['fixture-worker']});assert.equal(issued.code,200,JSON.stringify(issued.data));
 const profile=issued.data;assert.match(profile.pin,/^\d{10}$/);
 assert.equal((await kiosk('pair',{code:make.data.pairCode},undefined,{origin:s.mainUrl})).code,403);
 const registered=await kiosk('pair',{code:make.data.pairCode});assert.equal(registered.code,200,JSON.stringify(registered.data));
 assert.match(registered.headers.get('set-cookie'),/^fq_time_kiosk=.*; HttpOnly; SameSite=Strict; Path=\//);
 assert.equal((await kiosk('pair',{code:make.data.pairCode})).code,403);
 const cookie=registered.cookie;
 assert.equal((await api(s.workerUrl,'session',{cookie})).code,401,'station cookie is never an account session');
 assert.deepEqual((await kiosk('status',undefined,cookie)).data,{paired:true,label:'Fictional Warehouse A'});
 const punchIn=data(profile,'clock-in'),punchOut=data(profile,'clock-out');
 assert.equal((await kiosk('punch',{...punchIn,pin:'123'},cookie)).code,400);
 const inResult=await kiosk('punch',punchIn,cookie);assert.equal(inResult.code,200,JSON.stringify(inResult.data));
 assert.deepEqual(inResult.data,{action:'clock-in'});
 assert.equal((await kiosk('punch',punchIn,cookie)).code,200,'transport retry must not duplicate');
 assert.equal((await kiosk('punch',data(profile,'clock-in'),cookie)).code,409,'separate click cannot start a second shift');
 const fromPortal=(await api(s.workerUrl,'session',worker)).data;assert(fromPortal.data.openShift);
 const otherStation=await cmd({type:'create',company:x.c.id,job:x.c.jobs[1].id,label:'Site B'});assert.equal(otherStation.code,200);
 const otherDevice=(await view()).data.kiosks.find(k=>k.label==='Site B').id;
 const otherPIN=await cmd({type:'pin',id:otherDevice,account:x.info['fixture-worker']});assert.equal(otherPIN.code,200);
 const siteB=await kiosk('pair',{code:otherStation.data.pairCode});
 assert.equal((await kiosk('punch',data(otherPIN.data,'clock-out'),siteB.cookie)).code,409,'same company other job cannot close this station shift');
 assert.equal((await kiosk('punch',punchOut,cookie)).code,200);
 assert.equal((await kiosk('punch',punchOut,cookie)).code,200,'out retry is consistent after shift ends');
 assert.equal((await kiosk('punch',{...punchOut,requestedAt:Date.now()-180_000},cookie)).code,400,'old transport retry cannot close a later shift');
 const unsupported=await kiosk('punch',data({...profile,workerId:'fixture-foreign'},'clock-in'),cookie);assert.equal(unsupported.code,403);
 const disable=async features=>api(s.mainUrl,'admin/employee-features',{...owner,body:{companyId:x.c.id,employeeId:x.c.employees[0].id,features}});
 assert.equal((await disable([])).code,200);
 assert.equal((await kiosk('punch',data(profile,'clock-in'),cookie)).code,403,'disabling worker Time stops kiosk usage');
 assert.equal((await disable(['Time'])).code,200);
 const removed=await cmd({type:'remove-worker',id:otherDevice,account:x.info['fixture-worker']});assert.equal(removed.code,200);
 assert.equal((await kiosk('punch',data(otherPIN.data,'clock-in'),siteB.cookie)).code,403,'worker removal revokes their kiosk PIN');
 const record=dba(x.file,db=>({shifts:db.prepare('SELECT * FROM worker_shifts').all(),requests:db.prepare('SELECT * FROM worker_requests').all(),audit:db.prepare("SELECT * FROM audit WHERE kind LIKE 'kiosk%' OR kind LIKE 'worker clock-%'").all()}));
 assert.equal(record.shifts.length,1);assert.equal(record.requests[0].kind,'Timesheet');assert.equal(record.requests[0].status,'pending');
 assert.equal(record.audit.filter(x=>x.kind.startsWith('worker clock')).length,2);assert(!JSON.stringify(record).includes(profile.pin));
 assert(!JSON.stringify(await view()).includes(make.data.pairCode));assert(!JSON.stringify(await view()).includes(profile.pin));
 await x.restart();
 assert.deepEqual((await kiosk('status',undefined,cookie)).data,{paired:true,label:'Fictional Warehouse A'});
 assert.equal((await kiosk('punch',punchOut,cookie)).code,200,'persistent receipt survives restart and login cookie does not');
 dba(x.file,db=>db.prepare('UPDATE time_kiosk_limits SET attempts=60 WHERE device=?').run(id));
 assert.equal((await kiosk('punch',data(profile,'clock-in'),cookie)).code,429);
 const nowOwner=await signIn(x.suite.mainUrl,'fixture-owner'),freshCmd=body=>api(x.suite.mainUrl,admin,{...nowOwner,body});
 const newPair=await freshCmd({type:'re-pair',id});assert.equal(newPair.code,200,JSON.stringify(newPair.data));assert.deepEqual((await kiosk('status',undefined,cookie)).data,{paired:false});
 const next=await kiosk('pair',{code:newPair.data.pairCode});assert.equal(next.code,200,JSON.stringify(next.data));
 assert.equal((await freshCmd({type:'revoke',id})).code,200);
 assert.equal((await kiosk('punch',data(profile,'clock-in'),next.cookie)).code,401);
});

const executable=process.env.FIRMQUILL_BROWSER_EXE;
test('packaged owner provisions and revokes a shared browser for real staff time punches', {skip:!executable,timeout:75000},async t=>{
 const x=await fixture(t,{packaged:true}),s=x.suite;
 await signIn(s.workerUrl,'fixture-worker'); // Terms in normal worker space, not accepted on behalf of a worker.
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:executable});t.after(()=>browser.close());
 const admin=await browser.newPage({viewport:{width:1440,height:960}}),staff=await browser.newPage({viewport:{width:820,height:750}});
 const go=(label,page=admin)=>page.getByRole('button',{name:label,exact:true});
 await admin.goto(s.mainUrl);await admin.locator('[name=username]').fill('fixture-owner');await admin.locator('[name=password]').fill(password);
 await go('Sign in').click();await acceptFixtureBrowser(admin);
 await go('Time clock kiosk').click();await go('Create station').click();
 await admin.getByLabel('Station label').fill('Fictional station');await admin.locator('dialog').getByRole('button',{name:'Create station',exact:true}).click();
 const pairing=await admin.getByLabel('One-time pairing code').inputValue();
 await staff.goto(s.workerUrl+'/kiosk');await staff.getByLabel('Pairing code').fill(pairing);await go('Pair station',staff).click();
 await staff.getByRole('status').getByText(/Station paired/).waitFor();
 await admin.locator('dialog').getByRole('button',{name:'Close'}).click();
 await go('Issue worker PIN').click();await go('Generate PIN').click();const pin=await admin.getByLabel('Worker PIN',{exact:true}).inputValue();await go('Close').click();
 const sendPunch=async action=>{
   await staff.getByLabel('Worker ID').fill('fixture-worker');await staff.getByLabel('Station PIN').fill(pin);await go(action,staff).click();
   await staff.getByRole('status').getByText(action==='Clock in'?'Clock-in recorded.':'Clock-out recorded.',{exact:true}).waitFor();
   assert.equal(await staff.getByLabel('Station PIN').inputValue(),'');assert.equal(await staff.getByLabel('Worker ID').inputValue(),'');
 };
 await sendPunch('Clock in');await sendPunch('Clock out');
 await go('Approvals').click();await admin.getByText(/Timesheet/).first().waitFor();
 if(process.env.FIRMQUILL_KIOSK_SHOTS){const output=process.env.FIRMQUILL_KIOSK_SHOTS;await mkdir(output,{recursive:true});await staff.screenshot({path:join(output,'fictional-kiosk-punch.png')});}
 await go('Time clock kiosk').click();await go('Revoke station').click();await admin.locator('dialog').getByRole('button',{name:'Revoke station',exact:true}).click();
 await admin.getByText('revoked',{exact:true}).waitFor();await staff.reload();await staff.getByLabel('Pairing code').waitFor();
});
