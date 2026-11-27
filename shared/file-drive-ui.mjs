const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parameters=(companyId,groupId,folderId)=>new URLSearchParams({companyId,groupId,folderId});
export function driveView(data,{worker=false,transferMarkup=''}={}){
  const q=parameters(data.companyId,data.groupId,data.folderId);
  const scopes=[{id:'',name:'My private drive'},...data.groups];
  const groupOptions=scopes.map(({id,name})=>`<option value="${esc(id)}"${id===data.groupId?' selected':''}>${esc(name)}</option>`).join('');
  const crumbs=[{id:'',name:'Drive root'},...data.path].map(({id,name})=>`<button type="button" data-drive-folder="${esc(id)}">${esc(name)}</button>`).join(' / ');
  const rows=data.entries.map(e=>{
    const link=new URLSearchParams(q);link.set('id',e.id);
    return `<tr><td>${e.kind==='file'?`<a href="/api/drives/download?${esc(link)}" download>${esc(e.name)}</a>`:`<button type="button" data-drive-folder="${esc(e.id)}">${esc(e.name)}</button>`}</td><td>${e.kind==='file'?e.size.toLocaleString()+' bytes':'Folder'}</td><td>${e.canDelete?`<button type="button" data-drive-delete="${esc(e.id)}" data-drive-label="${esc(e.name)}" aria-label="Delete ${esc(e.name)}">Delete</button>`:''}</td></tr>`;
  }).join('');
  return `<section class="card"><h2>${data.groupId?'Group drive':'My private drive'}</h2>
  <p>${data.groupId?'Files are available only to active members of this group.':'Only this login can access these files in the app.'} Files are downloaded, never run or previewed here.</p>
  <label for="drive-selector">Drive</label> <select id="drive-selector" data-drive-scope>${groupOptions}</select>
  <nav aria-label="Folders">${crumbs}</nav>
  <div class="records">${rows?`<table><thead><tr><th>Name</th><th>Size or type</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>This folder is empty.</p>'}</div>
  <form data-drive-form="folder"><label>New folder name <input name="name" maxlength="200" required></label><button type="submit">Create folder</button></form>
  <form data-drive-form="upload"><label>File to upload (4 MiB max) <input name="file" type="file" required></label><button type="submit">Upload file</button></form>
  ${worker?'':transferMarkup}</section>`;
}
export function mountDrive(root,{companyId,csrf,worker=false,markup,submitExtra}){
  if(!root||!companyId||!csrf)return;
  if(root.dataset.driveMounted)return;
  root.dataset.driveMounted='true';
  root.innerHTML='<p data-drive-notice role="status"></p><div data-drive-content>Loading drives…</div>';
  const status=root.querySelector('[data-drive-notice]'),content=root.querySelector('[data-drive-content]');
  let groupId='',folderId='',active=false,current=null;
  async function request(action,{method='GET',body,filename,params}={}){
    const q=new URLSearchParams(params||parameters(companyId,groupId,folderId));
    const headers={Accept:'application/json'};
    if(method==='POST'){
      headers['X-CSRF-Token']=csrf;
      headers['Content-Type']=action==='upload'?'application/octet-stream':'application/json';
      if(filename)headers['X-Drive-Filename']=encodeURIComponent(filename);
    }
    const res=await fetch('/api/drives/'+action+'?'+q,{method,body,headers,cache:'no-store',credentials:'same-origin'});
    const data=await res.json();
    if(!res.ok)throw Error(data.error||'Unable to open this drive.');
    return data;
  }
  async function load(nextGroup=groupId,nextFolder=folderId){
    const data=await request('list',{params:parameters(companyId,nextGroup,nextFolder)});
    const transferMarkup=worker?'':await markup?.(data);
    if(root.isConnected){
      groupId=nextGroup;folderId=nextFolder;current=data;
      content.innerHTML=driveView(data,{worker,transferMarkup:transferMarkup||''});
    }
  }
  async function perform(fn){
    if(active)return;
    active=true;status.textContent='';content.inert=true;content.setAttribute('aria-busy','true');
    try{await fn();}catch(e){if(root.isConnected){status.textContent=e.message||'Drive request failed.';if(!content.querySelector('section'))content.textContent='Open the Drives page again to retry.';}}
    finally{active=false;content.inert=false;content.removeAttribute('aria-busy');}
  }
  root.addEventListener('change',ev=>{
    if(!ev.target.matches('[data-drive-scope]'))return;
    ev.stopPropagation();
    const requested=ev.target.value;
    void perform(async()=>{try{await load(requested,'');}catch(e){ev.target.value=groupId;throw e;}});
  });
  root.addEventListener('click',ev=>{
    const b=ev.target.closest('button[data-drive-folder],button[data-drive-delete]');
    if(!b)return;
    ev.preventDefault();ev.stopPropagation();
    if('driveFolder' in b.dataset){void perform(()=>load(groupId,b.dataset.driveFolder));return;}
    if(!confirm('Delete “'+b.dataset.driveLabel+'”?'))return;
    void perform(async()=>{await request('action',{method:'POST',body:JSON.stringify({type:'delete',id:b.dataset.driveDelete})});await load();status.textContent='Deleted.';});
  });
  root.addEventListener('submit',ev=>{
    const form=ev.target,type=form.dataset.driveForm;
    if(!type&&(!submitExtra||!form.matches('[data-private-ftps]')))return;
    ev.preventDefault();ev.stopPropagation();
    void perform(async()=>{
      if(!type){await submitExtra(form,current,{refresh:load});return;}
      if(type==='upload'){
        const file=form.elements.file.files[0];
        if(!file||file.size>4*1024*1024)throw Error('Choose a file no larger than 4 MiB.');
        await request('upload',{method:'POST',filename:file.name,body:file});
      }else await request('action',{method:'POST',body:JSON.stringify({type:'folder',name:form.elements.name.value})});
      await load();status.textContent=type==='upload'?'File uploaded.':'Folder created.';
    });
  });
  void perform(()=>load());
}
