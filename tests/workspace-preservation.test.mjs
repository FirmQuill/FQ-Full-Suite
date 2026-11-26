import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createSuite} from '../server.mjs';
import {backupDatabase,restoreDatabase} from '../recovery.mjs';

function retained(database,tables){const db=new DatabaseSync(database,{readOnly:true});try{
  tables??=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name).filter(name=>name!=='terms_acceptance_hashes');
  return Object.fromEntries(tables.map(table=>[table,createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM "'+table.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort())).digest('hex')]));
}finally{db.close();}}
test('existing five-company fictional Harborline workspace retains books, identities and records through restart and encrypted recovery',{skip:!process.env.FIRMQUILL_HARBORLINE_FIXTURE},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fq-harborline-preserve-'));let suite;
  try{
    const database=join(dir,'harborline.sqlite');await cp(process.env.FIRMQUILL_HARBORLINE_FIXTURE,database);const before=retained(database);
    const count=new DatabaseSync(database,{readOnly:true});try{assert.equal(JSON.parse(count.prepare('SELECT body FROM books').get().body).companies.length,5);}finally{count.close();}
    for(let i=0;i<2;i++){suite=await createSuite({database,mainPort:0,workerPort:0});await suite.close();suite=null;assert.deepEqual(retained(database,Object.keys(before)),before);}
    const archive=join(dir,'backup.fqdb'),restored=join(dir,'restored.sqlite');await backupDatabase(database,archive,'Fictional preservation test only 2026!');await restoreDatabase(archive,restored,'Fictional preservation test only 2026!');
    suite=await createSuite({database:restored,mainPort:0,workerPort:0});await suite.close();suite=null;assert.deepEqual(retained(restored,Object.keys(before)),before);
  }finally{await suite?.close();await rm(dir,{recursive:true,force:true});}
});
