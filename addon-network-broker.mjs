// HTTPS egress stays in the trusted parent. Pin public DNS results per request;
// the LPAC runtime has no direct network capability and never receives host sessions.
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList} from 'node:net';
const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['::ffff:0:0',96]])blocked.addSubnet(ip,bits,'ipv6');
export async function addonHttps(input,origins,{transport}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['url','method','headers','body'].includes(k)))throw Error('Invalid HTTPS request.');
 const url=new URL(input.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||!origins.includes(url.origin))throw Error('HTTPS destination is outside the approved package permissions.');
 const method=input.method||'POST';if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw Error('Unsupported HTTPS method.');
 const headers=Object.create(null);if(input.headers){if(typeof input.headers!=='object'||Array.isArray(input.headers)||Object.keys(input.headers).length>16)throw Error('Invalid HTTPS headers.');for(const [k,v] of Object.entries(input.headers)){if(!/^(?:authorization|content-type|accept|anthropic-version|openai-beta|x-api-key)$/i.test(k)||typeof v!=='string'||v.length>4096||/[\r\n]/.test(v))throw Error('Unsupported HTTPS header.');headers[k.toLowerCase()]=v;}}
 const body=input.body===undefined?'':typeof input.body==='string'?input.body:JSON.stringify(input.body);if(Buffer.byteLength(body)>1024*1024||method==='GET'&&body)throw Error('HTTPS body exceeds the supported contract.');
 const checked={url:url.href,method,headers,body};if(transport)return transport(checked);
 const addresses=await lookup(url.hostname,{all:true,verbatim:true});if(!addresses.length||addresses.some(a=>blocked.check(a.address,a.family===4?'ipv4':'ipv6')))throw Error('HTTPS destination must resolve only to public addresses.');
 const address=addresses[0];
 return new Promise((resolve,reject)=>{
  const req=request(url,{method,headers,timeout:45000,lookup:(hostname,options,callback)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)},res=>{
   if(res.statusCode>=300&&res.statusCode<400){res.destroy();reject(Error('HTTPS redirects are not followed.'));return;}let size=0;const parts=[];
   res.on('data',p=>{size+=p.length;if(size>1024*1024)res.destroy(Error('HTTPS response exceeds limit.'));else parts.push(p);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:{'content-type':String(res.headers['content-type']||'')},body:Buffer.concat(parts).toString('utf8')}));
  });req.once('timeout',()=>req.destroy(Error('HTTPS provider timed out.')));req.once('error',reject);req.end(body);
 });
}
