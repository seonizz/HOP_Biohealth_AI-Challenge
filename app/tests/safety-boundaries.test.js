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
