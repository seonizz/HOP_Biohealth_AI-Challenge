import test from 'node:test';
import assert from 'node:assert/strict';
import {runRelationshipAgent,validateSchema,assertRetrievedEvidence} from '../src/relationship-agent.js';
const text='PRIVATE_SOURCE 친구와 함께 산책했어요.';
const field=(id,rawText)=>({id,question:id,status:'answered',rawText,text:rawText,custom:''});
const context=()=>({patient:{alias:'하늘',fields:{name:field('name','하늘'),rel:field('rel','친구'),mood:field('mood',text)}},
  supporter:{fields:{}},user_goal:{message:field('want','이해하고 싶어요')},question_candidates:[],name_index:null,relationship_state:{patient:[],supporter:[],relationship:[],unknowns:[]}});
const ref=()=>({subject:'patient',question_id:'mood',quote:text});
const selection=()=>({observations:{patient:[ref()],supporter:[]},relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}});
const prior=()=>({summary:'합성 관찰',facts:[{...ref(),interpretation:'이용자가 생활을 보고했어요.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'});
async function run(handler){
  const gateway={agentComplete:async(stage,prompt,payload,schema,operation,validate)=>{
    assert.equal(stage,'relationship_analysis');return handler({payload,schema,validate});
  }};
  return runRelationshipAgent(gateway,context(),prior(),null,{controller:new AbortController()});
}
test('final analysis reports exact schema path before generic retrieval rejects an invented reference',async()=>{
  const bad=selection();bad.observations.patient[0].quote='PRIVATE_INVENTED_QUOTE';const before=structuredClone(bad);
  await assert.rejects(run(({payload,validate})=>{
    assert.throws(()=>assertRetrievedEvidence(bad,payload.retrieval),{modelReason:'agent_retrieval_evidence'});
    return validate(bad);
  }),error=>{
    assert.equal(error.modelReason,'agent_schema');const issue=JSON.parse(error.modelFeedback.split('\n')[0]);
    assert.equal(issue.path,'output.observations.patient[0]');assert.equal(issue.keyword,'enum');
    assert.match(error.modelFeedback,/전체 객체를 그대로/u);
    assert.equal(error.modelFeedback.includes('PRIVATE_'),false);return true;
  });
  assert.deepEqual(bad,before);
});
test('schema-valid final analysis still rejects references no longer present in retrieval',async()=>{
  await assert.rejects(run(({payload,schema,validate})=>{
    const good=selection();validateSchema(good,schema);
    // A retrieval-only failure must still be caught after the early guard.
    payload.retrieval.documents=[];
    return validate(good);
  }),{modelReason:'agent_retrieval_evidence'});
});
