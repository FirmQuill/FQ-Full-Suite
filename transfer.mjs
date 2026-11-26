import {validatePlanning} from './shared/planning-core.mjs';
import {validateManualPayroll} from './shared/manual-payroll.mjs';
import {validateDesk} from './shared/desk-core.mjs';
import {createHash} from 'node:crypto';
import {createVaultService, MAX_BACKUP_BYTES} from './shared/vault.mjs';
import {statements, validateState} from './shared/core.mjs';

function envelopeDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function memoryVault(envelope = null) {
  return createVaultService({
    async read() { return envelope; },
    async replace(expected, next) {
      if ((envelope?.token ?? null) !== expected) throw Error('The transfer changed during encryption.');
      envelope = next;
    }
  });
}

function attachmentLength(file) {
  if (typeof file.data !== 'string' || file.data.length > 1_400_000) throw Error('Invalid portable attachment size.');
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.toString('base64') !== file.data) throw Error('Invalid portable attachment encoding.');
  return bytes.length;
}

function validatePortable(state) {
  validateState(state);
  const portableKeys = ['format', 'schema', 'edition', 'currency', 'companies', 'groups'];
  if (Object.keys(state).some(key => !portableKeys.includes(key))) throw Error('Unrecognized portable data sections.');
  for (const company of state.companies) {
    validateDesk(company);
    validatePlanning(company);
    validateManualPayroll(company.manualPayroll,company);
    for (const file of company.attachments) attachmentLength(file);
    for (const entry of company.entries) {
      if (!entry.pair && !entry.other) continue;
      const partner = state.companies.find(c => c.id === entry.other && c.id !== company.id);
      if (!entry.pair || partner?.entries.filter(e => e.pair === entry.pair && e.other === company.id && e.date === entry.date).length !== 1) {
        throw Error('Intercompany transfer contains an incomplete pair.');
      }
    }
  }
  return true;
}

export function summarizeBooks(state) {
  validatePortable(state);
  const companies = state.companies.map(company => {
    const report = statements(company.entries);
    return {
      id: company.id, name: company.name, documents: company.docs.length,
      employees: company.employees.length, attachments: company.attachments.length,
      attachmentBytes: company.attachments.reduce((sum, file) => sum + attachmentLength(file), 0),
      journals: company.entries.length, history: company.history.length,
      balances: {
        cash: report.closingCash, receivables: report.balances['1100'],
        payables: -report.balances['2000'] || 0, inventory: report.balances['1200'],
        netIncome: report.income, trialDifference: report.trialDifference
      }
    };
  });
  return {companies, groups: state.groups.length};
}

export function assertEmptyDestination(state) {
  if (state === null || (state && Array.isArray(state.companies) && state.companies.length === 0 &&
    Array.isArray(state.groups) && state.groups.length === 0)) return;
  throw Error('Lite import requires an empty Full Suite destination. Existing companies cannot be merged or replaced.');
}

export async function inspectLite(envelopeText, password) {
  if (typeof envelopeText !== 'string' || envelopeText.length > MAX_BACKUP_BYTES ||
    Buffer.byteLength(envelopeText) > MAX_BACKUP_BYTES) throw Error('Invalid or oversized encrypted Lite backup.');
  let envelope;
  try { envelope = JSON.parse(envelopeText); } catch { throw Error('Invalid encrypted Lite backup file.'); }
  const unlocked = await memoryVault(envelope).openVault(password, validatePortable);
  try {
    const state = unlocked.state;
    return {state, summary: summarizeBooks(state), digest: envelopeDigest(envelopeText)};
  } finally { unlocked.lock(); }
}

export async function exportLite(state, password) {
  const summary = summarizeBooks(state);
  const vault = await memoryVault().createVault(password, state, validatePortable);
  try {
    const envelope = vault.backup();
    return {envelope, summary, digest: envelopeDigest(envelope)};
  } finally { vault.lock(); }
}
