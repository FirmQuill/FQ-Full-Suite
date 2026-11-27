// Required native gate, deliberately not mocked. A failure means service install is not verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {startAddonService} from '../addon-service-host.mjs';

test('required Windows service gate: AI-capable Node runtime uses verified containment, broker and denied direct OS access',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'fq-native-ai-gate-'));let service,server;
 t.after(async()=>{await service?.close();if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 const payload=join(root,'payload'),data=join(root,'data'),core=join(root,'core');for(const dir of [payload,data,core])await mkdir(dir,{mode:0o700});
 const database=join(root,'fictional.sqlite'),canary=join(core,'canary.txt');await writeFile(database,'FICTIONAL DATABASE CANARY');await writeFile(canary,'CORE CANARY UNCHANGED');
 await writeFile(join(payload,'service.mjs'),`export async function activate(context){return {health:()=>true,async handle(input){
 if(input.op==='prompt')return {text:'Fictional AI reply',provider:await context.request('https',{prompt:input.prompt})};
 const fs=await import('node:fs/promises'),cp=await import('node:child_process'),net=await import('node:net');
 const deny=async f=>{try{await f();return false;}catch{return true;}};
 return {db:await deny(()=>fs.readFile(context.settings.database)),core:await deny(()=>fs.readFile(context.settings.canary)),overwrite:await deny(()=>fs.writeFile(context.settings.canary,'BAD')),shell:await deny(()=>new Promise((yes,no)=>{const p=cp.spawn('cmd.exe',['/c','exit','0']);p.once('error',no);p.once('exit',yes);})),network:await deny(()=>new Promise((yes,no)=>{const s=net.connect(Number(context.settings.port),'127.0.0.1');const timeout=setTimeout(()=>{s.destroy();no(Error('denied'));},1000);s.once('connect',()=>{clearTimeout(timeout);s.destroy();yes();});s.once('error',e=>{clearTimeout(timeout);no(e);});}))};
 }}};`);
 server=createServer(s=>s.end('FICTIONAL'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 service=await startAddonService({payloadDirectory:payload,dataDirectory:data,supervisorDirectory:join(root,'supervisor'),protectedPaths:[core,database],settings:{database,canary,port:String(server.address().port)},request:async(op,input)=>{assert.equal(op,'https');return {reply:'FICTIONAL PROVIDER',prompt:input.prompt};}});
 assert.equal(service.protection.appContainer,true);assert.equal(service.protection.capabilities,0);assert.equal(service.protection.activeProcessLimit,1);assert.equal(service.protection.killOnClose,true);assert.equal(service.protection.protectedPathsDenied,2);assert.equal(await service.health(),true);
 assert.equal((await service.invoke({op:'prompt',prompt:'FICTIONAL'})).provider.reply,'FICTIONAL PROVIDER');
 assert.deepEqual(await service.invoke({op:'probes'}),{db:true,core:true,overwrite:true,shell:true,network:true});
 assert.equal(await readFile(canary,'utf8'),'CORE CANARY UNCHANGED');assert.equal(await readFile(database,'utf8'),'FICTIONAL DATABASE CANARY');
});
