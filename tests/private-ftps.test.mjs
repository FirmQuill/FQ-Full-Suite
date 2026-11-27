import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:net';
import tls from 'node:tls';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPrivateFtps,curlPrivateFtps,FTPS_MAX_BYTES} from '../ftps.mjs';
import {openStore,tx,saveBooks,putUser,passwordHash} from '../store.mjs';
import {createSuite} from '../server.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {fixtureAgreement,acceptFixtureBrowser} from './fixture-terms.mjs';

const options={enabled:true,host:'private.example.test',folder:'firmquill/files',companyId:'company',groupId:'group',operatorIds:['staff'],username:'fake',password:'not-real'};
const user={id:'staff',role:'manager'};
const scope={companyId:'company',groupId:'group'};
const status=(code)=>e=>e.status===code;
const makeDrive=(allowed=()=>true)=>{
 const files=new Map([['example',{filename:'example.csv',data:Buffer.from('a,b')}]]),deny=()=>{throw Object.assign(Error('Drive unavailable'),{status:404});};
 const check=a=>{if(!allowed(a))deny();};
 return {files,list(a){check(a);},authorizeRead(a,id){check(a);return files.get(id)||deny();},authorizeCreate(a){check(a);},createFromBytes(a,f,{filename,data}){check(a);files.set('download',{f,filename,data});return {id:'download'};}};
};
test('restricts fixed profile, users and drive scope and checks live access after pulls',async()=>{
 let hasAccess=true,calls=[],audit=[],profile;
 const d=makeDrive(a=>hasAccess&&a.userId==='staff'&&a.groupId==='group'&&a.companyId==='company');
 const s=createPrivateFtps({options,drive:d,transport:async(c,a)=>{profile=c; a.beforeConnect?.();calls.push(a);if(a.name==='removed.csv')hasAccess=false;return Buffer.from('fixture');},onSuccess:(...a)=>audit.push(a)});
 assert.deepEqual(createPrivateFtps({drive:d}).status(user,scope),{enabled:false});
 assert.deepEqual(createPrivateFtps({options:{...options,host:'ftp://user@evil.invalid'},drive:d}).status(user,scope),{enabled:false});
 assert.deepEqual(createPrivateFtps({options:{...options,folder:'../../system'},drive:d}).status(user,scope),{enabled:false});
 assert.deepEqual(createPrivateFtps({options:{...options,groupId:'',operatorIds:['a','b']},drive:d}).status(user,scope),{enabled:false});
 assert.deepEqual(s.status({...user,role:'worker'},scope),{enabled:false});
 assert.deepEqual(s.status(user,{...scope,groupId:'other'}),{enabled:false});
 assert.deepEqual(s.status(user,scope),{enabled:true,maxBytes:FTPS_MAX_BYTES});
 for(const p of [{remoteName:'../a'},{remoteName:'a%0d%0a'},{remoteName:'/x'},{remoteName:'example.csv',url:'ftp://evil.invalid/x'}])
   await assert.rejects(s.command(()=>user,{...scope,action:'download',...p}),status(400));
 await assert.rejects(s.command(()=>user,{...scope,groupId:'other',action:'upload',fileId:'example'}),status(403));
 assert.equal(calls.length,0);
 const sent=await s.command(()=>user,{...scope,action:'upload',fileId:'example'});
 assert.match(sent.remoteName,/^fq-[a-f0-9-]+-example\.csv$/);
 assert.equal(calls[0].data.toString(),'a,b');assert.deepEqual(profile.folder,['firmquill','files']);
 const got=await s.command(()=>user,{...scope,action:'download',remoteName:'example.csv',folderId:'inbox'});
 assert.equal(got.id,'download');assert.deepEqual(d.files.get('download'),{filename:'example.csv',f:'inbox',data:Buffer.from('fixture')});
 d.files.delete('download');
 await assert.rejects(s.command(()=>user,{...scope,action:'download',remoteName:'removed.csv'}),status(404));
 assert.equal(d.files.has('download'),false);assert.equal(audit.length,2);
 assert.doesNotMatch(JSON.stringify(audit),/private\.example|example\.csv|not-real/);
});

async function listening(s){await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});return s.address().port;}
function withClose(t,s){t.after(()=>new Promise(ok=>s.close(ok)));}
function version(bin){try{execFileSync(bin,['--version'],{stdio:'ignore'});return true;}catch{return false;}}
test('real curl refuses plain FTP without ever sending credentials',async t=>{
 if(!version('curl'))return t.skip('curl unavailable');
 const commands=[];
 const s=createServer(conn=>{conn.end('220 Fixture\r\n',()=>{});conn.on('data',c=>commands.push(c.toString()));});
 const port=await listening(s);withClose(t,s);
 await assert.rejects(curlPrivateFtps({...options,host:'127.0.0.1',port,folder:[]},{direction:'download',name:'fixture.txt'}),status(502));
 assert.doesNotMatch(commands.join(''),/USER|PASS|not-real/);
});
test('real curl uploads and downloads over verified explicit TLS, rejects untrusted CA and caps bytes',async t=>{
 if(!version('curl'))return t.skip('curl unavailable');
 try{execFileSync('openssl',['version'],{stdio:'ignore'});}catch{return t.skip('openssl unavailable');}
 const temp=await mkdtemp(join(tmpdir(),'fq-ftps-test-')),cert=join(temp,'cert.pem'),key=join(temp,'key.pem');
 t.after(()=>rm(temp,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
 const secureContext=tls.createSecureContext({cert:await readFile(cert),key:await readFile(key)});
 const downloads=new Map([['input.txt',Buffer.from('inbound bytes')],['large.txt',Buffer.alloc(FTPS_MAX_BYTES+1)]]),received=new Map(),commandLog=[],sockets=new Set(),passive=new Set();
 const track=s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));return s;};
 const server=createServer(raw=>{
   track(raw);let c=raw,text='',dataSocket,mode,sessionPrivate=false,dataServer;const send=v=>c.write(v+'\r\n');
   const move=()=>{
     if(!mode||!dataSocket||!dataSocket._fixtureReady)return;
     const [verb,n]=mode;const d=dataSocket;mode=null;dataSocket=null;
     assert.equal(sessionPrivate,true);
     if(verb==='RETR'){d.end(downloads.get(n));d.once('close',()=>send('226 Transfer complete'));}
     else{const parts=[];d.on('data',b=>parts.push(b));d.on('end',()=>{received.set(n,Buffer.concat(parts));d.end();send('226 Transfer complete');});}
   };
   const handler=async b=>{
     text+=b;for(let end;(end=text.indexOf('\r\n'))!==-1;){
       const line=text.slice(0,end);text=text.slice(end+2);const [v,...p]=line.split(' '),n=p.join(' ');commandLog.push([c!==raw,v,n]);
       if(v==='AUTH'){
         raw.removeListener('data',handler);
         raw.write('234 Ready for TLS\r\n',()=>{c=track(new tls.TLSSocket(raw,{isServer:true,secureContext}));c.on('data',handler);});return;
       }
       if(v==='USER')send('331 Password needed');
       else if(v==='PASS')send('230 Logged in');
       else if(v==='PBSZ')send('200 PBSZ set');
       else if(v==='PROT'){sessionPrivate=n==='P';send('200 PROT set');}
       else if(v==='PWD')send('257 "/" is current directory');
       else if(v==='CWD'||v==='TYPE')send('200 OK');
       else if(v==='EPSV'||v==='PASV'){
         dataServer=createServer(net=>{track(net);const d=track(new tls.TLSSocket(net,{isServer:true,secureContext}));dataSocket=d;
           d.once('secure',()=>{d._fixtureReady=true;move();});dataServer.close();
         });passive.add(dataServer);dataServer.on('close',()=>passive.delete(dataServer));
         const pp=await listening(dataServer);
         send(v==='EPSV'?'229 Entering Extended Passive Mode (|||'+pp+'|)':'227 Entering Passive Mode (127,0,0,1,'+Math.floor(pp/256)+','+(pp%256)+')');
       }else if(v==='SIZE'){if(downloads.has(n))send('213 '+downloads.get(n).length);else send('550 Missing');}
       else if(v==='STOR'||v==='RETR'){mode=[v,n];send('150 Opening data channel');move();}
       else if(v==='QUIT')c.end('221 Bye\r\n');
       else send('500 Not implemented');
     }
   };
   raw.on('data',handler);send('220 Fixture ready');
 });
 const port=await listening(server);
 t.after(async()=>{for(const s of sockets)s.destroy();for(const p of passive)p.close();await new Promise(ok=>server.close(ok));});
 const c={...options,username:'fake',password:'Fake "quotes" \\ backslash $HOME; plain',host:'127.0.0.1',port,folder:['shared'],caFile:cert};
 assert.equal((await curlPrivateFtps(c,{direction:'download',name:'input.txt'})).toString(),'inbound bytes');
 await curlPrivateFtps(c,{direction:'upload',name:'sent.txt',data:Buffer.from('outbound bytes')});
 assert.equal(received.get('sent.txt').toString(),'outbound bytes');
 assert(commandLog.some(([overTls,v,n])=>overTls&&v==='PASS'&&n===c.password));
 assert(commandLog.some(([overTls,v,n])=>overTls&&v==='PROT'&&n==='P'));
 assert(commandLog.some(([overTls,v,n])=>overTls&&v==='CWD'&&n==='shared'));
 assert.equal(commandLog.some(([overTls,v])=>!overTls&&['USER','PASS','STOR','RETR'].includes(v)),false);
 await assert.rejects(curlPrivateFtps(c,{direction:'download',name:'large.txt'}),status(413));
 const before=commandLog.filter(([tls,v])=>v==='PASS').length;
 await assert.rejects(curlPrivateFtps({...c,caFile:undefined},{direction:'download',name:'input.txt'}),status(502));
 assert.equal(commandLog.filter(([tls,v])=>v==='PASS').length,before);
});
test('Full Suite main portal FTPS route requires session, terms and CSRF; no worker route',async t=>{
 const password='Fictional FTPS owner password',dir=await mkdtemp(join(tmpdir(),'fq-ftps-http-')),database=join(dir,'test.sqlite');
 const db=openStore(database),hash=await passwordHash(password),state=sampleVault();
 let owner;
 try{tx(db,()=>{saveBooks(db,state);owner=putUser(db,null,{username:'transfer-owner',name:'Transfer Owner',role:'owner',assignments:[]},hash,{bootstrap:true});putUser(db,{id:owner,role:'owner'},{username:'transfer-worker',name:'Transfer Worker',role:'worker',assignments:[state.companies[0].id],employeeId:state.companies[0].employees[0].id},hash);});}finally{db.close();}
 const companyId=state.companies[0].id;
 let calls=0;
 const d=makeDrive(a=>a.userId===owner&&a.companyId===companyId&&!a.groupId);
 const suite=await createSuite({database,mainPort:0,workerPort:0,driveFactory:()=>d,ftpsOptions:{...options,companyId,groupId:'',operatorIds:[owner]},
   ftpsTransport:async()=>{calls++;return Buffer.from('remote fixture');}});
 t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
 const path='private-ftps?companyId='+encodeURIComponent(companyId);
 for(const [url,username] of [[suite.mainUrl,'transfer-owner'],[suite.workerUrl,'transfer-worker']]){
   let cookie,csrf;
   const request=async(path,data,{omitCSRF}={})=>{const res=await fetch(url+'/api/'+path,{
     method:data===undefined?'GET':'POST',headers:{Origin:url,...(cookie?{Cookie:cookie}:{}),...(!omitCSRF&&csrf?{'X-CSRF-Token':csrf}:{}),'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)
   });return {status:res.status,headers:res.headers,json:await res.json()};};
   assert.equal((await request(path)).status,401);
   const login=await request('login',{username,password});
   assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.json.csrf;
   assert.equal((await request(path)).status,428);
   assert.equal((await request('terms',fixtureAgreement)).status,200);
   if(url===suite.mainUrl){
     assert.deepEqual((await request(path)).json,{enabled:true,maxBytes:FTPS_MAX_BYTES});
     const body={action:'download',remoteName:'report.txt',companyId};
     assert.equal((await request('private-ftps',body,{omitCSRF:true})).status,403);
     assert.equal(calls,0);
     const success=await request('private-ftps',body);assert.equal(success.status,200,JSON.stringify(success.json));
     assert.equal(success.json.id,'download');
     assert.equal(d.files.get('download').data.toString(),'remote fixture');
   }else assert.equal((await request(path)).status,404);
 }
 assert.equal(calls,1);
});

test('configured FTPS imports into the real drive and exports only the selected real file',async t=>{
 const password='Fictional FTPS drive owner password',dir=await mkdtemp(join(tmpdir(),'fq-ftps-drive-')),database=join(dir,'test.sqlite');
 const db=openStore(database),hash=await passwordHash(password),state=sampleVault();
 let owner;
 try{tx(db,()=>{saveBooks(db,state);owner=putUser(db,null,{username:'drive-ftps-owner',name:'Fixture Owner',role:'owner',assignments:[]},hash,{bootstrap:true});});}finally{db.close();}
 const companyId=state.companies[0].id,uploads=[];
 const suite=await createSuite({database,mainPort:0,workerPort:0,ftpsOptions:{...options,companyId,groupId:'',operatorIds:[owner]},
   ftpsTransport:async(c,transfer)=>{if(transfer.direction==='download')return Buffer.from('fixture import');transfer.beforeConnect();uploads.push(transfer);}});
 t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
 let cookie,csrf;
 const request=(path,data)=>fetch(suite.mainUrl+'/api/'+path,{method:data===undefined?'GET':'POST',
   headers:{Origin:suite.mainUrl,...(cookie?{Cookie:cookie}:{}),'X-CSRF-Token':csrf||'','Content-Type':'application/json'},
   body:data===undefined?undefined:JSON.stringify(data)});
 const login=await request('login',{username:'drive-ftps-owner',password});
 cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 assert.equal((await request('terms',fixtureAgreement)).status,200);
 const result=await request('private-ftps',{companyId,action:'download',remoteName:'in.csv'});
 assert.equal(result.status,200);
 const {id}=await result.json();
 const q=new URLSearchParams({companyId,id});
 const download=await request('drives/download?'+q);
 assert.equal(await download.text(),'fixture import');
 assert.equal((await request('private-ftps',{companyId,action:'upload',fileId:id})).status,200);
 assert.equal(uploads.length,1);assert.equal(uploads[0].data.toString(),'fixture import');
 assert.equal((await request('private-ftps',{companyId,groupId:'foreign',action:'upload',fileId:id})).status,403);
});

test('actual Full Suite Drives UI uploads and imports from its matching FTPS profile',{skip:!process.env.FIRMQUILL_BROWSER_EXE},async t=>{
 const password='Fictional FTPS browser owner password',dir=await mkdtemp(join(tmpdir(),'fq-ftps-browser-')),database=join(dir,'test.sqlite');
 const db=openStore(database),hash=await passwordHash(password),state=sampleVault();
 let owner;
 try{tx(db,()=>{saveBooks(db,state);owner=putUser(db,null,{username:'browser-ftps-owner',name:'Fixture Owner',role:'owner',assignments:[]},hash,{bootstrap:true});});}finally{db.close();}
 const companyId=state.companies[0].id,uploads=[];
 const suite=await createSuite({database,mainPort:0,workerPort:0,ftpsOptions:{...options,companyId,groupId:'',operatorIds:[owner]},
   ftpsTransport:async(c,transfer)=>{if(transfer.direction==='download')return Buffer.from('browser fixture import');transfer.beforeConnect();uploads.push(transfer);}});
 t.after(async()=>{await suite.close();await rm(dir,{recursive:true,force:true});});
 const {chromium}=createRequire(import.meta.url)(process.env.FIRMQUILL_PLAYWRIGHT||'playwright');
 const browser=await chromium.launch({headless:true,executablePath:process.env.FIRMQUILL_BROWSER_EXE});
 t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(suite.mainUrl);
 await page.locator('#login [name=username]').fill('browser-ftps-owner');
 await page.locator('#login [name=password]').fill(password);
 await page.locator('#login button').click();await acceptFixtureBrowser(page);
 await page.locator('[data-act=nav][data-key=Drives]').click();
 const panel=page.getByRole('region',{name:'FTPS manual transfers'});
 await panel.getByLabel('Exact remote filename').fill('fixture.csv');
 await panel.getByRole('button',{name:'Download into this folder'}).click();
 await page.getByRole('link',{name:'fixture.csv'}).waitFor();
 await panel.getByRole('button',{name:'Upload one copy'}).click();
 await panel.getByText(/^Uploaded as fq-.+-fixture.csv/).waitFor();
 assert.equal(uploads.length,1);
 assert.equal(uploads[0].data.toString(),'browser fixture import');
 assert.deepEqual(errors,[]);
});
