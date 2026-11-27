import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {newVault,apply} from '../shared/core.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {fixtureAgreement,acceptFixtureBrowser,seedFixtureTerms} from './fixture-terms.mjs';

const password='Fictional close fixture 2026 only!';
const period='2026-10',cutoff=period+'-31';
async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'fq-close-fixture-')),database=join(folder,'fixture.sqlite');
  let state=newVault('Fictional Harborline October',['products','stock']),companyId=state.companies[0].id,
    book=()=>state.companies[0],post=(type,date,fields)=>{state=apply(state,companyId,{type,date,...fields});return book().docs.at(-1)?.id;};
  post('contact','2026-09-24',{kind:'Customer',name:'October buyer <fictional>'});
  post('contact','2026-09-24',{kind:'Vendor',name:'October seller'});
  post('item','2026-09-24',{kind:'Service',name:'Fictional handling'});
  const item=book().items[0].id,[customer,vendor]=book().parties.map(p=>p.id);
  const quote=post('quote','2026-10-10',{party:customer,item,qty:2,unit:5000});
  const order=post('sales order','2026-10-11',{parent:quote});
  const fulfilled=post('fulfillment','2026-10-12',{parent:order});
  const invoice=post('invoice','2026-10-13',{parent:fulfilled});
  post('collection','2026-10-14',{parent:invoice,amount:1000});
  post('collection','2026-11-01',{parent:invoice,amount:2000});
  const po=post('purchase order','2026-10-10',{party:vendor,item,qty:2,unit:3000});
  const receipt=post('receiving','2026-10-11',{parent:po});
  const bill=post('bill','2026-10-12',{parent:receipt});
  post('payment','2026-10-14',{parent:bill,amount:1000});
  post('payment','2026-11-04',{parent:bill,amount:2000});
  post('journal','2026-09-28',{label:'Member contribution',lines:[['1000',50000],['3000',-50000]],flow:'Financing'});
  const ent=book().entries.at(-1).id;
  post('statement import','2026-09-30',{rows:[{date:'2026-09-28',sourceRef:'fixture-1',description:'Bank contribution',amountCents:50000}]});
  post('match','2026-09-30',{row:book().bank.at(-1).id,entry:ent});
  post('reconcile','2026-09-30',{closing:50000});
  post('statement import','2026-10-30',{rows:[{date:'2026-10-14',sourceRef:'fixture-2',description:'October unlinked',amountCents:-1000}]});
  post('company','2026-10-30',{name:'Independent fixture company',activities:[]});
  const other=state.companies.at(-1).id,db=openStore(database),hash=await passwordHash(password);
  try{tx(db,()=>{
    saveBooks(db,state);
    for(const [username,role,assign,areas] of [
      ['owner','owner',[]],['clerk','bookkeeper',[companyId]],['manager','manager',[companyId]],['other','manager',[other]],['restricted','manager',[companyId],['Accounting','Reports']]
    ])putUser(db,null,{username,name:'Fixture '+username,role,assignments:assign,areas},hash,{bootstrap:true});
    seedFixtureTerms(db);
  });}finally{db.close();}
  let suite=await createSuite({database,mainPort:0,workerPort:0});
  t.after(async()=>{await suite.close();await rm(folder,{recursive:true,force:true});});
  return {suite,companyId,other,async restart(){const p=+new URL(suite.mainUrl).port,q=+new URL(suite.workerUrl).port;await suite.close();suite=await createSuite({database,mainPort:p,workerPort:q});return suite;}};
}
async function client(origin,username){
  let cookie='',csrf='';
  const req=async(path,body,override)=>{const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...override},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};};
  const r=await req('login',{username,password});assert.equal(r.status,200,JSON.stringify(r.data));cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;
  if(r.data.termsRequired)assert.equal((await req('terms',fixtureAgreement)).status,200);return req;
}
const view=(id)=>'month-end-close?companyId='+id+'&period='+period;
const download=(id)=>'month-end-close/packet?companyId='+id+'&period='+period;
const close=async(request,id,data,kind,note='Review fixture and track cash items')=>request(view(id),{action:{type:kind,period,version:data.status?.version??0,digest:data.digest,note,reviewed:true}});
const journal=async(req,companyId,date,label)=>req('action',{companyId,revision:(await req('session')).data.revision,action:{type:'journal',date,label,lines:[['1000',50],['3000',-50]],flow:'Financing',requestId:'request_'+label.replaceAll(' ','_')}});

test('month close HTTP validates dated amounts, separation, current holds, packet and period lock',async t=>{
  const f=await fixture(t),{companyId:id,other}=f;
  const owner=await client(f.suite.mainUrl,'owner'),clerk=await client(f.suite.mainUrl,'clerk'),manager=await client(f.suite.mainUrl,'manager'),
    restricted=await client(f.suite.mainUrl,'restricted'),outsider=await client(f.suite.mainUrl,'other');
  let v=(await owner(view(id))).data;
  assert.equal(v.packet.arTotal,9000);assert.equal(v.packet.apTotal,5000);assert.equal(v.packet.arVariance,0);assert.equal(v.packet.apVariance,0);
  assert.equal(v.packet.report.closingCash,50000);assert.equal(v.packet.bank.latest.date,'2026-09-30');
  assert.equal(v.packet.bank.rows[0].status,'Unmatched at cutoff');assert.equal(v.packet.bank.unmatchedCash.length,2);
  assert.equal((await owner(download(id))).status,404);
  for(const u of [restricted,outsider])assert.equal((await u(view(id))).status,403);
  assert.equal((await clerk(view(other))).status,403);
  assert.equal((await owner(view(id),{action:{type:'prepare',period,version:0,digest:v.digest,note:'fixture'}},{'X-CSRF-Token':'bad'})).status,403);
  const later=await journal(clerk,id,'2026-11-09','Future approval');assert.equal(later.status,200);
  assert.equal((await owner(view(id))).data.digest,v.digest);
  const pending=await journal(clerk,id,'2026-10-18','October approval');assert.equal(pending.status,200);
  assert.equal((await close(clerk,id,v,'prepare')).status,409,'preview digest goes stale on a relevant approval');
  v=(await clerk(view(id))).data;assert.equal(v.packet.approvals.length,1);assert.equal(v.allowedSign,false);
  const prep=await close(clerk,id,v,'prepare','Reviewed ledgers and bank fixture');assert.equal(prep.status,200,JSON.stringify(prep.data));
  assert.equal((await close(clerk,id,prep.data,'sign')).status,403);
  assert.equal((await close(manager,id,prep.data,'sign')).status,409,'pending required approval');
  const legacy=await owner('action',{companyId:id,revision:(await owner('session')).data.revision,action:{type:'close',date:cutoff,requestId:'legacy-close-fixture'}});
  assert.equal(legacy.status,409);
  const decision=await manager('approve',{id:pending.data.pendingApproval,decision:'reject',revision:(await manager('session')).data.revision});
  assert.equal(decision.status,200,JSON.stringify(decision.data));
  assert.equal((await manager(view(id))).data.stale,true);
  assert.equal((await close(manager,id,prep.data,'sign')).status,409);
  v=(await close(clerk,id,(await clerk(view(id))).data,'prepare')).data;
  const signed=await close(manager,id,v,'sign','Open amounts and cash exceptions reviewed; dated approval was rejected.');
  assert.equal(signed.status,200,JSON.stringify(signed.data));assert.equal(signed.data.status.status,'signed');assert.equal(signed.data.closedThrough,cutoff);
  const packet=(await owner(download(id))).data;assert.notEqual(packet.signOff.signer,packet.signOff.preparer);assert.equal(packet.approvals.length,0);
  assert.equal((await journal(owner,id,'2026-10-30','Past forbidden entry')).status,400);
  assert.equal((await journal(owner,id,'2026-11-08','Next period entry')).status,200);
  const history=(await owner('audit')).data.events;
  assert.ok(history.some(x=>x.kind==='month-end signed'&&x.detail.includes('separate preparer and signer')));
  const fresh=await client((await f.restart()).mainUrl,'owner');
  assert.deepEqual((await fresh(download(id))).data,packet);
  assert.equal((await fresh(view(id))).data.status.status,'signed');
});

test('company-wide close does not disclose a protected project or its packet to a finance role',async t=>{
  const {suite,companyId}=await fixture(t),owner=await client(suite.mainUrl,'owner'),manager=await client(suite.mainUrl,'manager');
  const project=await owner('projects',{action:{type:'project-save',companyId,departmentId:'legal',visibility:'restricted',name:'Hidden synthetic project',readers:[]}});
  assert.equal(project.status,200,JSON.stringify(project.data));
  assert.equal((await manager(view(companyId))).status,403);
  assert.equal((await manager(download(companyId))).status,403);
  assert.equal((await owner(view(companyId))).status,200);
  assert.ok(!(await manager('session')).data.user.workspaces.includes('Month-end close'));
});

const chromiumPath=process.env.FIRMQUILL_BROWSER_EXE;
test('browser prepares as clerk and signs as owner, downloads two formats, and reloads signed packet',{skip:!chromiumPath},async t=>{
  const x=await fixture(t),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:chromiumPath,headless:true});t.after(()=>browser.close());
  const folder=process.env.FIRMQUILL_CLOSE_SCREENSHOTS;
  const shot=async(p,n)=>{if(folder){await mkdir(folder,{recursive:true});await p.screenshot({path:join(folder,n+'.png'),fullPage:true});}};
  const enter=async(username)=>{
    const p=await browser.newPage({viewport:{width:1340,height:940}});p.setDefaultTimeout(10000);
    await p.goto(x.suite.mainUrl);await p.locator('#login [name=username]').fill(username);await p.locator('#login [name=password]').fill(password);await p.locator('#login button').click();await acceptFixtureBrowser(p);
    await p.locator('[data-act=nav][data-key="Month-end close"]').click();
    await p.getByRole('button',{name:'Choose month'}).click();await p.locator('dialog [name=period]').fill(period);
    await p.getByRole('button',{name:'View month'}).click();
    await p.getByText(/through 2026-10-31/).waitFor();
    return p;
  };
  const clerk=await enter('clerk');await clerk.getByRole('heading',{name:'Trial balance at cutoff'}).waitFor();await shot(clerk,'01-dated-close-review');
  await clerk.getByRole('button',{name:'Prepare close',exact:true}).click();await clerk.locator('dialog [name=note]').fill('Fixture: trial, open invoices and bank lines compared.');
  await clerk.getByRole('button',{name:'Save prepared close'}).click();await clerk.getByText(/awaiting sign-off/).first().waitFor();
  assert.equal(await clerk.getByRole('button',{name:'Sign and lock period'}).count(),0);
  await shot(clerk,'02-clerk-prepared-not-posted');
  const owner=await enter('owner');await owner.getByRole('button',{name:'Sign and lock period'}).click();
  await owner.locator('dialog [name=note]').fill('Reviewed outstanding amounts and documented unmatched cash as depositor follow-up.');
  await owner.locator('dialog [name=reviewed]').check();await shot(owner,'03-owner-review-before-lock');
  await owner.locator('dialog').getByRole('button',{name:'Sign and lock period'}).click();
  await owner.getByText(/Signed and locked/).first().waitFor();await shot(owner,'04-signed-locked-and-downloadable');
  const get=async name=>{const [d]=await Promise.all([owner.waitForEvent('download'),owner.getByRole('button',{name}).click()]);return readFile(await d.path(),'utf8');};
  const json=JSON.parse(await get('Download JSON close packet'));assert.equal(json.cutoff,cutoff);assert.equal(json.arTotal,9000);
  const html=await get('Download printable close packet');assert.match(html,/October buyer &lt;fictional&gt;/);assert.ok(!html.includes('October buyer <fictional>'));
  const reused=await enter('owner');await reused.getByText(/Signed and locked/).first().waitFor();
  await reused.getByRole('button',{name:'Download JSON close packet'}).waitFor();
});
