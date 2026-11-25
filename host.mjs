import {mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {openStore,putUser,tx,passwordHash,requireThat} from './store.mjs';
import {createSuite} from './server.mjs';

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
  requireThat(['init','serve','start'].includes(cmd),400,'Use node host.mjs init, serve or start.');
  const rel=relative(packageDir,database);requireThat(rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel),400,'Select a database path outside the program folder.');
  const exists=await stat(database).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
  requireThat(exists||cmd!=='serve',400,'Initialize the database with node host.mjs init.');
  await mkdir(dirname(database),{recursive:true,mode:0o700});
  const db=openStore(database);
  try{
    const initialized=!!db.prepare("SELECT 1 FROM accounts WHERE role='owner' AND active=1").get();
    if(cmd==='init'&&initialized)throw Error('An owner is already configured.');
    if(!initialized){
      requireThat(cmd!=='serve',400,'Initialize an owner first.');
      console.log('Create the first FirmQuill owner. The new workspace will be empty.');
      const username=await ask('Owner username: '),name=await ask('Display name: '),password=await ask('Password (12+ characters): ',true);
      requireThat(password===await ask('Confirm password: ',true),400,'Passwords differ.');
      const hashed=await passwordHash(password);
      tx(db,()=>{requireThat(!db.prepare('SELECT 1 FROM accounts LIMIT 1').get(),409,'A login already exists. Recover the database with its original owner.');putUser(db,null,{username,name,role:'owner',assignments:[]},hashed,{bootstrap:true});});
      console.log('Owner created.');
    }
  }finally{db.close();}
  if(cmd==='init')return;
  const {FIRMQUILL_MAIN_ORIGIN:mainOrigin,FIRMQUILL_WORKER_ORIGIN:workerOrigin}=process.env;
  requireThat((!mainOrigin&&!workerOrigin)||(mainOrigin&&workerOrigin&&mainOrigin!==workerOrigin),400,'Set two distinct HTTPS portal origins, or use both loopback defaults.');
  const mainPort=Number(process.env.FIRMQUILL_MAIN_PORT||4179),workerPort=Number(process.env.FIRMQUILL_WORKER_PORT||4180);
  requireThat([mainPort,workerPort].every(p=>Number.isInteger(p)&&p>=1&&p<=65535)&&mainPort!==workerPort,400,'Select two distinct TCP ports.');
  const suite=await createSuite({database,mainPort,workerPort,mainOrigin,workerOrigin});
  console.log('FirmQuill Full Suite   '+(mainOrigin||suite.mainUrl)+'/\nFirmQuill Worker       '+(workerOrigin||suite.workerUrl)+'/');
  let stopping=false;async function stop(){if(stopping)return;stopping=true;await suite.close();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});



