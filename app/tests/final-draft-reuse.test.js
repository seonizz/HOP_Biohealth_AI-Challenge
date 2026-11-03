import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {safetySources,urgentGuideActions} from '../src/relationship-agent.js';
import {COMMON,SPEAK,WRITE,CARD_ROLES,AVOID_CARD_WIRE} from '../src/relationship-prompts.js';
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
const generationStages=['relationship_analysis','communication_plan','guide_write','speech_detail'];
const redundantStages=/^(?:card_|speech_(?:opening|listening|offer|write)(?:_|$))/u;
const cardFields=['script','care','doList','avoid','next'];
const audits=claims=>(claims||[]).map(claim=>({id:claim.id,
  verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',
  reason:'합성 원문과 선택 가능한 제안입니다.'}));
const rejectedAudits=claims=>claims.map(claim=>({id:claim.id,
  verdict:claim.claim_kind==='avoidance_guidance'?'problem_in_recommended_content':claim.claim_kind==='guidance'?'problem_in_guidance':'unsupported',
  reason:'화자와 듣는 목적이 다릅니다.'}));
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

function fixture({reuseFinalDraft=true,ctx=context(),validGuide=guide(),response:override}={}) {
  const requests=[],events=[];
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined',reuseFinalDraft,
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

test('guarded policy reuse reduces normal O4 capability GETs from 15 to 2 without changing its 18 POSTs or saved output',async()=>{
  const run=async reuseTokenPolicy=>{
    const value=fixture(),transport=value.gateway.fetchImpl;
    let gets=0;
    const fetchImpl=async(url,request)=>{
      if(request.method==='GET'){
        gets++;return new Response(JSON.stringify({model:'synthetic-model',max_output_tokens:8192,max_context_tokens:32768,
          token_policy_revision:'c'.repeat(64)}));
      }
      return transport(url,request);
    };
    Object.assign(value.gateway,{fetchImpl,discoverTokenLimits:true,reuseTokenPolicy});
    value.gateway.reviewGateway=new ModelGateway({baseUrl:'https://reviewer.invalid/v1',apiKey:'synthetic-review-key',model:'synthetic-model',
      protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,diagnosticLogger:null,
      fetchImpl,discoverTokenLimits:true,reuseTokenPolicy});
    const output=await value.run();
    assertDetail(output);assert.equal(value.requests.length,18);
    return {output,gets,requests:value.requests};
  };
  const before=await run(false),after=await run(true);
  assert.equal(before.gets,15);assert.equal(after.gets,2);
  assert.deepEqual(after.output,before.output);assert.deepEqual(after.requests,before.requests);
});

test('O4 uses 18 HTTP calls and retains all 14 independent reviews plus the full storage payload',async()=>{
  const reused=fixture(),legacy=fixture({reuseFinalDraft:false});
  const output=await reused.run(),baseline=await legacy.run();
  const stages=reused.stages();
  assert.equal(stages.length,18);
  assert.equal(legacy.stages().length,26);
  assert.equal(legacy.stages().filter(stage=>redundantStages.test(stage)).length,8);
  assert.deepEqual([...stages].sort(),[...generationStages,...reviewStages].sort());
  assert.deepEqual(stages.slice(0,5),['relationship_analysis','analysis_review','communication_plan','plan_review','guide_write']);
  assert.deepEqual(stages.slice(-6),['guide_quality','speech_review','support_review','guide_review','speech_detail','speech_detail_review']);
  assert.ok(stages.every(stage=>!redundantStages.test(stage)));
  for(const stage of reviewStages)assert.equal(stages.filter(value=>value===stage).length,1,stage);
  for(const key of cardFields)assert.ok(stages.indexOf('speech_review_card_'+key)<stages.indexOf('guide_quality'));
  for(const key of ['care','next'])assert.ok(stages.indexOf('speech_review_card_'+key)<stages.indexOf('support_review_card_'+key));
  assertDetail(output);
  assert.equal(output.agent.final_draft_reused,true);
  assert.equal(baseline.agent.final_draft_reused,undefined);
  for(const key of ['guide','assessment','patient_state','name_index','relationship_analysis','relationship_memory','conversation_detail'])
    assert.deepEqual(output[key],baseline[key],key+' storage contract');
  assert.deepEqual(output.agent.retrieval.stages.map(row=>row.stage).sort(),[...stages].sort());
  for(const field of cardFields)assert.ok(reused.events.some(event=>event.type==='upsert'&&event.id===field),field);
});

for(const [label,badScript,change] of [
  ['mind reading','지민아, 네가 얼마나 잘하고 싶어 하는지 느껴져. 지금 이야기해도 괜찮을까?'],
  ['repeated permission','지금 이야기해도 괜찮을까? 잠깐 대화해도 괜찮을까? 밤에 계획표를 고치는 모습을 봤어.'],
  ['third-person address','그분이 어떤지 듣고 싶어요. 지금 이야기해도 괜찮을까?',ctx=>{ctx.name_index=null;}],
  ['missing treatment offer',guide().guide.script,ctx=>{
    ctx.user_goal.desired_outcomes={...field('goal','상담이나 진료를 권하고 싶어요'),selected:[{label:'상담이나 진료를 권하고 싶어요',meta:{t:'goal_treat'}}]};
  }],
]) test('O4 repairs only script for '+label+' and reviews it before partial publication',async()=>{
  const ctx=context();change?.(ctx);
  const valid=guide();
  if(label==='missing treatment offer')valid.guide.script+=' 원하면 상담을 함께 알아볼지 정해 줘.';
  if(label==='third-person address')valid.guide.script=valid.guide.script.replace('지민아, ','');
  const value=fixture({ctx,validGuide:valid,response:input=>{
    if(input.stage==='guide_write'){const bad=structuredClone(valid);bad.guide.script=badScript;return bad;}
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(stages.length,20,'Only one repair and one fresh card review are added to the 18-call path');
  assert.equal(stages.filter(stage=>stage==='guide_write').length,1);
  const repair=stages.findIndex(stage=>stage.startsWith('guide_repair_card_script'));
  assert.ok(repair>=0);
  const repairPrompt=value.requests[repair].body.messages[0].content;
  assert.equal(repairPrompt.split(COMMON).length-1,1,'The shared contract appears once in an actual script repair request');
  assert.ok(repairPrompt.startsWith(SPEAK+'\n지적된 카드 하나의 오류만 고칩니다. 다른 카드는 작성하지 마세요.'));
  assert.ok(stages.slice(repair+1).some(stage=>stage.startsWith('speech_review_card_script')));
  assert.equal(stages.filter(stage=>/^guide_repair_card_/u.test(stage)).length,1);
  assert.ok(stages.every(stage=>!redundantStages.test(stage)));
  assert.equal(output.guide.script,valid.guide.script);
  for(const key of cardFields.filter(key=>key!=='script'))assert.deepEqual(output.guide[key],valid.guide[key]);
  const published=value.events.filter(event=>event.type==='upsert').map(event=>event.card||event);
  assert.ok(published.filter(card=>card.id==='script').every(card=>card.value!==badScript));
  assertDetail(output);
});

test('O4 routes a non-script local card issue through that card repair and both care reviews',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='guide_write'){const bad=guide();bad.guide.care.feel='혼자 돌봄을 감당하고 계시는군요.';return bad;}
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(stages.filter(stage=>stage==='guide_write').length,1);
  assert.equal(stages.filter(stage=>/^guide_repair_card_/u.test(stage)).length,1);
  const repair=stages.findIndex(stage=>stage.startsWith('guide_repair_card_care'));
  assert.ok(repair>=0);
  const repairPrompt=value.requests[repair].body.messages[0].content;
  assert.equal(repairPrompt.split(COMMON).length-1,1);
  assert.ok(repairPrompt.startsWith(COMMON+'\n'+CARD_ROLES.care));
  assert.ok(stages.slice(repair+1).some(stage=>stage.startsWith('speech_review_card_care')));
  assert.ok(stages.slice(repair+1).some(stage=>stage.startsWith('support_review_card_care')));
  assert.deepEqual(output.guide,guide().guide);
  assert.ok(value.events.filter(event=>event.type==='upsert'&&(event.card||event).id==='care')
    .every(event=>(event.card||event).value.feel!=='혼자 돌봄을 감당하고 계시는군요.'));
  assertDetail(output);
});

test('O4 repairs incomplete avoid bundles without recreating the other four cards',async()=>{
  const bad=['재촉하지 마세요.','대신 편한 시간을 물어보세요.'];
  const value=fixture({response:input=>{
    if(input.stage==='guide_write'){const draft=guide();draft.guide.avoid=bad;return draft;}
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(stages.filter(stage=>stage==='guide_write').length,1);
  const repairs=stages.filter(stage=>/^guide_repair_card_/u.test(stage));
  assert.equal(repairs.length,1);
  assert.match(repairs[0],/^guide_repair_card_avoid/u);
  const repair=stages.indexOf(repairs[0]);
  const repairPrompt=value.requests[repair].body.messages[0].content;
  assert.equal(repairPrompt.split(COMMON).length-1,1);
  assert.ok(repairPrompt.startsWith(COMMON+'\n'+CARD_ROLES.avoid+AVOID_CARD_WIRE));
  assert.ok(stages.slice(repair+1).some(stage=>stage.startsWith('speech_review_card_avoid')));
  assert.deepEqual(output.guide,guide().guide);
  assert.ok(value.events.filter(event=>event.type==='upsert'&&(event.card||event).id==='avoid')
    .every(event=>JSON.stringify((event.card||event).value)!==JSON.stringify(bad)));
  assertDetail(output);
});

test('O4 top repair keeps the fallback writer contract once and preserves full reviews and detail',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='guide_write'){const bad=guide();bad.guide.top='우울';return bad;}
    if(input.stage==='guide_review')return {approved:false,issues:[{field:'top',reason:'현재 안내 범위를 다시 확인하세요.',repair:'전체 원문의 범위로 안내 분류를 고치세요.'}]};
  }});
  const output=await value.run(),stages=value.stages();
  const repair=value.requests.find(({input})=>input.stage==='guide_repair');
  assert.ok(repair);
  assert.equal(repair.input.data.field,'top');
  const prompt=repair.body.messages[0].content;
  assert.equal(prompt.split(COMMON).length-1,1);
  assert.ok(prompt.startsWith(WRITE+'\n지적된 카드 하나의 오류만 고칩니다. 다른 카드는 작성하지 마세요.'));
  assert.equal(stages.length,22,'One field repair and three renewed whole-guide reviews are added');
  for(const stage of reviewStages)assert.ok(stages.includes(stage),stage);
  for(const stage of ['speech_review_after_repair','support_review_after_repair','guide_review_after_repair'])assert.ok(stages.includes(stage),stage);
  assert.deepEqual(output.guide,guide().guide);
  assertDetail(output);
});

test('O4 aggregate draft retains every supporter source previously pinned for the separate care writer',async()=>{
  const ctx=context();
  for(let index=0;index<10;index++)ctx.supporter.fields['resource_'+index]=field('resource_'+index,'배경 기록 '+index+': 책갈피 '+index);
  const value=fixture({ctx});
  await value.run();
  const draft=value.requests.find(({input})=>input.stage==='guide_write').input;
  const included=new Set(draft.data.retrieval.documents.filter(row=>row.subject==='supporter').map(row=>row.question_id));
  for(const key of Object.keys(ctx.supporter.fields))assert.ok(included.has(key),key);
});

for(const [label,mutate,reason] of [
  ['missing required card',value=>{delete value.guide.care;},'agent_schema'],
  ['global safety mismatch',value=>{value.assessment.safety=true;},'agent_safety_mismatch'],
]) test('O4 cannot convert '+label+' into a card-local approval',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='guide_write'){const bad=guide();mutate(bad);return bad;}
  }});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:reason});
  const stages=value.stages();
  assert.equal(stages.filter(stage=>stage==='guide_write').length,3);
  assert.ok(stages.every(stage=>!/^guide_repair_card_|^(?:speech|support)_review_card_/u.test(stage)));
  assert.ok(value.events.filter(event=>event.type==='upsert').every(event=>!cardFields.includes((event.card||event).id)));
});

test('O4 invalid JSON remains a whole-request failure and cannot publish any draft card',async()=>{
  const value=fixture({response:input=>input.stage==='guide_write'
    ?new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{not valid JSON'}}]})):undefined});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,3);
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_review_card_')));
  assert.ok(value.events.filter(event=>event.type==='upsert').every(event=>!cardFields.includes((event.card||event).id)));
});

test('O4 preserves independent card rejection and never publishes the rejected draft',async()=>{
  const bad=guide();bad.guide.script='지민아, 밤에 계획표를 고치는 모습을 봤어. 내 이야기를 먼저 들어 줄래? 지금 이야기해도 괜찮을까?';
  let rejected=false;
  const value=fixture({response:(input,_body,payload)=>{
    if(input.stage==='guide_write')return bad;
    if(input.stage==='speech_review_card_script'&&!rejected){rejected=true;return {approved:false,
      issues:[{field:'script',reason:'상대의 이야기를 듣는 목적과 다릅니다.',repair:'이용자가 상대의 이야기를 듣고 싶다고 표현하세요.'}],
      audits:rejectedAudits(input.data.claims)};}
    return payload;
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(rejected,true);
  assert.ok(stages.some(stage=>stage.startsWith('guide_repair_card_script')));
  assert.ok(stages.some(stage=>stage.startsWith('speech_review_card_script_after_repair')));
  assert.ok(value.events.filter(event=>event.type==='upsert'&&(event.card||event).id==='script')
    .every(event=>(event.card||event).value!==bad.guide.script));
  assert.equal(output.guide.script,guide().guide.script);
  assertDetail(output);
});

test('O4 keeps quality refinement, renewed whole-guide reviews and final detail for the refined script',async()=>{
  const refined=guide();refined.guide.script+=' 답하기 편할 때 알려 줘.';
  const value=fixture({response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'script',reason:'답변 선택권을 명확히 하세요.',repair:'편할 때 답할 수 있음을 덧붙이세요.'}]};
    if(input.stage==='guide_refine')return refined;
    if(['speech_review','guide_review','speech_detail'].includes(input.stage))assert.equal(input.data.script||input.data.guide.script,refined.guide.script);
  }});
  const output=await value.run(),stages=value.stages();
  for(const stage of ['guide_quality','guide_refine','guide_quality_check','speech_review','support_review','guide_review','speech_detail','speech_detail_review'])
    assert.equal(stages.filter(value=>value===stage).length,1,stage);
  assert.ok(stages.indexOf('guide_refine')<stages.indexOf('guide_quality_check'));
  assert.ok(stages.indexOf('guide_quality_check')<stages.indexOf('speech_review'));
  const refinePrompt=value.requests.find(({input})=>input.stage==='guide_refine').body.messages[0].content;
  assert.match(refinePrompt,/전체 카드 초안 재사용 계약/u);
  assert.match(refinePrompt,/피할 말·행동: <피할 구체적인 말이나 행동> 이유: <조심할 이유> 대신 <같은 목적을 전할 실제 한마디나 행동>/u);
  assert.match(refinePrompt,/세 문단 사이에 빈 줄/u);
  assert.doesNotMatch(refinePrompt,/두 문단 사이에 빈 줄/u);
  assert.equal(output.guide.script,refined.guide.script);
  assertDetail(output);
});

test('O4 discards earlier card approvals after a late analysis repair and reviews the new draft',async()=>{
  const changed=guide();changed.guide.next='다음 대화를 서두르지 말고 자신의 휴식 시간도 확인해 보세요.';
  const value=fixture({response:(input,_body,payload)=>{
    if(input.stage==='guide_review')return {approved:false,issues:[{field:'relationship_analysis',reason:'해석의 범위를 좁혀야 합니다.',repair:'원문 관찰만 근거로 다시 대조하세요.'}]};
    if(input.stage==='analysis_repair_after_guide_review'){const repaired=analysis();repaired.unknowns=['원하는 도움은 원문만으로 확인되지 않았어요.'];return repaired;}
    if(input.stage==='guide_write_after_analysis_repair')return changed;
    return payload;
  }});
  const output=await value.run(),stages=value.stages();
  assert.equal(stages.filter(stage=>stage==='guide_write').length,1);
  assert.equal(stages.filter(stage=>stage==='guide_write_after_analysis_repair').length,1);
  for(const field of cardFields)assert.ok(stages.includes('speech_review_card_'+field+'_after_analysis_repair'));
  for(const field of ['care','next'])assert.ok(stages.includes('support_review_card_'+field+'_after_analysis_repair'));
  assert.ok(value.events.some(event=>event.type==='reset'));
  assert.equal(output.guide.next,changed.guide.next);
  assert.ok(stages.every(stage=>!redundantStages.test(stage)));
  assertDetail(output);
});

test('O4 whole-guide rejection still fails after bounded repairs instead of treating partial cards as saved output',async()=>{
  const value=fixture({response:input=>input.stage.startsWith('guide_review')
    ?{approved:false,issues:[{field:'script',reason:'현재 원문과 맞지 않습니다.',repair:'근거와 다시 대조하세요.'}]}:undefined});
  await assert.rejects(value.run(),{modelReason:'agent_review_rejected'});
  assert.ok(value.stages().includes('guide_review_after_repair_2'));
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
});

test('O4 cancellation after a partial card clears pending cards and never reaches final detail',async()=>{
  const value=fixture(),controller=new AbortController();let cancelled=false;
  await assert.rejects(value.run({signal:controller.signal,onCard:event=>{
    value.events.push(structuredClone(event));
    if(!cancelled&&event.type==='upsert'&&cardFields.includes((event.card||event).id)){
      cancelled=true;controller.abort();
    }
  }}),{code:'MODEL_CANCELLED'});
  assert.equal(cancelled,true);
  assert.ok(value.stages().every(stage=>!stage.startsWith('speech_detail')));
  const reset=value.events.findLastIndex(event=>event.type==='reset');
  assert.ok(reset>=0);
  assert.ok(value.events.slice(reset+1).every(event=>event.type!=='upsert'));
});

test('O4 preserves the separate urgent path and its fixed actions instead of reusing ordinary cards',async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');
  const actions=urgentGuideActions(ctx.name_index),urgent=guide();
  urgent.guide={...urgent.guide,...actions,care:{...urgent.guide.care,...actions.care}};
  urgent.assessment.safety=true;
  const response=input=>{
    if(input.stage==='relationship_analysis'){
      const value=analysis();value.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};return value;
    }
  };
  const reused=fixture({ctx,validGuide:urgent,response}),legacy=fixture({ctx,validGuide:urgent,response,reuseFinalDraft:false});
  const output=await reused.run(),baseline=await legacy.run();
  assert.deepEqual(reused.stages(),legacy.stages());
  assert.equal(output.assessment.safety,true);
  assert.equal(output.agent.safety_guidance_version,'immediate-help-v1');
  assert.equal(output.agent.reviewed,true);assert.equal(output.agent.quality_reviewed,true);
  assert.equal(output.conversation_detail,undefined);
  assert.ok(reused.stages().every(stage=>!stage.startsWith('speech_review_card_')));
  for(const key of ['script','doList','avoid','next'])assert.deepEqual(output.guide[key],actions[key]);
  assert.deepEqual(output.guide.care.tips,actions.care.tips);
  for(const key of ['guide','assessment','relationship_analysis','relationship_memory'])assert.deepEqual(output[key],baseline[key]);
});
