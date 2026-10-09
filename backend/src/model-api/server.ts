import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {strictJson} from '../llm.ts';
import {validateAssessment,validateResponse} from '../v2/assessment.ts';
import {validateExtraction,validateGuidance} from '../v2/model.ts';
import type {AgentModel,ModelContext} from '../v2/model.ts';
import {V2Error} from '../v2/errors.ts';
import {API_VERSION,MAX_BODY_BYTES,PATHS,MODEL_API_OPENAPI,ModelApiError,sameIdentity,validateIdentity,validateRequest} from './contract.ts';
import type {ModelIdentity,ModelOperation,ModelRequest} from './contract.ts';

type Options={token:string;identity:ModelIdentity|null;model:AgentModel|null;inferenceEnabled:boolean;timeoutMs?:number;evaluationTimeoutMs?:number;cacheTtlMs?:number;cacheLimit?:number};
type ApiResult={status:number;body:any};
const hash=(value:string)=>createHash('sha256').update(value).digest();
function send(res:ServerResponse,status:number,body:any){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
function errorResult(error:unknown,requestId:string|null):ApiResult{
  const code=error instanceof V2Error?error.code:'MODEL_UNAVAILABLE';
  const status=error instanceof ModelApiError?error.status:code==='MODEL_BUSY'?429:code==='INVALID_MODEL_OUTPUT'||code==='FAILED_VERIFICATION'?502:503;
  return {status,body:{api_version:API_VERSION,request_id:requestId,error:{code,retryable:status>=500||status===429}}};
}
async function readRequest(req:IncomingMessage){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')||req.headers['content-encoding'])throw new ModelApiError(415,'JSON_REQUIRED');
  if(Number(req.headers['content-length'])>MAX_BODY_BYTES)throw new ModelApiError(413,'REQUEST_TOO_LARGE');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY_BYTES)throw new ModelApiError(413,'REQUEST_TOO_LARGE');chunks.push(chunk);}
  try{return strictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ModelApiError(422,'INVALID_MODEL_REQUEST');}
}
function validateOutput(operation:ModelOperation,output:any,input:ModelContext){
  if(operation==='assess')validateAssessment(output,input.messages.map((message:any)=>({id:String(message.message_index),content:message.content,speaker:'supporter'})));
  else if(operation==='respond')return validateResponse(output);
  else if(operation==='extract')validateExtraction(output,input);
  else if(operation==='guide'){
    const refs=new Set<string>([...(input.answers||[]),...(input.memories||[]),...(input.recent_messages||[])].map((item:any)=>item.id));if(input.message_id)refs.add(input.message_id);validateGuidance(output,refs);
  }else if(operation==='verify'){
    if(!output||typeof output.approved!=='boolean'||!Array.isArray(output.issues)||Object.keys(output).some(key=>!['approved','issues'].includes(key))||output.issues.length>8||output.issues.some((issue:any)=>typeof issue!=='string'||!issue.trim()||issue.length>2000)||output.approved&&output.issues.length)throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');
  }else if(operation==='tokenize'&&(!Number.isInteger(output?.tokens)||output.tokens<0))throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');
  return output;
}
export function createModelApi(options:Options){
  if(typeof options.token!=='string'||options.token.length<32||/\s/.test(options.token))throw new Error('HOP_MODEL_API_TOKEN must contain at least 32 non-whitespace characters');
  if(options.identity)validateIdentity(options.identity);
  if(options.inferenceEnabled&&(!options.identity||!options.model))throw new Error('Enabled model API needs an explicit checkpoint identity and model transport');
  const tokenHash=hash(options.token),timeout=options.timeoutMs??30000,evaluationTimeout=options.evaluationTimeoutMs??10000,ttl=options.cacheTtlMs??300000,limit=options.cacheLimit??100;
  if(!Number.isInteger(timeout)||timeout<1||timeout>45000||!Number.isInteger(evaluationTimeout)||evaluationTimeout<1||evaluationTimeout>10000||!Number.isInteger(limit)||limit<1||!Number.isInteger(ttl)||ttl<1||ttl>300000)throw new Error('Invalid model API execution limits');
  const cache=new Map<string,{fingerprint:string;expires:number;pending:boolean;result:Promise<ApiResult>}>();
  const controllers=new Set<AbortController>();let busy=false;
  async function invoke(operation:ModelOperation,request:ModelRequest,disconnect:AbortSignal):Promise<ApiResult>{
    const controller=new AbortController();controllers.add(controller);busy=true;
    const timer=setTimeout(()=>controller.abort(new ModelApiError(504,'MODEL_TIMEOUT')),operation==='assess'?evaluationTimeout:timeout);timer.unref();
    const signal=AbortSignal.any([controller.signal,disconnect]);
    const execution=Promise.resolve().then(()=>operation==='tokenize'?options.model!.countTokens(request.input.current_message,signal).then(tokens=>({tokens})):options.model!.call(operation,request.input,signal));
    const release=()=>{busy=false;controllers.delete(controller);clearTimeout(timer);};execution.then(release,release);
    let aborted:(()=>void)|undefined;
    try{
      const abort=new Promise<never>((_resolve,reject)=>{aborted=()=>reject(signal.reason instanceof ModelApiError?signal.reason:new ModelApiError(499,'REQUEST_CANCELLED'));if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});});
      const raw=await Promise.race([execution,abort]);
      let output:any;
      try{output=validateOutput(operation,raw,request.input);}
      catch(error){throw new ModelApiError(502,error instanceof V2Error&&error.code==='FAILED_VERIFICATION'?'FAILED_VERIFICATION':'INVALID_MODEL_OUTPUT');}
      return {status:200,body:{api_version:API_VERSION,request_id:request.request_id,operation,model:options.identity,output}};
    }catch(error){return errorResult(error,request.request_id);}
    finally{if(aborted)signal.removeEventListener('abort',aborted);}
  }
  const server=createServer(async(req,res)=>{
    let requestId:string|null=null;
    try{
      const auth=req.headers.authorization||'';
      if(!auth.startsWith('Bearer ')||!timingSafeEqual(hash(auth.slice(7)),tokenHash))throw new ModelApiError(401,'UNAUTHORIZED');
      // This is a server-to-server API. Browser cookies and Origin requests cannot select model policies.
      if(req.headers.origin)throw new ModelApiError(403,'SERVER_CLIENT_REQUIRED');
      const url=new URL(req.url||'/','http://localhost');if(url.search)throw new ModelApiError(404,'NOT_FOUND');
      if(req.method==='GET'&&url.pathname==='/health/live'){send(res,200,{api_version:API_VERSION,status:'ok'});return;}
      if(req.method==='GET'&&url.pathname==='/v1/status'){send(res,200,{api_version:API_VERSION,inference_enabled:options.inferenceEnabled,configured:Boolean(options.identity&&options.model),inference_readiness:'not_probed',model:options.identity,busy,idempotency_window_seconds:ttl/1000});return;}
      if(req.method==='GET'&&url.pathname==='/v1/openapi.json'){send(res,200,MODEL_API_OPENAPI);return;}
      const operation=Object.entries(PATHS).find(([,path])=>path===url.pathname)?.[0] as ModelOperation|undefined;
      if(!operation)throw new ModelApiError(404,'NOT_FOUND');if(req.method!=='POST')throw new ModelApiError(405,'METHOD_NOT_ALLOWED');
      if(!options.inferenceEnabled)throw new ModelApiError(503,'MODEL_DISABLED');
      const request=validateRequest(await readRequest(req),operation);requestId=request.request_id;
      if(!sameIdentity(request.expected_model,options.identity!))throw new ModelApiError(409,'MODEL_IDENTITY_MISMATCH');
      for(const [key,value] of cache)if(!value.pending&&value.expires<=Date.now())cache.delete(key);
      const fingerprint=hash(JSON.stringify({operation,request})).toString('hex'),existing=cache.get(requestId);
      if(existing){if(existing.fingerprint!==fingerprint)throw new ModelApiError(409,'IDEMPOTENCY_CONFLICT');const result=await existing.result;send(res,result.status,result.body);return;}
      if(busy||cache.size>=limit)throw new ModelApiError(429,'MODEL_BUSY');
      const disconnect=new AbortController();res.once('close',()=>{if(!res.writableEnded)disconnect.abort(new ModelApiError(499,'REQUEST_CANCELLED'));});
      const result=invoke(operation,request,disconnect.signal),entry={fingerprint,expires:Date.now()+ttl,pending:true,result};cache.set(requestId,entry);
      const response=await result;entry.pending=false;entry.expires=Date.now()+ttl;send(res,response.status,response.body);
    }catch(error){const result=errorResult(error,requestId);send(res,result.status,result.body);}
  });
  server.headersTimeout=5000;server.requestTimeout=15000;server.keepAliveTimeout=5000;
  return {server,close:async()=>{for(const controller of controllers)controller.abort(new ModelApiError(503,'MODEL_API_STOPPING'));cache.clear();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
