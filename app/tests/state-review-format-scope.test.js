import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {auditSchema} from '../src/grounding-audit.js';
import {validateCombinedStateReview} from '../src/relationship-turn.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const claims=[
  {id:'patient.0',claim:'PRIVATE_REPORTED_CLAIM',certainty:'reported',evidence:[{subject:'patient',question_id:'mood',quote:'PRIVATE_SOURCE'}]},
  {id:'relationship.0',claim:'PRIVATE_TENTATIVE_CLAIM',certainty:'tentative',evidence:[{subject:'user_goal',question_id:'want',quote:'PRIVATE_GOAL'}]},
  {id:'patient_state.unknowns.0',kind:'unresolved_information',claim:'PRIVATE_UNKNOWN_CLAIM',certainty:'unknown',evidence:[]},
];
const reviewSchema=reviewClaims=>object({state:object({approved:{type:'boolean'},issues:{type:'array',maxItems:3,
  items:object({reason:{type:'string',maxLength:500},repair:{type:'string',maxLength:600}})},audits:auditSchema(reviewClaims)}),
  questions:{type:'null'},safety:{type:'null'}});
const schema=reviewSchema(claims);
const approved=()=>({state:{approved:true,issues:[],audits:claims.map(claim=>({id:claim.id,
  verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문의 현재 범위를 대조했습니다.'}))},questions:null,safety:null});
const rejected=issue=>{const value=approved();value.state.approved=false;value.state.issues=[issue];return value;};
const validate=value=>validateCombinedStateReview(value,schema,claims);
const selfFormatIssues=[
  {reason:'claims의 모든 항목이 포함되지 않았습니다.',repair:'모든 claims의 id를 audits에 포함해 반환하세요.'},
  {reason:'claims의 모든 항목을 포함하지 않았습니다.',repair:'patient.0, relationship.0, patient_state.unknowns.0 전체를 작성하세요.'},
  {reason:'현재 검토의 audits 배열이 누락되었습니다.',repair:'audits를 전체 작성하세요.'},
];

for(const issue of selfFormatIssues)
test('complete audit coverage rejects a reviewer complaint about its own output: '+issue.reason,()=>{
  const value=rejected(issue),before=structuredClone(value);
  assert.throws(()=>validate(value),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'state_review_schema');
    const feedback=JSON.parse(error.modelFeedback);assert.equal(feedback.keyword,'reviewScope');
    assert.deepEqual(feedback.required_audit_ids,claims.map(claim=>claim.id));
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));assert.match(feedback.repair,/자동 승인하지 마세요/u);return true;
  });
  assert.deepEqual(value,before);
});

for(const [issue,unsupported]of [
  [{reason:'대상자가 대화에 동의했다는 원문 근거가 없습니다.',repair:'동의를 사실로 단정한 부분을 수정하세요.'},true],
  [{reason:'최신 거절과 시점 정정이 관계 기록에서 빠졌습니다.',repair:'거절·시점을 보존한 reported finding을 선택하세요.'},false],
  [{reason:'현재 claims에 모든 정정 내용이 포함되지 않았습니다.',repair:'현재 원문이 전한 거절·시점 정정을 claims에 추가하세요.'},false],
  [{reason:'현재 claims가 인용 밖의 동의를 단정했습니다.',repair:'원문 근거를 다시 대조해 audits에 판정을 작성하고 동의 단정을 수정하세요.'},true],
])test('a genuine current source defect remains a rejected draft: '+issue.reason,()=>{
  const value=rejected(issue);if(unsupported)value.state.audits[1].verdict='unsupported';
  const before=structuredClone(value);assert.equal(validate(value),value);assert.equal(value.state.approved,false);assert.deepEqual(value,before);
});

test('complete supported and plausible claims do not force approval when a real correction finding is missing',()=>{
  const value=rejected({reason:'현재 주장은 근거에 맞지만 최신 정정을 보존한 finding이 누락됐습니다.',
    repair:'누락된 최신 거절을 해당 사람의 reported finding으로 보존하세요.'});
  assert.equal(validate(value),value);assert.equal(value.state.approved,false);
  assert.deepEqual(value.state.audits.map(audit=>audit.verdict),['supported','plausible','supported']);
});

for(const [name,mutate,reason]of [
  ['missing audit',value=>value.state.audits.pop(),'agent_schema'],
  ['duplicate audit',value=>{value.state.audits[1].id=value.state.audits[0].id;},'agent_claim_audit'],
  ['missing audits field',value=>{delete value.state.audits;},'agent_schema'],
  ['reported plausible self-approval',value=>{value.state.audits[0].verdict='plausible';},'agent_claim_audit'],
  ['unknown plausible self-approval',value=>{value.state.audits[2].verdict='plausible';},'agent_unknown_audit'],
])test('review output retains its original rejection for '+name,()=>{
  const value=approved();mutate(value);assert.throws(()=>validate(value),{code:'MODEL_INVALID_RESPONSE',modelReason:reason});
});

const data=()=>({shared_input:{},state:{input:{patient:[{question_id:'mood',answers:[{text:'PRIVATE_SOURCE'}]}],
  supporter:[],user_goal:[{question_id:'want',answers:[{text:'PRIVATE_GOAL'}]}],retrieval:{documents:[{text:'PRIVATE_SOURCE'}]}},
  state:{patient_state:{facts:[{quote:'PRIVATE_SOURCE'}]},name_index:null},claims:structuredClone(claims),
  reference_roles:{known_name:null,user_goal_fields:[{question_id:'want',role:'intended_message'}],supporter_report_fields:[]}},
  questions:null,safety:null});
const malformed=()=>({state:{approved:true,issues:[],PRIVATE_INVALID_REVIEW_KEY:'PRIVATE_INVALID_REVIEW_VALUE'}});
const gateway=(handler,options={})=>new ModelGateway({baseUrl:'https://synthetic-review.example/v1',apiKey:'PRIVATE_CREDENTIAL',
  model:'synthetic-reviewer',protocol:'relationship_agent',agentFormat:'prompt',timeoutMs:0,retryFailures:false,diagnosticLogger:null,...options,
  fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content),output=await handler({body,input,signal:request.signal});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
  }});
const generate=(model,{stage='turn_review',payload=data(),signal,validator=validate,outputSchema=schema}={})=>model.operation({signal},operation=>
  model.agentComplete(stage,'현재 원문과 claims 전체를 독립적으로 검토하세요.',payload,outputSchema,operation,validator));
const clean=input=>{
  for(const key of ['required_audit_ids','rejected_output','repair_task','validation_feedback'])assert.equal(Object.hasOwn(input,key),false);
};

const overlappingClaims=[...claims.slice(0,2),...['patient_state','relationship_memory'].flatMap(group=>
  Array.from({length:4},(_,index)=>({id:group+'.unknowns.'+index,kind:'unresolved_information',
    claim:'PRIVATE_UNKNOWN_CLAIM_'+index,certainty:'unknown',evidence:[]})))];
const overlappingSchema=reviewSchema(overlappingClaims);
const overlappingApproved=()=>({state:{approved:true,issues:[],audits:overlappingClaims.map(claim=>({id:claim.id,
  verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문의 현재 범위를 별도로 대조했습니다.'}))},questions:null,safety:null});
const overlapIssues=[
  {reason:'patient_state.unknowns.0과 relationship_memory.unknowns.0의 내용이 중복됨',
    repair:'두 항목 중 하나를 삭제하거나 서로 다른 미확인 범위를 정의해야 합니다.'},
  {reason:'patient_state.unknowns.1~3과 relationship_memory.unknowns.1~3의 내용이 중복됨',
    repair:'두 배열 사이의 중복된 미확인 범위를 정리해야 합니다.'},
];
const overlappingRejected=()=>{const value=overlappingApproved();value.state.approved=false;
  value.state.issues=structuredClone(overlapIssues);return value;};
const paraphrasedOverlap=()=>{const value=overlappingApproved();value.state.approved=false;
  value.state.issues=Array.from({length:3},(_,index)=>({
    reason:`patient_state.unknowns.${index}과 relationship_memory.unknowns.${index}이 동일한 범위(현재 원하는 도움의 범위)를 확인하는 것이므로 중복된 정보입니다.`,
    repair:'두 항목 중 하나를 삭제하거나, 각각의 목적에 맞게 범위를 명확히 구분해야 합니다.',
  }));return value;};
const mergedOverlap=()=>{const value=overlappingApproved();value.state.approved=false;
  value.state.issues=Array.from({length:3},(_,index)=>({
    reason:`patient_state.unknowns.${index}과 relationship_memory.unknowns.${index}의 범위가 중복됨`,
    repair:'두 배열에서 중복되는 문구는 하나로 통합하거나 각각의 고유한 미확인 범위로 조정해야 합니다.',
  }));return value;};
const overlappingData=()=>{const payload=data();payload.state.claims=structuredClone(overlappingClaims);return payload;};
const validateOverlap=value=>validateCombinedStateReview(value,overlappingSchema,overlappingClaims);
const generateOverlap=(model,options={})=>generate(model,{payload:overlappingData(),outputSchema:overlappingSchema,
  validator:validateOverlap,...options});

test('supported unknowns duplicated between the two arrays require reviewer scope repair without changing the draft',()=>{
  const value=overlappingRejected(),before=structuredClone(value);
  assert.throws(()=>validateOverlap(value),error=>{
    assert.equal(error.modelReason,'state_review_schema');const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.keyword,'reviewScope');assert.deepEqual(feedback.required_audit_ids,overlappingClaims.map(claim=>claim.id));
    assert.match(feedback.repair,/같은 미확인 범위는 허용됩니다/u);
    assert.match(feedback.repair,/독립적으로 다시 심사/u);assert.match(feedback.repair,/자동 승인하지 마세요/u);
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
  });
  assert.deepEqual(value,before);
});

for(const stage of ['turn_review','turn_review_after_review'])for(const rejectedReview of [overlappingRejected,paraphrasedOverlap,mergedOverlap])
test('duplicate-only reviewer complaints receive an independent review retry over the same current input: '+stage+' '+rejectedReview.name,async()=>{
  const calls=[],logs=[],payload=overlappingData(),before=structuredClone(payload);
  const model=gateway(call=>{calls.push(call);return calls.length===1?rejectedReview():overlappingApproved();},
    {diagnosticLogger:entry=>logs.push(entry)});let validations=0;
  assert.deepEqual(await generateOverlap(model,{stage,payload,validator:value=>{validations++;return validateOverlap(value);}}),overlappingApproved());
  assert.equal(validations,2);assert.equal(calls.length,2);assert.deepEqual(payload,before);clean(calls[0].input);
  for(const {input}of calls)assert.deepEqual(input.data,before);
  const repaired=calls[1].input;assert.equal(repaired.rejected_output,undefined);
  assert.deepEqual(repaired.required_audit_ids,overlappingClaims.map(claim=>claim.id));
  const feedback=JSON.parse(repaired.validation_feedback.split('\n').at(-1));assert.equal(feedback.keyword,'reviewScope');
  assert.match(feedback.repair,/같은 미확인 범위는 허용됩니다/u);
  assert.match(feedback.repair,/독립적으로 다시 심사/u);
  assert.match(feedback.repair,/자동 승인하지 마세요/u);assert.ok(!repaired.validation_feedback.includes('PRIVATE_'));
  assert.deepEqual(logs.map(entry=>entry.reason),['state_review_schema','success']);assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

for(const rejectedReview of [overlappingRejected,paraphrasedOverlap,mergedOverlap])
test('three repeated duplicate-only complaints exhaust the original retry budget without approval: '+rejectedReview.name,async()=>{
  const calls=[],logs=[],payload=overlappingData(),before=structuredClone(payload);
  const model=gateway(call=>{calls.push(call);return rejectedReview();},{diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generateOverlap(model,{payload}),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_schema',modelAttempts:3});
  assert.equal(calls.length,3);for(const {input}of calls)assert.deepEqual(input.data,before);
  assert.equal(logs.some(entry=>entry.event==='model_operation_retry'||entry.reason==='success'),false);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('explicit duplicate pairs resolve existing claims and allow only NFKC and whitespace equivalence',()=>{
  const reviewClaims=structuredClone(overlappingClaims),value=paraphrasedOverlap();
  reviewClaims.find(claim=>claim.id==='patient_state.unknowns.0').claim='현재 원하는 도움 방식 A';
  reviewClaims.find(claim=>claim.id==='relationship_memory.unknowns.0').claim='  현재  원하는\t도움 방식 Ａ  ';
  const before=structuredClone({reviewClaims,value});
  assert.throws(()=>validateCombinedStateReview(value,overlappingSchema,reviewClaims),{modelReason:'state_review_schema'});
  assert.deepEqual({reviewClaims,value},before);
});

for(const [reason,repair]of [
  ['patient_state.unknowns.0 및 relationship_memory.unknowns.0에서 같은 미확인 정보가 반복됩니다.',
    '반복되는 두 항목을 합쳐 하나로 남겨 주세요.'],
  ['relationship_memory.unknowns.0와 patient_state.unknowns.0는 서로 내용이 겹칩니다.',
    '겹치는 내용은 한쪽에 남기고 각각의 범위를 구분하세요.'],
  ['두 항목 patient_state.unknowns.0, relationship_memory.unknowns.0는 똑같은 내용을 나타냅니다.',
    '하나로 통합하거나 서로 다른 미확인 범위로 조정하세요.'],
  ['patient_state.unknowns.0 / relationship_memory.unknowns.0: 동일한 범위가 두 번 작성됐습니다.',
    '두 배열의 항목 중 하나를 제거하고 범위를 정리하세요.'],
])test('varied pure-duplication wording requests a fresh review using proven claim equality: '+reason,async()=>{
  const value=overlappingApproved();value.state.approved=false;value.state.issues=[{reason,repair}];
  const before=structuredClone(value),calls=[];
  assert.throws(()=>validateOverlap(value),{modelReason:'state_review_schema'});assert.deepEqual(value,before);
  const model=gateway(call=>{calls.push(call);return calls.length===1?value:overlappingApproved();});
  assert.deepEqual(await generateOverlap(model),overlappingApproved());assert.equal(calls.length,2);
  assert.deepEqual(calls[0].input.data,calls[1].input.data);
  assert.equal(JSON.parse(calls[1].input.validation_feedback).keyword,'reviewScope');
});

for(const [name,mutate]of [
  ['different corresponding claim',(_value,reviewClaims)=>{reviewClaims.find(claim=>claim.id==='relationship_memory.unknowns.0').claim='다른 시점과 사람의 도움 범위';}],
  ['unsupported unknown',value=>{value.state.audits[2].verdict='unsupported';}],
  ['plausible unknown',value=>{value.state.audits[2].verdict='plausible';}],
  ['unsupported reported fact',value=>{value.state.audits[0].verdict='unsupported';}],
  ['nonexistent explicit ID',value=>{value.state.issues[0].reason=value.state.issues[0].reason.replace('patient_state.unknowns.0','patient_state.unknowns.99');}],
  ['noncanonical explicit ID',value=>{value.state.issues[0].reason=value.state.issues[0].reason.replace('patient_state.unknowns.0','patient_state.unknowns.00');}],
  ['malformed explicit range',value=>{value.state.issues[0].reason=value.state.issues[0].reason.replace('patient_state.unknowns.0','patient_state.unknowns.0~oops');}],
  ['malformed repair reference',value=>{value.state.issues[0].repair+=' patient_state.unknowns.0~oops를 제거하세요.';}],
  ['missing explicit indices',value=>{value.state.issues[0].reason=value.state.issues[0].reason.replaceAll('.unknowns.0','.unknowns');}],
  ['additional referenced ID',value=>{value.state.issues[0].reason=value.state.issues[0].reason.replace('현재 원하는 도움의 범위','patient_state.unknowns.1');}],
  ...['원문 근거가 없는 범위','이미 확인된 도움','현재 보고와 모순되는 범위','최신 정정 누락','답한 범위'].map(scope=>[
    'parenthetical source defect '+scope,value=>{value.state.issues[0].reason=value.state.issues[0].reason.replace('현재 원하는 도움의 범위',scope);},
  ]),
  ['separate genuine correction issue',value=>{value.state.issues.push({reason:'중요한 최신 정정이 누락됐습니다.',repair:'현재 거절과 시점을 원문대로 보존하세요.'});}],
  ['additional source defect in same reason',value=>{value.state.issues[0].reason+=' 원문의 최신 정정이 누락됐습니다.';}],
  ['repair also changes source meaning',value=>{value.state.issues[0].repair+=' 원문의 현재 거절을 복원하세요.';}],
  ['generic independent error',value=>{value.state.issues[0].reason+=' 내용에 오류도 있습니다.';}],
  ['missing central content',value=>{value.state.issues[0].reason+=' 핵심 내용도 빠져 있습니다.';}],
  ['unknown relevance defect',value=>{value.state.issues[0].reason+=' 현재 판단에는 필요하지 않습니다.';}],
  ['repair has an independent defect',value=>{value.state.issues[0].repair+=' 잘못된 감정 표현을 고치세요.';}],
  ['repair refers to another unknown',value=>{value.state.issues[0].repair+=' patient_state.unknowns.1을 제거하세요.';}],
  ['repair removes a reported claim',value=>{value.state.issues[0].repair+=' patient.0을 제거하세요.';}],
  ['repair removes all unknowns',value=>{value.state.issues[0].repair='두 배열의 모든 항목을 삭제하세요.';}],
  ['duplication is expressly denied',value=>{value.state.issues[0].reason='patient_state.unknowns.0과 relationship_memory.unknowns.0은 중복이 아닙니다.';}],
  ['no duplication complaint',value=>{value.state.issues[0].reason='patient_state.unknowns.0과 relationship_memory.unknowns.0를 검토했습니다.';}],
  ['no duplicate-focused repair',value=>{value.state.issues[0].repair='두 항목을 그대로 두세요.';}],
])test('paraphrased overlap never replaces a genuine or unconfirmed draft rejection: '+name,async()=>{
  const reviewClaims=structuredClone(overlappingClaims),value=paraphrasedOverlap();value.state.issues=value.state.issues.slice(0,1);
  mutate(value,reviewClaims);const before=structuredClone({reviewClaims,value});
  const validateCurrent=output=>validateCombinedStateReview(output,overlappingSchema,reviewClaims);
  assert.equal(validateCurrent(value),value);assert.equal(value.state.approved,false);assert.deepEqual({reviewClaims,value},before);
  const payload=overlappingData();payload.state.claims=reviewClaims;let calls=0;
  const model=gateway(call=>{calls++;clean(call.input);return value;});
  assert.deepEqual(await generateOverlap(model,{payload,validator:validateCurrent}),value);assert.equal(calls,1);
});

test('legacy duplicate-range wording also requires equal existing corresponding claims',()=>{
  for(const mutate of [
    reviewClaims=>{reviewClaims.find(claim=>claim.id==='relationship_memory.unknowns.2').claim='다른 미확인 범위';},
    reviewClaims=>{reviewClaims.find(claim=>claim.id==='relationship_memory.unknowns.3').id='relationship_memory.unknowns.4';},
  ]){
    const reviewClaims=structuredClone(overlappingClaims);mutate(reviewClaims);
    const value=overlappingRejected();value.state.audits=value.state.audits.map((audit,index)=>({...audit,id:reviewClaims[index].id}));
    assert.equal(validateCombinedStateReview(value,reviewSchema(reviewClaims),reviewClaims),value);assert.equal(value.state.approved,false);
  }
});

for(const [name,mutate]of [
  ['unsupported unknown',value=>{value.state.audits[2].verdict='unsupported';}],
  ['unsupported relationship unknown',value=>{value.state.audits[6].verdict='unsupported';}],
  ['merely plausible unknown',value=>{value.state.audits[3].verdict='plausible';}],
  ['unsupported reported fact',value=>{value.state.audits[0].verdict='unsupported';}],
  ['separate missing latest correction',value=>{value.state.issues.push({reason:'최신 정정을 보존한 finding이 누락됐습니다.',
    repair:'최신 거절과 시점을 해당 사람의 reported finding에 보존하세요.'});}],
  ['same issue also reports a missing correction',value=>{value.state.issues[0].reason+=' 최신 정정도 누락됐습니다.';}],
  ['repair asks to restore a real correction',value=>{value.state.issues[0].repair+=' 최신 거절과 시점도 복원하세요.';}],
  ['duplicate complaint without both paths',value=>{value.state.issues[0].reason='unknowns의 내용이 중복됨';}],
])test('an overlap complaint preserves a genuine or unconfirmed draft rejection: '+name,async()=>{
  const calls=[],defect=overlappingRejected();mutate(defect);const before=structuredClone(defect);
  assert.equal(validateOverlap(defect),defect);assert.equal(defect.state.approved,false);assert.deepEqual(defect,before);
  const model=gateway(call=>{calls.push(call);return defect;});assert.deepEqual(await generateOverlap(model),defect);
  assert.equal(calls.length,1);clean(calls[0].input);
});

test('a duplicate-only complaint cannot replace the existing exact audit coverage checks',()=>{
  for(const [mutate,reason]of [
    [value=>value.state.audits.pop(),'agent_schema'],
    [value=>{value.state.audits[3].id=value.state.audits[2].id;},'agent_claim_audit'],
  ]){const value=overlappingRejected();mutate(value);
    assert.throws(()=>validateOverlap(value),{code:'MODEL_INVALID_RESPONSE',modelReason:reason});}
  const value=rejected(overlapIssues[0]);assert.equal(validate(value),value);assert.equal(value.state.approved,false);
});

for(const stage of ['turn_review','turn_review_after_review'])
test('combined structural repair excludes the invalid reviewer output while retaining every current source: '+stage,async()=>{
  const calls=[],logs=[],payload=data(),before=structuredClone(payload);
  const model=gateway(call=>{calls.push(call);return calls.length===1?malformed():calls.length===2?rejected(selfFormatIssues[0]):approved();},
    {diagnosticLogger:entry=>logs.push(entry)});let validations=0;
  assert.deepEqual(await generate(model,{stage,payload,validator:value=>{validations++;return validate(value);}}),approved());
  assert.equal(validations,3);assert.equal(calls.length,3);assert.deepEqual(payload,before);clean(calls[0].input);
  for(const {input,body}of calls.slice(1)){
    assert.deepEqual(input.data,before);assert.deepEqual(input.output_schema,schema);assert.equal(input.stage,stage);
    assert.equal(input.rejected_output,undefined);assert.deepEqual(input.required_audit_ids,claims.map(claim=>claim.id));
    assert.match(input.repair_task,/검토기 자신의 이전 JSON/u);assert.match(input.repair_task,/현재 초안의 근거·내용 오류는 계속 거절/u);
    assert.ok(!JSON.stringify(input).includes('PRIVATE_INVALID_REVIEW'));
    assert.ok(!input.validation_feedback.includes('PRIVATE_'));assert.equal(Object.hasOwn(body,'max_tokens'),false);
  }
  assert.equal(JSON.parse(calls[1].input.validation_feedback).keyword,'objectKeys');
  assert.equal(JSON.parse(calls[2].input.validation_feedback.split('\n').at(-1)).keyword,'reviewScope');
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_schema','state_review_schema','success']);assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

for(const stage of ['turn_review_custom','state_review','guide_review','turn_draft'])
test('generic stage retains its existing candidate repair contract: '+stage,async()=>{
  const calls=[],invalid=malformed(),model=gateway(call=>{calls.push(call);return calls.length===1?invalid:approved();});
  assert.deepEqual(await generate(model,{stage}),approved());assert.equal(calls.length,2);
  assert.deepEqual(calls[1].input.rejected_output,invalid);assert.equal(calls[1].input.required_audit_ids,undefined);
  assert.deepEqual(calls[1].input.data,calls[0].input.data);assert.deepEqual(calls[1].input.output_schema,schema);
});

test('a generic turn review without combined state claims retains its rejected candidate',async()=>{
  const calls=[],invalid=malformed(),model=gateway(call=>{calls.push(call);return calls.length===1?invalid:approved();});
  const payload={source:'PRIVATE_SOURCE',claims:structuredClone(claims)};
  await generate(model,{payload});assert.deepEqual(calls[1].input.rejected_output,invalid);
  assert.equal(calls[1].input.required_audit_ids,undefined);assert.deepEqual(calls[1].input.data,payload);
});

test('the explicit review_target wrapper repairs output independently while retaining its complete current input',async()=>{
  const {state:target,...rest}=data(),payload={...rest,review_target:target},before=structuredClone(payload),calls=[];
  const model=gateway(call=>{calls.push(call);return calls.length===1?malformed():approved();});
  assert.deepEqual(await generate(model,{stage:'turn_review_after_review',payload}),approved());assert.equal(calls.length,2);
  for(const {input}of calls){
    assert.deepEqual(input.data,before);assert.equal(input.data.state,undefined);
    assert.deepEqual(Object.keys(input.data.review_target).sort(),['claims','input','reference_roles','state']);
    assert.deepEqual(input.output_schema,schema);assert.equal(input.output_schema.properties.review_target,undefined);
  }
  assert.equal(calls[1].input.rejected_output,undefined);
  assert.deepEqual(calls[1].input.required_audit_ids,target.claims.map(claim=>claim.id));
  assert.equal(JSON.parse(calls[1].input.validation_feedback).keyword,'objectKeys');
  assert.match(calls[1].input.repair_task,/검토기 자신의 이전 JSON/u);assert.deepEqual(payload,before);
});

test('a genuine unsupported current claim after format repair is returned as rejection without automatic approval',async()=>{
  const calls=[],defect=rejected({reason:'현재 주장이 원문 밖의 동의를 단정했습니다.',repair:'동의를 단정하지 말고 의도 범위로 수정하세요.'});
  defect.state.audits[1].verdict='unsupported';
  const model=gateway(call=>{calls.push(call);return calls.length===1?malformed():defect;});
  const output=await generate(model);assert.equal(output.state.approved,false);assert.deepEqual(output,defect);assert.equal(calls.length,2);
});

test('persistent reviewer format complaints stop at the original three attempts',async()=>{
  const calls=[],logs=[],model=gateway(call=>{calls.push(call);return rejected(selfFormatIssues[0]);},
    {diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_schema',modelAttempts:3});
  assert.equal(calls.length,3);assert.equal(logs.some(entry=>entry.event==='model_operation_retry'),false);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('cancellation during combined format repair cannot approve a response or leak repair state into a later operation',async()=>{
  const calls=[],logs=[],controller=new AbortController();
  const model=gateway(call=>{
    calls.push(call);if(calls.length===1)return malformed();if(calls.length===2)controller.abort();return approved();
  },{retryFailures:true,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{signal:controller.signal}),{code:'MODEL_CANCELLED'});assert.equal(calls.length,2);
  assert.equal(logs.some(entry=>entry.event==='model_operation_retry'),false);
  assert.deepEqual(await generate(model),approved());clean(calls[2].input);assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('combined review format repair stays local across concurrent stages and new operations',async()=>{
  const calls=[],counts=new Map(),logs=[],model=gateway(call=>{
    calls.push(call);const count=(counts.get(call.input.stage)||0)+1;counts.set(call.input.stage,count);
    return call.input.stage==='turn_review'&&count===1?malformed():approved();
  },{diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await Promise.all(['turn_review','turn_review_after_review'].map(stage=>generate(model,{stage}))),[approved(),approved()]);
  const unaffected=calls.find(call=>call.input.stage==='turn_review_after_review');clean(unaffected.input);
  const repaired=calls.filter(call=>call.input.stage==='turn_review');assert.equal(repaired.length,2);
  assert.deepEqual(repaired[1].input.required_audit_ids,claims.map(claim=>claim.id));
  assert.deepEqual(await generate(model),approved());clean(calls.at(-1).input);assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});
