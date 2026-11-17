import {createQueueEventParser,queueStreamError} from './queue-event-stream.js';

// Own the process until clean exit: receiving a result line alone cannot make
// a truncated, duplicate-terminal, or subsequently failed SSH call successful.
export function queueProcessResponse(child,{id,stream=false,onChunk,signal,timeoutMs=1000000,maxBytes=16*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  let bytes=0,done=false,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  const parser=stream?createQueueEventParser({id,onChunk,maxBytes}):null;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
  const fail=code=>{child.kill('SIGTERM');finish(queueStreamError(code));};
  const abort=()=>fail('REQUEST_CANCELLED');
  const timer=setTimeout(()=>fail('model_request_timeout'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',chunk=>{
   if(done)return;bytes+=chunk.byteLength;if(bytes>maxBytes)return fail('queue_stream_bound');
   try{if(parser)parser.push(chunk);else text+=decoder.decode(chunk,{stream:true});}catch(error){child.kill('SIGTERM');finish(error.fatal?error:queueStreamError('queue_stream_encoding'));}
  });
  // SSH diagnostics can contain machine paths; they never enter public errors.
  child.stderr.resume();
  child.once('error',()=>finish(queueStreamError('networkfatal')));
  child.stdin?.once('error',()=>fail('networkfatal'));
  child.once('close',code=>{
   if(done)return;if(code!==0)return finish(queueStreamError('networkfatal'));
   try{const result=parser?parser.finish():JSON.parse(text+decoder.decode());finish(null,result);}catch(error){finish(error.fatal?error:queueStreamError('queue_stream_json'));}
  });
  if(signal?.aborted)abort();
 });
}
