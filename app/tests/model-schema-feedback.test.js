import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schema=object({summary:{type:'string',maxLength:12},rows:{type:'array',minItems:1,maxItems:2,
  items:object({text:{type:'string',maxLength:8},approved:{type:'boolean'}})}});
const valid={summary:'합성 요약',rows:[{text:'합성 내용',approved:true}]};
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const failure=(reason='agent_schema',feedback)=>Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 검증 반려'),
  {modelReason:reason,...(feedback?{modelFeedback:feedback}:{})});
const gateway=(outputs,requests,logs)=>new ModelGateway({baseUrl:'https://synthetic-model.example/v1',apiKey:'PRIVATE_CREDENTIAL',
  model:'synthetic-model',protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,
  diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
    requests.push(JSON.parse(JSON.parse(options.body).messages.at(-1).content));
    return envelope(outputs[Math.min(requests.length-1,outputs.length-1)]);
  }});
const generate=(model,validator=value=>validateSchema(value,schema),outputSchema=schema)=>model.operation({},operation=>
  model.agentComplete('synthetic_review','합성 출력 계약을 검토하세요.',{source:'PRIVATE_SOURCE'},outputSchema,operation,validator));
const clean=input=>{
  for(const key of ['rejected_output','repair_task','validation_feedback'])assert.equal(Object.hasOwn(input,key),false);
};
const privateLogs=logs=>assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));

for(const [name,candidate,expected] of [
  ['missing root keys',{summary:'합성 요약',PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE'},
    {path:'output',keyword:'objectKeys',expected:{key_count:2,keys:['summary','rows']},
      actual:{key_count:2,missing_key_count:1,missing_keys:['rows'],extra_key_count:1}}],
  ['missing nested keys',{...valid,rows:[{text:'합성 내용'}]},
    {path:'output.rows[0]',keyword:'objectKeys',expected:{key_count:2,keys:['text','approved']},
      actual:{key_count:1,missing_key_count:1,missing_keys:['approved'],extra_key_count:0}}],
  ['nested string length',{...valid,rows:[{text:'PRIVATE_RESPONSE',approved:true}]},
    {path:'output.rows[0].text',keyword:'maxLength',expected:{max_length:8},actual:{length:16}}],
  ['array count',{...valid,rows:Array.from({length:3},()=>({...valid.rows[0]}))},
    {path:'output.rows',keyword:'maxItems',expected:{max_count:2},actual:{count:3}}],
  ['nested type',{...valid,rows:[{text:'합성 내용',approved:'PRIVATE_RESPONSE'}]},
    {path:'output.rows[0].approved',keyword:'type',expected:{type:'boolean'},actual:{type:'string'}}],
])test('a generic schema rejection supplies precise repair feedback for '+name,async()=>{
  const requests=[],logs=[],model=gateway([candidate,valid],requests,logs),errors=[];
  assert.deepEqual(await generate(model,value=>{
    try { return validateSchema(value,schema); }
    catch(error) { errors.push(error);throw error; }
  }),valid);
  assert.equal(requests.length,2);clean(requests[0]);assert.deepEqual(requests[1].rejected_output,candidate);
  assert.deepEqual(JSON.parse(requests[1].validation_feedback),expected);
  assert.equal(errors[0].modelFeedback,requests[1].validation_feedback);
  assert.equal(errors[0].modelReason,'agent_schema');assert.ok(!requests[1].validation_feedback.includes('PRIVATE_'));
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_schema','success']);privateLogs(logs);
  assert.deepEqual(logs[0].schema_failure,{path:expected.path,keyword:expected.keyword});
  assert.equal(Object.hasOwn(logs[1],'schema_failure'),false);
});

test('schema diagnostics retain only bounded allowlisted paths and keywords, never feedback values',async()=>{
  const requests=[],logs=[],feedback=JSON.stringify({path:'output.patient[2].evidence[0].quote',keyword:'enum',
    expected:{enum:['PRIVATE_SOURCE']},actual:'PRIVATE_RESPONSE',repair:'PRIVATE_REPAIR'});
  const model=gateway([valid],requests,logs);let validations=0;
  await generate(model,value=>{if(++validations===1)throw failure('agent_schema',feedback);return value;});
  assert.deepEqual(logs[0].schema_failure,{path:'output.patient[2].evidence[0].quote',keyword:'enum'});
  assert.deepEqual(Object.keys(logs[0].schema_failure),['path','keyword']);privateLogs(logs);
});

for(const feedback of [
  {path:'output.PRIVATE_SOURCE',keyword:'type'},
  {path:'output.rows[PRIVATE_SOURCE]',keyword:'type'},
  {path:'output.rows[10000]',keyword:'type'},
  {path:'output'+'.rows'.repeat(17),keyword:'type'},
  {path:'output.__proto__',keyword:'type'},
  {path:'output.rows',keyword:'PRIVATE_SOURCE'},
  {path:['PRIVATE_SOURCE'],keyword:'type'},
  null,
])test('schema diagnostics omit untrusted structural metadata: '+JSON.stringify(feedback),async()=>{
  const requests=[],logs=[],model=gateway([valid],requests,logs);let validations=0;
  await generate(model,value=>{if(++validations===1)throw failure('agent_schema',JSON.stringify(feedback));return value;});
  assert.equal(Object.hasOwn(logs[0],'schema_failure'),false);privateLogs(logs);
});

test('explicit custom schema feedback is preserved even when the wire format also fails',async()=>{
  const requests=[],logs=[],candidate={summary:'합성 요약'},feedback='{"path":"custom","keyword":"synthetic"}',error=failure('agent_schema',feedback);
  const model=gateway([candidate,valid],requests,logs);let validations=0;
  assert.deepEqual(await generate(model,value=>{if(++validations===1)throw error;return validateSchema(value,schema);}),valid);
  assert.equal(requests[1].validation_feedback,feedback);assert.equal(error.modelFeedback,feedback);
  assert.deepEqual(requests[1].rejected_output,candidate);privateLogs(logs);
});

test('feedback and rejected output use the pristine response before a failing validator mutates it',async()=>{
  const candidate={...valid,rows:[{text:'PRIVATE_RESPONSE',approved:true}]},requests=[],logs=[],error=failure();
  const model=gateway([candidate,valid],requests,logs);let validations=0;
  assert.deepEqual(await generate(model,value=>{
    if(++validations===1){value.rows[0].text='변경됨';value.rows.push({text:'추가됨',approved:false});delete value.summary;throw error;}
    return validateSchema(value,schema);
  }),valid);
  assert.deepEqual(requests[1].rejected_output,candidate);
  assert.deepEqual(JSON.parse(requests[1].validation_feedback),{path:'output.rows[0].text',keyword:'maxLength',
    expected:{max_length:8},actual:{length:16}});privateLogs(logs);
});

test('a schema-valid response rejected by a custom validator keeps the original rejection without invented wire feedback',async()=>{
  const requests=[],logs=[],error=failure(),model=gateway([valid],requests,logs);let validations=0;
  await assert.rejects(generate(model,value=>{
    validations++;value.rows[0].approved='PRIVATE_MUTATION';throw error;
  }),actual=>actual===error);
  assert.equal(validations,3);assert.equal(requests.length,3);assert.equal(error.modelFeedback,undefined);
  for(const request of requests.slice(1)){
    assert.equal(Object.hasOwn(request,'validation_feedback'),false);assert.deepEqual(request.rejected_output,valid);
  }
  privateLogs(logs);
});

test('a semantic rejection is not relabeled or augmented because its candidate also violates the wire schema',async()=>{
  const requests=[],logs=[],candidate={summary:'합성 요약'},error=failure('agent_claim_audit'),model=gateway([candidate,valid],requests,logs);
  let validations=0;
  assert.deepEqual(await generate(model,value=>{if(++validations===1)throw error;return validateSchema(value,schema);}),valid);
  assert.equal(error.modelReason,'agent_claim_audit');assert.equal(error.modelFeedback,undefined);
  assert.equal(Object.hasOwn(requests[1],'validation_feedback'),false);
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_claim_audit','success']);privateLogs(logs);
});

test('custom normalization can still accept a response outside the wire schema without a retry',async()=>{
  const candidate={...valid,PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE',rows:Array.from({length:3},()=>({...valid.rows[0]}))};
  const requests=[],logs=[],model=gateway([candidate],requests,logs);
  const normalized={...valid,rows:[...valid.rows,{...valid.rows[0]}]};
  assert.deepEqual(await generate(model,value=>{
    delete value.PRIVATE_UNKNOWN_KEY;value.rows=value.rows.slice(0,2);return validateSchema(value,schema);
  }),normalized);
  assert.equal(requests.length,1);clean(requests[0]);assert.deepEqual(logs.map(entry=>entry.reason),['success']);privateLogs(logs);
});

test('schema enrichment preserves the original terminal error and the three-attempt budget',async()=>{
  const requests=[],logs=[],error=failure(),candidate={summary:'합성 요약'},model=gateway([candidate],requests,logs);
  await assert.rejects(generate(model,()=>{throw error;}),actual=>actual===error);
  assert.equal(error.message,'합성 검증 반려');assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_schema');
  assert.equal(error.modelAttempts,3);assert.equal(requests.length,3);
  assert.equal(JSON.parse(error.modelFeedback).keyword,'objectKeys');privateLogs(logs);
});

test('schema feedback and rejected candidates stay within one stage and operation',async()=>{
  const requests=[],logs=[],candidate={summary:'합성 요약'},model=gateway([candidate,valid],requests,logs);
  await model.operation({},async operation=>{
    for(const stage of ['synthetic_review','synthetic_next'])assert.deepEqual(await model.agentComplete(stage,'합성 계약',{},schema,operation,
      value=>validateSchema(value,schema)),valid);
  });
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,4);
  clean(requests[0]);clean(requests[2]);clean(requests[3]);assert.deepEqual(requests[1].rejected_output,candidate);
  assert.equal(JSON.parse(requests[1].validation_feedback).keyword,'objectKeys');privateLogs(logs);
});

test('source-bearing schema candidates, unknown keys and model values stay out of feedback and diagnostics',async()=>{
  const outputSchema=object({quote:{enum:['PRIVATE_ENUM_SOURCE']},certainty:{const:'reported'}}),requests=[],logs=[];
  const candidate={quote:'PRIVATE_MODEL_VALUE',certainty:'reported'},approved={quote:'PRIVATE_ENUM_SOURCE',certainty:'reported'};
  const model=gateway([candidate,approved],requests,logs);
  assert.deepEqual(await generate(model,value=>validateSchema(value,outputSchema),outputSchema),approved);
  assert.deepEqual(JSON.parse(requests[1].validation_feedback),{path:'output.quote',keyword:'enum',
    expected:{enum_count:1},actual:{type:'string'}});
  assert.ok(!requests[1].validation_feedback.includes('PRIVATE_'));privateLogs(logs);
});

test('schema diagnostics parse only the first JSON line and never log appended repair prose',async()=>{
  const requests=[],logs=[],model=gateway([valid],requests,logs);
  const feedback=JSON.stringify({path:'output.observations.patient[0]',keyword:'enum',actual:{type:'object',value:'PRIVATE_VALUE'}})+'\nPRIVATE_ADVICE 원문과 전체 근거 객체를 다시 확인하세요.';
  await assert.rejects(generate(model,()=>{throw failure('agent_schema',feedback);}),{modelReason:'agent_schema'});
  for(const entry of logs)assert.deepEqual(entry.schema_failure,{path:'output.observations.patient[0]',keyword:'enum'});
  assert.equal(requests[1].validation_feedback,feedback);privateLogs(logs);
  const badRequests=[],badLogs=[],badModel=gateway([valid],badRequests,badLogs);
  await assert.rejects(generate(badModel,()=>{throw failure('agent_schema','PRIVATE_INVALID\n'+JSON.stringify({path:'output.patient',keyword:'enum'}));}));
  assert.ok(badLogs.every(entry=>!entry.schema_failure));privateLogs(badLogs);
});
