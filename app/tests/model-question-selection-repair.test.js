import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const variant=(ids,reason)=>object({question_id:{type:'string',enum:ids},reason:{type:'string',const:reason}});
const makeSchema=items=>object({skip:{type:'array',maxItems:3,items:items??{anyOf:[
  variant(['need'],'already_covered'),variant(['others_help','values'],'not_needed'),
]}}});
const value=(id='need',reason='already_covered')=>({skip:[{question_id:id,reason}]});
const stage='turn_draft_block_questions';
const feedback=(path='output.skip[0].question_id',keyword='enum',type='string')=>JSON.stringify({path,keyword,actual:{type}});
function harness(outputs){
  const requests=[],logs=[],systems=[];
  const model=new ModelGateway({baseUrl:'http://synthetic.test/v1',apiKey:'PRIVATE_KEY',model:'synthetic',protocol:'relationship_agent',
    agentFormat:'prompt',timeoutMs:0,retryFailures:false,diagnosticLogger:event=>logs.push(event),fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body);systems.push(body.messages[0].content);requests.push(JSON.parse(body.messages.at(-1).content));
      const output=outputs[Math.min(requests.length-1,outputs.length-1)];
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {requests,logs,systems,run:(schema=makeSchema(),selectedStage=stage,payload={})=>model.operation({},operation=>
    model.agentComplete(selectedStage,'Synthetic instructions',payload,schema,operation,output=>validateSchema(output,schema,'output',true)))};
}
const clean=logs=>assert.equal(JSON.stringify(logs).includes('PRIVATE_'),false);

for(const selectedStage of [stage,stage+'_after_review'])test('question repair uses complete eligible IDs for the declared reason: '+selectedStage,async()=>{
  const schema=makeSchema(),good=value('others_help','not_needed');
  const {run,requests,logs}=harness([value('PRIVATE_WRONG','not_needed'),good]);
  assert.deepEqual(await run(schema,selectedStage),good);
  assert.equal(requests[0].question_selection_repair,undefined);
  assert.deepEqual(requests[1].question_selection_repair.eligible_choices,[{
    schema_path:'output_schema.properties.skip.items.anyOf[1].properties.question_id.enum',
    reasons:['not_needed'],question_ids:['others_help','values'],
  }]);
  assert.match(requests[1].question_selection_repair.instruction,/생략하라는 지시가 아닙니다/u);
  assert.deepEqual(requests[1].output_schema,schema);clean(logs);
});

test('direct question item schemas are supported without fabricating a branch',async()=>{
  const schema=makeSchema(variant(['need','help'],'already_covered')),{run,requests}=harness([value('wrong_id'),value()]);
  await run(schema);
  assert.deepEqual(requests[1].question_selection_repair.eligible_choices,[{
    schema_path:'output_schema.properties.skip.items.properties.question_id.enum',reasons:['already_covered'],question_ids:['need','help'],
  }]);
});

test('block recovery keeps each schema reason paired with its entire ID list',async()=>{
  const {run,requests,logs}=harness([value()]);await run(makeSchema(),stage,{combined_validation_feedback:feedback()});
  assert.deepEqual(requests[0].question_selection_repair.eligible_choices.map(({reasons,question_ids})=>({reasons,question_ids})),[
    {reasons:['already_covered'],question_ids:['need']},{reasons:['not_needed'],question_ids:['others_help','values']},
  ]);clean(logs);
});

test('an ineligible proposal can be omitted without forcing a replacement skip',async()=>{
  const {run,requests}=harness([value('wrong_id'),{skip:[]}]);
  assert.deepEqual(await run(),{skip:[]});assert.ok(requests[1].question_selection_repair);
});

test('invalid IDs remain rejected after all three attempts',async()=>{
  const {run,requests,logs}=harness([value('PRIVATE_WRONG')]);
  await assert.rejects(run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(requests.length,3);assert.ok(requests[1].question_selection_repair);assert.ok(requests[2].question_selection_repair);clean(logs);
});

test('different errors and later calls do not retain question repair hints',async()=>{
  const {run,requests,logs}=harness([value('wrong_id'),{...value(),extra:'PRIVATE_VALUE'},value()]);
  await run();await run();await run(makeSchema(),'turn_draft_block_relationship_memory');
  assert.ok(requests[1].question_selection_repair);
  for(const request of requests.slice(2))assert.equal(request.question_selection_repair,undefined);
  clean(logs);
});

for(const ids of [Array.from({length:65},(_,i)=>'question_'+i),['need','PRIVATE_ID'],['need','wrong-id'],['need','a'.repeat(65)]])
test('large or incompatible ID catalogs produce no partial hint: '+ids.length+' '+ids.at(-1),async()=>{
  const schema=makeSchema(variant(ids,'already_covered')),good=value(ids[0]),{run,requests,logs}=harness([good]);
  await run(schema,stage,{combined_validation_feedback:feedback()});
  assert.equal(requests[0].question_selection_repair,undefined);assert.deepEqual(requests[0].output_schema,schema);clean(logs);
});

for(const [selectedStage,issue] of [
  ['turn_draft_block_patient_state',feedback()],['question_review',feedback()],
  [stage,feedback('output.skip','maxItems')],[stage,feedback('output.skip[0].reason')],
  [stage,feedback('output.skip[3].question_id')],[stage,feedback('output.skip[0].question_id','enum','object')],
  [stage,feedback('output.skip[0].PRIVATE_PATH')],[stage,'not JSON'],
])test('unrelated errors and paths cannot create a question hint: '+selectedStage+' '+issue,async()=>{
  const {run,requests,logs}=harness([value()]);await run(makeSchema(),selectedStage,{combined_validation_feedback:issue});
  assert.equal(requests[0].question_selection_repair,undefined);clean(logs);
});

for(const selectedStage of [stage,stage+'_after_review'])test('complete question catalog is the final system instruction on initial and retry requests: '+selectedStage,async()=>{
  const h=harness([value('PRIVATE_WRONG'),value()]);await h.run(makeSchema(),selectedStage,{answers:[{question_id:'PRIVATE_SOURCE_ID'}]});
  const expected=[{reasons:['already_covered'],question_ids:['need']},{reasons:['not_needed'],question_ids:['others_help','values']}];
  for(const system of h.systems){
    assert.deepEqual(JSON.parse(system.split('허용 조합: ').at(-1)),expected);assert.match(system,/답변 원문의 question_id는 근거 위치/u);assert.match(system,/생략 지시가 아닙니다/u);assert.equal(system.includes('PRIVATE_SOURCE_ID'),false);
  }
  clean(h.logs);
});
for(const [id,reason,flags] of [
  ['PRIVATE_WRONG','already_covered',[true,false,false,false]],
  ['others_help','already_covered',[true,true,false,true]],
  [' need ','already_covered',[true,false,false,true]],
  [42,'already_covered',[false,false,false,false]],
])test('question ID diagnostic contains only boolean classification: '+JSON.stringify(flags),async()=>{
  const h=harness([value(id,reason),value()]);await h.run();
  const diagnostic=h.logs.find(event=>event.question_id_failure)?.question_id_failure;
  assert.deepEqual(diagnostic,Object.fromEntries(['id_string','any_eligible','reason_eligible','trimmed_eligible'].map((key,i)=>[key,flags[i]])));
  assert.ok(Object.values(diagnostic).every(value=>typeof value==='boolean'));clean(h.logs);
});
test('question catalog never appears for other stages, unsupported or oversized schemas',async()=>{
  const unsupported=makeSchema();unsupported.properties.skip.items.allOf=[];
  const large=makeSchema(variant(Array.from({length:65},(_,i)=>'question_'+i),'already_covered'));
  for(const [shape,selectedStage] of [[makeSchema(),'turn_review'],[unsupported,stage],[large,stage]]){
    const h=harness([{skip:[]}]);await h.run(shape,selectedStage);assert.ok(h.systems.every(system=>!system.includes('질문 생략 최종 제약')));assert.ok(h.logs.every(event=>!event.question_id_failure));
  }
});
test('empty eligible schema keeps skip empty without inventing a catalog',async()=>{
  const shape=makeSchema(object({}));shape.properties.skip.maxItems=0;
  const h=harness([{skip:[]}]);await h.run(shape);assert.ok(h.systems[0].endsWith('허용 조합: []'));
});
test('success and unrelated schema errors do not emit question ID diagnostic',async()=>{
  const h=harness([{skip:[{question_id:'need',reason:'already_covered',extra:'PRIVATE_EXTRA'}]},value()]);await h.run();
  assert.ok(h.logs.every(event=>!event.question_id_failure));clean(h.logs);
});
