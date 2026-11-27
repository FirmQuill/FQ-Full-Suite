import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';

export const FTPS_MAX_BYTES=4*1024*1024;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const check=(ok,status,message)=>{if(!ok)throw fail(status,message);};
const own=(o,k)=>Object.hasOwn(o,k);
const leaf=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v)&&!v.endsWith('.');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(v);
const hostLabel=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const credential=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f\u007f]/u.test(v);
const keys=new Set(['action','companyId','groupId','folderId','fileId','remoteName']);
const curlLine=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';

export function ftpsOptionsFromEnv(env=process.env){
  const get=k=>env['FIRMQUILL_FTPS_'+k];
  return {
    enabled:get('ENABLE')==='1',host:get('HOST'),port:get('PORT')||21,folder:get('FOLDER')||'',
    companyId:get('COMPANY_ID'),groupId:get('GROUP_ID')||'',operatorIds:(get('OPERATOR_IDS')||'').split(',').map(s=>s.trim()).filter(Boolean),
    username:get('USERNAME'),password:get('PASSWORD'),caFile:get('CA_FILE'),
  };
}
function normalize(o){
  const port=Number(o.port??21),host=o.host;
  const folder=typeof o.folder==='string'?(o.folder?o.folder.split('/'):[]):null;
  const ids=Array.isArray(o.operatorIds)?[...new Set(o.operatorIds)]:[];
  const groupId=o.groupId||'';
  const valid=typeof host==='string'&&host.length<=253&&(isIP(host)===4||(host.split('.').every(x=>hostLabel.test(x))&&!/^[0-9.]+$/.test(host)))
    && Number.isInteger(port)&&port>0&&port<=65535&&folder&&folder.length<=10&&folder.every(leaf)
    && id(o.companyId)&&(!groupId||id(groupId))&&ids.length>0&&ids.length<=20&&ids.every(id)
    && (groupId||ids.length===1)
    && credential(o.username)&&!o.username.includes(':')&&credential(o.password)
    && (!o.caFile||(typeof o.caFile==='string'&&isAbsolute(o.caFile)&&!/[\u0000-\u001f\u007f]/u.test(o.caFile)));
  if(!valid)return null;
  return {host,port,folder,companyId:o.companyId,groupId,operatorIds:Object.freeze(ids),username:o.username,password:o.password,caFile:o.caFile};
}
const scrubbedEnv=()=>Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
function transferName(filename){
  const source=typeof filename==='string'?filename:'file';
  const base=source.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g,'_').replace(/^[._-]+|[.]+$/g,'').slice(0,78).replace(/[.]+$/g,'')||'file';
  return `fq-${randomUUID()}-${base}`;
}

export async function curlPrivateFtps(c,{direction,name,data,beforeConnect},{launch=spawn}={}){
  check(leaf(name),400,'Enter one remote filename using letters, digits, dots, underscores or hyphens.');
  check(direction==='upload'||direction==='download',400,'Unsupported transfer.');
  const remote='ftp://'+c.host+':'+c.port+'/'+[...c.folder,name].map(encodeURIComponent).join('/');
  let temp;
  try{
    const args=['-q','--config','-','--proto','=ftp','--ssl-reqd','--tlsv1.2','--ftp-pasv','--ftp-skip-pasv-ip',
      '--noproxy','*','--no-netrc','--silent','--max-time','20','--connect-timeout','5','--max-filesize',String(FTPS_MAX_BYTES),'--globoff'];
    if(c.caFile)args.push('--cacert',c.caFile);
    if(direction==='upload'){
      check(Buffer.isBuffer(data)&&data.length<=FTPS_MAX_BYTES,413,'The file exceeds the 4 MiB transfer limit.');
      temp=await mkdtemp(join(tmpdir(),'firmquill-ftps-'));
      const local=join(temp,'payload');
      await writeFile(local,data,{flag:'wx',mode:0o600});
      args.push('--upload-file',local);
    }
    args.push('--url',remote);
    beforeConnect?.();
    return await new Promise((resolve,reject)=>{
      let child;
      try{child=launch('curl',args,{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:scrubbedEnv()});}
      catch{reject(fail(503,'FTPS requires curl on the FirmQuill host.'));return;}
      let size=0,stopReason,settled=false;
      const parts=[];
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(result);};
      const stop=(reason)=>{if(stopReason||settled)return;stopReason=reason;try{child.kill('SIGKILL');}catch{}};
      const timer=setTimeout(()=>stop(fail(504,'FTPS timed out. Check the private host and retry.')),22000);
      timer.unref?.();
      child.stdin.on('error',()=>{}); // A failed connection can also close stdin early.
      child.stdout.on('data',chunk=>{
        size+=chunk.length;
        if(size>FTPS_MAX_BYTES){stop(fail(413,'The remote file exceeds the 4 MiB transfer limit.'));return;}
        if(!stopReason&&direction==='download')parts.push(chunk);
      });
      child.once('error',()=>finish(fail(503,'FTPS requires a working curl installation on the FirmQuill host.')));
      child.once('close',(code)=>{
        if(stopReason)finish(stopReason);
        else if(code===0)finish(null,direction==='download'?Buffer.concat(parts,size):null);
        else if(code===63)finish(fail(413,'The remote file exceeds the 4 MiB transfer limit.'));
        else if(code===28)finish(fail(504,'FTPS timed out. Check the private host and retry.'));
        else finish(fail(502,'FTPS could not complete. Check host reachability, certificate, credentials and folder permissions.'));
      });
      child.stdin.end('user = '+curlLine(c.username+':'+c.password)+'\n');
    });
  }catch(e){
    if(e.status)throw e;
    throw fail(503,'The FirmQuill host could not prepare this transfer.');
  }finally{if(temp)await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
}

export function createPrivateFtps({options={},drive,transport=curlPrivateFtps,onSuccess=()=>{}}={}){
  const c=options.enabled===true?normalize(options):null;
  const available=!!c&&!!drive;
  let running=false;
  function resolve(user,p){
    if(!user||user.role==='worker'||!available||!c.operatorIds.includes(user.id)||p.companyId!==c.companyId||(p.groupId||'')!==c.groupId)return null;
    return {userId:user.id,companyId:c.companyId,groupId:c.groupId||undefined};
  }
  return {
    status(user,p){
      const access=resolve(user,p);
      if(!access)return {enabled:false};
      try{drive.list(access,p.folderId||'');return {enabled:true,maxBytes:FTPS_MAX_BYTES};}
      catch{return {enabled:false};}
    },
    async command(currentUser,p){
      check(Object.keys(p).every(k=>keys.has(k)),400,'Unexpected transfer fields. The remote host is configured by your administrator.');
      check((p.groupId===undefined||p.groupId===''||id(p.groupId))&&(p.folderId===undefined||p.folderId===''||id(p.folderId)),400,'Invalid private drive scope.');
      const user=currentUser();
      const access=resolve(user,p);
      check(access,403,'FTPS unavailable for this account and drive scope.');
      check(p.action==='download'||p.action==='upload',400,'Select a transfer direction.');
      check(!running,429,'Another FTPS transfer is in progress. Try again shortly.');
      running=true;
      try{
        if(p.action==='upload'){
          check(id(p.fileId)&&!own(p,'remoteName'),400,'Select one private drive file for upload.');
          const f=drive.authorizeRead(access,p.fileId);
          check(Buffer.isBuffer(f.data)&&f.data.length<=FTPS_MAX_BYTES,413,'The file exceeds the 4 MiB transfer limit.');
          const remoteName=transferName(f.filename);
          const beforeConnect=()=>{
            check(resolve(currentUser(),p),403,'FTPS unavailable for this account and drive scope.');
            const latest=drive.authorizeRead(access,p.fileId);
            check(latest.filename===f.filename&&Buffer.isBuffer(latest.data)&&latest.data.equals(f.data),409,'The private drive file changed. Reselect it and retry.');
          };
          await transport(c,{direction:'upload',name:remoteName,data:f.data,beforeConnect});
          onSuccess(user,access.companyId,'FTPS upload completed');
          return {direction:'upload',remoteName,bytes:f.data.length};
        }
        check(leaf(p.remoteName)&&!own(p,'fileId'),400,'Enter one remote filename using letters, digits, dots, underscores or hyphens.');
        const folderId=p.folderId||'';
        drive.authorizeCreate(access,folderId);
        const data=await transport(c,{direction:'download',name:p.remoteName});
        check(Buffer.isBuffer(data)&&data.length<=FTPS_MAX_BYTES,413,'The remote file exceeds the 4 MiB transfer limit.');
        check(resolve(currentUser(),p),403,'FTPS unavailable for this account and drive scope.');
        const imported=drive.createFromBytes(access,folderId,{filename:p.remoteName,data});
        onSuccess(user,access.companyId,'FTPS download completed');
        return {direction:'download',filename:p.remoteName,bytes:data.length,id:imported.id};
      }finally{running=false;}
    },
  };
}
