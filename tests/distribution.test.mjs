import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildPublicRelease,validatePublicDocumentation} from '../scripts/build-public-release.mjs';
test('public runtime build has setup-only help and verified hashes, without private manuals, indexes, fixtures or company data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fq-public-build-'));try{
    const destination=join(dir,'public'),report=await buildPublicRelease(destination);assert.equal(report.documentation.scope,'public-setup-only');assert.equal(report.documentation.screenshots,12);
    const root=await readdir(destination);assert.ok(!root.includes('docs'));assert.ok(!root.includes('tests'));assert.ok(!root.includes('EMPLOYEE-SETUP.md'));assert.ok(!root.includes('AGENT-API.md'));assert.ok(!root.some(n=>/sqlite|fqsetup|private|customer-manual/i.test(n)));
    const index=JSON.parse(await readFile(join(destination,'kb/index.json'),'utf8'));assert.ok(index.articles.every(a=>/setup|install|first-admin|initialize/.test(a.id)));
    for(const line of (await readFile(join(destination,'SHA256SUMS.txt'),'utf8')).trim().split('\n')){const [hash,name]=line.split('  ');assert.equal(createHash('sha256').update(await readFile(join(destination,name))).digest('hex'),hash,name);}
    const source=join(dir,'source');await cp(new URL('../kb/',import.meta.url),join(source,'kb'),{recursive:true});await writeFile(join(source,'kb/private-customer-manual.json'),'PRIVATE CANARY');await assert.rejects(validatePublicDocumentation(source),/Unapproved documentation/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('public asset allowlist rejects company packages and databases placed under runtime trees',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fq-public-private-canary-')),source=join(dir,'source');
  try{
    for(const directory of ['kb','web','shared'])await cp(new URL('../'+directory+'/',import.meta.url),join(source,directory),{recursive:true});
    const privatePackage=join(source,'web','company.fqsetup.json');await writeFile(privatePackage,'FICTIONAL PRIVATE PACKAGE CANARY');
    await assert.rejects(()=>buildPublicRelease(join(dir,'rejected-package'),{root:source}),/Unapproved runtime asset/);await rm(privatePackage);
    await writeFile(join(source,'shared','company.sqlite'),'FICTIONAL PRIVATE DATABASE CANARY');
    await assert.rejects(()=>buildPublicRelease(join(dir,'rejected-database'),{root:source}),/Unapproved runtime asset/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
