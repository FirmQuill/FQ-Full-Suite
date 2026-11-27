import {sections,reportClasses,packetRow,packetCsv} from './report-packet.mjs';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const room='<p class="quiet">Build from posted ledger entries. This exports nothing until you decide to print or download. The app never sends a packet.</p>';
export function renderPacket(packet){
  return '<article class="packet-printable"><h2>'+esc(packet.title)+'</h2><p><b>'+esc(packet.company)+'</b> · '+esc(packet.currency)+'<br>'+
    'Activity '+esc(packet.from)+' through '+esc(packet.through)+' · End-of-period balances as of '+esc(packet.through)+'</p>'+
    (packet.restricted?'<p class="callout warn"><b>Partial report: permitted records only.</b> This packet is not company-wide financial reporting. Ask the owner for a complete packet.</p>':'')+
    packet.sections.map(s=>'<section><h3>'+esc(s.label)+'</h3><p>'+esc(s.note)+'</p><div class="tablewrap"><table><thead><tr>'+
      s.headers.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+s.rows.map(r=>
      '<tr'+(r.total?' class="packet-total"':'')+'>'+packetRow(r).map((v,i)=>'<td'+(i>=s.moneyAt?' class="packet-amount"':'')+'>'+esc(v)+'</td>').join('')+'</tr>').join('')+
      '</tbody></table></div></section>').join('')+'</article>';
}
function saveCsv(packet){
  const objectUrl=URL.createObjectURL(new Blob(['\ufeff',packetCsv(packet)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=objectUrl;a.download='FirmQuill-financial-packet-'+packet.through+'.csv';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
}
export async function mountPacket(container,{run}){
  if(!container||container.dataset.active)return;
  container.dataset.active='yes';
  container.innerHTML='<p role="status">Loading report builder…</p>';
  let response;
  try{response=await run();}catch(e){container.querySelector('p').textContent=e.message;return;}
  if(!container.isConnected)return;
  let options=structuredClone(response.defaultOptions),templates=response.templates,selected='',sectionOrder=null,preview=null,dirty=true,busy=false;
  const template=()=>templates.find(t=>t.id===selected);
  function form(){
    const order=sectionOrder||[...options.sections,...Object.keys(sections).filter(k=>!options.sections.includes(k))];
    const flag=(name,label,on)=>'<label><input type="checkbox" name="'+name+'"'+(on?' checked':'')+'> '+label+'</label>';
    container.innerHTML='<div class="packet-settings"><h2>Report builder</h2>'+room+
      '<form data-packet-form><label>Packet title<input name="title" maxlength="120" value="'+esc(options.title)+'" required></label>'+
      '<div class="filters"><label>From<input type="date" name="from" value="'+esc(options.from)+'" required></label>'+
      '<label>Through / as of<input type="date" name="through" value="'+esc(options.through)+'" required></label></div>'+
      '<fieldset><legend>Sections (top to bottom)</legend>'+order.map((k,i)=>
      '<div class="packet-item"><label><input type="checkbox" name="section" value="'+k+'"'+(options.sections.includes(k)?' checked':'')+'> '+esc(sections[k])+'</label>'+
      '<button type="button" data-order="-1" data-section="'+k+'" aria-label="Move '+esc(sections[k])+' up"'+(!i?' disabled':'')+'>↑</button>'+
      '<button type="button" data-order="1" data-section="'+k+'" aria-label="Move '+esc(sections[k])+' down"'+(i===order.length-1?' disabled':'')+'>↓</button></div>').join('')+'</fieldset>'+
      '<fieldset><legend>Columns and filters</legend>'+flag('codes','Show account codes',options.columns.codes)+flag('classes','Group and label trial balance by account class',options.columns.classes)+
      flag('includeZero','Include accounts with zero balance',options.includeZero)+flag('detail','Show account breakdowns on balance sheet and income statement',options.detail)+
      '<label>Trial balance class<select name="trialClass">'+['all',...reportClasses].map(k=>'<option value="'+k+'"'+(options.trialClass===k?' selected':'')+'>'+(k==='all'?'All accounts':k)+'</option>').join('')+'</select></label></fieldset>'+
      '<button class="primary" type="submit">Build preview</button></form>'+
      '<div class="packet-templates"><label>Template <select data-template><option value="">New template</option>'+
      templates.map(t=>'<option value="'+esc(t.id)+'"'+(t.id===selected?' selected':'')+'>'+esc(t.name)+'</option>').join('')+'</select></label>'+
      '<label>Template name <input data-template-name maxlength="80" value="'+esc(template()?.name||'')+'"></label>'+
      '<button type="button" data-packet-action="save">Save template</button> '+
      (selected?'<button type="button" data-packet-action="delete">Delete template</button>':'')+
      '<p class="quiet">Templates store settings only. Build a fresh preview to pull current posted figures.</p></div>'+
      '<p class="error" role="status"></p><div data-packet-output></div></div>';
    draw();
  }
  function draw(){
    const out=container.querySelector('[data-packet-output]');
    if(!preview||dirty){
      out.innerHTML='<p class="quiet">Build or refresh the preview before exporting.</p>';return;
    }
    // Separate screen controls from the content area that is printed.
    out.innerHTML='<div class="packet-export"><button type="button" data-packet-action="print">Print / Save as PDF</button> <button type="button" data-packet-action="csv">Download packet CSV</button></div>'+renderPacket(preview);
  }
  const notify=message=>{const el=container.querySelector('[role=status]');if(el)el.textContent=message;};
  function read(){
    const f=new FormData(container.querySelector('[data-packet-form]'));
    return {title:f.get('title'),from:f.get('from'),through:f.get('through'),sections:f.getAll('section'),
      columns:{codes:f.has('codes'),classes:f.has('classes')},trialClass:f.get('trialClass'),includeZero:f.has('includeZero'),detail:f.has('detail')};
  }
  async function locked(fn){
    if(busy)return;
    busy=true;
    const snap=container.querySelector('.packet-settings');if(snap)snap.inert=true;
    notify('');
    try{await fn();}catch(e){if(container.isConnected)notify(e.message);}
    finally{if(snap)snap.inert=false;busy=false;}
  }
  container.addEventListener('input',e=>{
    if(!e.target.closest('[data-packet-form]'))return;
    dirty=true;draw();
  });
  container.addEventListener('change',e=>{
    if(!e.target.matches('[data-template]'))return;
    selected=e.target.value;options=structuredClone(template()?.options||response.defaultOptions);
    sectionOrder=null;preview=null;dirty=true;form();
  });
  container.addEventListener('submit',e=>{
    if(!e.target.matches('[data-packet-form]'))return;e.preventDefault();e.stopPropagation();
    void locked(async()=>{
      const next=read(),r=await run({type:'preview',options:next});
      if(!container.isConnected)return;
      options=next;preview=r.packet;dirty=false;draw();notify('Preview built from current posted records.');
    });
  });
  container.addEventListener('click',e=>{
    const order=e.target.closest('[data-order]');
    if(order){
      const current=read(),visible=[...container.querySelectorAll('[name=section]')].map(el=>el.value);
      const i=visible.indexOf(order.dataset.section),j=i+Number(order.dataset.order);[visible[i],visible[j]]=[visible[j],visible[i]];
      // Preserve inactive choices' relative position through a movement.
      sectionOrder=visible;
      options={...current,sections:visible.filter(k=>current.sections.includes(k))};
      const name=container.querySelector('[data-template-name]').value;
      dirty=true;form();
      container.querySelector('[data-template-name]').value=name;
      const next=container.querySelector('[data-section="'+order.dataset.section+'"][data-order="'+order.dataset.order+'"]');
      if(!next?.disabled)next?.focus();
      return;
    }
    const action=e.target.closest('[data-packet-action]')?.dataset.packetAction;if(!action)return;
    if(action==='delete'&&!confirm('Delete this saved template? No ledger data will change.'))return;
    void locked(async()=>{
      const old=template(),key=old?{id:old.id,version:old.version}:{};
      if(action==='save'||action==='delete'){
        const next=read(),name=container.querySelector('[data-template-name]').value;
        const r=await run({type:action,name,options:next,...key});
        if(!container.isConnected)return;
        templates=r.templates;selected=r.templateId||'';options=next;form();
        notify(action==='save'?'Template saved.':'Template deleted.');return;
      }
      if(!preview||dirty)return;
      const fresh=await run({type:'preview',options:read()});
      if(!container.isConnected)return;
      if(JSON.stringify(fresh.packet)!==JSON.stringify(preview)){
        preview=fresh.packet;draw();notify('Books or permissions changed. Review the refreshed preview and choose export again.');return;
      }
      if(action==='csv')saveCsv(preview);
      if(action==='print'){
        document.body.classList.add('printing-report-packet');
        try{window.print();}finally{document.body.classList.remove('printing-report-packet');}
      }
    });
  });
  form();
}
