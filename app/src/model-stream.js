// Reconstruct the completion envelope, stopping output already impossible as a
// single JSON value or under supplied schema bounds. The caller owns full JSON validation,
// source validation, independent review and retries.
export class ModelStreamError extends Error {
  constructor(reason,feedback) {
    super('Invalid model event stream');
    this.reason=reason;
    if(feedback!==undefined)this.feedback=feedback;
  }
}

// Local transport completion is distinct from the provider's finish reason.
// An upstream JSON field cannot opt a response into this path.
export const JSON_STREAM_COMPLETE=Symbol('jsonStreamComplete');

// This is an upper bound shared by every array allowed by the original schema,
// not a new output budget. Unknown schemas disable the early check.
export function schemaArrayLimit(schema) {
  const active=new Set();
  const maximum=values=>values.some(value=>value===null)?null:Math.max(0,...values);
  const literal=value=>{
    if(Array.isArray(value))return Math.max(value.length,...value.map(literal));
    if(value&&typeof value==='object')return Math.max(0,...Object.values(value).map(literal));
    return 0;
  };
  const visit=node=>{
    if(node===false)return 0;
    if(!node||typeof node!=='object'||Array.isArray(node)||active.has(node)||node.$ref!==undefined||node.$dynamicRef!==undefined)return null;
    active.add(node);
    try {
      const bounds=[];
      if(Array.isArray(node.enum)&&node.enum.length)bounds.push(Math.max(...node.enum.map(literal)));
      if(Object.hasOwn(node,'const'))bounds.push(literal(node.const));
      const types=Array.isArray(node.type)?node.type:[node.type];
      if(types.length&&types.every(type=>typeof type==='string'))bounds.push(maximum(types.map(type=>{
        if(['string','number','integer','boolean','null'].includes(type))return 0;
        if(type==='object') {
          if(node.additionalProperties!==false)return null;
          const properties=node.properties??{},patterns=node.patternProperties??{};
          if(!properties||typeof properties!=='object'||Array.isArray(properties)||!patterns||typeof patterns!=='object'||Array.isArray(patterns))return null;
          return maximum([...Object.values(properties),...Object.values(patterns)].map(visit));
        }
        if(type==='array') {
          if(!Number.isSafeInteger(node.maxItems)||node.maxItems<0)return null;
          if(node.maxItems===0)return 0;
          const prefix=node.prefixItems??(Array.isArray(node.items)?node.items:[]);
          if(!Array.isArray(prefix))return null;
          const items=Array.isArray(node.items)?node.additionalItems:node.items;
          const children=prefix.slice(0,node.maxItems).map(visit);
          if(node.maxItems>prefix.length)children.push(visit(items));
          const nested=maximum(children);
          return nested===null?null:Math.max(node.maxItems,nested);
        }
        return null;
      })));
      for(const key of ['anyOf','oneOf'])if(Array.isArray(node[key])&&node[key].length)
        bounds.push(maximum(node[key].map(visit)));
      if(Array.isArray(node.allOf)&&node.allOf.length) {
        const finite=node.allOf.map(visit).filter(value=>value!==null);
        if(finite.length)bounds.push(Math.max(...finite));
      }
      const finite=bounds.filter(value=>value!==null);
      return finite.length?Math.max(...finite):null;
    } finally {active.delete(node);}
  };
  return visit(schema);
}

// A shared upper bound for string values, never property names or total output.
// Count UTF-16 units to match the original validator's String.length contract.
export function schemaStringLimit(schema) {
  const active=new Set(),literals=new Set();
  const maximum=values=>values.some(value=>value===null)?null:Math.max(0,...values);
  const literal=value=>{
    if(typeof value==='string')return value.length;
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return 0;
    if(!value||typeof value!=='object'||literals.has(value))return null;
    if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    if(Object.getOwnPropertySymbols(value).length||Object.values(descriptors).some(item=>!Object.hasOwn(item,'value'))||
      typeof descriptors.toJSON?.value==='function')return null;
    if(Array.isArray(value))for(let index=0;index<value.length;index++)if(!Object.hasOwn(value,index))return null;
    literals.add(value);
    try{return maximum(Object.values(value).map(literal));}finally{literals.delete(value);}
  };
  const visit=node=>{
    if(node===false)return 0;
    if(!node||typeof node!=='object'||Array.isArray(node)||active.has(node)||node.$ref!==undefined||node.$dynamicRef!==undefined)return null;
    active.add(node);
    try {
      const bounds=[];
      if(Array.isArray(node.enum)&&node.enum.length)bounds.push(maximum(node.enum.map(literal)));
      if(Object.hasOwn(node,'const'))bounds.push(literal(node.const));
      const types=Array.isArray(node.type)?node.type:[node.type];
      if(types.length&&types.every(type=>typeof type==='string'))bounds.push(maximum(types.map(type=>{
        if(['number','integer','boolean','null'].includes(type))return 0;
        if(type==='string')return Number.isSafeInteger(node.maxLength)&&node.maxLength>=0?node.maxLength:null;
        if(type==='object') {
          if(node.additionalProperties!==false)return null;
          const properties=node.properties??{},patterns=node.patternProperties??{};
          if(!properties||typeof properties!=='object'||Array.isArray(properties)||!patterns||typeof patterns!=='object'||Array.isArray(patterns))return null;
          return maximum([...Object.values(properties),...Object.values(patterns)].map(visit));
        }
        if(type==='array') {
          if(node.maxItems!==undefined&&(!Number.isSafeInteger(node.maxItems)||node.maxItems<0))return null;
          if(node.maxItems===0)return 0;
          const prefix=node.prefixItems??(Array.isArray(node.items)?node.items:[]);
          if(!Array.isArray(prefix))return null;
          const children=prefix.slice(0,node.maxItems??prefix.length).map(visit);
          if((node.maxItems??Infinity)>prefix.length)children.push(visit(Array.isArray(node.items)?node.additionalItems:node.items));
          return maximum(children);
        }
        return null;
      })));
      for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(node[key])&&node[key].length)
        bounds.push(maximum(node[key].map(visit)));
      const finite=bounds.filter(value=>value!==null);
      return finite.length?Math.max(...finite):null;
    } finally {active.delete(node);}
  };
  return visit(schema);
}

// Property names may occur at several paths or in several union branches. Use
// their largest declared outer bound, and abandon precision when a name could
// come from an unmodelled schema or literal object containing arrays.
export function schemaPropertyArrayLimits(schema) {
  if(schemaArrayLimit(schema)===null)return null;
  const limits=Object.create(null),active=new Set();
  let uncertain=false;
  const containsArray=value=>Array.isArray(value)||Boolean(value&&typeof value==='object'&&Object.values(value).some(containsArray));
  const visit=(node,property=null)=>{
    if(node===false)return;
    if(!node||typeof node!=='object'||Array.isArray(node)||active.has(node)||node.$ref!==undefined||
      node.$dynamicRef!==undefined||node.patternProperties!==undefined){uncertain=true;return;}
    if(Array.isArray(node.enum)&&node.enum.some(containsArray)||Object.hasOwn(node,'const')&&containsArray(node.const)){uncertain=true;return;}
    const types=Array.isArray(node.type)?node.type:[node.type];
    const typed=types.length&&types.every(type=>['object','array','string','number','integer','boolean','null'].includes(type));
    const unions=['anyOf','oneOf','allOf'].filter(key=>Array.isArray(node[key])&&node[key].length);
    if(node.type!==undefined&&!typed||node.enum!==undefined&&!Array.isArray(node.enum)){uncertain=true;return;}
    if(!typed&&!unions.length&&!Array.isArray(node.enum)&&!Object.hasOwn(node,'const')){uncertain=true;return;}
    active.add(node);
    try {
      if(types.includes('object')) {
        if(node.additionalProperties!==false){uncertain=true;return;}
        const properties=node.properties??{};
        if(!properties||typeof properties!=='object'||Array.isArray(properties)){uncertain=true;return;}
        for(const [name,value] of Object.entries(properties))visit(value,name);
      }
      if(types.includes('array')) {
        if(!Number.isSafeInteger(node.maxItems)||node.maxItems<0){uncertain=true;return;}
        if(property!==null)limits[property]=Math.max(limits[property]??0,node.maxItems);
        if(node.maxItems>0){
          const prefix=node.prefixItems??(Array.isArray(node.items)?node.items:[]);
          if(!Array.isArray(prefix)){uncertain=true;return;}
          for(const value of prefix.slice(0,node.maxItems))visit(value);
          if(node.maxItems>prefix.length)visit(Array.isArray(node.items)?node.additionalItems:node.items);
        }
      }
      for(const key of unions)for(const value of node[key])visit(value,property);
    } finally {active.delete(node);}
  };
  visit(schema);
  return uncertain?null:Object.fromEntries(Object.entries(limits));
}

export async function streamJsonResponse(response,{signal,abort,arrayLimit=null,propertyArrayLimits=null,stringLimit=null,completeJson=false}={}) {
  let reader;
  const cancelled=()=>{void reader?.cancel().catch(()=>{});};
  try {
    if(!response.body||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream')
      throw new ModelStreamError('stream_content_type');
    reader=response.body.getReader();
    signal?.addEventListener('abort',cancelled,{once:true});
    signal?.throwIfAborted();
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const content=[],reasoning=[],reasoningContent=[];
    let line='',data=[],done=false,skipLF=false,finishReason=null,usage,id,model,created;
    let inString=false,escaped=false,whitespaceRun=0,keyText=null,valueString=false,stringLength=0,unicodeRemaining=0;
    const frames=[];
    let rootStarted=false,rootClosed=false,jsonComplete=false;
    const bounded=Number.isSafeInteger(arrayLimit)&&arrayLimit>=0;
    const stringBounded=Number.isSafeInteger(stringLimit)&&stringLimit>=0;
    const trackStructure=bounded||stringBounded||completeJson;
    const stringUnits=units=>{
      stringLength+=units;
      if(stringLength>stringLimit)throw new ModelStreamError('agent_schema',JSON.stringify({
        path:'output',keyword:'streamStringLimit',expected:{max_length:stringLimit},actual:{length:stringLength},
      }));
    };
    const valuePosition=()=>{
      const frame=frames.at(-1);
      if(rootClosed||frame?.type==='object'&&frame.state!=='value'||frame?.type==='array'&&!frame.expectsValue)
        throw new ModelStreamError('content_json');
    };
    const valueStart=()=>{
      const frame=frames.at(-1);
      if(frame?.type==='object'){if(frame.state==='value')frame.state='done';return;}
      if(frame?.type!=='array'||!frame.expectsValue)return;
      frame.expectsValue=false;
      if(++frame.count>frame.limit)throw new ModelStreamError('agent_schema',JSON.stringify({
        path:'output',keyword:'streamArrayLimit',expected:{max_count:frame.limit},actual:{count:frame.count},
      }));
    };
    const guard=fragment=>{
      let offset=0;
      for(const char of fragment) {
        offset+=char.length;
        if(inString) {
          if(valueString&&unicodeRemaining){
            if(!/^[0-9a-f]$/iu.test(char))throw new ModelStreamError('content_json');
            if(--unicodeRemaining===0)stringUnits(1);
          }
          else if(escaped){
            if(keyText!==null)keyText+=char;escaped=false;
            if(valueString){
              if(char==='u')unicodeRemaining=4;
              else if('"\\/bfnrt'.includes(char))stringUnits(1);
              else throw new ModelStreamError('content_json');
            }
          }
          else if(char==='\\'){if(keyText!==null)keyText+=char;escaped=true;}
          else if(char==='"'){
            inString=false;valueString=false;
            if(keyText!==null){
              const frame=frames.at(-1);
              try{frame.key=JSON.parse('"'+keyText+'"');}catch{frame.key=null;}
              frame.state='colon';keyText=null;
            }
          }else {
            if(keyText!==null)keyText+=char;
            if(valueString)stringUnits(char.length);
          }
          whitespaceRun=0;
        } else if(char==='"') {
          valueString=false;stringLength=0;unicodeRemaining=0;
          if(trackStructure&&rootStarted){
            const frame=frames.at(-1);
            if(frame?.type==='object'&&frame.state==='key')keyText='';
            else {valuePosition();valueStart();valueString=stringBounded&&frames.length>0;}
          }
          inString=true;whitespaceRun=0;
        }
        else if(char===' '||char==='\t'||char==='\r'||char==='\n') {
          // A local nonproductive-output rule, never a response-length cap.
          if(++whitespaceRun>4096)throw new ModelStreamError('stream_whitespace_stall');
        } else {
          whitespaceRun=0;
          if(!trackStructure)continue;
          if(!rootStarted){if(char!=='{'&&char!=='[')continue;rootStarted=true;}
          if(char==='{'||char==='['){
            if(rootClosed)throw new ModelStreamError('content_json');
            const owner=frames.at(-1);
            if(owner)valuePosition();
            const property=owner?.type==='object'&&owner.state==='value'?owner.key:null;
            const specific=property!==null&&propertyArrayLimits&&Object.hasOwn(propertyArrayLimits,property)?propertyArrayLimits[property]:null;
            const limit=bounded?(Number.isSafeInteger(specific)&&specific>=0?Math.min(arrayLimit,specific):arrayLimit):Infinity;
            valueStart();
            frames.push(char==='['?{type:'array',count:0,expectsValue:true,limit}:{type:'object',state:'key',key:null});
          }
          else if(char==='}'||char===']'){
            frames.pop();
            if(!frames.length){
              rootClosed=true;
              if(completeJson){
                const candidate=content.join('')+fragment.slice(0,offset);
                // Fenced/prose-prefixed responses still need provider termination.
                if(/^\s*[\[{]/u.test(candidate)){
                  try{JSON.parse(candidate);}catch{throw new ModelStreamError('content_json');}
                  jsonComplete=true;
                  return fragment.slice(0,offset);
                }
              }
            }
          }
          else if(char===','){
            const frame=frames.at(-1);
            if(frame?.type==='array')frame.expectsValue=true;
            else if(frame?.type==='object'){frame.state='key';frame.key=null;}
          }
          else if(char===':'){const frame=frames.at(-1);if(frame?.type==='object'&&frame.state==='colon')frame.state='value';}
          else if(frames.length)valueStart();
        }
      }
      return fragment;
    };
    const frame=()=>{
      const text=data.join('\n');data=[];
      if(!text.trim())return;
      if(text.trim()==='[DONE]'){done=true;return;}
      let payload;
      try{payload=JSON.parse(text);}catch{throw new ModelStreamError('stream_json');}
      if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new ModelStreamError('stream_envelope');
      if(payload.error)throw new ModelStreamError('stream_error');
      if(!Array.isArray(payload.choices)||payload.choices.length>1)
        throw new ModelStreamError('stream_envelope');
      if(payload.usage!==undefined)usage=payload.usage;
      if(typeof payload.id==='string')id=payload.id;
      if(typeof payload.model==='string')model=payload.model;
      if(Number.isSafeInteger(payload.created))created=payload.created;
      for(const choice of payload.choices) {
        if(!choice||choice.index!==0||!choice.delta||typeof choice.delta!=='object'||Array.isArray(choice.delta))
          throw new ModelStreamError('stream_envelope');
        const delta=choice.delta;
        if(delta.role!==undefined&&delta.role!=='assistant')throw new ModelStreamError('stream_envelope');
        for(const key of ['content','reasoning','reasoning_content']) {
          if(delta[key]!==undefined&&delta[key]!==null&&typeof delta[key]!=='string')throw new ModelStreamError('stream_envelope');
          if(finishReason!==null&&delta[key])throw new ModelStreamError('stream_envelope');
        }
        if(typeof delta.content==='string'&&!jsonComplete)content.push(guard(delta.content));
        if(typeof delta.reasoning==='string')reasoning.push(delta.reasoning);
        if(typeof delta.reasoning_content==='string')reasoningContent.push(delta.reasoning_content);
        if(choice.finish_reason!==undefined&&choice.finish_reason!==null) {
          if(typeof choice.finish_reason!=='string'||finishReason!==null)throw new ModelStreamError('stream_envelope');
          finishReason=choice.finish_reason;
        }
      }
    };
    const readLine=()=>{
      if(line==='')frame();
      else if(line==='data')data.push('');
      else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /u,''));
      line='';
    };
    const segment=text=>{
      for(const char of text) {
        if(skipLF){skipLF=false;if(char==='\n')continue;}
        if(char==='\r'||char==='\n') {
          readLine();skipLF=char==='\r';
          if(done)break;
        } else line+=char;
      }
    };
    const decode=(bytes,stream)=>{
      try{return decoder.decode(bytes,{stream});}
      catch{throw new ModelStreamError('stream_encoding');}
    };
    while(!done&&!jsonComplete) {
      const next=await reader.read();signal?.throwIfAborted();
      if(next.done) {
        segment(decode(undefined,false));
        if(!done){if(line)readLine();if(data.length)frame();}
        break;
      }
      segment(decode(next.value,true));
    }
    if(!finishReason&&!jsonComplete)throw new ModelStreamError('stream_finish');
    const headers=new Headers(response.headers);
    for(const key of ['content-length','content-encoding','transfer-encoding'])headers.delete(key);
    headers.set('content-type','application/json');
    const restored=new Response(JSON.stringify({id,object:'chat.completion',model,created,
      choices:[{index:0,finish_reason:finishReason,message:{role:'assistant',content:content.join(''),
        ...(reasoning.length?{reasoning:reasoning.join('')}:{}),
        ...(reasoningContent.length?{reasoning_content:reasoningContent.join('')}:{}),
      }}],...(usage!==undefined?{usage}:{})}),{status:response.status,statusText:response.statusText,headers});
    if(jsonComplete)Object.defineProperty(restored,JSON_STREAM_COMPLETE,{value:true});
    return restored;
  } catch(error) {
    abort?.(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort',cancelled);
    try{if(reader)await reader.cancel();else await response.body?.cancel();}catch{/* Closed or aborted. */}
    reader?.releaseLock();
  }
}
