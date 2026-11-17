import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,schemaResult} from './summarize_paired_role_evaluation.mjs';
const request={format:'json',messages:[{content:JSON.stringify({output_schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}})}]};
const assignment=arm=>({arm,case_id:'a',source_group_id:'group-a',request_id:'a-1',task:'test',request});
test('first raw JSON is judged without markdown repair',()=>{
  assert.equal(schemaResult(request,'{"ok":true}').schema_valid,true);
  assert.equal(schemaResult(request,'```json\n{"ok":true}\n```').schema_valid,false);
  assert.equal(schemaResult(request,'{"ok":"true"}').schema_valid,false);
});
test('failed and pending requests stay in fixed denominators',()=>{
  const a=[assignment('baseline'),assignment('trained')];
  const result=aggregate(a,[{...a[0],execution_status:'failed',text:''}]);
  assert.equal(result.metrics[0].value,0);
  assert.equal(result.metrics[0].failed_count,1);
  assert.equal(result.metrics[1].value,null);
  assert.equal(result.metrics[1].not_run_count,1);
  assert.equal(result.comparisons[0].difference,null);
});
test('invalid JSON is received but schema-invalid, duplicates rejected',()=>{
  const a=assignment('baseline'),output={...a,execution_status:'output_received',text:'broken'};
  const result=aggregate([a],[output]).metrics[0];
  assert.equal(result.received_count,1);assert.equal(result.failed_count,0);assert.equal(result.value,0);
  assert.throws(()=>aggregate([a],[output,output]),/duplicate/);
  assert.throws(()=>aggregate([a,a],[]),/duplicate/);
});
test('failure cannot earn credit from a populated text field',()=>{
  const a=assignment('baseline');
  const result=aggregate([a],[{...a,execution_status:'failed',text:'{"ok":true}'}]).metrics[0];
  assert.equal(result.value,0);assert.equal(result.failed_count,1);
});
test('started requests without completion are unknown, not guessed unstarted',()=>{
  const a=assignment('baseline');
  const result=aggregate([a],[],[{...a,event:'started'}]).metrics[0];
  assert.equal(result.value,null);assert.equal(result.not_run_count,0);
  assert.equal(result.missing_execution_evidence_count,1);
});
