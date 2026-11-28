// Fictional end-to-end issuer and Node service fixtures. Private keys remain in this test process.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {buildPublicRelease} from '../scripts/build-public-release.mjs';
import {activationFixture} from './fixture-activation.mjs';
import {fixtureAgreement} from './fixture-terms.mjs';

export const settingsId='fictional-settings',serviceId='fictional-ai';
export const fictionalOrigin='https://api.fictional-addon.example.com';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function fictionalServiceFiles({healthy=true,increment=1}={}){
  const service=`import {increment} from './arithmetic.mjs';
export async function activate(context){
  return {
    async health(){return ${JSON.stringify(healthy)};},
    async handle(request){
      if(request&&request.op==='runtime-identity')return {pid:process.pid};
      if(request&&request.kind==='prompt')return {text:'Fictional response: '+request.prompt,label:context.settings.label};
      if(request&&request.kind==='https')return context.request('https',{url:request.url||'${fictionalOrigin}/v1/reply',method:'POST',body:{prompt:request.prompt}});
      if(request&&request.op==='workspace-read')return context.request('workspace.read',{path:request.path,...(request.query===undefined?{}:{query:request.query})});
      if(request&&request.op==='workspace-write')return context.request('workspace.write',{path:request.path,body:request.body});
      if(request&&request.op==='private-state'){
        const fs=await import('node:fs/promises'),path=await import('node:path'),file=path.join(context.dataDirectory,'fictional-state.json');
        if(request.value!==undefined)await fs.writeFile(file,JSON.stringify({value:request.value}));
        return JSON.parse(await fs.readFile(file,'utf8'));
      }
      if(request&&request.op==='sandbox-probes'){
        const fs=await import('node:fs/promises'),child=await import('node:child_process'),net=await import('node:net');
        const attempt=async fn=>{try{await fn();return {denied:false};}catch(error){return {denied:['EACCES','EPERM','ERR_ACCESS_DENIED'].includes(error.code),code:String(error.code||'unknown')};}};
        const reads={};for(const [name,path] of Object.entries(request.paths))reads[name]=await attempt(()=>fs.readFile(path));
        const write=await attempt(()=>fs.writeFile(request.writePath,'Fictional write probe.'));
        const processProbe=await attempt(()=>child.execFileSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true,timeout:1000}));
        const shell=await attempt(()=>child.execFileSync(request.shellPath,['/c','exit','0'],{windowsHide:true,timeout:1000}));
        const network=await new Promise(resolve=>{let done=false,socket;const finish=value=>{if(done)return;done=true;socket?.destroy();resolve(value);};try{socket=net.createConnection({host:'127.0.0.1',port:request.port});socket.setTimeout(700,()=>finish({denied:false,code:'INCONCLUSIVE_TIMEOUT'}));socket.once('connect',()=>finish({denied:false}));socket.once('error',error=>finish({denied:['EACCES','EPERM','ERR_ACCESS_DENIED'].includes(error.code),code:String(error.code)}));}catch(error){finish({denied:['EACCES','EPERM','ERR_ACCESS_DENIED'].includes(error.code),code:String(error.code)});}});
        return {reads,write,process:processProbe,shell,network};
      }
      const value=Number.isInteger(request)?request:request?.value;
      if(!Number.isInteger(value))throw Error('Fictional handler requires an integer or a prompt.');
      return value+increment;
    }
  };
}
`;
  return Object.fromEntries(Object.entries({'service.mjs':service,'arithmetic.mjs':'export const increment='+JSON.stringify(increment)+';\n'}).map(([name,content])=>{
    const bytes=Buffer.from(content);return [name,{sha256:hash(bytes),content:bytes.toString('base64url')}];
  }));
}
export async function baseFileHashes(root){
  const result={};async function walk(prefix=''){
    for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
      if(!prefix&&entry.name==='packages')continue;
      const name=prefix?prefix+'/'+entry.name:entry.name;
      if(entry.isDirectory())await walk(name);else result[name]=hash(await readFile(join(root,name)));
    }
  }await walk();return result;
}
export async function fixtureAddon(t,{settingsOnly=false}={}){
  const root=await mkdtemp(join(tmpdir(),'fq-addon-packaged-')),runtime=join(root,'runtime');let suite,probeServer,probeConnections=0;
  t.after(async()=>{try{await suite?.close();if(probeServer)await new Promise(resolve=>probeServer.close(resolve));}finally{await rm(root,{recursive:true,force:true});}});
  const build=await buildPublicRelease(runtime); // Deliberately exactly once for the whole scenario.
  const app=name=>import(pathToFileURL(join(runtime,name)).href);
  const [{createSuite},{openStore,saveBooks,putUser,passwordHash},{sampleVault}]=await Promise.all([app('server.mjs'),app('store.mjs'),app('shared/sample.mjs')]);
  let now=Date.parse('2026-11-27T12:00:00Z');const license=await activationFixture(root,{clock:()=>now});
  const publisher=generateKeyPairSync('ed25519'),publisherKey=join(root,'publisher-public.pem');
  await writeFile(publisherKey,publisher.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const directory=join(runtime,'packages');await mkdir(directory,{mode:0o700,recursive:true});
  const canary=join(root,'fictional-outside-canary.txt');await writeFile(canary,'Fictional outside data canary.');
  const probeNonce='Fictional direct network probe '+randomBytes(16).toString('hex');
  probeServer=createServer(socket=>{probeConnections++;socket.end(probeNonce);});await new Promise((resolve,reject)=>probeServer.once('error',reject).listen(0,'127.0.0.1',resolve));
  const database=join(root,'fictional.sqlite'),password='Fictional packaged add-on verification only.',state=sampleVault(),company=state.companies[0];
  const db=openStore(database),passwordValue=await passwordHash(password);
  try{saveBooks(db,state);for(const role of ['owner','manager','worker'])putUser(db,null,{username:role,name:'Fictional '+role,role,assignments:role==='owner'?[]:[company.id],...(role==='worker'?{employeeId:company.employees[0].id}:{})},passwordValue,{bootstrap:true});}finally{db.close();}
  const manifest=({id=settingsId,revision=1,type='settings',healthy=true,increment=1,...fields}={})=>{
    return {format:'firmquill.addon.v1',id,name:'Fictional '+(type==='service'?'AI service':'settings'),revision,installationId:license.id,
      compatibility:{min:'0.6.5',max:'0.6.5',hostApi:1},type,permissions:type==='service'?['settings','service.runtime','network.https','workspace.read','workspace.write','workspace.write.auto']:['settings'],network:type==='service'?[fictionalOrigin]:[],
      settings:[{key:'label',label:'Fictional label',type:'string',default:'Fictional default',maxLength:80}],
      files:type==='service'?fictionalServiceFiles({healthy,increment}):{},...fields};
  };
  const stage=async(name,p,{badSignature=false}={})=>{
    const bytes=Buffer.from(JSON.stringify(p)),signature=sign(null,bytes,publisher.privateKey);if(badSignature)signature[0]^=1;
    const contents=JSON.stringify({signed:bytes.toString('base64url'),signature:signature.toString('base64url')});
    await writeFile(join(directory,name),contents,{mode:0o600});return contents;
  };
  const clients=new Map();
  const request=async(role,path,body)=>{
    const worker=role==='worker',base=worker?suite.workerUrl:suite.mainUrl,session=clients.get(role);
    const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(role,{accept=true}={})=>{
    clients.delete(role);const result=await request(role,'login',{username:role,password});assert.equal(result.status,200,JSON.stringify(result.data));clients.set(role,{cookie:result.cookie,csrf:result.data.csrf});
    if(result.data.termsRequired&&accept)assert.equal((await request(role,'terms',fixtureAgreement)).status,200);
    return result.data;
  };
  const httpsRequests=[];
  const httpsTransport=async input=>{httpsRequests.push(input);return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({reply:'Fictional provider response.'})};};
  const launch=async()=>{assert.equal(suite,undefined,'Never open two runtimes on the same SQLite database.');suite=await createSuite({database,mainPort:0,workerPort:0,activationOptions:license.options,addonOptions:{publisherKey,httpsTransport},planningClock:()=> '2026-11-27'});clients.clear();};
  const stop=async()=>{const running=suite;suite=undefined;clients.clear();await running?.close();};
  const signedLicense=(fields={})=>license.mint({licenseId:'a'.repeat(32),issuedAt:Math.floor(now/1000),expiresAt:Math.floor(now/1000)+3600,
    addons:[{id:settingsId,minRevision:1,maxRevision:8,permissions:['settings']},...settingsOnly?[]:[{id:serviceId,minRevision:1,maxRevision:8,permissions:['settings','service.runtime','network.https','workspace.read','workspace.write','workspace.write.auto']}]],...fields});
  await launch();
  return {root,runtime,directory,database,build,password,httpsRequests,probeNonce,get probeConnections(){return probeConnections;},probe:{paths:{database,core:join(runtime,'server.mjs'),outside:canary},writePath:canary,shellPath:join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),port:probeServer.address().port},get mainUrl(){return suite?.mainUrl;},get workerUrl(){return suite?.workerUrl;},manifest,stage,request,login,launch,stop,signedLicense,advance:milliseconds=>{now+=milliseconds;}};
}
