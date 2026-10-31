import {createHash} from 'node:crypto';
import {agentContext,canonicalRelationship} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';

const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
const ref=()=>({subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요'});
const name=()=>({alias:'지민',source_question_id:'name',quote:'지민'});
const memory=()=>({summary:'대상자와 이용자의 상황입니다.',facts:[{...ref(),interpretation:'이용자가 관찰했습니다.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'});
const relationshipMemory=()=>({patient:[{interpretation:'밤에 계획표를 고친다는 관찰입니다.',evidence:[ref()],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','자녀'),mood:field('mood','밤에 계획표를 고쳐요')}},
  supporter:{fields:{feeling:field('feeling','무력하고 걱정돼요')}},user_goal:{message:field('want','이해하고 싶어요')},
  relationship_state:relationshipMemory(),agent_state:memory(),name_index:name(),answered_count:4,adaptive_questions:true,
  question_candidates:[{id:'daily',subject:'patient',question:'생활에 어떤 변화가 있나요?'}],
  clarification_candidates:[{id:'support_requested',subject:'patient',question:'원하는 도움이 있나요?'}]});
const analysis=()=>({observations:{patient:[ref()],supporter:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]},
  relationship:{label:'자녀',supporter_role:'부모',dynamics:[{interpretation:'걱정에 응답하는 방식을 살펴볼 수 있어요.',evidence:[ref()],certainty:'tentative'}],strengths:[],boundaries:[]},
  unknowns:['대상자의 도움 의향은 미확인입니다.'],safety:{urgent:false,evidence_ids:[]}});
const plan=()=>({voice:'부모가 자녀에게 건네는 말',opening_evidence:[ref()],user_intent:'이해하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',
  supporter_care:['자신의 휴식도 살펴보세요.'],avoid_patterns:['재촉 대신 허락 구하기'],next_step:'다음 대화 시간을 함께 정하기'});
const guide=()=>({guide:{top:'통합',script:'지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',
  doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하는 말. 이유: 대답할 여유를 남겨야 합니다. 대신 편한 시간을 물어보세요.'],next:'다음 대화 시간을 함께 정하고 자신도 쉬어 보세요.',
  care:{feel:'무력하고 걱정된 마음을 들려주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
const stateStages=['state_observations','relationship_memory','state_review'];
const finalStages=['relationship_analysis','analysis_review','communication_plan','plan_review','guide_write',
  'card_care','card_doList','card_avoid','card_next','speech_opening','speech_listening','speech_offer',
  'speech_write','speech_review_card_care','speech_review_card_doList','speech_review_card_avoid','speech_review_card_next','speech_review_card_script',
  'support_review_card_care','support_review_card_next','guide_quality','speech_review','support_review','guide_review','speech_detail','speech_detail_review'];
const audits=claims=>claims.map(claim=>({id:claim.id,verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문과 일치합니다.'}));
const assertFinalStages=actual=>{
  assert.deepEqual([...actual].sort(),[...finalStages].sort());
  assert.deepEqual(actual.slice(0,5),finalStages.slice(0,5));
  const before=(first,last)=>assert.ok(actual.indexOf(first)<actual.indexOf(last),first+' must precede '+last);
  for(const field of ['care','doList','avoid','next','script']){
    before(field==='script'?'speech_write':'card_'+field,'speech_review_card_'+field);
    before('speech_review_card_'+field,'guide_quality');
  }
  for(const field of ['care','next']){before('speech_review_card_'+field,'support_review_card_'+field);before('support_review_card_'+field,'guide_quality');}
  for(const sequence of [['speech_opening','speech_listening','speech_offer','speech_write'],
    ['guide_quality','speech_review','support_review','guide_review','speech_detail','speech_detail_review']]){
    sequence.slice(1).forEach((stage,index)=>before(sequence[index],stage));
  }
};

function fixtureGateway(stateMode,{skipFinalExtras=false,rejectAnalysis=false,inconsistentAnalysis=false}={}) {
  const requests=[];let analysisReviewAttempts=0;
  const model=new ModelGateway({baseUrl:'https://example.test/v1',apiKey:'test-only-secret',model:'gemma4:12b',
    protocol:'relationship_agent',stateMode,skipFinalExtras,diagnosticLogger:null,fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      requests.push(body);
      const {stage,data,output_schema:schema}=input;
      let payload;
      if(stage==='state_observations')payload={patient_state:{facts:[{...ref(),certainty:'reported'}],unknowns:[]},name_index:name()};
      else if(stage==='relationship_memory')payload={relationship_memory:{patient:[{evidence:[ref()],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]}};
      else if(['state_review','analysis_review','analysis_review_after_repair','speech_review','support_review','speech_detail_review'].includes(stage)||/^(?:speech|support)_review_card_/u.test(stage))payload={approved:true,issues:[],audits:audits(data.claims)};
      else if(['plan_review','guide_review'].includes(stage))payload={approved:true,issues:[]};
      else if(stage==='relationship_analysis'||stage==='analysis_repair')payload=analysis();
      else if(stage==='communication_plan')payload=plan();
      else if(stage==='guide_write')payload=guide();
      else if(stage.startsWith('card_')) {
        const key=Object.keys(schema.properties)[0];payload=key==='avoid'
          ?{avoid:[{avoid_phrase:'재촉하는 말.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'}]}
          :{[key]:guide().guide[key]};
      } else if(stage==='guide_quality')payload={improvements:[]};
      else if(['speech_opening','speech_listening','speech_offer'].includes(stage))payload=Object.fromEntries(Object.keys(schema.properties).map(key=>[key,'원문을 확인하고 이야기를 듣고 싶어.']));
      else if(stage==='speech_write')payload={script:guide().guide.script};
      else if(stage==='speech_detail') {
        payload={opening_end:1,listening_end:data.script_units.length-1,
          ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{
            why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}]))};
      } else assert.fail('Unexpected final stage: '+stage);
      if(inconsistentAnalysis&&stage==='analysis_review'&&++analysisReviewAttempts===1)payload={approved:false,issues:[{field:'relationship_analysis',reason:'dynamics.0의 해석을 수정하세요.',repair:'현재 원문을 대조하세요.'}],audits:data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'현재 원문이 뒷받침합니다.'}))};
      if(rejectAnalysis&&stage.startsWith('analysis_review'))payload={approved:false,issues:[{field:'relationship_analysis',reason:'근거가 불충분합니다.',repair:'원문으로 다시 확인하세요.'}],audits:data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'원문이 충분히 지지하지 않습니다.'}))};
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,payload))}}]}));
    }});
  return {model,requests};
}
const stages=requests=>requests.map(body=>JSON.parse(body.messages.at(-1).content).stage);

test('final state reconstruction preserves every staged request and output even when adaptive questions are enabled',async()=>{
  const combined=fixtureGateway('combined'),staged=fixtureGateway('staged'),ctx=context();
  const output=await combined.model.operation({},operation=>combined.model.relationshipState(ctx,memory(),operation,true));
  const baseline=await staged.model.operation({},operation=>staged.model.relationshipState(ctx,memory(),operation,true));
  assert.deepEqual(stages(combined.requests),stateStages);
  assert.ok(combined.requests.every(body=>!Object.hasOwn(body,'max_tokens')));
  assert.deepEqual(combined.requests,staged.requests); // Includes prompts, inputs, schemas, sampling and token budgets.
  assert.deepEqual(output,baseline);
  assert.deepEqual(output.state_agent.stages,stateStages);
  assert.equal(output.state_agent.reviewed,true);
});

for(const [label,change] of [
  ['missing patient memory',ctx=>{delete ctx.agent_state;}],
  ['stale patient memory',ctx=>{ctx.agent_state.facts[0].quote='이전 답변에서만 존재했던 관찰';}],
  ['missing relationship memory',ctx=>{delete ctx.relationship_state;}],
  ['stale relationship memory',ctx=>{ctx.relationship_state.patient[0].evidence[0].quote='이전 답변에서만 존재했던 관찰';}],
  ['both memories missing',ctx=>{delete ctx.agent_state;delete ctx.relationship_state;}],
]) test('final respond with '+label+' keeps the original three state calls and the complete final pipeline',async()=>{
  const combined=fixtureGateway('combined'),staged=fixtureGateway('staged'),ctx=context();change(ctx);
  const output=await combined.model.respond(structuredClone(ctx));
  const baseline=await staged.model.respond(structuredClone(ctx));
  assert.deepEqual(stages(combined.requests).slice(0,3),stateStages);
  assertFinalStages(stages(combined.requests).slice(3));
  assert.deepEqual(combined.requests,staged.requests);
  assert.deepEqual(output,baseline);
  assert.deepEqual(output.guide,guide().guide);
  assertFinalStages(output.agent.stages);
  assert.equal(output.agent.reviewed,true);assert.equal(output.agent.quality_reviewed,true);
  assert.ok(output.conversation_detail);
});

test('final respond with valid memories skips reconstruction and keeps final generation, reviews and postprocessing identical',async()=>{
  const combined=fixtureGateway('combined'),staged=fixtureGateway('staged');
  const output=await combined.model.respond(context());
  const baseline=await staged.model.respond(context());
  assertFinalStages(stages(combined.requests));
  assert.deepEqual(combined.requests,staged.requests);
  assert.deepEqual(output,baseline);
  assert.deepEqual(output.guide,guide().guide);
  assertFinalStages(output.agent.stages);
  assert.ok(output.conversation_detail);
});


test('opt-in final extras skip keeps all required reviews and original cards',async()=>{
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras:true});const output=await model.respond(context());
  const optional=/^(communication_plan|plan_review|guide_quality|guide_refine|speech_detail|card_|speech_opening|speech_listening|speech_offer|speech_write)/;
  assert.ok(stages(requests).every(stage=>!optional.test(stage)));
  assert.deepEqual([...stages(requests)].sort(),finalStages.filter(stage=>!optional.test(stage)).sort());
  assert.deepEqual(output.guide,guide().guide);assert.equal(output.agent.reviewed,true);assert.equal(output.agent.quality_reviewed,false);
  assert.equal(Object.hasOwn(output,'conversation_detail'),false);
  for(const request of requests){const input=JSON.parse(request.messages.at(-1).content);assert.equal(Object.hasOwn(input.data,'plan'),false,input.stage);}
  assert.ok(stages(requests).includes('guide_review'));
  assert.ok(stages(requests).includes('speech_review_card_script'));
  assert.ok(stages(requests).includes('support_review_card_care'));
});
test('opt-in final extras skip cannot bypass independent analysis rejection',async()=>{
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras:true,rejectAnalysis:true});
  await assert.rejects(model.respond(context()),{modelReason:'agent_analysis_review_rejected'});
  assert.ok(stages(requests).includes('analysis_review'));assert.ok(stages(requests).includes('analysis_review_after_repair'));
  assert.ok(stages(requests).every(stage=>!stage.startsWith('guide_write')));
});

test('final analysis retries an inconsistent review without regenerating its accepted draft',async()=>{
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras:true,inconsistentAnalysis:true});const output=await model.respond(context());
  const sequence=stages(requests);assert.equal(sequence.filter(stage=>stage==='relationship_analysis').length,1);
  assert.equal(sequence.filter(stage=>stage==='analysis_review').length,2);assert.equal(sequence.includes('analysis_repair'),false);
  assert.equal(output.agent.reviewed,true);assert.deepEqual(output.guide,guide().guide);
});

test('fast final draft cannot bypass the selected treatment-goal speech invariant',async()=>{
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras:true}),ctx=context();
  ctx.user_goal.desired_outcomes={...field('goal','상담이나 진료를 권하고 싶어요'),selected:[{label:'상담이나 진료를 권하고 싶어요',meta:{t:'goal_treat'}}]};
  await assert.rejects(model.respond(ctx),{modelReason:'agent_goal_missing'});
  assert.equal(stages(requests).filter(stage=>stage==='guide_write').length,3);
  assert.ok(stages(requests).every(stage=>!stage.startsWith('speech_review_card_')));
});

for(const skipFinalExtras of [false,true])test('final reviewer preserves explicit self-reported feeling paraphrases without waiving unsupported claims: fast='+skipFinalExtras,async()=>{
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras}),ctx=context(),before=structuredClone(ctx);
  const result=await model.respond(ctx);
  const review=requests.find(request=>JSON.parse(request.messages.at(-1).content).stage==='guide_review');
  assert.ok(review);const prompt=review.messages[0].content;
  assert.match(prompt,/자신의 감정을 직접 말한 원문은 그 감정에 대한 보고 근거/u);
  assert.match(prompt,/원문과 단어가 다르거나/u);assert.match(prompt,/정확한 원문 반복이나 특정 보고 문구의 삽입 자체를 승인 조건으로 삼지/u);
  assert.match(prompt,/감정·원인·강도를 더하거나 이용자의 감정을 다른 사람에게 옮긴 경우/u);
  assert.match(prompt,/실제 의미·화자·근거 불일치/u);
  assert.deepEqual(ctx,before);assert.deepEqual(result.guide,guide().guide);assert.equal(result.agent.reviewed,true);
  assert.deepEqual(JSON.parse(review.messages.at(-1).content).output_schema.properties.approved,{type:'boolean'});
});

const finalSeed=ctx=>{
  const answers=agentContext(ctx),draftAnalysis=analysis();draftAnalysis.safety={urgent:false,evidence:[]};
  return {seed_id:'synthetic_actual_trace',answers,context_fingerprint:createHash('sha256').update(JSON.stringify(answers)).digest('hex'),
    analysis:canonicalRelationship(draftAnalysis,ctx),draft:guide()};
};
test('trusted same-context seed skips only initial writers and still runs all fresh required reviews',async()=>{
  const ctx=context(),{model,requests}=fixtureGateway('combined',{skipFinalExtras:true});model.finalDraftSeed=finalSeed(ctx);
  const before=structuredClone(model.finalDraftSeed),result=await model.respond(ctx),actual=stages(requests);
  assert.equal(actual.includes('relationship_analysis'),false);assert.equal(actual.includes('guide_write'),false);
  for(const stage of ['analysis_review','speech_review_card_script','support_review_card_care','speech_review','support_review','guide_review'])assert.ok(actual.includes(stage),stage);
  assert.deepEqual(result.agent.stages,actual);assert.deepEqual(result.agent.seed_reuse,{source:'trusted_local_seed',seed_id:before.seed_id,context_fingerprint:before.context_fingerprint,stages:['relationship_analysis','guide_write']});
  assert.deepEqual(result.guide,before.draft.guide);assert.deepEqual(result.relationship_analysis,before.analysis);assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,false);
  assert.deepEqual(model.finalDraftSeed,before);
});
for(const mutation of ['context','fingerprint','answers','analysis','draft','seed_id'])test('trusted final seed fails closed for '+mutation,async()=>{
  const ctx=context(),{model,requests}=fixtureGateway('combined',{skipFinalExtras:true});model.finalDraftSeed=finalSeed(ctx);
  if(mutation==='context')ctx.supporter.fields.feeling=field('feeling','현재는 마음이 달라요.');
  if(mutation==='fingerprint')model.finalDraftSeed.context_fingerprint='0'.repeat(64);
  if(mutation==='answers')model.finalDraftSeed.answers.alias='다른 사람';
  if(mutation==='analysis')model.finalDraftSeed.analysis.relationship.dynamics[0].evidence[0].quote='없는 원문';
  if(mutation==='draft')delete model.finalDraftSeed.draft.guide.care;
  if(mutation==='seed_id')model.finalDraftSeed.seed_id='not a valid id';
  await assert.rejects(model.respond(ctx),{code:'MODEL_SEED_INVALID',modelReason:'final_seed_invalid'});
  assert.equal(stages(requests).includes('guide_write'),false);assert.equal(stages(requests).includes('guide_review'),false);
  if(mutation!=='draft')assert.equal(requests.length,0);
});
test('seed cannot bypass a fresh analysis rejection and repair still uses the model',async()=>{
  const ctx=context(),{model,requests}=fixtureGateway('combined',{skipFinalExtras:true,rejectAnalysis:true});model.finalDraftSeed=finalSeed(ctx);
  await assert.rejects(model.respond(ctx),{modelReason:'agent_analysis_review_rejected'});
  assert.deepEqual(stages(requests),['analysis_review','analysis_repair','analysis_review_after_repair']);
});
test('seed is never accepted from conversation or request options',async()=>{
  const ctx=context(),{model,requests}=fixtureGateway('combined',{skipFinalExtras:true}),seed=finalSeed(ctx);
  ctx.finalDraftSeed=seed;
  const result=await model.respond(ctx,null,{finalDraftSeed:seed});
  assert.ok(stages(requests).includes('relationship_analysis'));assert.ok(stages(requests).includes('guide_write'));assert.equal(Object.hasOwn(result.agent,'seed_reuse'),false);
});

for(const skipFinalExtras of [false,true])test('whole-guide review excludes only historical derived memory while preserving every original answer: fast='+skipFinalExtras,async()=>{
  const ctx=context(),oldText='이전 메모리에서만 등장한 합성 추정입니다.';
  ctx.relationship_state.relationship=[{interpretation:oldText,evidence:[ref()],certainty:'tentative'}];
  const before=structuredClone(ctx),expected=agentContext(ctx);delete expected.prior_relationship_memory;
  const {model,requests}=fixtureGateway('combined',{skipFinalExtras});const result=await model.respond(ctx);
  const initial=JSON.parse(requests.find(request=>JSON.parse(request.messages.at(-1).content).stage==='relationship_analysis').messages.at(-1).content);
  assert.ok(JSON.stringify(initial.data.prior_relationship_memory).includes(oldText));
  const finals=requests.filter(request=>JSON.parse(request.messages.at(-1).content).stage.startsWith('guide_review'));
  assert.ok(finals.length);
  for(const request of finals){
    const input=JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(input.data.answers,expected);assert.equal(JSON.stringify(input.data).includes(oldText),false);
    assert.deepEqual(input.data.analysis,result.relationship_analysis);assert.deepEqual(input.data.guide,result.guide);
    assert.match(request.messages[0].content,/현재 data.analysis와 data.guide/u);
    assert.match(request.messages[0].content,/현재 analysis 또는 guide에 실제로 있는지/u);
  }
  assert.deepEqual(ctx,before);assert.deepEqual(result.guide,guide().guide);assert.equal(result.agent.reviewed,true);
});
