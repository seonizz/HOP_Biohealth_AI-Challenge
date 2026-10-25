import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema, relationshipStateRequest } from '../src/relationship-agent.js';
import { runCombinedRelationshipState, TURN_PROMPT_VERSION } from '../src/relationship-turn.js';
import { ModelGateway } from '../src/model.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구'),
  mood:field('mood','요즘 피곤하다고 말했어요.'),concern:field('concern','업무 연락 때문에 쉬기 어렵다고 했어요.'),
  support:field('support','누나와 통화하면 마음이 편하다고 했어요.')}},supporter:{fields:{}},
  user_goal:{message:field('want','이야기를 듣고 싶어요.')},answered_count:6,latest_answer:{subject:'patient',question_id:'support'},
  adaptive_questions:true,question_candidates:[],clarification_candidates:[]});
const ref=(ctx,id)=>({subject:'patient',question_id:id,quote:ctx.patient.fields[id].rawText});
const draft=ctx=>({state:{patient_state:{facts:[{...ref(ctx,'support'),certainty:'reported'}],unknowns:[]},name_index:null,
  relationship_memory:{patient:[
    {certainty:'reported',evidence:[ref(ctx,'mood'),ref(ctx,'concern')]},
    {certainty:'reported',evidence:[ref(ctx,'support')]},
    {certainty:'reported',evidence:[ref(ctx,'concern')]},
  ],supporter:[],relationship:[],unknowns:[]}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const catchSchema=(value,schema,enabled)=>{
  try { validateSchema(value,schema,'output',enabled); }
  catch(error) { assert.equal(error.modelReason,'agent_schema');return error; }
  assert.fail('Expected unchanged schema rejection');
};

test('combined draft rejects three reported findings outside the normalization exception and returns the exact capacity',async()=>{
  const ctx=context(),value=draft(ctx),before=structuredClone(value);
  let calls=0;
  const gateway={async agentComplete(stage,prompt,data,schema,operation,validate){
    calls++;assert.equal(stage,'turn_draft');
    assert.match(prompt,/모델 초안은 그룹당 2개·finding당 근거 3개 안에서 선택하세요/u);
    return validate(value);
  }};
  await assert.rejects(runCombinedRelationshipState(gateway,ctx,null,{}),error=>{
    assert.equal(error.modelReason,'agent_schema');
    assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output.state.relationship_memory.patient',keyword:'maxItems',
      expected:{max_count:2},actual:{count:3}});
    return true;
  });
  assert.equal(calls,1);assert.deepEqual(value,before);
  assert.match(TURN_PROMPT_VERSION,/-combined-turn-v48$/);
});

test('fact writing selects its quote enum while the complete long answer survives input and independent review',async()=>{
  const ctx=context(),source='함께 이야기할 시간이 필요하다고 말했어요. '.repeat(10).trim();
  ctx.patient.fields.support=field('support',source);
  const request=relationshipStateRequest(ctx,null),branch=request.schema.properties.patient_state.properties.facts.items.anyOf
    .find(item=>item.properties.question_id.const==='support');
  const quotes=branch.properties.quote.enum,quote=quotes[0];
  assert.ok(source.length>160);assert.equal(branch.properties.quote.maxLength,160);
  assert.ok(quotes.every(item=>item.length<=160));assert.ok(!quotes.includes(source));
  const value=draft(ctx);value.state.patient_state.facts=[{...ref(ctx,'support'),quote,certainty:'reported'}];
  value.state.relationship_memory.patient=[{certainty:'reported',evidence:[ref(ctx,'support')]}];
  const calls=[],gateway={async agentComplete(stage,prompt,data,schema,operation,validate){
    calls.push({stage,prompt,data,schema});
    return validate(stage==='turn_draft'?structuredClone(value):{
      state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':'supported',reason:'전체 합성 원문과 대조했습니다.'}))},
      questions:null,safety:null,
    });
  }};
  const result=await runCombinedRelationshipState(gateway,ctx,null,{});
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft','turn_review']);
  assert.match(calls[0].prompt,/facts의 quote는 해당 subject·question_id 분기의 quote\.enum 문자열 하나를 그대로 선택/u);
  assert.match(calls[0].prompt,/전체 답변이 후보에 없으면 그대로 복사하거나 임의로 자르지 마세요/u);
  assert.ok(calls[0].data.state_input.retrieval.documents.some(row=>row.question_id==='support'&&row.text===source));
  assert.ok(calls[1].data.review_target.input.patient.find(row=>row.question_id==='support').answers.some(answer=>answer.text===source));
  assert.ok(calls[1].data.review_target.state.patient_state.facts.some(fact=>fact.question_id==='support'&&fact.quote===source));
  assert.ok(result.patient_state.facts.some(fact=>fact.question_id==='support'&&fact.quote===source));
  assert.equal(result.state_agent.reviewed,true);

  const invalid=structuredClone(value);invalid.state.patient_state.facts[0].quote=source;let attempts=0;
  await assert.rejects(runCombinedRelationshipState({async agentComplete(stage,prompt,data,schema,operation,validate){
    attempts++;return validate(invalid);
  }},ctx,null,{}),error=>{
    assert.equal(error.modelReason,'agent_schema');
    assert.equal(JSON.parse(error.modelFeedback).keyword,'maxLength');return true;
  });
  assert.equal(attempts,1);
});

test('schema feedback is opt-in and preserves the default error contract',()=>{
  const schema={type:'array',maxItems:2,items:{type:'boolean'}},value=[true,false,true];
  const plain=catchSchema(value,schema,false),detailed=catchSchema(value,schema,true);
  assert.equal(plain.code,detailed.code);assert.equal(plain.message,detailed.message);
  assert.equal(plain.modelFeedback,undefined);assert.equal(plain.schemaChecks,undefined);
  assert.deepEqual(JSON.parse(detailed.modelFeedback),{path:'output',keyword:'maxItems',expected:{max_count:2},actual:{count:3}});
});

test('feedback matches rejection for types, bounds, missing keys and nested array positions without source leakage',()=>{
  const secret='PRIVATE_RESPONSE_SENTINEL',expectedSecret='PRIVATE_ENUM_SENTINEL';
  const fixtures=[
    [{known:'ok',PRIVATE_UNKNOWN_KEY:secret},object({known:{type:'string'}}),'objectKeys'],
    [{},object({known:{type:'string'}}),'objectKeys'],
    [secret,{type:'object',properties:{}},'type'],
    [secret,{type:'string',maxLength:3},'maxLength'],
    [' \n',{type:'string'},'nonBlank'],
    [[],{type:'array',minItems:1,items:{type:'boolean'}},'minItems'],
    [secret,{type:'boolean'},'type'],
    [secret,{type:'null'},'type'],
    [secret,{const:expectedSecret},'const'],
    [secret,{enum:[expectedSecret]},'enum'],
    [[{known:secret}],{type:'array',items:object({known:{enum:[expectedSecret]}})},'enum'],
  ];
  for(const [value,schema,keyword]of fixtures){
    const plain=catchSchema(value,schema,false),detailed=catchSchema(value,schema,true);
    assert.equal(detailed.code,plain.code);assert.equal(plain.modelFeedback,undefined);
    const feedback=JSON.parse(detailed.modelFeedback);
    assert.equal(feedback.keyword,keyword);
    for(const token of [secret,expectedSecret,'PRIVATE_UNKNOWN_KEY'])assert.ok(!detailed.modelFeedback.includes(token));
  }
  const indexed=catchSchema(fixtures.at(-1)[0],fixtures.at(-1)[1],true);
  assert.equal(JSON.parse(indexed.modelFeedback).path,'output[0].known');
});

test('anyOf reports the useful matching actor/question branch without printing enum or const values',()=>{
  const branch=id=>object({subject:{const:'patient'},question_id:{const:id},quote:{enum:['PRIVATE_ENUM_SENTINEL']}});
  const schema={type:'array',items:{anyOf:[branch('mood'),branch('support')]}};
  const value=[{subject:'patient',question_id:'support',quote:'PRIVATE_RESPONSE_SENTINEL'}];
  const error=catchSchema(value,schema,true);
  assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output[0].quote',keyword:'enum',expected:{enum_count:1},actual:{type:'string'}});
  assert.ok(!error.modelFeedback.includes('PRIVATE_'));
});

test('object feedback identifies missing sibling keys at the schema path without exposing unknown keys or values',()=>{
  const review=object({state:object({approved:{type:'boolean'},issues:{type:'array',items:{type:'string'}},
    audits:{type:'array',items:object({})}}),questions:{type:'null'},safety:{type:'null'}});
  const misplaced={state:{approved:true,issues:[],audits:[],questions:null,safety:null}};
  const error=catchSchema(misplaced,review,true);
  assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output',keyword:'objectKeys',
    expected:{key_count:3,keys:['state','questions','safety']},
    actual:{key_count:1,missing_key_count:2,missing_keys:['questions','safety'],extra_key_count:0}});
  const nested={state:{approved:true,issues:[],PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE_SENTINEL'},questions:null,safety:null};
  const nestedError=catchSchema(nested,review,true);
  assert.deepEqual(JSON.parse(nestedError.modelFeedback),{path:'output.state',keyword:'objectKeys',
    expected:{key_count:3,keys:['approved','issues','audits']},
    actual:{key_count:3,missing_key_count:1,missing_keys:['audits'],extra_key_count:1}});
  assert.ok(!nestedError.modelFeedback.includes('PRIVATE_'));
  for(const value of [misplaced,nested]){
    const plain=catchSchema(value,review,false);
    assert.equal(plain.modelFeedback,undefined);assert.equal(plain.schemaChecks,undefined);
  }
});

test('feedback changes neither successful values nor the validator special-case contracts',()=>{
  const fixtures=[
    [{a:'ok'},object({a:{type:'string'}})],
    [{b:2,a:1},{enum:[{a:1,b:2}]}],
    ['ok',{anyOf:[{type:'null'},{type:'string'}],type:'null'}],
    ['ok',{type:'number'}], // The existing validator does not enforce numeric types.
    ['ok',{type:'string',minLength:5}], // It enforces nonblank, not arbitrary minLength.
    ['😀',{type:'string',maxLength:2}],
  ];
  for(const [value,schema]of fixtures){
    assert.equal(validateSchema(value,schema),value);
    assert.equal(validateSchema(value,schema,'output',true),value);
  }
  for(const enabled of [false,true])catchSchema('😀',{type:'string',maxLength:1},enabled);
});

test('the next model attempt receives exact capacity feedback and still requires independent review',async()=>{
  const ctx=context(),invalid=draft(ctx),repaired=draft(ctx),requests=[],logs=[];
  repaired.state.relationship_memory.patient=[
    {certainty:'reported',evidence:[ref(ctx,'mood'),ref(ctx,'concern'),ref(ctx,'support')]},
    repaired.state.relationship_memory.patient[2],
  ];
  let drafts=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    stateMode:'combined',agentFormat:'prompt',diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);requests.push(body);
      let payload;
      if(input.stage==='turn_draft'){
        payload=++drafts===1?invalid:repaired;
        if(drafts===1)assert.equal(input.validation_feedback,undefined);
        else assert.deepEqual(JSON.parse(input.validation_feedback),{path:'output.state.relationship_memory.patient',keyword:'maxItems',
          expected:{max_count:2},actual:{count:3}});
      }else{
        assert.equal(input.stage,'turn_review');
        assert.equal(input.validation_feedback,undefined);
        payload={state:{approved:true,issues:[],audits:input.data.review_target.claims.map(claim=>({id:claim.id,
          verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},questions:null,safety:null};
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const output=await model.updateState(ctx);
  assert.deepEqual(requests.map(body=>JSON.parse(body.messages.at(-1).content).stage),['turn_draft','turn_draft','turn_review']);
  assert.deepEqual(logs.map(entry=>entry.reason),['agent_schema','success','success']);
  assert.equal(output.relationship_memory.patient.length,2);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,repaired.state.relationship_memory.patient[0].evidence);
  assert.equal(invalid.state.relationship_memory.patient.length,3);
});

test('combined review schema failures also receive bounded feedback before any approval is accepted',async()=>{
  const ctx=context(),value=draft(ctx);value.state.relationship_memory.patient=value.state.relationship_memory.patient.slice(0,2);
  const gateway={async agentComplete(stage,prompt,data,schema,operation,validate){
    if(stage==='turn_draft')return validate(value);
    return validate({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':'supported',reason:'합성 원문 대조'}))},
      questions:{PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE_SENTINEL'},safety:null});
  }};
  await assert.rejects(runCombinedRelationshipState(gateway,ctx,null,{}),error=>{
    assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output.questions',keyword:'type',expected:{type:'null'},actual:{type:'object'}});
    assert.ok(!error.modelFeedback.includes('PRIVATE_'));return true;
  });
});

test('a misplaced review receives trusted sibling key names on repair and still needs valid independent approval',async()=>{
  const ctx=context(),value=draft(ctx),requests=[],logs=[];
  value.state.relationship_memory.patient=value.state.relationship_memory.patient.slice(0,2);
  let reviews=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    stateMode:'combined',agentFormat:'json_object',diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);requests.push(input);
      let payload=value;
      if(input.stage==='turn_review'){
        const state={approved:true,issues:[],audits:input.data.review_target.claims.map(claim=>({id:claim.id,
          verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))};
        if(++reviews===1){
          assert.equal(input.validation_feedback,undefined);
          payload={state:{...state,questions:null,safety:null,PRIVATE_UNKNOWN_KEY:'PRIVATE_RESPONSE_SENTINEL'}};
        }else{
          assert.deepEqual(JSON.parse(input.validation_feedback),{path:'output',keyword:'objectKeys',
            expected:{key_count:3,keys:['state','questions','safety']},
            actual:{key_count:1,missing_key_count:2,missing_keys:['questions','safety'],extra_key_count:0}});
          assert.ok(!input.validation_feedback.includes('PRIVATE_'));
          payload={state,questions:null,safety:null};
        }
      }else assert.equal(input.stage,'turn_draft');
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const output=await model.updateState(ctx);
  assert.deepEqual(requests.map(input=>input.stage),['turn_draft','turn_review','turn_review']);
  assert.deepEqual(logs.map(entry=>entry.reason),['success','agent_schema','success']);
  assert.equal(reviews,2);assert.equal(output.relationship_memory.patient.length,2);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('default final-stage retries keep their original prompt and schema while identifying the rejected candidate',async()=>{
  const requests=[],schema=object({text:{type:'string',maxLength:4}});
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body);requests.push(body);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:requests.length===1?'too long':'okay'})}}]}));
    }});
  const output=await model.operation({},operation=>model.agentComplete('guide_write','Original final prompt',{},schema,operation,
    value=>validateSchema(value,schema)));
  assert.deepEqual(output,{text:'okay'});assert.equal(requests.length,2);
  assert.equal(requests[0].messages[0].content,'Original final prompt');
  assert.equal(requests[1].messages[0].content,'Original final prompt\n검증 후 재작성 1: 응답 형식 검증에 실패했습니다. 지정된 키와 자료형만 사용한 완전한 JSON 객체 하나를 처음부터 작성하세요. 설명·추가 키·미완성 문자열을 넣지 마세요. 사실이나 진단을 만들지 말고, 앞선 형식 예시의 사실을 현재 자료로 사용하지 마세요. 중복을 줄이고 모든 필수 필드를 완성하세요.');
  const first=JSON.parse(requests[0].messages.at(-1).content),second=JSON.parse(requests[1].messages.at(-1).content);
  assert.deepEqual(first,{stage:'guide_write',data:{},output_schema:schema});
  assert.deepEqual(second.rejected_output,{text:'too long'});assert.equal(typeof second.repair_task,'string');
  assert.deepEqual(JSON.parse(second.validation_feedback),{path:'output.text',keyword:'maxLength',
    expected:{max_length:4},actual:{length:8}});
  const {rejected_output,repair_task,validation_feedback,...original}=second;assert.deepEqual(original,first);
});
