import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createVaultService} from '../shared/vault.mjs';
import {apply, consolidate, validateState} from '../shared/core.mjs';
import {sampleVault} from '../shared/sample.mjs';
import {assertEmptyDestination, exportLite, inspectLite, summarizeBooks} from '../transfer.mjs';
import {backupDatabase, restoreDatabase} from '../recovery.mjs';
import {openStore, readBooks, saveBooks, putUser, safeUser, passwordHash, passwordMatches, actionFor, workerCommand, tx} from '../store.mjs';

const password = 'Synthetic transfer test passphrase';
function standaloneLite() {
  let value = null;
  return createVaultService({
    async read() { return value; },
    async replace(expected, next) { assert.equal(value?.token ?? null, expected); value = next; }
  });
}

test('encrypted owner transfer preserves every record, attachment, company control and group elimination', async () => {
  let before = sampleVault();
  const source = before.companies[0];
  const data = Buffer.from([0, 1, 127, 128, 255]).toString('base64');
  before = apply(before, source.id, {type:'attachment', source:source.history[0].id, name:'Synthetic file.bin', data, date:'2026-02-01'});
  const lite = await standaloneLite().createVault(password, before, validateState);
  const imported = await inspectLite(lite.backup(), password);
  assert.deepEqual(imported.state, before);
  assert.deepEqual(imported.summary.companies.map(c => c.balances.cash), [1542000, 994800]);
  assert.deepEqual(imported.summary.companies.map(c => c.balances.trialDifference), [0, 0]);
  assert.equal(imported.summary.companies[0].attachmentBytes, 5);
  assert.equal(imported.summary.groups, 1);
  assert.equal((await inspectLite(lite.backup(), password)).digest, imported.digest);
  const exported = await exportLite(imported.state, password);
  assert.deepEqual(exported.summary, imported.summary);
  assert.equal(exported.envelope.includes(source.name), false);
  const restored = await standaloneLite().restoreVault(exported.envelope, password, validateState);
  assert.deepEqual(restored.state, before);
  assert.deepEqual(consolidate(restored.state, before.groups[0].id), consolidate(before, before.groups[0].id));
  lite.lock(); restored.lock();
});

test('transfers reject wrong passwords, tampering, dangling links and unrecognized data', async () => {
  const before = sampleVault();
  const {envelope} = await exportLite(before, password);
  await assert.rejects(inspectLite(envelope, 'wrong synthetic password'), /Unable to unlock/);
  const edit = JSON.parse(envelope);
  edit.ciphertext = (edit.ciphertext[0] === 'B' ? 'A' : 'B') + edit.ciphertext.slice(1);
  await assert.rejects(inspectLite(JSON.stringify(edit), password), /Unable to unlock/);
  await assert.rejects(exportLite(before, 'weak'), /12 characters/);
  assert.throws(() => summarizeBooks({...before, users:[]}), /Unrecognized/);
  before.companies[0].docs[0].party = before.companies[1].parties[0].id;
  assert.throws(() => summarizeBooks(before));
});

test('empty-destination rule disallows live books, configured companies and existing groups', () => {
  const s = sampleVault();
  assert.doesNotThrow(() => assertEmptyDestination(null));
  assert.doesNotThrow(() => assertEmptyDestination({...s, companies:[], groups:[]}));
  for (const state of [s, {...s, companies:[]}, {}, undefined]) assert.throws(() => assertEmptyDestination(state), /empty/);
});

test('whole database recovery authenticates a consistent WAL snapshot and refuses existing destinations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'firmquill-synthetic-'));
  t.after(async () => {
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  });
  const source = join(dir, 'source.sqlite'), backup = join(dir, 'recovery.fqdb'), recovered = join(dir, 'recovered.sqlite');
  const original = openStore(source);
  try {
    original.exec('PRAGMA wal_autocheckpoint=0');
    const state=sampleVault(), company=state.companies[0];
    const hash=await passwordHash('Synthetic recovery account password');
    saveBooks(original,state);
    const account=(id)=>safeUser(original.prepare('SELECT * FROM accounts WHERE id=?').get(id));
    const owner=account(putUser(original,null,{username:'synthetic.owner',name:'Synthetic owner',role:'owner'},hash,{bootstrap:true}));
    const worker=account(putUser(original,owner,{username:'synthetic.worker',name:'Synthetic worker',role:'worker',employeeId:company.employees[0].id,assignments:[company.id]},hash));
    const clerk=account(putUser(original,owner,{username:'synthetic.clerk',name:'Synthetic clerk',role:'bookkeeper',assignments:[company.id]},hash));
    tx(original,()=>workerCommand(original,worker,state,{type:'clock-in',jobId:company.jobs[0].id},new Date('2026-02-01T12:00:00Z')));
    const openShift=original.prepare('SELECT id FROM worker_shifts WHERE user_id=? AND ended IS NULL').get(worker.id);
    tx(original,()=>workerCommand(original,worker,state,{type:'clock-out',shiftId:openShift.id},new Date('2026-02-01T13:00:00Z')));
    tx(original,()=>actionFor(original,clerk,{companyId:company.id,revision:readBooks(original).revision,action:{type:'journal',date:'2026-02-01',
      label:'Synthetic pending entry',lines:[['1000',825],['3000',-825]],flow:'Financing',requestId:'synthetic-request-recovery'}}));
    const tables=['books','accounts','audit','requests','approvals','worker_shifts','worker_requests'];
    const rows=(db,table)=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
    const committed=new Map(tables.map(table=>[table,rows(original,table)]));
    for (const [table,records] of committed) assert.ok(records.length>0,table+' has test data');
    assert.ok((await stat(source+'-wal')).size>0);
    original.exec("BEGIN; UPDATE accounts SET name='Uncommitted'");
    await backupDatabase(source, backup, password);
    original.exec('ROLLBACK');
    const bytes = await readFile(backup);
    assert.equal(bytes.includes(Buffer.from('Synthetic worker')), false);
    await assert.rejects(backupDatabase(source, backup, password), /already exists/);
    await assert.rejects(restoreDatabase(backup, recovered, 'Incorrect synthetic passphrase'), /authentication/);
    await assert.rejects(stat(recovered), {code:'ENOENT'});
    const damaged = join(dir, 'damaged.fqdb');
    bytes[bytes.length-1] ^= 1;
    await writeFile(damaged, bytes);
    await assert.rejects(restoreDatabase(damaged, recovered, password), /authentication/);
    await assert.rejects(stat(recovered), {code:'ENOENT'});
    await restoreDatabase(backup, recovered, password);
    const restored = new DatabaseSync(recovered, {readOnly:true});
    try {
      for (const [table,expected] of committed) assert.deepEqual(rows(restored,table),expected,table);
      assert.deepEqual(readBooks(restored).state,state);
      assert.equal(await passwordMatches('Synthetic recovery account password',restored.prepare('SELECT hash FROM accounts WHERE id=?').get(worker.id).hash),true);
    } finally { restored.close(); }
    await assert.rejects(restoreDatabase(backup, recovered, password), /already exists/);
    await assert.rejects(restoreDatabase(backup, source, password), /already exists/);
    assert.deepEqual(readBooks(original).state,state);
  } finally { original.close(); }
});
