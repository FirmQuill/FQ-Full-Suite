import {btn,esc,input,panel,select,table} from '/shared/views.mjs';
import {knowledgeMeta,knowledgeText} from '/shared/knowledge-content.mjs';

export function mainKnowledgeContent(data,company){
 if(!company)return panel('Company knowledge','<p>Create a company first.</p>');
 if(!data)return panel('Company knowledge','<p>Loading articles…</p>');
 if(data.error)return panel('Company knowledge','<p role="alert">'+esc(data.error)+'</p>');
 const {rights,article:r,articles,history,accounts}=data;
 if(r){
   const tools=btn('knowledge-reset','Back to articles')+
     (rights.edit&&!r.historical?btn('knowledge-edit','Edit draft',r.id):'')+
     (rights.publish&&!r.historical&&r.status!=='Published'?btn('knowledge-publish','Publish draft',r.id):'')+
     (rights.publish&&!r.historical&&r.status!=='Draft'?btn('knowledge-withdraw','Withdraw publication',r.id):'')+
     (rights.edit&&r.historical?btn('knowledge-restore','Restore this revision as draft',r.id):'');
   return panel(r.title,'<p class="quiet">'+knowledgeMeta(r)+(r.status?' · '+esc(r.status):'')+' · Version '+esc(r.version)+'</p>'+knowledgeText(r.body),tools)+
    (history?.length?panel('Article history',table(['Version','Action','Saved at'],history.map(h=>[btn('knowledge-history',String(h.version),r.id+':'+h.version,'link'),esc(h.event),esc(h.created)]))):'');
 }
 return panel('Company knowledge','<p>Company-authored articles. This workspace is separate from public setup help and any privately supplied support manual.</p>'+
    (data.more?'<p>Showing 60 results. Search to narrow the list.</p>':'')+
    table(['Article','Category / tags','Updated','Status'],articles.map(a=>[btn('knowledge-read',a.title,a.id,'link'),knowledgeMeta(a),esc(a.updated.slice(0,10)),esc(a.status||'Published')]),'No articles match.'),btn('knowledge-search','Search articles')+(rights.edit?btn('knowledge-create','New article','','primary'):'')+(data.query?btn('knowledge-reset','Clear search'):''))+
    (rights.manage?panel('Company article permissions','<p>Assigned ERP users with the Company knowledge area may read published articles. Editors can save drafts. Publishers can publish and withdraw. Worker portal reading is enabled per employee in User access.</p>'+
      table(['ERP account','Knowledge access'],accounts.map(a=>[esc(a.name),esc(a.role)]),'No other ERP accounts are assigned.'),accounts.length?btn('knowledge-grant','Manage article permissions'):''):'');
}
export async function mainKnowledgeAction(type,key,{data,companyId,api,formModal,closeModal,show,toast}){
 if(!type.startsWith('knowledge-'))return false;
 const route='company-knowledge?companyId='+encodeURIComponent(companyId);
 const detail=(id,version)=>route+'&id='+encodeURIComponent(id)+(version?'&version='+encodeURIComponent(version):'');
 const command=async (input,id)=>{const {result}=await api(route,input);const next=await api((id||input.type==='save')?detail(result.id):route);closeModal();show(next);toast('Company knowledge updated.');};
 if(type==='knowledge-reset'){show(await api(route));return true;}
 if(type==='knowledge-read'){show(await api(detail(key)));return true;}
 if(type==='knowledge-history'){
   const [id,version]=key.split(':');show(await api(detail(id,version)));return true;
 }
 if(type==='knowledge-search'){
   formModal('Search company articles',input('q','Title, tags, category, or article text','search',data?.query||'','maxlength="160"'),'Search',async(v)=>{
     const next=await api(route+'&q='+encodeURIComponent(v.q));closeModal();show({...next,query:v.q});
   });return true;
 }
 if(type==='knowledge-create'||type==='knowledge-edit'){
   const r=data?.article??{};
   formModal(type==='knowledge-create'?'New company article':'Edit company article',
     input('title','Title','text',r.title||'','maxlength="160"')+
     '<label>Category<input name="category" maxlength="80" value="'+esc(r.category||'')+'"></label>'+
     '<label>Tags (separate with commas)<input name="tags" maxlength="500" value="'+esc((r.tags||[]).join(', '))+'"></label>'+
     '<label>Article text<textarea name="body" rows="12" maxlength="24000" required>'+esc(r.body||'')+'</textarea></label>',
     'Save draft',v=>command({type:'save',...v,id:r.id,version:r.editVersion},r.id));return true;
 }
 if(type==='knowledge-grant'){
   formModal('Company article permissions',select('account','ERP account',data.accounts.map(a=>[a.id,a.name+' · '+a.role]))+
     select('role','Knowledge access',[['reader','Reader'],['editor','Editor'],['publisher','Publisher'],['editor and publisher','Editor and publisher']]),'Save permission',v=>command({type:'grant',...v}));return true;
 }
 const operations={'knowledge-publish':['publish','Publish draft','Readers will see this revision in company knowledge.'],'knowledge-withdraw':['withdraw','Withdraw publication','Readers will no longer see this article. The revision history is retained.'],'knowledge-restore':['restore','Restore this revision','Save a new draft from this revision. Published text is not affected until you publish.']};
 const [op,title,msg]=operations[type]||[];if(!op)return false;
 const r=data.article;formModal(title,'<p>'+esc(msg)+'</p>',title,()=>command({type:op,id:r.id,version:r.editVersion,sourceVersion:r.version},r.id));return true;
}
