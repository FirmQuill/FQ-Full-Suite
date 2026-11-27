// Fixed protocol runner. Package JS executes only in the verified Windows AppContainer.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const max=1024*1024, pendingBroker=new Map();let buffer=Buffer.alloc(0),service,sequence=0,initializing=false;
const send=value=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>max)throw Error('Service result exceeds limit.');process.stdout.write(text+'\n');};
const request=(op,input)=>new Promise((resolve,reject)=>{if(pendingBroker.size>=8)return reject(Error('Broker busy.'));const broker=++sequence;const timer=setTimeout(()=>{pendingBroker.delete(broker);reject(Error('Broker request timed out.'));},10000);pendingBroker.set(broker,{resolve,reject,timer});try{send({broker,op,input});}catch(e){clearTimeout(timer);pendingBroker.delete(broker);reject(e);}});
async function handle(message){
 if(message&&Number.isSafeInteger(message.broker)&&pendingBroker.has(message.broker)){const p=pendingBroker.get(message.broker);pendingBroker.delete(message.broker);clearTimeout(p.timer);message.ok?p.resolve(message.value):p.reject(Error(String(message.error||'Broker denied.')));return;}
 const id=message?.id;
 try{
  if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid service protocol.');let value;
  if(message.op==='init'&&!service&&!initializing){
   initializing=true;const payload=resolve(process.argv[2]);
   if(!process.permission?.has('fs.read',payload)||process.permission.has('child')||process.permission.has('addons'))throw Error('Runtime permissions not enforced.');
   const mod=await import(pathToFileURL(payload).href);if(typeof mod.activate!=='function')throw Error('Service must export activate(context).');
   const settings=Object.freeze({...message.settings});const context=Object.freeze({apiVersion:1,settings,dataDirectory:process.argv[3],request});
   service=await mod.activate(context);if(!service||typeof service.health!=='function'||typeof service.handle!=='function'||await service.health()!==true)throw Error('Service health check failed.');value=true;
  }else if(service&&message.op==='health'){if(await service.health()!==true)throw Error('Service health check failed.');value=true;}
  else if(service&&message.op==='invoke')value=await service.handle(message.value);
  else throw Error('Unsupported service operation.');
  send({id,ok:true,value:value??null});
 }catch(e){try{send({id,ok:false,error:String(e.message||'Service failed.').slice(0,200)});}catch{process.exitCode=1;process.stdin.destroy();return;}if(message?.op!=='invoke'||!service){process.exitCode=1;process.stdin.destroy();}}
}
process.stdin.on('data',chunk=>{if(buffer.length+chunk.length>max){process.exit(1);}buffer=Buffer.concat([buffer,chunk]);let n;while((n=buffer.indexOf(10))>=0){const line=buffer.subarray(0,n);buffer=buffer.subarray(n+1);try{void handle(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));}catch{process.exit(1);}}});
process.stdin.on('end',()=>{for(const p of pendingBroker.values()){clearTimeout(p.timer);p.reject(Error('Supervisor closed.'));}pendingBroker.clear();});
process.stdin.on('error',()=>process.exit(1));process.stdout.on('error',()=>process.exit(1));
