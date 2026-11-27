const el=(name,text)=>{const node=document.createElement(name);if(text!==undefined)node.textContent=text;return node;};
let counter=0;
export function mountContextualHelp(slot,{page,companyId='',api}){
  if(!slot)return;
  const query=new URLSearchParams({page,...(companyId?{companyId}:{})});
  async function establish(){
    const start=performance.now();
    let eligibility;try{eligibility=await api('support/context?'+new URLSearchParams([...query,['check','1']]));}catch{return;}
    const time=eligibility?.validForMs-(performance.now()-start);
    if(!eligibility?.available||!Number.isFinite(time)||time<=0||!slot.isConnected)return;
    const button=el('button','?');button.type='button';
    button.className='contextual-help-button';button.setAttribute('aria-label','Help for '+page);button.setAttribute('aria-haspopup','dialog');
    const box=el('dialog');box.className='contextual-help-dialog';
    const key='contextual-help-'+(++counter),heading=el('h2'),status=el('p'),article=el('div'),close=el('button','Close help');
    heading.id=key;box.setAttribute('aria-labelledby',key);status.setAttribute('role','status');article.className='contextual-help-article';
    close.type='button';close.autofocus=true;close.addEventListener('click',()=>box.close());
    let request=0;
    const remove=()=>{request++;if(box.open)box.close();if(button.isConnected)slot.replaceChildren();};
    const timer=setTimeout(()=>{if(slot.isConnected){remove();void establish();}},time);
    box.addEventListener('close',()=>{request++;article.replaceChildren();if(button.isConnected)button.focus();});
    box.append(heading,status,article,close);slot.replaceChildren(button,box);
    button.addEventListener('click',async()=>{
      if(box.open)return;
      const active=++request;
      heading.textContent='Help for '+page;status.textContent='Checking for an article…';article.replaceChildren();box.showModal();
      let result;try{result=await api('support/context?'+query);}catch{}
      if(active!==request||!box.isConnected||!box.open)return;
      if(!result?.available){clearTimeout(timer);remove();return;}
      status.textContent='Article for FirmQuill Full Suite '+result.version;
      article.append(el('h3',result.title));
      for(const line of result.body.replace(/\r\n?/g,'\n').split(/\n\s*\n/)){
        const m=/^#{1,4} ([^\n]+)$/.exec(line);
        article.append(m?el('h4',m[1]):el('p',line));
      }
    });
  }
  void establish();
}
