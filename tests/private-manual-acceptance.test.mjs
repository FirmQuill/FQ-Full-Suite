import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createSupportService,INSTALLED_VERSION} from '../support.mjs';
const directory=process.env.FIRMQUILL_PRIVATE_MANUAL;
test('external private upgrade manual articles cite this installed version and preserve setup-only default scope',{skip:!directory},async()=>{
 const service=createSupportService({documentationRoot:join(resolve(directory),'docs')}),info=await service.info();assert.equal(info.version,INSTALLED_VERSION);assert.equal(info.scope,'private-customer-manual');assert.equal(info.companyDataAccess,false);
 for(const id of ['edition-parity','departments','project-tracker','asset-pallets','inventory-audits','upgrade-recovery']){const article=await service.article(id);assert.equal(article.version,INSTALLED_VERSION);assert.ok(article.body.length>1000);}
 for(const [q,id] of [['pallet movement contents','asset-pallets'],['auditor count discrepancy','inventory-audits'],['project worker staffing access','project-tracker']]){const answer=await service.answer(q);assert.ok(answer.citations.some(c=>c.id===id),q);assert.ok(answer.citations.every(c=>c.version===INSTALLED_VERSION));}
 const defaults=await createSupportService().info();assert.equal(defaults.articles.length,5);assert.ok(!defaults.articles.some(a=>a.id==='inventory-audits'));
 const imageIndex=JSON.parse(await readFile(join(directory,'screenshots/index.json'),'utf8'));assert.ok(imageIndex.screenshots.length>=60);
 for(const line of (await readFile(join(directory,'SHA256SUMS.txt'),'utf8')).trim().split('\n')){const [hash,file]=line.split('  ');assert.equal(createHash('sha256').update(await readFile(join(directory,file))).digest('hex'),hash,file);}
});
test('buyer manual opens and searches offline with local screenshots and no network',{skip:!directory||!process.env.FIRMQUILL_BROWSER_EXE},async()=>{
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');const browser=await chromium.launch({executablePath:process.env.FIRMQUILL_BROWSER_EXE,headless:true});
 try{const context=await browser.newContext({offline:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(join(directory,'index.html')).href);
 await page.locator('#search').fill('auditor count');await page.locator('#results button[data-id="inventory-audits"]').click();assert.match(await page.locator('article#inventory-audits').innerText(),/Submit observations/);
 await page.locator('article#inventory-audits img').first().scrollIntoViewIfNeeded();await page.locator('article#inventory-audits img').first().evaluate(async img=>{if(!img.complete)await new Promise(r=>img.addEventListener('load',r,{once:true}));});assert.ok(await page.locator('article#inventory-audits img').first().evaluate(i=>i.naturalWidth>0));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
