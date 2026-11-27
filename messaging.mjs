import {randomUUID} from 'node:crypto';
import {activeCollaborationUser,activeGroupMember,companyGroups,collaborationDirectory,groupMessageWindows} from './collaboration-groups.mjs';
import {requireArea,requireWorkerFeature} from './access.mjs';
import {requireThat} from './store.mjs';

export function initializeMessaging(db){
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_threads(
    id TEXT PRIMARY KEY, company TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
    scope_a TEXT NOT NULL,scope_b TEXT NOT NULL,updated TEXT NOT NULL,
    UNIQUE(company,kind,scope_a,scope_b)
  );
  CREATE INDEX IF NOT EXISTS collaboration_threads_mail ON collaboration_threads(company,updated);
  CREATE TABLE IF NOT EXISTS collaboration_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,thread TEXT NOT NULL REFERENCES collaboration_threads(id),sender TEXT NOT NULL,body TEXT NOT NULL,sent TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS collaboration_messages_thread ON collaboration_messages(thread,id);
  CREATE INDEX IF NOT EXISTS collaboration_messages_sender ON collaboration_messages(sender);
  CREATE TABLE IF NOT EXISTS collaboration_reads(
    thread TEXT NOT NULL REFERENCES collaboration_threads(id),account TEXT NOT NULL REFERENCES accounts(id),
    last_read INTEGER NOT NULL,PRIMARY KEY(thread,account)
  );`);
}
function requireMessaging(db,user,scope){
  if(user.role==='worker')requireWorkerFeature(db,user,'Messages');
  else requireArea(db,user,'Messages');
  requireThat(activeCollaborationUser(db,{...scope,userId:user.id}),403,'Company messaging access required.');
}
function accessContext(db,user,scope){
  requireMessaging(db,user,scope);
  const groups=companyGroups(db,{...scope,userId:user.id}),people=collaborationDirectory(db,{...scope,forMessaging:true}).filter(p=>p.id!==user.id);
  return {groups,people,groupFloors:new Map(groupMessageWindows(db,{...scope,userId:user.id}).map(g=>[g.id,g.start_after])),groupNames:new Map(groups.map(g=>[g.id,g.name])),personNames:new Map(people.map(p=>[p.id,p.name]))};
}
export function latestMessageId(db){return db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='collaboration_messages'),0) AS value").get().value;}
const floorFor=(ctx,t)=>t.kind==='group'?ctx.groupFloors.get(t.scope_a):0;
function threadLabel(ctx,user,t){
  if(!t)return;
  if(t.kind==='group')return ctx.groupNames.get(t.scope_a);
  if(t.scope_a===user.id)return ctx.personNames.get(t.scope_b);
  if(t.scope_b===user.id)return ctx.personNames.get(t.scope_a);
}
export function messagingView(db,user,scope,{threadId,before}={}){
  const ctx=accessContext(db,user,scope),company=scope.companyId;
  const saved=db.prepare('SELECT * FROM collaboration_threads WHERE company=? AND id=?');
  const unread=db.prepare('SELECT COUNT(*) AS count FROM collaboration_messages WHERE thread=? AND sender<>? AND id>MAX(COALESCE((SELECT last_read FROM collaboration_reads WHERE thread=? AND account=?),0),?)');
  const threads=db.prepare(`SELECT t.* FROM collaboration_threads t
    WHERE company=? AND ((kind='direct' AND (scope_a=? OR scope_b=?))
      OR (kind='group' AND EXISTS(SELECT 1 FROM collaboration_group_members m JOIN collaboration_messages msg ON msg.thread=t.id AND msg.id>m.start_after WHERE m.group_id=t.scope_a AND m.account_id=?)))
    ORDER BY updated DESC,id`).all(company,user.id,user.id,user.id).flatMap(t=>{
    const label=threadLabel(ctx,user,t);
    return label?[{id:t.id,kind:t.kind,label,updated:t.updated,unread:unread.get(t.id,user.id,t.id,user.id,floorFor(ctx,t)).count}]:[];
  });
  const mailbox={people:ctx.people,groups:ctx.groups,threads};
  if(!threadId)return mailbox;
  const thread=saved.get(company,threadId),label=threadLabel(ctx,user,thread);
  requireThat(label,404,'Conversation unavailable.');
  const until=before==null?Number.MAX_SAFE_INTEGER:Number(before);
  requireThat(Number.isSafeInteger(until)&&until>0,400,'Invalid message page.');
  const messages=db.prepare('SELECT m.id,m.sender,COALESCE(a.name,\'Former account\') AS senderName,m.body,m.sent FROM collaboration_messages m LEFT JOIN accounts a ON a.id=m.sender WHERE m.thread=? AND m.id>? AND m.id<? ORDER BY m.id DESC LIMIT 51').all(thread.id,floorFor(ctx,thread),until);
  const older=messages.length>50;messages.length=Math.min(messages.length,50);messages.reverse();
  return {...mailbox,conversation:{id:thread.id,kind:thread.kind,label,messages,before:older?messages[0].id:null}};
}
function messageBody(body){
  requireThat(typeof body==='string'&&body.trim()&&body.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body),400,'Enter a plain-text message of 1–4,000 characters.');
  return body.trim();
}
export function messagingCommand(db,user,scope,action){
  const ctx=accessContext(db,user,scope),company=scope.companyId;
  const saved=db.prepare('SELECT * FROM collaboration_threads WHERE company=? AND id=?');
  const last=db.prepare('SELECT COALESCE(MAX(id),0) id FROM collaboration_messages WHERE thread=?');
  const mark=db.prepare(`INSERT INTO collaboration_reads(thread,account,last_read) VALUES(?,?,?)
    ON CONFLICT(thread,account) DO UPDATE SET last_read=MAX(last_read,excluded.last_read)`);
  if(action?.type==='read'){
    const t=saved.get(company,typeof action.threadId==='string'?action.threadId:'');
    requireThat(threadLabel(ctx,user,t),404,'Conversation unavailable.');
    requireThat(Number.isSafeInteger(action.through)&&action.through>floorFor(ctx,t)&&action.through<=last.get(t.id).id,400,'Invalid message marker.');
    mark.run(t.id,user.id,action.through);
    return {id:t.id};
  }
  requireThat(action?.type==='send',400,'Choose a message action.');
  const body=messageBody(action.body),now=new Date().toISOString();
  let t;
  if(action.threadId){
    t=saved.get(company,typeof action.threadId==='string'?action.threadId:'');
    requireThat(threadLabel(ctx,user,t),404,'Conversation unavailable.');
  }else{
    const target=action.target,kind=action.kind;
    requireThat(typeof target==='string'&&(kind==='direct'&&ctx.personNames.has(target)||kind==='group'&&activeGroupMember(db,{...scope,groupId:target,userId:user.id})),404,'Recipient unavailable.');
    const [a,b]=kind==='direct'?[user.id,target].sort():[target,''];
    db.prepare('INSERT OR IGNORE INTO collaboration_threads(id,company,kind,scope_a,scope_b,updated) VALUES(?,?,?,?,?,?)').run(randomUUID(),company,kind,a,b,now);
    t=db.prepare('SELECT * FROM collaboration_threads WHERE company=? AND kind=? AND scope_a=? AND scope_b=?').get(company,kind,a,b);
  }
  db.prepare('INSERT INTO collaboration_messages(thread,sender,body,sent) VALUES(?,?,?,?)').run(t.id,user.id,body,now);
  db.prepare('UPDATE collaboration_threads SET updated=? WHERE id=?').run(now,t.id);
  return {id:t.id};
}
