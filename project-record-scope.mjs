// Resolve linked records against the full company before any area projection.
// Imported journals and attachments can reference another source record rather
// than carrying the project ID themselves.
export function projectRecordScope(company, hidden) {
  const denied = new Set(hidden);
  const records = ['history','docs','time','entries','moves','bank','attachments']
    .flatMap(key => company[key] || []);
  const journalIds = new Set((company.entries || []).map(record => record.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      const references = [record.job,record.jobId,record.projectId,record.source,
        record.parent,record.approval,record.match,record.reverses];
      if (!denied.has(record.id) && references.some(id => id && denied.has(id))) {
        denied.add(record.id);
        changed = true;
      }
      // The approval event belongs to its time entry, although the event itself
      // does not carry the time entry's job ID.
      if (denied.has(record.id) && record.approval && !denied.has(record.approval)) {
        denied.add(record.approval);
        changed = true;
      }
      // A generated reversal points to the original journal through reverses;
      // hide its own source event (and attached files) with the journal too.
      if (denied.has(record.id) && journalIds.has(record.id) && record.source && !denied.has(record.source)) {
        denied.add(record.source);
        changed = true;
      }
    }
  }
  return {hidden,denied};
}
