import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {safetySources,urgentGuideActions,currentReviewedSafety,safetySnapshotFingerprint,agentContext} from '../src/relationship-agent.js';
import {COMMON} from '../src/relationship-prompts.js';
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

function fixture({reuseFinalDraft=true,compactReviewInputs=false,scopedQualityRefinement=false,bundleFinalReviews=true,ctx=context(),validGuide=guide(),response:override,httpOverride}={}) {
  const requests=[],events=[],logicalRequests=[];
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined',reuseFinalDraft,compactReviewInputs,scopedQualityRefinement,bundleFinalReviews,
    timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl:async (_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      requests.push({body,input:structuredClone(input)});
      const intercepted=await httpOverride?.(input,body);
      if(intercepted!==undefined)return intercepted;
      const produce=async task=>{
      const {stage,data,output_schema:schema}=task;
      logicalRequests.push(task);
      let payload;
      if(/^(?:relationship_analysis|analysis_repair)(?:_|$)/u.test(stage)) {
        payload=analysis();if(!schema.properties.safety)delete payload.safety;
      }
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
      const replaced=await override?.(task,body,payload);
      return replaced===undefined?payload:replaced;
      };
      let payload;
      if(input.data.tasks){
        payload={};
        for(const task of input.data.tasks){
          const data={...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,input.data.shared_inputs[id]]))};
          const instructions=task.instructions.map(rule=>rule.text??input.data.shared_instructions[rule.shared_instruction]).join('\n');
          payload[task.id]=await produce({stage:task.stage,data,output_schema:input.output_schema.properties[task.id],prompt:COMMON+'\n'+instructions,bundle_stage:input.stage,key:task.id});
        }
      }else payload=await produce(input);
      return envelope(evidenceWireFixture(input,payload));
    }});
  return {gateway,requests,events,logicalRequests,ctx,
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

test('O4 bundles all eleven post-draft reviews into one independent request: 18 to 8 with the same stored content',async()=>{
  const legacy=fixture({bundleFinalReviews:false}),bundled=fixture();
  const before=await legacy.run(),after=await bundled.run();
  assert.equal(legacy.requests.length,18);assert.equal(bundled.requests.length,8);
  for(const key of ['guide','assessment','patient_state','name_index','relationship_analysis','relationship_memory','conversation_detail'])
    assert.deepEqual(after[key],before[key],key);
  assertDetail(after);
  const request=bundled.requests.find(({input})=>input.stage==='final_review_bundle_initial');
  assert.equal(request.input.data.tasks.length,11);
  assert.equal(request.body.messages[0].content.split(COMMON).length-1,1);
  const bundledStages=new Set(request.input.data.tasks.map(task=>task.stage));
  const separateBytes=legacy.requests.filter(({input})=>bundledStages.has(input.stage))
    .reduce((sum,{body})=>sum+Buffer.byteLength(JSON.stringify(body)),0);
  assert.ok(Buffer.byteLength(JSON.stringify(request.body))<separateBytes,'lossless shared instructions and inputs reduce the eleven-request text');
  assert.equal(after.agent.review_bundles.length,1);
  for(const stage of reviewStages) {
    const original=legacy.logicalRequests.find(input=>input.stage===stage),current=bundled.logicalRequests.find(input=>input.stage===stage);
    assert.ok(current,stage);assert.deepEqual(current.data,original.data,stage+' exact original review scope');
    assert.deepEqual(current.output_schema,original.output_schema,stage+' schema');
    assert.ok(after.agent.stages.includes(stage),stage+' review provenance');
  }
  for(const field of ['script','care','doList','avoid','next'])assert.ok(bundled.events.some(event=>event.type==='upsert'&&event.id===field));
});

test('non-O4 generation keeps its expansion stages while care/next and final quality reviews share requests',async()=>{
  const legacy=fixture({bundleFinalReviews:false,reuseFinalDraft:false}),bundled=fixture({reuseFinalDraft:false});
  const before=await legacy.run(),after=await bundled.run();
  assert.equal(legacy.requests.length,26);assert.equal(bundled.requests.length,21);
  assert.deepEqual(after.guide,before.guide);assertDetail(after);
  assert.ok(bundled.stages().includes('card_review_bundle_care'));
  assert.ok(bundled.stages().includes('card_review_bundle_next'));
  assert.ok(bundled.stages().includes('final_review_bundle_quality'));
});

test('one missing nested audit cannot be approved by the other ten valid reviews',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='speech_review_card_care')return {approved:true,issues:[]};
  }});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,3);
  assert.equal(value.stages().filter(stage=>stage==='speech_review_card_care').length,3,'the original gate must also pass after fallback');
  assert.equal(value.logicalRequests.some(input=>input.stage==='speech_detail'),false);
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='care'),false);
  assert.equal(value.stages().some(stage=>stage.includes('_part_')),false,'schema failures do not split into an approval bypass');
});

const reject=(input,field)=>({approved:false,issues:[{field,reason:'이 카드의 표현을 원문 범위에 맞게 고쳐야 합니다.',repair:'보고한 마음과 선택 가능한 행동을 분리하여 쓰세요.'}],
  ...(input.data.claims?{audits:audits(input.data.claims).map((audit,index)=>input.data.claims[index].field===field?{...audit,
    verdict:input.data.claims[index].claim_kind==='avoidance_guidance'?'problem_in_recommended_content':'problem_in_guidance'}:audit)}:{})});
const refinedCare={feel:'무력하고 걱정된 마음을 들려주셨어요. 자신의 여유도 살펴보세요.',tips:['잠시 쉬어 보세요.']};

test('exhausted malformed future review resumes card repairs before quality and whole-guide reviews',async()=>{
  const response=input=>{
    if(input.stage==='speech_review_card_care'&&input.data.guide.care.feel===guide().guide.care.feel)return reject(input,'care');
    if(input.stage==='guide_repair_card_care_1')return {care:refinedCare};
    if(input.stage==='guide_review'&&input.data.guide.care.feel===guide().guide.care.feel)return {approved:true};
  };
  const legacy=fixture({bundleFinalReviews:false,response}),value=fixture({response});
  const expected=await legacy.run(),output=await value.run();
  assert.equal(legacy.requests.length,20);assert.equal(value.requests.length,23);
  assert.deepEqual(output.guide,expected.guide);assertDetail(output);
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,3);
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,1,'keep the original draft');
  assert.ok(value.stages().indexOf('guide_quality')>value.stages().indexOf('guide_repair_card_care_1'));
  assert.equal(output.agent.review_bundles,undefined,'failed envelope grants no recorded bundle approval');
  assert.equal(value.gateway.bundleFinalReviews,true,'fallback cannot mutate a shared gateway');
  for(const stage of legacy.stages())assert.ok(value.stages().includes(stage),stage+' reruns its original gate');
});

for(const reviewer of ['speech','support'])test('exhausted stale '+reviewer+' bundle restores the original current-only retry',async()=>{
  const old=guide().guide.next,next='다음 대화 시간은 서로 편할 때로 함께 정해 보세요.';
  const response=input=>{
    if(input.stage==='support_review')return reject(input,'next');
    if(input.stage==='guide_repair')return {next};
    if(input.stage===reviewer+'_review_after_repair'&&input.data.revision) {
      const stale=reject(input,'next');
      stale.issues[0].reason='현재 문안에 포함된 “'+old+'”는 원문 근거가 없습니다.';
      return stale;
    }
  };
  const legacy=fixture({bundleFinalReviews:false,response}),value=fixture({response,compactReviewInputs:true});
  const expected=await legacy.run(),output=await value.run();
  assert.deepEqual(output.guide,expected.guide);assertDetail(output);
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_after_repair').length,3);
  const fresh=value.requests.filter(({input})=>input.stage===reviewer+'_review_after_repair');
  assert.equal(fresh.length,2);assert.ok(fresh[0].input.data.revision);
  assert.equal(fresh[1].input.data.revision,undefined);
  assert.match(fresh[1].input.validation_feedback,/agent_review_stale/u);
  assert.equal(fresh[1].input.rejected_output,undefined);
  assert.deepEqual(fresh[1].input.data.guide,fresh[0].input.data.guide);
  assert.deepEqual(fresh[1].input.data.answers,fresh[0].input.data.answers);
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,1);
  assert.equal(value.stages().filter(stage=>stage==='guide_repair').length,1);
  assert.equal(output.agent.review_bundles.length,1,'only the completed initial bundle remains recorded');
});

test('a malformed post-quality bundle discards its approval and reruns the quality gate',async()=>{
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'care',reason:'자신의 여유도 살펴보세요.',repair:'선택 가능한 휴식을 제안하세요.'}]};
    if(input.stage==='guide_refine')return {care:refinedCare};
    if(input.bundle_stage==='final_review_bundle_after_quality'&&input.stage==='guide_review')return {approved:true};
    if(input.stage==='guide_quality_check'&&!input.bundle_stage)return {improvements:[{field:'care',reason:'현재 문구에 아직 수정할 문제가 남아 있습니다.',repair:'현재 문구를 원문과 다시 대조하세요.'}]};
  }});
  await assert.rejects(value.run(),{modelReason:'agent_quality_review_rejected'});
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_after_quality').length,3);
  assert.equal(value.stages().filter(stage=>stage==='guide_quality_check').length,1);
  assert.equal(value.stages().includes('speech_detail'),false);
});

test('a standalone card bundle failure restores both original card gates without regenerating the card',async()=>{
  const value=fixture({reuseFinalDraft:false,response:input=>{
    if(input.bundle_stage==='card_review_bundle_care'&&input.stage==='support_review_card_care')return {approved:true};
  }});
  const output=await value.run();assertDetail(output);
  assert.equal(value.stages().filter(stage=>stage==='card_review_bundle_care').length,3);
  for(const stage of ['card_care','speech_review_card_care','support_review_card_care','guide_quality','speech_review','support_review','guide_review'])
    assert.equal(value.stages().filter(item=>item===stage).length,1,stage);
  assert.equal(output.agent.review_bundles?.some(bundle=>bundle.stage==='card_review_bundle_care')??false,false);
});

test('fallback survives whole-operation recovery but does not disable batching for a new request',async()=>{
  let broken=true,detailAttempts=0;
  const value=fixture({response:input=>{
    if(broken&&input.bundle_stage&&input.stage==='guide_review')return {approved:true};
    if(broken&&input.stage==='speech_detail'&&++detailAttempts<=3)return {};
  }});
  value.gateway.retryFailures=true;value.gateway.retryDelayMs=1;
  const output=await value.run();assertDetail(output);
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,2,'existing whole-operation recovery executes');
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,3,'one failed bundle across recovery');
  assert.equal(value.gateway.bundleFinalReviews,true);
  broken=false;const before=value.requests.length,next=await value.run();assertDetail(next);
  assert.equal(value.requests.length-before,8,'a new request starts with batching enabled');
});

test('a card speech rejection wins over support approval and discards whole-guide results after repair',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='speech_review_card_care')return reject(input,'care');
    if(input.stage==='guide_repair_card_care_1')return {care:refinedCare};
  }});
  const output=await value.run();
  assert.equal(value.requests.length,11);assert.deepEqual(output.guide.care,refinedCare);
  assert.ok(value.stages().includes('card_review_bundle_care_after_repair_1'));
  const fresh=value.requests.find(({input})=>input.stage==='final_review_bundle_quality');assert.ok(fresh);
  for(const stage of ['guide_quality','speech_review','support_review','guide_review']) {
    const reviews=value.logicalRequests.filter(input=>input.stage===stage);
    assert.equal(reviews.length,2,stage);assert.deepEqual(reviews.at(-1).data.guide.care,refinedCare);
  }
  assertDetail(output);
});

test('whole-guide support rejection cannot be masked by speech or general approval',async()=>{
  const next='다음 대화 시간은 서로 편할 때로 함께 정해 보세요.';
  const value=fixture({response:input=>{
    if(input.stage==='support_review')return reject(input,'next');
    if(input.stage==='guide_repair')return {next};
  }});
  const output=await value.run();assert.equal(value.requests.length,10);
  assert.equal(output.guide.next,next);
  assert.ok(value.stages().includes('final_review_bundle_after_repair'));
  for(const stage of ['speech_review_after_repair','support_review_after_repair','guide_review_after_repair']) {
    const input=value.logicalRequests.find(input=>input.stage===stage);assert.ok(input,stage);assert.equal(input.data.guide.next,next);
  }
  assertDetail(output);
});

test('a late analysis rejection rebuilds and independently reviews every downstream result',async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='guide_review')return reject(input,'relationship_analysis');
  }});
  const output=await value.run();assert.equal(value.requests.length,14);
  assert.ok(value.stages().includes('analysis_repair_after_guide_review'));
  assert.ok(value.stages().includes('final_review_bundle_initial_after_analysis_repair'));
  for(const stage of reviewStages.filter(stage=>!['analysis_review','speech_detail_review'].includes(stage)))
    assert.ok(value.logicalRequests.some(input=>input.stage===stage+'_after_analysis_repair'),stage);
  assertDetail(output);
});

for(const rejectQuality of [false,true])test('quality patches invalidate prior approvals and require a new quality and whole-guide bundle: '+rejectQuality,async()=>{
  const value=fixture({scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'care',reason:'자신을 돌볼 선택도 제안하세요.',repair:'이용자의 여유를 살피는 문장을 덧붙이세요.'}]};
    if(input.stage==='guide_refine')return {care:refinedCare};
    if(input.stage==='guide_quality_check') {
      assert.deepEqual(input.data.revision.after.care,refinedCare);
      if(rejectQuality)return {improvements:[{field:'care',reason:'지적한 문제가 아직 남아 있습니다.',repair:'원문과 다시 대조하세요.'}]};
    }
  }});
  if(rejectQuality)await assert.rejects(value.run(),{modelReason:'agent_quality_review_rejected'});
  else {const output=await value.run();assert.deepEqual(output.guide.care,refinedCare);assert.equal(value.requests.length,10);assertDetail(output);}
  assert.ok(value.stages().includes('final_review_bundle_after_quality'));
  for(const stage of ['speech_review','support_review','guide_review']) {
    const inputs=value.logicalRequests.filter(input=>input.stage===stage);
    assert.equal(inputs.length,2,stage);assert.deepEqual(inputs.at(-1).data.guide.care,refinedCare);
  }
});

const contextLimit=()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Prompt (20000) exceeds the 10000-token input budget; no text was truncated'}}),{status:400});
test('a failed context partition discards successful speculative siblings before original ordered repair',async()=>{
  const value=fixture({httpOverride:input=>input.data.tasks?.length>6?contextLimit():undefined,response:input=>{
    if(input.bundle_stage&&input.stage==='guide_review')return {approved:true};
    if(!input.bundle_stage&&input.stage==='speech_review_card_care')return reject(input,'care');
    if(input.stage==='guide_repair_card_care_1')return {care:refinedCare};
  }});
  const output=await value.run();assertDetail(output);assert.deepEqual(output.guide.care,refinedCare);
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial_part_1').length,1);
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial_part_2').length,3);
  for(const stage of ['speech_review_card_script','speech_review_card_care','speech_review_card_doList','speech_review_card_avoid','speech_review_card_next'])
    assert.equal(value.stages().filter(item=>item===stage).length,1,stage+' must rerun despite the valid first partition');
  assert.equal(output.agent.review_bundles,undefined);
  assert.ok(value.stages().indexOf('guide_quality')>value.stages().indexOf('guide_repair_card_care_1'));
  assert.equal(value.stages().includes('speech_review_card_care_after_repair_1'),true);
});

test('transport failures do not switch to individual approval requests',async()=>{
  const value=fixture({httpOverride:input=>input.data.tasks
    ?new Response(JSON.stringify({error:{message:'Invalid synthetic provider request'}}),{status:400}):undefined});
  await assert.rejects(value.run(),{code:'MODEL_UPSTREAM_ERROR'});
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,1);
  assert.equal(value.stages().some(stage=>stage.startsWith('speech_review_card_')),false);
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='care'),false);
});

test('confirmed context limits split batches finitely without truncation or repeating successful subtasks',async()=>{
  const legacy=fixture({bundleFinalReviews:false}),value=fixture({httpOverride:input=>input.data.tasks?.length>4?contextLimit():undefined});
  const expected=await legacy.run(),output=await value.run();assert.deepEqual(output.guide,expected.guide);assertDetail(output);
  assert.equal(value.requests.length,14);
  for(const stage of reviewStages) {
    const parts=value.logicalRequests.filter(input=>input.stage===stage);assert.equal(parts.length,1,stage);
    assert.deepEqual(parts[0].data,legacy.logicalRequests.find(input=>input.stage===stage).data,stage+' retains full input');
  }
});

test('a context limit in an indivisible review remains an error',async()=>{
  const value=fixture({httpOverride:input=>input.data.tasks||input.stage==='speech_review_card_script'?contextLimit():undefined});
  await assert.rejects(value.run(),{code:'MODEL_CONTEXT_TOO_LONG'});
  assert.equal(value.logicalRequests.some(input=>input.stage==='speech_detail'),false);
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='script'),false);
});

function reviewedContext() {
  const ctx=context();ctx.safety_signal={urgent:false,evidence:[ref()],review:{basis:'distress_without_immediate_danger',reason:'현재 원문은 즉각 위험을 보고하지 않았습니다.'},
    source_snapshot:safetySnapshotFingerprint(ctx)};return ctx;
}
test('reviewed safety is absent from model selection but restored with exact evidence before every independent review',async()=>{
  const ctx=reviewedContext(),value=fixture({ctx}),output=await value.run();
  const request=value.logicalRequests.find(input=>input.stage==='relationship_analysis');
  assert.equal(Object.hasOwn(request.output_schema.properties,'safety'),false);
  const prompt=value.requests.find(({input})=>input.stage==='relationship_analysis').body.messages[0].content;
  assert.match(prompt,/출력은 observations,relationship,unknowns입니다/u);
  assert.doesNotMatch(prompt,/safety는 urgent와 evidence_ids만 출력|evidence_ids에는 근거로 사용한 문항/u);
  assert.deepEqual(output.relationship_analysis.safety,{urgent:false,evidence:[ref()]});
  assert.deepEqual(output.agent.safety_signal,currentReviewedSafety(ctx));
  assert.equal(value.requests.length,8);assertDetail(output);
  assert.deepEqual(value.logicalRequests.find(input=>input.stage==='analysis_review').data.analysis.safety,output.relationship_analysis.safety);
});

test('a model cannot inject a replacement safety key into a reviewed-safety projection',async()=>{
  const value=fixture({ctx:reviewedContext(),response:(input,_body,payload)=>input.stage==='relationship_analysis'
    ?{...payload,safety:{urgent:true,evidence_ids:[]}}:undefined});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.requests.length,3);assert.equal(value.logicalRequests.some(input=>input.stage==='analysis_review'),false);
});

test('trusted final seeds project reviewed safety on the wire and still run all independent reviews',async()=>{
  const ctx=reviewedContext(),baseline=fixture({ctx}),original=await baseline.run();
  const value=fixture({ctx}),answers=agentContext(ctx);
  value.gateway.finalDraftSeed={seed_id:'synthetic_reviewed_safety_seed',answers,context_fingerprint:createHash('sha256').update(JSON.stringify(answers)).digest('hex'),
    analysis:original.relationship_analysis,draft:{guide:original.guide,assessment:original.assessment}};
  const snapshot=structuredClone(value.gateway.finalDraftSeed),output=await value.run();
  assert.equal(value.requests.length,6);assert.deepEqual(output.guide,original.guide);assert.deepEqual(output.relationship_analysis,original.relationship_analysis);
  assert.deepEqual(value.gateway.finalDraftSeed,snapshot);assertDetail(output);
  for(const stage of reviewStages)assert.ok(value.logicalRequests.some(input=>input.stage===stage),stage);
});

test('reviewed urgent safety keeps exact fixed actions and combines only quality and final review: 7 to 6',async()=>{
  const ctx=context(),danger='지금 사람이 다치는 폭력이 계속되고 있다고 보고했어요.';
  ctx.patient.fields.risk=field('risk',danger);
  ctx.safety_signal={urgent:true,evidence:[{subject:'patient',question_id:'risk',quote:danger}],
    review:{basis:'current_physical_danger',reason:'현재 신체 위험을 보고했습니다.'},source_snapshot:safetySnapshotFingerprint(ctx)};
  const validGuide=guide(),actions=urgentGuideActions(ctx.name_index);
  Object.assign(validGuide.guide,actions,{care:{...validGuide.guide.care,...actions.care}});validGuide.assessment.safety=true;
  const legacy=fixture({ctx,validGuide,bundleFinalReviews:false}),bundled=fixture({ctx,validGuide});
  const before=await legacy.run(),after=await bundled.run();
  assert.equal(legacy.requests.length,7);assert.equal(bundled.requests.length,6);
  assert.deepEqual(after.guide,before.guide);assert.deepEqual(after.relationship_analysis.safety,{urgent:true,evidence:ctx.safety_signal.evidence});
  assert.equal(after.agent.safety_guidance_version,'immediate-help-v1');assert.equal(after.conversation_detail,undefined);
  const tasks=bundled.requests.find(({input})=>input.stage==='final_review_bundle_quality').input.data.tasks;
  assert.deepEqual(tasks.map(task=>task.id),['quality','guide']);
});

for(const late of [false,true])test('reviewed safety projection covers analysis repair, late='+late,async()=>{
  const ctx=reviewedContext();
  const value=fixture({ctx,response:input=>{
    if(late?input.stage==='guide_review':input.stage==='analysis_review') {
      return {approved:false,issues:[{field:'relationship_analysis',reason:'현재 해석의 범위를 다시 살펴보세요.',repair:'원문의 범위를 유지하세요.'}],
        ...(input.data.claims?{audits:audits(input.data.claims)}:{})};
    }
  }});
  const result=await value.run();
  const repaired=value.logicalRequests.find(input=>input.stage===(late?'analysis_repair_after_guide_review':'analysis_repair'));
  assert.ok(repaired);assert.equal(Object.hasOwn(repaired.output_schema.properties,'safety'),false);
  assert.deepEqual(result.relationship_analysis.safety,{urgent:false,evidence:[ref()]});assertDetail(result);
});

test('reviewed safety sources outside the default retrieval stay available for canonical restoration',async()=>{
  const ctx=reviewedContext(),quote='동아리의 세 번째 일정만 전달받았다고 적었어요.';
  for(let i=0;i<22;i++)ctx.patient.fields['misc_'+i]=field('misc_'+i,'합성 일반 생활 정보 '+i);
  ctx.patient.fields.old_context=field('old_context',quote);
  ctx.safety_signal.evidence=[{subject:'patient',question_id:'old_context',quote}];
  ctx.safety_signal.source_snapshot=safetySnapshotFingerprint(ctx);
  const value=fixture({ctx}),result=await value.run();
  const input=value.logicalRequests.find(input=>input.stage==='relationship_analysis');
  assert.ok(input.data.retrieval.documents.some(document=>document.question_id==='old_context'&&document.text===quote));
  assert.deepEqual(result.relationship_analysis.safety.evidence,ctx.safety_signal.evidence);assertDetail(result);
});

test('cancellation of a batch prevents publishing cards or completing detailed output',async()=>{
  const controller=new AbortController();
  const value=fixture({httpOverride:input=>{if(input.stage==='final_review_bundle_initial')controller.abort();}});
  await assert.rejects(value.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id!=='relationship'),false);
  assert.equal(value.logicalRequests.some(input=>input.stage==='speech_detail'),false);
});

test('card repair feedback identifies the rejected alternative and index without weakening review or retry limits',async()=>{
  const bad='네가 얼마나 잘하고 싶어 하는지 알고 있어.';
  let attempts=0;
  const value=fixture({response:input=>{
    if(input.stage==='guide_write') {
      const output=guide();output.guide.avoid=['피할 말·행동: 재촉하기. 이유: 답할 여유를 남겨야 합니다. 대신 '+bad];return output;
    }
    if(input.stage==='guide_repair_card_avoid_1') {
      attempts++;
      if(attempts===1)return {avoid:[avoid,{avoid_phrase:'단정하기.',reason:'마음을 미리 알 수 없습니다.',alternative:bad}]};
      const feedback=JSON.parse(input.validation_feedback);
      assert.equal(feedback.field,'avoid');assert.equal(feedback.rejected.length,1);
      assert.equal(feedback.rejected[0].path,'avoid[1].alternative');
      assert.equal(feedback.rejected[0].rejected_text,bad);
      assert.ok(feedback.rejected[0].issues.some(issue=>issue.reason==='대상자의 마음이나 행동 원인을 아는 것처럼 말합니다.'));
      return {avoid:[avoid]};
    }
  }});
  const output=await value.run();assert.equal(attempts,2);assert.equal(value.requests.length,12);
  assert.deepEqual(output.guide.avoid,guide().guide.avoid);
  assert.ok(value.logicalRequests.some(input=>input.stage==='speech_review_card_avoid_after_repair_1'));
  assert.ok(value.stages().includes('final_review_bundle_quality'));assertDetail(output);
});

for(const bundleFinalReviews of [false,true])for(const heading of ['피할 말·행동:','피할 말:','피할 행동:'])
test('equivalent avoidance headings preserve the original output without repair: '+heading+', bundled='+bundleFinalReviews,async()=>{
  const validGuide=guide();validGuide.guide.avoid=validGuide.guide.avoid.map(text=>text.replace('피할 말·행동:',heading));
  const value=fixture({validGuide,bundleFinalReviews}),output=await value.run();
  assert.equal(value.requests.length,bundleFinalReviews?8:18);
  assert.deepEqual(output.guide,validGuide.guide);
  assert.equal(value.stages().some(stage=>stage.startsWith('guide_repair')),false);
  assertDetail(output);
});

for(const text of [
  '피할 말: 재촉하기. 대신 편한 시간을 물어보세요.',
  '피할 행동: 재촉하기. 이유: 답할 여유가 필요합니다. 대신 ',
  '피할 말·행동: 이유: 답할 여유가 필요합니다. 대신 편한 시간을 물어보세요.',
  '권할 말: 재촉하기. 이유: 답할 여유가 필요합니다. 대신 편한 시간을 물어보세요.',
])test('avoidance still repairs missing components or a different role heading: '+text,async()=>{
  const value=fixture({response:input=>{
    if(input.stage==='guide_write'){const output=guide();output.guide.avoid=[text];return output;}
  }});
  const output=await value.run();assert.equal(value.requests.length,11);
  assert.ok(value.stages().includes('guide_repair_card_avoid_1'));
  assert.deepEqual(output.guide.avoid,guide().guide.avoid);assertDetail(output);
});


for(const repaired of [true,false])test('source attribution gates an unanimously approved bundle and preserves repair review: '+repaired,async()=>{
  const ctx=context();ctx.patient.fields.informant_view={...field('informant_view','미술 수업 참여'),
    question:'현재 지민에게 가장 필요하다고 생각하는 도움은 무엇인가요?'};
  const bad='지민이가 미술 수업을 원한다고 했으니 시간을 정해 보세요.';
  const corrected=['미술 수업에 관심이 있는지 먼저 물어보세요.'];let repairs=0;
  const probe=fixture({ctx,response:({stage},_body,payload)=>{
    if(stage==='guide_write')return {...payload,guide:{...payload.guide,doList:[bad]}};
    if(stage.startsWith('guide_repair_card_doList')){repairs++;return {doList:repaired?corrected:[bad]};}
  }});
  if(repaired){
    const result=await probe.run();assertDetail(result);
    assert.deepEqual(result.guide.doList,corrected);assert.equal(repairs,1);
    const review=probe.logicalRequests.find(row=>row.stage==='speech_review_card_doList_after_repair_1');
    assert.ok(review);assert.deepEqual(review.data.guide.doList,corrected);
  }else{
    await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE'});
    assert.equal(repairs,3);assert.equal(probe.stages().includes('speech_detail'),false);
  }
  assert.equal(probe.events.some(event=>event.type==='upsert'&&event.id==='doList'&&JSON.stringify(event).includes(bad)),false);
});

test('a reported request for the same help retains the eight-POST bundle and original wording',async()=>{
  const ctx=context();ctx.patient.fields.informant_view={...field('informant_view','미술 수업 참여'),
    question:'현재 지민에게 가장 필요하다고 생각하는 도움은 무엇인가요?'};
  ctx.patient.fields.direct_request={...field('direct_request','미술 수업'),question:'지민이가 직접 원한다고 말한 도움은 무엇인가요?'};
  const validGuide=guide();validGuide.guide.doList=['지민이가 미술 수업을 원한다고 했으니 시간을 정해 보세요.'];
  const probe=fixture({ctx,validGuide}),result=await probe.run();
  assertDetail(result);assert.deepEqual(result.guide.doList,validGuide.guide.doList);
  assert.equal(probe.requests.length,8);assert.equal(probe.stages().some(stage=>stage.startsWith('guide_repair')),false);
});
