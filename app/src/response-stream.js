// Application events contain public progress and reviewed cards only. Raw
// model deltas, prompts and reasoning never cross this transport.
export function streamEvent(res,type,value){
  if(res.destroyed||res.writableEnded)return;
  // Retire a stalled subscriber rather than buffering an unbounded history.
  // Other subscribers may continue the shared model operation.
  if(res.writableLength>1024*1024){res.destroy();return;}
  res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
}

export async function respondWithRun(req,res,run,signal,subscribe,{revision=run.revision,project=value=>value}={}){
  // subscribe owns admission and retires an unclaimed run even when shutdown
  // raced the DB read. Throwing before subscription would orphan queued work.
  if(signal.aborted)return await subscribe(run,signal);
  if(!String(req.headers.accept||'').split(',').some(value=>value.split(';')[0].trim()==='text/event-stream')){
    const value=project(await subscribe(run,signal));
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no',Vary:'Accept'});
  const snapshot=()=>{if(!signal.aborted)streamEvent(res,'progress',{revision,progress:run.progress.state,cards:run.progress.cards()});};
  const unsubscribe=run.progress.subscribe(snapshot);
  const heartbeat=setInterval(()=>{
    if(!signal.aborted&&!res.destroyed&&!res.writableEnded){
      if(res.writableLength>1024*1024)res.destroy();
      else res.write(': keepalive\n\n');
    }
  },15000);
  heartbeat.unref();
  try{
    snapshot();
    const result=project(await subscribe(run,signal));
    signal.throwIfAborted();
    streamEvent(res,'result',result);res.end();
  }finally{clearInterval(heartbeat);unsubscribe();}
}
