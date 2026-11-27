import {readFile,writeFile,mkdir,copyFile,readdir,lstat} from 'node:fs/promises';
import {resolve,relative,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const source=fileURLToPath(new URL('../',import.meta.url));
const articles=['install-launch.md','first-admin.md','initialize-workspace.md','setup-verification.md','setup-failures.md'];
const shots=['01-private-first-launch','02-first-administrator','03-setup-error-and-retry','04-empty-setup-complete','05-books-sign-in','06-review-terms','07-empty-books','08-create-first-company','09-setup-verified','10-approved-package-preview','11-package-setup-complete','12-public-setup-help'].map(n=>n+'.png');
const modules=['passkeys','module-activation','csv-recovery','password-work','report-packet-store','scheduled-backups','support-diagnostics','contextual-help','month-end-close','file-drives','collaboration-groups','messaging','company-knowledge','manual-payroll-store','warehouse-planning','team-workflows','departments','project-workspace','project-record-scope','assets-workspace','desk-migration','asset-desk-migration','portable-desk','access','agent-access','benefits','branding','demo','host','ftps','identity','mcp-agent','migration','records','recovery','server','setup-package','setup-wizard','store','support','transfer','worker'].map(n=>n+'.mjs');
const assets=[...['.nojekyll','app.css','app.mjs','core.mjs','report-packet.mjs','report-packet-ui.mjs','desk-core.mjs','warehouse-desk.mjs','file-drive-ui.mjs','contextual-help-ui.mjs','contextual-help.css','knowledge-content.mjs','messaging-ui.mjs','planning-core.mjs','planning-views.mjs','headquarters.png','passkeys-ui.mjs','passkey-browser.mjs','index.html','interop.mjs','mark.svg','payroll-rules.mjs','manual-payroll.mjs','manual-payroll-ui.mjs','sample.mjs','sw.js','vault.mjs','views.mjs'].map(n=>'shared/'+n),...['account.mjs','consent.mjs','privacy.css','privacy.html','terms-ui.mjs','terms.css','terms.mjs'].map(n=>'web/legal/'+n),...['company-knowledge.mjs','team-workflows.mjs','month-end-close.mjs','backup-admin.mjs','department-workspace.mjs','assets-workspace.mjs','audit.html','administration.mjs','app.mjs','private-ftps-ui.mjs','csv-recovery-ui.mjs','activation-ui.mjs','benefit-admin.mjs','connected-admin.mjs','identity-admin.mjs','index.html','record-admin.mjs','suite.css'].map(n=>'web/main/'+n),...['app.mjs','index.html','selfservice.mjs','worker.css'].map(n=>'web/worker/'+n),...['index.html','setup.css','setup.mjs'].map(n=>'web/setup/'+n)];
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderSetupGuide(root=source){
  const text=await readFile(join(root,'SETUP-GUIDE.md'),'utf8');let html='',code=false,table=false,section=false;
  for(const line of text.split(/\r?\n/)){
    if(line.startsWith('```')){html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
    if(code){html+=escape(line)+'\n';continue;}
    if(line.startsWith('|')){if(!table){html+='<table>';table=true;}if(!/^\|[\s|:-]+\|$/.test(line))html+='<tr>'+line.slice(1,-1).split('|').map(v=>'<td>'+escape(v.trim())+'</td>').join('')+'</tr>';continue;}
    if(table){html+='</table>';table=false;}
    const heading=/^(#{1,3}) (.+)$/.exec(line);if(heading){if(heading[1].length===2){if(section)html+='</section>';html+='<section>';section=true;}html+='<h'+heading[1].length+'>'+escape(heading[2])+'</h'+heading[1].length+'>';continue;}
    const img=/^!\[([^\]]+)\]\((kb\/screenshots\/[a-z0-9-]+\.png)\)$/.exec(line);if(img){html+='<figure><img loading="lazy" src="'+img[2]+'" alt="'+escape(img[1])+'"></figure>';continue;}
    if(line.trim())html+='<p>'+escape(line).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')+'</p>';
  }
  if(table)html+='</table>';if(section)html+='</section>';
  const document='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FirmQuill public setup guide · 0.6.0-preview.1</title><style>body{margin:0;background:#f3f5f2;color:#183c3f;font:16px/1.65 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:36px;background:white}header{position:sticky;top:0;background:#154e4c;color:white;padding:14px 24px;z-index:1}input{font:inherit;padding:8px;width:min(550px,85%)}h1{font-size:34px}h2{margin-top:2em}pre,code{background:#edf2ef}pre{padding:16px;overflow:auto}code{overflow-wrap:anywhere}img{max-width:100%;height:auto;border:1px solid #d3dcd8}figure{margin:24px 0}table{border-collapse:collapse;width:100%}td{border:1px solid #d3dcd8;padding:10px;vertical-align:top}section[hidden]{display:none}@media print{header{display:none}main{padding:0}section[hidden]{display:block}}</style><header><label>Search this setup guide <input id="search" type="search" placeholder="Package, password, port, retry…"></label></header><main>'+html+'</main><script>document.querySelector("#search").addEventListener("input",e=>{const q=e.target.value.trim().toLowerCase();for(const s of document.querySelectorAll("section"))s.hidden=!!q&&!s.textContent.toLowerCase().includes(q)});</script></html>';
  return document;
}
async function list(root,prefix=''){const out=[];for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){const p=join(prefix,entry.name);if(entry.isSymbolicLink())throw Error('Distribution cannot contain symlinks.');if(entry.isDirectory())out.push(...await list(root,p));else out.push(p.replaceAll('\\','/'));}return out;}
export async function validatePublicDocumentation(root=source){
  const index=JSON.parse(await readFile(join(root,'kb/index.json'),'utf8'));
  if(index.scope!=='public-setup-only'||index.version!=='0.6.0-preview.1'||index.articles.length!==articles.length||index.articles.some(a=>!articles.includes(a.file)))throw Error('Public help must contain exactly the versioned setup articles.');
  const permitted=new Set(['index.json',...articles,...shots.map(n=>'screenshots/'+n)]);
  const actual=await list(join(root,'kb'));if(actual.some(p=>!permitted.has(p)))throw Error('Unapproved documentation or screenshot in public KB.');
  for(const p of permitted)if(!actual.includes(p))throw Error('Missing public setup asset: '+p);
  return {version:index.version,articles:articles.length,screenshots:shots.length,scope:index.scope};
}
export async function buildPublicRelease(destination,{root=source}={}){
  destination=resolve(destination);const rel=relative(root,destination);if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw Error('Build outside the source checkout.');
  try{await lstat(destination);throw Error('Choose a fresh build destination.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const documentation=await validatePublicDocumentation(root);
  const actualAssets=[...await list(join(root,'shared')).then(a=>a.map(p=>'shared/'+p)),...await list(join(root,'web')).then(a=>a.map(p=>'web/'+p))];if(actualAssets.length!==assets.length||actualAssets.some(p=>!assets.includes(p)))throw Error('Unapproved runtime asset; review the explicit public allowlist.');
  await mkdir(destination,{recursive:true});
  const files=[...modules,'vendor/simplewebauthn-server.mjs','vendor/PASSKEY-LICENSES.txt','LICENSE','THIRD-PARTY-NOTICES.md','README.md','COMMERCE-LINES.md','MIGRATION-FORMATS.md','WAREHOUSE-WORKFLOWS.md','TEAM-WORKFLOWS.md','COLLABORATION.md','FTPS-SETUP.md','MONTH-END-CLOSE.md','MANAGED-BACKUPS.md','SETUP-GUIDE.md','Start FirmQuill Full.cmd','fixtures/workforce-demo.mjs',...assets,...await list(join(root,'kb')).then(a=>a.map(p=>'kb/'+p))];
  for(const name of files){const src=join(root,name);if(!(await lstat(src)).isFile())throw Error('Expected regular source file: '+name);await mkdir(dirname(join(destination,name)),{recursive:true});await copyFile(src,join(destination,name));}
  await writeFile(join(destination,'SETUP-GUIDE.html'),await renderSetupGuide(root));
  const names=await list(destination),hashes=[];for(const name of names.sort())hashes.push(createHash('sha256').update(await readFile(join(destination,name))).digest('hex')+'  '+name);
  await writeFile(join(destination,'SHA256SUMS.txt'),hashes.join('\n')+'\n');
  return {destination,files:names.length+1,documentation,excluded:['private customer manual/index/screenshots','company packages/raw exports/databases','tests/developer feature manuals']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv[2]==='--guide')await writeFile(join(source,'SETUP-GUIDE.html'),await renderSetupGuide());
  else {if(!process.argv[2])throw Error('Pass a fresh destination directory.');console.log(JSON.stringify(await buildPublicRelease(process.argv[2]),null,2));}
}
