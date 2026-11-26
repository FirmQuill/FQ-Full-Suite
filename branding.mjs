import {createHash} from 'node:crypto';

export const maxLogoBytes=512*1024;
const modes=new Set(['default','company','parent']);
const limit=160;
function requireBrand(condition,message,status=400){
  if(!condition)throw Object.assign(Error(message),{status});
}

export function initializeBranding(db){
  db.exec("CREATE TABLE IF NOT EXISTS worker_branding(company TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('default','company','parent')),label TEXT NOT NULL,parent TEXT NOT NULL,mime TEXT NOT NULL,logo BLOB,version INTEGER NOT NULL CHECK(version>0))");
}

function jpegSize(bytes){
  if(bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return [];
  for(let i=2;i+8<bytes.length;){
    if(bytes[i++]!==255)return [];
    while(bytes[i]===255)i++;
    const mark=bytes[i++];
    if(i+2>bytes.length||mark===218||mark===217)return [];
    const len=bytes.readUInt16BE(i);
    if(len<2||i+len>bytes.length)return [];
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(mark)&&len>=8)return [bytes.readUInt16BE(i+5),bytes.readUInt16BE(i+3)];
    i+=len;
  }
  return [];
}
function logoPayload(input){
  requireBrand(input&&['image/png','image/jpeg'].includes(input.mime)&&typeof input.data==='string'&&input.data.length<=Math.ceil(maxLogoBytes/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(input.data),'Choose a PNG or JPEG logo no larger than 512 KiB.');
  const bytes=Buffer.from(input.data,'base64');
  requireBrand(bytes.length>24&&bytes.length<=maxLogoBytes&&bytes.toString('base64')===input.data,'Logo data is invalid.');
  const png=input.mime==='image/png';
  const sz=png?(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND'?[bytes.readUInt32BE(16),bytes.readUInt32BE(20)]:[]):jpegSize(bytes);
  requireBrand(sz.length===2&&sz.every(n=>n>=1&&n<=2048),'Logo must be a PNG or JPEG between 1 and 2048 pixels on each side.');
  return {mime:input.mime,bytes};
}
const get=(db,id)=>db.prepare('SELECT * FROM worker_branding WHERE company=?').get(id);

function brandChoice(db,state,companyId){
  const company=state.companies.find(c=>c.id===companyId);
  if(!company)return null;
  const self=get(db,companyId);
  if(!self||self.mode==='default')return null;
  if(self.mode==='company')return {name:self.label||company.name,sourceId:company.id,row:self};
  const parent=state.companies.find(c=>c.id===self.parent&&c.id!==company.id);
  if(!parent)return null;
  const row=get(db,parent.id);
  return {name:row?.label||parent.name,sourceId:parent.id,row};
}

export function workerBranding(db,state,companyId){
  const b=brandChoice(db,state,companyId);
  return b?{name:b.name,logo:b.row?.logo?'/api/worker-brand/logo?v='+createHash('sha256').update(b.sourceId+':'+b.row.version).digest('hex').slice(0,16):''}:null;
}
export function workerBrandLogo(db,state,companyId){
  const row=brandChoice(db,state,companyId)?.row;
  return row?.logo?{mime:row.mime,bytes:Buffer.from(row.logo)}:null;
}

export function brandingSettings(db,state,companyId){
  const company=state.companies.find(c=>c.id===companyId);
  requireBrand(company,'Choose a company.',404);
  const r=get(db,companyId);
  return {mode:r?.mode||'default',label:r?.label||'',parent:r?.parent||'',hasLogo:!!r?.logo,version:r?.version||0,companyName:company.name,parents:state.companies.filter(c=>c.id!==companyId).map(c=>({id:c.id,name:c.name}))};
}

export function saveWorkerBranding(db,state,input){
  const settings=brandingSettings(db,state,input.companyId);
  requireBrand(input.version===settings.version,'Branding settings changed. Reopen before saving.',409);
  requireBrand(modes.has(input.mode)&&typeof input.label==='string'&&input.label.length<=limit&&!/[\u0000-\u001f\u007f]/u.test(input.label),'Choose a branding mode and a display name of up to 160 characters.');
  const label=input.label.trim(), parent=input.mode==='parent'?input.parent:'';
  if(input.mode==='parent')requireBrand(settings.parents.some(p=>p.id===parent),'Select another company as the parent brand.');
  requireBrand(['keep','remove','replace'].includes(input.logoAction),'Choose what to do with the logo.');
  const old=get(db,input.companyId);
  const logo=input.logoAction==='replace'?logoPayload(input.logo):input.logoAction==='keep'&&old?.logo?{bytes:old.logo,mime:old.mime}:null;
  db.prepare("INSERT INTO worker_branding VALUES(?,?,?,?,?,?,?) ON CONFLICT(company) DO UPDATE SET mode=excluded.mode,label=excluded.label,parent=excluded.parent,mime=excluded.mime,logo=excluded.logo,version=excluded.version")
    .run(input.companyId,input.mode,label,parent,logo?.mime||'',logo?.bytes||null,settings.version+1);
  return brandingSettings(db,state,input.companyId);
}
