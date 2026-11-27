const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const choices=rows=>rows.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.name)+(r.role?' · '+esc(r.role):'')+'</option>').join('');
const readableTime=value=>new Date(value).toLocaleString();
const text=value=>esc(value).replace(/\r\n?|\n/g,'<br>');
export function messagesUrl(companyId,detail={}){
  const params=new URLSearchParams();
  if(companyId)params.set('companyId',companyId);
  if(detail.id)params.set('threadId',detail.id);
  if(detail.before)params.set('before',detail.before);
  return 'collaboration/messages?'+params;
}
export function messagingContent(data){
  if(data?.error)return '<section class="card"><p>'+esc(data.error)+'</p></section>';
  if(!data)return '<section class="card"><p>Loading messages…</p></section>';
  const {people,groups,threads,conversation:c}=data;
  const compose=(kind,rows,label)=>rows.length?'<form data-chat="'+kind+'"><h3>'+label+'</h3><label>Recipient<select name="target" required><option value="">Choose…</option>'+choices(rows)+'</select></label><label>Message<textarea name="body" maxlength="4000" rows="3" required></textarea></label><p class="error" role="alert"></p><button type="submit">Send '+(kind==='direct'?'direct':'group')+' message</button></form>':'';
  const list=threads.map(t=>'<li><button type="button" data-chat-thread="'+esc(t.id)+'"'+(t.id===c?.id?' aria-current="true"':'')+'>'+esc(t.label)+' · '+esc(t.kind)+(t.unread?' · '+esc(t.unread)+' unread':'')+'</button></li>').join('');
  const thread=c?'<section class="card"><h2>'+esc(c.label)+'</h2><p>'+esc(c.kind==='group'?'Only active group members can open this conversation.':'Only the two current company participants can open this conversation.')+'</p>'+(c.before?'<button type="button" data-chat-before="'+esc(c.before)+'" data-chat-thread="'+esc(c.id)+'">Older messages</button>':'')+
    '<ol class="records">'+c.messages.map(m=>'<li><p><strong>'+esc(m.senderName)+'</strong> · <time datetime="'+esc(m.sent)+'">'+esc(readableTime(m.sent))+'</time></p><p class="message-text">'+text(m.body)+'</p></li>').join('')+'</ol>'+
    '<form data-chat="reply" data-thread="'+esc(c.id)+'"><label>Reply<textarea name="body" maxlength="4000" rows="3" required></textarea></label><p class="error" role="alert"></p><button type="submit">Send reply</button></form></section>':'';
  return '<section class="card"><h2>Mailbox</h2><p>Internal messages stay on your company server. These are not end-to-end encrypted. Refresh to check for new messages.</p><button type="button" data-chat-refresh>Refresh messages</button>'+(list?'<ul>'+list+'</ul>':'<p>No conversations yet.</p>')+(data.notice?'<p role="status">'+esc(data.notice)+'</p>':'')+'</section>'+thread+
    '<section class="card"><h2>New message</h2>'+(compose('direct',people,'Person')+compose('group',groups,'Group')||'<p>No eligible recipients in this company.</p>')+'</section>';
}
export function groupContent(data){
  if(data?.error)return '<section class="card"><p>'+esc(data.error)+'</p></section>';
  if(!data)return '<section class="card"><p>Loading collaboration groups…</p></section>';
  const fields=g=>'<form data-chat-group="'+esc(g?.id||'')+'"><input type="hidden" name="version" value="'+esc(g?.version||0)+'"><label>Group name<input name="name" value="'+esc(g?.name||'')+'" maxlength="80" required></label><fieldset><legend>Company login accounts</legend>'+
    (data.people.length?data.people.map(p=>'<label><input type="checkbox" name="memberIds" value="'+esc(p.id)+'"'+(g?.memberIds.includes(p.id)?' checked':'')+'> '+esc(p.name)+' · '+esc(p.role)+'</label>').join(''):'<p>No active company accounts.</p>')+
    '</fieldset>'+(g?.memberIds.some(id=>!data.people.some(p=>p.id===id))?'<p>Inactive or unavailable members cannot access the group. Saving removes them from the roster.</p>':'')+'<p class="error" role="alert"></p><button type="submit">'+(g?'Save group membership':'Create group')+'</button></form>';
  return '<section class="card"><h2>Create a company group</h2><p>Members can read chat messages sent after they joined and access shared group items. Removal ends access. Rejoining does not restore earlier messages. Owner access requires membership.</p>'+fields()+'</section>'+
    '<section class="card"><h2>Existing groups</h2>'+(data.groups.map(g=>'<details><summary>'+esc(g.name)+' · '+esc(g.memberIds.length)+' account(s)</summary>'+fields(g)+'</details>').join('')||'<p>No company groups yet.</p>')+'</section>';
}
export function chatForm(form){
  const values=new FormData(form),kind=form.dataset.chat;
  if(Object.hasOwn(form.dataset,'chatGroup'))return {type:'save',id:form.dataset.chatGroup||undefined,version:Number(values.get('version')),name:values.get('name'),memberIds:values.getAll('memberIds')};
  return {type:'send',body:values.get('body'),...(kind==='reply'?{threadId:form.dataset.thread}:{kind,target:values.get('target')})};
}
export async function loadConversation(api,companyId,id,before){
  const path=messagesUrl(companyId);
  try{
    const data=await api(messagesUrl(companyId,{id,before}));
    if(data.conversation&&!before&&data.conversation.messages.length){
      await api(path,{action:{type:'read',threadId:id,through:data.conversation.messages.at(-1).id}});
      return await api(messagesUrl(companyId,{id}));
    }
    return data;
  }catch(err){
    if(!id)throw err;
    const data=await api(path);
    return {...data,notice:err.message};
  }
}
