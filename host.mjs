import {releaseAddonOptions} from './addon-provision.mjs';
import {manualPackageFolderOptionsFromEnv} from './manual-package-folder.mjs';
import {backupOptionsFromEnv} from './scheduled-backups.mjs';
import {ftpsOptionsFromEnv} from './ftps.mjs';
import {mkdir,stat,readdir,readFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {openStore,putUser,tx,passwordHash,requireThat} from './store.mjs';
import {createSuite} from './server.mjs';
import {inspectSetupPackage,initializeSetupPackage,MAX_SETUP_BYTES} from './setup-package.mjs';
import {createSetupWizard} from './setup-wizard.mjs';

const packageDir=dirname(fileURLToPath(import.meta.url));
const database=resolve(process.env.FIRMQUILL_DB||resolve(packageDir,'../FirmQuill-data/books.sqlite'));
async function ask(label,hidden=false){
  requireThat(process.stdin.isTTY,400,'Open an interactive terminal to initialize the owner account.');
  process.stdout.write(label);
  const output=hidden?new Writable({write(chunk,enc,done){done();}}):process.stdout;
  const rl=createInterface({input:process.stdin,output,terminal:true,historySize:0});
  try{return await new Promise((resolve,reject)=>{rl.once('SIGINT',()=>reject(Error('Setup cancelled.')));rl.once('close',()=>reject(Error('Setup cancelled.')));rl.question('',resolve);});}
  finally{rl.close();if(hidden){output.end();process.stdout.write('\n');}}
}
async function main(){
  const cmd=process.argv[2]||'start';
  requireThat(['init','serve','start','configure','setup-preview','setup'].includes(cmd),400,'Use node host.mjs init, serve, start, configure, setup-preview FILE, or setup FILE.');
  const rel=relative(packageDir,database);requireThat(rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel),400,'Select a database path outside the program folder.');
  let exists=await stat(database).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
  if(cmd==='configure'){
    requireThat(!exists,409,'Configure requires a fresh FIRMQUILL_DB filename; existing workspaces remain unchanged.');
    const wizard=await createSetupWizard({destination:database});console.log('Open this private first-launch setup link on this computer (expires after 30 minutes):\n'+wizard.url+'\nStop with Ctrl+C after setup, then run node host.mjs start.');
    process.once('SIGINT',()=>wizard.close());process.once('SIGTERM',()=>wizard.close());return;
  }
  let setupFile=process.argv[3];
  if(['setup','setup-preview'].includes(cmd))requireThat(setupFile&&process.argv.length===4,400,'Specify exactly one .fqsetup.json file.');
  if(!exists&&['start','init'].includes(cmd)){
    const discover=resolve(dirname(database),'../FirmQuill-setup');
    const files=await readdir(discover).then(names=>names.filter(n=>/^[a-zA-Z0-9_.-]+\.fqsetup\.json$/.test(n)).sort(),e=>{if(e.code==='ENOENT')return [];throw e;});
    if(files.length){
      console.log('Approved setup packages found in '+discover);files.forEach((name,i)=>console.log((i+1)+'. '+name));
      const choice=await ask('Package number, or Enter for an empty workspace: ');
      if(choice){requireThat(/^\d+$/.test(choice)&&files[Number(choice)-1],400,'Choose a listed package number.');setupFile=resolve(discover,files[Number(choice)-1]);}
    }
  }
  if(setupFile){
    requireThat(cmd==='setup-preview'||!exists,409,'Existing workspaces are never initialized again. Choose a fresh FIRMQUILL_DB filename.');
    requireThat(setupFile.toLowerCase().endsWith('.fqsetup.json'),400,'Choose a .fqsetup.json data package.');
    const file=resolve(setupFile),info=await stat(file);requireThat(info.isFile()&&info.size<=MAX_SETUP_BYTES,413,'Invalid or oversized setup package.');
    const packageText=await readFile(file,'utf8'),preview=inspectSetupPackage(packageText);
    const {dataset,approval,...display}=preview;console.log(JSON.stringify(display,null,2));
    if(cmd==='setup-preview')return;
    requireThat(await ask('Review the scope, exceptions and balances above. Type INITIALIZE to confirm: ')==='INITIALIZE',400,'Setup cancelled; no package was applied.');
    await initializeSetupPackage({packageText,destination:database,confirmedDigest:preview.digest});exists=true;
    console.log('Package initialized and reconciled. Create your own first administrator below.');
  }
  requireThat(exists||cmd!=='serve',400,'Initialize the database with node host.mjs init.');
  await mkdir(dirname(database),{recursive:true,mode:0o700});
  const db=openStore(database);
  try{
    const initialized=!!db.prepare("SELECT 1 FROM accounts WHERE role='owner' AND active=1").get();
    if(cmd==='init'&&initialized)throw Error('An owner is already configured.');
    if(!initialized){
      requireThat(cmd!=='serve',400,'Initialize an owner first.');
      console.log('Create the first FirmQuill owner (administrator).');
      const username=await ask('Owner username: '),name=await ask('Display name: '),password=await ask('Password (12+ characters): ',true);
      requireThat(password===await ask('Confirm password: ',true),400,'Passwords differ.');
      const hashed=await passwordHash(password);
      tx(db,()=>{requireThat(!db.prepare('SELECT 1 FROM accounts LIMIT 1').get(),409,'A login already exists. Recover the database with its original owner.');putUser(db,null,{username,name,role:'owner',assignments:[]},hashed,{bootstrap:true});});
      console.log('Owner created.');
    }
  }finally{db.close();}
  if(cmd==='init'||cmd==='setup')return;
  const {FIRMQUILL_MAIN_ORIGIN:mainOrigin,FIRMQUILL_WORKER_ORIGIN:workerOrigin}=process.env;
  requireThat((!mainOrigin&&!workerOrigin)||(mainOrigin&&workerOrigin&&mainOrigin!==workerOrigin),400,'Set two distinct HTTPS portal origins, or use both loopback defaults.');
  const mainPort=Number(process.env.FIRMQUILL_MAIN_PORT||4179),workerPort=Number(process.env.FIRMQUILL_WORKER_PORT||4180);
  requireThat([mainPort,workerPort].every(p=>Number.isInteger(p)&&p>=1&&p<=65535)&&mainPort!==workerPort,400,'Select two distinct TCP ports.');
  const supportOptions={...(process.env.FIRMQUILL_SUPPORT_DOCS?{documentationRoot:process.env.FIRMQUILL_SUPPORT_DOCS}:{}),contextualRoot:process.env.FIRMQUILL_CONTEXTUAL_DOCS,signedSupport:{packagePath:process.env.FIRMQUILL_SIGNED_SUPPORT_PACKAGE,verifierPath:process.env.FIRMQUILL_SUPPORT_PACKAGE_PUBLIC_KEY},packageFolder:manualPackageFolderOptionsFromEnv()};
  const addonConfiguration=await releaseAddonOptions(database);
  const suite=await createSuite({database,mainPort,workerPort,mainOrigin,workerOrigin,addonOrigin:process.env.FIRMQUILL_ADDON_ORIGIN||mainOrigin,supportOptions,...addonConfiguration,ftpsOptions:ftpsOptionsFromEnv(),backupOptions:backupOptionsFromEnv()});
  console.log('FirmQuill Full Suite   '+(mainOrigin||suite.mainUrl)+'/\nFirmQuill Worker       '+(workerOrigin||suite.workerUrl)+'/');
  let stopping=false;async function stop(){if(stopping)return;stopping=true;await suite.close();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});



