import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export function queueModelServer({apiKey,fetchImpl,health}){
  if(typeof apiKey!=='string'||apiKey.length<32)throw new Error('A dedicated model credential is required');
  const expected=Buffer.from(`Bearer ${apiKey}`);
  const server=createServer(async(req,res)=>{
    const reply=(status,value)=>{if(res.headersSent){res.destroy();return;}if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
    const auth=Buffer.from(req.headers.authorization||'');
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return reply(401,{error:{code:'unauthorized',message:'Model authentication required'}});
    try{
      if(req.method==='GET'&&req.url==='/healthz')return reply(200,await health());
      if(req.method!=='POST'||req.url!=='/v1/chat/completions')return reply(404,{error:{code:'not_found'}});
      if(Number(req.headers['content-length'])>8*1024*1024)return reply(413,{error:{code:'request_too_large'}});
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>8*1024*1024)return reply(413,{error:{code:'request_too_large'}});chunks.push(chunk);}
      const body=Buffer.concat(chunks).toString('utf8');
      try{JSON.parse(body);}catch{return reply(400,{error:{code:'invalid_json'}});}
      const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
      try{
        const response=await fetchImpl('http://127.0.0.1:1/v1/chat/completions',{method:'POST',body,signal:controller.signal});
        if(res.destroyed){await response.body?.cancel();return;}
        const type=response.headers.get('content-type')||'application/json';
        res.writeHead(response.status,{'content-type':type,'cache-control':'no-store',...(type.startsWith('text/event-stream')?{'x-accel-buffering':'no'}:{})});
        res.flushHeaders();
        let heartbeat;
        if(type.startsWith('text/event-stream')){
          heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded&&!res.writableNeedDrain)res.write(': keep-alive\n\n');},15000);heartbeat.unref();
        }
        try{if(response.body)await pipeline(Readable.fromWeb(response.body),res,{signal:controller.signal});else res.end();}
        finally{clearInterval(heartbeat);}
      }finally{res.removeListener('close',cancel);}
    }catch{reply(503,{error:{code:'model_unavailable',message:'Selected GPU model is unavailable; no fallback was used'}});}
  });
  server.requestTimeout=0;server.timeout=0;
  return server;
}

async function main(){
  const root=await realpath(resolve(process.argv[2]||'')),runtime=await realpath(process.argv[4]||fileURLToPath(new URL('../runtime/',import.meta.url)));
  if(!relative(runtime,root)||relative(runtime,root).startsWith('..'))throw new Error('Use a qualified app/runtime run directory');
  const port=Number(process.argv[3]||18731);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
  const read=name=>readFile(join(root,name),'utf8').then(JSON.parse);
  const proof=await read('ready-proof.json');if(proof.worker_ready?.model!=='malssi-gemma4-31b-step5128')throw new Error('Unqualified model identity');
  const key=(await readFile(join(root,'service.key'),'utf8')).trim();
  const queue=await import(pathToFileURL(join(root,'queue-client.mjs')));
  const {serialModelFetch,SETTINGS}=await import(pathToFileURL(join(root,'metrics.mjs')));
  const {validateSchema}=await import(pathToFileURL(join(root,'frozen-app/src/relationship-agent.js')));
  const {compactClarificationPromptSchema}=await import(pathToFileURL(join(root,'frozen-app/src/clarification-schema-prompt.js')));
  const controller=new AbortController();
  const transport=serialModelFetch({remoteRequest:queue.remoteRequest,directory:join(root,'service-requests'),validateSchema,promptSchemaProjection:compactClarificationPromptSchema,signal:controller.signal});
  const health=async()=>{const state=await queue.remoteStatus();if(state.status!=='running'||!state.worker_ready)throw new Error('GPU stopped');return {model:SETTINGS.model,max_output_tokens:8192,max_context_tokens:40960};};
  await health();
  const server=queueModelServer({apiKey:key,fetchImpl:transport.fetchImpl,health});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await writeFile(join(root,'SERVICE.json'),JSON.stringify({status:'serving',pid:process.pid,port,model:SETTINGS.model,started_at:new Date().toISOString(),run:root},null,2)+'\n',{mode:0o600});
  let closing;
  const close=()=>closing||=(async()=>{controller.abort();server.closeAllConnections();await new Promise(done=>server.close(done));await transport.drain();const cleanup=await queue.stopRemote();await writeFile(join(root,'service-cleanup.json'),JSON.stringify(cleanup,null,2)+'\n');await writeFile(join(root,'SERVICE.json'),JSON.stringify({status:'stopped',pid:process.pid,port,stopped_at:new Date().toISOString()})+'\n');})();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().finally(()=>process.exit()));
  const watch=setInterval(async()=>{try{await health();}catch{clearInterval(watch);await close();}},60000);watch.unref();
  console.log(JSON.stringify({status:'serving',port,model:SETTINGS.model}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
