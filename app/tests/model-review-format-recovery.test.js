import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway, inferenceSchema } from '../src/model.js';
import { validateSchema } from '../src/relationship-agent.js';
import { HttpError } from '../src/errors.js';

const schema={type:'object',properties:{state:{type:'object',properties:{approved:{type:'boolean'},
  issues:{type:'array',items:{type:'string'},maxItems:3}},required:['approved','issues'],additionalProperties:false},
  questions:{type:'null'},safety:{type:'null'}},required:['state','questions','safety'],additionalProperties:false};
const valid={state:{approved:true,issues:[]},questions:null,safety:null};
const missing={state:{approved:true,issues:[],PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE_SENTINEL'}};
const draftSchema={type:'object',properties:{state:{type:'object',properties:{patient_state:{type:'object',
  properties:{facts:{type:'array',items:{type:'string'},maxItems:3}},required:['facts'],additionalProperties:false}},
  required:['patient_state'],additionalProperties:false},questions:{type:'null'}},required:['state','questions'],additionalProperties:false};
const draftValid={state:{patient_state:{facts:['합성 관찰1','합성 관찰2','합성 관찰3']}},questions:null};
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
const stream=value=>new Response(frame({choices:[{index:0,delta:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:null}]})+
  frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const envelope=value=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]}));
const gateway=(fetchImpl,options={})=>new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'PRIVATE_CREDENTIAL_SENTINEL',model:'synthetic-model',
  protocol:'relationship_agent',streamJson:true,agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl,...options});
const generate=(model,{stage='turn_review',signal,requestSchema=schema,validate=value=>validateSchema(value,requestSchema,'output',true)}={})=>model.operation({signal},operation=>
  model.agentComplete(stage,'독립 검토 원문을 유지하세요.',{source:'PRIVATE_SOURCE_SENTINEL'},requestSchema,operation,validate));

for(const stage of ['turn_draft','turn_draft_after_review','turn_review','turn_review_after_review','state_review','state_review_after_review','question_review','safety_review'])
test('known local streaming state stages repair structural failures before receiving the same schema grammar: '+stage,async()=>{
  const requests=[],logs=[];let validations=0;
  const isDraft=stage.startsWith('turn_draft'),requestSchema=isDraft?draftSchema:schema,expected=isDraft?draftValid:valid;
  const invalid=stage==='turn_draft'?{state:{patient_state:{facts:[...draftValid.state.patient_state.facts,'초과 관찰']}},questions:null}
    :stage==='turn_draft_after_review'?{state:draftValid.state}:missing;
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));return stream(requests.length<=2?invalid:expected);
  },{preserveStringLimits:true,diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model,{stage,requestSchema,validate:value=>{validations++;return validateSchema(value,requestSchema,'output',true);}}),expected);
  assert.equal(validations,stage==='turn_draft'?1:3);assert.deepEqual(requests.map(body=>body.response_format.type),['json_object','json_object','json_schema']);
  assert.deepEqual(requests[2].response_format.json_schema,{name:stage,strict:true,schema:inferenceSchema(requestSchema,{preserveStringLimits:true})});
  const first=JSON.parse(requests[0].messages.at(-1).content),second=JSON.parse(requests[1].messages.at(-1).content),third=JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(first.rejected_output,undefined);assert.equal(first.validation_feedback,undefined);assert.equal(first.repair_task,undefined);
  assert.deepEqual(second.rejected_output,stage==='turn_draft'?undefined:invalid);
  assert.deepEqual(third.rejected_output,stage==='turn_draft'?undefined:invalid);
  assert.deepEqual(second.data,first.data);assert.deepEqual(second.output_schema,first.output_schema);assert.deepEqual(second.output_schema,requestSchema);
  assert.deepEqual(third.data,first.data);assert.deepEqual(third.output_schema,requestSchema);
  const feedback=JSON.parse(second.validation_feedback);
  if(stage==='turn_draft')assert.deepEqual(feedback,{path:'output.state.patient_state.facts',keyword:'streamArrayLimit',expected:{max_count:3},actual:{count:4}});
  else assert.deepEqual(feedback.actual.missing_keys,isDraft?['questions']:['questions','safety']);
  assert.ok(!second.validation_feedback.includes('PRIVATE_'));assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
  await generate(model,{stage,requestSchema});assert.equal(requests[3].response_format.type,'json_object');
  const fresh=JSON.parse(requests[3].messages.at(-1).content);assert.equal(fresh.rejected_output,undefined);assert.equal(fresh.validation_feedback,undefined);
});

test('repair messages, source and validator results stay identical to the existing nonstreaming repair contract',async()=>{
  const requests=[];
  for(const streamJson of [false,true]){
    const local=[];requests.push(local);
    const model=gateway(async(_url,options)=>{
      local.push(JSON.parse(options.body));const value=local.length===1?missing:valid;return streamJson?stream(value):envelope(value);
    },{streamJson});
    assert.deepEqual(await generate(model),valid);
  }
  assert.deepEqual(requests[0].map(body=>body.messages),requests[1].map(body=>body.messages));
  assert.deepEqual(requests[0].map(body=>body.response_format.type),['json_object','json_object']);
  assert.deepEqual(requests[1].map(body=>body.response_format.type),['json_object','json_object']);
});

test('schema grammar cannot approve a response that still omits required root keys',async()=>{
  const requests=[];let validations=0;
  const model=gateway(async(_url,options)=>{requests.push(JSON.parse(options.body));return stream(missing);});
  await assert.rejects(generate(model,{validate:value=>{validations++;return validateSchema(value,schema,'output',true);}}),
    {code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(validations,3);assert.deepEqual(requests.map(body=>body.response_format.type),['json_object','json_object','json_schema']);
});

for(const reason of ['agent_claim_audit','agent_unknown_audit','state_review_schema','agent_evidence'])
test('semantic and source rejection never promote the response format: '+reason,async()=>{
  const requests=[];
  const model=gateway(async(_url,options)=>{requests.push(JSON.parse(options.body));return stream(valid);});
  await assert.rejects(generate(model,{validate:()=>{throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 검토 거절'),{modelReason:reason});}}),
    {code:'MODEL_INVALID_RESPONSE',modelReason:reason});
  assert.equal(requests.length,3);assert.ok(requests.every(body=>body.response_format.type==='json_object'));
});

for(const [name,options,stage] of [
  ['remote nonstreaming',{baseUrl:'https://remote.example/v1',streamJson:false},'turn_review'],
  ['local nonstreaming',{streamJson:false},'turn_review'],
  ['already-schema',{agentFormat:'json_schema'},'turn_review'],
  ['prompt',{agentFormat:'prompt'},'turn_review'],
  ['guide generation',{},'guide_write'],['other state draft',{},'relationship_memory'],['state generation',{},'state'],
  ['unlisted review name',{},'turn_review_custom'],['unlisted suffix',{},'state_review_final'],
])test('format promotion leaves other requests unchanged: '+name,async()=>{
  const requests=[];
  const model=gateway(async(_url,request)=>{
    requests.push(JSON.parse(request.body));return options.streamJson===false?envelope(missing):stream(missing);
  },options);
  await assert.rejects(generate(model,{stage}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(requests.length,3);
  const expected=options.agentFormat==='prompt'?undefined:options.agentFormat==='json_schema'?'json_schema':'json_object';
  assert.ok(requests.every(body=>body.response_format?.type===expected));
});

test('initially valid combined drafts and reviews keep their original JSON-object format',async()=>{
  for(const stage of ['turn_draft','turn_draft_after_review','turn_review']){
    const requests=[];
    const model=gateway(async(_url,options)=>{requests.push(JSON.parse(options.body));return stream(valid);});
    assert.deepEqual(await generate(model,{stage}),valid);assert.equal(requests.length,1);assert.equal(requests[0].response_format.type,'json_object');
  }
});

test('a third-attempt grammar whitespace stall cannot add an extra attempt beyond the original ceiling',async()=>{
  const requests=[],logs=[],signals=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));signals.push(options.signal);
    return stream(requests.length<=2?missing:' '.repeat(4097));
  },{diagnosticLogger:entry=>logs.push(entry)});
  const pending=generate(model,{validate:value=>{validations++;return validateSchema(value,schema,'output',true);}});
  await assert.rejects(pending,{code:'MODEL_INVALID_RESPONSE',modelReason:'stream_whitespace_stall'});
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_object','json_object','json_schema']);
  assert.equal(validations,2);assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,true);
  assert.equal(signals[2].aborted,true);
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'),false);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('an earlier grammar whitespace fallback stays sticky when a later candidate needs schema repair',async()=>{
  const requests=[],logs=[];let validations=0;
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));return stream(requests.length===1?' '.repeat(4097):requests.length===2?missing:valid);
  },{agentFormat:'json_schema',diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model,{validate:value=>{validations++;return validateSchema(value,schema,'output',true);}}),valid);
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_schema','json_object','json_object']);assert.equal(validations,2);
  const second=JSON.parse(requests[1].messages.at(-1).content),third=JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(second.rejected_output,undefined);assert.deepEqual(third.rejected_output,missing);
  const fallbacks=logs.filter(entry=>entry.event==='model_format_fallback');assert.equal(fallbacks.length,1);
  assert.equal(fallbacks[0].from,'json_schema');assert.equal(fallbacks[0].to,'json_object');assert.equal(fallbacks[0].reason,'stream_whitespace_stall');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('external cancellation interrupts a promoted review without another attempt or format retry',async()=>{
  const controller=new AbortController(),requests=[],logs=[];let notify,cancels=0;
  const started=new Promise(resolve=>{notify=resolve;});
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));if(requests.length<=2)return stream(missing);
    if(requests.length===3)return new Response(new ReadableStream({pull(){notify();},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
    return stream(valid);
  },{retryFailures:true,diagnosticLogger:entry=>logs.push(entry)});
  const pending=generate(model,{signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,{code:'MODEL_CANCELLED'});
  assert.deepEqual(requests.map(body=>body.response_format.type),['json_object','json_object','json_schema']);assert.equal(cancels,1);
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),['agent_schema','agent_schema','cancelled']);
  assert.equal(logs.some(entry=>entry.event==='model_format_fallback'||entry.event==='model_operation_retry'),false);
  assert.deepEqual(await generate(model),valid);
  const fresh=JSON.parse(requests[3].messages.at(-1).content);
  assert.equal(requests[3].response_format.type,'json_object');assert.equal(fresh.rejected_output,undefined);assert.equal(fresh.validation_feedback,undefined);
});
