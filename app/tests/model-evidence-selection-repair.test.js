import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems=2)=>({type:'array',items,maxItems});
const ref=(subject,quote='PRIVATE_'+subject+'_SOURCE')=>({subject,question_id:'mood',quote});
const reference=pool=>({...object({subject:{type:'string'},question_id:{type:'string'},quote:{type:'string'}}),enum:pool});
const finding=(pool,certainty)=>object({evidence:array(reference(pool),3),certainty:{enum:[certainty]}});
// Unsupported annotation keeps this legacy repair path exercised after the wire transport.
const makeSchema=(pool=[ref('patient')],tentativePool=pool)=>({$comment:'legacy transport fallback',...object({
  patient:array({anyOf:[finding(pool,'reported'),finding(tentativePool,'tentative')]}),
  supporter:array({anyOf:[finding([ref('supporter')],'reported'),finding([ref('supporter')],'tentative')]}),
  relationship:array(finding([ref('patient'),ref('supporter')],'tentative')),unknowns:array({type:'string'},4),
})});
const value=(subject='patient',evidence=ref(subject),certainty='reported')=>({patient:[],supporter:[],relationship:[],unknowns:[],
  [subject]:[{evidence:[evidence],certainty}]});
const stage='turn_draft_block_relationship_memory';
const feedback=(path='output.patient[0].evidence[0]',keyword='enum',type='object')=>JSON.stringify({path,keyword,actual:{type}});
function harness(outputs){
  const requests=[],logs=[];
  const model=new ModelGateway({baseUrl:'http://synthetic.test/v1',apiKey:'PRIVATE_KEY',model:'synthetic',protocol:'relationship_agent',
    agentFormat:'prompt',timeoutMs:0,retryFailures:false,diagnosticLogger:event=>logs.push(event),fetchImpl:async(_url,options)=>{
      requests.push(JSON.parse(JSON.parse(options.body).messages.at(-1).content));
      const output=outputs[Math.min(requests.length-1,outputs.length-1)];
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {requests,logs,run:(schema,selectedStage=stage,payload={})=>model.operation({},operation=>
    model.agentComplete(selectedStage,'Synthetic instructions',payload,schema,operation,output=>validateSchema(output,schema,'output',true)))};
}
const clean=logs=>assert.equal(JSON.stringify(logs).includes('PRIVATE_'),false);

for(const subject of ['patient','supporter','relationship'])test('evidence repair targets exact '+subject+' schema without accepting shortened quotes',async()=>{
  const certainty=subject==='relationship'?'tentative':'reported',source=ref(subject==='relationship'?'patient':subject);
  const bad=value(subject,{...source,quote:'PRIVATE_SHORT'},certainty),good=value(subject,source,certainty),schema=makeSchema();
  const {run,requests,logs}=harness([bad,good]);
  assert.deepEqual(await run(schema),good);
  assert.equal(requests[0].evidence_selection_repair,undefined);
  const hint=requests[1].evidence_selection_repair;
  assert.equal(hint.output_path,`output.${subject}[0].evidence[0]`);
  assert.deepEqual(hint.schema_paths,[`output_schema.properties.${subject}.items`+
    (subject==='relationship'?'':'.anyOf[0]')+'.properties.evidence.items.enum']);
  assert.deepEqual(hint.allowed_evidence,subject==='relationship'?[ref('patient'),ref('supporter')]:[source]);
  assert.match(hint.instruction,/전체 객체를 그대로 선택/u);
  assert.deepEqual(requests[1].output_schema,schema);clean(logs);
});

test('declared certainty selects its schema branch rather than another branch pool',async()=>{
  const source=ref('patient','PRIVATE_TENTATIVE_SOURCE'),schema=makeSchema([ref('patient')],[source]);
  const {run,requests,logs}=harness([value('patient',ref('patient','PRIVATE_BAD'),'tentative'),value('patient',source,'tentative')]);
  await run(schema);
  assert.deepEqual(requests[1].evidence_selection_repair.allowed_evidence,[source]);
  assert.match(requests[1].evidence_selection_repair.schema_paths[0],/anyOf\[1\]/);clean(logs);
});

for(const pool of [Array.from({length:17},(_,i)=>ref('patient','PRIVATE_SOURCE_'+i)),[ref('patient','PRIVATE_'+'가'.repeat(3000))]])
test('large evidence pools remain complete in the schema and are never truncated into a hint: '+pool.length,async()=>{
  const schema=makeSchema(pool),{run,requests,logs}=harness([value('patient',ref('patient','PRIVATE_BAD')),value('patient',pool.at(-1))]);
  await run(schema);
  const hint=requests[1].evidence_selection_repair;
  assert.equal(hint.candidate_count,pool.length);assert.equal(Object.hasOwn(hint,'allowed_evidence'),false);
  assert.deepEqual(requests[1].output_schema,schema);clean(logs);
});

test('persistent invalid citations still fail all three original attempts',async()=>{
  const {run,requests,logs}=harness([value('patient',ref('patient','PRIVATE_BAD'))]);
  await assert.rejects(run(makeSchema()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(requests.length,3);assert.ok(requests[1].evidence_selection_repair);assert.ok(requests[2].evidence_selection_repair);clean(logs);
});

test('a later different error clears the previous evidence hint and later calls do not inherit it',async()=>{
  const good=value(),extra={...good,extra:'PRIVATE_BAD'},schema=makeSchema();
  const {run,requests,logs}=harness([value('patient',ref('patient','PRIVATE_SHORT')),extra,good]);
  await run(schema);await run(schema);await run(schema,'turn_review');
  assert.ok(requests[1].evidence_selection_repair);
  for(const request of requests.slice(2))assert.equal(request.evidence_selection_repair,undefined);
  clean(logs);
});

test('block recovery can reference identical schema pools without inventing a rejected certainty',async()=>{
  const schema=makeSchema(),{run,requests,logs}=harness([value()]);
  await run(schema,stage,{combined_validation_feedback:feedback()});
  const hint=requests[0].evidence_selection_repair;
  assert.equal(hint.schema_paths.length,2);assert.deepEqual(hint.allowed_evidence,[ref('patient')]);clean(logs);
});

test('block recovery with ambiguous certainty pools gets no candidate-selection hint',async()=>{
  const schema=makeSchema([ref('patient')],[ref('patient','PRIVATE_OTHER')]),{run,requests,logs}=harness([value()]);
  await run(schema,stage,{combined_validation_feedback:feedback()});
  assert.equal(requests[0].evidence_selection_repair,undefined);clean(logs);
});

for(const [selectedStage,issue] of [
  ['turn_draft_block_patient_state',feedback()],['turn_review',feedback()],
  [stage,feedback('output.patient','maxItems')],[stage,feedback('output.patient[0].certainty','enum','string')],
  [stage,feedback('output.patient[2].evidence[0]')],[stage,feedback('output.patient[0].evidence[3]')],
  [stage,feedback('output.PRIVATE_SOURCE[0].evidence[0]')],[stage,feedback('output.patient[0].__proto__[0]')],
  [stage,'not JSON'],[stage,JSON.stringify({keyword:'enum',path:{toString:'PRIVATE_VALUE'},actual:{type:'object'}})],
])test('unsupported stage, path or failure cannot add an evidence hint: '+selectedStage+' '+issue,async()=>{
  const {run,requests,logs}=harness([value()]);await run(makeSchema(),selectedStage,{combined_validation_feedback:issue});
  assert.equal(requests[0].evidence_selection_repair,undefined);clean(logs);
});
