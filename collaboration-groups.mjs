import {randomUUID} from 'node:crypto';
import {employeeProfile} from './records.mjs';
import {accountAreas,workerFeatures} from './access.mjs';
import {readBooks,requireThat,audit} from './store.mjs';

const inactive=new Set(['inactive','disabled','deactivated','terminated']);
export function initializeCollaborationGroups(db){
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_groups(
    id TEXT PRIMARY KEY, company TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
    version INTEGER NOT NULL DEFAULT 1, UNIQUE(company,name)
  );
  CREATE TABLE IF NOT EXISTS collaboration_group_members(
    group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    start_after INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(group_id,account_id)
  );
  CREATE INDEX IF NOT EXISTS collaboration_group_members_account ON collaboration_group_members(account_id,group_id);
  CREATE TABLE IF NOT EXISTS collaboration_membership_history(account_id TEXT PRIMARY KEY REFERENCES accounts(id));`);
}
function accountIsActive(db,state,company,account){
  if(!account?.active)return false;
  const assigned=JSON.parse(account.assignments);
  if(account.role!=='owner'&&!assigned.includes(company?.id))return false;
  if(!account.employeeId)return account.role!=='worker';
  if(assigned.length!==1||assigned[0]!==company?.id||!company.employees.some(e=>e.id===account.employeeId))return false;
  if(inactive.has(employeeProfile(db,state,company.id,account.employeeId).employmentStatus))return false;
  if(account.role==='worker')return true;
  return !!db.prepare('SELECT enabled FROM employee_erp_flags WHERE company=? AND employee=?').get(company.id,account.employeeId)?.enabled;
}
export function activeCollaborationUser(db,{companyId,userId,state=readBooks(db).state}){
  const company=state.companies.find(c=>c.id===companyId);
  return !!company&&accountIsActive(db,state,company,db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(userId));
}
export function activeGroupMember(db,{companyId,groupId,userId,state=readBooks(db).state}){
  return activeCollaborationUser(db,{companyId,userId,state})&&!!db.prepare('SELECT 1 FROM collaboration_group_members m JOIN collaboration_groups g ON g.id=m.group_id WHERE g.company=? AND g.id=? AND m.account_id=?').get(companyId,groupId,userId);
}
export function companyGroups(db,{companyId,userId,state=readBooks(db).state}){
  if(!activeCollaborationUser(db,{companyId,userId,state}))return [];
  return db.prepare('SELECT g.id,g.name FROM collaboration_groups g JOIN collaboration_group_members m ON g.id=m.group_id WHERE g.company=? AND m.account_id=? ORDER BY g.name,g.id').all(companyId,userId);
}
export function groupMessageWindows(db,{companyId,userId}){
  return db.prepare('SELECT g.id,m.start_after FROM collaboration_groups g JOIN collaboration_group_members m ON g.id=m.group_id WHERE g.company=? AND m.account_id=?').all(companyId,userId);
}
export function collaborationDirectory(db,{companyId,state=readBooks(db).state,forMessaging=false}){
  const company=state.companies.find(c=>c.id===companyId);
  if(!company)return [];
  return db.prepare('SELECT id,name,role,assignments,employeeId,active FROM accounts WHERE active=1 ORDER BY name,id').all().filter(a=>
    accountIsActive(db,state,company,a)&&(!forMessaging||(a.role==='worker'?workerFeatures(db,{...a,assignments:[companyId]}):accountAreas(db,a)).includes('Messages'))
  ).map(({id,name,role})=>({id,name,role}));
}
export function groupAdminView(db,user,{companyId,state}){
  requireThat(user.role==='owner'&&activeCollaborationUser(db,{companyId,userId:user.id,state}),403,'Company owner access required.');
  const members=db.prepare('SELECT account_id FROM collaboration_group_members WHERE group_id=? ORDER BY account_id');
  return {
    groups:db.prepare('SELECT id,name,version FROM collaboration_groups WHERE company=? ORDER BY name,id').all(companyId).map(g=>({...g,memberIds:members.all(g.id).map(r=>r.account_id)})),
    people:collaborationDirectory(db,{companyId,state})
  };
}
export function groupAdminCommand(db,user,{companyId,state},action,{latestMessageId=0}={}){
  groupAdminView(db,user,{companyId,state});
  requireThat(action?.type==='save',400,'Choose a group action.');
  const id=action.id||randomUUID(),name=typeof action.name==='string'?action.name.trim():'',members=action.memberIds;
  requireThat(name&&name.length<=80&&!/[\u0000-\u001f\u007f]/.test(name),400,'Enter a group name of 1–80 characters.');
  requireThat(Array.isArray(members)&&members.length<=250&&new Set(members).size===members.length&&members.every(userId=>typeof userId==='string'&&activeCollaborationUser(db,{companyId,userId,state})),400,'Choose up to 250 distinct active company accounts.');
  requireThat(!db.prepare('SELECT 1 FROM collaboration_groups WHERE company=? AND name=? AND id<>?').get(companyId,name,id),400,'This company already has a group with that name.');
  if(action.id){
    const old=db.prepare('SELECT version FROM collaboration_groups WHERE company=? AND id=?').get(companyId,id);
    requireThat(old,404,'Company group unavailable.');
    requireThat(old.version===action.version,409,'The group changed. Reload and review current membership.');
    db.prepare('UPDATE collaboration_groups SET name=?,version=version+1 WHERE company=? AND id=?').run(name,companyId,id);
  }else{
    db.prepare('INSERT INTO collaboration_groups(id,company,name) VALUES(?,?,?)').run(id,companyId,name);
  }
  const previous=db.prepare('SELECT account_id FROM collaboration_group_members WHERE group_id=?').all(id);
  const allowed=new Set(members);
  for(const row of previous)if(!allowed.has(row.account_id))db.prepare('DELETE FROM collaboration_group_members WHERE group_id=? AND account_id=?').run(id,row.account_id);
  const insert=db.prepare('INSERT OR IGNORE INTO collaboration_group_members(group_id,account_id,start_after) VALUES(?,?,?)');
  const remember=db.prepare('INSERT OR IGNORE INTO collaboration_membership_history(account_id) VALUES(?)');
  for(const member of members){insert.run(id,member,latestMessageId);remember.run(member);}
  audit(db,user,companyId,action.id?'collaboration group updated':'collaboration group created',id);
  return groupAdminView(db,user,{companyId,state});
}
