import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {newVault,apply} from '../shared/core.mjs';
import {saveAreas} from '../access.mjs';
import {createSuite} from '../server.mjs';
import {seedFixtureTerms} from './fixture-terms.mjs';

const password='Fictional company knowledge password';
test('company knowledge HTTP scope, independent grants, history, published worker search and escaped browser rendering',{timeout:40000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fq-knowledge-test-')),database=join(dir,'knowledge.sqlite');
 let suite,browser,company,other;
 try{
   let state=newVault('Redwood Test');company=state.companies[0].id;
   state=apply(state,company,{type:'employee',date:'2026-01-01',name:'Reader Employee',rate:2500,state:'WA',locality:'Test'});
   state=apply(state,company,{type:'company',date:'2026-01-01',name:'Separate Employer',activities:[]});
   other=state.companies[1].id;
   const employee=state.companies[0].employees[0].id;
   const db=openStore(database),hash=await passwordHash(password),ids={};
   try{
     tx(db,()=>{
       saveBooks(db,state);
       for(const [name,role,assignments] of [['owner','owner',[]],['editor','viewer',[company]],['publisher','manager',[company]],['directory','viewer',[company]],['outsider','viewer',[other]],['worker','worker',[company]]])
         ids[name]=putUser(db,null,{username:'know-'+name,name,role,assignments,employeeId:name==='worker'?employee:''},hash,{bootstrap:true});
       saveAreas(db,ids.editor,['Company knowledge']);saveAreas(db,ids.publisher,['Company knowledge']);
       saveAreas(db,ids.directory,['Directory']);
     });
     seedFixtureTerms(db);
   }finally{db.close();}
   suite=await createSuite({database,mainPort:0,workerPort:0});
   const login=async name=>{
     const origin=name==='worker'?suite.workerUrl:suite.mainUrl;
     const l=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'know-'+name,password})});assert.equal(l.status,200);
     const cookie=l.headers.get('set-cookie').split(';')[0],s=await l.json();
     return async (path,body)=>{
       const r=await fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body?JSON.stringify(body):undefined});
       return {status:r.status,data:await r.json()};
     };
   };
   const o=await login('owner'),e=await login('editor'),p=await login('publisher'),u=await login('outsider'),w=await login('worker');
   const path='company-knowledge?companyId='+company,own=await o(path);
   assert.deepEqual(own.data.rights,{edit:true,publish:true,manage:true});
   assert.equal((await u(path)).status,404);
   assert.equal((await (await login('directory'))(path)).status,403,'Directory-only access never includes company knowledge');
   assert.equal((await w('company-knowledge')).status,403);
   assert.equal((await e(path,{type:'save',title:'No permission',body:'Denied'})).status,403);
   assert.equal((await o(path,{type:'grant',account:ids.outsider,role:'editor'})).status,404);
   assert.equal((await o(path,{type:'grant',account:ids.editor,role:'editor'})).status,200);
   assert.equal((await o(path,{type:'grant',account:ids.publisher,role:'publisher'})).status,200);
   let d=await e(path,{type:'save',title:'Safety checklist',category:'Operations',tags:'launch, REDWOOD',body:'Original article\n<script>globalThis.fqExecuted=1</script>'});
   assert.equal(d.status,200);
   const {id,version}=d.data.result,detail=path+'&id='+id;
   assert.equal((await o('company-knowledge?companyId='+other+'&id='+id)).status,404);
   assert.equal((await p(path,{type:'save',id,version,title:'Invalid publisher edit',body:'Denied'})).status,403);
   assert.equal((await e(path,{type:'publish',id,version})).status,403);
   assert.equal((await p(path,{type:'publish',id,version})).status,200);
   assert.equal((await o('admin/employee-features',{companyId:company,employeeId:employee,features:['Company knowledge']})).status,200);
   assert.equal((await w('company-knowledge?companyId='+other)).status,404);
   assert.equal((await w('company-knowledge?id='+id+'&version=1')).status,404);
   assert.equal((await w('company-knowledge',{type:'withdraw',id,version:2})).status,403);
   assert.deepEqual((await w('company-knowledge?q=Operations%20redwood')).data.articles.map(r=>r.title),['Safety checklist']);
   d=await e(path,{type:'save',id,version:2,title:'Secret unpublished next title',body:'Draft-only content'});
   assert.equal(d.status,200);
   assert.match((await w('company-knowledge?id='+id)).data.article.body,/Original article/);
   assert.deepEqual((await w('company-knowledge?q=draft-only')).data.articles,[]);
   assert.equal((await p(path,{type:'publish',id,version:2})).status,409);
   assert.equal((await o(detail+'&version=1')).data.article.title,'Safety checklist');
   assert.deepEqual((await e(detail)).data.history.map(r=>r.event),['Draft saved','Published','Draft saved']);
   const executable=process.env.FIRMQUILL_BROWSER_EXE;
   if(executable){
     const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
     browser=await chromium.launch({executablePath:executable,headless:true});
     const main=await browser.newPage(),worker=await browser.newPage(),errors=[];
     main.on('pageerror',x=>errors.push(x.message));worker.on('pageerror',x=>errors.push(x.message));
     async function signin(page,url,name){await page.goto(url);await page.locator('#login [name=username]').fill('know-'+name);await page.locator('#login [name=password]').fill(password);await page.locator('#login button').click();}
     await signin(main,suite.mainUrl,'owner');
     await main.locator('nav [data-key="Company knowledge"]').click();
     await main.getByRole('button',{name:'New article'}).click();
     const dialog=main.locator('dialog[open]');await dialog.locator('[name=title]').fill('Browser-created draft');await dialog.locator('textarea').fill('Plain text New article.');
     await dialog.getByRole('button',{name:'Save draft'}).click();
     await main.getByRole('heading',{name:'Browser-created draft'}).waitFor();
     await main.getByRole('button',{name:'Publish draft'}).click();await main.locator('dialog[open]').getByRole('button',{name:'Publish draft'}).click();
     await main.getByText('Published',{exact:true}).waitFor();
     await signin(worker,suite.workerUrl,'worker');
     await worker.locator('[data-tab="Company knowledge"]').click();
     const search=worker.locator('#company-knowledge-search');await search.locator('[name=query]').fill('redwood');await search.getByRole('button',{name:'Search'}).click();
     await worker.getByRole('heading',{name:'Browser-created draft'}).waitFor({state:'hidden'});
     await worker.getByRole('button',{name:'Read article'}).click();
     await worker.getByText('<script>globalThis.fqExecuted=1</script>',{exact:false}).waitFor();
     assert.equal(await worker.evaluate(()=>globalThis.fqExecuted),undefined);
     assert.deepEqual(errors,[]);
   }
   const restored=await e(path,{type:'restore',id,version:3,sourceVersion:1});
   assert.equal(restored.status,200);
   assert.equal((await e(detail)).data.article.title,'Safety checklist');
   // Read and withdraw must still work when revisions reach the content budget.
   const capped=openStore(database);
   try{
     const timestamp='2026-01-01T00:00:00.000Z';
     capped.prepare('INSERT INTO company_knowledge_articles VALUES(?,?,1,1,0,?)').run(other,'synthetic-cap',timestamp);
     capped.prepare('INSERT INTO company_knowledge_revisions VALUES(?,?,1,?,?,?,?,?,?,?,?)').run(other,'synthetic-cap','Draft saved','Capacity fixture','','[]','0'.repeat(8*1024*1024),'','worker',timestamp);
   }finally{capped.close();}
   assert.equal((await o(path,{type:'save',title:'Over capacity',body:'Reject and do not create an article.'})).status,413);
   assert.equal((await w('company-knowledge?id='+id)).status,200);
   assert.equal((await p(path,{type:'withdraw',id,version:4})).status,200);
   assert.equal((await o(detail+'&version=5')).data.article.title,'Safety checklist');
   assert.equal((await w('company-knowledge?id='+id)).status,404);
   assert.equal((await o(detail+'&version=2')).data.article.title,'Safety checklist');
   assert.equal((await o('support/info')).status,200);
 }finally{await browser?.close();await suite?.close();await rm(dir,{recursive:true,force:true});}
});
