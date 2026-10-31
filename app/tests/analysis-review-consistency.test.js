import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {validateAnalysisReviewConsistency,validateSchema,validateReview} from '../src/relationship-agent.js';
import {auditSchema,validateAudits} from '../src/grounding-audit.js';
const claims=[{id:'dynamics.1',certainty:'tentative'},{id:'strengths.0',certainty:'reported'}];
const review=(reason='dynamics.1의 근거를 수정하세요.',verdict='supported')=>({approved:false,issues:[{field:'relationship_analysis',reason,repair:'현재 원문을 다시 대조하세요.'}],audits:claims.map(claim=>({id:claim.id,verdict,reason:'PRIVATE_AUDIT_REASON'}))});
const shape={type:'object',properties:{approved:{type:'boolean'},issues:{type:'array',maxItems:4,items:{type:'object',properties:{field:{type:'string',enum:['relationship_analysis']},reason:{type:'string',maxLength:500},repair:{type:'string',maxLength:500}},required:['field','reason','repair'],additionalProperties:false}},audits:auditSchema(claims)},required:['approved','issues','audits'],additionalProperties:false};
function validate(value){validateSchema(value,shape);validateAudits(value.audits,claims,value.approved);validateReview({approved:value.approved,issues:value.issues});return validateAnalysisReviewConsistency(value,claims);}
test('explicit supported-ID rejection is returned to reviewer with only known IDs',()=>{
  const value=review('dynamics.1에 PRIVATE_SOURCE 문제가 있습니다.'),before=structuredClone(value);
  assert.throws(()=>validate(value),error=>{assert.equal(error.modelReason,'agent_analysis_review_inconsistent');assert.deepEqual(JSON.parse(error.modelFeedback).claim_ids,['dynamics.1']);assert.equal(error.modelFeedback.includes('PRIVATE_'),false);return true;});assert.deepEqual(value,before);
});
for(const [reason,verdict] of [
  ['dynamics.1 근거가 없습니다.','unsupported'],['dynamics.1 가설의 범위를 다시 확인하세요.','plausible'],
  ['관계 label이 원문과 다릅니다.','supported'],['미확인 정보의 설명에 문제가 있습니다.','supported'],
  ['dynamics.10을 수정하세요.','supported'],['xdynamics.1을 수정하세요.','supported'],['dynamics.1_extra 수정','supported'],
  ['dynamics.1과 dynamics.99를 대조하세요.','supported'],
])test('non-conflicting rejection preserved: '+reason,()=>{const value=review(reason,verdict);assert.equal(validate(value),value);});
test('a combined issue with one unsupported referenced audit remains a proper rejection',()=>{
  const value=review('dynamics.1 및 strengths.0 근거를 대조하세요.');value.audits[1].verdict='unsupported';assert.equal(validate(value),value);
});
function harness(outputs,{retryFailures=false}={}){
  const requests=[],logs=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'PRIVATE_KEY',model:'synthetic',protocol:'relationship_agent',timeoutMs:0,retryFailures,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);requests.push({body,...input});return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(outputs[Math.min(requests.length-1,outputs.length-1)])}}]}));
  }});
  return {requests,logs,run:()=>model.operation({},operation=>model.agentComplete('analysis_review','현재 분석을 검토하세요.',{analysis:{unchanged:true},claims,answers:'PRIVATE_SOURCE'},shape,operation,validate))};
}
test('review retry reconciles its own output without requesting a new analysis draft',async()=>{
  const corrected=review('dynamics.1 근거가 부족합니다.','unsupported'),h=harness([review(),corrected]);assert.deepEqual(await h.run(),corrected);
  assert.deepEqual(h.requests.map(row=>row.stage),['analysis_review','analysis_review']);assert.deepEqual(h.requests[0].data,h.requests[1].data);
  assert.deepEqual(h.requests[1].rejected_output,review());assert.match(h.requests[1].body.messages[0].content,/초안이 아닌 직전 검토 JSON/u);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);
});
test('unresolved inconsistency stops after three review attempts even when operation retries are enabled',async()=>{
  const h=harness([review()],{retryFailures:true});await assert.rejects(h.run(),{modelReason:'agent_analysis_review_inconsistent'});assert.equal(h.requests.length,3);
});
