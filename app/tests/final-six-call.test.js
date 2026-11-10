import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {safetySnapshotFingerprint,urgentGuideActions} from '../src/relationship-agent.js';
import {fixture,analysis,plan,assertDetail,reviewStages,context,field,guide} from './helpers/final-flow-fixture.js';

test('joint analysis and strategy retain all fourteen logical reviews and reduce eight POSTs to six',async()=>{
  const before=fixture(),after=fixture({bundleAnalysisPlan:true});
  const expected=await before.run(),actual=await after.run();
  assert.equal(before.requests.length,8);assert.equal(after.requests.length,6);assertDetail(actual);
  for(const key of ['guide','assessment','patient_state','name_index','relationship_analysis','relationship_memory','conversation_detail'])
    assert.deepEqual(actual[key],expected[key],key);
  assert.deepEqual(after.stages(),['final_analysis_plan_draft','final_review_bundle_analysis_plan','guide_write','final_review_bundle_initial','speech_detail','speech_detail_review']);
  for(const stage of reviewStages){
    const old=before.logicalRequests.find(row=>row.stage===stage),fresh=after.logicalRequests.find(row=>row.stage===stage);
    assert.ok(fresh,stage);assert.deepEqual(fresh.data,old.data,stage+' keeps exact review inputs');
    assert.deepEqual(fresh.output_schema,old.output_schema,stage+' keeps original schema');
    assert.ok(actual.agent.stages.includes(stage));
  }
});

test('joint writer never accepts a missing strategy or extra top-level approval',async()=>{
  for(const extra of [false,true]){
    const probe=fixture({bundleAnalysisPlan:true,response:({stage},_body,value)=>{
      if(stage!=='final_analysis_plan_draft')return;
      if(extra)value.approved=true;else delete value.plan;return value;
    }});
    await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE'});
    assert.equal(probe.requests.length,3);assert.equal(probe.stages().includes('guide_write'),false);
  }
});

test('rejected analysis invalidates its speculative strategy and obtains fresh ordered reviews',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,response:({stage},_body,value)=>{
    if(stage==='analysis_review')return {...value,approved:false,audits:value.audits.map(row=>({...row,verdict:'unsupported'})),
      issues:[{field:'relationship_analysis',reason:'해석이 현재 근거 범위를 넘었습니다.',repair:'근거 밖 해석을 제거하세요.'}]};
    if(stage==='analysis_repair'){const fixed=analysis();fixed.relationship.dynamics=[];return fixed;}
  }});
  const result=await probe.run();assertDetail(result);
  for(const stage of ['analysis_repair','analysis_review_after_repair','communication_plan','plan_review'])assert.ok(probe.stages().includes(stage),stage);
  assert.equal(result.relationship_analysis.relationship.dynamics.length,0);
  assert.ok(probe.stages().indexOf('communication_plan')>probe.stages().indexOf('analysis_review_after_repair'));
});

test('rejected speculative strategy is repaired and reviewed without reusing its old decision',async()=>{
  const corrected={...plan(),voice:'원문에 확인된 호칭으로 직접 건네는 말'};
  const probe=fixture({bundleAnalysisPlan:true,response:({stage},_body,value)=>{
    if(stage==='plan_review')return {approved:false,issues:[{field:'voice',reason:'호칭 범위를 명확히 하세요.',repair:'원문의 호칭을 사용하세요.'}]};
    if(stage==='communication_plan_repair')return corrected;
  }});
  const result=await probe.run();assertDetail(result);assert.equal(probe.requests.length,8);
  assert.deepEqual(probe.logicalRequests.find(row=>row.stage==='plan_review_after_repair').data.plan,corrected);
  assert.deepEqual(probe.logicalRequests.find(row=>row.stage==='guide_write').data.plan,corrected);
});

test('confirmed joint capacity overflow resumes the original lossless generation path',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,httpOverride:input=>input.stage==='final_analysis_plan_draft'?
    new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Prompt (20000) exceeds the 10000-token input budget; no text was truncated'}}),{status:400}):undefined});
  assertDetail(await probe.run());assert.equal(probe.requests.length,9);
  assert.ok(probe.stages().includes('relationship_analysis'));assert.ok(probe.stages().includes('communication_plan'));
});

test('cancelling the joint reviewer cannot publish either section or enter guide generation',async()=>{
  const controller=new AbortController();
  const probe=fixture({bundleAnalysisPlan:true,httpOverride:input=>{if(input.stage==='final_review_bundle_analysis_plan')controller.abort();}});
  await assert.rejects(probe.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(probe.stages().includes('guide_write'),false);assert.equal(probe.events.some(row=>row.type==='upsert'),false);
});

test('late analysis rejection renews strategy and every final gate after a six-call initial path',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,repairReviewBundleTasks:true,response:({stage})=>stage==='guide_review'?
    {approved:false,issues:[{field:'relationship_analysis',reason:'해석을 원문 범위로 한정하세요.',repair:'원문 근거로 다시 작성하세요.'}]}:undefined});
  assertDetail(await probe.run());
  for(const stage of ['analysis_repair_after_guide_review','analysis_review_after_guide_review_repair',
    'communication_plan_after_analysis_repair','plan_review_after_analysis_repair','final_review_bundle_initial_after_analysis_repair'])
    assert.ok(probe.stages().includes(stage),stage);
});

test('compact review output hydrates unchanged stored content on the six-call path',async()=>{
  const before=fixture({bundleAnalysisPlan:true}),after=fixture({bundleAnalysisPlan:true,compactReviewOutput:true});
  const expected=await before.run(),actual=await after.run();assertDetail(actual);assert.equal(after.requests.length,6);
  for(const key of ['guide','relationship_analysis','relationship_memory','conversation_detail'])assert.deepEqual(actual[key],expected[key]);
  assert.ok(after.requests.find(row=>row.input.stage==='final_review_bundle_initial').input.output_schema.properties.b);
});

test('joint generation keeps exact scoped evidence IDs together with compact review output',async()=>{
  const before=fixture(),after=fixture({bundleAnalysisPlan:true,compactReviewOutput:true,extendedFinalEvidenceIds:true,shareReviewSources:true,repairReviewBundleTasks:true});
  const expected=await before.run(),actual=await after.run();assertDetail(actual);assert.equal(after.requests.length,6);
  for(const key of ['guide','relationship_analysis','relationship_memory','conversation_detail'])assert.deepEqual(actual[key],expected[key]);
  const input=after.requests[0].input;
  assert.equal(input.output_schema.properties.plan.properties.opening_evidence.items.type,'string');
  assert.ok(input.evidence_sources.locations.every(row=>/^output_schema\.properties\.(analysis|plan)\./u.test(row.schema_path)));
});

test('compact missing plan remains unresolved until a fresh individual plan review',async()=>{
  let omitted=false;
  const probe=fixture({bundleAnalysisPlan:true,compactReviewOutput:true,repairReviewBundleTasks:true,wireOverride:(wire,input)=>{
    if(input.stage==='final_review_bundle_analysis_plan'&&!omitted){omitted=true;delete wire.o.plan;}
    return wire;
  }});
  assertDetail(await probe.run());assert.equal(probe.requests.length,7);
  assert.equal(probe.stages().filter(stage=>stage==='plan_review').length,1);
});

test('analysis rejection discards a missing speculative plan review before repairing either downstream section',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,compactReviewOutput:true,repairReviewBundleTasks:true,
    response:({stage},_body,value)=>{
      if(stage==='analysis_review')return {...value,approved:false,audits:value.audits.map(row=>({...row,verdict:'unsupported'})),
        issues:[{field:'relationship_analysis',reason:'인용 밖 해석이 있습니다.',repair:'인용이 지지하는 범위로 한정하세요.'}]};
      if(stage==='analysis_repair'){const corrected=analysis();corrected.relationship.dynamics=[];return corrected;}
    },wireOverride:(wire,input)=>{if(input.stage==='final_review_bundle_analysis_plan')delete wire.o.plan;return wire;}});
  assertDetail(await probe.run());assert.equal(probe.requests.length,10);
  assert.equal(probe.stages().filter(stage=>stage==='plan_review').length,1);
  assert.ok(probe.stages().indexOf('plan_review')>probe.stages().indexOf('communication_plan'));
});

test('joint compact profile preserves reviewed urgent safety and every exact fixed action',async()=>{
  const ctx=context(),danger='지금 사람이 다치는 폭력이 계속되고 있다고 보고했어요.';
  ctx.patient.fields.risk=field('risk',danger);
  ctx.safety_signal={urgent:true,evidence:[{subject:'patient',question_id:'risk',quote:danger}],
    review:{basis:'current_physical_danger',reason:'현재 신체 위험을 보고했습니다.'},source_snapshot:safetySnapshotFingerprint(ctx)};
  const validGuide=guide(),actions=urgentGuideActions(ctx.name_index);
  Object.assign(validGuide.guide,actions,{care:{...validGuide.guide.care,...actions.care}});validGuide.assessment.safety=true;
  const before=fixture({ctx,validGuide}),after=fixture({ctx,validGuide,bundleAnalysisPlan:true,compactReviewOutput:true,
    extendedFinalEvidenceIds:true,shareReviewSources:true,repairReviewBundleTasks:true});
  const expected=await before.run(),actual=await after.run();
  assert.equal(after.requests.length,4);assert.deepEqual(actual.guide,expected.guide);
  assert.deepEqual(actual.relationship_analysis.safety,{urgent:true,evidence:ctx.safety_signal.evidence});
  assert.equal(actual.conversation_detail,undefined);assert.equal(actual.agent.safety_guidance_version,'immediate-help-v1');
});

test('writer-requested compact output reaches the separately configured reviewer',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,compactReviewOutput:true});let reviewerPosts=0;
  probe.gateway.reviewGateway=new ModelGateway({baseUrl:'https://reviewer.synthetic.invalid/v1',apiKey:'synthetic-reviewer',
    model:'synthetic-reviewer',protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,
    diagnosticLogger:null,fetchImpl:(url,request)=>{reviewerPosts++;return probe.gateway.fetchImpl(url,request);}});
  assertDetail(await probe.run());assert.equal(reviewerPosts,3);
  assert.equal(probe.gateway.reviewGateway.compactReviewOutput,false,'endpoint configuration remains independent');
});

test('an independently enabled reviewer keeps compact output when the writer leaves it disabled',async()=>{
  const probe=fixture({bundleAnalysisPlan:true});
  probe.gateway.reviewGateway=new ModelGateway({baseUrl:'https://reviewer.synthetic.invalid/v1',apiKey:'synthetic-reviewer',
    model:'synthetic-reviewer',protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,
    compactReviewOutput:true,diagnosticLogger:null,fetchImpl:probe.gateway.fetchImpl});
  assertDetail(await probe.run());
  assert.ok(probe.requests.find(row=>row.input.stage==='final_review_bundle_initial').input.output_schema.properties.b);
  assert.equal(probe.gateway.compactReviewOutput,false);
});

test('compact duplicate JSON keys never become approvals',async()=>{
  const probe=fixture({bundleAnalysisPlan:true,compactReviewOutput:true,httpOverride:input=>{
    const binding=input.output_schema.properties.b?.enum?.[0];if(!binding)return;
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"b":"'+binding+'","b":"'+binding+'","o":{}}'}}]}));
  }});
  await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(probe.stages().includes('guide_write'),false);
});
