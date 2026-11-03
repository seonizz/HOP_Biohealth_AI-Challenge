import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import * as prompts from '../src/relationship-prompts.js';
import {scopeContext,scopeProbe} from './helpers/turn-input-optimization-fixture.js';

const {COMMON,SOURCE_FIDELITY_CONTRACT:contract}=prompts;
const assertContract=(prompt,label)=>{
  assert.equal(prompt.split(contract).length-1,1,label+' has one shared source contract');
  assert.equal(prompt.split(COMMON).length-1,1,label+' has one common instruction');
};

test('source fidelity reaches final writing, repair, quality and independent review contracts without duplication',()=>{
  for(const key of ['OBSERVE','MEMORY','STATE','STATE_REVIEW','ANALYZE','PLAN','WRITE','REVIEW',
    'QUALITY','QUALITY_CHECK','PLAN_REVIEW','SPEAK','DETAIL','SUPPORT_REVIEW'])assertContract(prompts[key],key);
  for(const partialGuide of [false,true])assertContract(prompts.reuseFinalDraftPrompt({partialGuide}),'O4 '+partialGuide);
  for(const typedAvoidance of [false,true])assertContract(prompts.speechReviewPrompt({typedAvoidance}),'speech '+typedAvoidance);
  for(const [field,role] of Object.entries(prompts.CARD_ROLES))assertContract(COMMON+'\n'+role,'card repair '+field);
  assert.match(contract,/누가 누구에게 보냈거나 말했는지, 누가 받거나 들었는지/u);
  assert.match(contract,/요약·공감·미확인 내용·질문 생략 이유와 검토의 reason\/repair에도 적용/u);
  assert.match(contract,/시점·지속 시간·빈도·수량·강도도 사실/u);
  assert.match(contract,/해당 범위가 원문에 실제로 보고됐다면 사용할 수/u);
  assert.match(contract,/이용자가 필요하다고 생각한 도움은 대상자가 직접 원한 도움이 아니며/u);
  assert.match(prompts.QUALITY,/실제 원문 근거와 보존할 의미를 지목하는 최소 수정 지시/u);
});

// Synthetic sources exercise real source projection and prompt composition;
// model responses are fixtures, not a claim of semantic model reliability.
for(const stateMode of ['combined','combined_blocks'])test('source direction and duration remain available to independent question review: '+stateMode,async()=>{
  const ctx=scopeContext();
  const fields={concern:'친구에게서 일정이 바뀌었다는 문자를 받았어요.',moment:'저는 버스를 기다리면서 15분 동안 답장을 기다렸어요.'};
  ctx.patient.fields.concern={id:'concern',question:'받은 연락은 무엇인가요?',status:'answered',rawText:fields.concern,text:fields.concern,custom:''};
  ctx.supporter.fields.moment={id:'moment',question:'어떤 장면이 떠오르나요?',status:'answered',rawText:fields.moment,text:fields.moment,custom:''};
  const before=structuredClone(ctx);
  const probe=scopeProbe(ModelGateway,{ctx,stateMode,enabled:true,blockScopedInputs:true});
  const result=await probe.run();
  assert.deepEqual(ctx,before);
  for(const call of probe.calls)assertContract(call.prompt,call.stage);
  const review=probe.calls.find(call=>call.stage==='question_review');
  assert.ok(review);
  for(const source of Object.values(fields))assert.ok(JSON.stringify(review.data).includes(source),'full source survives question review projection');
  assert.match(review.prompt,/already_covered는/u);
  assert.match(review.prompt,/not_needed는 답변 완료 주장이 아니라/u);
  assert.equal(result.question_plan.skip[0].reason,'already_covered');
  assert.equal(result.clarification,'support_requested');
  assert.equal(result.state_agent.reviewed,true);
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(result.state_agent.stages.includes(stage));
});
