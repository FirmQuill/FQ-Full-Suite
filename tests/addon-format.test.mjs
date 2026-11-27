import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {inspectAddon,validateAddonSettings} from '../addon-installer.mjs';
import {addonHttps} from '../addon-network-broker.mjs';
const key=generateKeyPairSync('ed25519'),id='a'.repeat(64),sum=b=>createHash('sha256').update(b).digest('hex');
const manifest=(fields={})=>({format:'firmquill.addon.v1',id:'any-new-feature',name:'Fictional new feature',revision:1,installationId:id,compatibility:{min:'0.6.5',max:'0.6.9',hostApi:1},type:'settings',permissions:['settings'],network:[],settings:[{key:'label',label:'Label',type:'string',default:'Fictional',maxLength:80}],files:{},...fields});
function envelope(p,k=key.privateKey){const b=Buffer.from(JSON.stringify(p));return Buffer.from(JSON.stringify({signed:b.toString('base64url'),signature:sign(null,b,k).toString('base64url')}));}
const inspect=p=>inspectAddon(envelope(p),key.publicKey,{installationId:id});
test('versioned feature-agnostic manifest verifies signature, installation and compatibility without feature registry changes',()=>{
 for(const feature of ['any-new-feature','another-addon','payroll-rule-template','full-suite-knowledge-base','ai-connection'])assert.equal(inspect(manifest({id:feature})).manifest.id,feature);
 const file=Buffer.from('export async function activate(){return {health:()=>true,handle:x=>x}}');const p=manifest({id:'fictional-node-runtime',type:'service',permissions:['settings','service.runtime','workspace.read','workspace.write','workspace.write.auto','network.https'],network:['https://api.fictional-addon.example.com'],files:{'service.mjs':{content:file.toString('base64url'),sha256:sum(file)}}});
 assert.equal(inspect(p).files['service.mjs'].toString(),file.toString());
 for(const change of [{format:'unknown'},{id:null},{id:'../escape'},{installationId:'b'.repeat(64)},{compatibility:{min:'0.7.0',max:'0.7.1',hostApi:1}},{compatibility:{min:'0.6.5',max:'0.6.5',hostApi:2}},{permissions:['settings','shell']},{permissions:['settings','workspace.write.auto']},{network:['http://localhost']}])assert.throws(()=>inspect(manifest(change)));
 const foreign=generateKeyPairSync('ed25519');assert.throws(()=>inspectAddon(envelope(p,foreign.privateKey),key.publicKey,{installationId:id}),/signature/);
 for(const name of ['../service.mjs','run.cmd','native.node','C:\\escape.mjs'])assert.throws(()=>inspect({...p,files:{...p.files,[name]:p.files['service.mjs']}}));
 assert.throws(()=>inspect({...p,files:{'service.mjs':{...p.files['service.mjs'],sha256:'0'.repeat(64)}}}),/integrity/);
});
test('signed settings use bounded typed values and reject poison keys, coercion and additional values',()=>{
 const p=inspect(manifest()).manifest;assert.equal(validateAddonSettings(p.settings,{label:'Owner value'}).label,'Owner value');
 for(const values of [{label:5},{label:'x'.repeat(81)},{label:'Okay',extra:true},[]])assert.throws(()=>validateAddonSettings(p.settings,values));
 for(const k of [null,'__proto__','constructor','a/b'])assert.throws(()=>inspect(manifest({settings:[{key:k,label:'Bad',type:'boolean',default:false}]})));
});
test('brokered AI HTTPS checks approved origins, methods, headers and bounds before using trusted transport',async()=>{
 const url='https://api.fictional-addon.example.com/v1/reply';let calls=0;
 const transport=async value=>{calls++;assert.equal(value.method,'POST');assert.equal(value.body,'{"prompt":"FICTIONAL"}');return {status:200,body:'{"reply":"fictional"}'};};
 assert.equal((await addonHttps({url,body:{prompt:'FICTIONAL'}},[new URL(url).origin],{transport})).status,200);assert.equal(calls,1);
 for(const value of [{url:'https://evil.example.com'},{url:'http://api.fictional-addon.example.com'},{url:'https://user:secret@api.fictional-addon.example.com'},{url,method:'CONNECT'},{url,headers:{cookie:'private'}},{url,headers:{authorization:'bad\r\nvalue'}},{url,body:'x'.repeat(1024*1024+1)}])await assert.rejects(()=>addonHttps(value,[new URL(url).origin],{transport}));
 assert.equal(calls,1,'Rejected requests never reach the network transport.');
});
