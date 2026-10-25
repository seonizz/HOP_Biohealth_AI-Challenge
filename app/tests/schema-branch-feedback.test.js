import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSchema} from '../src/relationship-agent.js';
import {ModelGateway} from '../src/model.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const variants=[object({evidence:{type:'array',items:{type:'string'}},certainty:{enum:['reported']}}),
  object({interpretation:{type:'string'},evidence:{type:'array',items:{type:'string'}},certainty:{enum:['tentative']}})];

test('finding feedback follows its declared certainty without changing anyOf validation',()=>{
  const schema={anyOf:variants},candidate={interpretation:'PRIVATE_MODEL_INFERENCE',evidence:['PRIVATE_SOURCE'],certainty:'reported'},before=structuredClone(candidate);
  for(const anyOf of [variants,[...variants].reverse()]) {
    assert.throws(()=>validateSchema(candidate,{anyOf},'output.patient[1]',true),error=>{
      assert.equal(error.modelReason,'agent_schema');
      assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output.patient[1]',keyword:'objectKeys',
        expected:{key_count:2,keys:['evidence','certainty']},
        actual:{key_count:3,missing_key_count:0,missing_keys:[],extra_key_count:1}});
      assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
    });
  }
  assert.throws(()=>validateSchema(candidate,schema),error=>error.modelReason==='agent_schema'&&error.modelFeedback===undefined);
  assert.deepEqual(candidate,before);
  for(const valid of [{evidence:['PRIVATE_SOURCE'],certainty:'reported'},
    {...candidate,certainty:'tentative'}])assert.equal(validateSchema(valid,schema,'output',true),valid);
});

test('an unsupported finding certainty still reports the existing enum failure',()=>{
  assert.throws(()=>validateSchema({evidence:[],certainty:'PRIVATE_CERTAINTY'},{anyOf:variants},'output',true),error=>{
    assert.equal(JSON.parse(error.modelFeedback).keyword,'enum');
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
  });
});

test('a reported finding repairs its extra interpretation without relabeling facts or bypassing independent review',async()=>{
  const field=(id,text)=>({id,question:id,text,rawText:text,status:'answered',custom:''});
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','요즘 피곤하다고 말했어요.'),
    support:field('support','누나와 통화하면 편하다고 했어요.')}},supporter:{fields:{}},
    user_goal:{message:field('want','이야기를 듣고 싶어요.')},latest_answer:{subject:'patient',question_id:'support'},
    answered_count:4,adaptive_questions:false,question_candidates:[],clarification_candidates:[]};
  const ref=id=>({subject:'patient',question_id:id,quote:ctx.patient.fields[id].rawText});
  const invalid={state:{patient_state:{facts:[{...ref('support'),certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[{evidence:[ref('mood')],certainty:'reported'},
      {interpretation:'PRIVATE_UNSUPPORTED_CAUSE',evidence:[ref('support')],certainty:'reported'}],
    supporter:[],relationship:[],unknowns:[]}},questions:null};
  const before=structuredClone(invalid),repaired=structuredClone(invalid);delete repaired.state.relationship_memory.patient[1].interpretation;
  const calls=[];let drafts=0;
  const gateway=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic',protocol:'relationship_agent',
    stateMode:'combined',agentFormat:'prompt',diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);calls.push(input);
      const value=input.stage==='turn_draft'?(++drafts===1?invalid:repaired):{
        state:{approved:true,issues:[],audits:input.data.review_target.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'원문 보고를 독립적으로 대조했습니다.'}))},
        questions:null,safety:null,
      };
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
    }});
  const result=await gateway.updateState(ctx);
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft','turn_draft','turn_review']);
  const feedback=JSON.parse(calls[1].validation_feedback);
  assert.equal(feedback.path,'output.state.relationship_memory.patient[1]');assert.equal(feedback.keyword,'objectKeys');
  assert.deepEqual(feedback.expected.keys,['evidence','certainty']);
  assert.deepEqual(calls[1].rejected_output,invalid);assert.deepEqual(invalid,before);
  const reviewed=calls[2].data.review_target.claims.find(claim=>claim.id==='patient.1');
  assert.equal(reviewed.certainty,'reported');assert.deepEqual(reviewed.evidence,[ref('support')]);
  assert.ok(!reviewed.claim.includes('PRIVATE_UNSUPPORTED_CAUSE'));
  assert.equal(result.relationship_memory.patient[1].certainty,'reported');
  assert.equal(result.state_agent.reviewed,true);
});
