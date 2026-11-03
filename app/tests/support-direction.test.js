import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {knownSpeechIssues} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

// Synthetic text only. These checks concern recommended support direction;
// factual quotations still pass through the existing independent reviews.
const empty=()=>({script:'',doList:[],avoid:[],next:'',care:{feel:'',tips:[]}});
const directionIssues=(text,field='script')=>{
  const guide=empty();
  if(field==='avoid')guide.avoid=['피할 말: 재촉하기. 이유: 선택권을 남기세요. 대신 '+text];
  else if(field==='doList')guide.doList=[text];
  else if(field==='care')guide.care.tips=[text];
  else guide[field]=text;
  return knownSpeechIssues(guide).filter(issue=>issue.reason.includes('지원 방향'));
};

for(const adverb of ['꼭','분명히','확실히','반드시','반드시 확실히'])
test('bounded emphasis does not hide recommended support direction: '+adverb,()=>{
  for(const field of ['script','doList','avoid','next','care']){
    assert.equal(directionIssues('너가 제 곁에 있다는 사실을 '+adverb+' 알리고 싶어요.',field).length,1,field);
    assert.equal(directionIssues('네가 곁에 있다는 것을 '+adverb+' 알려주고 싶어.',field).length,1,field);
  }
});

for(const text of [
  '나는 네가 어떤 상황이든 내 곁에 있다는 것을 알려주고 싶어.',
  '네가 곁에 있다는 걸 알리고 싶어.',
  '너가 무슨 일이 있든 제 곁에 있음을 알려주고 싶어요.',
  '당신이 어떤 일이 있어도 곁에 있다는 사실을 알려줄게요.',
  '네가 내 곁에 있다는 걸 알려주고 싶고, 편한 때 이야기하자.',
  '“네가 곁에 있다는 걸 알려주고 싶어”라고 말해 보세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라는 말을 해 보세요.',
  '네가 내 곁에 있다는 걸 알려주고 싶다는 말을 해 보세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라고 전해 보세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라고 말할 거예요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라고 들었어요. “네가 곁에 있다는 걸 알려주고 싶어”라고 말해 보세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라는 말은 하지 않습니다. 대신 “네가 곁에 있다는 걸 알려주고 싶어”라고 전해 보세요.',
  '그 말을 들었다고 해도, “네가 내 곁에 있다는 걸 알려주고 싶어”라고 말해 보세요.',
])test('reversed recommended support is rejected: '+text,()=>{
  for(const field of ['script','doList','avoid','next','care'])assert.equal(directionIssues(text,field).length,1,field);
});

for(const text of [
  '내가 네 곁에 있다는 걸 알리고 싶어.',
  '친구네가 내 곁에 있다는 걸 알려주고 싶어.',
  '걔네가 내 곁에 있다는 걸 알려주고 싶어.',
  '네가 곁에 있어 줘서 고마워.',
  '네가 내 곁에 있다는 걸 알려줘서 고마워.',
  '그때 네가 내 곁에 있었다는 사실을 기억해.',
  '당시 네가 내 곁에 있다는 걸 알려주고 싶었어.',
  '민수는 네가 내 곁에 있다는 걸 알려주고 싶어 했어.',
  '민수가 네가 내 곁에 있다는 걸 알려주고 싶어 한다고 전했어요.',
  '네가 내 곁에 있다는 걸 민수에게 알려주고 싶어.',
  '너가 제 곁에 있다는 사실을 꼭 민수에게 알리고 싶어요.',
  '민수가 “너가 제 곁에 있다는 사실을 분명히 알리고 싶어요”라고 전했어요.',
  '“너가 제 곁에 있다는 사실을 확실히 알리고 싶어요”라는 말은 하지 않습니다.',
  '친구네가 내 곁에 있다는 것을 반드시 알려주고 싶어.',
  '민수가 “네가 내 곁에 있다는 걸 알려주고 싶어”라고 말했어요.',
  '민수가 “네가 내 곁에 있다는 걸 알려주고 싶어”라고 전했어요.',
  '민수가 “네가 내 곁에 있다는 걸 알려주고 싶어”라며 말했어요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라고 들었어요.',
  '민수가 “네가 내 곁에 있다는 걸 알려주고 싶어”라고 말한 적이 있어요.',
  '민수가 “네가 내 곁에 있다는 걸 알려주고 싶어”라는 말을 했어요.',
  '민수가 네가 내 곁에 있다는 걸 알려주고 싶다는 말을 했어요.',
  '“네가 곁에 있다는 걸 알려주고 싶어”라고 그분이 말씀하셨어요.',
  '“네가 곁에 있다는 걸 알려주고 싶어”라는 말을 들었어요.',
  '피할 말: “네가 내 곁에 있다는 걸 알려주고 싶어”. 대신 자신의 도움 의사를 말하세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라는 표현은 피하세요.',
  '“네가 곁에 있다는 걸 알려주고 싶어”라고 말하지 마세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라는 말은 하지 않는 게 좋겠어요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라고 하지 않도록 주의하세요.',
  '“네가 내 곁에 있다는 걸 알려주고 싶어”라는 말은 하지 않습니다.',
  '네가 곁에 있다는 걸 알려주고 싶다면 누구에게 어떤 뜻을 전하려는지 살펴보세요.',
])test('thanks, reported speech and discouraged examples retain their direction: '+text,()=>{
  for(const field of ['script','doList','avoid','next','care'])assert.deepEqual(directionIssues(text,field),[],field);
});

const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
const ref={subject:'patient',question_id:'mood',quote:'저녁에 일정을 다시 살펴봐요'};
const context=()=>({patient:{alias:'연우',fields:{name:field('name','연우'),rel:field('rel','친구'),mood:field('mood',ref.quote)}},
  supporter:{fields:{feeling:field('feeling','걱정돼요')}},user_goal:{message:field('want','내가 곁에 있다는 뜻을 전하고 싶어요')},
  relationship_state:{patient:[{interpretation:'이용자의 관찰입니다.',evidence:[ref],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]},
  answered_count:5,question_candidates:[],name_index:{alias:'연우',source_question_id:'name',quote:'연우'}});
const memory=()=>({summary:'상황을 보고했어요.',facts:[{...ref,interpretation:'이용자의 관찰입니다.',certainty:'reported'}],unknowns:[],user_goal:'내가 곁에 있다는 뜻을 전하고 싶어요'});
const avoidance={avoid_phrase:'재촉하기.',reason:'선택권을 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'};
const good=()=>({guide:{top:'통합',script:'연우야, 저녁에 일정을 다시 살펴보는 모습을 봤어. 네 이야기를 듣고 싶어. 지금 이야기해도 괜찮을까?',
  doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하기. 이유: 선택권을 남겨야 합니다. 대신 편한 시간을 물어보세요.'],
  next:'서로 편한 시간을 정해 보세요.',care:{feel:'걱정된다고 말씀해 주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
const badSpeech='네가 어떤 일이 있어도 내 곁에 있다는 것을 알려주고 싶어.';
const badAlternative='“네가 곁에 있다는 걸 알리고 싶어”라고 말해 보세요.';
const audits=claims=>(claims||[]).map(claim=>({id:claim.id,
  verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',
  reason:'합성 원문과 선택 가능한 제안입니다.'}));

function fixture({target,repaired=true,bundled=true}={}) {
  const requests=[],logical=[],events=[];let repairs=0;
  const ctx=context(),draft=good();
  if(target==='script')draft.guide.script='연우야, 잠깐 이야기할 수 있을까? '+badSpeech+' 어떤 도움이 필요할까?';
  if(target==='avoid')draft.guide.avoid=['피할 말·행동: 재촉하기. 이유: 선택권을 남겨야 합니다. 대신 '+badAlternative];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',reuseFinalDraft:true,bundleFinalReviews:bundled,
    timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl:async(_url,request)=>{
      const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);requests.push(input.stage);
      const produce=task=>{
        const {stage,data,output_schema:schema}=task;logical.push(structuredClone(task));
        if(stage==='relationship_analysis')return {observations:{patient:[ref],supporter:[]},relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}};
        if(stage==='communication_plan')return {voice:'친구에게 건네는 말',opening_evidence:[ref],user_intent:'함께하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',supporter_care:['자신도 쉬세요.'],avoid_patterns:['재촉하지 않기'],next_step:'편한 시간을 정하기'};
        if(stage==='guide_write')return structuredClone(draft);
        if(stage.startsWith('guide_repair_card_')){
          repairs++;const key=Object.keys(schema.properties)[0];
          assert.equal(key,target);
          assert.match(data.task,/내가 네 곁에 있을게/u);
          return key==='avoid'?{avoid:[{...avoidance,...(!repaired?{alternative:badAlternative}:{})}]}:{script:repaired?good().guide.script:draft.guide.script};
        }
        if(stage.startsWith('guide_quality'))return {improvements:[]};
        if(/^(?:analysis_review|speech_review|support_review|speech_detail_review)(?:_|$)/u.test(stage))return {approved:true,issues:[],audits:audits(data.claims)};
        if(/^(?:plan_review|guide_review)(?:_|$)/u.test(stage))return {approved:true,issues:[]};
        if(stage==='speech_detail')return {opening_end:1,listening_end:data.script_units.length-1,
          ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'현재 관찰과 선택권을 구분합니다.',evidence:[ref]}]))};
        assert.fail('Unexpected stage '+stage);
      };
      const value=input.data.tasks?Object.fromEntries(input.data.tasks.map(task=>[task.id,produce({stage:task.stage,
        data:{...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,input.data.shared_inputs[id]]))},
        output_schema:input.output_schema.properties[task.id]})])):produce(input);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,value))}}]}));
    }});
  return {requests,logical,events,repairs:()=>repairs,run:()=>model.respond(ctx,memory(),{onCard:event=>events.push(structuredClone(event))})};
}

for(const target of ['script','avoid'])for(const bundled of [false,true])for(const repaired of [false,true])
test('unanimous model approval still requires support-direction repair and fresh review: '+JSON.stringify({target,bundled,repaired}),async()=>{
  const probe=fixture({target,bundled,repaired});
  if(repaired){
    const result=await probe.run();assert.equal(probe.repairs(),1);assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
    assert.deepEqual(result.guide[target],good().guide[target]);
    assert.ok(probe.logical.some(task=>task.stage==='speech_review_card_'+target+'_after_repair_1'));
    assert.equal(Object.values(result.conversation_detail).map(part=>part.excerpt).join(''),result.guide.script);
  }else{
    await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE'});assert.equal(probe.repairs(),3);
    assert.equal(probe.requests.includes('speech_detail'),false);
  }
  assert.equal(probe.events.some(event=>event.type==='upsert'&&event.id===target&&/네가(?: 어떤 일이 있어도 내)? 곁에/u.test(JSON.stringify(event))),false);
});

test('valid support retains the eight-POST path and original output',async()=>{
  const probe=fixture(),result=await probe.run();
  assert.equal(probe.requests.length,8);assert.equal(probe.repairs(),0);assert.deepEqual(result.guide,good().guide);
});
