// Incremental private queue protocol. A terminal receipt is accepted only once
// and only after the byte stream closes without additional events.
export function queueStreamError(code='queue_stream_invalid'){
  return Object.assign(new Error(code),{code,fatal:true});
}
export function createQueueEventParser({id,onChunk=()=>{},maxBytes=16*1024*1024,maxLineBytes=4*1024*1024}={}){
  if(typeof id!=='string'||!id)throw queueStreamError();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let pending='',bytes=0,sequence=0,terminal,ended=false;
  const line=value=>{
    if(Buffer.byteLength(value)>maxLineBytes)throw queueStreamError('queue_stream_bound');
    if(!value.trim())return;
    if(terminal!==undefined)throw queueStreamError('queue_stream_after_terminal');
    let event;try{event=JSON.parse(value);}catch{throw queueStreamError('queue_stream_json');}
    if(!event||typeof event!=='object'||Array.isArray(event))throw queueStreamError();
    if(event.event==='chunk'){
      if(Object.keys(event).some(key=>!['event','id','seq','delta','at'].includes(key))||event.id!==id||!Number.isSafeInteger(event.seq)||event.seq!==sequence+1||typeof event.delta!=='string'||!event.delta||!Number.isFinite(event.at))throw queueStreamError();
      sequence++;onChunk(event);return;
    }
    if(event.event==='result'&&Object.keys(event).every(key=>['event','envelope'].includes(key))&&event.envelope&&typeof event.envelope==='object'&&!Array.isArray(event.envelope)&&event.envelope.id===id){terminal=event.envelope;return;}
    throw queueStreamError();
  };
  const consume=text=>{
    pending+=text;
    let offset;
    while((offset=pending.indexOf('\n'))!==-1){line(pending.slice(0,offset).replace(/\r$/u,''));pending=pending.slice(offset+1);}
    if(Buffer.byteLength(pending)>maxLineBytes)throw queueStreamError('queue_stream_bound');
  };
  return {
    push(chunk){
      if(ended)throw queueStreamError('queue_stream_after_end');
      bytes+=chunk.byteLength;if(bytes>maxBytes)throw queueStreamError('queue_stream_bound');
      try{consume(decoder.decode(chunk,{stream:true}));}catch(error){if(error.fatal)throw error;throw queueStreamError('queue_stream_encoding');}
    },
    finish(){
      if(ended)throw queueStreamError('queue_stream_after_end');ended=true;
      try{consume(decoder.decode());}catch(error){if(error.fatal)throw error;throw queueStreamError('queue_stream_encoding');}
      if(pending)line(pending);pending='';
      if(terminal===undefined)throw queueStreamError('queue_stream_truncated');
      return terminal;
    },
    get chunks(){return sequence;},get bytes(){return bytes;}
  };
}
