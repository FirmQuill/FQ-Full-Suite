const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope=d=>({companyId:d.companyId,groupId:d.groupId||'',folderId:d.folderId||''});
export const privateFtpsQuery=d=>'private-ftps?'+new URLSearchParams(scope(d));

export function privateFtpsMarkup(d,state){
  if(!state?.enabled)return '';
  const eligible=(d.entries||[]).filter(f=>f.kind==='file'&&f.size<=state.maxBytes);
  const options=eligible.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  return `<section class="panel" aria-label="FTPS manual transfers"><h2>Private FTPS transfer</h2>
    <p>Transfer one file (up to 4 MiB) between this drive and the company-configured server and folder. Uses explicit TLS. Nothing syncs automatically.</p>
    ${options?`<form data-private-ftps="upload"><label>Private drive file <select name="fileId" required>${options}</select></label><button type="submit">Upload one copy</button><p class="error" role="alert"></p></form>`:''}
    <form data-private-ftps="download"><label>Exact remote filename <input required name="remoteName" maxlength="120" autocapitalize="none" spellcheck="false" placeholder="example.pdf"></label><button type="submit">Download into this folder</button><p class="error" role="alert"></p></form>
    <p class="small">Uploads use a unique remote filename. Copy the resulting name from the upload confirmation.</p></section>`;
}

export async function submitPrivateFtps(form,d,{api,toast,refresh}){
  const action=form.dataset.privateFtps;
  if(action!=='upload'&&action!=='download')return false;
  const value=new FormData(form);
  const button=form.querySelector('button[type=submit]'),error=form.querySelector('.error');
  button.disabled=true;
  error.textContent='';
  try{
    const result=await api('private-ftps',{...scope(d),action,...(action==='download'?{remoteName:value.get('remoteName')}:{fileId:value.get('fileId')})});
    if(action==='upload'){
      error.textContent='Uploaded as '+result.remoteName;
      error.classList.remove('error');error.setAttribute('role','status');
    }else{
      toast('Downloaded '+result.filename+' into this drive folder.');
      try{await refresh();}catch{toast('Download saved. Refresh the drive to see it.');}
    }
  }catch(e){
    error.classList.add('error');error.setAttribute('role','alert');error.textContent=e.message;
  }finally{button.disabled=false;}
  return true;
}
