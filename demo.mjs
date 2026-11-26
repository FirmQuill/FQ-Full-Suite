import {mkdir,open,rm} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {openStore} from './store.mjs';
import {seedWorkforceDemo} from './fixtures/workforce-demo.mjs';

async function secret(label){
  if(!process.stdin.isTTY)throw Error('Run this demo setup in an interactive terminal.');
  process.stdout.write(label);const output=new Writable({write(chunk,encoding,done){done();}}),rl=createInterface({input:process.stdin,output,terminal:true,historySize:0});
  try{return await new Promise((yes,no)=>{rl.once('SIGINT',()=>no(Error('Demo setup cancelled.')));rl.once('close',()=>no(Error('Demo setup cancelled.')));rl.question('',yes);});}finally{rl.close();output.end();process.stdout.write('\n');}
}
async function main(){
  if(process.argv[2]!=='--create'||!process.argv[3]||process.argv.length!==4||!isAbsolute(process.argv[3]))throw Error('Use node demo.mjs --create C:\\path\\outside-the-program\\fictional-demo.sqlite');
  const program=dirname(fileURLToPath(import.meta.url)),database=resolve(process.argv[3]),rel=relative(program,database);
  if(!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel))throw Error('Choose a new database file outside the program folder.');
  console.log('This creates a separate FICTIONAL demo company and six sample logins. It never opens or changes an existing database.');
  const password=await secret('Choose a demo password (12+ characters, no preset password): ');if(password!==await secret('Confirm demo password: '))throw Error('Passwords differ.');
  await mkdir(dirname(database),{recursive:true,mode:0o700});const handle=await open(database,'wx',0o600);await handle.close();let db;
  try{db=openStore(database);await seedWorkforceDemo(db,{password});}catch(error){db?.close();db=null;for(const suffix of ['','-wal','-shm'])await rm(database+suffix,{force:true});throw error;}finally{db?.close();}
  console.log('Created fictional demo at '+database+'\nLogins: demo-owner, demo-worker, demo-other-worker, demo-manager, demo-hr, demo-payroll.\nUse the password you just chose. Demo users share that explicitly chosen test password.\nSet FIRMQUILL_DB to this file and run node host.mjs serve.\nThe 2027/2028 demo enrollment windows are intentionally open around the date this fixture is created; they are illustrative employer rules.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
