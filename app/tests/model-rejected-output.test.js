import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {validateSchema} from '../src/relationship-agent.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';

const schema={type:'object',properties:{state:{type:'object',properties:{approved:{type:'boolean'},
  issues:{type:'array',items:{type:'string'},maxItems:3}},required:['approved','issues'],additionalProperties:false},
  questions:{type:'null'},safety:{type:'null'}},required:['state','questions','safety'],additionalProperties:false};
const valid={state:{approved:true,issues:[]},questions:null,safety:null};
const invalid={state:{approved:true,issues:[],PRIVATE_UNKNOWN_KEY:'PRIVATE_REJECTED_SENTINEL'}};
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const gateway=(fetchImpl,options={})=>new ModelGateway({baseUrl:'https://synthetic-model.example/v1',apiKey:'PRIVATE_CREDENTIAL_SENTINEL',
  model:'synthetic-model',protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl,...options});
const body=options=>JSON.parse(JSON.parse(options.body).messages.at(-1).content);
const validate=value=>validateSchema(value,schema,'output',true);
const generate=(model,{stage='turn_review',validator=validate,signal}={})=>model.operation({signal},operation=>
  model.agentComplete(stage,'현재 원문과 출력 계약을 검토하세요.',{source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,validator));
const clean=input=>{
  assert.equal(Object.hasOwn(input,'rejected_output'),false);assert.equal(Object.hasOwn(input,'repair_task'),false);
  assert.equal(Object.hasOwn(input,'validation_feedback'),false);
};
const secretFree=logs=>assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));

test('a stateless repair receives exactly the failed parsed candidate and actual sanitized validator feedback',async()=>{
  const requests=[],logs=[];
  const model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length===1?invalid:valid);},
    {diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,2);clean(requests[0]);
  const first=requests[0],repair=requests[1];
  assert.deepEqual(repair.rejected_output,invalid);assert.deepEqual(repair.data,first.data);assert.deepEqual(repair.output_schema,first.output_schema);
  assert.equal(repair.stage,first.stage);assert.equal(typeof repair.repair_task,'string');assert.ok(repair.repair_task.length>0);
  assert.deepEqual(JSON.parse(repair.validation_feedback),{path:'output',keyword:'objectKeys',
    expected:{key_count:3,keys:['state','questions','safety']},
    actual:{key_count:1,missing_key_count:2,missing_keys:['questions','safety'],extra_key_count:0}});
  assert.ok(!repair.validation_feedback.includes('PRIVATE_'));secretFree(logs);
});

test('the failed candidate is cloned before a validator can mutate nested arrays or delete source fields',async()=>{
  const requests=[],logs=[],candidate=structuredClone(valid),returned={validated:true};let validations=0;
  candidate.state.issues=['PRIVATE_ORIGINAL_ISSUE'];
  const rejection=Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 오류'),
    {modelReason:'agent_claim_audit',modelFeedback:'{"path":"output.state","keyword":"synthetic"}'});
  const model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length===1?candidate:valid);},
    {diagnosticLogger:entry=>logs.push(entry)});
  const output=await generate(model,{validator:value=>{
    if(++validations===1){value.state.issues[0]='PRIVATE_MUTATED_ISSUE';value.state.issues.push('PRIVATE_ADDED_ISSUE');delete value.state.approved;throw rejection;}
    validate(value);return returned;
  }});
  assert.equal(output,returned);assert.deepEqual(requests[1].rejected_output,candidate);
  assert.equal(requests[1].validation_feedback,rejection.modelFeedback);secretFree(logs);
});

test('each repair replaces the prior rejected candidate while retaining the real accumulated feedback',async()=>{
  const requests=[],logs=[],second={state:{approved:'PRIVATE_SECOND_TYPE_SENTINEL',issues:[]},questions:null,safety:null};
  const model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length===1?invalid:requests.length===2?second:valid);},
    {diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,3);
  assert.deepEqual(requests[1].rejected_output,invalid);assert.deepEqual(requests[2].rejected_output,second);
  const feedback=requests[2].validation_feedback.split('\n').map(line=>JSON.parse(line));
  assert.equal(feedback.length,2);assert.equal(feedback[0].path,'output');assert.equal(feedback[1].path,'output.state.approved');
  assert.equal(feedback[1].keyword,'type');assert.ok(!requests[2].validation_feedback.includes('PRIVATE_'));secretFree(logs);
});

test('an approved-looking rejected candidate can never approve itself or bypass the unchanged validator',async()=>{
  const requests=[],logs=[];let validations=0;
  const rejection=Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 독립 검토 반려'),{modelReason:'agent_claim_audit'});
  const model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(valid);},{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{validator:value=>{validations++;validate(value);throw rejection;}}),error=>error===rejection);
  assert.equal(validations,3);assert.equal(requests.length,3);clean(requests[0]);
  for(const repair of requests.slice(1))assert.deepEqual(repair.rejected_output,valid);
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_claim_audit','agent_claim_audit','agent_claim_audit']);secretFree(logs);
});

test('concurrent stages on one gateway receive only their own rejected output and repair feedback',async()=>{
  const requests=[],counts=new Map(),logs=[];
  const candidates={turn_review:{state:{PRIVATE_STAGE_A:'PRIVATE_FIRST_STAGE'}},state_review:{questions:'PRIVATE_SECOND_STAGE'}};
  const model=gateway(async(_url,options)=>{
    const input=body(options);requests.push(input);const count=(counts.get(input.stage)||0)+1;counts.set(input.stage,count);
    return envelope(count===1?candidates[input.stage]:valid);
  },{diagnosticLogger:entry=>logs.push(entry)});
  const outputs=await Promise.all([generate(model,{stage:'turn_review'}),generate(model,{stage:'state_review'})]);
  assert.deepEqual(outputs,[valid,valid]);
  for(const stage of Object.keys(candidates)){
    const local=requests.filter(input=>input.stage===stage);assert.equal(local.length,2);clean(local[0]);
    assert.deepEqual(local[1].rejected_output,candidates[stage]);
  }
  secretFree(logs);
});

test('successful normalized output cannot become repair state in a later stage or operation',async()=>{
  const requests=[],model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length===1?invalid:valid);});
  const accepted={approved_record:'PRIVATE_ACCEPTED_SENTINEL'};
  await model.operation({},async operation=>{
    assert.equal(await model.agentComplete('turn_review','원문',{source:'PRIVATE_SOURCE_SENTINEL'},schema,operation,value=>{validate(value);return accepted;}),accepted);
    assert.deepEqual(await model.agentComplete('state_review','원문',{},schema,operation,validate),valid);
  });
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,4);clean(requests[0]);clean(requests[2]);clean(requests[3]);
  assert.deepEqual(requests[1].rejected_output,invalid);
  assert.ok(requests.every(input=>!JSON.stringify(input).includes('PRIVATE_ACCEPTED_SENTINEL')));
});

test('a whole-operation restart starts clean even when the previous three parsed candidates were rejected',async()=>{
  const requests=[],logs=[],model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length<=3?invalid:valid);},
    {retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,4);clean(requests[0]);clean(requests[3]);
  assert.deepEqual(requests[2].rejected_output,invalid);
  assert.equal(logs.filter(entry=>entry.event==='model_operation_retry').length,1);secretFree(logs);
});

for(const candidate of [null,false,0,'',[],{}])test('falsy or empty parsed candidates remain exact rejected outputs: '+JSON.stringify(candidate),async()=>{
  const requests=[],model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(requests.length===1?candidate:valid);});
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,2);clean(requests[0]);
  assert.equal(Object.hasOwn(requests[1],'rejected_output'),true);assert.deepEqual(requests[1].rejected_output,candidate);
});

test('unparseable response text is neither retained as a parsed candidate nor exposed in diagnostics',async()=>{
  const requests=[],logs=[],model=gateway(async(_url,options)=>{
    requests.push(body(options));return requests.length===1?new Response(JSON.stringify({choices:[{finish_reason:'stop',
      message:{content:'PRIVATE_UNPARSEABLE_RESPONSE'}}]})):envelope(valid);
  },{diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await generate(model),valid);assert.equal(requests.length,2);clean(requests[0]);clean(requests[1]);secretFree(logs);
});

test('unexpected validator exceptions stay terminal and leave no rejected candidate for a later call',async()=>{
  const requests=[],logs=[],model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(valid);},{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{validator:()=>{throw new TypeError('PRIVATE_VALIDATOR_SENTINEL');}}),
    {code:'MODEL_UNAVAILABLE',modelReason:'internal_failure'});
  assert.equal(requests.length,1);assert.deepEqual(await generate(model),valid);clean(requests[0]);clean(requests[1]);secretFree(logs);
});

const stream=value=>{
  const frame=payload=>'data: '+JSON.stringify(payload)+'\n\n';
  return new Response(frame({choices:[{index:0,delta:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:null}]})+
    frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
};
const malformed=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'PRIVATE_MALFORMED_JSON'}}]}));
const exhaustion=(error,structural)=>{
  assert.equal(error.modelAttempts,3);assert.equal(error.modelStructuralFailures,structural);
  for(const key of ['modelAttempts','modelStructuralFailures']){
    assert.equal(Object.getOwnPropertyDescriptor(error,key)?.enumerable,false);assert.ok(!JSON.stringify(error).includes(key));
  }
  return true;
};

test('mixed connection and 429 retries count only the final schema rejection as structural failure',async()=>{
  const requests=[],logs=[],model=gateway(async(_url,options)=>{
    requests.push(body(options));
    if(requests.length===1)throw Object.assign(new Error('PRIVATE_CONNECTION_SENTINEL'),{code:'ECONNRESET'});
    if(requests.length===2)return new Response('PRIVATE_UPSTREAM_SENTINEL',{status:429,headers:{'retry-after':'0'}});
    return envelope(invalid);
  },{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model),error=>{assert.equal(error.modelReason,'agent_schema');return exhaustion(error,1);});
  assert.equal(requests.length,3);assert.ok(requests.every(input=>!Object.hasOwn(input,'rejected_output')));
  assert.deepEqual(logs.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),['connection_transient','http_transient','agent_schema']);secretFree(logs);
});

test('three semantic review rejections exhaust attempts without contributing structural failures',async()=>{
  const requests=[],logs=[],model=gateway(async(_url,options)=>{requests.push(body(options));return envelope(valid);},
    {diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{validator:()=>{throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','합성 의미 검토 반려'),
    {modelReason:'agent_claim_audit'});}}),error=>{assert.equal(error.modelReason,'agent_claim_audit');return exhaustion(error,0);});
  assert.equal(requests.length,3);secretFree(logs);
});

for(const [reason,makeResponse,options] of [
  ['agent_schema',()=>envelope(invalid),{}],
  ['content_json',malformed,{}],
  ['stream_whitespace_stall',()=>stream(' '.repeat(4097)),{streamJson:true,baseUrl:'http://127.0.0.1:11434/v1'}],
])test('three actual format failures receive private structural exhaustion metadata: '+reason,async()=>{
  const requests=[],logs=[],model=gateway(async(_url,request)=>{requests.push(body(request));return makeResponse();},
    {...options,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model),error=>{assert.equal(error.modelReason,reason);return exhaustion(error,3);});
  assert.equal(requests.length,3);secretFree(logs);
});

test('cancelling the third attempt cannot attach structural exhaustion metadata or contaminate a later operation',async()=>{
  const controller=new AbortController(),requests=[],logs=[],model=gateway(async(_url,options)=>{
    requests.push(body(options));if(requests.length<=2)return envelope(invalid);
    if(requests.length===3){controller.abort();throw new Error('PRIVATE_CANCELLED_FETCH');}
    return envelope(valid);
  },{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{signal:controller.signal}),error=>{
    assert.equal(error.code,'MODEL_CANCELLED');assert.equal(Object.hasOwn(error,'modelAttempts'),false);
    assert.equal(Object.hasOwn(error,'modelStructuralFailures'),false);return true;
  });
  assert.equal(requests.length,3);assert.deepEqual(await generate(model),valid);clean(requests[3]);secretFree(logs);
});

for(const status of [401,403])test('authentication failure never acquires format exhaustion metadata: '+status,async()=>{
  let calls=0;const model=gateway(async()=>{calls++;return new Response('PRIVATE_AUTH_SENTINEL',{status});});
  await assert.rejects(generate(model),error=>{
    assert.equal(error.code,'MODEL_AUTH_FAILED');assert.equal(Object.hasOwn(error,'modelAttempts'),false);
    assert.equal(Object.hasOwn(error,'modelStructuralFailures'),false);return true;
  });assert.equal(calls,1);
});

test('a third-attempt grammar whitespace stall can use four model-generated blocks and still requires a fresh full review',async()=>{
  const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','요즘 계획표를 고친다고 말했어요.')}},
    supporter:{fields:{}},user_goal:{message:field('want','곁에서 이야기를 듣고 싶어요.')},answered_count:3,
    latest_answer:{subject:'patient',question_id:'mood'},adaptive_questions:true,question_candidates:[],clarification_candidates:[]};
  const reference={subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.rawText};
  const draft={state:{patient_state:{facts:[{...reference,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[{evidence:[reference],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  const overflow=structuredClone(draft);overflow.state.patient_state.facts=Array.from({length:4},()=>({...reference,certainty:'reported'}));
  const requests=[],logs=[];let combined=0;
  const model=gateway(async(_url,options)=>{
    const request=JSON.parse(options.body),input=JSON.parse(request.messages.at(-1).content);requests.push({request,input});
    if(input.stage==='turn_draft')return stream(++combined<=2?overflow:' '.repeat(4097));
    if(input.stage.startsWith('turn_draft_block_')){
      const block=input.data.output_block,value=block==='questions'?draft.questions:draft.state[block];return stream(block==='name_index'?{name_index:value}:value);
    }
    return stream({state:{approved:true,issues:[],audits:input.data.review_target.claims.map(claim=>({id:claim.id,
      verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'현재 합성 원문 대조'}))},questions:null,safety:null});
  },{baseUrl:'http://127.0.0.1:11434/v1',streamJson:true,diagnosticLogger:entry=>logs.push(entry)});
  const output=await model.operation({},operation=>runCombinedRelationshipState(model,ctx,null,operation));
  assert.equal(output.state_agent.reviewed,true);assert.equal(combined,3);
  assert.deepEqual(requests.map(({input})=>input.stage),['turn_draft','turn_draft','turn_draft',
    'turn_draft_block_patient_state','turn_draft_block_name_index','turn_draft_block_relationship_memory','turn_draft_block_questions','turn_review']);
  assert.deepEqual(requests.slice(0,3).map(({request})=>request.response_format.type),['json_object','json_object','json_schema']);
  assert.equal(output.patient_state.facts.find(fact=>fact.question_id==='mood').quote,reference.quote);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[reference]);secretFree(logs);
});
