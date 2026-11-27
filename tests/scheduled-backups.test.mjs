import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createSuite} from '../server.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';
import {openStore,putUser,saveBooks,tx,passwordHash} from '../store.mjs';
import {newVault} from '../shared/core.mjs';
import {exportLite} from '../transfer.mjs';
import {fixtureAgreement,seedFixtureTerms,acceptFixtureBrowser} from './fixture-terms.mjs';

const password='Synthetic login fixture 2026 only!';
const secret='Fixture-key-with-40+characters-for-recovery!';
const statePath='managed-backups';
async function setup(t,{configured=true,archive,empty=false}={}){
 const root=await mkdtemp(join(tmpdir(),'fq-scheduled-fixture-')),directory=join(root,'archives'),keyFile=join(root,'secret');
 await mkdir(directory,{mode:0o700});await writeFile(keyFile,secret+'\n',{mode:0o600});
 const database=join(root,'books.sqlite'),p=await passwordHash(password),db=openStore(database);
 const start=empty?null:newVault('Synthetic managed backup'),company=start?.companies[0]?.id;
 try{tx(db,()=>{
   if(start)saveBooks(db,start);
   putUser(db,null,{username:'owner',name:'Fixture Owner',role:'owner',assignments:[]},p,{bootstrap:true});
   if(company)putUser(db,null,{username:'manager',name:'Fixture Manager',role:'manager',assignments:[company]},p,{bootstrap:true});
 });seedFixtureTerms(db);}finally{db.close();}
 let now=new Date('2026-10-01T11:59:00Z'),suite;
 const opts={database,mainPort:0,workerPort:0,backupOptions:configured?{directory,keyFile}:{},backupArchive:archive,backupClock:()=>new Date(now),backupIntervalMs:35};
 const restart=async()=>{await suite?.close();suite=await createSuite(opts);return suite;};
 await restart();
 t.after(async()=>{await suite?.close();await rm(root,{recursive:true,force:true});});
 return {root,directory,keyFile,database,company,get suite(){return suite;},restart,clock:value=>{now=new Date(value);}};
}
async function client(base,username='owner'){
 let cookie='',csrf='';
 const req=async(path,body)=>{
   const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:base,'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,data:await r.json(),headers:r.headers};
 };
 const r=await req('login',{username,password});assert.equal(r.status,200,JSON.stringify(r.data));cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;
 if(r.data.termsRequired)assert.equal((await req('terms',fixtureAgreement)).status,200);
 return Object.assign(req,{async ok(path,body){const x=await req(path,body);assert.equal(x.status,200,JSON.stringify(x.data));return x.data;}});
}
async function next(check){for(let i=0;i<120;i++){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,30));}assert.fail('Expected managed backup status did not appear.');}
const options=(p={})=>({dailyUTC:'',beforeCommit:false,retain:2,version:0,...p});
const names=async x=>(await readdir(x.directory)).filter(n=>n.endsWith('.fqdb')).sort();
function readArchive(file){const db=new DatabaseSync(file,{readOnly:true});try{return {state:JSON.parse(db.prepare('SELECT body FROM books').get().body),proposals:db.prepare('SELECT id,status FROM agent_proposals').all()};}finally{db.close();}}
async function proposal(x,owner,name){
 const current=await owner.ok('session'),grant=await owner.ok('agent-admin/action',{type:'grant',companyId:x.company,name:'Synthetic Agent',recordTypes:['contacts'],allowProposals:true});
 const r=await fetch(x.suite.mainUrl+'/api/agents/v1/proposals',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+grant.token},body:JSON.stringify({companyId:x.company,revision:current.revision,requestId:randomUUID(),action:{type:'contact',name,kind:'Customer',date:'2026-10-01'}})});
 assert.equal(r.status,200);const result=await r.json();return {type:'decide',id:result.id,revision:current.revision,decision:'approve'};
}
test('explicit policy required; daily encrypted archive is retained, restores, and deduplicates across restart',async t=>{
 const x=await setup(t);let owner=await client(x.suite.mainUrl),manager=await client(x.suite.mainUrl,'manager');
 assert.equal((await manager(statePath)).status,403);
 assert.equal((await owner.ok(statePath)).policy.dailyUTC,'');assert.equal((await owner.ok(statePath)).lastArchive,null);
 await owner.ok(statePath,options({dailyUTC:'12:00'}));assert.deepEqual(await names(x),[]);
 x.clock('2026-10-01T12:00:00Z');
 const first=await next(async()=>{const s=await owner.ok(statePath);return s.lastArchive&&!s.running?s:null;});
 assert.equal(first.lastArchive.reason,'daily');assert.equal(first.lastArchive.at,'2026-10-01T12:00:00.000Z');
 await x.restart();owner=await client(x.suite.mainUrl);
 assert.equal((await owner.ok(statePath)).lastArchive.name,first.lastArchive.name);assert.equal((await names(x)).length,1);
 await writeFile(join(x.directory,'unmanaged.fqdb'),'synthetic unrelated file');
 x.clock('2026-10-02T12:00:00Z');await next(async()=>{const s=await owner.ok(statePath);return !s.running&&s.lastArchive?.at.startsWith('2026-10-02');});
 x.clock('2026-10-03T12:00:00Z');const last=await next(async()=>{const s=await owner.ok(statePath);return !s.running&&s.lastArchive?.at.startsWith('2026-10-03')?s:null;});
 const files=await names(x);assert.equal(files.length,3);assert.ok(files.includes('unmanaged.fqdb'));assert.ok(!files.includes(first.lastArchive.name));
 const destination=join(x.root,'rehearsal.sqlite');
 await restoreDatabase(join(x.directory,last.lastArchive.name),destination,secret);
 assert.equal(readArchive(destination).state.companies[0].name,'Synthetic managed backup');
 assert.ok(!(JSON.stringify(last).includes(x.root)||JSON.stringify(last).includes(secret)));
});

test('AI approval backup failure and concurrent database writes leave proposal pending; retry archives immediately before a write',async t=>{
 let changedOnce=false,changeDuring=false;
 const archive=async(database,destination,key)=>{
   const result=await backupDatabase(database,destination,key);
   if(changeDuring&&!changedOnce){
     changedOnce=true;
     const d=openStore(database);try{d.prepare("INSERT INTO audit(at,actor,companyId,kind,detail) VALUES(?,?,?,?,?)").run('2026-10-01T12:00:00Z','fixture','','unrelated event','test-only concurrent non-books write');}finally{d.close();}
   }
   return result;
 };
 const x=await setup(t,{archive}),owner=await client(x.suite.mainUrl);
 await owner.ok(statePath,options({beforeCommit:true}));
 const decide=await proposal(x,owner,'Synthetic backup-protected customer');
 await rename(x.keyFile,x.keyFile+'.offline');
 const failed=await owner('agent-admin/action',decide);assert.equal(failed.status,503);assert.match(failed.data.error,/Nothing was applied/);
 assert.equal((await owner.ok('agent-admin')).proposals[0].status,'pending');assert.equal((await owner.ok(statePath)).lastError,'backup-unavailable');
 await rename(x.keyFile+'.offline',x.keyFile);changeDuring=true;
 const stale=await owner('agent-admin/action',decide);assert.equal(stale.status,409,JSON.stringify(stale.data));assert.match(stale.data.error,/backup was running/);
 assert.equal((await owner.ok('agent-admin')).proposals[0].status,'pending');assert.ok(changedOnce);
 await owner.ok('agent-admin/action',decide);
 const status=await owner.ok(statePath);assert.equal(status.lastArchive.reason,'agent-approval');
 const destination=join(x.root,'preapproval.sqlite');
 await restoreDatabase(join(x.directory,status.lastArchive.name),destination,secret);
 const snapshot=readArchive(destination);
 assert.equal(snapshot.proposals.find(p=>p.id===decide.id).status,'pending');
 assert.ok(!snapshot.state.companies[0].parties.some(p=>p.name==='Synthetic backup-protected customer'));
 assert.equal((await owner.ok('agent-admin')).proposals[0].status,'approved');
 assert.ok((await owner.ok('session')).state.companies[0].parties.some(p=>p.name==='Synthetic backup-protected customer'));
 const count=(await names(x)).length;
 assert.equal((await owner('agent-admin/action',decide)).status,409);
 assert.equal((await names(x)).length,count,'repeated approval does not trigger an archive');
});

test('reviewed Lite import stays staged on backup failure; retry creates a pre-import recovery point',async t=>{
 const x=await setup(t,{empty:true}),owner=await client(x.suite.mainUrl);
 await owner.ok(statePath,options({beforeCommit:true}));
 const exported=await exportLite(newVault('Synthetic imported company'),password);
 const preview=await owner.ok('transfer/preview',{envelope:exported.envelope,password});
 const request={envelope:exported.envelope,password,revision:preview.revision,digest:preview.digest};
 await rename(x.keyFile,x.keyFile+'.offline');
 assert.equal((await owner('transfer/import',request)).status,503);
 assert.equal((await owner.ok('session')).state.companies.length,0);
 await rename(x.keyFile+'.offline',x.keyFile);
 await owner.ok('transfer/import',request);
 const status=await owner.ok(statePath);assert.equal(status.lastArchive.reason,'reviewed-lite-import');
 const destination=join(x.root,'preimport.sqlite');await restoreDatabase(join(x.directory,status.lastArchive.name),destination,secret);
 assert.equal(readArchive(destination).state.companies.length,0);
 assert.equal((await owner.ok('session')).state.companies[0].name,'Synthetic imported company');
});

const browserExe=process.env.FIRMQUILL_BROWSER_EXE;
test('actual ERP owner can set and verify the managed backup policy without seeing host secrets',{skip:!browserExe},async t=>{
 const x=await setup(t),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:browserExe,headless:true});t.after(()=>browser.close());
 const shotDir=process.env.FIRMQUILL_BACKUP_SHOTS;
 const shot=async(p,n)=>{if(shotDir){await mkdir(shotDir,{recursive:true});await p.screenshot({path:join(shotDir,n+'.png'),fullPage:true});}};
 const login=async(user)=>{const page=await browser.newPage({viewport:{width:1300,height:930}});page.setDefaultTimeout(12000);await page.goto(x.suite.mainUrl);await page.locator('#login [name=username]').fill(user);await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click();await acceptFixtureBrowser(page);await page.locator('.toolbar').waitFor();return page;};
 const p=await login('owner'),m=await login('manager');
 assert.equal(await m.locator('[data-key="Managed backups"]').count(),0);
 await p.locator('[data-key="Managed backups"]').click();
 await p.getByText('No completed encrypted archive is recorded at the current destination.',{exact:true}).waitFor();
 await p.getByRole('button',{name:'Edit backup policy'}).click();
 const dialog=p.locator('dialog[open]');
 await dialog.getByRole('textbox',{name:'Daily UTC time (HH:MM)'}).fill('12:00');
 await dialog.getByRole('checkbox',{name:/Require an encrypted backup/}).check();
 await shot(p,'01-managed-backup-settings');
 await dialog.getByRole('button',{name:'Save backup policy'}).click();
 await p.getByText('Backup policy saved.',{exact:true}).waitFor();
 x.clock('2026-10-01T12:00:00Z');
 const owner=await client(x.suite.mainUrl);
 await next(async()=>{const s=await owner.ok(statePath);return !s.running&&s.lastArchive;});
 await p.getByRole('button',{name:'Refresh',exact:true}).click();
 await p.getByRole('heading',{name:'Last completed encrypted archive still present'}).waitFor();
 const body=await p.locator('body').innerText();
 assert.match(body,/does not mean a full restore was tested/);assert.ok(!body.includes(x.root)&&!body.includes(secret));
 await shot(p,'02-encrypted-archive-status');
});
