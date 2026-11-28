import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fixtureAddon,settingsId,serviceId,baseFileHashes} from './fixture-addon.mjs';
import {acceptFixtureBrowser} from './fixture-terms.mjs';

const executable=process.env.FIRMQUILL_BROWSER_EXE||process.env.ERP_LITE_BROWSER_EXE;
const settingsOnly=process.env.FIRMQUILL_ADDON_BROWSER_SETTINGS_ONLY==='1';

test('desktop owner installs a signed settings add-on and saves dynamic settings; no native runtime proof',{
  skip:!executable?'Browser executable not configured.':!settingsOnly?'Select the settings-only proof with FIRMQUILL_ADDON_BROWSER_SETTINGS_ONLY=1.':false,timeout:120000
},t=>browserProof(t,true));
test('desktop owner installs two signed add-ons, saves settings, and separately approves a service update',{
  skip:!executable?'Browser executable not configured.':settingsOnly?'NOTRUN: native supervisor is blocked; settings-only proof excludes service, restart, runtime workspace and automatic-write gates.':false,timeout:120000
},t=>browserProof(t,false));

async function browserProof(t,settingsOnly){
  const x=await fixtureAddon(t,{settingsOnly}),{chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],writes=[];
  const screenshots=process.env.FIRMQUILL_ADDON_SCREENSHOTS||fileURLToPath(new URL('../../addon-browser-proof/',import.meta.url));
  await mkdir(screenshots,{recursive:true});
  const baseHashes=await baseFileHashes(x.runtime),origin=x.mainUrl;
  assert.ok(origin&&x.password,'The disposable add-on fixture must expose its current mainUrl and fictional password.');
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('request',request=>{if(request.method()==='POST')writes.push(new URL(request.url()).pathname);});
  await x.stage('settings.fqaddon',x.manifest());
  if(!settingsOnly)await x.stage('service.fqaddon',x.manifest({id:serviceId,type:'service'}));

  await page.goto(origin);
  await page.locator('#login [name=username]').fill('owner');await page.locator('#login [name=password]').fill(x.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await acceptFixtureBrowser(page);
  await x.login('owner');const before=(await x.request('owner','session')).data.state;
  const navigate=async name=>{await page.locator('nav [data-act=nav]').filter({hasText:new RegExp('^'+name+'$')}).first().click();await page.getByRole('heading',{name,exact:true}).waitFor();};
  const review=async()=>{await page.getByRole('button',{name:'Review add-on folder',exact:true}).click();await page.locator('[data-addon-review] [data-addon-candidate]').first().waitFor();};
  const candidate=id=>page.locator('[data-addon-candidate]').filter({hasText:id});
  const installed=id=>page.locator('[data-addon-installed]').filter({hasText:id});
  const apply=async id=>{
    const card=candidate(id),button=card.getByRole('button',{name:'Apply add-on',exact:true});
    assert.equal(await button.isDisabled(),true,'Apply must wait for package-specific approval');
    await card.locator('[data-addon-apply-approve]').check();
    const applied=page.waitForResponse(response=>response.url()===origin+'/api/addons/apply'&&response.request().method()==='POST');
    await button.click();assert.equal((await applied).status(),200);await installed(id).waitFor();
  };
  await navigate('Packages');await review();
  assert.equal(await page.getByRole('button',{name:'Apply add-on',exact:true}).count(),0,'unlicensed packages remain unselectable');
  await navigate('Version Upgrade');
  const upgrade=page.locator('[data-version-upgrade]');assert.equal(await upgrade.getByRole('button').count(),1);
  assert.equal(await upgrade.getByRole('button',{name:'Upload signed license',exact:true}).count(),1);
  const uploaded=page.waitForResponse(response=>response.url()===origin+'/api/module-activation/upload'&&response.request().method()==='POST');
  await upgrade.locator('input[type=file]').setInputFiles({name:'fictional.fqlicense',mimeType:'text/plain',buffer:Buffer.from(x.signedLicense())});
  assert.equal((await uploaded).status(),200);
  await upgrade.getByText('Update partially complete',{exact:true}).waitFor();
  await upgrade.getByText(/Missing packages|Package error/).waitFor();
  await navigate('Packages');await review();await apply(settingsId);

  await page.locator('nav [data-key="addon/'+settingsId+'"]').click();
  const form=installed(settingsId).locator('[data-addon-settings-form]');
  await form.locator('input[type=text]').fill('Owner reviewed fixture');
  const save=form.getByRole('button',{name:'Save add-on settings',exact:true});assert.equal(await save.isDisabled(),true);
  await form.locator('[data-addon-settings-approve]').check();
  const settingsSaved=page.waitForResponse(response=>response.url()===origin+'/api/addons/settings'&&response.request().method()==='POST');
  await save.click();assert.equal((await settingsSaved).status(),200);
  await page.waitForFunction(id=>{const card=document.querySelector('[data-addon-installed][data-addon-id="'+id+'"]');return card?.querySelector('input[type=text]')?.value==='Owner reviewed fixture'&&card.querySelector('[data-addon-settings-approve]')?.checked===false;},settingsId);
  if(settingsOnly){
    const packagesShot=join(screenshots,'01-settings-only-owner-applied.png'),upgradeShot=join(screenshots,'02-settings-only-version-upgrade.png');
    await page.screenshot({path:packagesShot,fullPage:true});
    await navigate('Version Upgrade');await upgrade.getByText('Update fully complete',{exact:true}).waitFor();
    assert.equal(await upgrade.getByRole('button').count(),1);await page.screenshot({path:upgradeShot,fullPage:true});
    assert.deepEqual((await x.request('owner','session')).data.state,before,'settings operations leave fictional books unchanged');
    assert.deepEqual(await baseFileHashes(x.runtime),baseHashes,'one copied base remains unchanged by the settings add-on');
    const audit=await x.request('owner','audit');assert.equal(audit.status,200);
    const approvals=audit.data.events.filter(event=>event.kind==='add-on owner approval').map(event=>JSON.parse(event.detail));
    assert.ok(approvals.some(event=>event.id===settingsId&&event.action==='apply'),'audit records actual owner Apply');
    assert.ok(approvals.some(event=>event.id===settingsId&&event.action==='settings'),'audit records owner-approved settings');
    assert.equal(writes.some(path=>['/api/addons/restart','/api/addons/invoke','/api/addons/write-policy','/api/addons/approve-write'].includes(path)),false);
    assert.deepEqual(errors,[]);
    await writeFile(join(screenshots,'settings-only-browser-result.json'),JSON.stringify({
      proof:'PASS_SETTINGS_ONLY_DESKTOP_BROWSER',artifact:'One copied public runtime directory; not an exact final release ZIP.',browser:executable,
      passed:['real owner sign-in and Terms','unlicensed review denial','single signed license upload control','signed settings package review and explicit owner Apply','dynamic settings and separate consent','owner approval audit records','unchanged fictional books','unchanged base runtime files','zero browser page errors'],
      notRun:{nativeService:'SUPERVISOR_BLOCKED',serviceRestart:'SUPERVISOR_BLOCKED',runtimeWorkspaceBroker:'SUPERVISOR_BLOCKED',automaticRuntimeWrites:'SUPERVISOR_BLOCKED'},screenshots:[packagesShot,upgradeShot]
    },null,2)+'\n');
    t.diagnostic('PASS settings-only browser proof. NOTRUN native service, service restart, runtime workspace broker and automatic runtime writes: supervisor blocked. Screenshots: '+screenshots);
    return;
  }
  await navigate('Packages');await review();await apply(serviceId);
  await installed(serviceId).getByText('active',{exact:true}).waitFor();
  assert.equal(await installed(serviceId).getByRole('button',{name:'Approve restart',exact:true}).count(),0,'initial Apply does not invent a second restart');
  await page.screenshot({path:join(screenshots,'01-installed-addons-and-settings.png'),fullPage:true});

  await x.stage('service.fqaddon',x.manifest({id:serviceId,type:'service',revision:2}));
  await review();await apply(serviceId);
  await installed(serviceId).getByText(/Restart required/).waitFor();
  assert.equal(writes.includes('/api/addons/restart'),false,'Apply must never silently approve restart');
  await page.screenshot({path:join(screenshots,'02-pending-owner-restart.png'),fullPage:true});
  await navigate('Version Upgrade');await upgrade.getByText('Restart required',{exact:true}).waitFor();
  await navigate('Packages');
  const service=installed(serviceId),restart=service.getByRole('button',{name:'Approve restart',exact:true});assert.equal(await restart.isDisabled(),true);
  await service.locator('[data-addon-restart-approve]').check();await restart.click();
  await page.waitForFunction(id=>{const card=document.querySelector('[data-addon-installed][data-addon-id="'+id+'"]');return !!card&&card.textContent.includes('Revision 2')&&!card.querySelector('[data-addon-restart-approve]');},serviceId);
  assert.equal(writes.filter(path=>path==='/api/addons/restart').length,1);
  await page.screenshot({path:join(screenshots,'03-approved-service-revision.png'),fullPage:true});
  await navigate('Version Upgrade');await upgrade.getByText('Update fully complete',{exact:true}).waitFor();
  assert.equal(await upgrade.getByRole('button').count(),1);
  assert.deepEqual((await x.request('owner','session')).data.state,before,'package operations leave fictional books unchanged');
  assert.deepEqual(await baseFileHashes(x.runtime),baseHashes,'one base build is unchanged by add-on installation and update');
  assert.deepEqual(errors,[]);
  t.diagnostic('Desktop browser proof: '+executable+'; one disposable base build; screenshots: '+screenshots);
}
