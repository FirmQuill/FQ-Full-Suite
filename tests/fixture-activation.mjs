// Local test-only issuer. Ephemeral keys never leave the individual test process.
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModuleActivation,edition} from '../module-activation.mjs';
export async function activationFixture(folder,{clock=Date.now,activate=[]}={}){
  const directory=join(folder,'fictional-activation');await mkdir(directory,{mode:0o700});
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),verifierPath=join(folder,'fictional-verifier.pem');
  await writeFile(verifierPath,publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const options={directory,verifierPath,clock};
  const activator=await createModuleActivation(options),id=activator.status().installationId;
  const mint=(fields={})=>{
    const bytes=Buffer.from(JSON.stringify({format:'firmquill.activation.v1',edition,installationId:id,modules:['manual-payroll'],...fields}));
    return bytes.toString('base64url')+'.'+sign(null,bytes,privateKey).toString('base64url');
  };
  if(activate.length)await activator.activate(mint({modules:activate}),()=>{});
  return {options,id,mint};
}
