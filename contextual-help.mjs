// Separately installed, local-only documentation. No company records or network clients.
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INSTALLED_VERSION} from './support.mjs';

export const HELP_FORMAT='firmquill.contextual-support.v1';
const source=fileURLToPath(new URL('./',import.meta.url));
const mainRoles=new Set(['owner','manager','bookkeeper','viewer','hr','payroll']);
export const featuredHelpPages=new Set(['Overview','Directory','Sales','Purchasing','Jobs & time','Warehouse','Assembly','Fixed assets','Accounting','Banking','Reports','Payroll','History','Company setup']);
export const workspaceHelpPages=new Set(['Departments','Project tracker','Assets & pallets','Inventory audit','Company knowledge','Messages','Collaboration groups','Month-end close','Purchase requests','Time off review']);
export const mainHelpPages=new Set([...featuredHelpPages,...workspaceHelpPages,'Approvals','User access','Audit trail','Portable transfers','Employee records','Benefits administration','Identity connectors','Migration workspace','Agent access','Planning','Drives','Setup help']);
export const workerHelpPages=new Set(['Home','Setup help','Time','Pay','Reviews','Benefits','My Profile','Contacts','Time off','Company knowledge','Messages','Drives']);
const contained=(root,path)=>{const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&!/^\.\.(?:[\\/]|$)/.test(rel));};
const requireValid=value=>{if(!value)throw Error('Invalid local support package');};
const distinct=list=>new Set(list).size===list.length;
export const unavailableContext=()=>({available:false});

export function createContextualHelp({contextualRoot}={}){
  const configured=typeof contextualRoot==='string'&&isAbsolute(contextualRoot)&&!contained(source,resolve(contextualRoot));
  async function packageRoot(){
    requireValid(configured);
    const [application,root]=await Promise.all([realpath(source),realpath(contextualRoot)]);
    requireValid(!contained(application,root)&&!contained(root,application));
    return root;
  }
  async function read(root,name,max){
    const file=await realpath(join(root,name));
    requireValid(contained(root,file));
    const metadata=await stat(file);
    requireValid(metadata.isFile()&&metadata.size<=max);
    const bytes=await readFile(file);
    requireValid(bytes.length>0&&bytes.length<=max);
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  async function lookup({portal,page,role,companyId}){
    try{
      const root=await packageRoot();
      const index=JSON.parse(await read(root,'contextual-index.json',256*1024));
      requireValid(index?.format===HELP_FORMAT&&index.edition==='full-suite'&&index.version===INSTALLED_VERSION&&Array.isArray(index.articles)&&index.articles.length<=500);
      for(const item of index.articles){
        requireValid(item&&(item.portal==='main'||item.portal==='worker'));
        const isMain=item.portal==='main';
        requireValid((isMain?mainHelpPages:workerHelpPages).has(item.page)&&typeof item.title==='string'&&item.title.trim()&&item.title.length<=150);
        requireValid(typeof item.file==='string'&&/^[a-z0-9][a-z0-9-]{0,100}\.(?:md|txt)$/.test(item.file));
        requireValid(Array.isArray(item.roles)&&item.roles.length&&distinct(item.roles)&&item.roles.every(r=>isMain?mainRoles.has(r):r==='worker'));
        requireValid(Array.isArray(item.companyIds)&&item.companyIds.length&&distinct(item.companyIds)&&item.companyIds.every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)));
      }
      const matches=index.articles.filter(a=>a.portal===portal&&a.page===page&&a.roles.includes(role)&&a.companyIds.includes(companyId));
      if(matches.length!==1)return unavailableContext();
      const item=matches[0],body=await read(root,item.file,128*1024);
      requireValid(body.trim());
      return {available:true,title:item.title,body,version:INSTALLED_VERSION};
    }catch{return unavailableContext();}
  }
  return {lookup};
}
