import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway,relationshipEvidenceTransport} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
const stage='turn_draft_block_relationship_memory';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems)=>({type:'array',items,minItems:0,maxItems});
const ref={subject:'patient',question_id:'mood',quote:'PRIVATE_SYNTHETIC_SOURCE'};
const evidence=()=>array({...object({subject:{type:'string'},question_id:{type:'string'},quote:{type:'string'}}),enum:[ref]},3);
const finding=certainty=>object({certainty:{type:'string',enum:[certainty]},evidence:evidence(),
  ...(certainty==='tentative'?{interpretation:{type:'string'}}:{})});
const shape=()=>object({patient:array({anyOf:[finding('reported'),finding('tentative')]},2),
  supporter:array({anyOf:[finding('reported'),finding('tentative')]},2),relationship:array(finding('tentative'),1),unknowns:array({type:'string'},3)});
const output=()=>({patient:[{certainty:'reported',evidence:[ref]}],supporter:[],relationship:[],unknowns:[]});
function fixture(handler,{stream=false,selectedStage=stage}={}){
  const calls=[],schema=shape(),source={original:'PRIVATE_SYNTHETIC_SOURCE'};let validations=0;
  const gateway=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic',model:'synthetic',protocol:'relationship_agent',
    agentFormat:'json_schema',streamJson:stream,streamCompleteJson:stream,timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,...input});
      const value=evidenceWireFixture(input,handler(input,calls.length));
      return stream?new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(value)},finish_reason:null}]})+'\n\n',
        {headers:{'content-type':'text/event-stream'}}):new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
    }});
  return {calls,schema,source,get validations(){return validations;},run:()=>gateway.operation({},operation=>
    gateway.agentComplete(selectedStage,'Original source instructions',source,schema,operation,value=>{validations++;validateSchema(value,schema,'output',true);return value;}))};
}

test('relationship writer receives exact array limits on its first request without changing source or schema',async()=>{
  const f=fixture(()=>output()),snapshot=structuredClone(f.schema);assert.deepEqual(await f.run(),output());
  const call=f.calls[0];assert.deepEqual(call.data,f.source);assert.deepEqual(f.schema,snapshot);
  assert.deepEqual(call.output_schema,relationshipEvidenceTransport(stage,snapshot).schema);
  assert.deepEqual(call.array_limits.filter(row=>!row.output_path.includes('[*]')).map(({output_path,max_items})=>({output_path,max_items})),[
    {output_path:'output.patient',max_items:2},{output_path:'output.supporter',max_items:2},
    {output_path:'output.relationship',max_items:1},{output_path:'output.unknowns',max_items:3},
  ]);
  assert.deepEqual(call.array_limits.filter(row=>row.output_path==='output.patient[*].evidence').map(row=>[row.certainty,row.max_items]),[['reported',3],['tentative',3]]);
  assert.match(call.body.messages[0].content,/reported와 tentative를 합친/u);
  assert.equal(call.array_count_repair,undefined);
});

test('nonstream overflow is returned to the model with exact limits, never silently trimmed',async()=>{
  const bad=output();bad.patient[0].evidence=Array.from({length:4},()=>structuredClone(ref));
  const f=fixture((_input,count)=>count===1?bad:output());
  assert.deepEqual(await f.run(),output());assert.equal(f.calls.length,2);assert.equal(f.validations,1);
  const repair=f.calls[1].array_count_repair;
  assert.equal(repair.output_path,'output.patient[0].evidence');assert.equal(repair.observed_count,4);
  assert.ok(repair.allowed_limits.every(row=>row.output_path==='output.patient[*].evidence'&&row.max_items===3));
  assert.equal(f.calls[1].rejected_output.patient[0].evidence.length,4);
  assert.equal(bad.patient[0].evidence.length,4);
  assert.deepEqual(f.calls[1].data,f.calls[0].data);assert.deepEqual(f.calls[1].output_schema,f.calls[0].output_schema);
});

test('early stream overflow identifies the root array and retries even without a complete rejected candidate',async()=>{
  const f=fixture((_input,count)=>{const value=output();if(count===1)value.patient=Array.from({length:3},()=>structuredClone(value.patient[0]));return value;},{stream:true});
  assert.deepEqual(await f.run(),output());assert.equal(f.calls.length,2);assert.equal(f.validations,1);
  const retry=f.calls[1];assert.equal(retry.array_count_repair.output_path,'output.patient');
  assert.equal(retry.array_count_repair.observed_count,3);
  assert.deepEqual(retry.array_count_repair.allowed_limits.map(row=>row.max_items),[2]);
  assert.equal(retry.rejected_output,undefined);
  assert.deepEqual(retry.data,f.calls[0].data);assert.deepEqual(retry.output_schema,f.calls[0].output_schema);
});

test('an uncorrected overflow exhausts existing retries without calling the original validator',async()=>{
  const f=fixture(()=>{const value=output();value.patient[0].evidence=Array.from({length:4},()=>structuredClone(ref));return value;});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(f.calls.length,3);assert.equal(f.validations,0);
  assert.ok(f.calls.slice(1).every(call=>call.rejected_output.patient[0].evidence.length===4&&call.array_count_repair));
});

test('array repair belongs to the latest failure while limits remain in every writer request',async()=>{
  const f=fixture((_input,count)=>{const value=output();if(count===1)value.unknowns=['a','b','c','d'];if(count===2)value.extra='PRIVATE_UNKNOWN';return value;});
  assert.deepEqual(await f.run(),output());
  assert.ok(f.calls[1].array_count_repair);assert.equal(f.calls[2].array_count_repair,undefined);
  assert.ok(f.calls.every(call=>call.array_limits));
});

test('unrelated review requests retain their original body and receive no writer array instruction',async()=>{
  const f=fixture(()=>output(),{selectedStage:'turn_review'});assert.deepEqual(await f.run(),output());
  assert.equal(f.calls[0].array_limits,undefined);assert.equal(f.calls[0].array_count_repair,undefined);
  assert.doesNotMatch(f.calls[0].body.messages[0].content,/관계 기억의 array_limits/u);
});
