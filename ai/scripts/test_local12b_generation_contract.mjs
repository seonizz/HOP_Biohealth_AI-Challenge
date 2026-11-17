import test from 'node:test';
import assert from 'node:assert/strict';
import {sources,captureSource,makeCoverage,score,STAGES,digest} from './local12b_generation_contract.mjs';

async function fixture(split='validation'){
 const source=sources().find(s=>s.split===split),inputs=[],refs=[];
 for(const repair of [false,true])for(const r of await captureSource(source,repair)){
  const common={request_id:digest([source.source_root_id,r.stage,r.variant]),task:'app_generation',stage:r.stage,variant:r.variant,source_root_ids:[source.source_root_id],split};
  inputs.push({...common,messages:r.messages});refs.push({...common,target:r.target});
 }
 return {inputs,refs,coverage:makeCoverage(inputs,refs),outputs:refs.map(r=>({request_id:r.request_id,text:JSON.stringify(r.target),finish_reason:'stop',status:'ok'}))};
}
const data=await fixture();
test('new sources are disjoint and cover both polarity and uncertainty in each split',()=>{
 const all=sources();assert.equal(new Set(all.map(s=>s.source_root_id)).size,16);
 for(const split of ['train','validation','test']){
  const subset=all.filter(s=>s.split===split);assert.equal(new Set(subset.map(s=>s.negated)).size,2);assert.equal(new Set(subset.map(s=>s.uncertain)).size,2);
 }
});
test('actual app builders and native retry feedback yield three normal and three corrected wire requests',()=>{
 assert.equal(data.inputs.length,6);
 for(const stage of STAGES){const clean=data.inputs.find(r=>r.stage===stage&&r.variant==='normal'),retry=data.inputs.find(r=>r.stage===stage&&r.variant==='repair');assert.notDeepEqual(clean.messages,retry.messages);}
});
test('gold passes but missing baseline and held-out test never select a model',async()=>{
 const {inputs,refs,outputs,coverage}=data,base=score(inputs,refs,outputs,coverage);
 assert.equal(base.failures,0);assert.equal(base.integration_gate_eligible,false);assert.equal(base.checkpoint_selection_allowed,false);
 const next=score(inputs,refs,outputs,coverage,{baseline:base});assert.equal(next.integration_gate_eligible,true);assert.equal(next.model_selection_ready,false);
 const held=await fixture('test'),r=score(held.inputs,held.refs,held.outputs,held.coverage,{split:'test'});
 assert.equal(r.gate.passed,true);assert.equal(r.integration_gate_eligible,false);
});
test('duplicate state fits maximum length but is rejected',()=>{
 const bad=structuredClone(data.outputs),value=JSON.parse(bad[0].text);value.patient_state.facts=[value.patient_state.facts[0],value.patient_state.facts[0]];bad[0].text=JSON.stringify(value);
 const r=score(data.inputs,data.refs,bad,data.coverage);assert.equal(r.records[0].schema_valid,true);assert.equal(r.records[0].passed,false);
});
test('missing, incomplete, malformed and duplicate-key outputs cannot disappear from the denominator',()=>{
 const variants=[data.outputs.slice(1),structuredClone(data.outputs),structuredClone(data.outputs),structuredClone(data.outputs)];
 variants[1][0].finish_reason='length';variants[2][0].text='{';variants[3][0].text='{"patient_state":null,'+variants[3][0].text.slice(1);
 for(const v of variants){const r=score(data.inputs,data.refs,v,data.coverage);assert.equal(r.assigned,6);assert.equal(r.failures,1);assert.equal(r.gate.passed,false);}
});
test('wrong certainty and unsupported reference are rejected even when output is JSON',()=>{
 for(const mutate of [v=>{v.patient_state.facts[0].certainty='unknown';},v=>{v.patient_state.facts[0].quote='보고되지 않은 긍정 문장';}]){
  const bad=structuredClone(data.outputs),v=JSON.parse(bad[0].text);mutate(v);bad[0].text=JSON.stringify(v);
  assert.equal(score(data.inputs,data.refs,bad,data.coverage).gate.passed,false);
 }
});
test('coverage drift, output ID collisions and incomplete baselines fail closed',()=>{
 assert.throws(()=>score(data.inputs.slice(1),data.refs.slice(1),data.outputs.slice(1),data.coverage));
 assert.throws(()=>score(data.inputs,data.refs,[...data.outputs,data.outputs[0]],data.coverage));
 const base=score(data.inputs,data.refs,data.outputs,data.coverage);base.received=5;
 assert.throws(()=>score(data.inputs,data.refs,data.outputs,data.coverage,{baseline:base}));
});

test('error status with otherwise valid text and stop still fails',()=>{
 const bad=structuredClone(data.outputs);bad[0].status='timeout';
 const result=score(data.inputs,data.refs,bad,data.coverage);assert.equal(result.failures,1);assert.equal(result.gate.passed,false);
});

test('missing status with otherwise valid text and stop fails closed',()=>{
 const bad=structuredClone(data.outputs);delete bad[0].status;
 const result=score(data.inputs,data.refs,bad,data.coverage);
 assert.equal(result.assigned,data.inputs.length);assert.equal(result.failures,1);
 assert.equal(result.records[0].schema_valid,false);assert.equal(result.gate.passed,false);
 assert.equal(result.integration_gate_eligible,false);
});
