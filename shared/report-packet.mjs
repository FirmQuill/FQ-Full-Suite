import {accounts,date,dollars,integer,statements,sum} from './core.mjs';

export const sections=Object.freeze({
  balance:'Balance sheet', income:'Income statement', cash:'Cash flow', trial:'Trial balance'
});
export const reportClasses=['Asset','Liability','Equity','Revenue','Expense'];
export function defaultPacket(through=new Date().toISOString().slice(0,10)){
  return {title:'Financial statements packet',from:through.slice(0,4)+'-01-01',through,
    sections:Object.keys(sections),columns:{codes:true,classes:true},trialClass:'all',includeZero:false,detail:true};
}
function text(value,label,max){
  if(typeof value!=='string'||!value.trim()||Array.from(value).length>max||/[\p{Cc}\p{Cf}]/u.test(value))throw Error('Enter a valid '+label+' (up to '+max+' characters).');
  return value.trim();
}
export function validatePacket(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Choose packet settings.');
  const {from,through,sections:ordered,columns,trialClass,includeZero,detail}=value;
  if(from<'0001-01-01'||through<'0001-01-01'||date(from)>date(through))throw Error('Choose a valid range with a start date on or before the end date.');
  if(!Array.isArray(ordered)||!ordered.length||ordered.length>4||new Set(ordered).size!==ordered.length||
    ordered.some(k=>typeof k!=='string'||!Object.hasOwn(sections,k)))throw Error('Choose at least one report section without duplicates.');
  if(!columns||typeof columns.codes!=='boolean'||typeof columns.classes!=='boolean'||typeof includeZero!=='boolean'||typeof detail!=='boolean'||
    !['all',...reportClasses].includes(trialClass))throw Error('Choose valid report columns and filters.');
  return {title:text(value.title,'packet title',120),from,through,sections:[...ordered],columns:{codes:columns.codes,classes:columns.classes},trialClass,includeZero,detail};
}
export const templateName=name=>text(name,'template name',80);
export function buildPacket(company,input,{revision}={}){
  const options=validatePacket(input),{from,through,detail,includeZero,trialClass,columns}=options;
  const s=statements(company.entries,from,through);
  const result={title:options.title,company:company.name,from,through,currency:'USD',revision,
    restricted:company.projectScope==='permitted-records',
    sections:[]};
  const line=(label,value,total=false)=>({label,amounts:[integer(value)],total});
  const headings=['Line','Amount (USD)'];
  const breakdown=(group,map,sign=1)=>detail?Object.entries(accounts)
    .filter(([code,[,category]])=>category===group&&(includeZero||map[code]!==0))
    .map(([code,[name]])=>line((columns.codes?code+' · ':'')+name,map[code]*sign)):[];
  const money=(rows,note='')=>({headers:headings,moneyAt:1,rows,note});
  const diff=sum([s.closingCash,-s.openingCash,...Object.values(s.cashFlow).map(n=>-n)]);
  const definitions={
    balance:()=>money([
      ...breakdown('Asset',s.balances),line('Total assets',s.assets,true),
      ...breakdown('Liability',s.balances,-1),line('Total liabilities',s.liabilities,true),
      ...breakdown('Equity',s.balances,-1),line('Contributed capital',s.capital),
      line('Cumulative earnings',s.earnings),line('Total equity',sum([s.capital,s.earnings]),true),
      line('Total liabilities and equity',sum([s.liabilities,s.capital,s.earnings]),true)
    ],'Balances as of '+through+'.'),
    income:()=>money([
      ...breakdown('Revenue',s.movement,-1),line('Total revenue',s.revenue,true),
      ...breakdown('Expense',s.movement),line('Total expenses',s.expenses,true),
      line('Net income',s.income,true)
    ],'Activity from '+from+' through '+through+'.'),
    cash:()=>money([
      line('Opening operating cash',s.openingCash),...Object.entries(s.cashFlow).map(([k,v])=>line(k,v)),
      ...(diff?[line('Unclassified cash movement',diff)]:[]),line('Closing operating cash',s.closingCash,true)
    ],'Operating cash account 1000 only. '+(diff?'Some posted cash activity lacks a cash-flow classification; verify before sharing.':'')),
    trial:()=>{
      const prefix=[...(columns.codes?['Account code']:[]),'Account',...(columns.classes?['Class']:[])];
      const totals=[0,0],rows=[];
      const groups=columns.classes?reportClasses:['all'];
      for(const group of groups)for(const [code,[label,klass]] of Object.entries(accounts)){
        if((group!=='all'&&group!==klass)||(trialClass!=='all'&&trialClass!==klass))continue;
        const n=s.balances[code];if(!includeZero&&!n)continue;
        const amounts=[Math.max(0,n),Math.max(0,-n)];
        totals[0]=sum([totals[0],amounts[0]]);totals[1]=sum([totals[1],amounts[1]]);
        rows.push({label,fields:[...(columns.codes?[code]:[]),label,...(columns.classes?[klass]:[])],amounts});
      }
      rows.push({label:'Totals',fields:[...(columns.codes?['']:[]),'Totals',...(columns.classes?['']:[])],amounts:totals,total:true});
      return {headers:[...prefix,'Debit (USD)','Credit (USD)'],moneyAt:prefix.length,rows,
        note:'Balances as of '+through+'. '+(trialClass==='all'?'Debit less credit: '+dollars(s.trialDifference)+'.':'Filtered to '+trialClass+' accounts. Totals are for this subset, not a full trial balance.')};
    }
  };
  result.sections=options.sections.map(kind=>({kind,label:sections[kind],...definitions[kind]()}));
  return result;
}
export function packetRow(row){return [...(row.fields||[row.label]),...row.amounts.map(dollars)];}
const csvAmount=n=>{const v=BigInt(integer(n)),abs=v<0n?-v:v;return (v<0n?'-':'')+String(abs/100n)+'.'+String(abs%100n).padStart(2,'0');};
const csvText=value=>{
  const s=String(value??'');
  const safe=/^[\s\ufeff]*[=+\-@]|^[\t\r\n]/u.test(s)?"'"+s:s;
  return '"'+safe.replaceAll('"','""')+'"';
};
// Fixed schema. Use integer-cents ledger outputs to generate decimal strings;
// protecting only untrusted textual columns leaves real negative amounts numeric.
export function packetCsv(packet){
  const rows=[['packet_title','company','from','through','currency','scope','section','line','account_code','account_class','amount_usd','debit_usd','credit_usd','section_note'].map(csvText).join(',')];
  for(const section of packet.sections)for(const row of section.rows){
    const accountCode=row.fields&&section.headers[0]==='Account code'?row.fields[0]:'';
    const classIndex=section.headers.indexOf('Class');
    const prefix=[packet.title,packet.company,packet.from,packet.through,packet.currency,packet.restricted?'permitted records only':'company',section.label,row.label,accountCode,classIndex>=0?row.fields?.[classIndex]:''];
    rows.push(prefix.map(csvText).join(',')+','+(section.kind==='trial'?','+row.amounts.map(csvAmount).join(','):csvAmount(row.amounts[0])+',,')+','+csvText(section.note));
  }
  return rows.join('\r\n')+'\r\n';
}
