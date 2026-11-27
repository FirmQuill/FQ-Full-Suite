import {mountContextualHelp} from '/shared/contextual-help-ui.mjs';
import {employeeKnowledgeContent} from '/shared/knowledge-content.mjs';
import {mountDrive} from '/shared/file-drive-ui.mjs';
import {openAccount} from '/legal/account.mjs';
import {messagingContent,chatForm,loadConversation,messagesUrl} from '/shared/messaging-ui.mjs';
import {selfserviceContent,selfserviceSubmit} from './selfservice.mjs';
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const brand = document.querySelector('.brand'), brandName=brand.querySelector('span'), brandLogo=brand.querySelector('img'), favicon=document.querySelector('link[rel=icon]');
function showBrand(value){
  const name=value?.name||'FirmQuill', source=value?value.logo:'/shared/mark.svg';
  brandName.textContent=name;brandLogo.hidden=!source;
  if(source){if(brandLogo.getAttribute('src')!==source)brandLogo.setAttribute('src',source);}else brandLogo.removeAttribute('src');
  const faviconUrl=source||'/shared/mark.svg';if(favicon.getAttribute('href')!==faviconUrl){favicon.removeAttribute('type');favicon.setAttribute('href',faviconUrl);}
  document.title=name+' · Employee portal';
}
brandLogo.addEventListener('error',()=>{brandLogo.hidden=true;});
let chat=null;
let session, busy = false, noticeTimer,tab='Home',supportScope='public-setup-only',knowledge=null,knowledgeQuery='';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function stamp(value, zone) {
  return new Intl.DateTimeFormat('en-US', {timeZone:zone, month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short'}).format(new Date(value));
}
function say(message) {
  clearTimeout(noticeTimer); notice.textContent = message;
  noticeTimer = setTimeout(() => {notice.textContent='';}, 5500);
}
function login() {
  session = null;knowledge=null;knowledgeQuery='';chat=null;tab='Home';
  showBrand(null);
  const setup=new URLSearchParams(location.hash.slice(1)).get('setup');
  if(setup){app.innerHTML='<section class="login"><h1>Set up your employee login</h1><form id="setup"><label>Choose your password<input type="password" name="password" minlength="12" autocomplete="new-password" required></label><label>Confirm password<input type="password" name="confirm" minlength="12" autocomplete="new-password" required></label><p class="error" role="alert"></p><button class="primary">Activate my login</button></form></section>';return;}
  app.innerHTML = '<section class="login"><h1>Worker sign in</h1><p>Employee records and time clock</p><form id="login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><p class="error" role="alert"></p><button class="primary">Sign in</button></form><div id="federation"></div></section>';
  api('identity/providers').then(p=>{const out=document.querySelector('#federation');if(out)out.innerHTML=(p.providers||[]).map(p=>`<p><a href="/api/identity/oidc/start?id=${encodeURIComponent(p.id)}">Sign in with ${esc(p.name)}</a></p>`).join('');}).catch(()=>{});
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
function leaveContent(d){
  if(!d)return '<section class="card"><p>Time off is not enabled.</p></section>';
  return '<section class="card"><h2>Request time off</h2><p>These requests do not change a leave balance or payroll. Avoid including medical details.</p><form id="request-leave"><label>Reason category<select name="category">'+d.categories.map(c=>'<option>'+esc(c)+'</option>').join('')+'</select></label><label>First day<input type="date" name="from" required></label><label>Last day<input type="date" name="through" required></label><label>Note (optional)<textarea name="note" maxlength="500"></textarea></label><p class="error" role="alert"></p><button class="primary">Send request</button></form></section><section class="card"><h2>My requests</h2>'+ (d.requests.map(r=>'<article class="shift"><h3>'+esc(r.category)+'</h3><p>'+esc(r.from+' through '+r.through+' · '+r.status)+'</p>'+(r.reviewNote?'<p>'+esc(r.reviewNote)+'</p>':'')+(r.status==='pending'?'<form data-leave-withdraw="'+esc(r.id)+'"><input type="hidden" name="version" value="'+esc(r.version)+'"><p class="error" role="alert"></p><button>Withdraw request</button></form>':'')+'</article>').join('')||'<p>No time-off requests yet.</p>')+'</section>';
}
function render() {
  if(session)showBrand(session.branding);
  if(new URLSearchParams(location.hash.slice(1)).has('setup')){login();return;}
  const d=session.data, open=d.openShift;
  const features=session.features||['Time','Pay','Reviews','Benefits','My Profile','Contacts'];
  if(!['Home','Setup help'].includes(tab)&&!features.includes(tab)){tab='Home';chat=null;}
  const punch = open ? `<p>${esc(open.job)} · Started ${esc(stamp(open.start, open.zone))}</p><form id="clock-out"><p class="error" role="alert"></p><button class="primary">Clock out</button></form>` :
    d.jobs?.length ? `<form id="clock-in"><label>Job<select name="jobId" required>${d.jobs.map(j=>'<option value="'+esc(j.id)+'">'+esc(j.name)+'</option>').join('')}</select></label><p class="error" role="alert"></p><button class="primary">Clock in</button></form>` : '<p>Ask a manager to create a job before clocking in.</p>';
  const rows=(d.time||[]).slice().sort((a,b)=>b.date.localeCompare(a.date)).map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.job)}</td><td>${esc(t.minutes)}</td><td>${t.approved?'Approved':'Pending'}</td></tr>`).join('');
  const times=`<section class="card"><h2>My shifts</h2>${(d.shifts||[]).filter(s=>s.end).map(shiftCard).join('')||'<p class="muted">Completed shifts appear here.</p>'}</section><section class="card"><h2>My time entries</h2>${rows?'<div class="records"><table><thead><tr><th>Work date</th><th>Job</th><th>Minutes</th><th>Review</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<p class="muted">No time entries recorded.</p>'}</section>`;
  app.innerHTML = `<div class="bar"><div><p class="muted">${esc(d.company)}</p><h1>${esc(d.employee)}</h1></div><div class="row"><button id="refresh">Refresh</button><button id="logout">Sign out</button></div></div><nav class="portal-tabs" aria-label="Employee portal">${['Home',...features,'Setup help'].map(t=>`<button data-tab="${esc(t)}"${tab===t?' aria-current="page" class="active"':''}>${esc(t)}</button>`).join('')}</nav><div id="contextual-help"></div>${features.includes('Time')?`<section class="punch"><h2>${open?'On the clock':'Time clock'}</h2><p class="muted">Work time zone · ${esc(d.timezone)}</p>${punch}</section>`:''}${tab==='Setup help'?'<section class="card"><h2>Public setup help</h2><p>This assistant searches only the installed public setup guide. Ask your company support contact for help with employee workflows.</p><form id="setup-help"><label>Setup question<input name="question" maxlength="1500" required></label><p class="error" role="alert"></p><button>Search guide</button></form><div id="setup-answer" aria-live="polite"></div></section>':tab==='Time'?times:tab==='Time off'?leaveContent(session.leave):tab==='Drives'?'<div id="drive-workspace"></div>':tab==='Messages'?messagingContent(chat):tab==='Company knowledge'?employeeKnowledgeContent(knowledge):selfserviceContent(tab,session)+(tab==='Home'&&features.includes('Time')?times:'')}`;
  mountContextualHelp(app.querySelector('#contextual-help'),{page:tab,api});
  if(tab==='Drives')mountDrive(app.querySelector('#drive-workspace'),{companyId:session.driveCompanyId,csrf:session.csrf,worker:true});
  if(tab==='Setup help'&&supportScope==='private-customer-manual'){
    const form=app.querySelector('#setup-help');form.parentElement.querySelector('h2').textContent='Privately supplied customer manual';form.previousElementSibling.textContent='Your host explicitly selected this customer manual. Retrieval reads documentation only and has no company-data access.';form.querySelector('label').firstChild.textContent='Documentation question';
  }
}
async function refreshKnowledge(id=''){
  if(!session?.features?.includes('Company knowledge'))return;
  try{const params=id?'id='+encodeURIComponent(id):'q='+encodeURIComponent(knowledgeQuery);knowledge={...await api('company-knowledge?'+params),query:knowledgeQuery};}
  catch(err){knowledge={error:err.message};}
  if(session&&tab==='Company knowledge')render();
}
async function refresh() {
  if(new URLSearchParams(location.hash.slice(1)).has('setup')){login();return;}
  try { session=await api('session'); knowledge=null;if(tab==='Messages'){await refreshChat(chat?.conversation?.id);return;}render();if(tab==='Company knowledge')await refreshKnowledge(); }
  catch(err) { if(!session) login(); else say(err.message); }
}
async function refreshChat(id,before){
  const current=session?.user.id;
  let next;
  try{next=await loadConversation(api,null,id,before);}catch(err){next={error:err.message};}
  if(session?.user.id===current&&tab==='Messages'){chat=next;render();}
}
app.addEventListener('submit',async ev=>{
  ev.preventDefault(); if(busy)return;
  const form=ev.target, button=ev.submitter, values=Object.fromEntries(new FormData(form));
  busy=true; if(button)button.disabled=true;
  try {
    if(form.id==='setup'){if(values.password!==values.confirm)throw Error('Passwords do not match.');await api('identity/invite/accept',{token:new URLSearchParams(location.hash.slice(1)).get('setup'),password:values.password});history.replaceState(null,'',location.pathname);login();say('Password set. Sign in with your assigned username.');}
    else if(form.id==='login') { session=await api('login', {username:values.username,password:values.password}); render();if(tab==='Company knowledge')await refreshKnowledge(); }
    else if(form.id==='company-knowledge-search'){knowledgeQuery=values.query;await refreshKnowledge();}
    else if(form.dataset.chat&&tab==='Messages'){
      const result=await api(messagesUrl(),{action:chatForm(form)});
      await refreshChat(result.id);say('Message sent.');
    }
    else if(form.id==='setup-help'){const result=await api('support/answer',{question:values.question});document.querySelector('#setup-answer').innerHTML='<p>'+esc(result.answer)+'</p>'+(result.citations||[]).map(c=>'<p>'+esc(c.title)+' · '+esc(c.version)+' · '+esc(c.section||'')+'</p>').join('')+'<p>'+esc(result.escalation?.message||'')+'</p>';}
    else if(form.id==='request-leave'||form.dataset.leaveWithdraw){
      const action=form.dataset.leaveWithdraw?{type:'withdraw',id:form.dataset.leaveWithdraw,version:Number(values.version)}:{type:'submit',...values};
      session=await api('team/my-time-off',{action});render();say('Time-off request saved.');
    }
    else if(form.dataset.service){const response=await selfserviceSubmit(form,button,session,api);session=response?.user?response:await api('session');render();say(response?.result?.receipt?'Received. Receipt: '+response.result.receipt:'Saved.');}
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
  const article=ev.target.closest('[data-knowledge-article]');if(article){busy=true;try{await refreshKnowledge(article.dataset.knowledgeArticle);}finally{busy=false;}return;}
  const message=ev.target.closest('[data-chat-thread],[data-chat-refresh]');
  if(message&&tab==='Messages'){busy=true;try{await refreshChat(message.dataset.chatThread||chat?.conversation?.id,message.dataset.chatBefore);}finally{busy=false;}return;}
  const target=ev.target.closest('[data-tab]');if(target){tab=target.dataset.tab;
    if(tab==='Messages'){busy=true;try{chat=null;render();await refreshChat();}finally{busy=false;}return;}
    chat=null;if(tab==='Setup help'){try{supportScope=(await api('support/info')).scope;}catch(e){say(e.message);}}render();if(tab==='Company knowledge'){busy=true;try{await refreshKnowledge();}finally{busy=false;}}return;}
  if(ev.target.id==='refresh'){busy=true;try{await refresh();}finally{busy=false;}return;}
  if(ev.target.id!=='logout')return;
  busy=true;
  try {await api('logout',{}); login(); notice.textContent='';}
  catch(err){say(err.message);} finally {busy=false;}
});
window.addEventListener('pagehide',()=>{login();notice.textContent='';});
window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('setup')){login();busy=false;}});
window.addEventListener('pageshow',ev=>{if(ev.persisted)refresh();});
await refresh();
