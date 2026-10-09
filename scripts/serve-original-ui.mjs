// Serve only the built frontend; all API traffic stays on the same origin.
import {createServer,request} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=await realpath(fileURLToPath(new URL('../frontend/dist/',import.meta.url)));
const port=Number(process.env.HOP_WEB_PORT||8088),apiPort=Number(process.env.HOP_API_PORT||19020);
const host=process.env.HOP_WEB_HOST||'127.0.0.1';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const pathname=new URL(req.url||'/','http://localhost').pathname;
  if(/^\/(?:api\/|health\/|help\/|openapi)/.test(pathname)){
    const upstream=request({hostname:'127.0.0.1',port:apiPort,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${apiPort}`}},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({detail:'서비스 연결을 확인해 주세요.'}));});
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  try{
    const file=resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+sep))throw new Error();
    const canonical=await realpath(file);if(!canonical.startsWith(root+sep))throw new Error();
    const info=await stat(canonical);if(!info.isFile())throw new Error();
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':info.size});
    if(req.method==='HEAD')res.end();else createReadStream(canonical).pipe(res);
  }catch{res.writeHead(404);res.end();}
});
server.listen(port,host,()=>console.log(`Original UI listening on ${host}:${port}; backend 127.0.0.1:${apiPort}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close());
