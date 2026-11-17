import {performance} from 'node:perf_hooks';
import {modelHttpFetch} from '../src/model-http.js';

// Measures authenticated HTTP availability, not browser paint. Never records
// headers, response bodies or generated card content.
export function startResultProgressProbe({url,headers,revision,signal,fetchImpl=modelHttpFetch,record,
  intervalMs=500,timeoutMs=8000}={}) {
  const endpoint=new URL(url);
  if(!endpoint.pathname.endsWith('/result')||!Number.isSafeInteger(revision)||revision<0||
    !Number.isFinite(intervalMs)||intervalMs<=0||!Number.isFinite(timeoutMs)||timeoutMs<=0)
    throw new TypeError('Invalid progress probe configuration');
  endpoint.pathname=endpoint.pathname.replace(/\/result$/,'/progress');
  const requestHeaders=new Headers(headers);
  requestHeaders.delete('content-length');requestHeaders.delete('transfer-encoding');
  const controller=new AbortController(),started=performance.now(),cards=new Map(),latencies=[];
  const state={requests:0,errors:0,revision_mismatches:0,rate_limited:0,timeouts:0,record_errors:0,cancelled_requests:0};
  const elapsed=()=> (performance.now()-started)/1000;
  const emit=event=>{
    try{
      const result=record?.({at:new Date().toISOString(),elapsed_seconds:elapsed(),...event});
      if(result?.then)void Promise.resolve(result).catch(()=>{state.record_errors++;});
    }catch{state.record_errors++;}
  };
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const snapshot=()=>{
    const sorted=[...latencies].sort((a,b)=>a-b);
    return {...state,status:cards.has('script')?'passed':state.errors?'failed':'unobserved',
      first_cards:[...cards.values()].map(card=>({...card})),
      poll_latency_seconds:{count:sorted.length,mean:sorted.length?sorted.reduce((a,b)=>a+b,0)/sorted.length:null,
        p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,max:sorted.at(-1)??null},
      interval_ms:intervalMs,timeout_ms:timeoutMs,stopped:controller.signal.aborted,
      scope:'authenticated_progress_http_availability_not_browser_paint'};
  };
  const wait=milliseconds=>new Promise(resolve=>{
    if(controller.signal.aborted){resolve();return;}
    const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,milliseconds);controller.signal.addEventListener('abort',done,{once:true});
  });
  const running=(async()=>{
    try{
      while(!controller.signal.aborted){
        const requestStarted=performance.now(),attempt=new AbortController();
        let timeout=false,delay=intervalMs,rejectAbort;
        const abortAttempt=()=>attempt.abort();
        controller.signal.addEventListener('abort',abortAttempt,{once:true});
        const timer=setTimeout(()=>{timeout=true;attempt.abort();},timeoutMs);
        const interrupted=new Promise((_,reject)=>{rejectAbort=()=>reject(new Error('Probe interrupted'));attempt.signal.addEventListener('abort',rejectAbort,{once:true});});
        state.requests++;
        try{
          const data=await Promise.race([(async()=>{
            const response=await fetchImpl(endpoint.href,{method:'GET',headers:requestHeaders,signal:attempt.signal});
            if(!response.ok){
              if(response.status===429){delay=60000;state.rate_limited++;}
              await response.body?.cancel();
              throw Object.assign(new Error('HTTP failure'),{probeStatus:response.status});
            }
            return response.json();
          })(),interrupted]);
          if(controller.signal.aborted)break;
          if(!data||!Number.isSafeInteger(data.revision)||!Array.isArray(data.cards))throw new Error('Invalid progress shape');
          if(data.revision!==revision){state.revision_mismatches++;emit({event:'revision_mismatch'});}
          else for(const card of data.cards){
            if(!['script','care','doList','avoid','next','relationship'].includes(card?.id)||cards.has(card.id))continue;
            const first={id:card.id,elapsed_seconds:elapsed()};cards.set(card.id,first);
            emit({event:'first_card',...first,source:'authorized_progress_get',poll_interval_ms:intervalMs});
          }
        }catch(error){
          if(controller.signal.aborted){state.cancelled_requests++;break;}
          state.errors++;if(timeout)state.timeouts++;
          emit({event:'poll_failure',kind:timeout?'timeout':error?.probeStatus?'http':'transport_or_payload',
            ...(Number.isInteger(error?.probeStatus)?{http_status:error.probeStatus}:{}),retry_after_ms:delay});
        }finally{
          clearTimeout(timer);controller.signal.removeEventListener('abort',abortAttempt);
          attempt.signal.removeEventListener('abort',rejectAbort);
          latencies.push((performance.now()-requestStarted)/1000);
        }
        await wait(delay);
      }
    }finally{signal?.removeEventListener('abort',abort);}
  })();
  return {snapshot,stop:async()=>{abort();await running;return snapshot();}};
}
