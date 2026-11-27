import {esc,btn,table,panel,input,select,choices,mapping} from '/shared/views.mjs';

const detail=value=>`<pre>${esc(JSON.stringify(value,null,2))}</pre>`;
const optionalInput=(...args)=>input(...args).replace(' required>','>');
export function connectedContent(page,data,session){
  if(page==='Setup help')return (data?.error?panel('Support documentation unavailable',`<p>${esc(data.error)}</p><p>The application remains available. Contact your host administrator.</p>`):data?.scope==='private-customer-manual'?panel('Privately supplied customer manual','<p>Your host explicitly selected this separate customer manual for support. Search retrieves documentation only and cannot read company records.</p>',btn('support-search','Search supplied manual')+btn('support-ask','Find matching guidance')+btn('support-public-search','Search public setup guide')):panel('Public setup guide','<p>Search installation, first administrator, empty or package setup, verification and setup recovery. Matching guidance comes from the public setup guide without an AI service. It cannot read company records. Your privately supplied customer manual is separate.</p>',btn('support-search','Search setup guide')+btn('support-ask','Find matching guidance')))+(session.user.role==='owner'?panel('Local support diagnostics','<p>Review a small technical report before downloading it. The report contains application, runtime and schema versions and coded checks for installed features. No records, paths, logs or credentials are included. Nothing is sent automatically.</p>',btn('support-diagnostics','Preview diagnostics')):'');
  if(!data)return '<p>Loading…</p>';
  if(data.error)return `<p class="error">${esc(data.error)}</p>`;
  if(page==='Migration workspace')return panel('Prepare a company package','<p>Stage exports from several sources, map fields, review errors and reconcile before approving. Staging leaves the current books unchanged. Use fictional files for evaluation. Raw exports stay in your own protected folder. No data is sent to an AI service.</p>',btn('migration-create','New migration','','primary'))+
    panel('Company migrations',table(['Company','Migration ID','Actions'],(data.runs||[]).map(r=>[esc(r.company?.name||r.companyName||r.name),esc(r.id||r.runId),btn('migration-stage','Map CSV',r.id||r.runId)+btn('migration-iif','QuickBooks Desktop contacts',r.id||r.runId)+btn('migration-expectations','Set control balances',r.id||r.runId)+btn('migration-preview','Preview / reconcile',r.id||r.runId)+btn('migration-package','Build approved package',r.id||r.runId)]),'No staged migrations.'))+
    panel('Available formats',detail(data.coverage||{}))+
    panel('Reusable mapping profiles',detail(data.profiles||[]));
  return '';
}
function display(ctx,title,value){ctx.formModal(title,detail(value),'',null);}
export async function connectedAction(type,key,ctx){
  const {api,formModal,closeModal,refresh,toast,auxiliary,session,download}=ctx;
  switch(type){
    case 'migration-create':formModal('New company migration',input('companyName','Company name','text','','maxlength="160"'),'Create staging workspace',async v=>{await api('migration',{type:'create',companyName:v.companyName});closeModal();await refresh();toast('Migration staging created.');});return true;
    case 'migration-iif':{
      formModal('Stage QuickBooks Desktop contact list',input('sourceId','Stable source namespace (reuse for the same source)','text','','maxlength="80"')+input('edition','QuickBooks Desktop edition / version')+input('exportedAt','Export date','date',new Date().toISOString().slice(0,10))+select('contactKind','Exported list type',[['Customer','Customer'],['Vendor','Vendor']])+'<label>QuickBooks Desktop list file<input type="file" name="file" accept=".iif,text/plain" required></label><p>Select a single exported flat customer or vendor list. Only the contact name and type are imported. You can provide approved ID mappings below when source REFNUM is absent. Keep stable IDs across exports.</p><label>Reviewed ID crosswalk by exact name (JSON)<textarea name="crosswalk">{}</textarea></label><label><input type="checkbox" name="fictional" checked> This is a fictional fixture</label>','Stage QuickBooks contacts',async(values,form)=>{
        const file=form.get('file');if(!file?.size||file.size>2*1024*1024)throw Error('Choose an IIF no larger than 2 MiB.');
        let crosswalk;try{crosswalk=JSON.parse(values.crosswalk||'{}');}catch{throw Error('Enter a JSON object for the stable-ID crosswalk.');}
        const bytes=await file.arrayBuffer();let iif;try{iif=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{iif=new TextDecoder('windows-1252').decode(bytes);}
        const result=await api('migration',{type:'stage',runId:key,source:{id:values.sourceId,product:'QuickBooks Desktop',edition:values.edition,exportedAt:values.exportedAt,fixtureOnly:form.has('fictional')},recordType:'contacts',csv:iif,nativeProfile:'quickbooks-desktop-iif-contacts',contactKind:values.contactKind,iifCrosswalk:crosswalk});
        closeModal();await refresh();display(ctx,'Staging result',result);
      });return true;
    }
    case 'migration-stage':{
      const fields=auxiliary.fields||{};
      formModal('Choose records to map',select('recordType','Record type',Object.keys(fields).map(k=>[k,k])),'Continue',async v=>{
        const recordType=v.recordType,definition=fields[recordType],names=Array.isArray(definition)?definition:Object.keys(definition||{});
        formModal('Map '+recordType+' CSV',input('sourceId','Stable source namespace (reuse for the same source)','text','','maxlength="80"')+input('product','Source product and edition')+input('exportedAt','Export date','date',new Date().toISOString().slice(0,10))+optionalInput('profileName','Save mapping profile as (optional)','text','','maxlength="80"')+'<label>Saved profile<select name="profile"><option value="">Manual mapping</option>'+(auxiliary.profiles||[]).filter(p=>p.recordType===recordType).map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')+'</select></label><label>CSV export<input type="file" name="file" accept=".csv,text/csv" required></label><p>Enter the exact CSV header for each canonical field. Leave unused optional fields empty. Dates use YYYY-MM-DD; amounts are whole integer cents (100 = $1.00) unless you explicitly choose a transform. Source identifiers must remain stable across repeats.</p>' + (['invoiceLines','billLines'].includes(recordType)?'<p>Give all document lines the same sourceId, but distinct stable lineId values. Stage every line of a document together, with the same contact, date and document description. Map quantity, unit price, discount if any, and independent net amount. This mode is for service lines only.</p>':'') + ''+names.map(name=>optionalInput('map-'+name,name+' header','text','','maxlength="160"')+`<label>${esc(name)} transform<select name="transform-${esc(name)}"><option value="">As supplied</option>${['decimalDollars','integerCents','isoDate','MM/DD/YYYY','DD/MM/YYYY','text'].map(t=>`<option>${esc(t)}</option>`).join('')}</select></label>`).join('')+'<label><input type="checkbox" name="fictional" checked> This is a fictional fixture (uncheck for real local exports)</label>','Stage mapped rows',async(values,form)=>{
          const file=form.get('file');if(!file?.size||file.size>2*1024*1024)throw Error('Choose a CSV no larger than 2 MiB.');
          const profile=(auxiliary.profiles||[]).find?.(p=>p.name===values.profile&&p.recordType===recordType);
          const mapping=profile?.mapping||Object.fromEntries(names.filter(name=>values['map-'+name]).map(name=>[name,values['transform-'+name]?{column:values['map-'+name],transform:values['transform-'+name]}:values['map-'+name]]));
          if(values.profileName)await api('migration',{type:'profile',name:values.profileName,recordType,mapping});
          const result=await api('migration',{type:'stage',runId:key,source:{id:values.sourceId,product:values.product,edition:values.product,exportedAt:values.exportedAt,fixtureOnly:form.has('fictional')},recordType,csv:await file.text(),mapping,profileName:values.profileName||values.profile||undefined});
          closeModal();await refresh();display(ctx,'Staging result',result);
        });
      });return true;
    }
    case 'migration-preview':{
      const preview=await api('migration',{type:'preview',runId:key});
      formModal('Reconcile migration preview',detail(preview)+(preview.unresolved||[]).filter(r=>r.status!=='excluded').map(r=>`<p>${esc(r.status)} · line ${esc(r.line)} ${btn('migration-exclude','Exclude this source row',[key,r.batchId,r.line].join('|'))}</p>`).join('')+'<label><input type="checkbox" name="accept" required> I reviewed counts, balances and every unresolved item. Approve this staged version.</label>','Approve staged version',async()=>{await api('migration',{type:'approve',runId:key,previewDigest:preview.previewDigest||preview.digest,acceptExceptions:true});closeModal();await refresh();toast('Staged records approved for packaging.');});return true;
    }
    case 'migration-exclude':{const [runId,batchId,line]=key.split('|');await api('migration',{type:'exclude',runId,items:[{batchId,line:Number(line)}]});closeModal();await refresh();toast('Row excluded. Preview and approve the revised scope.');return true;}
    case 'migration-expectations':formModal('Independent control balances','<p>Enter independently checked closing balances as JSON: account code to signed integer cents, for example {"1000":52000,"1100":10000,"2000":-3000}. An empty object provides no independent comparison.</p><label>Expected balances<textarea name="balances" required>{}</textarea></label>','Save control balances',async v=>{let balances;try{balances=JSON.parse(v.balances);}catch{throw Error('Enter valid JSON control balances.');}await api('migration',{type:'expectations',runId:key,balances});closeModal();await refresh();toast('Control balances set. Reconcile again.');});return true;
    case 'migration-package':{
      const preview=await api('migration',{type:'preview',runId:key});
      const result=await api('migration',{type:'package',runId:key,approvedDigest:preview.previewDigest||preview.digest});
      download(result.packageText,result.filename,'application/json');toast('Private company package downloaded. Keep it outside the application folder.');return true;
    }
    case 'support-diagnostics':{
      const data=await api('support/diagnostics');
      const preview=JSON.stringify(data,null,2)+'\n';
      formModal('Preview local support diagnostics','<p>These are the exact contents of the download. Checks confirm only the presence of expected database schema parts. They do not test integrations, data integrity, backups or access permissions.</p><pre data-support-diagnostics-preview>'+esc(preview)+'</pre>',
        'Download diagnostics JSON',()=>{
          download(preview,'FirmQuill-Full-Suite-diagnostics.json','application/json');closeModal();toast('Diagnostics downloaded. Nothing was sent.');
        });return true;
    }
    case 'support-public-search':case 'support-search':case 'support-ask':{const publicOnly=type==='support-public-search',privateMode=!publicOnly&&auxiliary?.scope==='private-customer-manual';formModal(privateMode?'Search privately supplied customer manual':type==='support-ask'?'Find matching guidance':'Search public setup guide',input('question',privateMode?'Documentation question':'Setup question','text','','maxlength="1500"'),'Search',async v=>{
      const route=publicOnly?'&scope=public':'';
      const result=type==='support-ask'?await api('support/answer',{question:v.question}):await api('support/search?q='+encodeURIComponent(v.question)+route);
      formModal(privateMode?'Private manual guidance':'Public setup guidance',`<p>Installed version ${esc(result.version)}</p>${result.answer?`<p class="request-detail">${esc(result.answer)}</p>`:''}`+(result.citations||result.results||[]).map(c=>`<p>${btn(publicOnly?'support-public-article':'support-article',c.title,c.id)}<br><small>${esc(c.version)} · ${esc(c.section||c.snippet||'')}</small></p>`).join('')+`<p>${esc(result.escalation?.message||'Contact your designated support contact if this guidance does not resolve the problem.')}</p>`,'',null);
    });return true;}
    case 'support-public-article':case 'support-article':{const article=await api('support/article?id='+encodeURIComponent(key)+(type==='support-public-article'?'&scope=public':''));formModal(article.title,`<p>Article ${esc(article.id)} · installed version ${esc(article.version)}</p><pre>${esc(article.body)}</pre>`,'',null);return true;}
    default:return false;
  }
}
