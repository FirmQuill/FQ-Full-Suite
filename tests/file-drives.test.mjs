import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {saveAreas} from '../access.mjs';
import {newVault,apply} from '../shared/core.mjs';
import {initializeCollaborationGroups,groupAdminCommand} from '../collaboration-groups.mjs';
import {createSuite} from '../server.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';
import {MAX_DRIVE_FILE_BYTES,MAX_DRIVE_TOTAL_BYTES,createDriveService} from '../file-drives.mjs';
import {seedFixtureTerms,fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';

const password='Fictional file drives password 2026!';
const companyQuery=(companyId,extras={})=>new URLSearchParams({companyId,...extras}).toString();
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'fq-drive-')),database=join(dir,'drive.sqlite');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 let state=newVault('Fixture company',['employees']);
 const companyId=state.companies[0].id;
 state=apply(state,companyId,{type:'employee',date:'2026-01-01',name:'Fixture Worker',rate:2400,state:'WA',locality:'Fictional'});
 const employeeId=state.companies[0].employees[0].id;
 state=apply(state,companyId,{type:'company',date:'2026-01-01',name:'Separate company',activities:[]});
 const otherCompany=state.companies.at(-1).id;
 let db=openStore(database),groupId;
 const ids={},hash=await passwordHash(password);
 try{
   initializeCollaborationGroups(db);
   tx(db,()=>{
     saveBooks(db,state);
     for(const [username,role,assigned] of [['drive-owner','owner',[]],['drive-member','viewer',[companyId]],['drive-nonmember','manager',[companyId]],['drive-worker','worker',[companyId]],['drive-outsider','manager',[otherCompany]]])
       ids[username]=putUser(db,null,{username,name:username,role,assignments:assigned,employeeId:role==='worker'?employeeId:'',areas:username==='drive-member'?['Directory']:['Directory','Drives']},hash,{bootstrap:true});
     groupId=groupAdminCommand(db,{id:ids['drive-owner'],role:'owner'},{companyId,state},{type:'save',name:'Inventory team',memberIds:[ids['drive-member'],ids['drive-worker']]}).groups[0].id;
   });
   seedFixtureTerms(db);
   db.prepare('DELETE FROM terms_acceptance_hashes WHERE account_id=?').run(ids['drive-outsider']);
 }finally{db.close();}
 return {dir,database,state,companyId,employeeId,otherCompany,groupId,ids};
}
async function client(url,username){
 let cookie='',csrf='';
 const request=async(path,{body,bytes,filename,csrfOverride,origin=url}={})=>{
  const response=await fetch(url+'/api/'+path,{method:body===undefined&&bytes===undefined?'GET':'POST',
    headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrfOverride??csrf,'Content-Type':bytes===undefined?'application/json':'application/octet-stream',...(filename===undefined?{}:{'X-Drive-Filename':encodeURIComponent(filename)})},
    body:bytes??(body===undefined?undefined:JSON.stringify(body))});
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  const data=response.headers.get('content-type')?.startsWith('application/octet-stream')?Buffer.from(await response.arrayBuffer()):await response.json();
  if(data.csrf)csrf=data.csrf;
  return {status:response.status,data,headers:response.headers};
 };
 const login=await request('login',{body:{username,password}});
 assert.equal(login.status,200);
 return {request,login};
}

test('drives use real portal sessions, enforce scopes and revocation, and survive encrypted recovery',async t=>{
 const f=await fixture(t),suite=await createSuite({database:f.database,mainPort:0,workerPort:0});let running=true;
 t.after(async()=>{if(running)await suite.close();});
 const owner=await client(suite.mainUrl,'drive-owner'),member=await client(suite.mainUrl,'drive-member'),
       nonmember=await client(suite.mainUrl,'drive-nonmember'),worker=await client(suite.workerUrl,'drive-worker'),
       outsider=await client(suite.mainUrl,'drive-outsider');
 const p=companyQuery(f.companyId),g=companyQuery(f.companyId,{groupId:f.groupId});
 assert.equal((await outsider.request('drives/list?'+p)).status,428);
 await outsider.request('terms',{body:fixtureAgreement});
 assert.equal((await outsider.request('drives/list?'+p)).status,404);
 assert.equal((await outsider.request('drives/list?'+companyQuery(f.otherCompany,{groupId:f.groupId}))).status,404);
 assert.equal((await member.request('drives/list?'+p)).status,403);
 assert.equal((await member.request('drives/list?'+g)).status,403);
 assert.equal((await member.request('drives/upload?'+p,{bytes:Buffer.from('x'),filename:'without grant.txt'})).status,403);
 const grants=openStore(f.database);try{saveAreas(grants,f.ids['drive-member'],['Directory','Drives']);}finally{grants.close();}
 assert.equal((await member.request('drives/list?'+p)).data.groups[0].id,f.groupId);
 assert.equal((await owner.request('drives/list?'+g)).status,404);
 assert.equal((await worker.request('drives/list?'+p)).status,404);
 const folder=(await member.request('drives/action?'+p,{body:{type:'folder',name:'Working files'}})).data;
 assert.equal(folder.kind,'folder');
 const query=companyQuery(f.companyId,{folderId:folder.id});
 const binary=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>not an inline document</text></svg>');
 assert.equal((await member.request('drives/upload?'+query,{bytes:binary,filename:'A.svg',csrfOverride:'wrong'})).status,403);
 assert.equal((await member.request('drives/upload?'+query,{bytes:binary,filename:'A.svg',origin:'http://example.invalid'})).status,403);
 assert.equal((await member.request('drives/upload?'+query,{bytes:binary,filename:'../escape'})).status,400);
 assert.equal((await member.request('drives/upload?'+query,{bytes:binary,filename:'NUL.txt'})).status,400);
 const uploaded=await member.request('drives/upload?'+query,{bytes:binary,filename:'Résumé.svg'});
 assert.equal(uploaded.status,200,JSON.stringify(uploaded.data));assert.equal(uploaded.data.size,binary.length);
 assert.ok(!('blob' in uploaded.data));
 assert.equal((await member.request('drives/upload?'+query,{bytes:binary,filename:'RÉSUMÉ.SVG'})).status,409);
 const d=companyQuery(f.companyId,{id:uploaded.data.id}),download=await member.request('drives/download?'+d);
 assert.equal(download.status,200);assert.deepEqual(download.data,binary);
 assert.match(download.headers.get('content-disposition'),/^attachment;.*filename\*=UTF-8''R%C3%A9sum%C3%A9.svg$/);
 assert.equal(download.headers.get('x-content-type-options'),'nosniff');
 assert.equal(download.headers.get('cache-control'),'no-store');
 assert.equal((await owner.request('drives/download?'+d)).status,404);
 assert.equal((await nonmember.request('drives/list?'+query)).status,404);
 assert.equal((await member.request('drives/action?'+p,{body:{type:'delete',id:folder.id}})).status,409);
 assert.equal((await member.request('drives/upload?'+p,{bytes:Buffer.alloc(MAX_DRIVE_FILE_BYTES+1),filename:'large.dat'})).status,413);
 const db=openStore(f.database);
 try{
  assert.equal((await owner.request('admin/employee-features',{body:{companyId:f.companyId,employeeId:f.employeeId,features:['Drives']}})).status,200);
  const groupFile=(await member.request('drives/upload?'+g,{bytes:binary,filename:'Team.svg'})).data;
  const byGroup=companyQuery(f.companyId,{groupId:f.groupId,id:groupFile.id});
  assert.equal((await worker.request('session')).data.driveCompanyId,f.companyId);
  assert.equal((await worker.request('drives/download?'+byGroup)).status,200);
  assert.equal((await worker.request('drives/download?'+d)).status,404);
  assert.equal((await nonmember.request('drives/download?'+byGroup)).status,404);
  assert.equal((await worker.request('drives/action?'+g,{body:{type:'delete',id:groupFile.id}})).status,404);
  const workerFile=await worker.request('drives/upload?'+g,{bytes:Buffer.from([0,127,255]),filename:'Worker.dat'});
  assert.equal(workerFile.status,200);
  db.prepare('DELETE FROM collaboration_group_members WHERE group_id=? AND account_id=?').run(f.groupId,f.ids['drive-worker']);
  assert.equal((await worker.request('drives/download?'+byGroup)).status,404);
  assert.deepEqual((await worker.request('drives/list?'+p)).data.groups,[]);
  assert.equal((await owner.request('drives/download?'+byGroup)).status,404);
  assert.equal((await member.request('drives/download?'+byGroup)).status,200);

  const service=createDriveService(db);
  const access={userId:f.ids['drive-member'],companyId:f.companyId};
  for(let i=0;i<3;i++)service.createFromBytes(access,'',{filename:'capacity'+i+'.dat',data:Buffer.alloc(MAX_DRIVE_FILE_BYTES,i+1)});
  assert.equal(MAX_DRIVE_TOTAL_BYTES,4*MAX_DRIVE_FILE_BYTES);
  assert.throws(()=>service.createFromBytes(access,'',{filename:'over-quota.dat',data:Buffer.alloc(MAX_DRIVE_FILE_BYTES)}),{status:413});
 }finally{db.close();}
 await suite.close();running=false;
 const archive=join(f.dir,'encrypted.fqdb'),restored=join(f.dir,'restored.sqlite');
 await backupDatabase(f.database,archive,password);
 assert.ok(!(await readFile(archive)).includes(binary));
 await restoreDatabase(archive,restored,password);
 const restoredDb=openStore(restored);
 try{
  const service=createDriveService(restoredDb);
  const access={userId:f.ids['drive-member'],companyId:f.companyId};
  assert.deepEqual(service.authorizeRead(access,uploaded.data.id).data,binary);
  assert.throws(()=>service.authorizeRead({...access,userId:f.ids['drive-owner']},uploaded.data.id),{status:404});
  assert.throws(()=>service.authorizeRead({...access,companyId:f.otherCompany},uploaded.data.id),{status:404});
 }finally{restoredDb.close();}
});

const browserExe=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('Chromium uploads and downloads in both actual portals with worker access opt-in',{skip:!browserExe},async t=>{
 const f=await fixture(t),suite=await createSuite({database:f.database,mainPort:0,workerPort:0});
 t.after(()=>suite.close());
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({executablePath:browserExe,headless:true});t.after(()=>browser.close());
 const errors=[];
 const page=async(url,username)=>{
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1380,height:1000}}),p=await context.newPage();
  p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
  await p.goto(url);await p.locator('#login [name=username]').fill(username);await p.locator('#login [name=password]').fill(password);
  await p.locator('#login button').click();await acceptFixtureBrowser(p);return p;
 };
 const owner=await page(suite.mainUrl,'drive-owner');
 await owner.locator('[data-act=nav][data-key="Identity connectors"]').click();
 // Opt in using the production action; the worker tab never comes from a URL hint.
 const status=await owner.evaluate(async(fields)=>{
   const me=await fetch('/api/session').then(r=>r.json());
   const r=await fetch('/api/admin/employee-features',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf},body:JSON.stringify(fields)});
   return r.status;
 },{companyId:f.companyId,employeeId:f.employeeId,features:['Drives']});assert.equal(status,200);
 const worker=await page(suite.workerUrl,'drive-worker');
 const member=await page(suite.mainUrl,'drive-member');
 assert.equal(await member.locator('[data-act=nav][data-key=Drives]').count(),0);
 const grants=openStore(f.database);try{saveAreas(grants,f.ids['drive-member'],['Directory','Drives']);}finally{grants.close();}
 await member.reload();
 await member.locator('[data-act=nav][data-key=Drives]').click();
 await member.getByLabel('Drive',{exact:true}).selectOption(f.groupId);
 await member.getByRole('heading',{name:'Group drive',exact:true}).waitFor();
 await member.getByLabel('New folder name').fill('Current work');
 await member.getByRole('button',{name:'Create folder'}).click();
 await member.getByRole('button',{name:'Current work',exact:true}).click();
 await member.getByRole('navigation',{name:'Folders'}).getByRole('button',{name:'Current work',exact:true}).waitFor();
 const bytes=Buffer.from('Synthetic staff file\n');
 await member.getByLabel('File to upload (4 MiB max)').setInputFiles({name:'Shared note.txt',mimeType:'text/plain',buffer:bytes});
 await member.getByRole('button',{name:'Upload file'}).click();
 await member.getByRole('link',{name:'Shared note.txt'}).waitFor();
 await worker.getByRole('button',{name:'Drives',exact:true}).click();
 await worker.getByLabel('Drive',{exact:true}).selectOption(f.groupId);
 await worker.getByRole('button',{name:'Current work',exact:true}).click();
 const downloaded=worker.waitForEvent('download');
 await worker.getByRole('link',{name:'Shared note.txt'}).click();
 const file=await downloaded;assert.equal(file.suggestedFilename(),'Shared note.txt');
 assert.deepEqual(await readFile(await file.path()),bytes);
 await worker.getByLabel('File to upload (4 MiB max)').setInputFiles({name:'Worker response.txt',mimeType:'text/plain',buffer:Buffer.from('Worker response')});
 await worker.getByRole('button',{name:'Upload file'}).click();
 await worker.getByRole('link',{name:'Worker response.txt'}).waitFor();
 assert.deepEqual(errors,[]);
});
