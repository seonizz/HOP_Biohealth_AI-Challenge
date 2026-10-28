import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { canonicalRelationshipSelection, groundedEvidenceSchema, relationshipSelectionSchema,
  runRelationshipAgent } from '../src/relationship-agent.js';
import { retrieveSources, retrievedContext } from '../src/relationship-retrieval.js';

const field=(id,text)=>({id,question:id,status:'answered',rawText:text,text,custom:''});
const describe='지난달부터 아침에는 가까운 공원에서 걷고, 저녁에는 집에서 음악을 들어요.';
const support='이웃과 장을 함께 봐요. 돌아오는 길에는 기분이 괜찮다고 하지만 다음날은 모르겠어요.';
const context=()=>({patient:{alias:'하늘',fields:{name:field('name','하늘'),rel:field('rel','친구'),
  describe:field('describe',describe),support:field('support',support)}},supporter:{fields:{}},
  user_goal:{message:field('want','이해하고 싶어요')},question_candidates:[],name_index:null,
  relationship_state:{patient:[],supporter:[],relationship:[],unknowns:[]}});
const reference=(question_id,quote)=>({subject:'patient',question_id,quote});
const selection=()=>({observations:{patient:[reference('describe',describe)],supporter:[]},
  relationship:{label:'친구',supporter_role:'친구',dynamics:[{
    interpretation:'가능한 해석: 저녁에 조용히 쉬는 시간을 원할 수 있어요.',
    evidence:[reference('describe',describe)],certainty:'tentative'}],strengths:[{
    interpretation:'가능한 해석: 이웃과 함께 장을 보는 것이 지지가 될 수 있어요.',
    evidence:[reference('support',support)],certainty:'tentative'}],boundaries:[]},
  unknowns:['도움 의향은 아직 확인되지 않았어요.'],safety:{urgent:false,evidence_ids:[]}});
const invalidSelection=()=>{
  const value=selection();
  value.observations.patient[0].quote='저녁에는 집에서 음악을 들어요.';
  value.relationship.dynamics[0].evidence[0].quote='아침에는 가까운 공원에서 걷고, 저녁에는 집에서 음악을 들어요.';
  value.relationship.strengths[0].evidence[0].quote='이웃과 장을 함께 봐요. 돌아오는 길에는 기분이 괜찮다고 하지만';
  return value;
};
const captureError=run=>{try{run();assert.fail('Expected rejection');}catch(error){
  assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_schema');return error;
}};
const requestFixture=()=>{const ctx=context(),retrieval=retrieveSources(ctx,{stage:'relationship_analysis'});
  return {ctx,retrieval,schema:groundedEvidenceSchema(relationshipSelectionSchema,retrievedContext(ctx,retrieval))};};
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const makeGateway=(fetchImpl,diagnostics=[])=>new ModelGateway({baseUrl:'https://example.test/v1',
  apiKey:'synthetic-secret',model:'synthetic-model',protocol:'relationship_agent',agentFormat:'prompt',
  reasoningEffort:'omit',fetchImpl,diagnosticLogger:entry=>diagnostics.push(entry)});

test('partial and joined source quotes remain invalid; only opt-in errors include repair details',()=>{
  const {ctx,retrieval}=requestFixture(),bad=invalidSelection(),before=structuredClone(bad);
  const legacy=captureError(()=>canonicalRelationshipSelection(bad,ctx,retrieval));
  assert.equal(legacy.modelFeedback,undefined);
  for(const path of ['observation','dynamic','strength']) {
    const value=selection();
    if(path==='observation')value.observations.patient=bad.observations.patient;
    if(path==='dynamic')value.relationship.dynamics=bad.relationship.dynamics;
    if(path==='strength')value.relationship.strengths=bad.relationship.strengths;
    const error=captureError(()=>canonicalRelationshipSelection(value,ctx,retrieval,true));
    const issue=JSON.parse(error.modelFeedback.split('\n')[0]);
    assert.equal(issue.keyword,'enum');assert.equal(issue.actual.type,'object');
    assert.match(error.modelFeedback,/observations와 relationship의 모든 evidence/u);
    assert.match(error.modelFeedback,/전체 객체를 그대로/u);
    for(const text of [describe,support,...[bad.observations.patient[0],bad.relationship.dynamics[0].evidence[0],
      bad.relationship.strengths[0].evidence[0]].map(item=>item.quote)])assert.equal(error.modelFeedback.includes(text),false);
  }
  assert.deepEqual(bad,before,'Invalid references must never be expanded, deleted or rewritten');
  assert.deepEqual(canonicalRelationshipSelection(selection(),ctx,retrieval,true),
    canonicalRelationshipSelection(selection(),ctx,retrieval));
});

test('scalar enums, unknown keys and invented quotes do not leak values or get object-copy instructions incorrectly',()=>{
  const {ctx,retrieval}=requestFixture();
  const scalar=selection();scalar.relationship.dynamics[0].certainty='PRIVATE_ENUM_VALUE';
  const scalarError=captureError(()=>canonicalRelationshipSelection(scalar,ctx,retrieval,true));
  assert.equal(JSON.parse(scalarError.modelFeedback).keyword,'enum');
  assert.equal(scalarError.modelFeedback.includes('PRIVATE_ENUM_VALUE'),false);
  const extra=selection();extra.PRIVATE_UNKNOWN_KEY='PRIVATE_UNKNOWN_VALUE';
  const extraError=captureError(()=>canonicalRelationshipSelection(extra,ctx,retrieval,true));
  assert.equal(JSON.parse(extraError.modelFeedback).keyword,'objectKeys');
  for(const sentinel of ['PRIVATE_UNKNOWN_KEY','PRIVATE_UNKNOWN_VALUE'])assert.equal(extraError.modelFeedback.includes(sentinel),false);
  const invented=selection();invented.observations.patient[0].quote='PRIVATE_INVENTED_QUOTE';
  const inventedError=captureError(()=>canonicalRelationshipSelection(invented,ctx,retrieval,true));
  assert.equal(inventedError.modelFeedback.includes('PRIVATE_INVENTED_QUOTE'),false);
  const wrongPerson=selection();wrongPerson.observations.patient[0].subject='supporter';
  captureError(()=>canonicalRelationshipSelection(wrongPerson,ctx,retrieval,true));
  const wrongQuestion=selection();wrongQuestion.observations.patient[0].question_id='support';
  captureError(()=>canonicalRelationshipSelection(wrongQuestion,ctx,retrieval,true));
});

test('first request and schema stay identical while a rejected analysis gets bounded source-free retry guidance',async()=>{
  const {ctx,retrieval,schema}=requestFixture(),before=structuredClone(schema),bodies=[],logs=[];
  const run=(gateway,feedback)=>gateway.operation({},operation=>gateway.agentComplete('relationship_analysis',
    '합성 분석 지침',{answers:ctx},schema,operation,value=>canonicalRelationshipSelection(value,ctx,retrieval,feedback)));
  const baselineBodies=[];
  const expected=await run(makeGateway(async(_url,options)=>{baselineBodies.push(options.body);return envelope(selection());}),false);
  const actual=await run(makeGateway(async(_url,options)=>{bodies.push(options.body);
    return envelope(bodies.length===1?invalidSelection():selection());},logs),true);
  assert.deepEqual(actual,expected);assert.equal(bodies.length,2);assert.equal(bodies[0],baselineBodies[0]);
  const first=JSON.parse(bodies[0]),retry=JSON.parse(bodies[1]);
  const firstInput=JSON.parse(first.messages[1].content),retryInput=JSON.parse(retry.messages[1].content);
  assert.equal(Object.hasOwn(firstInput,'validation_feedback'),false);
  assert.match(retryInput.validation_feedback,/output\.observations\.patient\[0\]/u);
  assert.match(retryInput.validation_feedback,/모든 evidence/u);
  assert.deepEqual(retryInput.output_schema,firstInput.output_schema);assert.deepEqual(retryInput.data,firstInput.data);
  assert.equal(retry.max_tokens,first.max_tokens);assert.equal(retry.temperature,first.temperature);
  assert.deepEqual(schema,before);assert.deepEqual(logs.map(row=>row.reason),['agent_schema','success']);
  assert.equal(JSON.stringify(logs).includes('validation_feedback'),false);
  for(const secret of [describe,support,'synthetic-secret'])assert.equal(JSON.stringify(logs).includes(secret),false);
});

test('persistent invalid evidence still fails after the existing three attempts',async()=>{
  const {ctx,retrieval,schema}=requestFixture();let calls=0;const logs=[];
  const gateway=makeGateway(async()=>{calls++;return envelope(invalidSelection());},logs);
  await assert.rejects(gateway.operation({},operation=>gateway.agentComplete('relationship_analysis','합성 지침',
    {},schema,operation,value=>canonicalRelationshipSelection(value,ctx,retrieval,true))),
    {code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(calls,3);assert.deepEqual(logs.map(row=>row.reason),['agent_schema','agent_schema','agent_schema']);
});

test('the final pipeline independently reviews the analysis after an enum repair',async()=>{
  const ctx=context(),stages=[];let calls=0,reviewed=false;
  const gateway=makeGateway(async(_url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(input.stage,'relationship_analysis');calls++;
    if(calls===2)assert.match(input.validation_feedback,/전체 객체/u);
    return envelope(calls===1?invalidSelection():selection());});
  const complete=gateway.agentComplete;
  gateway.agentComplete=async function(...args){stages.push(args[0]);
    if(args[0]==='analysis_review'){reviewed=true;throw new Error('TEST_REVIEW_BOUNDARY');}
    return Reflect.apply(complete,this,args);
  };
  const prior={summary:'합성 관찰입니다.',facts:[{...reference('describe',describe),
    interpretation:'이용자가 생활을 보고했어요.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'};
  await assert.rejects(gateway.operation({},operation=>runRelationshipAgent(gateway,ctx,prior,null,operation)),
    {message:'TEST_REVIEW_BOUNDARY'});
  assert.equal(reviewed,true);assert.equal(calls,2);assert.deepEqual(stages,['relationship_analysis','analysis_review']);
});
