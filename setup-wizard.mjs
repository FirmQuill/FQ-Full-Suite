import {createServer} from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,lstat,mkdir,open,link,unlink} from 'node:fs/promises';
import {dirname,join,isAbsolute} from 'node:path';
import {openStore,tx,putUser,passwordHash,readBooks} from './store.mjs';
import {inspectSetupPackage,initializeSetupPackage,MAX_SETUP_BYTES} from './setup-package.mjs';

const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
async function absent(path){for(const suffix of ['','-wal','-shm','-journal']){try{await lstat(path+suffix);}catch(e){if(e.code==='ENOENT')continue;throw e;}throw Object.assign(Error('Destination already exists. Existing workspaces are never replaced.'),{status:409});}}
// Explicit, temporary, loopback-only setup surface. Normal terminal startup is unchanged.
export async function createSetupWizard({destination,port=0}){
  fail(typeof destination==='string'&&isAbsolute(destination),'Choose an absolute database destination.');
  await absent(destination);const secret=randomBytes(32).toString('base64url');let candidate=null,busy=false,complete=false,origin;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try{
      fail(req.headers.host===new URL(origin).host,'Unknown setup host.',403);const path=new URL(req.url,origin).pathname;
      if(['/', '/setup.mjs','/setup.css'].includes(path)&&req.method==='GET'){
        const name=path==='/'?'index.html':path.slice(1),body=await readFile(new URL('./web/setup/'+name,import.meta.url));res.writeHead(200,{'Content-Type':name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(body);return;
      }
      const supplied=req.headers['x-setup-token'];fail(typeof supplied==='string'&&/^[A-Za-z0-9_-]+$/.test(supplied)&&supplied.length===secret.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)),'Open the private setup link printed by this host.',403);
      fail(req.method==='POST'&&req.headers.origin===origin,'Use this setup page on its own host.',403);
      fail(req.headers['content-type']?.split(';')[0]==='application/json','Send JSON.',415);
      const envelopeLimit=2*MAX_SETUP_BYTES+65536;fail(!req.headers['content-length']||Number(req.headers['content-length'])<=envelopeLimit,'Setup request too large.',413);
      let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;fail(length<=envelopeLimit,'Setup request too large.',413);chunks.push(chunk);}let p;try{p=JSON.parse(Buffer.concat(chunks));}catch{fail(false,'Invalid JSON.');}
      fail(p&&typeof p==='object'&&!Array.isArray(p),'Invalid setup request.');fail(!busy,'Setup is busy. Wait and retry.',409);
      if(path==='/api/preview'){
        fail(!complete,'Setup already completed.',409);await absent(destination);
        fail(!busy&&!complete,'Setup is busy or already completed. Wait and retry.',409);candidate=null;
        if(Object.hasOwn(p,'packageText')){const info=inspectSetupPackage(p.packageText);candidate={mode:'package',text:p.packageText,digest:info.digest};const {dataset,approval,...preview}=info;send(200,{mode:'package',preview});}
        else{candidate={mode:'empty',digest:''};send(200,{mode:'empty',preview:{company:'An empty workspace; create a company after signing in.'}});}return;
      }
      if(path==='/api/initialize'){
        fail(!complete,'Setup already completed. Start FirmQuill normally.',409);fail(p.confirm===true,'Confirm the reviewed setup contents.');
        fail(candidate,'Preview the setup contents before initializing.',409);
        fail(typeof p.password==='string'&&p.password===p.confirmPassword,'Passwords differ.');
        fail((candidate?.digest||'')===(p.digest||''),'Preview this exact package again.',409);
        const selected=candidate;busy=true;const stage=join(dirname(destination),'.firmquill-owner-'+randomUUID()+'.partial');let db;
        try{
          await absent(destination);const encoded=await passwordHash(p.password);await mkdir(dirname(destination),{recursive:true,mode:0o700});
          if(selected.mode==='package')await initializeSetupPackage({packageText:selected.text,destination:stage,confirmedDigest:selected.digest});
          else{const handle=await open(stage,'wx',0o600);await handle.close();}
          db=openStore(stage);tx(db,()=>putUser(db,null,{username:p.username,name:p.name,role:'owner',assignments:[]},encoded,{bootstrap:true}));
          const companies=readBooks(db).state.companies.map(c=>({id:c.id,name:c.name}));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();db=null;
          const flushed=await open(stage,'r+');try{await flushed.sync();}finally{await flushed.close();}
          await absent(destination);await link(stage,destination);complete=true;candidate=null;
          send(200,{initialized:true,companies,message:'Administrator created. Close this temporary setup page and run node host.mjs start. Sign in with your own credentials.'});
        }finally{db?.close();busy=false;for(const suffix of ['','-wal','-shm','-journal'])await unlink(stage+suffix).catch(e=>{if(e.code!=='ENOENT')throw e;});}
        return;
      }
      fail(false,'Setup endpoint unavailable.',404);
    }catch(e){if(!res.headersSent)send(e.status||400,{error:e.code?'Setup storage unavailable. Check the chosen data location and retry.':e.message});}
  });
  await new Promise((yes,no)=>server.once('error',no).listen(port,'127.0.0.1',yes));origin='http://127.0.0.1:'+server.address().port;
  const expiry=setTimeout(()=>{candidate=null;server.close();server.closeIdleConnections();},30*60*1000);expiry.unref();
  return {url:origin+'/#'+secret,origin,async close(){clearTimeout(expiry);candidate=null;await new Promise(done=>{server.close(done);server.closeIdleConnections();});}};
}
