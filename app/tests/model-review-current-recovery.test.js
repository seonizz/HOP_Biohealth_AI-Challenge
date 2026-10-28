import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {validateSchema} from '../src/relationship-agent.js';

const schema={type:'object',properties:{approved:{type:'boolean'},issues:{type:'array',items:{type:'string'}}},
  required:['approved','issues'],additionalProperties:false};
const approved={approved:true,issues:[]};
const stale={approved:false,issues:['PRIVATE_OBSOLETE_WORDING']};
const payload=()=>({answers:{source:'PRIVATE_CURRENT_SOURCE'},guide:{next:'PRIVATE_CURRENT_GUIDE'},
  claims:[{id:'next.0',claim:'PRIVATE_CURRENT_GUIDE'}],plan:{intent:'PRIVATE_CURRENT_INTENT'},
  retrieval:{documents:[{text:'PRIVATE_CURRENT_SOURCE'}]},
  revision:{before:'PRIVATE_OBSOLETE_WORDING',after:'PRIVATE_CURRENT_GUIDE',previous_review:stale}});
const rejection=(reason='agent_review_stale',feedback='PRIVATE_OBSOLETE_WORDING')=>
  Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 검토 반려'),{modelReason:reason,modelFeedback:feedback});
const gateway=(handler,options={})=>new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'PRIVATE_CREDENTIAL',
  model:'synthetic-model',protocol:'relationship_agent',timeoutMs:0,diagnosticLogger:null,...options,
  fetchImpl:async(_url,request)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',
    message:{content:JSON.stringify(await handler(JSON.parse(JSON.parse(request.body).messages.at(-1).content)))}}]}))});
const generate=(model,data,validate,options={},stage='speech_review_card_next_after_repair_1')=>
  model.operation(options,operation=>model.agentComplete(stage,'원문과 현재 답안을 검토하세요.',data,schema,operation,validate));

for(const stage of ['speech_review_card_next_after_repair_1','support_review_after_repair'])
test('a stale reviewer retries only the current source and guide: '+stage,async()=>{
  const inputs=[],logs=[],data=payload(),before=structuredClone(data);
  const model=gateway(input=>{inputs.push(input);return inputs.length===1?stale:approved;},
    {diagnosticLogger:entry=>logs.push(entry)});
  let validations=0;
  assert.deepEqual(await generate(model,data,value=>{
    validateSchema(value,schema);if(++validations===1)throw rejection();return value;
  },{},stage),approved);
  assert.equal(validations,2);assert.equal(inputs.length,2);assert.deepEqual(data,before);
  assert.deepEqual(inputs[0].data,before);
  const {revision,...current}=before;assert.deepEqual(inputs[1].data,current);
  assert.deepEqual(inputs[1].output_schema,schema);
  assert.equal(inputs[1].rejected_output,undefined);assert.equal(inputs[1].repair_task,undefined);
  assert.match(inputs[1].validation_feedback,/agent_review_stale/);
  assert.ok(!JSON.stringify(inputs[1]).includes('PRIVATE_OBSOLETE_WORDING'));
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('a current-only review cannot bypass repeated stale or unsupported-current rejection',async()=>{
  for(const reason of ['agent_review_stale','agent_claim_audit']){
    const inputs=[],logs=[],model=gateway(input=>{inputs.push(input);return approved;},
      {retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
    // Isolate the bounded request here; the outer guide owner keeps its existing policy.
    let validations=0;
    await assert.rejects(model.operation({},operation=>model.agentComplete('speech_review',
      '현재 원문 전체를 검토하세요.',payload(),schema,operation,()=>{
        if(++validations===1)throw rejection();throw rejection(reason,'현재 주장을 원문으로 확인하세요.');
      }),{retryFailures:false}),{code:'MODEL_INVALID_RESPONSE',modelReason:reason});
    assert.equal(validations,3);assert.equal(inputs.length,3);
    assert.ok(inputs.slice(1).every(input=>input.data.revision===undefined));
    assert.equal(logs.some(entry=>entry.event==='model_operation_retry'),false);
  }
});

test('a schema error after a fresh review receives its own details without old review text',async()=>{
  const inputs=[],model=gateway(input=>{inputs.push(input);return inputs.length===1?stale:inputs.length===2?{issues:[]}:approved;});
  let validations=0;
  assert.deepEqual(await generate(model,payload(),value=>{
    validateSchema(value,schema);if(++validations===1)throw rejection();return value;
  }),approved);
  assert.equal(inputs.length,3);assert.equal(inputs[2].data.revision,undefined);
  assert.deepEqual(inputs[2].rejected_output,{issues:[]});
  assert.equal(JSON.parse(inputs[2].validation_feedback).keyword,'objectKeys');
  assert.ok(!JSON.stringify(inputs[2]).includes('PRIVATE_OBSOLETE_WORDING'));
});

test('ordinary review rejection retains its revision, candidate and existing repair contract',async()=>{
  const inputs=[],data=payload(),model=gateway(input=>{inputs.push(input);return inputs.length===1?stale:approved;});
  let validations=0;
  await generate(model,data,value=>{if(++validations===1)throw rejection('agent_review_targets','missing issue field');return value;});
  assert.deepEqual(inputs[1].data,data);assert.deepEqual(inputs[1].rejected_output,stale);
  assert.equal(inputs[1].validation_feedback,'missing issue field');
});

test('fresh-review state stays local to its stage and operation',async()=>{
  const inputs=[],counts=new Map(),model=gateway(input=>{
    inputs.push(input);const count=(counts.get(input.stage)||0)+1;counts.set(input.stage,count);
    return count===1?stale:approved;
  });
  const data=payload(),validate=value=>{if(!value.approved)throw rejection();return value;};
  const results=await Promise.all(['speech_review','support_review'].map(stage=>generate(model,data,validate,{},stage)));
  assert.deepEqual(results,[approved,approved]);
  for(const stage of ['speech_review','support_review']){
    const own=inputs.filter(input=>input.stage===stage);
    assert.deepEqual(own[0].data,data);assert.equal(own[1].data.revision,undefined);
  }
  await generate(model,data,validate,{},'speech_review');
  assert.deepEqual(inputs.at(-1).data,data);assert.equal(inputs.at(-1).validation_feedback,undefined);
});

test('cancellation stops a stale review before any fresh retry',async()=>{
  const controller=new AbortController(),inputs=[],model=gateway(input=>{inputs.push(input);return stale;});
  await assert.rejects(generate(model,payload(),()=>{controller.abort();throw rejection();},
    {signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(inputs.length,1);
});
