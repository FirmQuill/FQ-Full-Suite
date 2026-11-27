import {browserSupportsWebAuthn,startRegistration,startAuthentication} from './passkey-browser.mjs';
const node=(tag,label)=>{const el=document.createElement(tag);if(label!==undefined)el.textContent=label;return el;};
const button=(label)=>{const el=node('button',label);el.type='button';return el;};
const hint=err=>['NotAllowedError','AbortError'].includes(err?.name)?'Passkey prompt cancelled or unavailable. You can still use your password.':err?.message||'The passkey could not be used.';

export async function bindPasskeyLogin(form,api,onSignIn){
 if(!form||!isSecureContext||!browserSupportsWebAuthn())return;
 try{
   const {available}=await api('passkeys/available');if(!form.isConnected)return;
   if(!available){
     if(location.protocol==='http:'&&location.hostname==='127.0.0.1'){
       const a=node('a','Open localhost to use passkeys on this computer');const u=new URL(location.href);u.hostname='localhost';a.href=u.toString();const p=node('p');p.append(a);form.append(p);
     }
     return;
   }
 }catch{return;}
 const b=button('Sign in with a passkey'),err=form.querySelector('.error');
 form.append(b);
 b.addEventListener('click',async()=>{
   if(b.disabled)return;
   const toggled=[...form.querySelectorAll('button')].filter(x=>!x.disabled);
   for(const x of toggled)x.disabled=true;
   err.textContent='';
   try{
     const {options}=await api('passkeys/sign-in/start',{});
     const response=await startAuthentication({optionsJSON:options});
     if(form.isConnected)await onSignIn(await api('passkeys/sign-in/finish',{response}));
   }catch(e){if(form.isConnected)err.textContent=hint(e);}
   finally{for(const x of toggled)x.disabled=false;}
 });
}
export function bindPasskeyManagement(slot,api){
 if(!slot||!isSecureContext||!browserSupportsWebAuthn()||location.hostname==='127.0.0.1')return;
 const trigger=button('Manage passkeys');
 const dialog=node('dialog'),heading=node('h2','Manage passkeys'),display=node('div'),error=node('p'),close=button('Close passkey management');
 heading.id='fq-passkey-manager-heading';dialog.setAttribute('aria-labelledby',heading.id);
 error.setAttribute('role','alert');
 close.addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>{display.replaceChildren();error.textContent='';if(trigger.isConnected)trigger.focus();});
 dialog.append(heading,node('p','Your device or password manager keeps the private passkey. Keep your password available for recovery and to manage these passkeys.'),display,error,close);
 slot.append(trigger,dialog);
 const fill=data=>{
   if(!dialog.open||!slot.isConnected)return;
   const list=node('ul');
   for(const it of data.credentials){
     const row=node('li'),r=button('Remove '+it.name);row.append(node('span',it.name+' · Added '+it.createdAt.slice(0,10)+(it.lastUsed?' · Last used '+it.lastUsed.slice(0,10):'')+' '),r);list.append(row);
     r.addEventListener('click',()=>{
       if(display.querySelector('[aria-busy="true"]'))return;
       showForm('Remove passkey '+it.name,true,async password=>api('passkeys/revoke',{id:it.id,password}));
     });
   }
   const create=button('Add passkey');
   create.addEventListener('click',()=>{
     showForm('Create a named passkey',false,async(password,label)=>{
       const {options,ticket}=await api('passkeys/register/start',{password,label});
       const response=await startRegistration({optionsJSON:options});
       if(!slot.isConnected||!dialog.open)throw Error('Passkey setup was closed. Start again.');
       return api('passkeys/register/finish',{ticket,response});
     });
   });
   display.replaceChildren(data.credentials.length?list:node('p','No passkeys are registered for this account and portal.'),create);
 };
 async function load(){
   try{const data=await api('passkeys/list');if(data.available)fill(data);else display.textContent='Passkeys are unavailable for this local account or portal.';}
   catch(e){if(dialog.open)error.textContent=hint(e);}
 }
 function showForm(title,remove,apply){
   const form=node('form'),legend=node('h3',title),label=node('label','Current password'),password=node('input');
   password.type='password';password.autocomplete='current-password';password.required=true;label.append(password);form.append(legend,label);
   let name;
   if(!remove){const n=node('label','Passkey name');name=node('input');name.maxLength=64;name.required=true;n.append(name);form.append(n);}
   const okay=node('button',remove?'Confirm removal':'Verify password and continue'),back=button('Back to passkeys');okay.type='submit';back.addEventListener('click',()=>load());form.append(okay,back);display.replaceChildren(form);password.focus();error.textContent='';
   form.addEventListener('submit',async event=>{
     event.preventDefault();event.stopPropagation();if(okay.disabled)return;
     okay.disabled=true;back.disabled=true;form.setAttribute('aria-busy','true');error.textContent='';
     const current=password.value;password.value='';
     try{fill(await apply(current,name?.value));}
     catch(e){if(dialog.open)error.textContent=hint(e);}
     finally{okay.disabled=false;back.disabled=false;form.removeAttribute('aria-busy');}
   });
 }
 trigger.addEventListener('click',()=>{dialog.showModal();display.textContent='Loading passkeys…';void load();});
}
