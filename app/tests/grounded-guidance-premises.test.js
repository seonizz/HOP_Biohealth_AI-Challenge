import test from 'node:test';
import assert from 'node:assert/strict';
import {knownSpeechIssues,validateRelationship} from '../src/relationship-agent.js';
import {PROMPT_VERSION,COMMON,ANALYZE} from '../src/relationship-prompts.js';

const field=(id,text)=>({id,question:id,status:'answered',rawText:text,text});
const context=()=>({patient:{alias:'민서',fields:{rel:field('rel','동료'),support:field('support','동료와 이야기하고 필요하면 담당자에게 일정 조정을 요청할 수 있어요.')}},
  supporter:{fields:{moment:field('moment','저는 동료와 업무를 나누고 필요하면 담당자에게 일정 조정을 요청합니다.'),mysupport:field('mysupport','친구와 이야기하며 도움을 받을 수 있어요.')}},user_goal:{}});
const guide=(text,kind='script')=>({script:kind==='script'?text:'',doList:kind==='doList'?[text]:[],avoid:kind==='avoid'?[text]:[],next:kind==='next'?text:'',care:{feel:'',tips:kind==='care'?[text]:[]}});
const traitIssues=(text,kind='script',ctx=context())=>knownSpeechIssues(guide(text,kind),ctx).filter(issue=>issue.reason==='확인되지 않은 대상자의 성품을 다른 질문의 전제로 제시합니다.');
const premise='민서 씨가 책임감이 강하신 것 같은데, 오늘 어떤 일이 있었나요?';

test('hedged character premises in actual recommendations remain defects in every card scope',()=>{
  for(const kind of ['script','doList','avoid','next','care']){
    const text=kind==='avoid'?'피할 말: 대답을 재촉하기. 이유: 생각할 시간이 필요합니다. 대신 '+premise:premise;
    const issues=traitIssues(text,kind);assert.equal(issues.length,1,kind);assert.equal(issues[0].field,kind);
    assert.match(issues[0].repair,/성품이나 동기를 미리 평가하는 전제를 빼고/u);
  }
  assert.equal(traitIssues('저는 걱정되지만 민서 씨가 책임감이 강하신 것 같은데, 오늘은 어떠셨나요?').length,1);
});

test('bad examples, actual trait questions and speaker self-expression are preserved unchanged',()=>{
  for(const [text,kind] of [
    ['피할 말: '+premise+' 이유: 성품을 미리 판단하지 마세요.','avoid'],
    ['피할 말: '+premise+' 이유: 성품을 미리 판단하지 마세요. 대신 어떤 도움이 필요한지 물어보세요.','avoid'],
    ['“책임감이 강한 것 같은데, 오늘은 어때?”라는 말은 피하고 필요한 도움을 물어보세요.','doList'],
    ['스스로 책임감이 강한 편이라고 느끼시나요?','script'],
    ['책임감이 강한 것 같은데, 본인도 그렇게 느끼시나요?','script'],
    ['저는 책임감이 강한 것 같아서 쉬는 시간을 정하려고 해요.','script'],
    ['나는 책임감이 강한 것 같아요. 그래서 내 한계를 살펴보려고 해.','script'],
    ['요즘 제가 걱정이 되지만 어떤 도움이 필요하신지 듣고 싶어요.','script'],
  ])assert.deepEqual(traitIssues(text,kind),[],text);
});

test('an explicitly attributed target self-report needs the actual source and speaker',()=>{
  const ctx=context(),text='“책임감이 강한 것 같아요”라고 말씀하셨죠. 어떤 도움이 필요하신가요?';
  assert.equal(traitIssues(text,'script',ctx).length,1);
  for(const speaker of ['민서는','민서 님은','민서 씨가']){
    ctx.patient.fields.values=field('values',speaker+' “책임감이 강한 것 같아요”라고 말했어요.');
    assert.deepEqual(traitIssues(text,'script',ctx),[],speaker);
  }
  ctx.patient.fields.values=field('values','저는 “책임감이 강한 것 같아요”라고 민서에게 말했어요.');
  assert.equal(traitIssues(text,'script',ctx).length,1,'the user speaking to the target is not a target self-report');
});

const ref=(ctx,subject,question_id)=>({subject,question_id,quote:ctx[subject].fields[question_id].rawText});
const analysis=item=>({patient_summary:'보고된 업무 상황입니다.',supporter_summary:'보고된 이용자 상황입니다.',relationship:{label:'동료',supporter_role:'동료',dynamics:[],strengths:[item],boundaries:[]},unknowns:['도움 의향은 미확인입니다.'],safety:{urgent:false,evidence:[]}});
const userResource=ctx=>({interpretation:'이용자는 동료와 이야기를 나누며 지원 자원을 활용하고 있습니다.',certainty:'reported',evidence:[ref(ctx,'patient','support')]});

test('user resource claims cannot rely only on the target resource question even when the actual user source exists elsewhere',()=>{
  const ctx=context(),item=userResource(ctx),before=structuredClone(item);
  assert.throws(()=>validateRelationship(analysis(item),ctx),error=>{
    assert.equal(error.modelReason,'agent_resource_owner');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.field,'relationship.strengths.0');assert.equal(feedback.required_owner,'supporter');
    assert.deepEqual(feedback.selected_evidence,[{subject:'patient',question_id:'support'}]);
    assert.match(feedback.repair,/supporter.moment나 patient.concern/u);return true;
  });
  assert.deepEqual(item,before);
  item.evidence=[ref(ctx,'supporter','moment')];
  assert.deepEqual(validateRelationship(analysis(item),ctx).relationship.strengths,[item]);
  item.evidence.push(ref(ctx,'patient','support'));
  assert.deepEqual(validateRelationship(analysis(item),ctx).relationship.strengths,[item]);
});

test('explicit selected self-reports remain usable across question groups without relabeling their references',()=>{
  const ctx=context();ctx.patient.fields.support=field('support','저는 동료와 이야기를 나누며 도움을 받고 있습니다.');
  const item=userResource(ctx);assert.deepEqual(validateRelationship(analysis(item),ctx).relationship.strengths,[item]);
  ctx.patient.fields.concern=field('concern','저는 동료와 업무를 공유하며 필요하면 일정 조정을 요청합니다.');
  item.evidence=[ref(ctx,'patient','concern')];
  assert.deepEqual(validateRelationship(analysis(item),ctx).relationship.strengths,[item]);
});

test('quoted target first-person speech cannot be reassigned to the user resource owner',()=>{
  const ctx=context();ctx.patient.fields.support=field('support','대상자는 “저는 동료와 이야기를 나누며 도움을 받아요”라고 말했어요.');
  assert.throws(()=>validateRelationship(analysis(userResource(ctx)),ctx),{modelReason:'agent_resource_owner'});
});

test('the converse resource-owner mismatch rejects while explicit target attribution remains usable',()=>{
  const ctx=context(),item={interpretation:'대상자는 친구의 도움을 활용하고 있습니다.',certainty:'reported',evidence:[ref(ctx,'supporter','mysupport')]};
  assert.throws(()=>validateRelationship(analysis(item),ctx),{modelReason:'agent_resource_owner'});
  for(const speaker of ['대상자는','민서 님은','민서 씨가']){
    ctx.supporter.fields.mysupport=field('mysupport',speaker+' 친구와 이야기하며 도움을 받고 있습니다.');
    item.evidence=[ref(ctx,'supporter','mysupport')];
    assert.deepEqual(validateRelationship(analysis(item),ctx).relationship.strengths,[item]);
  }
});

test('writer and review contracts preserve question premises and selected-source ownership distinctions',()=>{
  assert.equal(PROMPT_VERSION,'relationship-v3.28-speech-detail-review');
  assert.match(COMMON,/뒤의 질문이 다른 내용을 묻는다면 그 추측은 여전히 질문의 전제/u);
  assert.match(COMMON,/대상자의 실제 자기보고를 출처와 함께 되짚는 표현은 구분/u);
  assert.match(ANALYZE,/선택한 evidence가 해석의 주체·행동을 뒷받침/u);
  assert.match(ANALYZE,/다른 영역의 명시적 자기보고는 사용할 수 있지만/u);
});
