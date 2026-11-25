import {recommended,modules,accounts,manualAccounts,outstanding,sum,cents,dollars,check,statements} from '/shared/core.mjs';
import {previewBankCsv,exportBankCsv,reconcileBankStatement} from '/shared/interop.mjs';
import {states,ficaPreview,incomeTaxPreview,payrollGate} from '/shared/payroll-rules.mjs';
import {esc,btn,money,table,panel,pretty,code,choices,input,options,select,dateField,mapping,acts,home,contacts,commerceView,jobs,warehouse,assetsView,accounting,banks,reportView,payrollView,history,ref,title,line} from '/shared/views.mjs';
import {suiteContent,suiteAction} from './administration.mjs';

const app=document.querySelector('#app'),dialog=document.querySelector('dialog'),notice=document.querySelector('#notice');
const brand='<div class="brand"><img src="/shared/mark.svg" alt="">FirmQuill</div>';
let session=null,companyId='',page='Overview',menu=false,busy=false,epoch=0;
let auxiliary=null,loadGeneration=0,draftRequestId='';
let idleTimer,lastActivity=0;
const idleLimit=5*60*1000;
const localDate=()=>{const now=new Date();return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');};
let filter={from:'2000-01-01',through:localDate(),group:''};
const readOnlyActs=new Set(['nav','menu','refresh','logout','detail','worksheet','print document','get attachment','export','cancel']);
function toast(message){notice.textContent=message;clearTimeout(toast.timer);toast.timer=setTimeout(()=>notice.textContent='',4600);}
function showError(error){
  const el=dialog.open?dialog.querySelector('.error'):app.querySelector('.error');
  if(el){el.textContent=error.message||String(error);el.scrollIntoView({block:'nearest'});}else toast(error.message);
}
function closeModal(){dialog.close();dialog.replaceChildren();dialog.onsubmit=null;dialog.onchange=null;}
function signedOut(){
  epoch++;loadGeneration++;clearTimeout(idleTimer);session=null;companyId='';page='Overview';menu=false;busy=false;auxiliary=null;filter.group='';
  closeModal();notice.textContent='';gate();
}
function endIdleSession(){
  if(!session)return;
  const csrf=session.csrf;
  signedOut();toast('Signed out after five minutes of inactivity.');
  fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}',credentials:'same-origin',keepalive:true}).catch(()=>{});
}
function touch(){
  if(!session)return;
  if(lastActivity&&Date.now()-lastActivity>=idleLimit){endIdleSession();return;}
  lastActivity=Date.now();clearTimeout(idleTimer);idleTimer=setTimeout(endIdleSession,idleLimit);
}
for(const event of ['pointerdown','keydown','wheel'])document.addEventListener(event,touch,{capture:true,passive:true});
document.addEventListener('visibilitychange',()=>{if(session&&Date.now()-lastActivity>=idleLimit)endIdleSession();});
function gate(){
  app.innerHTML=`<div class="gate"><div class="gateart">${brand}<section><p class="eyebrow">Full Suite</p><h2>Company books</h2><div class="bookart" aria-hidden="true"></div></section><p class="foot small">Company-hosted workspace</p></div><div class="gatepanel"><p class="eyebrow">FirmQuill &nbsp; / &nbsp; Full Suite</p><h1>Sign in</h1><p class="quiet">Use your individual company account to open your assigned books.</p><form id="login">${input('username','Username','text','','autocomplete="username" autocapitalize="none" spellcheck="false"')}${input('password','Password','password','','autocomplete="current-password"')}<div class="error" role="alert"></div><button class="primary">Sign in</button></form><p class="small quiet">For clock-in and timesheets, open your company’s worker portal.</p></div></div>`;
}
async function api(path,body){
  const requestEpoch=epoch;
  const headers={Accept:'application/json'};
  if(body!==undefined){headers['Content-Type']='application/json';if(session)headers['X-CSRF-Token']=session.csrf;}
  let response;
  try{response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});}
  catch{throw Error('Could not reach your company server. Reconnect and refresh the workspace to check the last saved change.');}
  const data=await response.json().catch(()=>({}));
  if(requestEpoch!==epoch)throw Error('The session changed. Sign in again.');
  if(!response.ok){
    if(response.status===401&&path!=='login'){signedOut();throw Error('Your session ended. Sign in again.');}
    if(response.status===409&&session){
      closeModal();
      const latest=await api('session');useSession(latest);await loadPage();
      throw Error((data.error||'The record changed in another session.')+' Review the refreshed records before trying again.');
    }
    throw Error(typeof data.error==='string'?data.error:`Request failed (${response.status}).`);
  }
  return data;
}
function useSession(next){
  check(next?.user&&Array.isArray(next?.state?.companies),'The server returned an incomplete workspace. Sign in again.');
  const old=session?.user?.id;session=next;
  if(old!==next.user.id){epoch++;lastActivity=0;touch();page='Overview';companyId='';filter.group='';auxiliary=null;}
  if(!next.state.companies.some(c=>c.id===companyId)){companyId=next.state.companies[0]?.id||'';filter.group='';}
  if(filter.group&&!next.state.groups.some(g=>g.id===filter.group))filter.group='';
}
function setupFields(){return `<fieldset><legend>What does this company do?</legend>${choices('activities',acts)}</fieldset><div class="callout small"><b>Featured workflows</b><p id="suggested">Accounting · Reports</p></div>`;}
function previewSettings(form){const out=form.querySelector('#suggested');if(out)out.textContent=recommended(new FormData(form).getAll('activities')).join(' · ');}
function suitePages(){
  const role=session.user.role;
  if(role==='owner')return ['Approvals','User access','Audit trail','Portable transfers'];
  if(role==='manager')return ['Approvals','Audit trail'];
  if(role==='bookkeeper')return ['Approvals'];
  return [];
}
function setup(c){return panel('Company profile',`<p><b>${esc(c.name)}</b></p><p class="quiet">${acts.filter(([v])=>c.activities.includes(v)).map(([,n])=>esc(n)).join(' · ')||'No activities selected'}</p><div class="rule"></div><p>Featured on overview</p><p>${esc(c.featured.join(' · ')||'None')}</p>`,btn('settings','Edit profile'))+
  panel('Workspaces','<p>Each company keeps its own contacts, stock, document numbers and journals.</p>',session.user.role==='owner'?btn('company','Add company'):'');}
const views={'Overview':home,'Directory':contacts,'Sales':c=>commerceView(c,true),'Purchasing':c=>commerceView(c,false),'Jobs & time':jobs,'Warehouse':c=>warehouse(c,false),'Assembly':c=>warehouse(c,true),'Fixed assets':assetsView,'Accounting':accounting,'Banking':banks,'Reports':reportView,'Payroll':payrollView,'History':history,'Company setup':setup};
const endpoints={'Approvals':'approvals','User access':'admin/users','Audit trail':'audit'};
async function loadPage(){
  const generation=++loadGeneration;auxiliary=null;render();
  if(!session||!endpoints[page])return;
  try{const response=await api(endpoints[page]);if(generation!==loadGeneration)return;auxiliary=response;render();}
  catch(err){if(generation===loadGeneration){auxiliary={error:err.message};render();}}
}
function navButton(key){
  return `<button type="button" data-act="nav" data-key="${esc(key)}"${page===key?' class="active" aria-current="page"':''}>${esc(key)}</button>`;
}
function label(text){return `<p class="navlabel">${esc(text)}</p>`;}
function roleFilter(root){
  const role=session?.user.role;
  for(const button of root.querySelectorAll('button[data-act]')){
    const act=button.dataset.act;
    if(role==='viewer'&&!readOnlyActs.has(act))button.hidden=true;
    if(role!=='owner'&&['company','group','intercompany'].includes(act))button.hidden=true;
    if(!['owner','manager'].includes(role)&&['settings','approve time','close'].includes(act))button.hidden=true;
  }
}
function render(){
  if(!session){gate();return;}
  const s=session.state,user=session.user,c=s.companies.find(x=>x.id===companyId);
  const full=suitePages();
  if(!views[page]&&!full.includes(page))page='Overview';
  let nav=label('Workspace')+navButton('Overview');
  if(c){
    nav+=navButton('Directory')+(c.featured.length?label('Featured'):'')+c.featured.map(navButton).join('')+
      label('All tools')+[...modules.filter(m=>!c.featured.includes(m)),'History','Company setup'].map(navButton).join('');
  }
  if(full.length)nav+=label('Full Suite')+full.map(navButton).join('');
  let body;
  if(full.includes(page))body=suiteContent(page,auxiliary,session);
  else if(c)body=views[page](c,s,filter);
  else body=panel(user.role==='owner'?'Set up your books':'Company access',user.role==='owner'?'<p>Create a company, or import an encrypted Lite backup into this empty workspace.</p>':'<p>Ask your owner to assign your account to a company.</p>',user.role==='owner'?btn('company','Create company','','primary')+btn('nav','Import from Lite','Portable transfers'):'');
  const picker=c?`<label for="company">Company</label><select id="company" aria-label="Active company" class="picker">${options(mapping(s.companies))}</select>`:'';
  app.innerHTML=`<div class="shell${menu?' menu':''}"><aside>${brand}<nav aria-label="Workspace">${nav}</nav><div class="sidebarfoot small">FirmQuill · Full Suite preview</div></aside><div class="maincol"><header class="toolbar"><div class="toolgroup">${btn('menu','Menu','','mobilemenu')}${picker}</div><div class="toolgroup"><span class="quiet small">${esc(user.name)} · ${esc(pretty(user.role))}</span>${btn('refresh','Refresh')}${btn('logout','Sign out')}</div></header><div class="workspace"><div class="pagehead"><div><p class="eyebrow">${esc(c?.name||'FirmQuill')}</p><h1>${page==='Overview'?'Workspace overview':esc(page)}</h1></div>${c&&page==='Overview'?btn('quote','New quote','','primary'):''}</div><div class="error" role="alert"></div>${body}</div></div></div>`;
  if(c)app.querySelector('#company').value=companyId;
  if(page==='Reports'&&c)app.querySelector('[name=group]').value=filter.group;
  roleFilter(app);
}
async function save(type,a){
  check(session,'Sign in first.');
  const token=epoch;
  const response=await api('action',{companyId,revision:session.revision,action:{...a,type,date:a.date||localDate(),requestId:draftRequestId}});
  if(token!==epoch)return;
  useSession(response);
  if(type==='company'&&!response.pendingApproval){companyId=session.state.companies.at(-1)?.id||'';filter.group='';page='Overview';}
  if(type==='group'&&!response.pendingApproval)filter.group=session.state.groups.at(-1)?.id||'';
  closeModal();await loadPage();toast(response.pendingApproval?'Submitted for manager approval.':'Saved to the shared books.');
}
dialog.addEventListener('cancel',ev=>{ev.preventDefault();if(!busy)closeModal();});
dialog.addEventListener('click',ev=>{if(ev.target.closest('[data-act="cancel"]')&&!busy)closeModal();});

function formModal(heading,fields,submit,handler){
  draftRequestId=crypto.randomUUID();
  closeModal();dialog.innerHTML=`<form><h2>${esc(heading)}</h2><div class="fields">${fields}</div><div class="error" role="alert"></div><div class="dialogfoot">${btn('cancel',submit?'Cancel':'Close')}${submit?`<button class="primary" type="submit">${esc(submit)}</button>`:''}</div></form>`;
  roleFilter(dialog);dialog.showModal();dialog.onsubmit=async ev=>{
    ev.preventDefault();if(busy||!handler)return;busy=true;const token=epoch,form=ev.target,submitter=ev.submitter;if(submitter)submitter.disabled=true;
    const f=new FormData(form);try{await handler(Object.fromEntries(f),f,form);}catch(err){if(epoch===token)showError(err);}finally{if(epoch===token){busy=false;if(submitter)submitter.disabled=false;}}
  };
  dialog.onchange=ev=>previewSettings(ev.target.form||dialog.querySelector('form'));
}
function download(contents,filename,mime){
  const url=URL.createObjectURL(new Blob([contents],{type:mime})),link=document.createElement('a');
  link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function docFields(c,sale){
  const people=c.parties.filter(p=>p.kind===(sale?'Customer':'Vendor'));
  check(people.length&&c.items.length,'Add the contact and an item or service in Directory first.');
  return select('party',sale?'Customer':'Vendor',mapping(people))+select('item','Item or service',mapping(c.items))+input('qty','Quantity','number',1,'min="1" step="1"')+input('unit','Unit price (USD)','text','','inputmode="decimal"')+input('location','Location','text','Main')+
   `<label>Job<select name="job">${options([['','No job'],...mapping(c.jobs)])}</select></label>`;
}

async function action(type,key){
  if(type==='logout'){await api('logout',{});signedOut();return;}
  if(!session)return;
  if(type==='refresh'){useSession(await api('session'));await loadPage();toast('Workspace refreshed.');return;}
  if(type==='nav'){page=key;menu=false;await loadPage();window.scrollTo(0,0);return;}
  if(type==='menu'){menu=!menu;render();return;}
  const context={session,companyId,auxiliary,api,formModal,closeModal,download,toast,async refresh(response){if(response?.state)useSession(response);else useSession(await api('session'));await loadPage();}};
  if(await suiteAction(type,key,context))return;
  const s=session.state,c=s.companies.find(x=>x.id===companyId),now=localDate();
  const form=(label,fields,convert=(v)=>v,button='Save')=>formModal(label,fields,button,(v,f)=>save(type,convert(v,f)));
  const amount=(k='amount',label='Amount (USD)',v='')=>input(k,label,'text',v,'inputmode="decimal"');
  const count=(k,label,v=1)=>input(k,label,'number',v,'min="1" step="1"');
  const memo=input('label','Description','text','','maxlength="160"'),dates=dateField(now);
  const list=(name,label,rows)=>{check(rows.length,'Create a '+label.toLowerCase()+' record first.');return select(name,label,mapping(rows));};
  const products=(c?.items||[]).filter(i=>i.kind==='Product');
  switch(type){
    case 'company':form('Create company',input('name','Company name')+setupFields(),(v,f)=>({...v,activities:f.getAll('activities')}));break;
    case 'settings':form('Company setup',input('name','Company name','text',c.name)+`<fieldset><legend>Company activities</legend>${choices('activities',acts,c.activities)}</fieldset><div class="callout small">Recommended home & navigation<p id="suggested">${esc(recommended(c.activities).join(' · '))}</p></div><fieldset><legend>Feature these workflows</legend>${choices('featured',modules.map(m=>[m,m]),c.featured)}</fieldset>`,(v,f)=>({...v,activities:f.getAll('activities'),featured:f.getAll('featured')}));break;
    case 'contact':case 'item':form(type==='item'?'Add item or service':'Add contact',input('name','Name')+select('kind','Type',(type==='item'?['Product','Service']:['Customer','Vendor']).map(x=>[x,x])));break;
    case 'job':form('Create job',input('name','Job name'));break;
    case 'employee':form('Add employee',input('name','Employee name')+select('state','Work state',states.map(x=>[x,x]))+input('locality','Work locality')+amount('rate','Hourly rate (USD)'),v=>({...v,rate:cents(v.rate)}));break;
    case 'time':form('Log time',list('employee','Employee',c.employees)+list('job','Job',c.jobs)+dates+count('minutes','Minutes worked',60),v=>({...v,minutes:Number(v.minutes)}));break;
    case 'approve time':form('Approve time entry',dates,v=>({...v,time:key}),'Approve');break;
    case 'job expense':form('Record cash job expense',list('job','Job',c.jobs)+memo+amount()+dates,v=>({...v,amount:cents(v.amount)}));break;
    case 'quote':case 'purchase order':form('New '+type,docFields(c,type==='quote')+memo+dates,v=>({...v,qty:Number(v.qty),unit:cents(v.unit)}));break;
    case 'advance':{
      const [parent,step]=key.split('|'),p=c.docs.find(d=>d.id===parent),settles=['collection','payment'].includes(step);
      const info=`<p class="quiet">${esc(code(p))} · ${esc(title(c.parties,p.party))} · ${money(p.total)}</p>`;
      const credit=step.includes('credit')?'<p class="callout warn">This fully credits the document, returns product stock and records a cash refund for any settled amount. Confirm that the return and refund have occurred.</p>':'';
      formModal(pretty(step),info+credit+dates+(settles?amount('amount','Settlement amount (USD)',(BigInt(outstanding(c,p))/100n)+'.'+String(outstanding(c,p)%100).padStart(2,'0')):''),'Record '+step,v=>save(step,{...v,label:pretty(step)+' · '+code(p),parent,...(settles?{amount:cents(v.amount)}:{})}));break;
    }
    case 'transfer':case 'adjust':{
      const adjustment=type==='adjust';const fields=(adjustment?select('direction','Direction',[['adjust in','Increase'],['adjust out','Decrease']]):'')+list('item','Stock item',products)+input('location','Source location','text','Main')+(adjustment?amount('amount','Total value for increase (USD)','0.00'):input('to','Destination location'))+count('qty','Units')+memo+dates;
      formModal(adjustment?'Adjust stock':'Transfer stock',fields,'Post movement',v=>save(adjustment?v.direction:type,{...v,qty:Number(v.qty),...(adjustment?{amount:cents(v.amount)}:{})}));break;
    }
    case 'assemble':{
      check(products.length>=2,'Add at least two product items to the directory.');
      const parts=products.map(p=>input('component-'+p.id,'Consume '+p.name,'number',0,'min="0" step="1"')).join('');
      form('Build assembly',list('item','Finished item',products)+count('qty','Finished units')+input('location','Build location','text','Main')+`<fieldset><legend>Components consumed</legend>${parts}</fieldset>`+dates,v=>({...v,qty:Number(v.qty),components:products.map(p=>({item:p.id,qty:Number(v['component-'+p.id])})).filter(x=>x.qty>0)}));break;
    }
    case 'asset':form('Acquire fixed asset',input('name','Asset name')+amount('amount','Cash purchase cost (USD)')+amount('residual','Residual value (USD)','0.00')+count('months','Useful life in months',36)+dates,v=>({...v,amount:cents(v.amount),residual:cents(v.residual),months:Number(v.months)}));break;
    case 'depreciate':form('Post monthly depreciation','<p class="quiet">Straight-line book depreciation begins in the acquisition month.</p>'+dates,v=>({...v,asset:key}));break;
    case 'journal':{
      const opts=manualAccounts.map(k=>[k,k+' · '+accounts[k][0]]);
      form('Post journal',memo+dates+select('debit','Debit account',opts)+select('credit','Credit account',opts)+amount()+select('flow','Cash-flow classification',['Operating','Financing','Investing'].map(x=>[x,x])),v=>{const n=cents(v.amount);check(n>0,'Enter a positive amount.');return {...v,lines:[[v.debit,n],[v.credit,-n]]};},'Post journal');break;
    }
    case 'reverse journal':form('Reverse posted journal',memo+dates,v=>({...v,entry:key}),'Post reversal');break;
    case 'close':form('Close accounting period','<div class="callout warn">Closing prevents new postings through this date. Review journals and statements before closing.</div>'+dateField(now,'date','Close through')+'<label class="checkfield"><input type="checkbox" required>I reviewed the period and approve closing.</label>',v=>v,'Close period');break;
    case 'group':form('Create reporting group',input('name','Group name')+`<fieldset><legend>Member companies</legend>${choices('members',mapping(s.companies))}</fieldset>`,(v,f)=>({...v,members:f.getAll('members')}));break;
    case 'intercompany':form('Charge another company',`<p class="quiet">${esc(c.name)} earns service revenue. The receiving company records the expense and payable.</p>`+list('other','Receiving company',s.companies.filter(x=>x.id!==c.id))+amount()+memo+dates,v=>({...v,amount:cents(v.amount)}),'Post to both books');break;
    case 'import':importForm(c);break;
    case 'export':formModal('Export bank transactions','<p class="callout warn">This download contains readable dates, descriptions and amounts.</p>'+select('profile','Destination',[['wave','Wave bank upload'],['quickbooks','QuickBooks Online bank upload']]),'Download CSV',v=>{
      const rows=c.entries.map(j=>({date:j.date,description:j.memo,amountCents:sum(j.lines.filter(l=>l.account==='1000').map(l=>l.cents))})).filter(r=>r.amountCents);
      download(exportBankCsv(rows,v.profile),'operating-account-'+v.profile+'.csv','text/csv');closeModal();
    });break;
    case 'match':{
      const r=c.bank.find(x=>x.id===key),eligible=c.entries.filter(e=>!c.bank.some(x=>x.match===e.id)&&sum(e.lines.filter(l=>l.account==='1000').map(l=>l.cents))===r.amountCents);
      check(eligible.length,'Record a matching cash transaction in Accounting, Sales or Purchasing first.');
      form('Match bank line',`<p>${esc(r.description)} · ${money(r.amountCents)}</p>`+select('entry','Posted cash entry',eligible.map(e=>[e.id,e.date+' · '+e.memo]))+dates,v=>({...v,row:key}));break;
    }
    case 'reconcile':form('Reconcile statement',dateField(now,'date','Statement ending date')+amount('closing','Closing statement balance (USD)'),v=>({...v,closing:cents(v.closing)}));break;
    case 'worksheet':worksheet(c,key);break;
    case 'detail':detail(c,key);break;
    case 'print document':window.print();break;
    case 'attach':{
      const token=epoch;formModal('Attach a file',input('file','File (up to 1 MB)','file'),'Save attachment',async v=>{
        check(v.file.size>0&&v.file.size<=1000000,'Choose a file up to 1 MB.');const bytes=new Uint8Array(await v.file.arrayBuffer());if(token!==epoch)return;
        let raw='';for(let p=0;p<bytes.length;p+=8192)raw+=String.fromCharCode(...bytes.subarray(p,p+8192));await save('attachment',{source:key,name:v.file.name,data:btoa(raw)});
      });break;
    }
    case 'get attachment':{const a=c.attachments.find(x=>x.id===key);download(Uint8Array.from(atob(a.data),ch=>ch.charCodeAt(0)),a.name,'application/octet-stream');break;}
  }
}
function detail(c,id){
  const e=ref(c,id),d=c.docs.find(x=>x.id===id),j=c.entries.filter(j=>j.source===id),files=c.attachments.filter(a=>a.source===id);
  const evidence=d?`<section class="printable"><div class="printbrand"><img src="/shared/mark.svg" alt="">FirmQuill</div><p><b>${esc(c.name)}</b></p><p>${esc(d.date)} · ${esc(title(c.parties,d.party))}</p>`+
    (['payment','collection'].includes(d.kind)?line('Amount settled',d.total):table(['Item or service','Units','Unit price','Document total'],[[esc(title(c.items,d.item)),d.qty,money(d.unit),money(d.total)]]))+'</section>'+
    btn('print document','Print document')+
    (d.parent?btn('detail','View source '+code(ref(c,d.parent)),d.parent):''):'';
  formModal(code(e)+' · '+pretty(e.kind),`<p>${esc(e.date)} · ${esc(e.label)}</p><p class="small quiet source">${esc(e.id)}</p>${evidence}`+
    table(['Account','Debit','Credit'],j.flatMap(entry=>entry.lines.map(l=>[esc(l.account+' '+accounts[l.account][0]),money(Math.max(0,l.cents)),money(Math.max(0,-l.cents))])),'No journal was posted for this activity.')+
    `<div class="rule"></div><h3>Attachments</h3><p class="small quiet">Downloaded attachments are readable outside the shared workspace.</p><div class="actions">${files.map(a=>btn('get attachment',a.name,a.id)).join('')}${btn('attach','Attach file',id)}</div>`,'',null);
}
function importForm(c){
  const acct=c.id,token=epoch;formModal('Preview statement import',select('profile','File layout',[['wave','Wave · YYYY-MM-DD'],['quickbooks','QuickBooks Online · DD/MM/YYYY']])+input('file','Statement CSV','file','','accept=".csv,text/csv"')+input('opening','Statement opening balance (USD)','text','0.00')+input('closing','Statement closing balance (USD)','text',''),'Preview',async v=>{
    check(v.file.size<=2000000,'File exceeds 2 MB.');const raw=await v.file.text();if(epoch!==token)return;
    const p=previewBankCsv(raw,v.profile,c.bank),r=reconcileBankStatement(p,cents(v.opening),cents(v.closing));
    const skipped=new Set(p.skipped.map(x=>x.sourceRef));
    const body=`<p>${p.added.length} new · ${p.skipped.length} already imported</p>`+line('Movement',p.totalCents)+line('Calculated closing',r.computedClosingCents)+line('Difference',r.differenceCents)+
      table(['Date','Description','Amount','Action'],p.rows.map(x=>[x.date,esc(x.description),money(x.amountCents),skipped.has(x.sourceRef)?'Skip duplicate':'Import']))+
      (!r.balanced?'<div class="callout warn">Resolve the closing balance difference before import.</div>':'');
    formModal('Review statement lines',body,(r.balanced&&p.added.length)?'Import lines':'',async()=>{
      check(companyId===acct,'Company changed.');const fresh=session.state.companies.find(b=>b.id===acct);const rows=previewBankCsv(raw,v.profile,fresh.bank).added;
      await save('statement import',{rows,label:'Bank CSV import'});
    });
  });
}
function worksheet(c,personId){
  const p=c.employees.find(e=>e.id===personId),approved=c.time.filter(t=>t.employee===p.id&&t.approved);
  const dollarsField=(k,l,v='')=>input(k,l,'text',v,'inputmode="decimal"');
  const fields=`<p class="quiet">${esc(p.name)} · ${esc(p.state)} · ${esc(p.locality)}. Enter taxable bases and year-to-date wages explicitly.</p>`+
    dateField(localDate(),'date','Pay date')+dateField('2026-01-01','from','Approved time from')+dateField(localDate(),'to','Approved time through')+
    dollarsField('fed','Federal taxable wages')+dollarsField('ss','Social Security taxable wages')+dollarsField('med','Medicare taxable wages')+dollarsField('priorSs','Prior Social Security wages this year')+dollarsField('priorMed','Prior Medicare wages this year')+
    select('status','2020+ W-4 filing status',[['single','Single / married filing separately'],['joint','Married filing jointly'],['head','Head of household']])+select('periods','Pay periods per year',[52,26,24,12,4,2,260].map(n=>[n,n]))+
    '<label class="checkfield"><input type="checkbox" name="step2">W-4 Step 2 box checked</label>'+dollarsField('other','W-4 other income','0.00')+dollarsField('ded','W-4 deductions','0.00')+dollarsField('credits','W-4 credits','0.00')+dollarsField('extra','W-4 extra withholding','0.00');
  formModal('Federal payroll worksheet',fields,'Calculate preview',v=>{
    check(v.from<=v.to&&v.to<=v.date,'Review time and pay dates.');
    const rows=approved.filter(t=>t.date>=v.from&&t.date<=v.to);
    const fica=ficaPreview({payDate:v.date,ssWagesCents:cents(v.ss),medicareWagesCents:cents(v.med),priorSsWagesCents:cents(v.priorSs),priorMedicareWagesCents:cents(v.priorMed)});
    const tax=incomeTaxPreview({payDate:v.date,taxableWagesCents:cents(v.fed),periods:Number(v.periods),filingStatus:v.status,step2:v.step2==='on',otherIncomeCents:cents(v.other),deductionsCents:cents(v.ded),creditsCents:cents(v.credits),extraCents:cents(v.extra)});
    const gate=payrollGate({payDate:v.date,state:p.state,locality:p.locality});
    formModal('Federal worksheet result',`<p>${esc(p.name)} · ${esc(v.date)}</p>`+line('Approved straight-time estimate',sum(rows.map(t=>t.cost)))+line('Federal income tax',tax)+line('Employee Social Security',fica.employeeSocialSecurityCents)+line('Employee Medicare',fica.employeeMedicareCents)+line('Additional Medicare',fica.additionalMedicareCents)+line('Employer Social Security',fica.employerSocialSecurityCents)+line('Employer Medicare',fica.employerMedicareCents)+`<div class="callout warn"><b>Final output blocked</b><ul>${gate.blockers.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`,'',null);
  });
}

document.addEventListener('click',async ev=>{
  const b=ev.target.closest('button[data-act]');
  if(!b||b.dataset.act==='cancel'||busy)return;
  busy=true;
  try{await action(b.dataset.act,b.dataset.key);}catch(err){showError(err);}finally{busy=false;}
});
app.addEventListener('change',async ev=>{
  if(ev.target.id==='company'){
    companyId=ev.target.value;menu=false;filter.group='';await loadPage();
  }
});
app.addEventListener('submit',async ev=>{
  ev.preventDefault();if(busy)return;busy=true;
  const form=ev.target,v=Object.fromEntries(new FormData(form)),submit=ev.submitter;if(submit)submit.disabled=true;
  try{
    if(form.id==='login'){
      const next=await api('login',{username:v.username,password:v.password});useSession(next);
      form.reset();closeModal();notice.textContent='';await loadPage();
    }else if(form.id==='report-filter'){
      statements([],v.from,v.through);filter={from:v.from,through:v.through,group:v.group};render();
    }
  }catch(err){showError(err);}finally{busy=false;if(submit)submit.disabled=false;}
});
window.addEventListener('pagehide',signedOut);
window.addEventListener('pageshow',async ev=>{if(ev.persisted)await reconnect();});
async function reconnect(){
  gate();
  try{useSession(await api('session'));await loadPage();}
  catch(err){if(err.message!=='Your session ended. Sign in again.')showError(err);}
}
await reconnect();

