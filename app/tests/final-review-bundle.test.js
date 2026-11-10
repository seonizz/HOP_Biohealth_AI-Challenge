import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {safetySources,urgentGuideActions,currentReviewedSafety,safetySnapshotFingerprint,agentContext} from '../src/relationship-agent.js';
import {COMMON} from '../src/relationship-prompts.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
import {restoreReviewSources} from '../src/final-review-bundle.js';

// Synthetic conversation only. Every response passes the real HTTP parser,
// schema/evidence validators, card gates and final-detail contract.
import {field,ref,name,memory,context,analysis,plan,avoid,guide,reviewStages,audits,envelope,fixture,assertDetail} from './helpers/final-flow-fixture.js';

for(const reuseFinalDraft of [false,true])for(const persistent of [false,true])
test(`bundled final approvals still require fresh continuation review and bounded repair: reuse=${reuseFinalDraft}, persistent=${persistent}`,async()=>{
  const ctx=context(),id='continuation_1_0123456789abcdef',candidate=guide();
  ctx.supporter.fields[id]=field(id,'저는 내일 저녁에 통화할 여유가 있어요.');
  candidate.guide.next='오늘 저녁 통화할 여유가 있다고 전하고 상대에게 가능한지 물어보세요.';
  const fixed='내일 저녁 통화할 여유가 있다고 전하고 상대에게 가능한지 물어보세요.';
  let checks=0,repairs=0;
  const value=fixture({ctx,reuseFinalDraft,validGuide:candidate,response:input=>{
    if(input.stage.startsWith('guide_repair')) {
      repairs++;assert.equal(input.data.field,'next');
      assert.ok(input.data.context_feedback.some(check=>check.field==='next'));
      return {next:persistent?candidate.guide.next:fixed};
    }
    if(!input.stage.startsWith('continuation_context_review'))return;
    const {sources,required_source_ids,units}=input.data,reject=persistent||++checks===1;
    if(persistent)checks++;
    assert.equal(units.find(unit=>unit.id==='next.0').text,checks===1||persistent?candidate.guide.next:fixed);
    return {
      source_events:required_source_ids.map(id=>({source_id:id,quote:sources.find(source=>source.id===id).text,
        actor:'supporter',action:'통화할 여유가 있음',action_time:'내일 저녁',status:'availability'})),
      checks:units.map(unit=>{
        const availability=unit.field==='next',failed=availability&&reject;
        return {id:unit.id,utterance_frame:unit.role==='direct_speech'||unit.role==='alternative'?'current_reply':'not_speech',
          candidate_quote:unit.text,candidate_action_time:availability?(failed?'오늘 저녁':'내일 저녁'):'명시 없음',
          source_action_time:availability?'내일 저녁':'명시 없음',source_ids:availability?required_source_ids:[],
          relation:availability?(failed?'different':'same'):'not_applicable',statement:availability?'reported_fact':'other',
          comparison:failed?'원문은 내일 저녁의 여유만 보고했지만 안내는 오늘 저녁을 단정합니다.':'원문의 시점과 합의를 유지합니다.',
          verdict:failed?'conflict':'consistent',repair:failed?'통화할 여유의 시점을 원문의 내일 저녁으로 고치세요.':null};
      }),
    };
  }});
  if(persistent) {
    await assert.rejects(value.run(),{modelReason:'agent_review_rejected'});
    assert.equal(checks,3);assert.equal(repairs,2);
    assert.ok(!value.stages().includes('speech_detail'));
    assert.equal(value.events.at(-1).type,'reset');
  } else {
    const output=await value.run();
    assert.equal(checks,2);assert.equal(repairs,1);
    assert.deepEqual(output.guide,{...candidate.guide,next:fixed});assertDetail(output);
    assert.ok(value.stages().indexOf('final_review_bundle_after_repair')>
      value.stages().indexOf('continuation_context_review_after_repair'));
  }
  assert.ok(value.stages().some(stage=>stage==='final_review_bundle_initial'||stage==='final_review_bundle_quality'));
});

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

test('shared source transport keeps every logical task and saved value while reducing complete request bytes',async t=>{
  const baseline=fixture(),compact=fixture({shareReviewSources:true});
  const before=await baseline.run(),after=await compact.run();
  assert.equal(compact.requests.length,8);
  for(const key of ['guide','assessment','patient_state','name_index','relationship_analysis','relationship_memory','conversation_detail'])assert.deepEqual(after[key],before[key],key);
  for(const stage of reviewStages)assert.deepEqual(compact.logicalRequests.find(task=>task.stage===stage).data,baseline.logicalRequests.find(task=>task.stage===stage).data,stage);
  const original=baseline.requests.find(({input})=>input.stage==='final_review_bundle_initial'),encoded=compact.requests.find(({input})=>input.stage==='final_review_bundle_initial');
  assert.ok(encoded.input.data.shared_sources);
  const a=Buffer.byteLength(JSON.stringify(original.body)),b=Buffer.byteLength(JSON.stringify(encoded.body));
  assert.ok(b<a);t.diagnostic(JSON.stringify({metric:'complete_bundle_request_bytes',baseline:a,compact:b,saved:a-b,model_posts:8}));
});

test('task-local repair requests only one missing audit and retains exact sibling gates',async t=>{
  const response=input=>input.bundle_stage&&input.stage==='speech_review_card_care'?{approved:true,issues:[]}:undefined;
  const baseline=fixture({response}),value=fixture({repairReviewBundleTasks:true,response});
  const before=await baseline.run(),output=await value.run();assertDetail(output);
  assert.deepEqual(output.guide,before.guide);
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,1);
  assert.equal(value.stages().filter(stage=>stage==='speech_review_card_care').length,1);
  assert.equal(value.requests.length,9);
  assert.equal(value.stages().some(stage=>stage==='speech_review_card_script'),false,'valid sibling is not regenerated');
  assert.ok(baseline.requests.length>value.requests.length);
  t.diagnostic(JSON.stringify({metric:'one_missing_audit_posts',baseline:baseline.requests.length,task_repair:value.requests.length}));
});

test('all new final transport flags preserve the eight-POST output and exact logical citations',async()=>{
  const baseline=fixture(),value=fixture({shareReviewSources:true,repairReviewBundleTasks:true,extendedFinalEvidenceIds:true});
  const before=await baseline.run(),output=await value.run();assertDetail(output);assert.equal(value.requests.length,8);
  for(const key of ['guide','relationship_analysis','relationship_memory','conversation_detail'])assert.deepEqual(output[key],before[key]);
  for(const stage of ['communication_plan','speech_detail']) {
    const request=value.requests.find(({input})=>input.stage===stage);
    assert.ok(request.input.evidence_sources.locations.length>0,stage);
    const schema=stage==='communication_plan'?request.input.output_schema.properties.opening_evidence:
      request.input.output_schema.properties.opening.properties.evidence;
    assert.equal(schema.items.type,'string',stage);
  }
});

for(const point of ['initial','task_repair'])test('review contract is captured before dispatch and rejects in-flight changes: '+point,async()=>{
  const value=fixture({repairReviewBundleTasks:true,response:input=>{
    if(point==='initial'&&input.bundle_stage==='final_review_bundle_initial'&&input.stage==='guide_review')value.gateway.model='changed-in-flight';
    if(point==='task_repair'&&input.bundle_stage==='final_review_bundle_initial'&&input.stage==='speech_review_card_care')return {approved:true,issues:[]};
    if(point==='task_repair'&&!input.bundle_stage&&input.stage==='speech_review_card_care')value.gateway.model='changed-in-flight';
  }});
  await assert.rejects(value.run(),{modelReason:'agent_review_stale'});
  assert.equal(value.stages().includes('speech_detail'),false);
  assert.equal(value.events.some(event=>event.id==='care'&&event.type==='upsert'),false);
});

test('card rejection repairs before a malformed later quality or guide task and discards old approvals',async()=>{
  const value=fixture({repairReviewBundleTasks:true,response:input=>{
    if(input.bundle_stage==='final_review_bundle_initial'&&input.stage==='speech_review_card_care')return reject(input,'care');
    if(input.bundle_stage==='final_review_bundle_initial'&&['guide_quality','guide_review'].includes(input.stage))return {};
    if(input.stage==='guide_repair_card_care_1')return {care:refinedCare};
  }});
  const output=await value.run();assert.deepEqual(output.guide.care,refinedCare);assertDetail(output);
  assert.equal(value.stages().includes('guide_quality'),false,'do not repair invalidated speculative quality');
  assert.equal(value.stages().includes('guide_review'),false,'do not repair invalidated speculative guide');
  const fresh=value.logicalRequests.filter(input=>input.bundle_stage==='final_review_bundle_quality');
  assert.ok(fresh.length);assert.ok(fresh.every(input=>input.data.guide.care.feel===refinedCare.feel));
});

test('quality improvements run before recovery of malformed whole-guide tasks',async()=>{
  const value=fixture({repairReviewBundleTasks:true,scopedQualityRefinement:true,response:input=>{
    if(input.bundle_stage==='final_review_bundle_initial'&&input.stage==='guide_quality')return {improvements:[{field:'care',reason:'추가 돌봄 제안을 넣어 주세요.',repair:'자신의 여유도 살펴보세요.'}]};
    if(input.bundle_stage==='final_review_bundle_initial'&&input.stage==='guide_review')return {};
    if(input.stage==='guide_refine')return {care:refinedCare};
  }});
  const output=await value.run();assertDetail(output);assert.deepEqual(output.guide.care,refinedCare);
  assert.equal(value.stages().includes('guide_review'),false);
  assert.ok(value.stages().includes('final_review_bundle_after_quality'));
  const guide=value.logicalRequests.filter(task=>task.stage==='guide_review').at(-1);
  assert.deepEqual(guide.data.guide.care,refinedCare);
});

test('local card rejection also precedes repair of missing speculative whole-guide output',async()=>{
  const bad=guide();bad.guide.script='네가 얼마나 노력하는지 다 알고 있어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?';
  const value=fixture({validGuide:bad,repairReviewBundleTasks:true,response:input=>{
    if(input.bundle_stage==='final_review_bundle_initial'&&input.stage==='guide_review')return {};
    if(input.stage==='guide_repair_card_script_1')return {script:guide().guide.script};
  }});
  const output=await value.run();assertDetail(output);assert.equal(output.guide.script,guide().guide.script);
  assert.equal(value.stages().includes('guide_review'),false);
  assert.equal(value.events.some(event=>event.id==='script'&&event.value===bad.guide.script),false);
});

test('exhausted task-local repair restores the original gates and cannot publish an unreviewed card',async()=>{
  const value=fixture({repairReviewBundleTasks:true,response:input=>input.stage==='speech_review_card_care'?{approved:true,issues:[]}:undefined});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,1);
  assert.equal(value.stages().filter(stage=>stage==='speech_review_card_care').length,6,'three local attempts then three original fallback attempts');
  assert.equal(value.events.some(event=>event.id==='care'&&event.type==='upsert'),false);
  assert.equal(value.stages().includes('speech_detail'),false);
});

for(const malformed of ['duplicate_keys','truncated','extra_key'])test('task repair refuses unsafe envelope '+malformed,async()=>{
  const value=fixture({repairReviewBundleTasks:true,httpOverride:input=>{
    if(input.stage!=='final_review_bundle_initial')return;
    const content=malformed==='duplicate_keys'?'{"guide":{},"gu\\u0069de":{}}':malformed==='truncated'?'{':JSON.stringify({unknown_task:{approved:true}});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  }});
  assertDetail(await value.run());
  assert.equal(value.stages().filter(stage=>stage==='final_review_bundle_initial').length,3);
  for(const field of ['script','care','doList','avoid','next'])assert.ok(value.stages().includes('speech_review_card_'+field));
});

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

test('fallback survives transport recovery but does not disable batching for a new request',async()=>{
  let broken=true,detailAttempts=0;
  const value=fixture({response:input=>{
    if(broken&&input.bundle_stage&&input.stage==='guide_review')return {approved:true};
  },httpOverride:input=>{
    if(broken&&input.stage==='speech_detail'&&++detailAttempts<=3)
      return new Response('{}',{status:503,headers:{'Retry-After':'0'}});
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

test('shared sources and task recovery preserve every original input across context partitions',async()=>{
  const legacy=fixture({bundleFinalReviews:false});
  const value=fixture({shareReviewSources:true,repairReviewBundleTasks:true,
    httpOverride:input=>input.data.tasks?.length>4?contextLimit():undefined});
  const expected=await legacy.run(),output=await value.run();
  assertDetail(output);assert.deepEqual(output.guide,expected.guide);
  assert.equal(value.requests.length,14);
  for(const stage of reviewStages) {
    const parts=value.logicalRequests.filter(task=>task.stage===stage);
    assert.equal(parts.length,1,stage+' must not repeat a successful partition');
    assert.deepEqual(parts[0].data,legacy.logicalRequests.find(task=>task.stage===stage).data,stage+' retains its original scope');
  }
});

test('cancelling task-local review recovery never publishes its unresolved card or completes detail',async()=>{
  const controller=new AbortController();
  const value=fixture({repairReviewBundleTasks:true,
    response:input=>input.bundle_stage&&input.stage==='speech_review_card_care'?{}:undefined,
    httpOverride:input=>{if(input.stage==='speech_review_card_care')controller.abort();}});
  await assert.rejects(value.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(value.stages().filter(stage=>stage==='speech_review_card_care').length,1);
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='care'),false);
  assert.equal(value.stages().includes('speech_detail'),false);
  assert.equal(value.events.at(-1).type,'reset');
});

test('late analysis rejection renews every downstream bundled gate with source sharing and task recovery',async()=>{
  const value=fixture({shareReviewSources:true,repairReviewBundleTasks:true,response:input=>
    input.stage==='guide_review'?{approved:false,issues:[{field:'relationship_analysis',
      reason:'현재 해석 범위를 확인하세요.',repair:'원문의 범위를 유지하세요.'}]}:undefined});
  const output=await value.run();assertDetail(output);
  assert.ok(value.stages().includes('analysis_repair_after_guide_review'));
  assert.ok(value.stages().includes('communication_plan_after_analysis_repair'));
  assert.ok(value.stages().includes('plan_review_after_analysis_repair'));
  const stage='final_review_bundle_initial_after_analysis_repair';
  assert.equal(value.stages().filter(item=>item===stage).length,1);
  const fresh=value.logicalRequests.filter(task=>task.bundle_stage===stage);
  assert.equal(fresh.length,11);
  assert.deepEqual(new Set(fresh.map(task=>task.key)),new Set(value.logicalRequests
    .filter(task=>task.bundle_stage==='final_review_bundle_initial').map(task=>task.key)));
  assert.ok(fresh.every(task=>task.stage.endsWith('_after_analysis_repair')));
});
