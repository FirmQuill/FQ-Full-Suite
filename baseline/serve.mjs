import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const root=new URL('../shared/',import.meta.url);
const files=new Set(['index.html','mark.svg','headquarters.png','app.css','app.mjs','core.mjs','views.mjs','sample.mjs','vault.mjs','interop.mjs','payroll-rules.mjs','sw.js']);
const types={html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',png:'image/png',svg:'image/svg+xml'};
function localServer(){
  return createServer(async(req,res)=>{
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
    if(req.url==='/'){res.writeHead(302,{Location:'/fieldledger-lite/'}).end();return;}
    const file=req.url==='/fieldledger-lite/'?'index.html':req.url?.replace(/^\/fieldledger-lite\//,'');
    if(!req.url?.startsWith('/fieldledger-lite/')||!files.has(file)){res.writeHead(404).end();return;}
    try{const bytes=await readFile(new URL(file,root));res.writeHead(200,{'Content-Type':types[file.split('.').pop()],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:bytes);}
    catch{res.writeHead(500).end();}
  });
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const server=localServer();server.on('error',err=>{console.error('Local launcher could not start ('+err.code+').');process.exitCode=1;});
  server.listen(4178,'127.0.0.1',()=>console.log('Open http://127.0.0.1:4178/fieldledger-lite/ in your browser.\nKeep this window open while using Lite. Press Ctrl+C to stop.'));
}

export {localServer};

