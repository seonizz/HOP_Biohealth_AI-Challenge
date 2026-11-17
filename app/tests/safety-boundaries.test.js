import {evidenceWireFixture} from './evidence-wire.fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {cases} from '../scripts/turn-comparison-cases.js';
import {relationshipQuestionRequest,safetyReviewRequest,validateSafetyReview,safetySources} from '../src/relationship-agent.js';

const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
function fixture(context,basis,{stateMode='combined_blocks',evidenceIds,proposedUrgent=false}={}) {
  const risk=safetySources(context).find(source=>source.question_id==='risk');
  const ref={subject:'patient',question_id:'risk',quote:context.patient.fields.risk.rawText};
  const draft={state:{patient_state:{facts:[{...ref,certainty:'reported'}],unknowns:[]},name_index:context.name_index,
    relationship_memory:{patient:[{certainty:'reported',evidence:[ref]}],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:proposedUrgent,evidence_ids:proposedUrgent?[risk.id]:[]}}};
  const calls=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',model:'synthetic',protocol:'relationship_agent',stateMode,
    retryFailures:false,diagnosticLogger:null,fetchImpl:async(_url,request)=>{
      const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content),{stage,data}=input;calls.push(input);
      if(stage==='turn_draft')return envelope(draft);
      if(stage==='turn_draft_block_name_index')return envelope({name_index:draft.state.name_index});
      if(stage.startsWith('turn_draft_block_'))return envelope(evidenceWireFixture(input,stage.endsWith('questions')?draft.questions:draft.state[stage.slice(17)]));
      if(stage==='state_observations')return envelope({patient_state:draft.state.patient_state,name_index:draft.state.name_index});
      if(stage==='relationship_memory')return envelope({relationship_memory:draft.state.relationship_memory});
      const approved=claims=>({approved:true,issues:[],audits:claims.map(claim=>({id:claim.id,verdict:'supported',reason:'합성 현재 원문을 보존한 사실'}))});
      if(stage==='turn_review')return envelope({state:approved(data.review_target.claims),questions:null,safety:null});
      if(stage==='state_review')return envelope(approved(data.claims));
      if(stage==='question_plan')return envelope(draft.questions);
      if(stage==='safety_review')return envelope({basis,reason:'현재 위험·부정·과거를 전체 원문에서 독립 분류',evidence_ids:evidenceIds??[risk.id]});
      throw new Error('Unexpected stage '+stage);
    }});
  return {model,calls};
}
for(const mode of ['combined','combined_blocks','staged'])for(const [caseId,basis,urgent] of [
  ['current_physical_danger','current_physical_danger',true],
  ['negated_current_danger','negated',false],
  ['past_only_danger','past_only',false],
])test(`${mode}: negative initial proposal still receives independent safety assessment: ${caseId}`,async()=>{
  const ctx=structuredClone(cases.find(item=>item.id===caseId).context),f=fixture(ctx,basis,{stateMode:mode});
  const result=await f.model.updateState(ctx);
  assert.equal(result.finish_early,urgent);assert.equal(result.safety_signal.urgent,urgent);
  const reviews=f.calls.filter(call=>call.stage==='safety_review');assert.equal(reviews.length,1);
  assert.equal(reviews[0].data.proposed_safety.urgent,false);assert.deepEqual(reviews[0].data.proposed_safety.evidence,[]);
  assert.deepEqual(reviews[0].data.safety_sources,safetySources(ctx));
  assert.ok(result.safety_signal.evidence.some(ref=>ref.quote===ctx.patient.fields.risk.rawText));
  assert.equal(result.safety_signal.review.basis,basis);assert.match(result.safety_signal.source_snapshot,/^[a-f0-9]{64}$/u);
  assert.equal(result.state_agent.reviewed,true);
});

test('independent safety evidence uses all current sources even outside question-planner retrieval',()=>{
  const ctx=structuredClone(cases.find(item=>item.id==='current_physical_danger').context);
  const planner=relationshipQuestionRequest(ctx),source=safetySources(ctx).find(row=>row.question_id==='risk');
  planner.retrieval.documents=planner.retrieval.documents.filter(row=>row.question_id!=='risk');
  const request=safetyReviewRequest(planner,{safety_signal:{urgent:false,evidence:[]}});
  const result=validateSafetyReview({basis:'current_physical_danger',reason:'전체 원문에 현재 진행 중인 위험',evidence_ids:[source.id]},ctx,request);
  assert.equal(result.urgent,true);assert.equal(result.evidence[0].quote,ctx.patient.fields.risk.rawText);
  for(const ids of [[],[source.id,source.id],['safety_not_in_current_sources']])
    assert.throws(()=>validateSafetyReview({basis:'current_physical_danger',reason:'잘못된 근거',evidence_ids:ids},ctx,request),{code:'MODEL_INVALID_RESPONSE'});
});

test('a selected danger source always restores its complete later correction',()=>{
  const ctx=structuredClone(cases.find(item=>item.id==='current_physical_danger').context);
  ctx.patient.fields.risk.followUp={question:'현재 상황을 정정했어요.',answer:{text:'과거 상황이었고 현재 위험은 없어요.',rawText:'과거 상황이었고 현재 위험은 없어요.'}};
  const source=safetySources(ctx).find(row=>row.question_id==='risk');
  const request=safetyReviewRequest(relationshipQuestionRequest(ctx),{safety_signal:{urgent:false,evidence:[]}});
  const result=validateSafetyReview({basis:'past_only',reason:'후속 정정을 포함한 과거 보고',evidence_ids:[source.id]},ctx,request);
  assert.equal(result.urgent,false);assert.equal(result.evidence.length,2);
  assert.ok(result.evidence.some(ref=>ref.quote.includes('현재 위험은 없어요')));
});


test('duplicate safety-review IDs remain rejected with a precise repair diagnostic and unchanged candidate',()=>{
  const ctx=structuredClone(cases.find(item=>item.id==='current_physical_danger').context);
  const source=safetySources(ctx).find(row=>row.question_id==='risk');
  const request=safetyReviewRequest(relationshipQuestionRequest(ctx),{safety_signal:{urgent:false,evidence:[]}});
  const candidate={basis:'current_physical_danger',reason:'현재 원문의 위험을 검토했습니다.',evidence_ids:[source.id,source.id]};
  const original=structuredClone(candidate);
  assert.throws(()=>validateSafetyReview(candidate,ctx,request),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_safety_source');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.path,'output.evidence_ids');assert.equal(feedback.keyword,'uniqueSafetySourceId');
    assert.deepEqual(feedback.duplicate_ids,[source.id]);assert.ok(feedback.repair.length>0);
    return true;
  });
  assert.deepEqual(candidate,original);
});

for(const [caseId,basis] of [['current_physical_danger','current_physical_danger'],['negated_current_danger','negated']])
test(`safety-review retry receives duplicate-ID feedback and validates a fresh response: ${basis}`,async()=>{
  const ctx=structuredClone(cases.find(item=>item.id===caseId).context);
  const source=safetySources(ctx).find(row=>row.question_id==='risk');
  const request=safetyReviewRequest(relationshipQuestionRequest(ctx),{safety_signal:{urgent:false,evidence:[]}});
  const valid={basis,reason:'현재 원문의 위험·부정·시점을 독립적으로 대조했습니다.',evidence_ids:[source.id]};
  const duplicate={...valid,evidence_ids:[source.id,source.id]},calls=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',model:'synthetic',
    protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);calls.push(input);
      return envelope(calls.length===1?duplicate:valid);
    }});
  const result=await model.operation({},operation=>model.agentComplete('safety_review',request.prompt,request.data,
    request.schema,operation,value=>validateSafetyReview(value,ctx,request)));
  assert.equal(calls.length,2);assert.equal(calls[0].validation_feedback,undefined);
  assert.deepEqual(calls[1].rejected_output,duplicate);
  assert.deepEqual(calls[1].data,calls[0].data);assert.deepEqual(calls[1].output_schema,calls[0].output_schema);
  const feedback=JSON.parse(calls[1].validation_feedback);
  assert.equal(feedback.path,'output.evidence_ids');assert.equal(feedback.keyword,'uniqueSafetySourceId');
  assert.deepEqual(feedback.duplicate_ids,[source.id]);
  assert.equal(result.urgent,basis==='current_physical_danger');assert.equal(result.review.basis,basis);
  assert.equal(result.review.reason,valid.reason);assert.ok(result.evidence.length>0);
});

for(const failure of ['duplicate','unknown','missing_current_danger_evidence'])
test(`safety-review feedback never accepts a still-invalid response: ${failure}`,async()=>{
  const ctx=structuredClone(cases.find(item=>item.id==='current_physical_danger').context);
  const source=safetySources(ctx).find(row=>row.question_id==='risk');
  const request=safetyReviewRequest(relationshipQuestionRequest(ctx),{safety_signal:{urgent:false,evidence:[]}});
  const duplicate={basis:'current_physical_danger',reason:'현재 원문의 위험을 검토했습니다.',evidence_ids:[source.id,source.id]};
  const later={...duplicate,evidence_ids:failure==='duplicate'?[source.id,source.id]:failure==='unknown'?['safety_not_in_current_sources']:[]};
  const calls=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',model:'synthetic',
    protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      calls.push(JSON.parse(JSON.parse(options.body).messages.at(-1).content));
      return envelope(calls.length===1?duplicate:later);
    }});
  await assert.rejects(model.operation({},operation=>model.agentComplete('safety_review',request.prompt,request.data,
    request.schema,operation,value=>validateSafetyReview(value,ctx,request))),{code:'MODEL_INVALID_RESPONSE',modelAttempts:3});
  assert.equal(calls.length,3);assert.deepEqual(calls[1].rejected_output,duplicate);
  assert.equal(JSON.parse(calls[1].validation_feedback).keyword,'uniqueSafetySourceId');
  assert.deepEqual(calls[2].rejected_output,later);
});
