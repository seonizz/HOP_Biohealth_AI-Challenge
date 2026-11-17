import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const questions=object({skip:{type:'array',items:{type:'string'}},clarify:{type:'array',items:{type:'string'}},
  safety:object({urgent:{type:'boolean'},evidence_ids:{type:'array',items:{type:'string'}}})});
const schema=object({state:object({patient_state:object({facts:{type:'array',items:{type:'string'}},unknowns:{type:'array',items:{type:'string'}}}),
  name_index:{type:'null'}}),questions});
const valid={state:{patient_state:{facts:['PRIVATE_CURRENT_SOURCE'],unknowns:[]},name_index:null},
  questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
const wrong={state:valid.state,questions:[],clarify:[],safety:valid.questions.safety};
const malformed='{"skip":["PRIVATE_UNVALIDATED_VALUE"]},"clarify":[],"safety":{"urgent":false,"evidence_ids":[]}}';
const make=(outputs,{agentFormat='prompt'}={})=>{
  const inputs=[],requests=[],logs=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'PRIVATE_KEY',model:'synthetic',
    protocol:'relationship_agent',agentFormat,timeoutMs:0,retryFailures:false,diagnosticLogger:entry=>logs.push(entry),
    fetchImpl:async(_url,options)=>{
      const request=JSON.parse(options.body);requests.push(request);inputs.push(JSON.parse(request.messages.at(-1).content));
      const value=outputs[Math.min(inputs.length-1,outputs.length-1)];
      return Response.json({choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}]});
    }});
  return {model,inputs,requests,logs};
};
const run=(model,{stage='turn_draft',outputSchema=schema,validate=value=>validateSchema(value,outputSchema,'output',true)}={})=>
  model.operation({},operation=>model.agentComplete(stage,'합성 원문과 출력 계약을 지키세요.',
    {source:'PRIVATE_CURRENT_SOURCE'},outputSchema,operation,validate));
const privateLogs=logs=>assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));

test('prompt-only drafts receive schema-derived nesting without example facts or default verdicts',async()=>{
  const {model,inputs,requests,logs}=make([valid]);
  assert.deepEqual(await run(model),valid);
  const layout=inputs[0].output_object_layout;
  assert.deepEqual(layout,[{path:[],keys:['state','questions']},{path:['state'],keys:['patient_state','name_index']},
    {path:['state','patient_state'],keys:['facts','unknowns']},{path:['questions'],keys:['skip','clarify','safety']},
    {path:['questions','safety'],keys:['urgent','evidence_ids']}]);
  assert.ok(!JSON.stringify(layout).includes('PRIVATE_'));
  assert.equal(inputs[0].rejected_output,undefined);assert.equal(inputs[0].validation_feedback,undefined);
  assert.equal(requests[0].messages[0].content,'합성 원문과 출력 계약을 지키세요.');
  assert.match(inputs[0].output_layout_instruction,/output_schema/);
  assert.equal(requests[0].response_format,undefined);privateLogs(logs);
});

test('the first json_object request includes required decision nesting without fabricated answers or verdicts',async()=>{
  const outputSchema=object({...schema.properties,
    questions:object({...questions.properties,personalization:{type:'null'}})});
  const output={...structuredClone(valid),questions:{...structuredClone(valid.questions),
    safety:{urgent:true,evidence_ids:['PRIVATE_MODEL_SOURCE']},personalization:null}};
  const {model,inputs,requests,logs}=make([output],{agentFormat:'json_object'});
  assert.deepEqual(await run(model,{outputSchema}),output);
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0].response_format,{type:'json_object'});
  assert.deepEqual(inputs[0].output_schema,outputSchema);
  assert.deepEqual(inputs[0].output_object_layout,[
    {path:[],keys:['state','questions']},
    {path:['state'],keys:['patient_state','name_index']},
    {path:['state','patient_state'],keys:['facts','unknowns']},
    {path:['questions'],keys:['skip','clarify','safety','personalization']},
    {path:['questions','safety'],keys:['urgent','evidence_ids']},
  ]);
  // The layout contains key placement only, never a response template, source
  // excerpt, or a false/null/empty-array default for a model decision.
  assert.ok(inputs[0].output_object_layout.every(row=>Object.keys(row).join(',')==='path,keys'));
  assert.doesNotMatch(JSON.stringify(inputs[0].output_object_layout),/PRIVATE_|true|false|null/);
  assert.deepEqual(inputs[0].data,{source:'PRIVATE_CURRENT_SOURCE'});
  assert.equal(inputs[0].rejected_output,undefined);assert.equal(inputs[0].validation_feedback,undefined);
  assert.match(inputs[0].output_layout_instruction,/답안 예시가 아닙니다/u);
  privateLogs(logs);
});

test('a JSON failure replaces stale schema feedback and drops the older rejected wrapper',async()=>{
  const broken=JSON.stringify(wrong)+'}';
  const {model,inputs,logs}=make([wrong,broken,valid]);
  assert.deepEqual(await run(model),valid);
  assert.deepEqual(inputs[1].rejected_output,wrong);
  assert.equal(JSON.parse(inputs[1].validation_feedback).keyword,'objectKeys');
  const last=inputs[2],feedback=JSON.parse(last.validation_feedback);
  assert.equal(last.rejected_output,undefined);assert.equal(last.repair_task,undefined);
  assert.equal(feedback.keyword,'jsonSyntax');assert.equal(feedback.problem,'trailing_content');
  assert.equal(feedback.character_offset,broken.length-1);assert.equal(feedback.character_count,broken.length);
  assert.deepEqual(last.data,inputs[0].data);assert.deepEqual(last.output_schema,inputs[0].output_schema);
  assert.deepEqual(logs.map(row=>row.reason),['agent_schema','content_json','success']);privateLogs(logs);
});

for(const [name,content,problem] of [
  ['premature object close',malformed,'trailing_content'],
  ['extra trailing brace',JSON.stringify(valid)+'}','trailing_content'],
  ['second JSON object',JSON.stringify(valid)+'{}','trailing_content'],
  ['truncated object','{"questions":','incomplete_json'],
  ['prose prefix','PRIVATE_EXPLANATION '+JSON.stringify(valid),'invalid_json'],
  ['duplicate verdict','{"urgent":false,"ur\\u0067ent":true}','duplicate_key'],
])test('malformed JSON stays rejected after all retries: '+name,async()=>{
  const {model,inputs,logs}=make([content]);let validations=0;
  await assert.rejects(run(model,{validate:value=>{validations++;return value;}}),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'content_json');
    assert.equal(error.modelAttempts,3);assert.equal(JSON.parse(error.modelFeedback).problem,problem);
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
  });
  assert.equal(validations,0);assert.equal(inputs.length,3);
  for(const input of inputs.slice(1)){
    assert.equal(input.rejected_output,undefined);
    assert.equal(JSON.parse(input.validation_feedback).problem,problem);
  }
  privateLogs(logs);
});

test('a syntactically repaired response must still pass the original schema',async()=>{
  const {model,inputs,logs}=make([malformed,{skip:[],clarify:[],safety:{urgent:'PRIVATE_BAD_TYPE',evidence_ids:[]}}]);
  await assert.rejects(run(model,{stage:'turn_draft_block_questions',outputSchema:questions}),
    {code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:3});
  assert.equal(inputs.length,3);assert.equal(JSON.parse(inputs[2].validation_feedback.split('\n').at(-1)).path,'output.safety.urgent');
  privateLogs(logs);
});

test('syntax feedback and layout do not leak into another stage or change the requested wire format',async()=>{
  const {model,inputs,requests,logs}=make([malformed,valid],{agentFormat:'json_schema'});
  assert.deepEqual(await run(model),valid);assert.deepEqual(await run(model,{stage:'synthetic_next'}),valid);
  assert.equal(inputs[0].output_object_layout,undefined);assert.ok(inputs[1].output_object_layout.length);
  assert.equal(inputs[2].output_object_layout,undefined);assert.equal(inputs[2].validation_feedback,undefined);
  assert.equal(inputs[2].rejected_output,undefined);
  assert.ok(requests.every(request=>request.response_format.type==='json_schema'));privateLogs(logs);
});

for(const method of ['completeTrained','complete'])test('legacy JSON retries keep their own wire contract: '+method,async()=>{
  const {model,inputs,requests,logs}=make([malformed,valid]);
  const context={schema_version:'1.0',patient:{alias:'',fields:{}},supporter:{fields:{}},user_goal:{},answered_count:0,question_candidates:[]};
  const validate=value=>validateSchema(value,schema,'output',true);
  const result=await model.operation({},operation=>method==='completeTrained'
    ?model.completeTrained(context,null,false,operation,validate)
    :model.complete(context,null,'원래 합성 출력 계약입니다.',operation,validate));
  assert.deepEqual(result,valid);assert.equal(requests.length,2);
  assert.deepEqual(inputs[1],inputs[0]);
  const original=requests[0].messages[0].content,repair=requests[1].messages[0].content;
  assert.ok(repair.startsWith(original));
  assert.doesNotMatch(repair.slice(original.length),/validation_feedback|output_schema|output_object_layout|\bdata\b/);
  assert.match(repair.slice(original.length),/JSON 문법/);
  for(const input of inputs)for(const key of ['validation_feedback','output_object_layout','output_layout_instruction'])
    assert.equal(Object.hasOwn(input,key),false);
  assert.deepEqual(logs.map(row=>row.reason),['content_json','success']);privateLogs(logs);
});

for(const method of ['completeTrained','complete'])
for(const duplicate of ['{"approved":false,"appro\\u0076ed":true}',
  '{"review":{"approved":false,"approved":true}}'])
test('legacy model protocols reject overwritten JSON values before validation: '+method+' '+duplicate,async()=>{
  const accepted={approved:false};
  const {model,inputs,logs}=make([duplicate,accepted]);
  let validations=0;
  const validate=value=>{validations++;return value;};
  const context={patient:{fields:{}},supporter:{fields:{}},user_goal:{}};
  const result=await model.operation({},operation=>method==='completeTrained'
    ?model.completeTrained(context,null,false,operation,validate)
    :model.complete(context,null,'합성 출력 계약',operation,validate));
  assert.deepEqual(result,accepted);assert.equal(validations,1);assert.equal(inputs.length,2);
  assert.deepEqual(logs.map(entry=>entry.reason),['content_json','success']);
  privateLogs(logs);
});
