import {activationFixture} from './fixture-activation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {openStore,tx,saveBooks,passwordHash,putUser} from '../store.mjs';
import {saveAreas} from '../access.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {createSuite} from '../server.mjs';
import {INSTALLED_VERSION} from '../support.mjs';
import {createContextualHelp,HELP_FORMAT} from '../contextual-help.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

const version=INSTALLED_VERSION, secret='SYNTHETIC CONTEXT ONLY';
const pass='Fictional contextual test only.';
const name=role=>'fixture-'+role;
const criteria=(companyId,page='Directory',role='viewer',portal='main')=>({portal,page,role,companyId});
const article=(companyId,page,roles,portal='main',file='sample.txt')=>({companyIds:[companyId],page,roles,portal,file,title:'Fictional '+page+' guide'});
const createDir=async t=>{const folder=await mkdtemp(join(tmpdir(),'fq-context-'));t.after(()=>rm(folder,{recursive:true,force:true}));return folder;};
async function packageFiles(dir,articles){
  const index={format:HELP_FORMAT,edition:'full-suite',version,articles};
  const save=()=>writeFile(join(dir,'contextual-index.json'),JSON.stringify(index));
  await save();await writeFile(join(dir,'sample.txt'),secret+'\n\n<img src="https://example.invalid" onerror="alert(1)">');
  return {index,save};
}
test('context catalog requires exact edition, version, company, role, portal and single matching page; broken local package is optional',async t=>{
  const dir=await createDir(t),a=article('alpha','Directory',['viewer']);
  const {index,save}=await packageFiles(dir,[a]);
  const scope=criteria('alpha'),lookup=createContextualHelp({contextualRoot:dir}).lookup;
  assert.match((await lookup(scope)).body,/SYNTHETIC/);
  for(const other of [criteria('beta'),criteria('alpha','Sales'),criteria('alpha','Directory','owner'),criteria('alpha','Directory','worker','worker')])assert.deepEqual(await lookup(other),{available:false});
  for(const contextualRoot of [undefined,'.',join(dir,'missing'),new URL('../kb',import.meta.url).pathname])assert.deepEqual(await createContextualHelp({contextualRoot}).lookup(scope),{available:false});
  index.edition='lite';await save();assert.deepEqual(await lookup(scope),{available:false});index.edition='full-suite';
  index.version='2027-not-installed';await save();assert.deepEqual(await lookup(scope),{available:false});index.version=version;
  index.articles.push(a);await save();assert.deepEqual(await lookup(scope),{available:false});index.articles.pop();
  a.file='invalid.bin';await save();assert.deepEqual(await lookup(scope),{available:false});
  const outside=await createDir(t);await writeFile(join(outside,'canary.txt'),secret);await symlink(join(outside,'canary.txt'),join(dir,'external.txt'));
  a.file='external.txt';await save();assert.deepEqual(await lookup(scope),{available:false});
  a.file='sample.txt';await save();await writeFile(join(dir,'sample.txt'),'z'.repeat(128*1024+1));assert.deepEqual(await lookup(scope),{available:false});
});
async function setup(t,{licensed=true,configured=true,expires}={}){
  const dir=await createDir(t),database=join(dir,'fictional.sqlite'),ctx=join(dir,'fictional-context'),legacy=join(dir,'fictional-legacy');
  await mkdir(ctx);await mkdir(legacy);
  const state=sampleVault(),[company,other]=state.companies,[employee]=company.employees;
  company.featured=company.featured.filter(feature=>feature!=='Payroll');
  const pack=await packageFiles(ctx,[
    article(company.id,'Directory',['owner','viewer']),
    article(company.id,'Sales',['viewer']),
    article(company.id,'Payroll',['owner']),
    article(other.id,'Directory',['viewer']),
    article(company.id,'Time',['worker'],'worker'),
    article(company.id,'Pay',['worker'],'worker')
  ]);
  await writeFile(join(legacy,'index.json'),JSON.stringify({version,scope:'private-customer-manual',articles:[{id:'fictional-private',file:'sample.md',title:'Legacy fixture',status:'verified-local',keywords:['synthetic']}] }));
  await writeFile(join(legacy,'sample.md'),secret);
  const db=openStore(database);try{
    tx(db,()=>saveBooks(db,state));const hash=await passwordHash(pass);
    tx(db,()=>{
      for(const role of ['owner','viewer','worker']){
        putUser(db,null,{username:name(role),name:'Fictional '+role,role,assignments:role==='owner'?[]:[company.id],...(role==='worker'?{employeeId:employee.id}:{})},hash,{bootstrap:true});
        if(role==='viewer')saveAreas(db,db.prepare('SELECT id FROM accounts WHERE username=?').get(name(role)).id,['Directory']);
      }
      db.prepare('INSERT INTO employee_portal_flags VALUES(?,?,?)').run(company.id,employee.id,JSON.stringify(['Time']));
    });
  }finally{db.close();}
  let time=Date.now();const fx=await activationFixture(dir,{clock:()=>time,activate:licensed&&!expires?['private-support']:[]});
  const {options:activationOptions}=fx;
  const suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions,supportOptions:configured?{contextualRoot:ctx,documentationRoot:legacy}:{}});
  t.after(()=>suite.close());return {...suite,database,company,other,pack,fx,moveTime:value=>{time=value;},time};
}
async function call(base,path,{cookie,csrf,body}={}){
  const res=await fetch(base+'/api/'+path,{headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'X-CSRF-Token':csrf,'Content-Type':'application/json',Origin:base}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  return {status:res.status,cookie:res.headers.get('Set-Cookie')?.split(';')[0],data:await res.json(),cache:res.headers.get('Cache-Control')};
}
async function login(base,role){
  const session=await call(base,'login',{body:{username:name(role),password:pass}});assert.equal(session.status,200);
  return {cookie:session.cookie,csrf:session.data.csrf};
}
test('real portal HTTP uses consent, current authorization and server-derived worker company; contextual surface cannot be bypassed through legacy support',async t=>{
  const {mainUrl,workerUrl,company,other,pack}=await setup(t),directory='support/context?page=Directory&companyId='+company.id;
  assert.equal((await call(mainUrl,directory)).status,401);
  const owner=await login(mainUrl,'owner'),viewer=await login(mainUrl,'viewer'),worker=await login(workerUrl,'worker');
  assert.equal((await call(mainUrl,directory,viewer)).status,428);
  for(const [base,auth] of [[mainUrl,owner],[mainUrl,viewer],[workerUrl,worker]])assert.equal((await call(base,'terms',{...auth,body:fixtureAgreement})).status,200);
  for(const auth of [owner,viewer]){
    const r=await call(mainUrl,directory,auth);assert.equal(r.cache,'no-store');assert.ok(r.data.available);assert.match(r.data.body,/SYNTHETIC/);
  }
  for(const path of ['support/context?page=Sales&companyId='+company.id, 'support/context?page=Directory&companyId='+other.id,'support/context?page=Directory','support/context?page=Not%20real&companyId='+company.id])
    assert.equal((await call(mainUrl,path,viewer)).status,404);
  assert.equal((await call(workerUrl,'support/context?page=Time&companyId='+other.id,worker)).data.available,true);
  assert.equal((await call(workerUrl,'support/context?page=Pay',worker)).status,404);
  assert.equal((await call(workerUrl,directory,worker)).status,404);
  assert.equal((await call(mainUrl,directory,worker)).status,401);
  assert.equal((await call(mainUrl,'support/info',owner)).data.scope,'private-customer-manual');
  for(const [base,auth] of [[mainUrl,viewer],[workerUrl,worker]]){
    assert.equal((await call(base,'support/info',auth)).data.scope,'public-setup-only');
    assert.equal((await call(base,'support/article?id=fictional-private',auth)).status,404);
  }
  pack.index.edition='lite';await pack.save();assert.equal((await call(mainUrl,directory,viewer)).status,404);
  assert.equal((await call(mainUrl,'session',viewer)).status,200);
});
const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
test('sign-in through real portal, keyboard controls, content as text, mobile worker, and unavailable help without interrupting the app',{skip:!executable,timeout:60000},async t=>{
  const {mainUrl,workerUrl,database,pack}=await setup(t);
  const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||process.env.ERP_LITE_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());
  const urls=[],errors=[],shotDir=process.env.FIRMQUILL_CONTEXT_SHOTS;
  for(const [base,role,section] of [[mainUrl,'owner','Directory'],[mainUrl,'viewer','Directory'],[workerUrl,'worker','Time']]){
    const page=await browser.newPage(role==='worker'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:900}});
    page.on('request',r=>urls.push(r.url()));page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(base);await page.locator('#login [name=username]').fill(name(role));await page.locator('#login [name=password]').fill(pass);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'I agree to the Terms of Service',exact:true}).click();
    await page.getByRole('navigation').getByRole('button',{name:section,exact:true}).first().click();
    const help=page.getByRole('button',{name:'Help for '+section}),dialog=page.getByRole('dialog',{name:'Help for '+section});
    await help.focus();await page.keyboard.press('Enter');await dialog.getByText(secret,{exact:true}).waitFor();
    assert.equal(await dialog.locator('img').count(),0);
    if(shotDir){await mkdir(shotDir,{recursive:true});await page.screenshot({path:join(shotDir,'context-'+role+'.png')});}
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await help.evaluate(el=>document.activeElement===el),true);
    if(role!=='worker'){await page.getByRole('navigation').getByRole('button',{name:'Setup help',exact:true}).first().click();await page.getByRole('heading',{name:/Privately supplied customer manual|Public setup guide/}).waitFor();assert.equal(await page.getByRole('button',{name:'Help for Setup help'}).count(),0);await page.getByRole('button',{name:'Refresh',exact:true}).click();}
    else {pack.index.articles=[];await pack.save();await help.click();await help.waitFor({state:'hidden'});await page.getByRole('button',{name:'Clock in',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    await page.close();
  }
  const defaults=await createSuite({database,mainPort:0,workerPort:0});
  try{
    const fresh=await browser.newPage();await fresh.goto(defaults.mainUrl);
    await fresh.locator('#login [name=username]').fill(name('owner'));await fresh.locator('#login [name=password]').fill(pass);await fresh.getByRole('button',{name:'Sign in',exact:true}).click();
    await fresh.getByRole('navigation').getByRole('button',{name:'Setup help',exact:true}).first().click();
    await fresh.getByRole('heading',{name:'Public setup guide',exact:true}).waitFor();
    assert.equal(await fresh.getByRole('button',{name:'Help for Setup help'}).count(),0);
    if(shotDir)await fresh.screenshot({path:join(shotDir,'context-default-unavailable.png')});
    await fresh.close();
  }finally{await defaults.close();}
  assert.deepEqual(errors,[]);assert.ok(urls.every(url=>url.startsWith(mainUrl)||url.startsWith(workerUrl)));
});

test('no paid article or installed module is exposed without active signed support plus actual trusted content',async t=>{
 const missing=await setup(t,{licensed:true,configured:false});
 const unlicensed=await setup(t,{licensed:false});
 for(const f of [missing,unlicensed]){
  const a=await login(f.mainUrl,'owner');
  assert.equal((await call(f.mainUrl,'terms',{...a,body:fixtureAgreement})).status,200);
  assert.equal((await call(f.mainUrl,'support/context?page=Directory&companyId='+f.company.id+'&check=1',a)).status,404);
  assert.equal((await call(f.mainUrl,'support/context?page=Directory&companyId='+f.company.id,a)).status,404);
  assert.equal((await call(f.mainUrl,'support/info?scope=public',a)).data.scope,'public-setup-only');
  const licensing=(await call(f.mainUrl,'module-activation',a)).data;
  assert.deepEqual(licensing.eligibleModules,[]);assert.deepEqual(licensing.modules,{});
 }
 const {mainUrl,company,fx,time,moveTime}=unlicensed,owner=await login(mainUrl,'owner');
 const expiresAt=Math.floor(time/1000)+120;
 assert.equal((await call(mainUrl,'module-activation',{...owner,body:{code:fx.mint({modules:['private-support'],expiresAt})}})).status,200);
 const valid='support/context?page=Directory&companyId='+company.id;
 assert.deepEqual((await call(mainUrl,valid+'&check=1',owner)).data,{available:true,validForMs:60000});
 assert.match((await call(mainUrl,valid,owner)).data.body,/SYNTHETIC/);
 assert.deepEqual((await call(mainUrl,'module-activation',owner)).data.eligibleModules,['private-support']);
 // Visibility toggles are separate from business authority: license does not
 // cause unfeatured contextual content to show, and normal payroll stays usable.
 assert.equal((await call(mainUrl,'support/context?page=Payroll&companyId='+company.id+'&check=1',owner)).status,404);
 assert.equal((await call(mainUrl,'manual-payroll?companyId='+company.id,owner)).status,200);
 moveTime(expiresAt*1000);
 assert.equal((await call(mainUrl,valid+'&check=1',owner)).status,404);
 assert.equal((await call(mainUrl,valid,owner)).status,404);
 assert.deepEqual((await call(mainUrl,'module-activation',owner)).data.eligibleModules,[]);
});
