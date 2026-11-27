import {esc,btn,table,panel,pretty} from '/shared/views.mjs';

const day=()=>new Date().toISOString().slice(0,10);
const unpack=data=>data?.records||data||{};
const label=key=>({managerEmployeeId:'Manager employee',managerAccountId:'Assigned manager account',hrContactId:'HR contact',payrollContactId:'Payroll contact',workEmail:'Work email',businessPhone:'Business phone',personalEmail:'Personal email',personalPhone:'Personal phone',employmentStatus:'Employment status',hireDate:'Hire date',groupIds:'Benefit groups',projectAssignments:'Project assignments'}[key]||pretty(key.replace(/([A-Z])/g,' $1')));
const keyFor=(company,employee)=>company+'|'+employee;
const when=value=>value?new Date(value).toLocaleString():'—';
const field=(key,title,value='',type='text',attrs='')=>`<label>${esc(title)}<input name="${esc(key)}" type="${esc(type)}" value="${esc(value)}" ${attrs}></label>`;
const area=(key,title,value='',attrs='')=>`<label>${esc(title)}<textarea name="${esc(key)}" ${attrs}>${esc(value)}</textarea></label>`;
const choice=(key,title,pairs,value='')=>`<label>${esc(title)}<select name="${esc(key)}">${pairs.map(([id,name])=>`<option value="${esc(id)}"${id===value?' selected':''}>${esc(name)}</option>`).join('')}</select></label>`;
const showValue=value=>Array.isArray(value)?value.map(v=>typeof v==='string'?v:Object.entries(v).filter(([,v])=>v).map(([k,v])=>label(k)+': '+v).join(' · ')).join('\n'):value??'';
const employeeName=(data,employee)=>data.employees?.find(e=>e.employeeId===employee)?.name||'Employee';
const canHR=session=>['owner','hr'].includes(session.user.role);

export function recordsContent(raw,session,companyId){
  if(!raw)return '<p class="quiet">Loading employee records…</p>';
  if(raw.error)return `<div class="callout warn">${esc(raw.error)}</div>`;
  const data=unpack(raw),employees=data.employees||[];
  const roster=table(['Employee','Department / title','Status','Worker access',''],employees.map(e=>[
    esc(e.name),esc([e.profile.department,e.profile.title].filter(Boolean).join(' · ')),esc(e.profile.employmentStatus),
    e.workerAccount?`${esc(e.workerAccount.username)}<br><small>${e.workerAccount.active?(e.workerAccount.configured?'Password configured':'Awaiting password setup'):'Disabled'}</small>`:'—',
    btn('record-detail','Open record',keyFor(e.companyId,e.employeeId))
  ]),'No employee records in your assigned scope.');
  const reviews=table(['Employee','Review','Status','Published / acknowledged',''],(data.reviews||[]).map(r=>[
    esc(employeeName(data,r.employeeId)),esc(r.title),esc(r.status),esc(r.published?when(r.published)+(r.acknowledged?' · Acknowledged '+when(r.acknowledged):' · Awaiting acknowledgement'):'Private draft'),btn('record-review','Read review',keyFor(r.companyId,r.employeeId)+'|'+r.id)
  ]),'No visible reviews.');
  const corrections=table(['Employee','Field','Requested','Status',''],(data.corrections||[]).map(c=>[
    esc(employeeName(data,c.employee)),esc(label(c.field)),esc(when(c.requested)),esc(c.status),canHR(session)&&c.status==='pending'?btn('record-correction','Review request',c.id):''
  ]),'No profile correction requests.');
  const paystubs=table(['Employee','Pay date','Period','Source',''],(data.paystubs||[]).map(p=>[
    esc(employeeName(data,p.employeeId)),esc(p.payDate),esc(p.periodStart+' – '+p.periodEnd),esc(p.source),`<a href="/api/records/file/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Download finalized PDF</a>`
  ]),'No finalized paystubs have been published in your scope.');
  return panel('Employee records',roster,canHR(session)?btn('employee','Add employee','','primary')+btn('record-contacts','Contacts & field rules',companyId)+(session.user.role==='owner'?btn('record-branding','Worker portal branding',companyId):''):'')+
    panel('Performance reviews',reviews)+panel('Profile corrections',corrections)+
    (['owner','payroll'].includes(session.user.role)?panel('Published paystubs',paystubs):'');
}

async function selected(ctx,key){
  const [companyId,employeeId]=key.split('|');
  const data=unpack(await ctx.api('records?companyId='+encodeURIComponent(companyId)+'&employeeId='+encodeURIComponent(employeeId)));
  if(!data.employee)throw Error('Employee record unavailable. Refresh the list.');
  return data;
}
async function save(ctx,action,message='Employee record saved.'){
  await ctx.api('records/action',{action});ctx.closeModal();await ctx.refresh();ctx.toast(message);
}
function details(data,ctx){
  const e=data.employee,p=e.profile,k=keyFor(e.companyId,e.employeeId),isHR=e.permissions.editProfile;
  const fields=['hireDate','employmentStatus','department','title','location','workEmail','businessPhone'];
  const contact=data.contacts||{};
  const contactLine=c=>c?[c.name,c.title,c.email,c.phone].filter(Boolean).map(esc).join(' · '):'Not assigned';
  const history=table(['Effective date','Field changes','Recorded'],(p.history||[]).slice().reverse().map(h=>[
    esc(h.effectiveDate),Object.entries(h.changes).map(([name,v])=>`${esc(label(name))}: ${esc(showValue(v.before))} → ${esc(showValue(v.after))}`).join('<br>'),esc(when(h.at))+'<br>'+esc(h.reason)
  ]),'No recorded job changes.');
  const jobs=table(['Project','Role','Start','End'],(p.projectAssignments||[]).map(a=>[
    esc(data.jobs.find(j=>j.id===a.jobId)?.name||a.jobId),esc(a.role),esc(a.start),esc(a.end||'Ongoing')
  ]),'No current or scheduled project assignments.');
  const actions=(isHR?btn('record-profile','Edit profile',k)+btn('record-projects','Assign projects',k)+btn('record-credentials','Education & certifications',k):'')+
    (e.permissions.reviews&&['owner','hr','manager'].includes(ctx.session.user.role)?btn('record-review-new','Add review',k):'')+
    (e.permissions.paystubs&&['owner','payroll'].includes(ctx.session.user.role)?btn('record-stub-upload','Publish finalized paystub',k):'');
  const access=e.workerAccount?`<p>Worker username: <b>${esc(e.workerAccount.username)}</b> · ${e.workerAccount.active?(e.workerAccount.configured?'Password configured':'Awaiting password setup'):'Disabled'}. Password setup invitations are available under Identity connectors.</p>`:'';
  ctx.formModal(e.name,actions+access+table(['Field','Value'],fields.map(f=>[esc(label(f)),esc(p[f]||'—')]))+
    `<h3>Business contacts</h3><p>Manager: ${contactLine(contact.manager)}</p><p>HR: ${contactLine(contact.hr)}</p><p>Payroll: ${contactLine(contact.payroll)}</p>`+
    `<h3>Education</h3><p class="request-detail">${esc(showValue(p.education)||'None recorded')}</p><h3>Certifications</h3><p class="request-detail">${esc(showValue(p.certifications)||'None recorded')}</p><h3>Project assignments</h3>${jobs}<h3>Effective job history</h3>${history}`,'',null);
}
async function editProfile(ctx,key){
  const data=await selected(ctx,key),e=data.employee,p=e.profile;
  const book=ctx.session.state.companies.find(c=>c.id===e.companyId),contactOptions=[['','Use company or location fallback'],...(data.settings?.contacts||[]).map(c=>[c.id,c.name])];
  const fields=field('hireDate','Hire date',p.hireDate,'date')+choice('employmentStatus','Employment status',['active','leave','inactive','terminated'].map(s=>[s,pretty(s)]),p.employmentStatus)+
    ['department','title','location','workEmail','businessPhone','personalEmail','personalPhone'].map(k=>field(k,label(k),p[k],k.endsWith('Email')?'email':'text','maxlength="500"')).join('')+
    choice('managerEmployeeId','Manager employee',[['','Not assigned'],...(book?.employees||[]).filter(x=>x.id!==e.employeeId).map(x=>[x.id,x.name])],p.managerEmployeeId)+
    choice('managerAccountId','Assigned manager account',[['','Not assigned'],...(data.managers||[]).map(m=>[m.id,m.name])],p.managerAccountId)+
    choice('hrContactId','HR contact',contactOptions,p.hrContactId)+choice('payrollContactId','Payroll contact',contactOptions,p.payrollContactId)+
    field('effectiveDate','Job changes effective',day(),'date','required')+field('reason','Change reason','','text','required maxlength="500"');
  ctx.formModal('Edit '+e.name,fields,'Save profile',v=>{
    const patch=Object.fromEntries(['hireDate','employmentStatus','department','title','location','workEmail','businessPhone','personalEmail','personalPhone','managerEmployeeId','managerAccountId','hrContactId','payrollContactId'].map(k=>[k,v[k]]));
    return save(ctx,{type:'profile-update',companyId:e.companyId,employeeId:e.employeeId,version:p.version,patch,effectiveDate:v.effectiveDate,reason:v.reason});
  });
}
async function projects(ctx,key){
  const data=await selected(ctx,key),e=data.employee,p=e.profile;
  if(!data.jobs.length)throw Error('Create a company project in Jobs & time first.');
  const assignments=p.projectAssignments||[],count=assignments.length+3;
  const fields=Array.from({length:count},(_,i)=>{const assigned=assignments[i];return `<fieldset><legend>Assignment ${i+1}</legend>${choice('job'+i,'Project',[['','No assignment'],...data.jobs.map(j=>[j.id,j.name])],assigned?.jobId||'')}${field('start'+i,'Start',assigned?.start||day(),'date')}${field('end'+i,'End (optional)',assigned?.end||'','date')}${field('role'+i,'Project role',assigned?.role||'')}</fieldset>`;}).join('')+field('effectiveDate','Changes effective',day(),'date','required')+field('reason','Change reason','','text','required');
  ctx.formModal('Project assignments · '+e.name,fields,'Save assignments',v=>save(ctx,{type:'profile-update',companyId:e.companyId,employeeId:e.employeeId,version:p.version,patch:{projectAssignments:Array.from({length:count},(_,n)=>v['job'+n]?{jobId:v['job'+n],start:v['start'+n],end:v['end'+n],role:v['role'+n]}:null).filter(Boolean)},effectiveDate:v.effectiveDate,reason:v.reason}));
}
async function credentials(ctx,key){
  const data=await selected(ctx,key),e=data.employee,p=e.profile;
  const count=Math.max(4,p.education.length+1,p.certifications.length+1);
  const fields=Array.from({length:count},(_,i)=>{const edu=typeof p.education[i]==='string'?{name:p.education[i]}:p.education[i]||{},cert=typeof p.certifications[i]==='string'?{name:p.certifications[i]}:p.certifications[i]||{};return `<fieldset><legend>Education ${i+1}</legend>${field('educationName'+i,'Program / qualification',edu.name||'')}${field('institution'+i,'Institution',edu.institution||'')}${area('educationDescription'+i,'Notes',edu.description||'')}</fieldset><fieldset><legend>Certification ${i+1}</legend>${field('certName'+i,'Certification',cert.name||'')}${field('issuer'+i,'Issuer',cert.issuer||'')}${field('issued'+i,'Issued',cert.issued||'','date')}${field('expires'+i,'Expires (optional)',cert.expires||'','date')}${area('certDescription'+i,'Notes',cert.description||'')}</fieldset>`;}).join('');
  ctx.formModal('Education & certifications · '+e.name,fields,'Save credentials',v=>{
    const education=[],certifications=[];for(let i=0;i<count;i++){if(v['educationName'+i].trim())education.push({...((typeof p.education[i]==='object'&&p.education[i])||{}),name:v['educationName'+i],institution:v['institution'+i],description:v['educationDescription'+i]});if(v['certName'+i].trim())certifications.push({...((typeof p.certifications[i]==='object'&&p.certifications[i])||{}),name:v['certName'+i],issuer:v['issuer'+i],issued:v['issued'+i],expires:v['expires'+i],description:v['certDescription'+i]});}
    return save(ctx,{type:'profile-update',companyId:e.companyId,employeeId:e.employeeId,version:p.version,patch:{education,certifications}});
  });
}
async function review(ctx,key,isNew=false){
  const data=await selected(ctx,key),e=data.employee,id=key.split('|')[2],r=isNew?null:data.reviews.find(r=>r.id===id);
  if(!isNew&&!r)throw Error('Review unavailable.');
  if(r?.status==='published'){
    ctx.formModal(r.title,`<p>Published ${esc(when(r.published))} · Publisher ${esc(r.publisher)}</p><p>Acknowledgement: ${esc(r.acknowledged?when(r.acknowledged):'Awaiting employee')}</p><p class="request-detail">${esc(r.body)}</p>`,'',null);return;
  }
  const fields=`<p>${esc(e.name)} · Private draft</p>`+field('title','Review title',r?.title||'','text','required maxlength="200"')+area('body','Review',r?.body||'','required maxlength="30000" rows="12"')+
    choice('next','After saving',[['draft','Keep private draft'],['publish','Publish to employee']],'draft');
  ctx.formModal(r?'Edit review draft':'Add performance review',fields,'Save review',async v=>{
    const saved=await ctx.api('records/action',{action:{type:'review-save',companyId:e.companyId,employeeId:e.employeeId,title:v.title,body:v.body,...(r?{reviewId:r.id,version:r.version}:{})}});
    if(v.next==='publish'){
      const updated=await selected(ctx,key),reviewId=saved.result?.reviewId||saved.reviewId||r?.id,latest=updated.reviews.find(row=>row.id===reviewId);
      if(!latest)throw Error('Draft saved. Refresh the employee record before publishing.');
      await ctx.api('records/action',{action:{type:'review-publish',reviewId:latest.id,version:latest.version}});
    }
    ctx.closeModal();await ctx.refresh();ctx.toast(v.next==='publish'?'Review published to the employee.':'Private draft saved.');
  });
}
async function uploadStub(ctx,key){
  const data=await selected(ctx,key),e=data.employee;
  const fields=`<p>${esc(e.name)} · Publish an existing finalized payroll PDF. The original payroll source remains responsible for its amounts.</p>`+
    field('periodStart','Period start','','date','required')+field('periodEnd','Period end','','date','required')+field('payDate','Pay date','','date','required')+field('source','Payroll source / reference','','text','required maxlength="500"')+
    '<label>Finalized PDF (up to 2 MiB)<input name="file" type="file" accept="application/pdf,.pdf" required></label><label class="checkfield"><input type="checkbox" name="finalized" required>I verified this is the finalized paystub for this employee.</label>';
  ctx.formModal('Publish finalized paystub',fields,'Publish PDF',async v=>{
    if(!v.file?.size||v.file.size>2*1024*1024)throw Error('Choose a PDF no larger than 2 MiB.');
    const bytes=new Uint8Array(await v.file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return save(ctx,{type:'paystub-import',companyId:e.companyId,employeeId:e.employeeId,periodStart:v.periodStart,periodEnd:v.periodEnd,payDate:v.payDate,source:v.source,data:btoa(binary),filename:v.file.name,finalized:v.finalized==='on'},'Finalized paystub published to the employee.');
  });
}
async function correction(ctx,id){
  const data=unpack(ctx.auxiliary),c=data.corrections?.find(c=>c.id===id);if(!c)throw Error('Refresh the correction queue.');
  const fields=`<p>${esc(employeeName(data,c.employee))} · ${esc(label(c.field))}</p><p class="request-detail">Requested value: ${esc(showValue(c.value))}</p><p class="request-detail">${esc(c.reason)}</p>`+
    choice('decision','Decision',[['','Choose a decision'],['approve','Approve correction'],['reject','Decline correction']])+field('effectiveDate','Effective date',day(),'date','required')+area('reason','Decision reason','','required maxlength="1000"');
  ctx.formModal('Review profile correction',fields,'Record decision',v=>save(ctx,{type:'correction-decide',correctionId:id,decision:v.decision,reason:v.reason,effectiveDate:v.effectiveDate},'Correction decision recorded.'));
}
async function contactSettings(ctx,companyId){
  const data=unpack(await ctx.api('records?companyId='+encodeURIComponent(companyId))),config=data.settings||{contacts:[],locations:{},fieldRules:{}};
  const count=Math.max(5,config.contacts.length+2);
  const rows=Array.from({length:count},(_,i)=>{const c=config.contacts[i]||{};return `<fieldset><legend>Business contact ${i+1}</legend>${field('contactName'+i,'Name',c.name||'')}${field('contactTitle'+i,'Title / responsibility',c.title||'')}${field('contactEmail'+i,'Business email',c.email||'','email')}${field('contactPhone'+i,'Business phone',c.phone||'')}</fieldset>`;}).join('');
  const contactOptions=[['','Not assigned'],...Array.from({length:count},(_,i)=>[String(i),config.contacts[i]?.name||'Business contact '+(i+1)])];
  const idx=id=>{const i=config.contacts.findIndex(c=>c.id===id);return i<0?'':String(i);};
  const locations=[...new Set([...Object.keys(config.locations||{}),...(data.employees||[]).map(e=>e.profile.location).filter(Boolean)])];
  const fields=rows+choice('hrContact','Company HR fallback',contactOptions,idx(config.hrContactId))+choice('payrollContact','Company Payroll fallback',contactOptions,idx(config.payrollContactId))+
    locations.map((location,i)=>`<fieldset><legend>${esc(location)} fallback</legend>${choice('locationHR'+i,'HR contact',contactOptions,idx(config.locations[location]?.hrContactId))}${choice('locationPayroll'+i,'Payroll contact',contactOptions,idx(config.locations[location]?.payrollContactId))}</fieldset>`).join('')+
    `<h3>Employee field rules</h3><p>Employment and access fields require HR review. Editable fields are limited to contact details and credentials.</p>`+Object.entries(data.fieldRules||{}).map(([name,value])=>choice('rule-'+name,label(name),[['view','View only'],['request','Request HR correction'],...(['businessPhone','personalEmail','personalPhone','education','certifications'].includes(name)?[['edit','Employee can edit']]:[])],value)).join('');
  ctx.formModal('Business contacts & profile rules',fields,'Save settings',v=>{
    const contacts=[];for(let i=0;i<count;i++)if(v['contactName'+i].trim())contacts.push({id:config.contacts[i]?.id||'business-'+crypto.randomUUID(),name:v['contactName'+i],title:v['contactTitle'+i],email:v['contactEmail'+i],phone:v['contactPhone'+i],slot:i});
    const contactId=index=>contacts.find(c=>String(c.slot)===index)?.id||'';
    const settings={contacts:contacts.map(({slot,...c})=>c),hrContactId:contactId(v.hrContact),payrollContactId:contactId(v.payrollContact),locations:Object.fromEntries(locations.map((location,i)=>[location,{hrContactId:contactId(v['locationHR'+i]),payrollContactId:contactId(v['locationPayroll'+i])}])),fieldRules:Object.fromEntries(Object.keys(data.fieldRules||{}).map(name=>[name,v['rule-'+name]]))};
    return save(ctx,{type:'company-record-settings',companyId,settings},'Business contacts and profile rules saved.');
  });
}

const maxSourceLogoBytes=20*1024*1024,maxSavedLogoBytes=512*1024;
const logoTooLarge='Choose a logo at most 20 MiB, no more than 8192 pixels per side and 24 megapixels.';
function sourceLogoSize(bytes){
  const view=new DataView(bytes.buffer), n=bytes.length;
  if(n>=33&&view.getUint32(0)===0x89504e47&&view.getUint32(4)===0x0d0a1a0a&&view.getUint32(8)===13&&view.getUint32(12)===0x49484452)
    return ['image/png',view.getUint32(16),view.getUint32(20)];
  if(n>10&&view.getUint16(0)===0xffd8){
    for(let i=2;i+8<n;){
      if(bytes[i++]!==255)break;
      while(bytes[i]===255)i++;
      if(i+3>n)break;
      const marker=bytes[i++],length=view.getUint16(i);
      if(marker===218||marker===217||length<2||i+length>n)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)
        return ['image/jpeg',view.getUint16(i+5),view.getUint16(i+3)];
      i+=length;
    }
  }
  throw Error('Choose a readable PNG or JPEG logo.');
}
async function fitLogo(file){
  if(file.size>maxSourceLogoBytes)throw Error(logoTooLarge);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const [mime,w,h]=sourceLogoSize(bytes);
  if(!w||!h||w>8192||h>8192||w*h>24_000_000)throw Error(logoTooLarge);
  let bitmap;
  try{bitmap=await createImageBitmap(new Blob([bytes],{type:mime}));}
  catch{throw Error('This logo could not be opened. Try exporting it again as a PNG or JPEG.');}
  try{
    if(!bitmap.width||!bitmap.height||bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>24_000_000)throw Error(logoTooLarge);
    // One scale for both axes; rounding to whole pixels is the only proportion adjustment.
    let scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    for(let attempt=0;attempt<14;attempt++,scale*=0.78){
      const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d',{alpha:mime==='image/png'});
      context.imageSmoothingQuality='high';
      context.drawImage(bitmap,0,0,width,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime,0.9));
      if(!blob||blob.type!==mime)throw Error('This browser could not prepare the logo. Try exporting a smaller PNG or JPEG.');
      if(blob.size>maxSavedLogoBytes)continue;
      const output=new Uint8Array(await blob.arrayBuffer());let raw='';
      for(let i=0;i<output.length;i+=8192)raw+=String.fromCharCode(...output.subarray(i,i+8192));
      return {mime,data:btoa(raw),width,height,resized:width!==bitmap.width||height!==bitmap.height};
    }
    throw Error('This logo could not be fitted. Try exporting it at a smaller resolution.');
  }finally{bitmap.close();}
}

async function workerBranding(ctx,companyId){
  const data=await ctx.api('worker-brand?companyId='+encodeURIComponent(companyId));
  const fields='<p>Change the name and logo workers see after signing in. Signed-out screens and publisher terms keep their existing identity.</p>'+
    choice('mode','Display branding',[['default','FirmQuill default'],['company','This company'],['parent','Parent company']],data.mode)+
    field('label','This company’s display name (optional)',data.label,'text','maxlength="160" placeholder="'+esc(data.companyName)+'"')+
    choice('parent','Parent company (only used in Parent company mode)',[['','Choose a parent'],...data.parents.map(p=>[p.id,p.name])],data.parent)+
    '<p>For parent branding, set the parent’s own display name and logo on its company record. Workers see only the resolved brand.</p>'+
    '<label>Upload a PNG or JPEG logo<input name="file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"></label>'+
    '<p class="small quiet">Large logos are fitted automatically without cropping or stretching. Original limit: 20 MiB, 8192 pixels per side and 24 megapixels. Nothing changes until you save.</p>'+
    '<p data-logo-status role="status" class="small"></p><img data-logo-preview class="worker-logo-preview" alt="Preview of the new worker portal logo" width="160" height="96" hidden>'+
    (data.hasLogo?'<p class="small quiet">A custom logo is already saved.</p><label class="checkfield"><input type="checkbox" name="remove">Remove the saved custom logo</label>':'');
  let prepared,prepare;
  ctx.formModal('Worker portal branding',fields,'Save branding',async (v,_,form)=>{
    let logoAction=v.remove==='on'?'remove':'keep',logo;
    if(v.file?.name){
      if(v.remove==='on')throw Error('Choose either a new logo or removal.');
      const task=prepare(form.elements.file.files[0]||v.file);
      const result=await task.promise;
      if(!form.isConnected||!form.closest('dialog')?.open||prepared!==task)return;
      if(!result.ok)throw Error(result.message);
      logoAction='replace';logo={mime:result.logo.mime,data:result.logo.data};
    }
    await ctx.api('worker-brand',{companyId,version:data.version,mode:v.mode,label:v.label,parent:v.parent,logoAction,logo});
    if(form.isConnected&&form.closest('dialog')?.open)ctx.closeModal();
    await ctx.refresh();ctx.toast('Worker portal branding saved.');
  });
  const input=document.querySelector('dialog[open] input[name="file"]'), form=input.form;
  const status=form.querySelector('[data-logo-status]'),preview=form.querySelector('[data-logo-preview]');
  prepare=file=>{
    if(prepared?.file===file)return prepared;
    const task={file};prepared=task;
    preview.hidden=true;preview.removeAttribute('src');status.textContent='Preparing logo…';
    task.promise=fitLogo(file).then(logo=>{
      if(prepared===task&&form.isConnected){
        preview.src='data:'+logo.mime+';base64,'+logo.data;preview.hidden=false;
        status.textContent=(logo.resized?'Fitted to ':'Ready at ')+logo.width+' × '+logo.height+' pixels.';
      }
      return {ok:true,logo};
    },error=>{
      if(prepared===task&&form.isConnected)status.textContent=error.message;
      return {ok:false,message:error.message};
    });
    return task;
  };
  input.addEventListener('change',()=>{
    if(input.files[0])prepare(input.files[0]);
    else{prepared=null;preview.hidden=true;preview.removeAttribute('src');status.textContent='';}
  });
}

export async function recordsAction(type,key,ctx){
  if(!type.startsWith('record-'))return false;
  if(type==='record-detail')details(await selected(ctx,key),ctx);
  else if(type==='record-profile')await editProfile(ctx,key);
  else if(type==='record-projects')await projects(ctx,key);
  else if(type==='record-credentials')await credentials(ctx,key);
  else if(type==='record-review-new')await review(ctx,key,true);
  else if(type==='record-review')await review(ctx,key);
  else if(type==='record-stub-upload')await uploadStub(ctx,key);
  else if(type==='record-correction')await correction(ctx,key);
  else if(type==='record-contacts')await contactSettings(ctx,key);
  else if(type==='record-branding')await workerBranding(ctx,key);
  else return false;
  return true;
}
