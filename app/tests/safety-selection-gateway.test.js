import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {configuredModelGateway,configuredReviewGateway} from '../src/model-config.js';
import {prepareModelConnection,connectionGateway} from '../src/model-connections.js';
import {cases} from '../scripts/turn-comparison-cases.js';
import {relationshipQuestionRequest,safetyReviewRequest,validateSafetyReview,safetySources} from '../src/relationship-agent.js';
const envelope=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:typeof content==='string'?content:JSON.stringify(content)}}]}));
const config={baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',model:'synthetic',protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null};
function fixture(id='current_physical_danger'){
 const context=structuredClone(cases.find(row=>row.id===id).context),request=safetyReviewRequest(relationshipQuestionRequest(context),{safety_signal:{urgent:false,evidence:[]}});
 return {context,request,risk:safetySources(context).find(row=>row.question_id==='risk').id};
}
function wire(input,{risk,basis='current_physical_danger',none=false}={}){
 return {b:input.output_schema.properties.b.enum[0],o:{basis,reason:'현재 원문의 시점과 부정을 대조한 독립 판정입니다.',evidence_selection:Object.fromEntries(Object.keys(input.output_schema.properties.o.properties.evidence_selection.properties).map(id=>[id,!none&&id===risk]))}};
}
async function run(gateway,f){return gateway.operation({},op=>gateway.agentComplete('safety_review_final',f.request.prompt,f.request.data,f.request.schema,op,value=>validateSafetyReview(value,f.context,f.request)));}
for(const [id,basis] of [['current_physical_danger','current_physical_danger'],['negated_current_danger','negated'],['past_only_danger','past_only']])
test(`selected safety sources reach the original semantic validator: ${basis}`,async()=>{
 const f=fixture(id),calls=[];const gateway=new ModelGateway({...config,safetyReviewSelectionMap:true,fetchImpl:async(_url,init)=>{
  const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content);calls.push(input);return envelope(wire(input,{risk:f.risk,basis}));
 }});const result=await run(gateway,f);assert.equal(calls.length,1);assert.equal(result.review.basis,basis);assert.equal(result.urgent,basis==='current_physical_danger');assert.ok(result.evidence.length>0);assert.equal(gateway.compactReviewOutput,false);
});
test('current danger with no selected source still fails every bounded attempt',async()=>{
 const f=fixture(),calls=[];const gateway=new ModelGateway({...config,safetyReviewSelectionMap:true,fetchImpl:async(_url,init)=>{
  const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content);calls.push(input);return envelope(wire(input,{none:true}));
 }});await assert.rejects(run(gateway,f),{code:'MODEL_INVALID_RESPONSE',modelAttempts:3});assert.equal(calls.length,3);
});
test('duplicate raw boolean keys are rejected before hydration',async()=>{
 const f=fixture();let calls=0;const gateway=new ModelGateway({...config,safetyReviewSelectionMap:true,fetchImpl:async(_url,init)=>{
  const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content),value=wire(input,{risk:f.risk});calls++;const text=JSON.stringify(value).replace(JSON.stringify(f.risk)+':true',JSON.stringify(f.risk)+':false,'+JSON.stringify(f.risk)+':true');return envelope(text);
 }});await assert.rejects(run(gateway,f),{code:'MODEL_INVALID_RESPONSE',modelAttempts:3});assert.equal(calls,3);
});
test('writer opt-in reaches an independent reviewer without enabling audit compression',async()=>{
 const f=fixture();let writerCalls=0,reviewCalls=0;const reviewer=new ModelGateway({...config,fetchImpl:async(_url,init)=>{reviewCalls++;const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content);return envelope(wire(input,{risk:f.risk}));}});
 const writer=new ModelGateway({...config,safetyReviewSelectionMap:true,reviewGateway:reviewer,fetchImpl:async()=>{writerCalls++;throw new Error('Unexpected writer request');}});
 assert.equal((await run(writer,f)).urgent,true);assert.equal(reviewCalls,1);assert.equal(writerCalls,0);assert.equal(reviewer.compactReviewOutput,false);assert.equal(reviewer.safetyReviewSelectionMap,false);
});
test('default gateway retains the original safety array contract',async()=>{
 const f=fixture();let calls=0;const gateway=new ModelGateway({...config,fetchImpl:async(_url,init)=>{calls++;const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content);assert.ok(input.output_schema.properties.evidence_ids);assert.equal(input.output_schema.properties.b,undefined);return envelope({basis:'current_physical_danger',reason:'현재 위험 원문입니다.',evidence_ids:[f.risk]});}});
 assert.equal((await run(gateway,f)).urgent,true);assert.equal(calls,1);
});
test('selection opt-in is strict, independent and retained in immutable connection serialization',()=>{
 const env={MODEL_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_API_KEY:'synthetic',MODEL_NAME:'synthetic',MODEL_PROTOCOL:'relationship_agent',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_SAFETY_REVIEW_SELECTION_MAP:'true'};
 const gateway=configuredModelGateway({env,diagnosticLogger:null});assert.equal(gateway.safetyReviewSelectionMap,true);assert.equal(gateway.reviewGateway.safetyReviewSelectionMap,false);
 const reviewer=configuredReviewGateway({env:{...env,MODEL_REVIEW_SAFETY_REVIEW_SELECTION_MAP:'true'}});assert.equal(reviewer.safetyReviewSelectionMap,true);
 for(const value of ['yes','TRUE','1',true,null])assert.throws(()=>configuredReviewGateway({env:{...env,MODEL_REVIEW_SAFETY_REVIEW_SELECTION_MAP:value}}),/Invalid MODEL_REVIEW configuration/);
 const prepared=prepareModelConnection('gpu31b',{base_url:gateway.baseUrl,model:gateway.model,api_key:''},gateway),restored=connectionGateway(prepared.config);
 assert.equal(restored.safetyReviewSelectionMap,true);assert.equal(restored.reviewGateway.safetyReviewSelectionMap,false);assert.equal(prepared.config.writer.safetyReviewSelectionMap,true);
});
