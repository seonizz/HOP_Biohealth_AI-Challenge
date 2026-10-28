import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { JSON_STREAM_COMPLETE, ModelStreamError, schemaArrayLimit, schemaPropertyArrayLimits, schemaStringLimit, streamJsonResponse } from '../src/model-stream.js';
import { ModelGateway } from '../src/model.js';
import { HttpError } from '../src/errors.js';
import { validateSchema } from '../src/relationship-agent.js';

const encoder=new TextEncoder();
const chunk=(delta={},finish_reason=null)=>({id:'synthetic-id',model:'synthetic-model',created:10,
  choices:[{index:0,delta,finish_reason}]});
const event=(payload,newline='\n')=>'data: '+(typeof payload==='string'?payload:JSON.stringify(payload))+newline+newline;
const response=(parts,{open=false,headers={},onCancel=()=>{}}={})=>new Response(new ReadableStream({
  start(controller){for(const part of parts)controller.enqueue(typeof part==='string'?encoder.encode(part):part);if(!open)controller.close();},
  cancel(reason){onCancel(reason);},
}),{headers:{'content-type':'text/event-stream',...headers}});
const completion=(content,finish='stop',options={})=>response([
  event(chunk({role:'assistant',content:typeof content==='string'?content:JSON.stringify(content)})),
  event(chunk({},finish)),event('[DONE]'),
],options);
const schema={type:'object',properties:{okay:{type:'boolean'}},required:['okay'],additionalProperties:false};
const gateway=(fetchImpl,options={})=>new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'PRIVATE_KEY_SENTINEL',
  model:'synthetic-model',protocol:'relationship_agent',streamJson:true,timeoutMs:0,diagnosticLogger:null,fetchImpl,...options});
const generate=(model,options={})=>model.operation(options,operation=>model.agentComplete('synthetic_stage','원문만 검토하세요.',
  {source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,value=>validateSchema(value,schema,'output',true)));

test('string bounds cover nested values and union/literal alternatives without counting property names',()=>{
  const closed=properties=>({type:'object',properties,additionalProperties:false});
  const definition=closed({next:{type:'string',maxLength:8000},rows:{type:'array',items:{anyOf:[
    {type:'string',maxLength:13},{type:'null'},closed({text:{enum:['한글','😀','literal text']}}),
  ]}}});
  const before=structuredClone(definition);
  assert.equal(schemaStringLimit(definition),8000);assert.deepEqual(definition,before);
  assert.equal(schemaStringLimit({oneOf:[{type:'string',maxLength:2},{type:'string',maxLength:17}]}),17);
  assert.equal(schemaStringLimit({allOf:[{type:'string',maxLength:2},{type:'string',maxLength:17}]}),17);
  assert.equal(schemaStringLimit({type:['string','null'],maxLength:5}),5);
  assert.equal(schemaStringLimit({enum:[{['long key '.repeat(20)]:['a','😀']},'abc']}),3);
  assert.equal(schemaStringLimit({const:{['long key '.repeat(20)]:'😀'}}),2);
  assert.equal(schemaStringLimit(closed({['long key '.repeat(20)]:{type:'boolean'}})),0);
  assert.equal(schemaStringLimit({type:'string',enum:['tiny','😀']}),4);
  assert.equal(schemaStringLimit({type:'array',items:{type:'string',maxLength:9}}),9);
  assert.equal(schemaStringLimit({type:'array',prefixItems:[{type:'string',maxLength:7}],items:false}),7);
  assert.equal(schemaStringLimit({type:'array',maxItems:1,prefixItems:[{type:'string',maxLength:3},{}]}),3);
  assert.equal(schemaStringLimit({type:'array',items:[{type:'string',maxLength:6}],additionalItems:false}),6);
  assert.equal(schemaStringLimit({type:'array',maxItems:0}),0);
  assert.equal(schemaStringLimit({type:'string',maxLength:0}),0);
});

test('unbounded, open, referenced or unknown string schemas disable the early check',()=>{
  for(const definition of [undefined,true,{},{$ref:'#/$defs/value'},{$dynamicRef:'#value'},
    {type:'string'},{maxLength:3},{type:'string',maxLength:-1},{type:'string',maxLength:1.5},
    {type:['string','object'],maxLength:3},{type:'array'},{type:'array',maxItems:2},
    {type:'array',items:{type:'string'}},{type:'array',prefixItems:[{type:'string',maxLength:2}]},
    {type:'object',properties:{text:{type:'string',maxLength:8}}},
    {type:'object',additionalProperties:{type:'string',maxLength:8},properties:{}},
    {type:'object',additionalProperties:false,properties:{text:{}}},
    {anyOf:[{type:'string',maxLength:5},{type:'string'}]},
    {oneOf:[{const:'bounded'},{type:'object'}]},{allOf:[{},{}]},
  ])assert.equal(schemaStringLimit(definition),null,JSON.stringify(definition));
  const cyclic={type:'array'};cyclic.items=cyclic;assert.equal(schemaStringLimit(cyclic),null);
  assert.equal(schemaStringLimit({anyOf:[{type:'string',maxLength:3},{$ref:'#/$defs/value'}]}),null);
  assert.equal(schemaStringLimit({anyOf:[{type:'string',maxLength:3},{type:'object',properties:{},additionalProperties:true}]}),null);
  assert.equal(schemaStringLimit({type:'string',maxLength:7,anyOf:[{enum:['tiny']},{}]}),7);
});

test('non-JSON and cyclic literal constraints do not invent a finite string limit',()=>{
  const cyclic={};cyclic.self=cyclic;
  const accessor=Object.defineProperty({},'value',{enumerable:true,get(){throw new Error('Do not evaluate schema literal accessors');}});
  const toJSON=Object.defineProperty({},'toJSON',{value:()=> 'unmodelled string'});
  for(const value of [undefined,NaN,Infinity,1n,Symbol('value'),()=>'',new Date(0),new Map(),cyclic,accessor,toJSON,Array(2)])
    assert.equal(schemaStringLimit({const:value}),null);
  assert.equal(schemaStringLimit({enum:['bounded',{nested:undefined}]}),null);
});

test('an unfinished value string stops only after the original 8000-unit schema bound and releases its reader',{timeout:1000},async()=>{
  let cancelled=0,aborted;
  const incoming=response([event(chunk({content:'{"next":"'+ 'x'.repeat(6875)})),
    event(chunk({content:' '.repeat(1125)})),event(chunk({content:' '}))],{open:true,onCancel:()=>cancelled++});
  await assert.rejects(streamJsonResponse(incoming,{stringLimit:8000,abort:error=>{aborted=error;}}),error=>{
    assert.equal(error.reason,'agent_schema');
    assert.deepEqual(JSON.parse(error.feedback),{path:'output',keyword:'streamStringLimit',expected:{max_length:8000},actual:{length:8001}});
    assert.doesNotMatch(JSON.stringify(error),/next|xxxxx/);return true;
  });
  assert.equal(aborted.reason,'agent_schema');assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

for(const encoded of ['"\\u0041"','"\\ud83d\\ude00"','"😀"','"\\ud800"','"\\\\u0041"','"\\"\\\\\\/\\b\\f\\n\\r\\t"','"한글"'])
test('string accounting uses decoded UTF-16 across every delta and byte boundary: '+encoded,async()=>{
  const content='{"value":'+encoded+'}',decoded=JSON.parse(content).value,fragments=[];
  for(let index=0;index<content.length;index++)fragments.push(event(chunk({content:content[index]})));
  const wire=fragments.join('')+event(chunk({},'stop'))+event('[DONE]');
  const parts=Array.from(encoder.encode(wire),byte=>Uint8Array.of(byte));
  const restored=await (await streamJsonResponse(response(parts),{stringLimit:decoded.length})).json();
  assert.equal(JSON.parse(restored.choices[0].message.content).value,decoded);
  const tooShort=response(fragments,{open:true});
  await assert.rejects(streamJsonResponse(tooShort,{stringLimit:decoded.length-1}),{reason:'agent_schema'});
});

test('string bounds apply to nested object/array values individually without limiting keys, prose, reasoning or total output',async()=>{
  const value={['PRIVATE_LONG_KEY '.repeat(1000)]:['abc',{nested:'def'},['ghi']],empty:''};
  const prefix='"PRIVATE_PROSE_PREFIX '.repeat(1)+'p'.repeat(10000)+'" ';
  const content=prefix+JSON.stringify(value);
  const incoming=response([event(chunk({reasoning:'r'.repeat(20000),reasoning_content:'s'.repeat(20000),content})),
    event(chunk({},'stop')),event('[DONE]')]);
  const restored=await (await streamJsonResponse(incoming,{stringLimit:3})).json();
  assert.equal(restored.choices[0].message.content,content);
  assert.equal(restored.choices[0].message.reasoning.length,20000);
  const rootString=JSON.stringify('a'.repeat(12000));
  assert.equal((await (await streamJsonResponse(completion(rootString),{stringLimit:0})).json()).choices[0].message.content,rootString);
  const many={values:Array(1000).fill('a'.repeat(100))};
  assert.deepEqual(JSON.parse((await (await streamJsonResponse(completion(many),{stringLimit:100})).json()).choices[0].message.content),many);
  assert.deepEqual(JSON.parse((await (await streamJsonResponse(completion({empty:''}),{stringLimit:0})).json()).choices[0].message.content),{empty:''});
  await assert.rejects(streamJsonResponse(response([event(chunk({content:'["a'}))],{open:true}),{stringLimit:0}),{reason:'agent_schema'});
});

test('unknown string bounds impose no replacement length cap',async()=>{
  const value={text:'PRIVATE_RESPONSE_SENTINEL '+ ' '.repeat(20000)};
  for(const stringLimit of [null,undefined,-1,Infinity,1.5]){
    const restored=await (await streamJsonResponse(completion(value),{stringLimit})).json();
    assert.deepEqual(JSON.parse(restored.choices[0].message.content),value);
  }
});

test('escaped long property names and fenced JSON retain their original value-string boundary',async()=>{
  const value={['\\ " 😀 key '.repeat(100)]:'a'},fence=String.fromCharCode(96).repeat(3);
  const content=fence+'json\n'+JSON.stringify(value)+'\n'+fence,parts=[];
  for(let offset=0;offset<content.length;offset+=11)parts.push(event(chunk({content:content.slice(offset,offset+11)})));
  parts.push(event(chunk({},'stop')));
  const restored=await (await streamJsonResponse(response(parts),{stringLimit:1,completeJson:true})).json();
  assert.equal(restored.choices[0].message.content,content);assert.equal(restored.choices[0].finish_reason,'stop');
});

test('decoded string overflow remains an error in JSON-completion mode, never a partial completed value',async()=>{
  let cancelled=0;
  const incoming=response([event(chunk({content:'{"x":"\\u0041\\u0042'}))],{open:true,onCancel:()=>cancelled++});
  await assert.rejects(streamJsonResponse(incoming,{stringLimit:1,completeJson:true}),{reason:'agent_schema'});
  assert.equal(cancelled,1);
  const restored=await streamJsonResponse(response([event(chunk({content:'{"x":"\\u0041"}'}))],{open:true}),{stringLimit:1,completeJson:true});
  assert.equal(restored[JSON_STREAM_COMPLETE],true);
  assert.deepEqual(JSON.parse((await restored.json()).choices[0].message.content),{x:'A'});
});

for(const failure of [null,'source','schema'])test('original string bound survives inference-schema stripping and all new attempts still require original validators: '+(failure||'repaired'),async()=>{
  const original={type:'object',properties:{next:{type:'string',maxLength:8}},required:['next'],additionalProperties:false};
  const before=structuredClone(original),calls=[],seen=[],logs=[];let cancelled=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,input,signal:options.signal});
    if(calls.length===1)assert.equal(body.response_format.json_schema.schema.properties.next.maxLength,undefined);
    else assert.deepEqual(body.response_format,{type:'json_object'});
    assert.deepEqual(input.output_schema,original);assert.deepEqual(input.data,{source:'PRIVATE_SOURCE_SENTINEL'});
    for(const key of ['max_tokens','max_completion_tokens','num_predict','stop'])assert.equal(Object.hasOwn(body,key),false);
    if(calls.length===1)return response([event(chunk({content:'{"next":"PRIVATE_RESPONSE_SENTINEL'}))],{open:true,onCancel:()=>cancelled++});
    if(calls.length===2){
      assert.equal(JSON.parse(input.validation_feedback).keyword,'streamStringLimit');
      assert.equal(input.rejected_output,undefined);
    }
    return completion(failure==='schema'?{next:true}:{next:calls.length===2||failure==='source'?'forged':'trusted'});
  },{streamCompleteJson:true,diagnosticLogger:entry=>logs.push(entry)});
  const pending=model.operation({},operation=>model.agentComplete('card_next','원래 원문으로 검증하세요.',
    {source:'PRIVATE_SOURCE_SENTINEL'},original,operation,value=>{
      seen.push(structuredClone(value));validateSchema(value,original,'output',true);
      if(value.next!=='trusted'){const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic rejected source');error.modelReason='agent_evidence';throw error;}
      return value;
    }));
  if(failure)await assert.rejects(pending,{code:'MODEL_INVALID_RESPONSE',modelReason:failure==='source'?'agent_evidence':'agent_schema'});
  else assert.deepEqual(await pending,{next:'trusted'});
  assert.equal(calls.length,3);assert.equal(seen.length,2);assert.ok(seen.every(value=>!JSON.stringify(value).includes('PRIVATE_RESPONSE_SENTINEL')));
  assert.equal(cancelled,1);assert.equal(calls[0].signal.aborted,true);assert.deepEqual(original,before);
  assert.deepEqual(calls.map(({body})=>body.response_format.type),['json_schema','json_object','json_object']);
  assert.equal(logs.filter(entry=>entry.event==='model_attempt')[0].reason,'agent_schema');
  const fallback=logs.filter(entry=>entry.event==='model_format_fallback');assert.equal(fallback.length,1);
  assert.equal(fallback[0].reason,'agent_schema');assert.equal(fallback[0].feedback_keyword,'streamStringLimit');
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_SOURCE_SENTINEL|PRIVATE_RESPONSE_SENTINEL/);
});

test('string overflow format recovery succeeds with provider termination and resets for the next generation',async()=>{
  const original={type:'object',properties:{next:{type:'string',maxLength:8}},required:['next'],additionalProperties:false};
  const calls=[],logs=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);calls.push(body);
    assert.deepEqual(input.data,{source:'PRIVATE_SOURCE_SENTINEL'});assert.deepEqual(input.output_schema,original);
    if(calls.length===1)return response([event(chunk({content:'{"next":"'+ ' '.repeat(9)}))],{open:true});
    return completion({next:'trusted'});
  },{diagnosticLogger:entry=>logs.push(entry)});
  const results=await model.operation({},async operation=>{
    const invoke=stage=>model.agentComplete(stage,'원문만 검토하세요.',{source:'PRIVATE_SOURCE_SENTINEL'},original,operation,value=>{
      validations++;validateSchema(value,original,'output',true);assert.equal(value.next,'trusted');return value;
    });
    return [await invoke('card_next'),await invoke('another_stage')];
  });
  assert.deepEqual(results,[{next:'trusted'},{next:'trusted'}]);assert.equal(validations,2);
  assert.deepEqual(calls.map(body=>body.response_format.type),['json_schema','json_object','json_schema']);
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>[entry.reason,entry.finish_reason]),
    [['agent_schema',null],['success','stop'],['success','stop']]);
  assert.equal(model.agentFormat,'json_schema');
});

test('unbounded strings still reach full validation without a schema format fallback',async()=>{
  const original={type:'object',properties:{next:{type:'string'}},required:['next'],additionalProperties:false};
  const calls=[],logs=[],value={next:'PRIVATE_RESPONSE_SENTINEL '+ ' '.repeat(10000)};let validations=0;
  const model=gateway(async(_url,options)=>{
    calls.push(JSON.parse(options.body));return completion(value);
  },{streamCompleteJson:true,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(model.operation({},operation=>model.agentComplete('card_next','원문만 검토하세요.',{},original,operation,candidate=>{
    validations++;validateSchema(candidate,original,'output',true);assert.deepEqual(candidate,value);
    throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic source rejection'),{modelReason:'agent_evidence'});
  })),{modelReason:'agent_evidence'});
  assert.equal(validations,3);assert.equal(calls.length,3);
  assert.ok(calls.every(body=>body.response_format.type==='json_schema'));
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
});

test('nonstream length rejection retains the provider format and original validator on every attempt',async()=>{
  const original={type:'object',properties:{next:{type:'string',maxLength:8}},required:['next'],additionalProperties:false};
  const calls=[],logs=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);assert.equal(body.stream,false);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({next:'longer than eight'})},finish_reason:'stop'}]}),
      {headers:{'content-type':'application/json'}});
  },{streamJson:false,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(model.operation({},operation=>model.agentComplete('card_next','원문만 검토하세요.',{},original,operation,value=>{
    validations++;return validateSchema(value,original,'output',true);
  })),error=>error.modelReason==='agent_schema'&&JSON.parse(error.modelFeedback).keyword==='maxLength');
  assert.equal(validations,3);assert.equal(calls.length,3);
  assert.ok(calls.every(body=>body.response_format.type==='json_schema'));
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
});

test('a field-specific maxLength rejection below the shared stream bound keeps JSON schema format',async()=>{
  const original={type:'object',properties:{next:{type:'string',maxLength:8},other:{type:'string',maxLength:40}},
    required:['next','other'],additionalProperties:false};
  const calls=[],logs=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    calls.push(JSON.parse(options.body));return completion({next:'longer than eight',other:'valid'});
  },{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(model.operation({},operation=>model.agentComplete('card_next','원문만 검토하세요.',{},original,operation,value=>{
    validations++;return validateSchema(value,original,'output',true);
  })),error=>error.modelReason==='agent_schema'&&JSON.parse(error.modelFeedback).keyword==='maxLength');
  assert.equal(validations,3);assert.equal(calls.length,3);
  assert.ok(calls.every(body=>body.response_format.type==='json_schema'));
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
});

test('validator feedback cannot impersonate the internal stream string guard to change formats',async()=>{
  const calls=[],logs=[];
  const model=gateway(async(_url,options)=>{calls.push(JSON.parse(options.body));return completion({okay:true});},
    {diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(model.operation({},operation=>model.agentComplete('synthetic_stage','원문만 검토하세요.',{},schema,operation,()=>{
    throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic validator rejection'),{modelReason:'agent_schema',
      modelFeedback:JSON.stringify({path:'output',keyword:'streamStringLimit',expected:{max_length:0},actual:{length:1}})});
  })),{modelReason:'agent_schema'});
  assert.equal(calls.length,3);assert.ok(calls.every(body=>body.response_format.type==='json_schema'));
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
});

for(const newline of ['\n','\r\n','\r'])test('SSE frames preserve UTF-8, all reasoning fields and usage with newline '+JSON.stringify(newline),async()=>{
  const wire='\uFEFF: heartbeat'+newline+newline+'event: message'+newline+'data: '+JSON.stringify(chunk({role:'assistant',content:null}))+newline+newline+
    event(chunk({reasoning:'생각 😀',reasoning_content:'추가 생각',content:'{"text":"한글😀"}'}),newline)+
    'data: {"choices":'+newline+'data: [{"index":0,"delta":{},"finish_reason":"stop"}]}'+newline+newline+
    event({choices:[],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}},newline)+event('[DONE]',newline);
  const bytes=encoder.encode(wire),parts=Array.from(bytes,value=>Uint8Array.of(value));
  let cancelled=0;
  const incoming=response(parts,{open:true,onCancel:()=>cancelled++,headers:{'x-test':'preserved','content-length':'999','content-encoding':'identity'}});
  const restored=await streamJsonResponse(incoming);
  const value=await restored.json();
  assert.equal(value.id,'synthetic-id');assert.equal(value.model,'synthetic-model');assert.equal(value.created,10);
  assert.deepEqual(value.choices,[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"text":"한글😀"}',
    reasoning:'생각 😀',reasoning_content:'추가 생각'}}]);
  assert.deepEqual(value.usage,{prompt_tokens:10,completion_tokens:20,total_tokens:30});
  assert.equal(restored.headers.get('content-type'),'application/json');assert.equal(restored.headers.get('x-test'),'preserved');
  assert.equal(restored.headers.get('content-length'),null);assert.equal(restored.headers.get('content-encoding'),null);
  assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

test('4096 outside-string whitespace characters are accepted across content and wire boundaries',async()=>{
  const fragments=['{',' '.repeat(2048),' '.repeat(2048),'"okay":true}'];
  const wire=fragments.map(content=>event(chunk({content}))).join('')+event(chunk({},'stop'))+event('[DONE]');
  const parts=Array.from({length:Math.ceil(wire.length/31)},(_,index)=>wire.slice(index*31,(index+1)*31));
  const payload=await (await streamJsonResponse(response(parts))).json();
  assert.deepEqual(JSON.parse(payload.choices[0].message.content),{okay:true});
});

test('4097 outside-string whitespace characters stop the owned attempt and release the reader',async()=>{
  let cancelled=0,aborted;
  const incoming=response([event(chunk({content:'{'+ ' '.repeat(2048)})),event(chunk({content:' '.repeat(2049)}))],
    {open:true,onCancel:()=>cancelled++});
  await assert.rejects(streamJsonResponse(incoming,{abort:error=>{aborted=error;}}),error=>{
    assert.ok(error instanceof ModelStreamError);assert.equal(error.reason,'stream_whitespace_stall');
    assert.equal(error.message,'Invalid model event stream');return true;
  });
  assert.equal(aborted.reason,'stream_whitespace_stall');assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

test('escaped quotes, long strings, reasoning whitespace and many productive whitespace runs have no total cap',async()=>{
  const value={text:'escaped " \\ 😀 '+ ' '.repeat(10000)+' PRIVATE_RESPONSE_SENTINEL '.repeat(9000)};
  const content=JSON.stringify(value),parts=[];
  for(let offset=0;offset<content.length;offset+=7)parts.push(event(chunk({content:content.slice(offset,offset+7)})));
  parts.unshift(event(chunk({reasoning:' '.repeat(12000),reasoning_content:' '.repeat(15000)})));
  parts.push(event(chunk({},'stop'))); // A normal EOF is accepted even without [DONE].
  const restored=await (await streamJsonResponse(response(parts))).json();
  assert.deepEqual(JSON.parse(restored.choices[0].message.content),value);
  assert.equal(restored.choices[0].message.reasoning.length,12000);
  assert.equal(restored.choices[0].message.reasoning_content.length,15000);
  const spaced='{'+Array.from({length:12},(_,i)=>' '.repeat(2000)+'"key'+i+'":'+i).join(',')+'}';
  assert.equal((await (await streamJsonResponse(completion(spaced))).json()).choices[0].message.content,spaced);
});

test('array bound follows every nested schema branch and leaves the original schema intact',()=>{
  const nested={type:'object',additionalProperties:false,properties:{rows:{type:'array',maxItems:2,items:{
    anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{values:{type:'array',maxItems:5,items:{type:'string'}}}}],
  }}}};
  const before=structuredClone(nested);
  assert.equal(schemaArrayLimit(nested),5);
  assert.equal(schemaArrayLimit({anyOf:[nested,{type:'array',maxItems:8,items:{type:'boolean'}}]}),8);
  assert.equal(schemaArrayLimit({const:{values:[1,2,3]}}),3);
  assert.equal(schemaArrayLimit({enum:[{values:[1]},[1,2,3,4]]}),4);
  assert.equal(schemaArrayLimit({allOf:[{type:'array',maxItems:2,items:{type:'string'}},{}]}),2);
  assert.equal(schemaArrayLimit({type:'object',properties:{okay:{type:'boolean'}},additionalProperties:false}),0);
  assert.deepEqual(nested,before);
});

test('unknown schemas and any unbounded nested value disable the early array check',()=>{
  for(const value of [undefined,true,{},{$ref:'#/$defs/row'},
    {type:'array',items:{type:'string'}},{type:'array',maxItems:3},
    {type:'object',properties:{rows:{type:'array',maxItems:2,items:{type:'string'}}}},
    {type:'object',additionalProperties:false,properties:{rows:{type:'array',maxItems:2,items:{}}}},
    {anyOf:[{type:'array',maxItems:2,items:{type:'string'}},{}]},
    {allOf:[{},{}]},
  ])assert.equal(schemaArrayLimit(value),null,JSON.stringify(value));
  const cyclic={type:'array',maxItems:2};cyclic.items=cyclic;
  assert.equal(schemaArrayLimit(cyclic),null);
});

test('tuple and closed empty array schemas preserve their safe global upper bounds',()=>{
  assert.equal(schemaArrayLimit({type:'array',maxItems:0}),0);
  assert.equal(schemaArrayLimit({type:'array',maxItems:2,prefixItems:[{type:'string'},{type:'number'}],items:false}),2);
  assert.equal(schemaArrayLimit({type:'array',maxItems:2,items:[{type:'array',maxItems:7,items:{type:'string'}},{type:'number'}],additionalItems:false}),7);
  assert.equal(schemaArrayLimit({type:'array',maxItems:3,prefixItems:[{type:'string'}]}),null);
});

test('a never-ending array is cancelled at the original finite schema upper bound', {timeout:1000},async()=>{
  let cancelled=0,aborted;
  const incoming=response([event(chunk({content:'{"rows":[{"text":"PRIVATE_RESPONSE_SENTINEL"},true,null,'})),
    event(chunk({content:'{"text":"fourth"}'}))],{open:true,onCancel:()=>cancelled++});
  await assert.rejects(streamJsonResponse(incoming,{arrayLimit:3,abort:error=>{aborted=error;}}),error=>{
    assert.equal(error.reason,'agent_schema');
    assert.deepEqual(JSON.parse(error.feedback),{path:'output',keyword:'streamArrayLimit',expected:{max_count:3},actual:{count:4}});
    assert.doesNotMatch(JSON.stringify(error),/PRIVATE_|fourth/);return true;
  });
  assert.equal(aborted.reason,'agent_schema');assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

test('nested arrays, primitives, escapes and Unicode are counted across delta and byte boundaries',async()=>{
  const value={rows:[{text:'한글😀, ] [ " \\ 문자열',nested:[1,2,3,4,5]},null],
    empty:[],primitives:[true,false,null,-1,1.25]};
  const content=JSON.stringify(value),fragments=[];
  for(let offset=0;offset<content.length;offset+=3)fragments.push(event(chunk({content:content.slice(offset,offset+3)})));
  const wire=fragments.join('')+event(chunk({},'stop'))+event('[DONE]');
  const bytes=Array.from(encoder.encode(wire),value=>Uint8Array.of(value));
  const output=await (await streamJsonResponse(response(bytes),{arrayLimit:5})).json();
  assert.deepEqual(JSON.parse(output.choices[0].message.content),value);
});

test('empty arrays accept a zero bound and the first value rejects without waiting for finish',async()=>{
  assert.deepEqual(JSON.parse((await (await streamJsonResponse(completion({rows:[]}),{arrayLimit:0})).json()).choices[0].message.content),{rows:[]});
  await assert.rejects(streamJsonResponse(response([event(chunk({content:'{"rows":[0'}))],{open:true}),{arrayLimit:0}),{reason:'agent_schema'});
});

test('root arrays use the same finite bound as nested arrays',async()=>{
  const payload=await (await streamJsonResponse(completion([{},null]),{arrayLimit:2})).json();
  assert.deepEqual(JSON.parse(payload.choices[0].message.content),[{},null]);
  await assert.rejects(streamJsonResponse(response([event(chunk({content:'[{},null,'})),event(chunk({content:'true'}))],
    {open:true}),{arrayLimit:2}),{reason:'agent_schema'});
});

test('bounded arrays do not impose any string, reasoning or total output cap',async()=>{
  const value={rows:['escaped " \\ 😀 , [ ] '+'PRIVATE_RESPONSE_SENTINEL '.repeat(6000)]};
  const wire=[event(chunk({reasoning:' '.repeat(20000),reasoning_content:'[1,2,3]'.repeat(5000)})),
    event(chunk({content:JSON.stringify(value)})),event(chunk({},'stop')),event('[DONE]')];
  const output=await (await streamJsonResponse(response(wire),{arrayLimit:1})).json();
  assert.deepEqual(JSON.parse(output.choices[0].message.content),value);
  assert.equal(output.choices[0].message.reasoning.length,20000);
  assert.equal(output.choices[0].message.reasoning_content.length,35000);
});

test('a second root object or array cancels an unfinished bounded JSON stream immediately', {timeout:1000},async()=>{
  for(const content of ['{}{}','{} []','[] {}','[][]']){
    let cancelled=0,aborted;
    const parts=Array.from(content,char=>event(chunk({content:char})));
    const incoming=response(parts,{open:true,onCancel:()=>cancelled++});
    await assert.rejects(streamJsonResponse(incoming,{arrayLimit:3,abort:error=>{aborted=error;}}),error=>{
      assert.equal(error.reason,'content_json');
      assert.equal(error.message,'Invalid model event stream');
      assert.equal(error.feedback,undefined);return true;
    });
    assert.equal(aborted.reason,'content_json');assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
  }
});

test('missing commas or colons reject the next quoted or container value before a stalled finish', {timeout:1000},async()=>{
  const malformed=[
    '{"outer":{"done":{}} "PRIVATE_UNKNOWN_KEY":{',
    '{"outer":{"done":{}} {',
    '{"outer":{"done":{}} [',
    '{"key" "PRIVATE_RESPONSE_SENTINEL"',
    '{"key" {',
    '{"key" [',
    '{"key":true "PRIVATE_UNKNOWN_KEY"',
    '{"key":null {',
    '{"key":-1.25e+2 [',
    '[{} "PRIVATE_RESPONSE_SENTINEL"',
    '[{} {',
    '[[] [',
    '[false "PRIVATE_RESPONSE_SENTINEL"',
  ];
  for(const content of malformed){
    let cancelled=0,aborted;
    const parts=Array.from(content,char=>event(chunk({content:char})));
    const incoming=response(parts,{open:true,onCancel:()=>cancelled++});
    await assert.rejects(streamJsonResponse(incoming,{arrayLimit:9,abort:error=>{aborted=error;}}),error=>{
      assert.equal(error.reason,'content_json');assert.equal(error.feedback,undefined);
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE_/);return true;
    });
    assert.equal(aborted.reason,'content_json');assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
  }
});

test('valid empty and escaped keys, nested containers and primitive delimiters survive fragmented input',async()=>{
  const nested='{"":"empty","esc\\\"aped":{"":-1.25e+2,"null":null,"bool":true},'+
    '"fa\\u0063ts":[false,0,"quoted \\\" } { , : [ ]"],"list":[{},[],{"":""}]}';
  for(const content of ['{}','[]','{"":""}',nested,'```json\n'+nested+'\n```']){
    const fragments=[];
    for(let offset=0;offset<content.length;offset+=2)fragments.push(event(chunk({content:content.slice(offset,offset+2)})));
    fragments.push(event(chunk({},'stop')),event('[DONE]'));
    const bytes=encoder.encode(fragments.join('')),parts=[];
    for(let offset=0;offset<bytes.length;offset+=7)parts.push(bytes.slice(offset,offset+7));
    const output=await (await streamJsonResponse(response(parts),{arrayLimit:3,propertyArrayLimits:{facts:3}})).json();
    assert.equal(output.choices[0].message.content,content);
    assert.doesNotThrow(()=>JSON.parse(content.startsWith('```')?nested:content));
  }
});

test('one fenced JSON root preserves trailing fences, nested values and long quoted fake roots',async()=>{
  const value={text:'escaped " \\ 😀 } { ][ '.repeat(6000),rows:[{rows:[{},{}]},{text:'"facts": [{},{}]'}]};
  const content='```json\n'+JSON.stringify(value)+'\n``` \n';
  const fragments=[];
  for(let offset=0;offset<content.length;offset+=17)fragments.push(event(chunk({content:content.slice(offset,offset+17)})));
  fragments.unshift(event(chunk({reasoning:'{}[]'.repeat(10000),reasoning_content:'} {'.repeat(10000)})));
  fragments.push(event(chunk({},'stop')),event('[DONE]'));
  const wire=encoder.encode(fragments.join('')),bytes=[];
  for(let offset=0;offset<wire.length;offset+=31)bytes.push(wire.slice(offset,offset+31));
  const output=await (await streamJsonResponse(response(bytes),{arrayLimit:3})).json();
  assert.equal(output.choices[0].message.content,content);
  assert.equal(output.choices[0].message.reasoning.length,40000);
  assert.equal(output.choices[0].message.reasoning_content.length,30000);
});

test('an unspecified or unbounded schema preserves existing stream reconstruction for repeated roots',async()=>{
  const unbounded=schemaArrayLimit({type:'object',properties:{rows:{type:'array',items:{type:'string'}}}});
  assert.equal(unbounded,null);
  for(const content of ['{"first":true}{"second":true}','{"outer":{"done":{}} "next":{','{"key" "value"'])
    for(const options of [{},{arrayLimit:unbounded}]){
      const output=await (await streamJsonResponse(completion(content),options)).json();
      assert.equal(output.choices[0].message.content,content);
    }
});

test('an unbounded schema keeps accepting a productive array longer than other schema limits',async()=>{
  const output={rows:Array.from({length:30},(_,i)=>({text:String(i)}))};
  const limit=schemaArrayLimit({type:'object',additionalProperties:false,properties:{rows:{type:'array',items:{type:'object'}}}});
  assert.equal(limit,null);
  const restored=await (await streamJsonResponse(completion(output),{arrayLimit:limit})).json();
  assert.deepEqual(JSON.parse(restored.choices[0].message.content),output);
});

const closed=properties=>({type:'object',properties,additionalProperties:false});
const list=(maxItems,items={type:'string'})=>({type:'array',maxItems,items});

test('property bounds merge the largest outer bound across paths, unions and tuple items',()=>{
  const definition=closed({facts:list(3),safety_ids:list(9),
    other:{anyOf:[{type:'null'},closed({facts:list(7)})]},
    tuple:{type:'array',maxItems:2,prefixItems:[closed({facts:list(5)}),closed({facts:list(6)})],items:false}});
  const before=structuredClone(definition);
  assert.equal(schemaArrayLimit(definition),9);
  assert.deepEqual(schemaPropertyArrayLimits(definition),{facts:7,safety_ids:9,tuple:2});
  assert.deepEqual(definition,before);
  assert.deepEqual(schemaPropertyArrayLimits(closed({facts:{anyOf:[list(3),list(8),{type:'string'}]}})),{facts:8});
});

test('uncertain property names retain only the global array check',()=>{
  for(const definition of [undefined,{},closed({facts:{type:'array',items:{type:'string'}}}),
    {allOf:[closed({facts:list(3)}),{}]},
    {allOf:[closed({facts:list(3)}),{$ref:'#/$defs/unknown'}]},
    {type:'object',additionalProperties:false,properties:{facts:list(3)},patternProperties:{'.*':list(9)}},
    {type:'object',properties:{},enum:[{label:'fixed'}]},
    {anyOf:[closed({facts:list(3)}),{enum:[{facts:Array(9).fill('fixed')}]}]},
    closed({facts:{...list(3),enum:[['fixed']]}}),
  ])assert.equal(schemaPropertyArrayLimits(definition),null,JSON.stringify(definition));
});

test('facts rejects its fourth value even when another array permits nine values', {timeout:1000},async()=>{
  const definition=closed({facts:list(3,{type:'number'}),safety_ids:list(9)});
  let cancelled=0;
  const incoming=response([event(chunk({content:'{"facts":[1,2,3,'})),event(chunk({content:'4'}))],
    {open:true,onCancel:()=>cancelled++});
  await assert.rejects(streamJsonResponse(incoming,{arrayLimit:schemaArrayLimit(definition),
    propertyArrayLimits:schemaPropertyArrayLimits(definition)}),error=>{
    assert.equal(error.reason,'agent_schema');
    assert.deepEqual(JSON.parse(error.feedback),{path:'output',keyword:'streamArrayLimit',expected:{max_count:3},actual:{count:4}});
    assert.doesNotMatch(error.feedback,/facts|safety_ids/);return true;
  });
  assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

test('larger same-name variants and anonymous nested arrays retain their valid bounds',async()=>{
  const definition={anyOf:[closed({facts:list(3,{type:'number'}),safety_ids:list(9)}),
    closed({facts:list(7,{type:'number'}),safety_ids:list(9)})]};
  const value={facts:Array.from({length:7},(_,i)=>i),safety_ids:Array(9).fill('safe')};
  const output=await (await streamJsonResponse(completion(value),{arrayLimit:schemaArrayLimit(definition),
    propertyArrayLimits:schemaPropertyArrayLimits(definition)})).json();
  assert.deepEqual(JSON.parse(output.choices[0].message.content),value);
  const nestedDefinition=closed({facts:list(1,list(9,{type:'number'}))});
  const nested={facts:[Array.from({length:9},(_,i)=>i)]};
  const restored=await (await streamJsonResponse(completion(nested),{arrayLimit:schemaArrayLimit(nestedDefinition),
    propertyArrayLimits:schemaPropertyArrayLimits(nestedDefinition)})).json();
  assert.deepEqual(JSON.parse(restored.choices[0].message.content),nested);
});

test('escaped property names are decoded while matching words inside values are ignored',async()=>{
  const properties={facts:3,'한글😀':2};
  for(const name of ['fa\\u0063ts','\\ud55c\\uae00\\ud83d\\ude00']){
    const values=name.startsWith('fa')?'1,2,3,4':'1,2,3';
    const wire=`{"${name}":[${values}`;
    const parts=[];for(let offset=0;offset<wire.length;offset++)parts.push(event(chunk({content:wire[offset]})));
    await assert.rejects(streamJsonResponse(response(parts,{open:true}),{arrayLimit:9,propertyArrayLimits:properties}),
      {reason:'agent_schema'});
  }
  const value={message:'"facts":[1,2,3,4]',word:'facts',other:Array(9).fill('safe'),'a"facts':Array(8).fill('safe')};
  const content=JSON.stringify(value),parts=[];
  for(let offset=0;offset<content.length;offset+=2)parts.push(event(chunk({content:content.slice(offset,offset+2)})));
  parts.push(event(chunk({},'stop')),event('[DONE]'));
  const output=await (await streamJsonResponse(response(parts),{arrayLimit:9,propertyArrayLimits:properties})).json();
  assert.deepEqual(JSON.parse(output.choices[0].message.content),value);
});

test('literal-array uncertainty disables precision and preserves a valid larger literal',async()=>{
  const value={facts:Array(9).fill('fixed')};
  const definition={anyOf:[closed({facts:list(3)}),{const:value}]};
  assert.equal(schemaPropertyArrayLimits(definition),null);
  const output=await (await streamJsonResponse(completion(value),{arrayLimit:schemaArrayLimit(definition),
    propertyArrayLimits:schemaPropertyArrayLimits(definition)})).json();
  assert.deepEqual(JSON.parse(output.choices[0].message.content),value);
});

test('gateway cancels an overfull array and repairs with sanitized feedback before validation',async()=>{
  const definition={...closed({facts:list(3,{type:'number'}),safety_ids:list(9)}),required:['facts','safety_ids']};
  const source={source:'PRIVATE_SOURCE_SENTINEL'},calls=[],logs=[];
  const valid={facts:[1,2,3],safety_ids:Array(9).fill('safe')};
  let cancelled=0,validated=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);
    calls.push({body,input});
    if(calls.length===1)return response([event(chunk({content:'{"facts":[1,2,3,4'}))],
      {open:true,onCancel:()=>cancelled++});
    assert.deepEqual(input.data,source);assert.deepEqual(input.output_schema,definition);
    assert.equal(input.rejected_output,undefined);
    assert.deepEqual(JSON.parse(input.validation_feedback),{path:'output',keyword:'streamArrayLimit',expected:{max_count:3},actual:{count:4}});
    assert.doesNotMatch(input.validation_feedback,/PRIVATE_|facts/);
    return completion(valid);
  },{agentFormat:'prompt',diagnosticLogger:entry=>logs.push(entry)});
  const result=await model.operation({},operation=>model.agentComplete('synthetic_array_stage','Return the required object.',
    source,definition,operation,value=>{validated++;return validateSchema(value,definition,'output',true);}));
  assert.deepEqual(result,valid);assert.equal(cancelled,1);assert.equal(validated,1);assert.equal(calls.length,2);
  for(const {body} of calls)for(const key of ['max_tokens','max_completion_tokens','num_predict'])assert.equal(Object.hasOwn(body,key),false);
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_schema','success']);
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|facts/);
});

test('gateway cancels repeated roots and retries the same source without a rejected partial or output cap',async()=>{
  const calls=[],logs=[];
  let cancelled=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);
    calls.push({body,input});
    if(calls.length===1)return response([event(chunk({content:'{"okay":false}'})),
      event(chunk({content:'{"PRIVATE_UNKNOWN_KEY":'}))],{open:true,onCancel:()=>cancelled++});
    assert.deepEqual(input.data,{source:'PRIVATE_SOURCE_SENTINEL'});assert.deepEqual(input.output_schema,schema);
    assert.equal(input.rejected_output,undefined);
    return completion({okay:true});
  },{agentFormat:'prompt',diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),{okay:true});
  assert.equal(cancelled,1);assert.equal(calls.length,2);
  for(const {body} of calls)for(const key of ['max_tokens','max_completion_tokens','num_predict'])assert.equal(Object.hasOwn(body,key),false);
  assert.deepEqual(logs.map(entry=>entry.reason),['content_json','success']);
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_/);
});

test('gateway retries missing delimiters without exposing or validating the rejected partial',async()=>{
  let attempts=0,cancelled=0,validated=0;
  const logs=[];
  const model=gateway(async(_url,options)=>{
    attempts++;
    const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    assert.deepEqual(input.data,{source:'PRIVATE_SOURCE_SENTINEL'});assert.deepEqual(input.output_schema,schema);
    assert.equal(input.rejected_output,undefined);
    if(attempts===1)return response([event(chunk({content:'{"okay":true "PRIVATE_UNKNOWN_KEY":{'}))],
      {open:true,onCancel:()=>cancelled++});
    return completion({okay:true});
  },{agentFormat:'prompt',diagnosticLogger:entry=>logs.push(entry)});
  const output=await model.operation({},operation=>model.agentComplete('synthetic_delimiter_stage','Return the required object.',
    {source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,value=>{validated++;return validateSchema(value,schema,'output',true);}));
  assert.deepEqual(output,{okay:true});assert.equal(attempts,2);assert.equal(cancelled,1);assert.equal(validated,1);
  assert.deepEqual(logs.map(entry=>entry.reason),['content_json','success']);
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_/);
});

test('three partial array overflows retain the existing structural recovery metadata',async()=>{
  const definition={...closed({facts:list(3,{type:'number'}),safety_ids:list(9)}),required:['facts','safety_ids']};
  let attempts=0,cancelled=0,validated=0;
  const model=gateway(async()=>{
    attempts++;
    return response([event(chunk({content:'{"facts":[1,2,3,4'}))],{open:true,onCancel:()=>cancelled++});
  },{agentFormat:'prompt'});
  await assert.rejects(model.operation({},operation=>model.agentComplete('turn_draft','Return the required object.',
    {source:'PRIVATE_SOURCE_SENTINEL'},definition,operation,value=>{validated++;return validateSchema(value,definition,'output',true);})),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_schema');
    assert.equal(error.modelAttempts,3);assert.equal(error.modelStructuralFailures,3);
    assert.doesNotMatch(error.modelFeedback,/PRIVATE_|facts/);return true;
  });
  assert.equal(attempts,3);assert.equal(cancelled,3);assert.equal(validated,0);
});

for(const [name,parts,reason] of [
  ['broken event JSON',[event('{PRIVATE_RESPONSE_SENTINEL')],'stream_json'],
  ['stream error',[event({error:{message:'PRIVATE_RESPONSE_SENTINEL'}})],'stream_error'],
  ['missing choices',[event({PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE_SENTINEL'})],'stream_envelope'],
  ['second choice',[event({choices:[{index:0,delta:{}},{index:1,delta:{}}]})],'stream_envelope'],
  ['wrong choice index',[event({choices:[{index:1,delta:{content:'{}'},finish_reason:'stop'}]})],'stream_envelope'],
  ['missing delta',[event({choices:[{index:0,finish_reason:'stop'}]})],'stream_envelope'],
  ['invalid delta',[event(chunk({content:{PRIVATE_UNKNOWN_KEY:true}}))],'stream_envelope'],
  ['invalid role',[event(chunk({role:'user',content:'{}'}))],'stream_envelope'],
  ['duplicate finish',[event(chunk({},'stop')),event(chunk({},'stop'))],'stream_envelope'],
  ['text after finish',[event(chunk({},'stop')),event(chunk({content:'{}'}))],'stream_envelope'],
  ['done before finish',[event(chunk({content:'{}'})),event('[DONE]')],'stream_finish'],
  ['EOF before finish',[event(chunk({content:'{}'}))],'stream_finish'],
  ['usage only',[event({choices:[],usage:{total_tokens:10}}),event('[DONE]')],'stream_finish'],
  ['invalid UTF-8',[Uint8Array.of(0xff)],'stream_encoding'],
])test('invalid SSE rejects without leaking source values: '+name,async()=>{
  const incoming=response(parts);
  await assert.rejects(streamJsonResponse(incoming),error=>{
    assert.ok(error instanceof ModelStreamError);assert.equal(error.reason,reason);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_'));assert.ok(!error.message.includes('PRIVATE_'));return true;
  });
  assert.equal(incoming.body.locked,false);
});

test('non-SSE successful responses are rejected and their unread body is released',async()=>{
  let cancelled=0;
  const incoming=response(['PRIVATE_RESPONSE_SENTINEL'],{open:true,onCancel:()=>cancelled++,headers:{'content-type':'application/json'}});
  await assert.rejects(streamJsonResponse(incoming),{reason:'stream_content_type'});
  assert.equal(cancelled,1);assert.equal(incoming.body.locked,false);
});

test('transport failures keep their original connection classification',async()=>{
  const failure=Object.assign(new Error('PRIVATE_CONNECTION_SENTINEL'),{code:'ECONNRESET'});
  const incoming=new Response(new ReadableStream({start(controller){controller.error(failure);}}),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(streamJsonResponse(incoming),error=>error===failure);
  assert.equal(incoming.body.locked,false);
});

test('caller cancellation interrupts a stalled reader and removes its signal listener',async()=>{
  let pulled,cancels=0;
  const started=new Promise(resolve=>{pulled=resolve;}),controller=new AbortController(),reason=new Error('synthetic cancellation');
  const incoming=new Response(new ReadableStream({pull(){pulled();},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
  const pending=streamJsonResponse(incoming,{signal:controller.signal});
  await started;controller.abort(reason);
  await assert.rejects(pending,error=>error===reason);
  assert.equal(cancels,1);assert.equal(incoming.body.locked,false);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('streaming is opt-in and supports exact local aliases, loopback and RFC1918 IPv4 endpoints',async()=>{
  let calls=0;
  for(const options of [{baseUrl:'https://remote.example/v1'}, {baseUrl:'http://127.0.0.1.remote.example/v1'},
    ...['http://localhost.remote.example/v1','http://host.docker.internal.remote.example/v1','http://192.168.123.175.remote.example/v1','http://[::ffff:192.0.2.1]/v1',
      'http://[::ffff:192.168.123.175]/v1','http://[fd00::1]/v1','http://9.255.255.255/v1','http://11.0.0.0/v1',
      'http://172.15.255.255/v1','http://172.32.0.0/v1','http://192.167.255.255/v1','http://192.169.0.0/v1',
      'http://100.64.0.1/v1','http://169.254.1.2/v1','http://165.194.161.61:20522/v1','http://224.0.0.1/v1',
      'http://0.0.0.0/v1'].map(baseUrl=>({baseUrl})),
    {streamJson:'true'},{streamJson:1}]){
    const model=gateway(async()=>{calls++;},options);
    assert.equal(model.configured,false);
    await assert.rejects(generate(model),{code:'MODEL_NOT_CONFIGURED'});
  }
  assert.equal(calls,0);
  for(const baseUrl of ['http://localhost:11434/v1','http://host.docker.internal:11434/v1','http://127.0.0.1:11434/v1','http://127.2.3.4/v1','http://127.1/v1','http://[::1]/v1',
    'http://10.0.0.0/v1','http://10.255.255.255/v1','http://172.16.0.0/v1','http://172.31.255.255/v1',
    'http://192.168.0.0/v1','http://192.168.255.255/v1','http://192.168.123.175:11434/v1','https://192.168.123.175/v1'])
    assert.equal(gateway(async()=>{}, {baseUrl}).configured,true);
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.stream,false);assert.equal(body.stream_options,undefined);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"okay":true}'}}]}));
  },{baseUrl:'https://remote.example/v1',streamJson:false});
  assert.deepEqual(await generate(model),{okay:true});
  const defaultModel=new ModelGateway({baseUrl:'https://remote.example/v1',apiKey:'synthetic',fetchImpl:async()=>{}});
  assert.equal(defaultModel.streamJson,false);assert.equal(defaultModel.configured,true);
});

test('an explicitly configured LAN stream keeps the endpoint, authentication, whitespace fallback and validators',async()=>{
  const requests=[],url='http://192.168.123.175:11434/v1';let validations=0;
  const model=gateway(async(endpoint,options)=>{
    assert.equal(endpoint,url+'/chat/completions');assert.equal(options.headers.Authorization,'Bearer PRIVATE_KEY_SENTINEL');
    const body=JSON.parse(options.body);requests.push(body);assert.equal(body.stream,true);
    return completion(requests.length===1?' '.repeat(4097):{okay:true});
  },{baseUrl:url});
  const output=await model.operation({},operation=>model.agentComplete('synthetic_stage','현재 원문만 검토하세요.',
    {source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,value=>{validations++;return validateSchema(value,schema,'output',true);}));
  assert.deepEqual(output,{okay:true});assert.equal(validations,1);assert.equal(requests.length,2);
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_schema','json_object']);
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content).data,JSON.parse(requests[0].messages.at(-1).content).data);
});

test('whitespace fallback is local to one generation and preserves source, stage, schema and validators',async()=>{
  const requests=[],signals=[],logs=[],progress=[];let calls=0,validations=0,cancelled=0;
  const source='PRIVATE_SOURCE_SENTINEL '+ '한글😀 원문 '.repeat(2500);
  const model=gateway(async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:11434/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer PRIVATE_KEY_SENTINEL');
    const body=JSON.parse(options.body);requests.push(body);signals.push(options.signal);calls++;
    assert.equal(body.stream,true);assert.deepEqual(body.stream_options,{include_usage:true});
    for(const key of ['max_tokens','max_completion_tokens','num_predict'])assert.equal(Object.hasOwn(body,key),false);
    return calls===1?response([event(chunk({content:' '.repeat(4097)}))],{open:true,onCancel:()=>cancelled++}):completion({okay:true});
  },{retryFailures:false,diagnosticLogger:entry=>logs.push(entry)});
  let operationSignal;
  const result=await model.operation({onProgress:value=>progress.push(value)},async operation=>{
    operationSignal=operation.controller.signal;assert.equal(operation.deadline,Infinity);
    const invoke=stage=>model.agentComplete(stage,'원문만 검토하세요.',{source},schema,operation,value=>{
      validations++;return validateSchema(value,schema,'output',true);
    });
    const first=await invoke('draft_one');
    assert.equal(getEventListeners(operationSignal,'abort').length,0);
    const second=await invoke('review_two');
    assert.equal(getEventListeners(operationSignal,'abort').length,0);
    return [first,second];
  });
  assert.deepEqual(result,[{okay:true},{okay:true}]);assert.equal(validations,2);assert.equal(cancelled,1);
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_schema','json_object','json_schema']);
  assert.deepEqual(requests.map(body=>JSON.parse(body.messages.at(-1).content).stage),['draft_one','draft_one','review_two']);
  assert.equal(requests[0].messages.at(-1).content,requests[1].messages.at(-1).content);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).data.source,source);
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content).output_schema,schema);
  assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);assert.equal(signals[2].aborted,false);
  assert.equal(operationSignal.aborted,false);assert.equal(new Set(signals).size,3);
  assert.deepEqual(progress.map(value=>[value.stage,value.status]),[['draft_one','started'],['draft_one','started'],
    ['draft_one','completed'],['review_two','started'],['review_two','completed']]);
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),['stream_whitespace_stall','success','success']);
  const fallback=logs.find(entry=>entry.event==='model_format_fallback');
  assert.equal(fallback.from,'json_schema');assert.equal(fallback.to,'json_object');assert.equal(fallback.reason,'stream_whitespace_stall');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));assert.equal(model.agentFormat,'json_schema');
});

test('fallback never bypasses source validation or its existing three-attempt ceiling',async()=>{
  const requests=[],logs=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return requests.length===1?response([event(chunk({content:' '.repeat(4097)}))]):completion({okay:true});
  },{retryFailures:false,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(model.operation({},operation=>model.agentComplete('analysis','독립된 원문 검토',{source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,()=>{
    validations++;throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','원문 불일치'),{modelReason:'agent_evidence'});
  })),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_evidence'});
  assert.equal(validations,2);assert.equal(requests.length,3);
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_schema','json_object','json_object']);
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),['stream_whitespace_stall','agent_evidence','agent_evidence']);
});

test('combined streaming fallback still requires an independently audited state review',async()=>{
  const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','밤에 계획표를 고쳐요.')}},supporter:{fields:{}},
    user_goal:{message:field('want','옆에서 이야기를 듣고 싶어요.')},answered_count:3,
    latest_answer:{subject:'patient',question_id:'mood'},adaptive_questions:true,question_candidates:[],clarification_candidates:[]};
  const ref={subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요.'};
  const draft={state:{patient_state:{facts:[{...ref,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[{evidence:[ref],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  for(const guard of ['whitespace','string_limit'])for(const [validReview,streamCompleteJson] of [[true,false],[false,false],[true,true],[false,true]]){
    const requests=[];
    const model=gateway(async(_url,options)=>{
      const request=JSON.parse(options.body),input=JSON.parse(request.messages.at(-1).content);requests.push(request);
      if(requests.length===1){
        const limit=schemaStringLimit(input.output_schema);assert.ok(Number.isSafeInteger(limit));
        return response([event(chunk({content:guard==='whitespace'?' '.repeat(4097):
          '{"state":{"patient_state":{"unknowns":["'+ 'x'.repeat(limit+1)}))]);
      }
      if(input.stage==='turn_draft')return completion(draft);
      if(input.stage==='safety_review')return completion(safetyReviewFixture(input.data));
      assert.equal(input.stage,'turn_review');
      return completion({state:{approved:true,issues:[],audits:validReview?input.data.review_target.claims.map(claim=>({id:claim.id,
        verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'})):[]},questions:null,safety:null});
    },{streamCompleteJson});
    if(validReview){const output=await model.updateState(ctx);assert.equal(output.state_agent.reviewed,true);}
    else await assert.rejects(model.updateState(ctx),{code:'MODEL_INVALID_RESPONSE'});
    assert.deepEqual(requests.slice(0,3).map(body=>JSON.parse(body.messages.at(-1).content).stage),['turn_draft','turn_draft','turn_review']);
    assert.deepEqual(requests.slice(0,3).map(body=>body.response_format.type),['json_schema','json_object','json_schema']);
    assert.equal(requests.length,validReview?4:5);
  }
});

for(const [name,makeResponse] of [
  ['schema failure',()=>completion({unexpected:true})],
  ['malformed SSE',()=>response([event('{PRIVATE_RESPONSE_SENTINEL')])],
  ['nonstop completion',()=>completion({okay:true},'length')],
])test('ordinary failures never change JSON format: '+name,async()=>{
  const requests=[],logs=[];
  const model=gateway(async(_url,options)=>{requests.push(JSON.parse(options.body));return makeResponse();},{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(requests.length,3);assert.ok(requests.every(body=>body.response_format.type==='json_schema'));
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('a guard failure cannot manufacture a schema format when configured for JSON object or prompt',async()=>{
  for(const agentFormat of ['json_object','prompt']){
    const requests=[],logs=[];
    const model=gateway(async(_url,options)=>{requests.push(JSON.parse(options.body));return response([event(chunk({content:' '.repeat(4097)}))]);},
      {agentFormat,diagnosticLogger:entry=>logs.push(entry)});
    await assert.rejects(generate(model),{code:'MODEL_INVALID_RESPONSE',modelReason:'stream_whitespace_stall'});
    assert.equal(requests.length,3);
    assert.ok(requests.every(body=>agentFormat==='prompt'?body.response_format===undefined:body.response_format.type==='json_object'));
    assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
  }
});

test('HTTP rejection, authentication and transient retry behavior stay outside the SSE adapter',async()=>{
  for(const [status,code] of [[401,'MODEL_AUTH_FAILED'],[403,'MODEL_AUTH_FAILED'],[307,'MODEL_UPSTREAM_ERROR']]){
    let calls=0,cancels=0;
    const model=gateway(async()=>{calls++;return new Response(new ReadableStream({cancel(){cancels++;}}),{status,
      headers:{location:'https://remote.example/private'}});});
    await assert.rejects(generate(model),{code});assert.equal(calls,1);assert.equal(cancels,1);
  }
  const requests=[];
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return requests.length===1?new Response('PRIVATE_UPSTREAM_SENTINEL',{status:429,headers:{'retry-after':'0'}}):completion({okay:true});
  });
  assert.deepEqual(await generate(model),{okay:true});assert.equal(requests.length,2);
  assert.ok(requests.every(body=>body.response_format.type==='json_schema'));
});

test('external cancellation stops an active streaming request without timeout, fallback or another attempt',async()=>{
  let pulled,cancels=0,calls=0,attemptSignal;
  const started=new Promise(resolve=>{pulled=resolve;}),controller=new AbortController(),logs=[];
  const model=gateway(async(_url,options)=>{
    calls++;attemptSignal=options.signal;
    return new Response(new ReadableStream({pull(){pulled();},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
  },{retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  const pending=generate(model,{signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,{code:'MODEL_CANCELLED'});
  assert.equal(calls,1);assert.equal(cancels,1);assert.equal(attemptSignal.aborted,true);
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),['cancelled']);
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'||entry.event==='model_operation_retry'),false);
});


test('local completion frames a full JSON root, cancels an open repeat stream and validates once',async()=>{
  let cancels=0,validations=0;const logs=[];
  const model=gateway(async()=>response([event(chunk({content:'  {"okay":true}\n```json\n{'}))],{open:true,onCancel:()=>cancels++}),
    {streamCompleteJson:true,diagnosticLogger:entry=>logs.push(entry)});
  const result=await model.operation({},operation=>model.agentComplete('analysis','원문 검토',{source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,value=>{
    validations++;validateSchema(value,schema,'output',true);return value;
  }));
  assert.deepEqual(result,{okay:true});assert.equal(cancels,1);assert.equal(validations,1);
  assert.equal(logs.at(-1).finish_reason,'json_complete');assert.equal(logs.at(-1).reason,'success');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('local completion handles escaped braces, Unicode, arbitrary chunk boundaries and unbounded arrays',async()=>{
  const value={text:'한글 😀 { } " \\ ',rows:Array.from({length:50},(_,i)=>i)};
  const wire=event(chunk({content:JSON.stringify(value)}));
  const bytes=encoder.encode(wire),parts=Array.from(bytes,byte=>Uint8Array.of(byte));
  const incoming=response(parts,{open:true});
  const restored=await streamJsonResponse(incoming,{completeJson:true});
  assert.equal(restored[JSON_STREAM_COMPLETE],true);
  const payload=await restored.json();assert.equal(payload.choices[0].finish_reason,null);
  assert.deepEqual(JSON.parse(payload.choices[0].message.content),value);assert.equal(incoming.body.locked,false);
});

for(const content of ['{"okay":tru','{"okay":true,}','{"okay" true}','{"okay":[1,]}','{"okay":true]'])
  test('local completion never accepts incomplete or malformed JSON '+content,async()=>{
    const model=gateway(async()=>response([event(chunk({content}))]),{streamCompleteJson:true});
    await assert.rejects(generate(model),{code:'MODEL_INVALID_RESPONSE'});
  });

for(const finish of ['length','content_filter','tool_calls','function_call','unknown','json_complete'])
  test('local completion honors explicit buffered provider failure '+finish,async()=>{
    for(const separateFrame of [false,true]){
      const wire=separateFrame?event(chunk({content:'{"okay":true}'}))+event(chunk({},finish)):
        event(chunk({content:'{"okay":true}'},finish));
      const model=gateway(async()=>response([wire]),{streamCompleteJson:true});
      await assert.rejects(generate(model),{code:'MODEL_INVALID_RESPONSE',modelReason:'finish_reason'});
    }
  });

test('local completion retains a genuine provider stop and cannot be enabled by provider JSON',async()=>{
  const logs=[];
  const model=gateway(async()=>response([event(chunk({content:'{"okay":true}'},'stop'))]),
    {streamCompleteJson:true,diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),{okay:true});assert.equal(logs.at(-1).finish_reason,'stop');
  const spoof=gateway(async()=>completion({okay:true},'json_complete'));
  await assert.rejects(generate(spoof),{modelReason:'finish_reason'});
});

test('complete local JSON still fails the original schema and source validators',async()=>{
  for(const kind of ['schema','source']){
    let calls=0,validations=0;
    const model=gateway(async()=>{calls++;return response([event(chunk({content:JSON.stringify(kind==='schema'?{wrong:true}:{okay:true})}))],{open:true});},
      {streamCompleteJson:true});
    await assert.rejects(model.operation({},operation=>model.agentComplete('analysis','검토',{},schema,operation,value=>{
      validations++;validateSchema(value,schema,'output',true);
      throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','원문 불일치'),{modelReason:'agent_evidence'});
    })),{code:'MODEL_INVALID_RESPONSE',modelReason:kind==='schema'?'agent_schema':'agent_evidence'});
    assert.equal(calls,3);assert.equal(validations,3);
  }
});

test('schema-less requests retain provider termination even when local completion is configured',async()=>{
  const model=gateway(async()=>response([event(chunk({content:'{"okay":true}'}))]),{streamCompleteJson:true});
  await assert.rejects(model.operation({},operation=>model.request(()=>({messages:[]}),operation,value=>value,'legacy')),
    {code:'MODEL_INVALID_RESPONSE',modelReason:'stream_finish'});
});
