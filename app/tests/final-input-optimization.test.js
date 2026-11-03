import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {safetySources,urgentGuideActions} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

// Synthetic conversation only. Every response passes the real HTTP parser,
// schema/evidence validators, card gates and final-detail contract.
const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
const ref=()=>({subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요'});
const name=()=>({alias:'지민',source_question_id:'name',quote:'지민'});
const memory=()=>({summary:'대상자와 이용자의 상황입니다.',facts:[{...ref(),interpretation:'이용자가 관찰했습니다.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','자녀'),mood:field('mood','밤에 계획표를 고쳐요')}},
  supporter:{fields:{feeling:field('feeling','무력하고 걱정돼요')}},user_goal:{message:field('want','이해하고 싶어요')},
  relationship_state:{patient:[{interpretation:'밤에 계획표를 고친다는 관찰입니다.',evidence:[ref()],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]},
  agent_state:memory(),name_index:name(),answered_count:4,question_candidates:[]});
const analysis=()=>({observations:{patient:[ref()],supporter:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]},
  relationship:{label:'자녀',supporter_role:'부모',dynamics:[{interpretation:'걱정에 응답하는 방식을 살펴볼 수 있어요.',evidence:[ref()],certainty:'tentative'}],strengths:[],boundaries:[]},
  unknowns:['대상자의 도움 의향은 미확인입니다.'],safety:{urgent:false,evidence_ids:[]}});
const plan=()=>({voice:'부모가 자녀에게 건네는 말',opening_evidence:[ref()],user_intent:'이해하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',
  supporter_care:['자신의 휴식도 살펴보세요.'],avoid_patterns:['재촉 대신 허락 구하기'],next_step:'다음 대화 시간을 함께 정하기'});
const avoid={avoid_phrase:'재촉하는 말.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'};
const guide=()=>({guide:{top:'통합',script:'지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',
  doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하는 말. 이유: 대답할 여유를 남겨야 합니다. 대신 편한 시간을 물어보세요.'],
  next:'다음 대화 시간을 함께 정하고 자신도 쉬어 보세요.',care:{feel:'무력하고 걱정된 마음을 들려주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
const reviewStages=['analysis_review','plan_review',
  ...['script','care','doList','avoid','next'].map(key=>'speech_review_card_'+key),
  'support_review_card_care','support_review_card_next','guide_quality','speech_review','support_review','guide_review','speech_detail_review'];
const audits=claims=>(claims||[]).map(claim=>({id:claim.id,
  verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',
  reason:'합성 원문과 선택 가능한 제안입니다.'}));
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

function fixture({reuseFinalDraft=true,compactReviewInputs=false,scopedQualityRefinement=false,ctx=context(),validGuide=guide(),response:override}={}) {
  const requests=[],events=[];
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined',reuseFinalDraft,compactReviewInputs,scopedQualityRefinement,
    timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl:async (_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      requests.push({body,input:structuredClone(input)});
      const {stage,data,output_schema:schema}=input;
      let payload;
      if(/^(?:relationship_analysis|analysis_repair)(?:_|$)/u.test(stage))payload=analysis();
      else if(/^communication_plan(?:_|$)/u.test(stage))payload=plan();
      else if(/^guide_(?:write|refine)(?:_|$)/u.test(stage))payload=structuredClone(validGuide);
      else if(/^guide_repair(?:_|$)/u.test(stage)) {
        const key=Object.keys(schema.properties)[0];
        payload=key==='avoid'?{avoid:[structuredClone(avoid)]}:{[key]:structuredClone(validGuide.guide[key])};
      } else if(/^guide_quality(?:_|$)/u.test(stage))payload={improvements:[]};
      else if(/^(?:analysis_review|speech_review|support_review|speech_detail_review)(?:_|$)/u.test(stage))payload={approved:true,issues:[],audits:audits(data.claims)};
      else if(/^(?:plan_review|guide_review)(?:_|$)/u.test(stage))payload={approved:true,issues:[]};
      else if(stage.startsWith('card_')) {
        const key=Object.keys(schema.properties)[0];
        payload=key==='avoid'?{avoid:[structuredClone(avoid)]}:{[key]:structuredClone(validGuide.guide[key])};
      } else if(/^speech_(?:opening|listening|offer)(?:_|$)/u.test(stage))payload=Object.fromEntries(Object.keys(schema.properties).map(key=>[key,'원문을 확인하고 이야기를 듣고 싶어.']));
      else if(/^speech_write(?:_|$)/u.test(stage))payload={script:validGuide.guide.script};
      else if(/^speech_detail(?:_|$)/u.test(stage))payload={opening_end:1,listening_end:data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}]))};
      else assert.fail('Unexpected stage '+stage);
      const changed=await override?.(input,body,payload);
      if(changed instanceof Response)return changed;
      return envelope(evidenceWireFixture(input,changed===undefined?payload:changed));
    }});
  return {gateway,requests,events,ctx,
    stages:()=>requests.map(({input})=>input.stage),
    run:options=>gateway.respond(ctx,ctx.agent_state,{onCard:event=>events.push(structuredClone(event)),...options})};
}

function assertDetail(output) {
  assert.equal(output.agent.reviewed,true);
  assert.equal(output.agent.quality_reviewed,true);
  assert.deepEqual(Object.keys(output.conversation_detail),['opening','listening','offer']);
  assert.equal(Object.values(output.conversation_detail).map(part=>part.excerpt).join(''),output.guide.script);
  for(const part of Object.values(output.conversation_detail)) {
    assert.ok(part.why.length>0);
    assert.deepEqual(part.evidence,[ref()]);
  }
}

test('compact reviews preserve every review, source, claim and stored value while removing only duplicate inputs',async()=>{
  const legacy=fixture(),compact=fixture({compactReviewInputs:true});
  const [baseline,output]=await Promise.all([legacy.run(),compact.run()]);
  assert.deepEqual(output,baseline);
  assert.equal(compact.requests.length,18);
  for(const {body,input} of compact.requests) {
    const original=legacy.requests.find(request=>request.input.stage===input.stage);
    assert.ok(original,input.stage);
    assert.deepEqual(input.output_schema,original.input.output_schema,input.stage);
    const expected=structuredClone(original.input.data);
    if(/^speech_review(?:_|$)/u.test(input.stage)&&typeof expected.script==='string'&&expected.script===expected.guide?.script)delete expected.script;
    assert.deepEqual(input.data,expected,input.stage+' retains all claims and retrieval');
    if(input.stage.startsWith('speech_review_card_')) {
      const field=input.data.review_scope.guide_fields[0];
      assert.match(body.messages[0].content,/카드의 역할/u);
      assert.equal(body.messages[0].content.includes('\navoid는'),field==='avoid');
      assert.equal(body.messages[0].content.includes('\ncare의'),field==='care');
    } else assert.equal(body.messages[0].content,original.body.messages[0].content,input.stage);
  }
  const bytes=value=>value.requests.reduce((sum,{body})=>sum+Buffer.byteLength(JSON.stringify(body)),0);
  assert.ok(bytes(compact)<bytes(legacy));
  assertDetail(output);
});

for(const reuseFinalDraft of [false,true])test('scoped quality updates multiple fields in one request and preserves every other value, O4='+reuseFinalDraft,async()=>{
  const revised=guide();revised.guide.script+=' 답하기 편할 때 알려 줘.';revised.guide.next='다음 대화 시간은 서로 편한 때로 함께 정해 보세요.';
  const value=fixture({reuseFinalDraft,compactReviewInputs:true,scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[
      {field:'script',reason:'답변 선택권을 명확히 하세요.',repair:'편할 때 답하도록 안내하세요.'},
      {field:'next',reason:'대화 시간을 함께 정하세요.',repair:'서로 편한 시간을 묻도록 쓰세요.'},
      {field:'script',reason:'선택권을 유지하세요.',repair:'답변을 재촉하지 마세요.'}]};
    if(input.stage==='guide_refine') {
      assert.deepEqual(Object.keys(input.output_schema.properties),['script','next']);
      assert.deepEqual(input.output_schema.required,['script','next']);
      assert.equal(input.output_schema.additionalProperties,false);
      return {script:revised.guide.script,next:revised.guide.next};
    }
    if(input.stage==='guide_quality_check') {
      assert.deepEqual(input.data.revision.before,guide().guide);
      assert.deepEqual(input.data.revision.after,revised.guide);
    }
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(stages.filter(stage=>stage==='guide_refine').length,1);
  assert.equal(stages.length,reuseFinalDraft?20:28);
  for(const stage of [...reviewStages,'guide_quality_check'])assert.equal(stages.filter(candidate=>candidate===stage).length,1,stage);
  assert.deepEqual(output.guide,revised.guide);
  assert.deepEqual(output.assessment,revised.assessment);
  assertDetail(output);
  const prompt=value.requests.find(({input})=>input.stage==='guide_refine').body.messages[0].content;
  assert.match(prompt,/품질 수정 출력 계약/u);
  assert.doesNotMatch(prompt,/출력은 기존 스키마의 guide와 assessment를 포함/u);
  if(reuseFinalDraft) {
    assert.match(prompt,/전체 카드 초안 재사용 계약/u);
    assert.match(prompt,/세 문단 사이에 빈 줄/u);
    assert.match(prompt,/피할 말·행동: <피할 구체적인 말이나 행동> 이유:/u);
  }
});

for(const [label,patch] of [
  ['missing field',{}],
  ['unrequested card',{next:'다음 대화 시간을 함께 정해 보세요.',script:guide().guide.script}],
  ['assessment',{next:'다음 대화 시간을 함께 정해 보세요.',assessment:{safety:true}}],
  ['full guide',guide()],
])test('scoped quality rejects '+label+' without publishing or saving the patch',async()=>{
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'next',reason:'대화 시간을 함께 정하세요.',repair:'서로 편한 때를 선택하도록 쓰세요.'}]};
    if(input.stage==='guide_refine')return structuredClone(patch);
  }});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(value.stages().filter(stage=>stage==='guide_refine').length,3);
  assert.ok(!value.stages().includes('guide_quality_check'));
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
  assert.equal(value.events.at(-1).type,'reset');
});

test('scoped refinement cannot bypass the full speech validator',async()=>{
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'script',reason:'관찰을 구체화하세요.',repair:'원문 장면만 전하세요.'}]};
    if(input.stage==='guide_refine')return {script:'네가 얼마나 노력하는지 잘 알고 있어. 지금 이야기해도 괜찮을까?'};
  }});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_script_inference'});
  assert.ok(!value.stages().includes('guide_quality_check'));
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
});

test('compact and scoped modes retain whole-guide rejection after refinement',async()=>{
  const value=fixture({compactReviewInputs:true,scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'next',reason:'시간 선택을 분명히 하세요.',repair:'편한 시간을 물어보도록 쓰세요.'}]};
    if(input.stage==='guide_refine')return {next:'서로 편한 다음 대화 시간을 함께 정해 보세요.'};
    if(input.stage.startsWith('guide_review'))return {approved:false,issues:[{field:'next',reason:'현재 원문과 맞지 않습니다.',repair:'원문 근거를 다시 확인하세요.'}]};
  }});
  await assert.rejects(value.run(),{modelReason:'agent_review_rejected'});
  assert.ok(value.stages().includes('guide_quality_check'));
  assert.ok(value.stages().includes('guide_review_after_repair_2'));
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
});

test('scoped refinement still stops when the full quality recheck finds an unresolved issue',async()=>{
  const issue={field:'next',reason:'대화 시간의 선택권이 남아 있어야 합니다.',repair:'상대가 편한 때를 함께 정하도록 쓰세요.'};
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality'||input.stage==='guide_quality_check')return {improvements:[issue]};
    if(input.stage==='guide_refine')return {next:guide().guide.next};
  }});
  await assert.rejects(value.run(),{modelReason:'agent_quality_review_rejected'});
  assert.equal(value.stages().filter(stage=>stage==='guide_refine').length,1);
  assert.ok(value.stages().every(stage=>!['speech_review','support_review','guide_review','speech_detail'].includes(stage)));
  assert.equal(value.events.at(-1).type,'reset');
});

test('scoped quality cancellation never reaches final verification or detail',async()=>{
  const controller=new AbortController();
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'next',reason:'시간 선택을 분명히 하세요.',repair:'편한 시간을 물어보도록 쓰세요.'}]};
    if(input.stage==='guide_refine') {controller.abort();return {next:guide().guide.next};}
  }});
  await assert.rejects(value.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.ok(!value.stages().includes('guide_quality_check'));
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
  assert.equal(value.events.at(-1).type,'reset');
});

for(const invalidTips of [false,true])test('urgent scoped refinement preserves fixed actions and tips, invalidTips='+invalidTips,async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');
  const actions=urgentGuideActions(ctx.name_index),urgent=guide();
  urgent.guide={...urgent.guide,...actions,care:{...urgent.guide.care,...actions.care}};
  urgent.assessment.safety=true;
  const feel='무력하고 걱정되는 마음을 말씀해 주셨어요.';
  const value=fixture({ctx,validGuide:urgent,compactReviewInputs:true,scopedQualityRefinement:true,response:input=>{
    if(input.stage==='relationship_analysis') {
      const result=analysis();result.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};return result;
    }
    if(input.stage==='guide_quality')return {improvements:[{field:'care',reason:'보고한 감정을 반영하세요.',repair:'원문의 걱정과 무력감만 공감하세요.'}]};
    if(input.stage==='guide_refine') {
      assert.deepEqual(Object.keys(input.output_schema.properties),['care']);
      assert.deepEqual(input.output_schema.properties.care.properties.tips.enum,[actions.care.tips]);
      return {care:{feel,tips:invalidTips?['도움을 나중으로 미루세요.']:actions.care.tips}};
    }
  }});
  if(invalidTips) {
    await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
    assert.ok(!value.stages().includes('guide_quality_check'));
  } else {
    const output=await value.run();
    assert.deepEqual(output.guide,{...urgent.guide,care:{feel,tips:actions.care.tips}});
    assert.deepEqual(output.assessment,urgent.assessment);
    assert.ok(value.stages().includes('guide_quality_check'));
    assert.ok(value.stages().includes('guide_review'));
    assert.equal(value.stages().filter(stage=>stage==='guide_refine').length,1);
  }
});
