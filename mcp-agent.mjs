import {pathToFileURL} from 'node:url';

export const MCP_PROTOCOL_VERSION='2025-11-25';
const string={type:'string'};
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const TOOLS=[
  {name:'firmquill_capabilities',description:'Show the current grant and supported proposed changes.',inputSchema:schema({},[]),annotations:{readOnlyHint:true}},
  {name:'firmquill_read_records',description:'Read a page of explicitly granted business records from one company.',inputSchema:schema({companyId:string,recordType:{enum:['contacts','items','invoices','bills']},limit:{type:'integer',minimum:1,maximum:100},cursor:string},['companyId','recordType']),annotations:{readOnlyHint:true}},
  {name:'firmquill_propose_record',description:'Propose a new contact or item for an owner to review in FirmQuill. Does not change company books.',inputSchema:schema({companyId:string,revision:{type:'integer',minimum:0},requestId:string,action:schema({type:{enum:['contact','item']},name:string,kind:{enum:['Customer','Vendor','Product','Service']},date:string},['type','name','kind','date'])},['companyId','revision','requestId','action']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'firmquill_proposal_status',description:'Read the status of a proposal made using this grant.',inputSchema:schema({id:string},['id']),annotations:{readOnlyHint:true}}
];
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
export function createMcpHandler({requestApi}){
  let negotiated=false,ready=false;
  return async function handle(message){
    const valid=message&&typeof message==='object'&&!Array.isArray(message)&&message.jsonrpc==='2.0'&&typeof message.method==='string';
    if(!valid)return rpcError(null,-32600,'Invalid JSON-RPC request.');
    const notification=!Object.hasOwn(message,'id'),id=message.id;
    if(!notification&&!(typeof id==='string'||Number.isSafeInteger(id)))return rpcError(null,-32600,'Invalid request ID.');
    if(notification){if(message.method==='notifications/initialized'&&negotiated)ready=true;return null;}
    if(message.method==='ping')return {jsonrpc:'2.0',id,result:{}};
    if(message.method==='initialize'){
      if(negotiated)return rpcError(id,-32600,'Already initialized.');
      const p=message.params;
      if(!p||p.protocolVersion!==MCP_PROTOCOL_VERSION)return rpcError(id,-32602,'Supported protocol version: '+MCP_PROTOCOL_VERSION+'.');
      if(!p.clientInfo||typeof p.clientInfo.name!=='string'||typeof p.clientInfo.version!=='string'||!p.capabilities||typeof p.capabilities!=='object')return rpcError(id,-32602,'Invalid initialization parameters.');
      negotiated=true;
      return {jsonrpc:'2.0',id,result:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{tools:{}},serverInfo:{name:'FirmQuill agent adapter',version:'1.0.0'}}};
    }
    if(!ready)return rpcError(id,-32000,'Initialize and send notifications/initialized first.');
    if(message.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:TOOLS}};
    if(message.method!=='tools/call')return rpcError(id,-32601,'Method unavailable.');
    const p=message.params,tool=TOOLS.find(t=>t.name===p?.name),args=p?.arguments??{};
    if(!tool)return rpcError(id,-32602,'Unknown tool.');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k))||tool.inputSchema.required.some(k=>!Object.hasOwn(args,k)))return rpcError(id,-32602,'Invalid tool arguments.');
    try{
      let result;
      if(tool.name==='firmquill_capabilities')result=await requestApi('GET','capabilities');
      if(tool.name==='firmquill_read_records')result=await requestApi('GET','records?'+new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)])));
      if(tool.name==='firmquill_propose_record')result=await requestApi('POST','proposals',args);
      if(tool.name==='firmquill_proposal_status')result=await requestApi('GET','proposal?'+new URLSearchParams({id:args.id}));
      return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};
    }catch{return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'FirmQuill rejected or could not complete this request. Check the grant, company, revision, and local host.'}]}};}
  };
}

async function main(){
  const base=new URL(process.env.FIRMQUILL_AGENT_URL||'http://127.0.0.1:4179');
  const token=process.env.FIRMQUILL_AGENT_TOKEN;
  if(!/^fqag_[A-Za-z0-9_-]{43}$/.test(token||'')||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(base.hostname))))throw Error('Agent adapter configuration is invalid.');
  const handle=createMcpHandler({requestApi:async(method,path,body)=>{
    const response=await fetch(new URL('/api/agents/v1/'+path,base),{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok)throw Error('FirmQuill request failed.');
    let bytes=0;const chunks=[];
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>256*1024)throw Error('Response exceeds limit.');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }});
  const write=message=>{if(message)process.stdout.write(JSON.stringify(message)+'\n');};
  let pending='';
  process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){
    pending+=chunk;
    let newline;
    while((newline=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;
      if(Buffer.byteLength(line)>64*1024){write(rpcError(null,-32600,'Message exceeds 64 KiB.'));return;}
      let message;try{message=JSON.parse(line);}catch{write(rpcError(null,-32700,'Invalid JSON.'));continue;}
      write(await handle(message));
    }
    if(Buffer.byteLength(pending)>64*1024){write(rpcError(null,-32600,'Message exceeds 64 KiB.'));return;}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('FirmQuill agent adapter could not start. Check its environment configuration.\n');process.exitCode=1;});
