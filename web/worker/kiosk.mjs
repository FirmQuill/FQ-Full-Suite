const $=id=>document.getElementById(id);
const pair=$('pair'),punch=$('punch'),result=$('result');
let busy=false,notice;
const text=(message,clear=false)=>{
  clearTimeout(notice);result.textContent=message;
  if(clear)notice=setTimeout(()=>result.textContent='Ready for the next employee.',6000);
};
async function api(path,body){
  const r=await fetch('/api/time-kiosk/'+path,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await r.json();
  if(!r.ok)throw Object.assign(Error(data.error||'Station request did not complete.'),{status:r.status});
  return data;
}
function configured(data){
  $('station').textContent=data.paired?data.label:'';
  pair.hidden=data.paired;punch.hidden=!data.paired;
  if(data.paired)$('worker-id').focus();
}
try{const data=await api('status');configured(data);text(data.paired?'Ready to clock in or out.':'This station is not paired.');}
catch(err){text(err.status?err.message:'Station unavailable. Check the connection and reload.');}
pair.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;const button=event.submitter;button.disabled=true;
  const code=$('pair-code').value.trim();pair.reset();
  try{configured(await api('pair',{code}));text('Station paired. Ready for the first employee.');}
  catch(e){text(e.status?e.message:'Connection interrupted. Reload to check whether the station paired.');}
  finally{busy=false;button.disabled=false;if(!pair.hidden)$('pair-code').focus();}
});
punch.addEventListener('submit',event=>event.preventDefault());
for(const button of punch.querySelectorAll('button[data-action]'))button.addEventListener('click',async()=>{
  if(busy||!punch.reportValidity())return;
  busy=true;const buttons=[...punch.querySelectorAll('button')];for(const b of buttons)b.disabled=true;
  const p={workerId:$('worker-id').value,pin:$('pin').value,action:button.dataset.action,request:crypto.randomUUID(),requestedAt:Date.now()};
  punch.reset();text('Recording…');
  try{
    try{await api('punch',p);}catch(e){if(e.status)throw e;await api('punch',p);}
    text(p.action==='clock-in'?'Clock-in recorded.':'Clock-out recorded.',true);
  }catch(e){text(e.status?e.message:'Could not confirm the punch. Check with your supervisor before trying again.');
    if(e.status===401){configured({paired:false});$('pair-code').focus();}
  }finally{busy=false;for(const b of buttons)b.disabled=false;if(!punch.hidden)$('worker-id').focus();}
});
