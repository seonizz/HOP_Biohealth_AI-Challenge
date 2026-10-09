import {randomUUID} from 'node:crypto';
import {API_VERSION,MAX_BODY_BYTES,PATHS,ModelApiError,sameIdentity,validateIdentity} from '../model-api/contract.ts';
import type {ModelIdentity,ModelOperation} from '../model-api/contract.ts';
import type {AgentModel,ModelContext} from './model.ts';

// The endpoint is operator configuration, never taken from a browser message or model output.
export class ModelApiClient implements AgentModel {
  readonly base:string;readonly token:string;readonly identity:ModelIdentity;
  constructor(base:string,token:string,identity:ModelIdentity,allowedOrigin=''){
    const url=new URL(base),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(loopback&&url.protocol==='http:'||url.protocol==='https:'&&allowedOrigin===url.origin))throw new Error('Model API requires HTTP loopback or an explicitly allowed HTTPS origin with no path');
    if(token.length<32||/\s/.test(token))throw new Error('HOP_MODEL_API_TOKEN must contain at least 32 non-whitespace characters');
    this.base=url.origin;this.token=token;this.identity=validateIdentity(identity);
  }
  private async invoke(operation:ModelOperation,input:ModelContext,signal:AbortSignal){
    const {_model_request_id,...context}=input,requestId=_model_request_id||randomUUID();
    const body=JSON.stringify({api_version:API_VERSION,request_id:requestId,expected_model:this.identity,input:context});
    if(Buffer.byteLength(body)>MAX_BODY_BYTES)throw new ModelApiError(413,'CONTEXT_TOO_LARGE');
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
    let response:Response;
    try{response=await fetch(this.base+PATHS[operation],{method:'POST',redirect:'error',signal:requestSignal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},body});}
    catch{throw new ModelApiError(503,requestSignal.aborted?'MODEL_TIMEOUT':'MODEL_UNAVAILABLE');}
    const reader=response.body?.getReader();if(!reader)throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>MAX_BODY_BYTES){await reader.cancel();throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');}chunks.push(result.value);}}
    catch(error){if(error instanceof ModelApiError)throw error;throw new ModelApiError(503,'MODEL_UNAVAILABLE');}
    let payload:any;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');}
    if(!response.ok){
      const allowed=['MODEL_DISABLED','MODEL_BUSY','MODEL_TIMEOUT','MODEL_IDENTITY_MISMATCH','IDEMPOTENCY_CONFLICT','INVALID_MODEL_OUTPUT','FAILED_VERIFICATION','MODEL_UNAVAILABLE','INVALID_MODEL_REQUEST','UNAUTHORIZED','REQUEST_TOO_LARGE','REQUEST_CANCELLED','MODEL_API_STOPPING'];
      throw new ModelApiError(response.status,allowed.includes(payload.error?.code)?payload.error.code:'MODEL_UNAVAILABLE');
    }
    try{if(payload.api_version!==API_VERSION||payload.request_id!==requestId||payload.operation!==operation||!payload.model||!sameIdentity(this.identity,validateIdentity(payload.model))||!Object.hasOwn(payload,'output'))throw new Error('invalid response');}
    catch{throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');}
    return payload.output;
  }
  async call(kind:string,context:ModelContext,signal:AbortSignal){
    if(!Object.hasOwn(PATHS,kind)||kind==='tokenize')throw new ModelApiError(422,'INVALID_MODEL_REQUEST');
    return this.invoke(kind as ModelOperation,context,signal);
  }
  async countTokens(value:string,signal:AbortSignal){
    const output=await this.invoke('tokenize',{current_message:value},signal);
    if(!Number.isInteger(output?.tokens)||output.tokens<0)throw new ModelApiError(502,'INVALID_MODEL_OUTPUT');return output.tokens;
  }
}
