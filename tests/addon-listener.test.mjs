import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createAddonListeners} from '../addon-listener.mjs';

test('dedicated socket requires explicit start, validates its authority and restores only its configuration',async t=>{
  const db=new DatabaseSync(':memory:');
  const id='fictional-addon', owner={id:'owner'}, service={};
  let eligible=true;
  const addons={
    listenerService(packageId,actor){return eligible&&packageId===id&&(!actor||actor===owner)?service:null;},
    listenerRoute(packageId,path,runtime){
      return this.listenerService(packageId)===runtime&&path==='/fictional'?
        async()=>({status:200,body:'ok'}):null;
    }
  };
  const portal='https://company.example.com',origin='https://service.example.com';
  let listeners=createAddonListeners(db,addons,[portal]);
  t.after(async()=>{await listeners.close();db.close();});
  const occupied=createServer();
  await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  t.after(()=>occupied.close());
  const port=occupied.address().port;
  const configure={id,action:'configure',host:'127.0.0.1',port,origin};
  const change=input=>listeners.change(input,()=>owner);
  const read=(path,host='service.example.com',headers={})=>new Promise((resolve,reject)=>{
    const client=request({host:'127.0.0.1',port,path,agent:false,headers:{host,...headers}},res=>{
      res.resume();res.once('end',()=>resolve(res.statusCode));
    });
    client.once('error',reject);client.end();
  });
  assert.equal(listeners.status(id).running,false);
  await assert.rejects(()=>listeners.change(configure,()=>({id:'unapproved'})),/approving owner/);
  await assert.rejects(()=>change({...configure,origin:portal}),/dedicated HTTPS/);
  await change(configure);
  await assert.rejects(()=>change({id,action:'start'}),/already in use/);
  await new Promise(resolve=>occupied.close(resolve));
  await assert.rejects(()=>read('/fictional'),{code:'ECONNREFUSED'});
  await change({id,action:'start'});
  assert.equal(await read('/fictional'),200);
  assert.equal(await read('/api/session'),404);
  assert.equal(await read('/fictional','company.example.com'),404);
  assert.equal(await read('/fictional','service.example.com',{cookie:'fictional=1'}),403);
  await assert.rejects(()=>change(configure),/Stop the listener/);
  eligible=false;
  assert.equal(await read('/fictional'),404);
  await listeners.reconcile();
  await assert.rejects(()=>read('/fictional'),{code:'ECONNREFUSED'});
  await listeners.close();
  listeners=createAddonListeners(db,addons,[portal]);
  assert.deepEqual(listeners.status(id),{host:'127.0.0.1',port,origin,running:false});
});
