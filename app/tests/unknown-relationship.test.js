import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRelationship,canonicalRelationshipSelection,validateRelationship,runRelationshipAgent} from '../src/relationship-agent.js';
import {retrieveSources} from '../src/relationship-retrieval.js';

const field=(id,text,status='answered')=>({id,question:id,text,rawText:text,custom:'',status});
const context=(v3=true,status='auto_skipped')=>({
  ...(v3?{bundle_id:'malssi-intake-3.0.0-rc1'}:{}),
  patient:{fields:{[v3?'q3_02':'rel']:field(v3?'q3_02':'rel','',status)}},
  supporter:{fields:{[v3?'q3_01':'feeling']:field(v3?'q3_01':'feeling','무리하지 않고 도울 말을 정리하고 싶어요.')}},
  user_goal:{message:field(v3?'q3_01':'want','무리하지 않고 도울 말을 정리하고 싶어요.')},
  question_candidates:[],name_index:null,relationship_state:{patient:[],supporter:[],relationship:[],unknowns:[]},
});
const draft=(ctx)=>({
  observations:{patient:[],supporter:[{subject:'supporter',question_id:ctx.bundle_id?'q3_01':'feeling',quote:'무리하지 않고 도울 말을 정리하고 싶어요.'}]},
  relationship:{label:'미확인',supporter_role:'미확인',dynamics:[],strengths:[],boundaries:[]},
  unknowns:['상대방이 원하는 도움'],safety:{urgent:false,evidence:[]},
});

test('canonical analysis normalizes the exact unknown marker without modifying skipped answers or the draft',()=>{
  for(const v3 of [true,false])for(const status of ['auto_skipped','unknown','refused','skipped','missing']){
    const ctx=context(v3,status);
    if(status==='missing')ctx.patient.fields={};
    const value=draft(ctx),before=structuredClone({ctx,value});
    const result=canonicalRelationship(value,ctx);
    assert.equal(result.relationship.label,'확인되지 않음');
    assert.equal(result.relationship.supporter_role,'확인되지 않음');
    assert.deepEqual(result.observations,value.observations);
    assert.deepEqual(result.unknowns,value.unknowns);
    assert.deepEqual(validateRelationship(result,ctx),result);
    assert.deepEqual({ctx,value},before);
  }
});

test('canonical analysis keeps canonical and mixed unknown markers consistent',()=>{
  const ctx=context();
  for(const label of ['미확인','확인되지 않음'])for(const role of ['미확인','확인되지 않음']){
    const value=draft(ctx);value.relationship.label=label;value.relationship.supporter_role=role;
    const result=canonicalRelationship(value,ctx);
    assert.equal(result.relationship.label,'확인되지 않음');
    assert.equal(result.relationship.supporter_role,'확인되지 않음');
  }
});

test('unknown marker normalization cannot hide an invented relationship or gendered role',()=>{
  for(const v3 of [true,false])for(const key of ['label','supporter_role'])for(const text of ['배우자','남편','친구 미확인','미확인: 아내']){
    const ctx=context(v3),value=draft(ctx);value.relationship[key]=text;
    assert.throws(()=>canonicalRelationship(value,ctx),error=>{
      assert.equal(error.modelReason,'agent_relationship_unknown');
      const feedback=JSON.parse(error.modelFeedback);
      assert.deepEqual(feedback.fields,['relationship.label','relationship.supporter_role']);
      assert.equal(feedback.required_value,'확인되지 않음');
      return true;
    });
  }
});

test('answered relationship still requires its source label and never becomes unknown automatically',()=>{
  const ctx=context();ctx.patient.fields.q3_02=field('q3_02','친구');
  const value=draft(ctx);
  assert.throws(()=>canonicalRelationship(value,ctx),{modelReason:'agent_relationship_label'});
  value.relationship.label='친구';value.relationship.supporter_role='친구';
  assert.deepEqual(canonicalRelationship(value,ctx).relationship,value.relationship);
});

test('wire selection normalizes unknown markers only after evidence and schema validation',()=>{
  const ctx=context(),value=draft(ctx),retrieval=retrieveSources(ctx,{stage:'relationship_analysis'});
  value.safety={urgent:false,evidence_ids:[]};
  assert.equal(canonicalRelationshipSelection(value,ctx,retrieval).relationship.label,'확인되지 않음');
  value.observations.supporter[0].quote='원문에 없는 사실';
  assert.throws(()=>canonicalRelationshipSelection(value,ctx,retrieval),{modelReason:'agent_schema'});
});

test('normalizing a draft still sends it to independent analysis review',async()=>{
  const ctx=context(false),value=draft(ctx),stages=[],stop=new Error('review reached');
  value.safety={urgent:false,evidence_ids:[]};
  const memory={summary:'원문',facts:[{...value.observations.supporter[0],interpretation:'이용자의 목적',certainty:'reported'}],
    unknowns:[],user_goal:ctx.user_goal.message.text};
  const gateway={async agentComplete(stage,prompt,payload,schema,operation,validate){
    stages.push(stage);
    if(stage==='relationship_analysis')return validate(value);
    assert.equal(stage,'analysis_review');
    assert.equal(payload.analysis.relationship.label,'확인되지 않음');
    assert.equal(payload.analysis.relationship.supporter_role,'확인되지 않음');
    throw stop;
  }};
  await assert.rejects(runRelationshipAgent(gateway,ctx,memory,null,{}),error=>error===stop);
  assert.deepEqual(stages,['relationship_analysis','analysis_review']);
});
