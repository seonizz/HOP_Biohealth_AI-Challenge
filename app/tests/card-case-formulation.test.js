import test from 'node:test';
import assert from 'node:assert/strict';
import {CARD_CASE_DIMENSIONS,cardCaseClaims,reviewedCardCase} from '../src/card-case-formulation.js';
import {fixture,caseDetail,context,field,ref,audits,guide} from './helpers/final-flow-fixture.js';
import {safetySnapshotFingerprint,urgentGuideActions} from '../src/relationship-agent.js';

test('detailed card analysis keeps the same model calls and visible cards while persisting reviewed internal provenance',async()=>{
  const legacy=fixture(),detailed=fixture({detailedCardAnalysis:true});
  const before=await legacy.run(),after=await detailed.run();
  assert.equal(detailed.requests.length,legacy.requests.length);
  assert.deepEqual(detailed.events,legacy.events);
  assert.deepEqual(after.guide,before.guide);assert.deepEqual(after.relationship_analysis,before.relationship_analysis);
  assert.equal(before.agent.case_formulation,undefined);
  assert.equal(after.agent.case_formulation.version,'card-case-v1');assert.equal(after.agent.case_formulation.reviewed,true);
  assert.deepEqual(after.agent.case_formulation.findings[0].evidence,[ref()]);
  assert.equal(after.agent.case_formulation.coverage.behavior.status,'source_linked');
  for(const dimension of CARD_CASE_DIMENSIONS.filter(value=>value!=='behavior'))
    assert.deepEqual(after.agent.case_formulation.coverage[dimension],{status:'unknown',finding_ids:[]});
  const review=detailed.logicalRequests.find(row=>row.stage==='analysis_review');
  const claim=review.data.claims.find(row=>row.id==='case.0');
  assert.deepEqual(JSON.parse(claim.claim),Object.fromEntries(Object.entries(caseDetail().findings[0])
    .filter(([key])=>!['certainty','evidence'].includes(key))));
  assert.deepEqual(review.data.case_formulation,caseDetail());
  const writer=detailed.logicalRequests.find(row=>row.stage==='guide_write');
  assert.deepEqual(writer.data.case_formulation,after.agent.case_formulation);
  assert.ok(detailed.stages().every(stage=>stage!=='question_plan'));
});

test('all five dimensions retain exact evidence, attribution and time without inventing missing reports',async()=>{
  const ctx=context();ctx.patient.fields.change=field('change','지난주에는 일찍 잤고 이번 주에는 늦게 잔다고 들었어요.');
  const evidence=(subject,id)=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
  const rows=[
    {dimension:'situation',actor:'patient',source_kind:'reported_observation',interpretation:'이용자가 대상자의 밤 계획표 수정을 보고했습니다.',time_scope:'unclear',evidence:[ref()]},
    {...caseDetail().findings[0]},
    {dimension:'emotion',actor:'supporter',source_kind:'reported_speech',interpretation:'이용자는 무력하고 걱정된다고 말했습니다.',time_scope:'unclear',evidence:[evidence('supporter','feeling')]},
    {dimension:'relationship',actor:'patient',source_kind:'reported_speech',interpretation:'대상자는 이용자의 자녀로 보고됐습니다.',time_scope:'unclear',evidence:[evidence('patient','rel')]},
    {dimension:'change',actor:'patient',source_kind:'reported_speech',interpretation:'이용자는 지난주와 이번 주의 취침 시각 차이를 들었다고 보고했습니다.',time_scope:'change',evidence:[evidence('patient','change')]},
  ].map(item=>({certainty:'reported',...item}));
  const value=fixture({detailedCardAnalysis:true,ctx,caseFormulation:{findings:rows}});
  const result=await value.run();
  assert.equal(result.agent.case_formulation.findings.length,5);
  for(const dimension of CARD_CASE_DIMENSIONS)assert.equal(result.agent.case_formulation.coverage[dimension].status,'source_linked');
  assert.deepEqual(result.agent.case_formulation.findings.map(({id,...item})=>item),rows);
  assert.equal(value.logicalRequests.find(row=>row.stage==='analysis_review').data.claims.filter(row=>row.id.startsWith('case.')).length,5);
});

test('combined and separate final writers preserve the same internal details without adding requests',async()=>{
  for(const bundleAnalysisPlan of [false,true]){
    const options={bundleAnalysisPlan,bundleFinalReviews:true,shareReviewSources:true,extendedFinalEvidenceIds:true};
    const baseline=fixture(options),detailed=fixture({...options,detailedCardAnalysis:true});
    await baseline.run();const result=await detailed.run();
    assert.equal(detailed.requests.length,baseline.requests.length);
    assert.deepEqual(result.agent.case_formulation,reviewedCardCase(caseDetail()));
    assert.deepEqual(detailed.logicalRequests.find(row=>row.stage==='analysis_review').data.case_formulation,caseDetail());
  }
});

test('independently reviewed safety stays outside new analysis output while case citations use exact reference IDs',async()=>{
  const ctx=context();ctx.safety_signal={urgent:false,evidence:[ref()],review:{basis:'distress_without_immediate_danger',reason:'즉각 위험은 보고되지 않았습니다.'},
    source_snapshot:safetySnapshotFingerprint(ctx)};
  const value=fixture({ctx,detailedCardAnalysis:true,extendedFinalEvidenceIds:true,bundleAnalysisPlan:true});
  const output=await value.run();
  const request=value.requests.find(row=>row.input.stage==='final_analysis_plan_draft').input;
  assert.equal(request.output_schema.properties.analysis.properties.safety,undefined);
  assert.equal(request.output_schema.properties.analysis.properties.case_formulation.properties.findings.items.properties.evidence.items.type,'string');
  assert.deepEqual(output.agent.case_formulation,reviewedCardCase(caseDetail()));
  assert.deepEqual(output.relationship_analysis.safety,{urgent:false,evidence:[ref()]});
});

test('urgent fixed guidance does not wait for optional detailed case formulation',async()=>{
  const ctx=context(),danger='지금 사람이 다치는 폭력이 계속되고 있다고 보고했어요.';
  ctx.patient.fields.risk=field('risk',danger);
  ctx.safety_signal={urgent:true,evidence:[{subject:'patient',question_id:'risk',quote:danger}],
    review:{basis:'current_physical_danger',reason:'현재 신체 위험을 보고했습니다.'},source_snapshot:safetySnapshotFingerprint(ctx)};
  const validGuide=guide(),actions=urgentGuideActions(ctx.name_index);
  Object.assign(validGuide.guide,actions,{care:{...validGuide.guide.care,...actions.care}});validGuide.assessment.safety=true;
  const baseline=fixture({ctx,validGuide}),detailed=fixture({ctx,validGuide,detailedCardAnalysis:true});
  const before=await baseline.run(),after=await detailed.run();
  assert.equal(detailed.requests.length,baseline.requests.length);assert.deepEqual(after.guide,before.guide);
  assert.equal(after.agent.case_formulation,undefined);
  assert.equal(detailed.logicalRequests.find(row=>row.stage==='relationship_analysis').output_schema.properties.case_formulation,undefined);
});

test('empty evidence coverage remains explicitly unknown and adds no case claims',async()=>{
  const value=fixture({detailedCardAnalysis:true,caseFormulation:{findings:[]}});
  const result=await value.run();
  assert.deepEqual(result.agent.case_formulation.findings,[]);
  assert.ok(Object.values(result.agent.case_formulation.coverage).every(row=>row.status==='unknown'));
  assert.equal(value.logicalRequests.find(row=>row.stage==='analysis_review').data.claims.some(row=>row.id.startsWith('case.')),false);
});

for(const kind of ['fabricated_quote','unknown_source','empty_evidence','reported_hypothesis','duplicate_claim','self_approval'])
test('case formulation rejects '+kind+' before guide writing',async()=>{
  const detail=caseDetail(),ctx=context();
  if(kind==='fabricated_quote')detail.findings[0].evidence[0].quote='원문에 없는 감정';
  if(kind==='unknown_source'){
    ctx.patient.fields.missing={...field('missing','그럴 것 같아요'),status:'unknown'};
    detail.findings[0].evidence=[{subject:'patient',question_id:'missing',quote:'그럴 것 같아요'}];
  }
  if(kind==='empty_evidence')detail.findings[0].evidence=[];
  if(kind==='reported_hypothesis')detail.findings[0].source_kind='model_hypothesis';
  if(kind==='duplicate_claim')detail.findings.push({...structuredClone(detail.findings[0]),dimension:'situation'});
  if(kind==='self_approval')detail.reviewed=true;
  const value=fixture({detailedCardAnalysis:true,caseFormulation:detail,ctx});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.stages().includes('guide_write'),false);assert.equal(value.events.length,0);
});

test('each internal claim needs its own independent audit and cannot be approved by ordinary analysis audits',async()=>{
  const value=fixture({detailedCardAnalysis:true,response:input=>input.stage==='analysis_review'
    ?{approved:true,issues:[],audits:audits(input.data.claims.filter(row=>!row.id.startsWith('case.')))}:undefined});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(value.stages().includes('guide_write'),false);assert.equal(value.events.length,0);
});

test('an unsupported actor or time assertion stays rejected after repair and never reaches the writer',async()=>{
  const detail=caseDetail();detail.findings[0].actor='supporter';detail.findings[0].time_scope='change';
  const value=fixture({detailedCardAnalysis:true,caseFormulation:detail,response:input=>{
    if(input.stage!=='analysis_review'&&input.stage!=='analysis_review_after_repair')return;
    const claims=input.data.claims;
    return {approved:false,issues:[{field:'relationship_analysis',reason:'case.0의 행동 주체와 전후 변화는 원문이 뒷받침하지 않습니다.',repair:'원문에 보고된 주체와 시점 범위로 고치세요.'}],
      audits:audits(claims).map(row=>row.id==='case.0'?{...row,verdict:'unsupported'}:row)};
  }});
  await assert.rejects(value.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_analysis_review_rejected'});
  assert.equal(value.stages().includes('guide_write'),false);
  assert.equal(value.logicalRequests.filter(row=>row.stage.startsWith('analysis_review')).length,2);
});

test('source storage subject never overwrites the actual actor or the source perspective',()=>{
  const detail=caseDetail();Object.assign(detail.findings[0],{actor:'supporter',source_kind:'user_interpretation',certainty:'tentative',
    interpretation:'이용자는 자신의 걱정이 행동에 영향을 줄 수도 있다고 추측했습니다.'});
  const claims=cardCaseClaims(detail),result=reviewedCardCase(detail);
  assert.equal(result.findings[0].evidence[0].subject,'patient');assert.equal(result.findings[0].actor,'supporter');
  assert.equal(JSON.parse(claims[0].claim).actor,'supporter');assert.equal(JSON.parse(claims[0].claim).source_kind,'user_interpretation');
  assert.equal(claims[0].certainty,'tentative');
});

test('a legacy seed cannot skip new case generation and review',async()=>{
  const value=fixture({detailedCardAnalysis:true});value.gateway.finalDraftSeed={seed_id:'legacy'};
  await assert.rejects(value.run(),{code:'MODEL_SEED_INVALID'});assert.equal(value.requests.length,0);
});
