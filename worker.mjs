import {initializeProjects,visibleProjectJobs,authorizeProjectAction} from './project-workspace.mjs';
import {randomUUID} from 'node:crypto';
import {apply, validateState} from './shared/core.mjs';

const MINUTE = 60000;
const DAY = 1440 * MINUTE;

function requireValue(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), {status});
}

function zoneName() {
  const zone = process.env.FIRMQUILL_TIMEZONE || 'America/Denver';
  // Validate an IANA zone before the first punch is written.
  return new Intl.DateTimeFormat('en-US', {timeZone: zone}).resolvedOptions().timeZone;
}

function localDay(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return [fields.year, fields.month, fields.day].join('-');
}

function instant(text) {
  requireValue(typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text),
    'Enter a timestamp with a UTC offset or Z.');
  const millis = Date.parse(text);
  const day = new Date(text.slice(0,10) + 'T00:00:00Z');
  requireValue(Number.isFinite(millis) && Number.isFinite(day.valueOf()) &&
    day.toISOString().slice(0,10) === text.slice(0,10) && Number(text.slice(11,13)) < 24, 'Invalid timestamp.');
  return millis;
}

// Assign each complete elapsed minute to the work date on which that minute began.
// Binary search crosses midnight without assuming every local calendar day is 24 hours.
function slices(start, end, zone) {
  const minutes = Math.floor((end - start) / MINUTE);
  requireValue(end - start <= DAY && minutes >= 1, 'Approved shifts must be at least one minute and at most 24 hours. Request a correction.');
  const result = [];
  let offset = 0;
  while (offset < minutes) {
    const date = localDay(start + offset * MINUTE, zone);
    let low = offset + 1, high = minutes;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (localDay(start + mid * MINUTE, zone) === date) low = mid + 1;
      else high = mid;
    }
    result.push({date, minutes: low - offset});
    offset = low;
  }
  return result;
}

export function initializeWorker(db) {
  initializeProjects(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_shifts (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, employee TEXT NOT NULL, user_id TEXT NOT NULL,
      job TEXT NOT NULL, zone TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER,
      effective_start INTEGER, effective_end INTEGER, time_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS worker_open ON worker_shifts(company, employee) WHERE ended IS NULL;
    CREATE INDEX IF NOT EXISTS worker_own ON worker_shifts(company, employee, user_id, started);
    CREATE TABLE IF NOT EXISTS worker_requests (
      id TEXT PRIMARY KEY, shift TEXT NOT NULL REFERENCES worker_shifts(id), kind TEXT NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
      created INTEGER NOT NULL, reviewed INTEGER, reviewer TEXT,
      before_rows TEXT, after_rows TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS worker_pending_kind ON worker_requests(shift, kind) WHERE status='pending';
  `);
}

function workerIdentity(user, state) {
  requireValue(user?.role === 'worker' && Array.isArray(user.assignments) && user.assignments.length === 1, 'Worker access required.', 403);
  const book = state.companies.find(c => c.id === user.assignments[0]);
  const person = book?.employees.find(e => e.id === user.employeeId);
  requireValue(book && person, 'Worker assignment is unavailable.', 403);
  return {book, person};
}

function mayReview(user, company) {
  return user?.role === 'owner' || (user?.role === 'manager' && user.assignments?.includes(company));
}

function submitted(db, shift, kind, start, end, reason, at) {
  const id = 'w-' + randomUUID();
  db.prepare('INSERT INTO worker_requests(id,shift,kind,start,end,reason,status,created) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, shift, kind, start, end, reason, 'pending', at);
  return id;
}

function iso(millis) { return millis == null ? null : new Date(millis).toISOString(); }

export function workerView(db, user, state) {
  const {book, person} = workerIdentity(user, state);
  const jobs = visibleProjectJobs(db,user,book);
  const records = db.prepare('SELECT * FROM worker_shifts WHERE company=? AND employee=? AND user_id=? ORDER BY started DESC, id')
    .all(book.id, person.id, user.id);
  const requests = db.prepare('SELECT kind,start,end,reason,status,created,reviewed FROM worker_requests WHERE shift=? ORDER BY created,id');
  const shifts = records.map(s => ({
    id:s.id, job:jobs.find(j => j.id === s.job)?.name || 'Job', zone:s.zone,
    start:iso(s.started), end:iso(s.ended), approvedStart:iso(s.effective_start), approvedEnd:iso(s.effective_end),
    reviews:requests.all(s.id).map(r => ({kind:r.kind, start:iso(r.start), end:iso(r.end), reason:jobs.some(j=>j.id===s.job)?r.reason:(r.reason?'Project details restricted':''), status:r.status, created:iso(r.created), reviewed:iso(r.reviewed)}))
  }));
  const time = book.time.filter(r => r.employee === person.id).map(r => ({
    id:r.id, date:r.date, minutes:r.minutes, job:jobs.find(j => j.id === r.job)?.name || 'Job', approved:r.approved
  }));
  return {company:book.name, employee:person.name, timezone:zoneName(), jobs, openShift:shifts.find(s => !s.end) || null, shifts, time};
}

export function workerCommand(db, user, state, action, at = new Date()) {
  const {book, person} = workerIdentity(user, state);
  const now = at.getTime();
  const own = [book.id, person.id, user.id];
  if (action?.type === 'clock-in') {
    authorizeProjectAction(db,user,state,book.id,{jobId:action.jobId});
    requireValue(book.jobs.some(j => j.id === action.jobId), 'Select a job assigned to this company.');
    const open = db.prepare('SELECT id FROM worker_shifts WHERE company=? AND employee=? AND ended IS NULL').get(book.id, person.id);
    requireValue(!open, 'A shift is already open for this employee.', 409);
    db.prepare('INSERT INTO worker_shifts(id,company,employee,user_id,job,zone,started) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), ...own, action.jobId, zoneName(), now);
    return;
  }
  if (action?.type === 'clock-out') {
    const open = db.prepare('SELECT * FROM worker_shifts WHERE company=? AND employee=? AND user_id=? AND ended IS NULL').get(...own);
    requireValue(open, 'No open shift for this login.', 409);
    requireValue(action.shiftId === open.id, 'The open shift changed. Refresh before clocking out.', 409);
    requireValue(now >= open.started, 'Server clock is earlier than the original punch.');
    db.prepare('UPDATE worker_shifts SET ended=? WHERE id=?').run(now, open.id);
    submitted(db, open.id, 'Timesheet', open.started, now, '', now);
    return;
  }
  requireValue(action?.type === 'correction', 'Unknown worker action.');
  const shift = db.prepare('SELECT * FROM worker_shifts WHERE id=? AND company=? AND employee=? AND user_id=?').get(String(action.shiftId), ...own);
  requireValue(shift && shift.ended !== null, 'Completed shift unavailable.', 404);
  const start = instant(action.start), end = instant(action.end);
  requireValue(end <= now, 'Correction cannot include future time.');
  slices(start, end, shift.zone);
  const reason = typeof action.reason === 'string' ? action.reason.trim() : '';
  requireValue(reason.length > 0 && reason.length <= 300, 'Enter a correction reason of up to 300 characters.');
  const existing = db.prepare("SELECT id FROM worker_requests WHERE shift=? AND kind='Correction' AND status='pending'").get(shift.id);
  requireValue(!existing, 'A correction already awaits review.', 409);
  submitted(db, shift.id, 'Correction', start, end, reason, now);
}

export function workerPending(db, user, state) {
  if (!['owner','manager'].includes(user?.role)) return [];
  const rows = db.prepare(`SELECT r.*,s.company,s.employee,s.user_id,s.zone,s.job,s.started,s.ended,s.effective_start,s.effective_end
    FROM worker_requests r JOIN worker_shifts s ON s.id=r.shift WHERE r.status='pending' ORDER BY r.created,r.id`).all();
  return rows.filter(r => mayReview(user, r.company)).filter(r=>{try{authorizeProjectAction(db,user,state,r.company,{job:r.job});return true;}catch{return false;}}).map(r => {
    const c = state.companies.find(c => c.id === r.company);
    const employee = c?.employees.find(p => p.id === r.employee)?.name || 'Employee';
    const job = c?.jobs.find(p => p.id === r.job)?.name || 'Job';
    const duration = Math.floor((r.end - r.start) / MINUTE);
    const detail = [
      job, 'Recorded ' + iso(r.started) + ' to ' + iso(r.ended), r.kind === 'Correction' ? 'Requested '+iso(r.start)+' to '+iso(r.end) : '',
      r.effective_start == null ? '' : 'Previously approved '+iso(r.effective_start)+' to '+iso(r.effective_end),
      r.zone, duration+' complete minutes', r.reason
    ].filter(Boolean).join(' · ');
    return {id:r.id, companyId:r.company, kind:r.kind, label:employee+' · '+r.kind, status:r.status, requestedBy:employee, detail};
  });
}

export function workerReview(db, user, state, requestId, decision, at = new Date()) {
  requireValue(['owner','manager'].includes(user?.role), 'Manager access required.', 403);
  requireValue(['approve','reject'].includes(decision), 'Choose approve or reject.');
  const r = db.prepare('SELECT * FROM worker_requests WHERE id=?').get(requestId);
  const s = r && db.prepare('SELECT * FROM worker_shifts WHERE id=?').get(r.shift);
  requireValue(s && mayReview(user, s.company), 'Review unavailable.', 404);
  authorizeProjectAction(db,user,state,s.company,{job:s.job});
  requireValue(r.status === 'pending', 'Request already reviewed.', 409);
  requireValue(s.user_id !== user.id, 'Another manager must review your own time.', 403);
  const now = at.getTime();
  if (decision === 'reject') {
    db.prepare("UPDATE worker_requests SET status='rejected',reviewed=?,reviewer=? WHERE id=?").run(now, user.id, r.id);
    return state;
  }
  if (r.kind === 'Timesheet') {
    const pending = db.prepare("SELECT id FROM worker_requests WHERE shift=? AND kind='Correction' AND status='pending'").get(s.id);
    requireValue(!pending, 'Review the pending correction before approving the original punches.',409);
  }
  const overlap = db.prepare(`SELECT id FROM worker_shifts WHERE company=? AND employee=? AND id<>? AND
    ((effective_start IS NOT NULL AND effective_start<? AND effective_end>?) OR (ended IS NULL AND started<?))`)
    .get(s.company,s.employee,s.id,r.end,r.start,r.end);
  requireValue(!overlap, 'Proposed time overlaps another open or approved shift.', 409);
  const dates = slices(r.start, r.end, s.zone);
  const original = state.companies.find(c => c.id === s.company);
  requireValue(original, 'Linked company unavailable.');
  const ids = JSON.parse(s.time_ids), previous = original.time.filter(t => ids.includes(t.id));
  requireValue(previous.length === ids.length && previous.every(t => t.employee === s.employee && t.approved), 'Prior approved time differs from the shift linkage.',409);
  if (original.closedThrough) requireValue(previous.every(t => t.date > original.closedThrough), 'Prior time belongs to a closed period.',409);
  let next = structuredClone(state);
  const book = next.companies.find(c => c.id === s.company);
  book.time = book.time.filter(t => !ids.includes(t.id));
  const reviewDate = localDay(now, s.zone);
  const replacements = [];
  for (const part of dates) {
    next = apply(next, s.company, {type:'time', ...part, employee:s.employee, job:s.job, label:'Worker shift', requestId:r.id+'-time-'+part.date});
    const current = next.companies.find(c => c.id === s.company);
    const row = current.time.at(-1);
    next = apply(next, s.company, {type:'approve time', time:row.id, date:reviewDate, label:'Manager time approval', requestId:r.id+'-approval-'+part.date});
    replacements.push(row.id);
  }
  const updated = next.companies.find(c => c.id === s.company);
  const approved = updated.time.filter(t => replacements.includes(t.id));
  // Preserve the exact superseded rows alongside the new approval in the portable history.
  updated.history.at(-1).workerTimeReview = {shift:s.id, request:r.id, kind:r.kind, originalStart:iso(s.started), originalEnd:iso(s.ended), approvedStart:iso(r.start), approvedEnd:iso(r.end), reason:r.reason, priorTime:previous, newTime:replacements};
  validateState(next);
  db.prepare("UPDATE worker_requests SET status='approved',reviewed=?,reviewer=?,before_rows=?,after_rows=? WHERE id=?")
    .run(now,user.id,JSON.stringify(previous),JSON.stringify(approved),r.id);
  db.prepare('UPDATE worker_shifts SET effective_start=?,effective_end=?,time_ids=? WHERE id=?').run(r.start,r.end,JSON.stringify(replacements),s.id);
  if (r.kind === 'Correction') db.prepare("UPDATE worker_requests SET status='superseded',reviewer=?,reviewed=? WHERE shift=? AND kind='Timesheet' AND status='pending'").run(user.id,now,s.id);
  return next;
}
