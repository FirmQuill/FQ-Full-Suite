import {randomUUID} from 'node:crypto';
import {defaultPacket,validatePacket,templateName,buildPacket} from './shared/report-packet.mjs';
import {requireArea} from './access.mjs';
import {readBooks,requireThat,scoped,tx} from './store.mjs';

export function initializeReportPackets(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_packet_templates(
      id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), company TEXT NOT NULL,
      name TEXT NOT NULL, options TEXT NOT NULL, version INTEGER NOT NULL,
      UNIQUE(account,company,name)
    );
  `);
}
export function reportPackets(db,user,companyId,input){
  requireThat(user.role!=='worker',403,'Reports access required.');
  requireArea(db,user,'Reports');
  const {state,revision}=readBooks(db),company=scoped(user,state,db).companies.find(c=>c.id===companyId);
  requireThat(company,404,'Company unavailable.');
  const list=()=>db.prepare('SELECT id,name,version,options FROM report_packet_templates WHERE account=? AND company=? ORDER BY name,id')
    .all(user.id,company.id).map(r=>({id:r.id,name:r.name,version:r.version,options:JSON.parse(r.options)}));
  const out=()=>({defaultOptions:defaultPacket(),templates:list()});
  if(!input)return out();
  if(input.type==='preview'){
    const original=state.companies.find(c=>c.id===companyId);
    const reportCompany=company.entries.length!==original.entries.length?{...company,projectScope:'permitted-records'}:company;
    return {...out(),packet:buildPacket(reportCompany,input.options,{revision})};
  }
  return tx(db,()=>{
    const existing=typeof input.id==='string'&&db.prepare('SELECT id,version FROM report_packet_templates WHERE account=? AND company=? AND id=?')
      .get(user.id,company.id,input.id);
    if(input.id)requireThat(existing,404,'Template unavailable.');
    if(existing)requireThat(input.version===existing.version,409,'Template changed. Reload and review it before saving.');
    if(input.type==='delete'){
      requireThat(existing,404,'Template unavailable.');
      db.prepare('DELETE FROM report_packet_templates WHERE id=? AND account=? AND company=?').run(existing.id,user.id,company.id);
      return out();
    }
    requireThat(input.type==='save',400,'Choose a packet template action.');
    const name=templateName(input.name),options=JSON.stringify(validatePacket(input.options));
    requireThat(!db.prepare('SELECT 1 FROM report_packet_templates WHERE account=? AND company=? AND name=? AND id<>?')
      .get(user.id,company.id,name,existing?.id||''),409,'A template with this name already exists.');
    requireThat(existing||list().length<30,400,'Delete an existing template before saving another (30 per company).');
    const id=existing?.id||randomUUID();
    db.prepare(`INSERT INTO report_packet_templates(id,account,company,name,options,version) VALUES(?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,options=excluded.options,version=report_packet_templates.version+1`)
      .run(id,user.id,company.id,name,options);
    return {...out(),templateId:id};
  });
}
