import {INSTALLED_VERSION} from './support.mjs';

// Each check asks only whether fixed application schema objects are present.
// Do not query table data or include raw results, diagnostics, configuration, or metadata.
const modules=Object.freeze({
  books:['books'],
  approvals:['approvals','requests'],
  employeePortal:['worker_shifts','worker_requests'],
  employeeRecords:['employee_records','employee_reviews','employee_paystubs'],
  benefits:['enrollment_instances','retirement_changes'],
  companyKnowledge:['company_knowledge_articles','company_knowledge_revisions'],
  collaboration:['collaboration_groups','collaboration_messages'],
  drives:['drive_entries'],
  monthEndClose:['month_end_close']
});
const version=value=>typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)?value:'unknown';

export function supportDiagnostics(db) {
  const hasTable=db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?");
  const schemaVersion=db.prepare('PRAGMA user_version').get().user_version;
  const checks=Object.fromEntries(Object.entries(modules).map(([name,tables])=>[
    name,tables.every(table=>hasTable.get(table)?.present===1)?'schema-present':'schema-unavailable'
  ]));
  return {
    format:'firmquill.support-diagnostics.v1',
    product:{edition:'Full Suite',version:INSTALLED_VERSION},
    runtime:{node:version(process.versions.node),sqlite:version(db.prepare('SELECT sqlite_version() AS value').get().value)},
    schemaVersion:[1,2].includes(schemaVersion)?schemaVersion:'unrecognized',
    checks
  };
}
