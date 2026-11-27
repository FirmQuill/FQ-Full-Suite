import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startWindowsAddon} from '../addon-windows-supervisor.mjs';

test('native supervisor refuses incomplete/unverified launch configuration',async()=>{
  await assert.rejects(startWindowsAddon({}),/Windows add-on isolation/);
  await assert.rejects(startWindowsAddon({args:['one','two']}),/Windows add-on isolation/);
});

test('actual Windows gate starts Node in a verified standard AppContainer and verifies cleanup',{
  skip:process.platform!=='win32'||process.env.FIRMQUILL_NATIVE_TEST!=='1',timeout:60000
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'fq-native-gate-'));let child;
  t.after(async()=>{await child?.close();const checked=resolve(root);assert.ok(checked.startsWith(resolve(tmpdir())+'\\'));await rm(checked,{recursive:true,force:true});});
  const payload=join(root,'payload'),data=join(root,'data'),core=join(root,'protected-core');
  await Promise.all([payload,data,core].map(p=>mkdir(p)));
  const database=join(core,'fictional.sqlite'),runner=join(root,'runner.mjs'),entry=join(payload,'index.mjs');
  await writeFile(database,'Disposable fictional native access-check canary.');
  await writeFile(runner,"import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[2])); process.stdin.resume();\n");
  await writeFile(entry,"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[3]+'/executed.txt','fictional marker');process.stdout.write(JSON.stringify({ready:true})+'\\n');\n");
  const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($p in @($env:FQ_PAYLOAD,$env:FQ_DATA,$env:FQ_CORE)){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($s in @($sid.Value,'S-1-5-18')){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath $p -AclObject $a}";
  await promisify(execFile)(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{SystemRoot:process.env.SystemRoot,FQ_PAYLOAD:payload,FQ_DATA:data,FQ_CORE:core}});
  try{
    child=await startWindowsAddon({runnerPath:runner,payloadDirectory:payload,dataDirectory:data,supervisorDirectory:join(root,'supervisor'),args:[entry],protectedPaths:[core,database],lessPrivileged:false});
    assert.equal(child.protection.appContainer,true);assert.equal(child.protection.lpac,false);assert.equal(child.protection.capabilities,0);assert.equal(child.protection.activeProcessLimit,1);assert.equal(child.protection.killOnClose,true);assert.equal(child.protection.protectedPathsDenied,2);assert.equal(child.protection.inheritedStationReadOnly,true);assert.equal(child.protection.stationHandleAccess,2);assert.equal(child.protection.stationAclUnchanged,true);
    let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
    for(let n=0;n<50&&!output.includes('ready');n++)await new Promise(r=>setTimeout(r,100));
    assert.match(output,/"ready":true/,'native token verification alone is not proof that Node can initialize: '+errors+' exit='+child.serviceExitCode);
    assert.equal(await readFile(join(data,'executed.txt'),'utf8'),'fictional marker');
    await child.close();t.diagnostic('NATIVE_RUNTIME_READY: Node executed inside the verified AppContainer; full denial/broker tests are separate.');
  }catch(error){
    t.diagnostic('NATIVE_RUNTIME_BLOCKED: '+error.message+'; a refusal with cleanup does not pass this positive readiness gate.');
    throw error;
  }
});
