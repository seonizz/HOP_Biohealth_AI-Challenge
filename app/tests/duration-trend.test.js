import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {knownSpeechIssues} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

// Synthetic reports: duration, change, activity and speaker are separate facts.
const field=(id,text,question='연우에게 어떤 변화가 있나요?')=>({id,text,rawText:text,custom:'',status:'answered',question});
const source='혼자 지내는 시간이 꽤 길다고 했어요.';
const context=()=>({patient:{alias:'연우',fields:{name:field('name','연우'),rel:field('rel','친구'),mood:field('mood',source)}},
  supporter:{fields:{}},user_goal:{message:field('want','함께하고 싶어요')},
  name_index:{alias:'연우',source_question_id:'name',quote:'연우'},answered_count:4,question_candidates:[]});
const empty=()=>({script:'',doList:[],avoid:[],next:'',care:{feel:'',tips:[]}});
const check=(text,ctx=context(),key='script')=>{
  const guide=empty();
  if(key==='doList')guide.doList=[text];
  else if(key==='avoid')guide.avoid=['피할 말: 재촉하기. 이유: 부담을 줄 수 있어요. 대신 '+text];
  else if(key==='care')guide.care.feel=text;
  else guide[key]=text;
  const before=structuredClone({guide,ctx});
  const issues=knownSpeechIssues(guide,ctx).filter(issue=>issue.reason.includes('시간이 늘었다는'));
  assert.deepEqual({guide,ctx},before);return issues;
};

for(const claim of ['네가 혼자 있는 시간이 길어지고 있어 걱정돼.','연우가 혼자 지내는 시간이 늘었어요.','그분이 혼자 보내는 시간이 더 늘어나고 있어요.'])
test('long duration alone cannot establish an increase: '+claim,()=>{
  for(const key of ['script','doList','avoid','next','care'])assert.equal(check(claim,context(),key).length,1,key);
});

for(const text of [
  '네가 혼자 지내는 시간이 꽤 길어서 걱정돼.',
  '혼자 있는 시간이 길어졌나요?',
  '혼자 있는 시간이 늘어난 건가요?',
  '혼자 지내는 시간이 늘었는지 물어보세요.',
  '만약 혼자 지내는 시간이 늘어난다면 어떻게 지내고 싶은지 물어보세요.',
  '혼자 보내는 시간이 길어지면 원하는 활동을 함께 정해 보세요.',
  '혼자 지내는 시간이 늘어났으면 함께할 시간을 정해 보세요.',
  '혼자 있는 시간이 늘어난 경우에는 원하는 활동을 정해 보세요.',
  '혼자 있는 시간이 길어지고 있다면 원하는 활동을 정해 보세요.',
  '앞으로 혼자 있는 시간이 늘어나겠지만 원하는 활동을 함께 정할 수 있어.',
  '혼자 지내는 시간이 늘지는 않았어요.',
  '혼자 있는 시간이 길어지고 있지는 않아요.',
  '혼자 있는 시간이 길어진 게 아니에요.',
  '혼자 지내는 시간이 늘어난 것 같아요.',
  '민수가 혼자 있는 시간이 길어지고 있어요.',
  '내가 혼자 보내는 시간이 늘었어.',
  '피할 말: “네가 혼자 있는 시간이 길어지고 있어”. 지금 모습만 말하세요.',
  '“혼자 있는 시간이 길어지고 있다”라고 단정하지 마세요.',
])test('questions, conditions, denials, other speakers and avoidance stay distinct: '+text,()=>{
  assert.deepEqual(check(text),[]);
});

for(const report of [
  '혼자 지내는 시간이 전보다 늘었어요.',
  '연우는 최근에 혼자 보내는 시간이 길어졌어요.',
  '연우가 “내가 혼자 있는 시간이 늘었어”라고 말했어요.',
])test('an actual report of the same patient and activity supports the change: '+report,()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood',report);
  assert.deepEqual(check('네가 혼자 있는 시간이 길어지고 있어 걱정돼.',ctx),[]);
});

for(const report of [
  '민수가 혼자 있는 시간이 늘었어요.',
  '제가 혼자 있는 시간이 늘었어요.',
  '연우가 공부하는 시간이 늘었어요.',
  '혼자 지내는 시간이 늘어났는지 모르겠어요.',
  '혼자 있는 시간이 늘어난 건가요?',
  '혼자 있는 시간이 늘어난 경우에는 원하는 활동을 정해 보세요.',
  '혼자 지내는 시간이 늘어난 것은 아니에요.',
  '만약 혼자 지내는 시간이 늘어난다면 걱정될 것 같아요.',
])test('unrelated or unconfirmed increases cannot waive the guard: '+report,()=>{
  const ctx=context();ctx.patient.fields.note=field('note',report);
  assert.equal(check('네가 혼자 지내는 시간이 늘었어.',ctx).length,1);
});

test('custom and short current follow-up answers retain their activity and speaker scope',()=>{
  const ctx=context();ctx.patient.fields.mood.custom='연우가 혼자 있는 시간이 늘었어요.';
  assert.deepEqual(check('네가 혼자 지내는 시간이 늘었어.',ctx),[]);
  ctx.patient.fields.mood.custom='';ctx.patient.fields.mood.followUp={question:'연우가 혼자 보내는 시간은 달라졌나요?',answer:{text:'늘었어요.'}};
  assert.deepEqual(check('네가 혼자 지내는 시간이 늘었어.',ctx),[]);
  ctx.patient.fields.mood.followUp.question='민수가 혼자 보내는 시간은 달라졌나요?';
  assert.equal(check('네가 혼자 지내는 시간이 늘었어.',ctx).length,1);
});

test('a same-field follow-up denial supersedes the earlier increase',()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','혼자 지내는 시간이 늘었어요.');
  ctx.patient.fields.mood.followUp={question:'현재 시간 변화는 어떤가요?',answer:{text:'혼자 지내는 시간이 늘지는 않았어요.'}};
  assert.equal(check('네가 혼자 지내는 시간이 늘었어.',ctx).length,1);
});

test('an explicit short denial after 아니요 keeps its matched patient and activity',()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','혼자 있는 시간이 늘었어요.');
  ctx.patient.fields.mood.followUp={question:'연우가 혼자 있는 시간은 늘었나요?',answer:{text:'아니요, 늘지 않았어요.'}};
  assert.equal(check('네가 혼자 있는 시간이 늘었어.',ctx).length,1);
});

test('unknown, skipped and another subject sources cannot confirm the increase',()=>{
  for(const status of ['unknown','refused','skipped']){
    const ctx=context();ctx.patient.fields.note={...field('note','혼자 있는 시간이 늘었어요.'),status};
    assert.equal(check('네가 혼자 지내는 시간이 늘었어.',ctx).length,1,status);
  }
  const ctx=context();ctx.supporter.fields.note=field('note','혼자 있는 시간이 늘었어요.');
  assert.equal(check('네가 혼자 지내는 시간이 늘었어.',ctx).length,1);
});

test('an approved model review still repairs the unsupported trend and independently reviews the repair',async()=>{
  const ctx=context(),ref={subject:'patient',question_id:'mood',quote:source},requests=[],events=[];
  ctx.relationship_state={patient:[{interpretation:'이용자의 관찰입니다.',evidence:[ref],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]};
  const memory={summary:'상황을 보고했어요.',facts:[{...ref,interpretation:'이용자의 관찰입니다.',certainty:'reported'}],unknowns:[],user_goal:'함께하고 싶어요'};
  const corrected='연우야, 지금 이야기해도 괜찮을까? 혼자 지내는 시간이 꽤 길다고 들었어. 어떤 도움이 필요할까?';
  const guide={top:'통합',script:'연우야, 지금 이야기해도 괜찮을까? 네가 혼자 지내는 시간이 늘었어. 어떤 도움이 필요할까?',
    doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하기. 이유: 선택권을 남겨야 합니다. 대신 편한 시간을 물어보세요.'],
    next:'서로 편한 시간을 정해 보세요.',care:{feel:'이야기를 들려주셨어요.',tips:['잠시 쉬어 보세요.']}};
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'prompt',reasoningEffort:'omit',reuseFinalDraft:true,timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,request)=>{
      const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content),{stage,data}=input;requests.push(input);let value;
      if(stage==='relationship_analysis')value={observations:{patient:[ref],supporter:[]},relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}};
      else if(stage==='communication_plan')value={voice:'친구에게 건네는 말',opening_evidence:[ref],user_intent:'함께하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',supporter_care:['자신도 쉬세요.'],avoid_patterns:['재촉하지 않기'],next_step:'편한 시간을 정하기'};
      else if(stage==='guide_write')value={guide,assessment:{safety:false}};
      else if(stage==='guide_repair_card_script_1'){
        assert.match(data.task,/증가 근거가 없다면/u);value={script:corrected};
      }else if(stage.startsWith('guide_quality'))value={improvements:[]};
      else if(/^(?:analysis_review|speech_review|support_review|speech_detail_review)(?:_|$)/u.test(stage))value={approved:true,issues:[],audits:(data.claims||[]).map(claim=>({id:claim.id,
        verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문을 검토했습니다.'}))};
      else if(/^(?:plan_review|guide_review)(?:_|$)/u.test(stage))value={approved:true,issues:[]};
      else if(stage==='speech_detail')value={opening_end:1,listening_end:data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'현재 관찰과 선택권을 구분합니다.',evidence:[ref]}]))};
      else assert.fail('Unexpected stage '+stage);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,value))}}]}));
    }});
  const result=await model.respond(ctx,memory,{onCard:event=>events.push(event)});
  assert.equal(result.guide.script,corrected);assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
  assert.equal(requests.filter(input=>input.stage.startsWith('guide_repair')).length,1);
  const review=requests.find(input=>input.stage==='speech_review_card_script_after_repair_1');
  assert.ok(review);assert.equal(review.data.guide.script,corrected);
  assert.equal(events.some(event=>event.type==='upsert'&&event.id==='script'&&JSON.stringify(event).includes('시간이 늘었어')),false);
  assert.equal(Object.values(result.conversation_detail).map(part=>part.excerpt).join(''),corrected);
});
