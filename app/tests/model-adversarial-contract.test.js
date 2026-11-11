import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';
import {scopeProbe} from './helpers/turn-input-optimization-fixture.js';

const schema={type:'object',properties:{approved:{type:'boolean'}},required:['approved'],additionalProperties:false};
const response=content=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
const run=model=>model.operation({},operation=>model.agentComplete('state_review','합성 독립 검토',{},schema,operation,
  value=>validateSchema(value,schema,'output',true)));
const gateway=(fetchImpl,options={})=>new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',
  model:'synthetic',protocol:'relationship_agent',retryFailures:false,timeoutMs:0,diagnosticLogger:null,fetchImpl,...options});

for(const code of ['invalid_model','',0])test('explicit non-capacity code cannot trigger legacy budget recovery: '+JSON.stringify(code),async()=>{
  const requests=[];
  const model=gateway(async(_url,options)=>{
    if(options.method==='GET')return Response.json({model:'synthetic',max_output_tokens:8192,max_context_tokens:32768});
    requests.push(JSON.parse(options.body));
    return Response.json({error:{type:'invalid_request_error',code,
      message:'Prompt (26000) plus max_tokens (8192) exceeds the 32768-token context budget; no text was truncated'}},{status:400});
  },{discoverTokenLimits:true});
  await assert.rejects(run(model),{code:'MODEL_UPSTREAM_ERROR',modelReason:'http_rejected'});
  assert.equal(requests.length,1);assert.equal(requests[0].max_tokens,8192);
});

test('repeated strict-schema unknowns omission switches to complete blocks after two attempts',async()=>{
  const probe=scopeProbe(ModelGateway,{stateMode:'combined',fallback:true});
  probe.gateway.agentFormat='json_schema';
  const output=await probe.run();
  assert.equal(output.state_agent.reviewed,true);
  assert.equal(probe.calls.filter(call=>call.stage==='turn_draft').length,2);
  assert.equal(probe.calls.filter(call=>call.stage.startsWith('turn_draft_block_')).length,4);
  assert.ok(probe.calls.some(call=>call.stage==='turn_review'));
  for(const call of probe.calls.filter(call=>call.stage.startsWith('turn_draft_block_')))
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[key],probe.calls[0].data[key]);
  assert.ok(output.relationship_memory.unknowns.length>0,'missing semantic content must be model-generated, not defaulted to []');
});

test('a single unknowns omission that repairs on attempt two stays combined',async()=>{
  let drafts=0;
  const probe=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage==='turn_draft'&&++drafts===1)delete value.state.relationship_memory.unknowns;
    return value;
  }});
  probe.gateway.agentFormat='json_schema';
  const output=await probe.run();assert.equal(output.state_agent.reviewed,true);
  assert.equal(drafts,2);assert.equal(probe.calls.some(call=>call.stage.startsWith('turn_draft_block_')),false);
});

test('json-object drafts retain the third attempt before block recovery',async()=>{
  const probe=scopeProbe(ModelGateway,{stateMode:'combined',fallback:true});
  await probe.run();assert.equal(probe.calls.filter(call=>call.stage==='turn_draft').length,3);
});

test('different missing keys do not trigger early block recovery',async()=>{
  let drafts=0;
  const probe=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage==='turn_draft'){
      drafts++;
      if(drafts<=2)delete value.state.relationship_memory[drafts===1?'unknowns':'supporter'];
    }
    return value;
  }});
  probe.gateway.agentFormat='json_schema';await probe.run();
  assert.equal(drafts,3);assert.equal(probe.calls.some(call=>call.stage.startsWith('turn_draft_block_')),false);
});

for(const agentFormat of ['json_schema','json_object','prompt'])test('ordinary uncompressed reviews reject overwritten verdicts: '+agentFormat,async()=>{
  const requests=[],logs=[];
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return response(requests.length===1?'{"approved":false,"appro\\u0076ed":true}':'{"approved":false}');
  },{agentFormat,diagnosticLogger:entry=>logs.push(entry)});
  assert.deepEqual(await run(model),{approved:false});
  assert.equal(requests.length,2);assert.deepEqual(logs.map(entry=>entry.reason),['content_json','success']);
});
