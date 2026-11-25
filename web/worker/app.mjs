import {openAccount} from '/legal/account.mjs';
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
let session, busy = false, noticeTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function stamp(value, zone) {
  return new Intl.DateTimeFormat('en-US', {timeZone:zone, month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short'}).format(new Date(value));
}
function say(message) {
  clearTimeout(noticeTimer); notice.textContent = message;
  noticeTimer = setTimeout(() => {notice.textContent='';}, 5500);
}
function login() {
  session = null;
  app.innerHTML = '<section class="login"><h1>Worker sign in</h1><form id="login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><p class="error" role="alert"></p><button class="primary">Sign in</button></form></section>';
}
async function api(path, body) {
  const options = {credentials:'same-origin',cache:'no-store'};
  if (body !== undefined) {
    options.method='POST'; options.headers={'Content-Type':'application/json'};
    if(session?.csrf) options.headers['X-CSRF-Token']=session.csrf;
    options.body=JSON.stringify(body);
  }
  const res = await fetch('/api/'+path, options);
  const payload = await res.json().catch(() => ({}));
  if(!res.ok) {
    if(res.status===401 && path!=='login') login();
    throw Error(typeof payload.error === 'string' ? payload.error : 'The request could not be completed.');
  }
  return openAccount(payload);
}
function shiftCard(s) {
  const pending=s.reviews.some(r => r.kind==='Correction' && r.status==='pending');
  const history=s.reviews.map(r=>`<li>${esc(r.kind)} · ${esc(r.status)} · ${esc(stamp(r.start,s.zone))} – ${esc(stamp(r.end,s.zone))}${r.reason?' · '+esc(r.reason):''}</li>`).join('');
  return `<article class="shift"><div class="row"><h3>${esc(s.job)}</h3><span class="tag">${s.approvedStart?'Approved time recorded':s.reviews.some(r=>r.status==='pending')?'Awaiting review':'Review complete'}</span></div><p>Original punches · ${esc(stamp(s.start,s.zone))} – ${esc(stamp(s.end,s.zone))}</p>${s.approvedStart?'<p>Approved interval · '+esc(stamp(s.approvedStart,s.zone))+' – '+esc(stamp(s.approvedEnd,s.zone))+'</p>':''}<details><summary>Review history</summary><ul>${history}</ul></details>${pending?'<p class="muted">Correction awaiting manager review.</p>':`<details><summary>Request correction</summary><form data-correction="${esc(s.id)}"><p class="muted">Enter both timestamps in UTC with Z or include a numeric time-zone offset.</p><div class="form-grid"><label>Requested start<input name="start" value="${esc(s.approvedStart||s.start)}" required></label><label>Requested end<input name="end" value="${esc(s.approvedEnd||s.end)}" required></label><label class="wide">Reason<textarea name="reason" maxlength="300" required></textarea></label></div><p class="error" role="alert"></p><button>Send correction</button></form></details>`}</article>`;
}
function render() {
  const d=session.data, open=d.openShift;
  const punch = open ? `<p>${esc(open.job)} · Started ${esc(stamp(open.start, open.zone))}</p><form id="clock-out"><p class="error" role="alert"></p><button class="primary">Clock out</button></form>` :
    d.jobs.length ? `<form id="clock-in"><label>Job<select name="jobId" required>${d.jobs.map(j=>'<option value="'+esc(j.id)+'">'+esc(j.name)+'</option>').join('')}</select></label><p class="error" role="alert"></p><button class="primary">Clock in</button></form>` : '<p>Ask a manager to create a job before clocking in.</p>';
  const rows=d.time.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.job)}</td><td>${esc(t.minutes)}</td><td>${t.approved?'Approved':'Pending'}</td></tr>`).join('');
  app.innerHTML = `<div class="bar"><div><p class="muted">${esc(d.company)}</p><h1>${esc(d.employee)}</h1></div><div class="row"><button id="refresh">Refresh</button><button id="logout">Sign out</button></div></div><section class="punch"><h2>${open?'On the clock':'Time clock'}</h2><p class="muted">Work time zone · ${esc(d.timezone)}</p>${punch}</section><section class="card"><h2>My shifts</h2>${d.shifts.filter(s=>s.end).map(shiftCard).join('')||'<p class="muted">Completed shifts appear here.</p>'}</section><section class="card"><h2>My time entries</h2>${rows?'<div class="records"><table><thead><tr><th>Work date</th><th>Job</th><th>Minutes</th><th>Review</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<p class="muted">No time entries recorded.</p>'}</section>`;
}
async function refresh() {
  try { session=await api('session'); render(); }
  catch(err) { if(!session) login(); else say(err.message); }
}
app.addEventListener('submit',async ev=>{
  ev.preventDefault(); if(busy)return;
  const form=ev.target, button=ev.submitter, values=Object.fromEntries(new FormData(form));
  busy=true; if(button)button.disabled=true;
  try {
    if(form.id==='login') { session=await api('login', {username:values.username,password:values.password}); render(); }
    else {
      const type=form.dataset.correction?'correction':form.id;
      const action = type==='correction'?{type,shiftId:form.dataset.correction,...values}:
        type==='clock-out'?{type,shiftId:session.data.openShift.id}:{type,...values};
      session=await api('worker/action',{action}); render();
      say(type==='clock-in'?'Clocked in.':type==='clock-out'?'Clocked out. Shift sent for review.':'Correction sent for review.');
    }
  } catch(err) {
    const out = form.isConnected && form.querySelector('.error');
    if(out)out.textContent=err.message;else say(err.message);
  } finally {busy=false; if(button)button.disabled=false;}
});
app.addEventListener('click', async ev=>{
  if(busy)return;
  if(ev.target.id==='refresh'){busy=true;try{await refresh();}finally{busy=false;}return;}
  if(ev.target.id!=='logout')return;
  busy=true;
  try {await api('logout',{}); login(); notice.textContent='';}
  catch(err){say(err.message);} finally {busy=false;}
});
window.addEventListener('pagehide',()=>{login();notice.textContent='';});
window.addEventListener('pageshow',ev=>{if(ev.persisted)refresh();});
await refresh();
