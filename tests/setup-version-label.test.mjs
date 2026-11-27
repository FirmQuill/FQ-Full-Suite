import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSetupWizard} from '../setup-wizard.mjs';
import {INSTALLED_VERSION} from '../support.mjs';
test('first-launch page displays the installed release version',async()=>{
 const d=await mkdtemp(join(tmpdir(),'fq-version-'));
 let wizard;try{
  wizard=await createSetupWizard({destination:join(d,'workspace.sqlite')});
  const r=await fetch(wizard.origin);assert.equal(r.status,200);
  const body=await r.text();assert(body.includes('FIRMQUILL · FULL SUITE '+INSTALLED_VERSION));assert(!body.includes('__FQ_INSTALLED_VERSION__'));
 }finally{await wizard?.close();await rm(d,{recursive:true,force:true});}
});
