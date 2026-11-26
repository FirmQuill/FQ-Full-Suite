// Documentation retrieval has no database, agent-token or provider dependency.
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
export const INSTALLED_VERSION='0.5.0-preview.1';
const appDirectory=fileURLToPath(new URL('./',import.meta.url)),defaultRoot=fileURLToPath(new URL('./kb/',import.meta.url));
const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const inside=(parent,child)=>{const r=relative(parent,child);return r===''||(!r.startsWith('..\\')&&!r.startsWith('../')&&r!=='..'&&!isAbsolute(r));};
const stop=new Set('a an and are as at be by can do does for from how i in is it me my of on or our the this to use using what when where which who why with you your'.split(' '));
const aliases={signin:'login',sign:'login',passwords:'password',stubs:'paystub',paystubs:'paystub',workers:'worker',employees:'employee',invoices:'invoice',bills:'bill',backups:'backup',restore:'recovery',restoration:'recovery',recover:'recovery',csvs:'csv',roles:'role',permissions:'permission',duplicates:'duplicate',reimport:'duplicate',reimports:'duplicate',citations:'citation',documentation:'docs',companies:'company',contacts:'contact',journals:'journal',errors:'error',failed:'failure',retrying:'retry'};
function tokens(value){return [...new Set(String(value).toLowerCase().match(/[a-z0-9]+/g)||[])].map(x=>aliases[x]||x).filter(x=>x.length>1&&!stop.has(x));}
function question(value){fail(typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=2048,'Enter a support question within 2 KiB.');return value.trim();}
function citation(item,heading=''){return {id:item.id,title:item.title,version:INSTALLED_VERSION,section:heading,url:'/api/support/article?id='+encodeURIComponent(item.id)+(heading?'#'+heading.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''):'')};}

/** Explicit private manual opt-in only. Missing docs fail support requests, never app startup. */
export function createSupportService({documentationRoot}={}){
  const privateMode=documentationRoot!==undefined;
  const configuredValid=!privateMode||(typeof documentationRoot==='string'&&isAbsolute(documentationRoot)&&!inside(appDirectory,resolve(documentationRoot)));
  const selectedRoot=privateMode&&configuredValid?resolve(documentationRoot):defaultRoot;
  async function safeRoot(){
    fail(configuredValid,'Private support documentation must be an absolute directory outside the application.',503);
    let dir,application;try{[dir,application]=await Promise.all([realpath(selectedRoot),realpath(appDirectory)]);}catch{fail(false,'Support documentation is unavailable. Keep the application running and contact the host administrator.',503);}
    fail(!privateMode||!inside(application,dir),'Private support documentation must stay outside the application.',503);return dir;
  }
  async function readDocument(file,maxBytes=256*1024){
    fail(/^[a-z0-9-]+\.(md|json)$/.test(file),'Invalid installed documentation filename.',503);
    const dir=await safeRoot();let location,body,metadata;
    try{location=await realpath(resolve(dir,file));}catch{fail(false,'Support documentation is unavailable. Contact the host administrator.',503);}
    fail(inside(dir,location),'Documentation references must stay inside the selected directory.',503);
    try{metadata=await stat(location);}catch{fail(false,'Support documentation is unavailable. Contact the host administrator.',503);}
    fail(metadata.isFile()&&metadata.size<=maxBytes,'Installed documentation exceeds the supported file size or is not a regular file.',503);
    try{body=await readFile(location,'utf8');}catch{fail(false,'Support documentation is unavailable. Contact the host administrator.',503);}
    fail(Buffer.byteLength(body)<=maxBytes,'Installed documentation exceeds the supported file size.',503);return body;
  }
  async function catalog(){
    let index;try{index=JSON.parse(await readDocument('index.json',64*1024));}catch(error){if(error.status)throw error;fail(false,'Installed documentation index is invalid.',503);}
    fail(index&&typeof index==='object'&&!Array.isArray(index),'Installed documentation index is invalid.',503);
    fail(index.version===INSTALLED_VERSION,'Installed documentation version does not match this application.',503);
    fail(index.scope===(privateMode?'private-customer-manual':'public-setup-only'),'Installed documentation scope does not match the explicitly selected support mode.',503);
    fail(index&&Array.isArray(index.articles)&&index.articles.length<=100&&index.articles.every(a=>a&&/^[a-z0-9-]+$/.test(a.id)&&/^[a-z0-9-]+\.md$/.test(a.file)&&typeof a.title==='string'&&a.title.length<=200&&Array.isArray(a.keywords)&&a.keywords.every(k=>typeof k==='string'&&k.length<=80))&&new Set(index.articles.map(a=>a.id)).size===index.articles.length,'Installed documentation catalog is invalid.',503);return index;
  }
  async function info(){const index=await catalog();return {version:INSTALLED_VERSION,scope:index.scope,mode:'local-extractive',providerEnabled:false,companyDataAccess:false,articles:index.articles.map(a=>({id:a.id,title:a.title,status:a.status})),escalation:'Contact your company owner or designated FirmQuill support contact. Include installed version, article ID, exact error, safe reproduction steps and a redacted diagnostic; omit credentials and company/personnel exports.'};}
  async function article(id){const index=await catalog(),item=index.articles.find(a=>a.id===id);fail(item,'Documentation article unavailable for this installed version.',404);return {...citation(item),status:item.status,body:await readDocument(item.file)};}
  async function ranked(value){const q=tokens(question(value)),index=await catalog();if(!q.length)return [];
    const rows=await Promise.all(index.articles.map(async item=>{const body=await readDocument(item.file),title=new Set(tokens(item.title)),keys=new Set(tokens(item.keywords.join(' '))),words=new Set(tokens(body)),matched=q.filter(t=>words.has(t)||keys.has(t)||title.has(t));const score=matched.reduce((n,t)=>n+(title.has(t)?6:0)+(keys.has(t)?4:0)+(words.has(t)?1:0),0);return {item,body,score,matched,q};}));
    return rows.filter(r=>r.score>=4&&r.matched.length>=Math.min(2,r.q.length)).sort((a,b)=>b.score-a.score||a.item.id.localeCompare(b.item.id));
  }
  async function search(value,{limit=5}={}){fail(Number.isInteger(limit)&&limit>=1&&limit<=10,'Choose a support result limit from 1 through 10.');const rows=await ranked(value);return {version:INSTALLED_VERSION,scope:privateMode?'private-customer-manual':'public-setup-only',results:rows.slice(0,limit).map(r=>({...citation(r.item),status:r.item.status,score:r.score,excerpt:r.body.replace(/^#.*\n/gm,'').replace(/\n+/g,' ').slice(0,280)}))};}
  async function answer(value){const rows=await ranked(value),escalation={needed:!rows.length,message:'Contact your company owner or designated FirmQuill support contact. Supply installed version '+INSTALLED_VERSION+', exact error and redacted reproduction steps. Never include passwords, tokens, raw exports, employee evidence or paystubs.'};
    if(!rows.length)return {version:INSTALLED_VERSION,mode:'local-extractive',answer:'I could not find verified guidance for this question in the installed documentation. Ask your company owner or support contact to review it.',citations:[],escalation};
    const excerpts=[];
    for(const row of rows.slice(0,3)){let heading='';const sections=[];for(const paragraph of row.body.split(/\n\s*\n/)){if(/^#{1,3} /.test(paragraph)){heading=paragraph.replace(/^#+ /,'').split('\n')[0];continue;}if(/^Article:/.test(paragraph))continue;const words=new Set(tokens(paragraph)),headingWords=new Set(tokens(heading)),score=row.q.reduce((n,t)=>n+(words.has(t)?1:0)+(headingWords.has(t)?3:0),0);if(score)sections.push({text:paragraph,heading,score});}sections.sort((a,b)=>b.score-a.score);const section=sections[0];if(section)excerpts.push({text:section.text.slice(0,1600),citation:citation(row.item,section.heading),status:row.item.status});}
    escalation.needed=excerpts.some(x=>x.status!=='verified-local')||excerpts.some(x=>/unverified|unsupported|not implemented|not supported|blocked|outstanding/i.test(x.text));
    return {version:INSTALLED_VERSION,mode:'local-extractive',answer:'Relevant installed documentation (local excerpts; no AI provider):\n\n'+excerpts.map((x,i)=>'['+(i+1)+'] '+x.text).join('\n\n')+'\n\nIf these articles do not resolve your case, ask your company owner or support contact. Guidance outside these excerpts is unverified.',citations:excerpts.map(x=>x.citation),escalation};
  }
  return {info,search,article,answer};
}
const standard=createSupportService();
export const supportInfo=standard.info,supportSearch=standard.search,supportArticle=standard.article,supportAnswer=standard.answer;
