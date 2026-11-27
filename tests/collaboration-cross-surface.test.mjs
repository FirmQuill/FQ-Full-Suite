import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newVault} from '../shared/core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';
import {saveAreas} from '../access.mjs';
import {seedFixtureTerms} from './fixture-terms.mjs';

const password='Synthetic collaboration integration only!';
const list=(base,fields)=>base+'?'+new URLSearchParams(fields);
async function signIn(base,username){
 let cookie='',csrf='';
 async function call(path,{body,bytes,filename}={}){
   const response=await fetch(base+'/api/'+path,{method:body!==undefined||bytes!==undefined?'POST':'GET',
      headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':bytes===undefined?'application/json':'application/octet-stream',...(filename?{'X-Drive-Filename':encodeURIComponent(filename)}:{})},
      body:bytes??(body===undefined?undefined:JSON.stringify(body))});
   if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
   const data=response.headers.get('content-type')?.startsWith('application/octet-stream')?Buffer.from(await response.arrayBuffer()):await response.json();
   if(data?.csrf)csrf=data.csrf;return {status:response.status,data};
 }
 const login=await call('login',{body:{username,password}});assert.equal(login.status,200);return call;
}
async function ok(client,path,options){const r=await client(path,options);assert.equal(r.status,200,JSON.stringify(r.data));return r.data}
test('one live group drives both chat and file access through removal and encrypted recovery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'firmquill-combined-private-')),database=join(dir,'company.sqlite'),restore=join(dir,'restore.sqlite'),archive=join(dir,'company.fqdb');
 let suite=null;t.after(async()=>{await suite?.close();await rm(dir,{recursive:true,force:true});});
 const state=newVault('Fictional test company'),companyId=state.companies[0].id,ids={},db=openStore(database),digest=await passwordHash(password);
 try{tx(db,()=>{saveBooks(db,state);for(const [name,role] of [['owner','owner'],['writer','bookkeeper'],['reader','viewer']])ids[name]=putUser(db,null,{username:name,name,role,assignments:role==='owner'?[]:[companyId]},digest,{bootstrap:true});for(const id of ['writer','reader'])saveAreas(db,ids[id],['Directory','Messages','Drives']);});seedFixtureTerms(db);}finally{db.close();}
 const start=database=>createSuite({database,mainPort:0,workerPort:0});
 suite=await start(database);
 let owner=await signIn(suite.mainUrl,'owner'),reader=await signIn(suite.mainUrl,'reader'),writer=await signIn(suite.mainUrl,'writer');
 const groups=list('collaboration/groups',{companyId});
 const edited=await ok(owner,groups,{body:{action:{type:'save',name:'Fictional Review Group',memberIds:[ids.writer,ids.reader]}}});
 const g=edited.groups[0],groupId=g.id,chat=list('collaboration/messages',{companyId});
 const payload=Buffer.from([0,1,127,255,5]);
 const file=await ok(writer,list('drives/upload',{companyId,groupId}),{bytes:payload,filename:'Shared.pdf'});
 const sent=await ok(writer,chat,{body:{action:{type:'send',kind:'group',target:groupId,body:'A new file is in our group drive.'}}});
 const thread=list('collaboration/messages',{companyId,threadId:sent.id}),download=list('drives/download',{companyId,groupId,id:file.id});
 assert.deepEqual(await ok(reader,download),payload);assert.equal((await ok(reader,thread)).conversation.messages.length,1);
 assert.equal((await owner(download)).status,404);assert.equal((await owner(thread)).status,404);
 await ok(owner,groups,{body:{action:{type:'save',id:groupId,version:g.version,name:g.name,memberIds:[ids.writer]}}});
 assert.equal((await reader(download)).status,404);assert.equal((await reader(thread)).status,404);
 assert.deepEqual(await ok(writer,download),payload);
 await suite.close();suite=null;
 await backupDatabase(database,archive,password);await restoreDatabase(archive,restore,password);
 suite=await start(restore);reader=await signIn(suite.mainUrl,'reader');writer=await signIn(suite.mainUrl,'writer');
 assert.equal((await reader(download)).status,404);assert.equal((await reader(thread)).status,404);
 assert.deepEqual(await ok(writer,download),payload);assert.equal((await ok(writer,thread)).conversation.messages.length,1);
});
