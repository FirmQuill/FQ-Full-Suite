// Maintainer-only; run "npm ci" in vendor first. Full Suite users use prebuilt bundles and never need this.
import {build} from 'esbuild';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const vendor=fileURLToPath(new URL('./',import.meta.url)),top=resolve(vendor,'..');
const jobs=[
 ['server','node','node24',join(vendor,'simplewebauthn-server.mjs'),"export {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';\nexport {decodeAttestationObject,decodeClientDataJSON} from '@simplewebauthn/server/helpers';"],
 ['browser','browser','es2022',join(top,'shared/passkey-browser.mjs'),"export {browserSupportsWebAuthn,startRegistration,startAuthentication} from '@simplewebauthn/browser';"]
];
const directories=new Set();
for(const [label,platform,target,outfile,contents] of jobs){
 const out=await build({stdin:{contents,resolveDir:vendor,sourcefile:label+'.mjs'},absWorkingDir:vendor,bundle:true,format:'esm',platform,target,minify:true,legalComments:'none',metafile:true,outfile,
 ...(label==='server'?{banner:{js:"import {createRequire as fqCreateRequire} from 'node:module'; const require = fqCreateRequire(import.meta.url);"}}:{})});
 for(const meta of Object.values(out.metafile.outputs))for(const f of Object.keys(meta.inputs)){
   if(!f.startsWith('node_modules/'))continue;
   let dir=dirname(resolve(vendor,f));
   while(relative(vendor,dir)&&dir!==join(vendor,'node_modules')){
     const json=await readFile(join(dir,'package.json'),'utf8').then(JSON.parse,()=>null);
     if(json?.version){directories.add(dir);break;}
     dir=dirname(dir);
   }
 }
}
const notices=['# WebAuthn runtime dependencies','Built from pin-locked NPM packages. Build-time esbuild is not distributed as runtime code.',''];
for(const dir of [...directories].sort()){
 const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
 const files=(await readdir(dir)).filter(x=>/^(LICENSE|NOTICE)/i.test(x)).sort();
 if(!files.some(x=>/^LICENSE/i.test(x)))throw Error('Missing license for '+pkg.name);
 notices.push('### '+pkg.name+' '+pkg.version+' ('+pkg.license+')','',...(await Promise.all(files.map(f=>readFile(join(dir,f),'utf8')))),'');
}
await writeFile(join(vendor,'PASSKEY-LICENSES.txt'),notices.join('\n').replace(/[ \t]+$/gm,'').trimEnd()+'\n');
