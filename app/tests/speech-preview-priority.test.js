import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredModelGateway} from '../src/model-config.js';
import {ModelGateway} from '../src/model.js';
import {fixture,guide,assertDetail,audits,context,field} from './helpers/final-flow-fixture.js';
import {safetySnapshotFingerprint,urgentGuideActions} from '../src/relationship-agent.js';

const options={prioritizeSpeechPreview:true,bundleAnalysisPlan:true,shareReviewSources:true,repairReviewBundleTasks:true,extendedFinalEvidenceIds:true};
const rejected=input=>({approved:false,issues:[{field:'script',reason:'발화의 표현을 원문 범위에 맞춰 고쳐야 합니다.',repair:'이해하고 싶은 마음과 선택 가능한 제안을 분리하세요.'}],
  audits:audits(input.data.claims)});

test('speech priority is a strict opt-in requiring the complete reuse/bundle pipeline',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_REUSE_FINAL_DRAFT:'true',MODEL_BUNDLE_FINAL_REVIEWS:'true'};
  assert.equal(configuredModelGateway({env}).prioritizeSpeechPreview,false);
  const enabled={...env,MODEL_PRIORITIZE_SPEECH_PREVIEW:'true'};
  assert.equal(configuredModelGateway({env:enabled}).prioritizeSpeechPreview,true);
  for(const value of ['yes','TRUE','1',true,null])
    assert.throws(()=>configuredModelGateway({env:{...enabled,MODEL_PRIORITIZE_SPEECH_PREVIEW:value}}),/Invalid MODEL configuration/);
  for(const overrides of [{MODEL_REUSE_FINAL_DRAFT:'false'},{MODEL_BUNDLE_FINAL_REVIEWS:'false'},{MODEL_SKIP_FINAL_EXTRAS:'true'},{MODEL_PROTOCOL:'json_schema'}])
    assert.throws(()=>configuredModelGateway({env:{...enabled,...overrides}}),/Invalid MODEL configuration/);
  const split=configuredModelGateway({env:{...enabled,MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'}});
  assert.equal(split.reviewGateway.prioritizeSpeechPreview,false);
  assert.equal(new ModelGateway({baseUrl:'http://127.0.0.1:11434',apiKey:'synthetic',prioritizeSpeechPreview:'true'}).configured,false);
});

test('reviewed speech is published while the remaining bundle is pending; all final gates and output remain',async()=>{
  const baseline=fixture({...options,prioritizeSpeechPreview:false}),before=await baseline.run();
  const reached=Promise.withResolvers(),resume=Promise.withResolvers();
  const value=fixture({...options,httpOverride:async input=>{
    if(input.stage==='speech_review_card_script')assert.equal(value.events.some(event=>event.id==='script'),false);
    if(input.stage==='final_review_bundle_initial'){
      assert.equal(input.data.tasks.some(task=>task.stage==='speech_review_card_script'),false,'no duplicate card approval');
      reached.resolve();await resume.promise;
    }
  }});
  const running=value.run();
  await reached.promise;
  try{
    assert.deepEqual(value.events.filter(event=>event.type==='upsert'&&event.id==='script'&&!event.detail).map(event=>event.value),[guide().guide.script]);
    assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='care'),false);
    assert.equal(value.stages().includes('speech_detail'),false);
  }finally{resume.resolve();}
  const after=await running;assertDetail(after);
  assert.equal(baseline.requests.length,6);assert.equal(value.requests.length,7);
  for(const key of ['guide','assessment','relationship_analysis','relationship_memory','conversation_detail'])assert.deepEqual(after[key],before[key],key);
  assert.equal(value.logicalRequests.filter(task=>task.stage==='speech_review_card_script').length,1);
  for(const stage of ['guide_quality','speech_review','support_review','guide_review','speech_detail_review'])assert.ok(value.logicalRequests.some(task=>task.stage===stage),stage);
});

test('rejected speech is repaired and independently approved before preview and the remaining bundle',async()=>{
  const fixed=guide().guide.script.replace('네 마음을 이해하고 싶어.','네 이야기를 더 듣고 싶어.');
  const value=fixture({...options,response:input=>{
    if(input.stage==='speech_review_card_script')return rejected(input);
    if(input.stage==='guide_repair_card_script_1'){
      assert.equal(value.events.some(event=>event.id==='script'),false);return {script:fixed};
    }
    if(input.stage==='speech_review_card_script_after_repair_1'){
      assert.equal(input.data.guide.script,fixed);assert.equal(value.events.some(event=>event.id==='script'),false);
      assert.equal(input.data.revision.changes[0].before,guide().guide.script);
    }
    if(['guide_quality','speech_review','guide_review'].includes(input.stage))assert.equal(input.data.guide.script,fixed);
  }});
  const result=await value.run();assertDetail(result);assert.equal(result.guide.script,fixed);
  assert.deepEqual(value.events.filter(event=>event.type==='upsert'&&event.id==='script'&&!event.detail).map(event=>event.value),[fixed]);
  assert.equal(value.stages().includes('final_review_bundle_quality'),false,'snapshot includes the approved repair');
});

test('persistent speech rejection never publishes a speech preview or reaches remaining reviews',async()=>{
  const value=fixture({...options,response:input=>input.stage.startsWith('speech_review_card_script')?rejected(input):undefined});
  await assert.rejects(value.run(),{modelReason:'agent_review_rejected'});
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='script'),false);
  assert.equal(value.stages().filter(stage=>stage.startsWith('guide_repair_card_script')).length,2);
  assert.equal(value.stages().includes('final_review_bundle_initial'),false);
});

for(const stage of ['speech_review_card_script','final_review_bundle_initial'])test('cancellation clears priority previews at '+stage,async()=>{
  const controller=new AbortController();
  const value=fixture({...options,httpOverride:input=>{if(input.stage===stage)controller.abort();}});
  await assert.rejects(value.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='script'),stage==='final_review_bundle_initial');
  assert.equal(value.events.at(-1).type,'reset');assert.equal(value.stages().includes('speech_detail'),false);
});

test('later quality repair removes the earlier speech and publishes its independently reapproved replacement',async()=>{
  const fixed=guide().guide.script.replace('네 마음을 이해하고 싶어.','네 이야기를 더 듣고 싶어.');
  const value=fixture({...options,scopedQualityRefinement:true,response:input=>{
    if(input.stage==='guide_quality')return {improvements:[{field:'script',reason:'이야기를 듣고 싶은 마음을 분명히 해 주세요.',repair:'이야기를 듣고 싶다고 제안하세요.'}]};
    if(input.stage==='guide_refine'){
      assert.ok(value.events.some(event=>event.type==='remove'&&event.id==='script'));return {script:fixed};
    }
  }});
  const result=await value.run();assertDetail(result);assert.equal(result.guide.script,fixed);
  assert.deepEqual(value.events.filter(event=>event.type==='upsert'&&event.id==='script'&&!event.detail).map(event=>event.value),[guide().guide.script,fixed]);
  assert.ok(value.logicalRequests.some(input=>input.stage==='speech_review'&&input.bundle_stage==='final_review_bundle_after_quality'&&input.data.guide.script===fixed));
});

test('urgent guidance retains the safety path and never takes speech-priority generation',async()=>{
  const ctx=context(),danger='지금 친구가 제 앞에서 흉기를 들고 저를 찌르겠다고 위협하고 있어요.';
  ctx.patient.fields.risk=field('risk',danger);
  ctx.safety_signal={urgent:true,evidence:[{subject:'patient',question_id:'risk',quote:danger}],
    review:{basis:'current_physical_danger',reason:'현재 직접 신체 위험이 보고됐습니다.'},source_snapshot:safetySnapshotFingerprint(ctx)};
  const candidate=guide(),actions=urgentGuideActions(ctx.name_index);
  Object.assign(candidate.guide,actions,{care:{...candidate.guide.care,...actions.care}});candidate.assessment.safety=true;
  const value=fixture({...options,ctx,validGuide:candidate});
  const result=await value.run();assert.equal(result.assessment.safety,true);
  assert.equal(value.stages().some(stage=>stage.startsWith('speech_review_card_script')),false);
  assert.deepEqual(result.guide.script,actions.script);
});
