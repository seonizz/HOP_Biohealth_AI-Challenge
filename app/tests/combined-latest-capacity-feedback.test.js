import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';

const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
function fixture(subject='patient') {
  const ids=subject==='patient'?['mood','burden','support','values']:['moment','feeling','after','mysupport'];
  const texts=subject==='patient'?['마감 뒤 피곤하다고 했어요.','퇴근 뒤 업무 연락이 부담이라고 했어요.',
    '누나와 통화하면 편하다고 했어요.','약속을 지키는 것을 중요하게 여긴다고 했어요. 종교는 잘 몰라요.']:
    ['먼저 조언해 아쉬웠어요.','친구가 걱정돼요.','제 휴식 시간도 필요해요.','저는 형에게 제 감정을 말할 수 있어요.'];
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구')}},supporter:{fields:{}},
    user_goal:{message:field('want','이야기를 듣고 싶어요.')},answered_count:7,latest_answer:{subject,question_id:ids[3]},
    adaptive_questions:true,question_candidates:[],clarification_candidates:[]};
  ids.forEach((id,index)=>{ctx[subject].fields[id]=field(id,texts[index]);});
  const ref=id=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
  const value={state:{patient_state:{facts:[{...ref(ids[3]),certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  value.state.relationship_memory[subject]=[{certainty:'tentative',interpretation:'가능한 해석: 현재 도움의 범위를 더 확인할 필요가 있을 수 있어요.',evidence:ids.slice(0,3).map(ref)},
    {certainty:'tentative',interpretation:'가능한 해석: 현재 부담을 더 확인할 필요가 있을 수 있어요.',evidence:[ref(ids[0]),ref(ids[1])]}];
  return {ctx,value,subject,ids,ref};
}
const approve=data=>data.safety_sources?safetyReviewFixture(data):({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},questions:null,safety:null});
function gateway(f,review=approve) {
  const calls=[];
  return {calls,async agentComplete(stage,prompt,data,schema,operation,validate){
    calls.push({stage,prompt,data,schema});
    return validate(stage.startsWith('turn_draft')?f.value:stage.startsWith('safety_review')?safetyReviewFixture(data):review(data));
  }};
}
function checkFeedback(error,subject) {
  assert.equal(error.modelReason,'agent_latest_fact_capacity');
  const feedback=JSON.parse(error.modelFeedback);
  assert.deepEqual({...feedback,repair:undefined},{path:`output.state.relationship_memory.${subject}`,keyword:'latestFactCapacity',
    expected:{max_findings:2,max_evidence_per_finding:6,reported_slot_required:true,max_tentative_count:1},
    actual:{selected_latest_refs:1,missing_latest_refs:1,reported_count:0,tentative_count:2},repair:undefined});
  assert.match(feedback.repair,/latest_answer와 같은 사람·문항/u);
  assert.match(feedback.repair,/빈자리를 확보해 전체 원문에서 근거를 다시 선택/u);
  assert.match(feedback.repair,/tentative를 사실로 바꾸거나 필수 정정·부정·시점을 삭제하지/u);
  return true;
}

for(const subject of ['patient','supporter'])test('two hypotheses leave no reported slot and still reject without dropping either: '+subject,async()=>{
  const f=fixture(subject),before=structuredClone(f.value),contextBefore=structuredClone(f.ctx),model=gateway(f);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),error=>checkFeedback(error,subject));
  assert.deepEqual(f.value,before);assert.deepEqual(f.ctx,contextBefore);
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft']);
  assert.match(model.calls[0].prompt,/모델 초안은 그룹당 2개·finding당 근거 3개 안에서 선택하세요/u);
  assert.match(model.calls[0].prompt,/이전 reported finding은 근거가 더 많을 수 있으므로 그대로 복사하지 말고/u);
  assert.match(model.calls[0].prompt,/최신 reported fact를 선택했다면\(name\/rel\/contact 제외\)/u);
  assert.match(model.calls[0].prompt,/reported 행 또는 빈자리를 확보/u);
  assert.match(model.calls[0].prompt,/tentative는 최대 1개/u);
  assert.match(model.calls[0].prompt,/기존 reported 행이나 필요한 최신 fact·근거를 삭제하지/u);
});

function overflowFixture(subject='patient') {
  const f=fixture(subject);
  f.value.state.relationship_memory[subject].unshift({certainty:'reported',evidence:f.ids.slice(0,3).map(f.ref)});
  return f;
}
function checkOverflowFeedback(error,subject) {
  assert.equal(error.modelReason,'agent_schema');
  const feedback=JSON.parse(error.modelFeedback);
  assert.deepEqual({...feedback,repair:undefined},{path:`output.state.relationship_memory.${subject}`,keyword:'maxItems',
    expected:{max_count:2,reported_slot_required:true,max_tentative_count:1},
    actual:{count:3,reported_count:1,tentative_count:2,selected_latest_refs:1,missing_latest_refs:1},repair:undefined});
  assert.match(feedback.repair,/reported 행 또는 빈자리를 확보/u);
  assert.match(feedback.repair,/기존 reported 행이나 필요한 최신 fact·근거를 삭제하지/u);
  assert.match(feedback.repair,/tentative를 사실로 바꾸거나 필수 정정·부정·시점을 삭제하지/u);
  return true;
}

for(const subject of ['patient','supporter'])test('one reported row plus two hypotheses still rejects with source-free slot guidance: '+subject,async()=>{
  const f=overflowFixture(subject),before=structuredClone(f.value),contextBefore=structuredClone(f.ctx),model=gateway(f);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),error=>{
    checkOverflowFeedback(error,subject);
    for(const source of ['지민',...f.ids,...f.ids.map(id=>f.ref(id).quote)])assert.ok(!error.modelFeedback.includes(source));
    return true;
  });
  assert.deepEqual(f.value,before);assert.deepEqual(f.ctx,contextBefore);
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft']);
});

for(const [name,change]of [
  ['no selected latest fact',f=>{f.value.state.patient_state.facts=[{...f.ref(f.ids[0]),certainty:'reported'}];}],
  ['latest fact already reported',f=>{f.value.state.relationship_memory.patient[0].evidence=[f.ref(f.ids[3])];}],
  ['unknown latest certainty',f=>{f.value.state.patient_state.facts[0].certainty='unknown';}],
  ['unconfirmed latest field',f=>{f.ctx.patient.fields[f.ids[3]].status='unknown';}],
  ['other latest actor',f=>{f.ctx.latest_answer.subject='supporter';}],
  ['metadata latest field',f=>{f.ctx.latest_answer.question_id='name';f.value.state.patient_state.facts=[{subject:'patient',question_id:'name',quote:'지민',certainty:'reported'}];}],
  ['malformed facts',f=>{f.value.state.patient_state.facts=null;}],
  ['three reported rows',f=>{f.value.state.relationship_memory.patient=f.value.state.relationship_memory.patient.map(row=>({certainty:'reported',evidence:row.evidence}));}],
  ['four rows',f=>{f.value.state.relationship_memory.patient.push(structuredClone(f.value.state.relationship_memory.patient[0]));}],
])test('targeted slot feedback does not broaden the overflow case: '+name,async()=>{
  const f=overflowFixture();change(f);const before=structuredClone(f.value),model=gateway(f);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),error=>{
    assert.equal(error.modelReason,'agent_schema');
    let original;
    try { validateSchema(f.value,model.calls[0].schema,'output',true); } catch(error) { original=error; }
    assert.ok(original);assert.deepEqual(JSON.parse(error.modelFeedback),JSON.parse(original.modelFeedback));
    return true;
  });
  assert.deepEqual(f.value,before);assert.equal(model.calls.length,1);
});

test('duplicate selected latest facts are counted once in overflow guidance',async()=>{
  const f=overflowFixture();f.value.state.patient_state.facts.push(structuredClone(f.value.state.patient_state.facts[0]));
  await assert.rejects(runCombinedRelationshipState(gateway(f),f.ctx,null,{}),error=>checkOverflowFeedback(error,'patient'));
});

test('the next overflow retry receives slot guidance and still needs a new complete independent review',async()=>{
  const f=overflowFixture(),before=structuredClone(f.value),repaired=structuredClone(f.value),requests=[];
  const originalRows=f.value.state.relationship_memory.patient;
  // This is a new model draft, not a server merge: both hypothesis texts and
  // their existing references are explicitly retained in its bounded finding.
  repaired.state.relationship_memory.patient=[structuredClone(originalRows[0]),{
    certainty:'tentative',interpretation:originalRows.slice(1).map(row=>row.interpretation).join(' '),
    evidence:structuredClone(originalRows[1].evidence),
  }];
  const repairedBefore=structuredClone(repaired),latest=f.ref(f.ids[3]);let drafts=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',stateMode:'combined',agentFormat:'prompt',diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);requests.push(input);
      let payload;
      if(input.stage==='turn_draft') {
        payload=++drafts===1?f.value:repaired;
        if(drafts===1)assert.equal(input.validation_feedback,undefined);
        else checkOverflowFeedback({modelReason:'agent_schema',modelFeedback:input.validation_feedback},'patient');
      } else if(input.stage.startsWith('safety_review'))payload=safetyReviewFixture(input.data);
      else {
        assert.equal(input.stage,'turn_review');assert.equal(input.validation_feedback,undefined);
        assert.deepEqual(input.data.review_target.claims[0].evidence,[latest,...originalRows[0].evidence]);
        assert.equal(input.data.review_target.claims[1].claim,repaired.state.relationship_memory.patient[1].interpretation);
        assert.deepEqual(input.data.review_target.claims[1].evidence,repaired.state.relationship_memory.patient[1].evidence);
        payload=approve(input.data);
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const result=await model.updateState(f.ctx);
  assert.deepEqual(requests.map(input=>input.stage),['turn_draft','turn_draft','turn_review','safety_review']);
  assert.deepEqual(requests[0].output_schema,requests[1].output_schema);
  assert.deepEqual(result.relationship_memory.patient[1],repaired.state.relationship_memory.patient[1]);
  assert.deepEqual(result.relationship_memory.patient[0].evidence,[latest,...originalRows[0].evidence]);
  assert.deepEqual(f.value,before);assert.deepEqual(repaired,repairedBefore);
});

test('capacity feedback never repeats source text, a name, or a dynamic question identifier',async()=>{
  const f=fixture(),oldId=f.ids[3],id='PRIVATE_QUESTION_SENTINEL',text='PRIVATE_VALUE_SENTINEL';
  delete f.ctx.patient.fields[oldId];f.ctx.patient.fields[id]=field(id,text);f.ctx.latest_answer.question_id=id;
  f.value.state.patient_state.facts=[{subject:'patient',question_id:id,quote:text,certainty:'reported'}];
  await assert.rejects(runCombinedRelationshipState(gateway(f),f.ctx,null,{}),error=>{
    checkFeedback(error,'patient');
    for(const source of [id,text,'지민',...f.value.state.relationship_memory.patient.flatMap(row=>row.evidence.map(ref=>ref.quote))])
      assert.ok(!error.modelFeedback.includes(source));
    return true;
  });
});

test('a model can use capacity feedback to reselect evidence, followed by complete independent review',async()=>{
  const f=fixture(),before=structuredClone(f.value),contextBefore=structuredClone(f.ctx),repaired=structuredClone(f.value),calls=[],logs=[];
  // The next model draft replaces one hypothesis with a literal source report.
  // The server neither chooses that replacement nor promotes its interpretation.
  repaired.state.relationship_memory.patient[0]={certainty:'reported',evidence:[f.ref(f.ids[1]),f.ref(f.ids[2])]};
  const repairedBefore=structuredClone(repaired),latest=f.ref(f.ids[3]);
  let drafts=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',stateMode:'combined',agentFormat:'prompt',diagnosticLogger:entry=>logs.push(entry),
    fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);calls.push(input);
      let payload;
      if(input.stage==='turn_draft') {
        drafts++;payload=drafts===1?f.value:repaired;
        if(drafts===1)assert.equal(input.validation_feedback,undefined);
        else checkFeedback({modelReason:'agent_latest_fact_capacity',modelFeedback:input.validation_feedback},'patient');
      } else if(input.stage.startsWith('safety_review'))payload=safetyReviewFixture(input.data);
      else {
        assert.equal(input.stage,'turn_review');assert.equal(input.validation_feedback,undefined);
        assert.deepEqual(input.data.review_target.claims.map(claim=>claim.id),['patient.0','patient.1']);
        assert.deepEqual(input.data.review_target.claims[0].evidence,[latest,...repaired.state.relationship_memory.patient[0].evidence]);
        assert.deepEqual(input.data.review_target.claims[1].evidence,before.state.relationship_memory.patient[1].evidence);
        const raw={...input.data.shared_input,...input.data.review_target.input};
        for(const id of f.ids)assert.ok(raw.patient.find(row=>row.question_id===id).answers.some(answer=>answer.text===f.ref(id).quote));
        payload=approve(input.data);
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const output=await model.updateState(f.ctx);
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft','turn_draft','turn_review','safety_review']);
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_latest_fact_capacity','success','success','success']);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[latest,...repaired.state.relationship_memory.patient[0].evidence]);
  assert.deepEqual(output.relationship_memory.patient[1],before.state.relationship_memory.patient[1]);
  assert.equal(output.state_agent.reviewed,true);
  assert.deepEqual(f.value,before);assert.deepEqual(repaired,repairedBefore);assert.deepEqual(f.ctx,contextBefore);
});

test('capacity repair cannot bypass a missing independent audit for the preserved latest fact',async()=>{
  const f=fixture();f.value.state.relationship_memory.patient[0]={certainty:'reported',evidence:[f.ref(f.ids[0])]};
  const model=gateway(f,data=>{const output=approve(data);output.state.audits.shift();return output;});
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review']);
});
