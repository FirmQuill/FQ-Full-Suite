import {createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {link, lstat, open, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline';

const derive = promisify(scrypt);
const magic = Buffer.from('FQDBAK01');
const saltLength = 16, ivLength = 12, tagLength = 16;
const headerLength = magic.length + saltLength + ivLength;
export const MAX_DATABASE_BYTES = 64 * 1024 * 1024;

async function keyFor(password, salt) {
  if (typeof password !== 'string' || Array.from(password).length < 12) throw Error('Use a backup password of at least 12 characters.');
  return derive(password, salt, 32, {N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024});
}

function verifyDatabase(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== 1179735372 ||
      ![1,2].includes(db.prepare('PRAGMA user_version').get().user_version)) throw Error('Expected a FirmQuill Full Suite schema version 1 or 2 database.');
  const result = db.prepare('PRAGMA integrity_check(1)').get();
  if (result.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw Error('SQLite integrity or foreign-key verification failed.');
  const schema = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (['books', 'accounts', 'audit', 'requests', 'approvals', 'worker_shifts', 'worker_requests'].some(table => !schema.has(table))) {
    throw Error('The database is missing a required Full Suite table.');
  }
}

function takeSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, {readOnly: true, timeout: 4000});
  try {
    db.exec('BEGIN');
    verifyDatabase(db);
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    if (pages * pageSize > MAX_DATABASE_BYTES) throw Error('This recovery utility supports databases up to 64 MiB.');
    const image = db.serialize();
    db.exec('COMMIT');
    return image;
  } finally { db.close(); }
}

async function assertAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Destination already exists. Choose a fresh filename.');
}

async function cleanDatabaseTarget(target) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await assertAbsent(target + suffix);
}

// Stage, flush, verify, then create a hard link. A competing creator wins safely.
// Keep staging on the destination filesystem so the final no-overwrite link is atomic.
async function publish(target, chunks, verify) {
  await assertAbsent(target);
  const stage = join(dirname(target), '.firmquill-' + randomUUID() + '.partial');
  const file = await open(stage, 'wx', 0o600);
  try {
    try {
      for (const chunk of chunks) await file.writeFile(chunk);
      await file.sync();
    } finally { await file.close(); }
    if (verify) await verify(stage);
    await link(stage, target);
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await unlink(stage + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function readEncrypted(path) {
  const file = await open(path, 'r');
  try {
    const {size} = await file.stat();
    if (size <= headerLength + tagLength || size > MAX_DATABASE_BYTES + headerLength + tagLength) throw Error('Invalid recovery archive size.');
    const data = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      const {bytesRead} = await file.read(data, position, size - position, position);
      if (bytesRead === 0) throw Error('Recovery archive was truncated.');
      position += bytesRead;
    }
    if ((await file.stat()).size !== size) throw Error('Recovery archive changed during reading.');
    return data;
  } finally { await file.close(); }
}

export async function backupDatabase(dbPath, destination, password) {
  if (!destination.toLowerCase().endsWith('.fqdb')) throw Error('Use the .fqdb extension for a Full Suite recovery archive.');
  await assertAbsent(destination);
  const salt = randomBytes(saltLength), iv = randomBytes(ivLength);
  const header = Buffer.concat([magic, salt, iv]);
  const key = await keyFor(password, salt);
  let image;
  try {
    image = takeSnapshot(dbPath);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const chunks = [header, cipher.update(image), cipher.final(), cipher.getAuthTag()];
    await publish(destination, chunks);
    return {databaseBytes: image.length, schema: Buffer.from(image.subarray(60,64)).readUInt32BE(0)};
  } finally { key.fill(0); image?.fill(0); }
}

export async function restoreDatabase(archivePath, destination, password) {
  if (!/\.(sqlite|db)$/i.test(destination)) throw Error('Use a fresh .sqlite or .db recovery destination.');
  await cleanDatabaseTarget(destination);
  const data = await readEncrypted(archivePath);
  if (!data.subarray(0, magic.length).equals(magic)) throw Error('Unknown recovery archive format.');
  const header = data.subarray(0, headerLength);
  const key = await keyFor(password, header.subarray(magic.length, magic.length + saltLength));
  let decoded;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length + saltLength));
    cipher.setAAD(header);
    cipher.setAuthTag(data.subarray(-tagLength));
    try {
      decoded = cipher.update(data.subarray(headerLength, -tagLength));
      cipher.final();
    } catch { throw Error('Recovery authentication failed. Check the archive and password.'); }
    await publish(destination, [decoded], async stage => {
      const db = new DatabaseSync(stage, {readOnly: true});
      try { verifyDatabase(db); } finally { db.close(); }
      await cleanDatabaseTarget(destination);
    });
    return {databaseBytes: decoded.length, schema: decoded.readUInt32BE(60)};
  } finally { key.fill(0); decoded?.fill(0); }
}

async function promptPassword(label) {
  if (!process.stdin.isTTY) throw Error('Run recovery from an interactive terminal to enter the password privately.');
  process.stderr.write(label);
  const silentOutput = new Writable({write(_chunk, _encoding, done) { done(); }});
  const rl = createInterface({input: process.stdin, output: silentOutput, terminal: true, historySize: 0});
  try {
    return await new Promise((resolveAnswer, reject) => {
      rl.once('SIGINT', () => reject(Error('Recovery cancelled.')));
      rl.once('close', () => reject(Error('Recovery cancelled.')));
      rl.question('', resolveAnswer);
    });
  } finally { rl.close(); silentOutput.end(); process.stderr.write('\n'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, input, destination] = process.argv.slice(2);
    if (!['backup', 'restore'].includes(operation) || !input || !destination || process.argv.length !== 5) {
      throw Error('Usage: node recovery.mjs backup existing.sqlite new.fqdb | restore existing.fqdb new.sqlite');
    }
    const password = await promptPassword('Recovery password: ');
    if (operation === 'backup' && password !== await promptPassword('Confirm password: ')) throw Error('Passwords differ.');
    const result = await (operation === 'backup' ? backupDatabase : restoreDatabase)(input, destination, password);
    console.log('Verified ' + operation + ' completed (' + result.databaseBytes + ' database bytes).');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
