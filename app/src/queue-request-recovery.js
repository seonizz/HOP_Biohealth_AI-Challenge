import {randomUUID} from 'node:crypto';

const fault=code=>Object.assign(new Error(code),{code,fatal:true});
const recoverableCodes=new Set(['request_timeout','request_cancelled']);
const canonicalRequestId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

// A provider error alone never proves that its reusable worker finished cleanup.
export function reusableRequestFailure(envelope,expectedId=envelope?.id){
 const proof=envelope?.recovery;
 return canonicalRequestId(expectedId)&&recoverableCodes.has(envelope?.error?.code)&&envelope?.fatal!==true&&envelope?.error?.fatal!==true&&
  envelope.id===expectedId&&proof?.version===1&&proof.request_id===expectedId&&
  ['request_stopped','cache_cleared','adapter_unchanged','worker_reusable'].every(key=>proof[key]===true);
}

// Cancelling a consumer requests cooperative cancellation of its UUID. The
// transport stays open until that request's terminal receipt has been read.
export function createRecoverableRequestQueue({call,cancelRequest,cancelAckTimeoutMs=30000,onRecord=()=>{}}){
 let tail=Promise.resolve(),fatal=null;
 const request=(payload,{signal,cancelSignal,onChunk}={})=>{
  const task=tail.catch(()=>{}).then(async()=>{
   if(fatal)throw fatal;
   if(signal?.aborted)throw fault('request_aborted');
   if(cancelSignal?.aborted)throw Object.assign(new Error('app_request_cancelled'),{code:'app_request_cancelled'});
   const id=randomUUID(),controller=new AbortController();
   let cancelWork=null,timer,rejectCancellation;
   const cancellationDeadline=new Promise((_,reject)=>{rejectCancellation=reject;});
   const hardAbort=()=>controller.abort(signal.reason);
   const cancel=()=>{
    if(cancelWork)return;
    timer=setTimeout(()=>{
     const error=fault('request_cancel_ack_timeout');controller.abort(error);rejectCancellation(error);
    },cancelAckTimeoutMs);
    cancelWork=Promise.resolve().then(()=>cancelRequest(id)).then(receipt=>{
     if(receipt?.status!=='request_cancel_requested'||receipt.request_id!==id)throw fault('request_cancel_id_mismatch');
     return receipt;
    });
    void cancelWork.catch(error=>{controller.abort(error);rejectCancellation(error);});
   };
   signal?.addEventListener('abort',hardAbort,{once:true});
   cancelSignal?.addEventListener('abort',cancel,{once:true});
   if(signal?.aborted)hardAbort();
   if(cancelSignal?.aborted)cancel();
   try{
    const envelope=await Promise.race([call({action:'request',id,payload},{signal:controller.signal,onChunk}),cancellationDeadline]);
    if(controller.signal.aborted)throw fault('request_aborted');
    cancelSignal?.removeEventListener('abort',cancel);
    if(envelope?.id!==id)throw fault('request_terminal_id_mismatch');
    if(cancelWork)await Promise.race([cancelWork,cancellationDeadline]);
    if(recoverableCodes.has(envelope?.error?.code)&&!reusableRequestFailure(envelope,id))throw fault('request_cleanup_unverified');
    if(envelope.fatal===true||envelope.error?.fatal===true)throw fault(envelope.error?.code||'worker_failed');
    try{onRecord({id,cancellation_requested:Boolean(cancelWork),reusable_failure:reusableRequestFailure(envelope,id)});}catch{/* Diagnostics cannot alter a verified terminal receipt. */}
    return envelope;
   }catch(error){
    fatal=error?.fatal?error:fault(error?.code||'networkfatal');
    // A transport fault can leave this generation active. Only its UUID is
    // cancelled; worker lifecycle/shutdown remains the explicit owner's job.
    if(!cancelWork){
     let cleanupTimer;
     try{await Promise.race([cancelRequest(id),new Promise((_,reject)=>{
      cleanupTimer=setTimeout(()=>reject(fault('request_cancel_ack_timeout')),cancelAckTimeoutMs);
     })]);}catch{/* Fatal state still blocks dispatch. */}finally{clearTimeout(cleanupTimer);}
    }
    throw fatal;
   }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',hardAbort);cancelSignal?.removeEventListener('abort',cancel);
   }
  });
  tail=task.catch(()=>{});return task;
 };
 return {request,drain:()=>tail,get fatal(){return fatal;}};
}
