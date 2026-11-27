import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {visibleNavigation,navigationGroupMarkup,workflowOnSidebar} from '../web/main/navigation-groups.mjs';

test('grouped navigation preserves authorized routes once and uses separate focusable department and chevron controls',()=>{
 const routes=['Overview','Sales','Accounting','Warehouse','Employee records','Messages','User access','Setup help'];
 const groups=visibleNavigation(routes,{canCreateCompany:true});
 assert.deepEqual(groups.map(g=>g.title),['Workspace','Sales & purchasing','Finance & reporting','Operations','HR','Collaboration','Administration','Help']);
 assert.deepEqual(groups.flatMap(g=>g.links),routes);
 assert.deepEqual(groups.filter(g=>g.canCreateCompany).map(g=>g.title),['Administration']);
 const viewer=visibleNavigation(['Warehouse','Setup help','Warehouse']);
 assert.deepEqual(viewer.flatMap(g=>g.links),['Warehouse','Setup help']);
 assert.ok(viewer.every(g=>!g.canCreateCompany));
 const folded=navigationGroupMarkup(groups[4],{open:false,active:true,links:'<button>Employee records</button>'});
 assert.match(folded,/data-act="nav-section"[^>]+aria-current="page"/);
 assert.match(folded,/data-act="nav-fold"[^>]+aria-expanded="false" aria-controls="nav-hr"/);
 assert.match(folded,/id="nav-hr" class="navgroup-links" hidden/);
 assert.match(navigationGroupMarkup(groups[4]),/aria-expanded="true"/);
});
test('sidebar feature preferences keep role-authorized essentials while filtering configured business links',()=>{
 const modules=['Accounting','Reports','Sales','Purchasing','Payroll','Fixed assets'];
 const candidates=['Directory','Sales','Purchasing','Purchase requests','Accounting','Month-end close','Report builder','Reports','Payroll','Employee records','Project tracker','Assets & pallets','Version Upgrade','Company setup','Setup help'];
 const render=features=>visibleNavigation(candidates.filter(k=>workflowOnSidebar(k,features,modules))).flatMap(g=>g.links);
 const visible=render(['Reports']);
 for(const key of ['Directory','Report builder','Reports','Employee records','Project tracker','Assets & pallets','Version Upgrade','Company setup','Setup help'])assert.ok(visible.includes(key),key);
 for(const key of ['Sales','Purchasing','Purchase requests','Accounting','Month-end close','Payroll'])assert.ok(!visible.includes(key),key);
 assert.ok(render(['Purchasing']).includes('Purchase requests'));
 assert.ok(!visibleNavigation(['Directory']).flatMap(g=>g.links).includes('Version Upgrade'));
});

test('packaged ERP and worker serve standalone read-only Legal, approved terms, and same-origin navigation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'fq-nav-artifact-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime');await buildPublicRelease(runtime);
 const {createSuite}=await import(pathToFileURL(join(runtime,'server.mjs')));
 const s=await createSuite({database:join(root,'fictional.sqlite'),mainPort:0,workerPort:0});
 const get=async(url,path)=>{const r=await fetch(url+path);assert.equal(r.status,200,path);return r.text();};
 try{
  for(const endpoint of [s.mainUrl,s.workerUrl]){
   const legal=await get(endpoint,'/legal/legal.html');assert.match(legal,/Early Development/);assert.match(legal,/\/legal\/privacy\.html/);assert.match(legal,/does not record Terms acceptance/);
   assert.match(await get(endpoint,'/legal/legal.mjs'),/import \{termsText\} from '.\/terms\.mjs'/);
   assert.deepEqual(await get(endpoint,'/legal/terms.mjs'),await readFile(new URL('../web/legal/terms.mjs',import.meta.url),'utf8'));
   assert.match(await get(endpoint,'/app.mjs'),/href="\/legal\/legal\.html"/);
  }
  const main=await get(s.mainUrl,'/app.mjs');assert.match(main,/<h1\$\{activeGroup\?' data-department-heading/);assert.match(main,/!activeGroup&&c&&page==='Overview'&&allowed\('Sales'\)\?btn\('quote'/);assert.doesNotMatch(main,/FirmQuill · Full Suite preview/);assert.match(main,/Asset workspace unavailable\./);
  assert.match(await get(s.mainUrl,'/navigation-groups.mjs'),/Finance & reporting/);
  assert.equal((await fetch(s.workerUrl+'/navigation-groups.mjs')).status,404);
 }finally{await s.close();}
});
