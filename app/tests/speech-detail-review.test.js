import test from 'node:test';
import assert from 'node:assert/strict';
import { speechDetailReviewRequest } from '../src/relationship-agent.js';
import { DETAIL, DETAIL_REVIEW, DETAIL_REPAIR } from '../src/relationship-prompts.js';
import { AUDIT_INSTRUCTION } from '../src/grounding-audit.js';
import { fixture, guide, ref, assertDetail } from './helpers/final-flow-fixture.js';

const purpose='밤에 계획표를 고친다는 보고를 되짚어요. 어떤 이야기를 나누고 싶은지 확인하기 위한 질문이에요.';
const invented='밤에 계획표를 고쳤고 이미 상담에도 동의했으므로 상담 일정을 정하도록 돕는 말이에요.';
const detail=()=>Object.fromEntries(['opening','listening','offer'].map((id,index)=>[id,{
  excerpt:['지민아, 밤에 계획표를 고치는 모습을 봤어. ','네 마음을 이해하고 싶어. ','지금 이야기해도 괜찮을까?'][index],
  why:purpose,evidence:[ref()],
}]));
const payload=()=>({answers:{patient:[{question_id:'mood',answers:[{text:ref().quote}]}],supporter:[],user_goal:[]},
  script:Object.values(detail()).map(part=>part.excerpt).join(''),detail:detail()});
const audits=(claims,verdict='supported')=>claims.map(claim=>({id:claim.id,verdict,reason:'현재 설명의 사실 전제와 발화 목적을 대조했습니다.'}));
const rejection=(claims,reason='opening: 원문에는 상담 동의가 없으므로 이미 동의했다는 전제를 삭제하세요.')=>({
  approved:false,issues:[reason],audits:claims.map(claim=>({id:claim.id,
    verdict:claim.id==='opening'?'unsupported':'supported',reason:claim.id==='opening'?reason:'선택한 인용과 해당 발화 목적에 맞습니다.'})),
});

test('detail review transmits the entire explanation and sources without labeling future purpose reported',()=>{
  const original=payload(),before=structuredClone(original),request=speechDetailReviewRequest(original);
  assert.deepEqual(original,before);
  assert.deepEqual(request.payload.answers,before.answers);
  assert.equal(request.payload.script,before.script);
  assert.deepEqual(request.payload.detail,before.detail);
  for(const claim of request.payload.claims){
    assert.equal(Object.hasOwn(claim,'certainty'),false);
    assert.equal(claim.claim_kind,'speech_detail_explanation');
    assert.equal(claim.claim,before.detail[claim.id].why);
    assert.deepEqual(claim.evidence,before.detail[claim.id].evidence);
  }
  assert.deepEqual(request.schema.properties.audits.items.properties.verdict.enum,['supported','plausible','unsupported']);
  assert.equal(request.prompt,DETAIL_REVIEW);
  assert.equal(request.prompt.includes(AUDIT_INSTRUCTION),false);
  assert.match(request.prompt,/모든 사실과 전제는 선택된 evidence가/u);
  assert.match(request.prompt,/목적 문구가 원문에 그대로 없거나 아직 실행하지 않았다는 이유만으로 거절하지/u);
  assert.match(request.prompt,/실제 효과가 있었다거나 반드시 생길 것이라는 단정/u);
  const approved={approved:true,issues:[],audits:audits(request.payload.claims)};
  assert.deepEqual(request.validate(approved),approved);
});

test('mixed unreported personal facts remain visible to review and unsupported or plausible cannot pass',()=>{
  const input=payload();input.detail.opening.why=invented;
  const request=speechDetailReviewRequest(input);
  assert.equal(request.payload.detail.opening.why,invented);
  assert.equal(request.payload.claims.find(claim=>claim.id==='opening').claim,invented);
  assert.deepEqual(request.payload.claims.find(claim=>claim.id==='opening').evidence,[ref()]);
  for(const verdict of ['unsupported','plausible']){
    const rejected={approved:false,issues:['opening: 동의 여부를 인용으로 확인할 수 없습니다.'],
      audits:request.payload.claims.map(claim=>({id:claim.id,verdict:claim.id==='opening'?verdict:'supported',reason:'동의 전제를 원문에서 확인할 수 없습니다.'}))};
    assert.deepEqual(request.validate(rejected),rejected);
    assert.throws(()=>request.validate({...rejected,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
  }
  assert.throws(()=>request.validate({approved:true,issues:[],audits:audits(request.payload.claims).slice(1)}),{code:'MODEL_INVALID_RESPONSE'});
});

test('contradictory detail rejections are review errors, never approvals or content repair instructions',()=>{
  const request=speechDetailReviewRequest(payload());
  for(const issues of [[],['audits의 verdict 키가 verdict로 잘못 적혔습니다.','audits의 id 순서가 다릅니다.'],
    ['listening: opening의 설명을 복사해 현재 구간의 내용과 맞지 않습니다.']]){
    const value={approved:false,issues,audits:audits(request.payload.claims).reverse()},before=structuredClone(value);
    assert.throws(()=>request.validate(value),error=>{
      assert.equal(error.modelReason,'agent_detail_review_inconsistent');
      const feedback=JSON.parse(error.modelFeedback);
      assert.deepEqual(feedback.rejected_claim_ids,[]);
      assert.match(feedback.instruction,/검토 JSON만 수정/u);
      assert.match(feedback.instruction,/ID 순서는 자유/u);
      assert.match(feedback.instruction,/자동 승인하거나 실제 문제를 지우지/u);
      return true;
    });
    assert.deepEqual(value,before);
  }
  const approved={approved:true,issues:[],audits:audits(request.payload.claims).reverse()};
  assert.deepEqual(request.validate(approved),approved,'Audit order is not a semantic error');
});

test('coherent negative detail audits remain content rejections without literal IDs in free-text issues',()=>{
  const request=speechDetailReviewRequest(payload()),value=rejection(request.payload.claims);
  const natural={...value,issues:['설명에 확인되지 않은 감정이 추가됐어요.']};
  assert.deepEqual(request.validate(natural),natural);
  const comparison={...value,issues:['opening: listening에서만 묻는 내용을 이 구간의 설명에 넣지 마세요.']};
  assert.deepEqual(request.validate(comparison),comparison,'A repair may compare another supported section');
  const multiple={...natural,audits:audits(request.payload.claims,'unsupported')};
  assert.deepEqual(request.validate(multiple),multiple);
  assert.throws(()=>request.validate({...natural,issues:[]}),{modelReason:'agent_detail_review_inconsistent'});
});

test('an approved script expression is not evidence of the user having that feeling or intention',()=>{
  const input=payload();
  input.detail.opening.excerpt='응원하고 싶어. ';
  input.script=Object.values(input.detail).map(part=>part.excerpt).join('');
  input.detail.opening.why='이용자가 응원하는 마음을 전하고 싶어 하므로 그 마음을 표현했습니다.';
  const request=speechDetailReviewRequest(input);
  assert.equal(request.payload.script,input.script);
  assert.deepEqual(request.payload.answers,input.answers);
  assert.equal(JSON.stringify(request.payload.answers).includes('응원'),false);
  assert.equal(request.payload.claims[0].claim,input.detail.opening.why);
  assert.deepEqual(request.payload.claims[0].evidence,[ref()]);
  const rejected=rejection(request.payload.claims,'opening: 제안 발화의 응원 표현은 이용자의 실제 감정이나 의도를 보고한 원문이 아닙니다.');
  assert.deepEqual(request.validate(rejected),rejected);
  assert.throws(()=>request.validate({...rejected,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
});

test('one rejected detail is repaired once with current evidence and the complete approved script preserved',async()=>{
  const approvedScript=guide().guide.script;
  let originalDetail,writerAnswers;
  const run=fixture({response:({stage,data},body,value)=>{
    if(stage==='speech_detail'||stage==='speech_detail_repair'){
      assert.ok(body.messages[0].content.includes(DETAIL));
      assert.match(body.messages[0].content,/승인된 발화 속 제안·표현을 이용자의 실제 감정·의도·행동으로 바꾸어 why에 귀속하지/u);
      assert.match(body.messages[0].content,/모든 개인화 사실과 전제는 answers의 원문만 근거로 삼고, 이를 뒷받침하는 인용을 evidence에 빠짐없이/u);
      assert.match(body.messages[0].content,/원문에 없는 마음은 생략하거나, 이용자의 실제 마음으로 귀속하지 않는/u);
    }
    if(stage==='speech_detail'){
      writerAnswers=structuredClone(data.answers);
      return {...value,opening:{...value.opening,why:invented}};
    }
    if(stage==='speech_detail_review'){
      originalDetail=structuredClone(data.detail);
      assert.equal(data.script,approvedScript);
      assert.equal(data.claims[0].claim,invented);
      assert.equal(Object.hasOwn(data.claims[0],'certainty'),false);
      return rejection(data.claims);
    }
    if(stage==='speech_detail_repair'){
      assert.deepEqual(data.previous,originalDetail);
      assert.deepEqual(data.answers,writerAnswers);
      assert.equal(data.review.audits.find(audit=>audit.id==='opening').verdict,'unsupported');
      assert.equal(data.script,approvedScript);
      assert.equal(data.script_units.map(unit=>unit.text).join(''),approvedScript);
      assert.deepEqual(data.previous.opening.evidence,[ref()]);
      assert.ok(body.messages[0].content.includes(DETAIL_REPAIR));
      return {...value,opening:{...value.opening,why:purpose}};
    }
    if(stage==='speech_detail_review_after_repair'){
      assert.equal(data.script,approvedScript);
      assert.equal(data.detail.opening.why,purpose);
      assert.deepEqual(data.detail.opening.evidence,[ref()]);
      assert.equal(Object.values(data.detail).map(part=>part.excerpt).join(''),approvedScript);
      assert.equal(data.claims.some(claim=>claim.claim.includes('이미 상담에도 동의')),false);
      return {approved:true,issues:[],audits:audits(data.claims)};
    }
  }});
  const result=await run.run();
  assertDetail(result);
  assert.equal(result.guide.script,approvedScript);
  assert.equal(result.conversation_detail.opening.why,purpose);
  assert.deepEqual(run.stages().filter(stage=>stage.startsWith('speech_detail')),
    ['speech_detail','speech_detail_review','speech_detail_repair','speech_detail_review_after_repair']);
  const published=run.events.filter(event=>event.type==='upsert'&&event.id==='script'&&event.detail);
  assert.equal(published.length,1);
  assert.deepEqual(published[0].detail,result.conversation_detail);
  assert.equal(JSON.stringify(published).includes(invented),false);
});

test('two valid semantic rejections still fail closed without more repairs or publishing unapproved detail',async()=>{
  const run=fixture({response:({stage,data},_body,value)=>{
    if(stage==='speech_detail'||stage==='speech_detail_repair')return {...value,opening:{...value.opening,why:invented}};
    if(stage.startsWith('speech_detail_review'))return rejection(data.claims);
  }});
  await assert.rejects(run.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_detail_review_rejected'});
  assert.deepEqual(run.stages().filter(stage=>stage.startsWith('speech_detail')),
    ['speech_detail','speech_detail_review','speech_detail_repair','speech_detail_review_after_repair']);
  assert.equal(run.events.some(event=>JSON.stringify(event).includes(invented)),false);
});

test('a contradictory review is retried before a genuine detail rejection consumes the content repair',async()=>{
  let reviews=0,repairs=0;
  const run=fixture({response:({stage,data},body,value)=>{
    if(stage==='speech_detail')return {...value,opening:{...value.opening,why:invented}};
    if(stage==='speech_detail_review'){
      reviews++;
      if(reviews===1)return {approved:false,issues:['audits의 id 순서가 다릅니다.'],audits:audits(data.claims).reverse()};
      assert.match(JSON.stringify(JSON.parse(body.messages.at(-1).content).validation_feedback),/검토기 자신의 audits/u);
      return rejection(data.claims);
    }
    if(stage==='speech_detail_repair'){
      repairs++;
      assert.equal(data.review.audits.find(audit=>audit.id==='opening').verdict,'unsupported');
      assert.equal(data.review.issues.some(issue=>issue.includes('id 순서')),false);
      assert.match(body.messages[0].content,/다른 구간에서만 하는/u);
      return {...value,opening:{...value.opening,why:purpose}};
    }
    if(stage==='speech_detail_review_after_repair')return {approved:true,issues:[],audits:audits(data.claims)};
  }});
  const result=await run.run();assertDetail(result);
  assert.equal(reviews,2);assert.equal(repairs,1);
  assert.deepEqual(run.stages().filter(stage=>stage.startsWith('speech_detail')),
    ['speech_detail','speech_detail_review','speech_detail_review','speech_detail_repair','speech_detail_review_after_repair']);
  assert.equal(run.events.some(event=>JSON.stringify(event).includes(invented)),false);
});
