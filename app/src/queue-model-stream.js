import {queueStreamError} from './queue-event-stream.js';

// The remote model's actual deltas may arrive before proof is available. Only
// the independently verified terminal receipt can authorize finish/usage/DONE.
export function validateQueueStreamReceipt(envelope,{id,chunks,content,validate}){
 validate(envelope);
 const response=envelope.response,choice=response?.choices?.[0];
 if(envelope.id!==id||!chunks||!Array.isArray(response?.choices)||response.choices.length!==1||choice.index!==0||choice.finish_reason!=='stop'||choice.message?.role!=='assistant'||typeof choice.message.content!=='string'||choice.message.content!==content)throw queueStreamError('queue_stream_content_mismatch');
 return response;
}
export function createQueueModelStream({model,onCancel=()=>{},maxBytes=16*1024*1024}={}){
 let controller,closed=false,cancelled=false,id,sequence=0,bytes=0;const pieces=[],encoder=new TextEncoder();
 const body=new ReadableStream({start(value){controller=value;},cancel(reason){cancelled=true;closed=true;onCancel(reason);}});
 const emit=value=>{if(!closed)controller.enqueue(encoder.encode('data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n'));};
 const frame=(choices,extra={})=>({id,object:'chat.completion.chunk',model,choices,...extra});
 return {
  response:new Response(body,{status:200,headers:{'content-type':'text/event-stream','cache-control':'no-store'}}),
  push(event){
   if(closed)throw queueStreamError('REQUEST_CANCELLED');
   if(!event||typeof event.id!=='string'||!event.id||event.seq!==sequence+1||typeof event.delta!=='string'||!event.delta||!Number.isFinite(event.at)||id!==undefined&&event.id!==id)throw queueStreamError();
   id=event.id;sequence++;bytes+=encoder.encode(event.delta).byteLength;if(bytes>maxBytes)throw queueStreamError('queue_stream_bound');pieces.push(event.delta);
   emit(frame([{index:0,delta:{...(sequence===1?{role:'assistant'}:{}),content:event.delta},finish_reason:null}]));
  },
  complete(envelope,validate){
   if(closed)throw queueStreamError('REQUEST_CANCELLED');
   const response=validateQueueStreamReceipt(envelope,{id,chunks:sequence,content:pieces.join(''),validate});
   const extra=Number.isSafeInteger(response.created)?{created:response.created}:{};
   emit(frame([{index:0,delta:{},finish_reason:'stop'}],extra));
   if(response.usage!==undefined)emit(frame([],{...extra,usage:response.usage}));
   emit('[DONE]');closed=true;controller.close();
  },
  fail(error){if(closed)return;emit({error:{code:typeof error?.code==='string'&&/^[a-zA-Z0-9_]{1,100}$/u.test(error.code)?error.code:'queue_stream_failed',message:'Model stream did not complete'}});closed=true;controller.close();},
  get cancelled(){return cancelled;},get chunks(){return sequence;},get content(){return pieces.join('');}
 };
}
