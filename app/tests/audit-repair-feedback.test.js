import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAuditCoverage,validateAudits} from '../src/grounding-audit.js';
import {ModelGateway} from '../src/model.js';
import {requestCombinedStateReview} from '../src/relationship-turn.js';

const claims=[
  {id:'patient.0',claim:'PRIVATE_REPORTED_CLAIM',certainty:'reported',evidence:[{subject:'patient',question_id:'mood',quote:'PRIVATE_SOURCE'}]},
  {id:'relationship.0',claim:'PRIVATE_TENTATIVE_CLAIM',certainty:'tentative',evidence:[]},
];
const audits=()=>claims.map(claim=>({id:claim.id,verdict:claim.certainty==='reported'?'supported':'plausible',reason:'PRIVATE_AUDIT_REASON'}));
const feedback=(run,keyword)=>{
  let result;
  assert.throws(run,error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_claim_audit');
    result=JSON.parse(error.modelFeedback);assert.equal(result.keyword,keyword);
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));assert.match(result.repair,/원문/u);return true;
  });
  return result;
};

for(const [name,change,missing,duplicates,unexpected]of [
  ['missing',value=>value.slice(0,1),['relationship.0'],[],0],
  ['duplicate',value=>[value[0],value[0]],['relationship.0'],['patient.0'],0],
  ['untrusted unknown ID',value=>[value[0],{...value[1],id:'PRIVATE_INVENTED_ID'}],['relationship.0'],[],1],
  ['invalid item',value=>[value[0],null],['relationship.0'],[],1],
  ['non-array',()=>null,claims.map(claim=>claim.id),[],0],
])test('audit coverage provides exact safe identities for '+name,()=>{
  const value=change(audits()),before=structuredClone(value);
  const result=feedback(()=>validateAudits(value,claims,true),'auditCoverage');
  assert.deepEqual(result.required_audit_ids,claims.map(claim=>claim.id));
  assert.deepEqual(result.missing_audit_ids,missing);assert.deepEqual(result.duplicate_audit_ids,duplicates);
  assert.equal(result.unexpected_audit_count,unexpected);assert.deepEqual(value,before);
  assert.match(result.repair,/자동 승인하지/u);
});

test('exact coverage accepts reordered identities but never approves claim content',()=>{
  const value=audits().reverse();value[0].verdict='unsupported';
  assert.equal(validateAuditCoverage(value,claims),undefined);
  feedback(()=>validateAudits(value,claims,true),'auditApprovalConflict');
  assert.equal(validateAudits(value,claims,false),undefined);
  assert.equal(validateAudits([],[],true),undefined);
});

for(const [index,verdict]of [[0,'plausible'],[0,'unsupported'],[1,'unsupported']])
test('approval conflict has actionable metadata without source text: '+index+'/'+verdict,()=>{
  const value=audits();value[index].verdict=verdict;
  const before=structuredClone(value),result=feedback(()=>validateAudits(value,claims,true),'auditApprovalConflict');
  assert.equal(result.claim_id,claims[index].id);assert.equal(result.verdict,verdict);
  assert.deepEqual(result.allowed_approved_verdicts,index===0?['supported']:['supported','plausible']);
  assert.match(result.repair,/approved=false/u);assert.match(result.repair,/supported로 올리거나 자동 승인하지/u);
  assert.deepEqual(value,before);assert.equal(validateAudits(value,claims,false),undefined);
});

test('malformed audit fields remain distinct from coverage and verdict conflicts',()=>{
  const value=audits();value[1].reason='';value[1].PRIVATE_EXTRA_FIELD='PRIVATE_EXTRA_VALUE';
  const result=feedback(()=>validateAudits(value,claims,true),'auditFormat');
  assert.equal(result.audit_index,1);assert.deepEqual(result.required_keys,['id','reason','verdict']);
  assert.equal(result.reason_max_length,500);
});

const unknown=group=>({id:group+'.unknowns.0',kind:'unresolved_information',claim:'PRIVATE_UNKNOWN_CLAIM',certainty:'unknown',evidence:[]});
const input=()=>({shared_input:{},review_target:{
  input:{patient:[{question_id:'mood',answers:[{text:'PRIVATE_SOURCE'}]}],supporter:[],user_goal:[],retrieval:{documents:[]}},
  state:{patient_state:{facts:[{quote:'PRIVATE_SOURCE'}]},name_index:null},
  claims:[claims[0],unknown('patient_state'),unknown('relationship_memory')],
  reference_roles:{known_name:null,user_goal_fields:[],supporter_report_fields:[]},
},questions:null,safety:null});
const approval=reviewClaims=>({state:{approved:true,issues:[],audits:reviewClaims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'?'still_unknown':'supported',reason:'PRIVATE_AUDIT_REASON'}))},questions:null,safety:null});
const duplicate=value=>{value.state.audits[1]={...value.state.audits[0],reason:'PRIVATE_INVALID_REVIEW'};return value;};
const conflict=value=>{value.state.audits[0].verdict='plausible';return value;};
const rejected=value=>{
  value.state.approved=false;value.state.audits[0].verdict='unsupported';
  value.state.issues=[{reason:'현재 주장이 원문 밖의 동의를 단정했습니다.',repair:'원문의 의도 범위로 수정하세요.'}];return value;
};
function fixture(edit,suffix=''){
  const calls=[],logs=[],payload=input();
  const gateway=new ModelGateway({baseUrl:'https://synthetic-audit.invalid/v1',apiKey:'PRIVATE_CREDENTIAL',
    model:'synthetic-reviewer',protocol:'relationship_agent',agentFormat:'prompt',compactReviewOutput:false,
    timeoutMs:0,retryFailures:false,diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),request=JSON.parse(body.messages.at(-1).content);calls.push(request);
      const output=edit(approval(request.data.review_target.claims),calls.length);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {calls,logs,payload,run:()=>gateway.operation({},operation=>requestCombinedStateReview(gateway,payload,operation,suffix))};
}

for(const suffix of ['','_after_review'])
test('duplicate state audit retries from exact wire identities without retaining malformed review: '+suffix,async()=>{
  const f=fixture((value,attempt)=>attempt===1?duplicate(value):value,suffix),before=structuredClone(f.payload);
  const result=await f.run();assert.equal(f.calls.length,2);
  const initial=f.calls[0],repair=f.calls[1],expected=initial.data.review_target.claims.map(claim=>claim.id);
  assert.deepEqual(expected,['patient.0','patient_state.unknowns.0']);
  assert.deepEqual(repair.required_audit_ids,expected);assert.equal(repair.rejected_output,undefined);
  assert.deepEqual(repair.data,initial.data);assert.deepEqual(repair.output_schema,initial.output_schema);
  assert.equal(JSON.parse(repair.validation_feedback).keyword,'auditCoverage');
  assert.match(repair.repair_task,/현재 초안의 근거·내용 오류는 계속 거절/u);
  assert.equal(JSON.stringify(repair).includes('PRIVATE_INVALID_REVIEW'),false);
  assert.deepEqual(result.state.audits.map(audit=>audit.id),before.review_target.claims.map(claim=>claim.id));
  assert.equal(result.state.approved,true);assert.deepEqual(f.payload,before);
  assert.deepEqual(f.logs.map(entry=>entry.reason),['agent_claim_audit','success']);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_'));
});

test('a verdict conflict after identity repair keeps its candidate and can return genuine rejection',async()=>{
  const f=fixture((value,attempt)=>attempt===1?duplicate(value):attempt===2?conflict(value):rejected(value));
  const result=await f.run();assert.equal(f.calls.length,3);assert.equal(result.state.approved,false);
  const third=f.calls[2];assert.equal(third.required_audit_ids,undefined);
  assert.equal(third.rejected_output.state.audits[0].verdict,'plausible');
  assert.equal(third.rejected_output.state.approved,true);
  assert.equal(JSON.parse(third.validation_feedback.split('\n').at(-1)).keyword,'auditApprovalConflict');
  assert.deepEqual(third.data,f.calls[0].data);assert.equal(result.state.audits[0].verdict,'unsupported');
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_'));
});

for(const verdict of ['already_answered','not_needed','review_uncertain'])
test('typed unknown approval conflict retains its wire verdict and still_unknown-only approval: '+verdict,async()=>{
  const f=fixture(value=>{value.state.audits[1].verdict=verdict;return value;});
  await assert.rejects(f.run(),error=>{
    assert.equal(error.modelReason,verdict==='review_uncertain'?'agent_unknown_audit':'agent_claim_audit');
    assert.equal(error.modelAttempts,3);
    const failure=JSON.parse(error.modelFeedback);
    assert.equal(failure.keyword,'auditApprovalConflict');assert.equal(failure.claim_id,'patient_state.unknowns.0');
    assert.equal(failure.verdict,verdict);assert.deepEqual(failure.allowed_approved_verdicts,['still_unknown']);
    assert.match(failure.repair,/still_unknown으로 올리거나 자동 승인하지/u);
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
  });
  assert.equal(f.calls.length,3);
  for(const request of f.calls.slice(1)){
    const failure=JSON.parse(request.validation_feedback.split('\n').at(-1));
    assert.equal(failure.verdict,verdict);assert.deepEqual(failure.allowed_approved_verdicts,['still_unknown']);
    assert.equal(request.required_audit_ids,undefined);
    assert.equal(request.rejected_output.state.approved,true);
    assert.equal(request.rejected_output.state.audits[1].verdict,verdict);
  }
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_'));
});

for(const [name,edit,keyword]of [['duplicate',duplicate,'auditCoverage'],['verdict conflict',conflict,'auditApprovalConflict']])
test('persistent '+name+' still stops after the original three attempts',async()=>{
  const f=fixture(edit);
  await assert.rejects(f.run(),error=>{
    assert.equal(error.modelReason,'agent_claim_audit');assert.equal(error.modelAttempts,3);
    assert.equal(JSON.parse(error.modelFeedback).keyword,keyword);return true;
  });
  assert.equal(f.calls.length,3);
  for(const request of f.calls.slice(1)){
    assert.equal(Object.hasOwn(request,'required_audit_ids'),keyword==='auditCoverage');
    assert.equal(Object.hasOwn(request,'rejected_output'),keyword!=='auditCoverage');
  }
  assert.ok(!f.logs.some(entry=>entry.event==='model_operation_retry'));
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_'));
});
