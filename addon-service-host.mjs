// Node service contract, launched only in the verified zero-capability Windows AppContainer.
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startWindowsAddon} from './addon-windows-supervisor.mjs';
const runner=fileURLToPath(new URL('./addon-service-runner.mjs',import.meta.url));
const limit=1024*1024;
export async function startAddonService({payloadDirectory,dataDirectory,supervisorDirectory,protectedPaths=[],settings={},request=async()=>{throw Error('Broker unavailable.');},timeoutMs=60000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw Error('Invalid service timeout.');
 // This is one fixed supported sandbox policy, never a retry outside containment.
 const child=await startWindowsAddon({runnerPath:runner,payloadDirectory,dataDirectory,supervisorDirectory,protectedPaths,lessPrivileged:false,args:[join(payloadDirectory,'service.mjs')]});
 let dead=false,buffer=Buffer.alloc(0),seq=0,brokerCount=0,stderr=0,cleanup;const pending=new Map();
 const closeChild=()=>cleanup??=(async()=>child.close())();
 const fail=reason=>{if(dead)return;dead=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(reason));}pending.clear();void closeChild().catch(()=>{});};
 child.on('error',()=>fail('Restricted service failed to start.'));child.on('exit',()=>fail('Restricted service exited.'));
 child.stderr.on('data',b=>{stderr+=b.length;if(stderr>16384)fail('Service log limit exceeded.');});
 function send(value){const text=JSON.stringify(value);if(Buffer.byteLength(text)>limit)throw Error('Service message exceeds limit.');child.stdin.write(text+'\n');}
 child.stdin.on('error',()=>fail('Service pipe failed.'));
 child.stdout.on('data',chunk=>{
  if(buffer.length+chunk.length>limit)return fail('Service protocol size exceeded.');buffer=Buffer.concat([buffer,chunk]);let n;
  while((n=buffer.indexOf(10))>=0){const raw=buffer.subarray(0,n);buffer=buffer.subarray(n+1);let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{return fail('Invalid service protocol.');}
   if(Number.isSafeInteger(data?.broker)&&data.broker>0&&typeof data.op==='string'){
    if(++brokerCount>8)return fail('Broker request limit exceeded.');
    void Promise.resolve().then(()=>request(data.op,data.input)).then(value=>{if(!dead)send({broker:data.broker,ok:true,value});},error=>{if(!dead)send({broker:data.broker,ok:false,error:String(error.message||'Broker denied.').slice(0,200)});}).catch(()=>fail('Broker response failed.')).finally(()=>brokerCount--);continue;
   }
   const row=pending.get(data?.id);if(!row||typeof data.ok!=='boolean')return fail('Invalid service response.');pending.delete(data.id);clearTimeout(row.timer);if(data.ok)row.resolve(data.value);else{row.reject(Object.assign(Error(String(data.error||'Service failed.')),{code:row.op==='invoke'?'ADDON_REQUEST_REJECTED':'ADDON_SERVICE_FAILED'}));if(row.op!=='invoke')fail('Service failed.');}
  }
 });
 function call(op,payload={}){if(dead)return Promise.reject(Error('Service unavailable.'));if(pending.size>=8)return Promise.reject(Object.assign(Error('Service busy.'),{code:'ADDON_REQUEST_REJECTED'}));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>fail('Service health or request timed out.'),op==='invoke'?timeoutMs:10000);pending.set(id,{op,resolve,reject,timer});try{send({id,op,...payload});}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}});}
 try{if(child.exitCode!==undefined&&child.exitCode!==null)throw Error('Restricted service exited before initialization.');if(await call('init',{settings})!==true)throw Error('Initial health check failed.');}catch(e){await closeChild();throw e;}
 return {health:async()=>{if(await call('health')!==true)throw Error('Service unhealthy.');return true;},invoke:value=>call('invoke',{value}),async close(){fail('Service closed.');await closeChild();},pid:child.pid,protection:child.protection};
}
