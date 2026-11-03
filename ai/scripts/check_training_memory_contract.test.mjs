import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {checkMemoryRow,checkFiles} from './check_training_memory_contract.mjs';
import {projectMemoryCase} from './project_memory_review_cases.mjs';
import {requestCombinedStateReview} from '../../app/src/relationship-turn.js';

// Newly authored regression fixture; not copied from a training/evaluation row.
const fixture=()=>({case_id:'fixture-001',split:'train',origin_type:'test_fixture',
  turn1:'성인 친구가 행사 준비를 맡았대요. 저는 표 정리만 도울 수 있어요. 역할을 나누고 싶어요. 장소는 동쪽 방이라고 들었어요.',
  turn2:'장소를 정정할게요. 친구가 서쪽 방으로 옮겼다고 했어요.',
  facts:[{subject:'patient',turn:1,quote:'성인 친구가 행사 준비를 맡았대요.'},
    {subject:'supporter',turn:1,quote:'저는 표 정리만 도울 수 있어요.'},
    {subject:'user_goal',turn:1,quote:'역할을 나누고 싶어요.'},
    {subject:'patient',turn:2,quote:'친구가 서쪽 방으로 옮겼다고 했어요.'}],
  superseded:[{subject:'patient',turn:1,quote:'장소는 동쪽 방이라고 들었어요.'}],
  unknowns:['표를 정리할 시간']});
const rows=async()=>(await projectMemoryCase(fixture())).rows;

test('actual current callback validates accepted and rejected synthetic targets without rewriting them',async()=>{
  for(const row of await rows()) {
    const before=structuredClone(row),report=await checkMemoryRow(row,requestCombinedStateReview);
    assert.deepEqual(report,{schema_equal:true,input_equal:true,prompt_equal:true,validator_passed:true});
    assert.deepEqual(row,before);
  }
});

test('prompt drift is distinguished from a target accepted by the current callback',async()=>{
  const [row]=await rows();row.messages[0].content='old prompt';
  const report=await checkMemoryRow(row,requestCombinedStateReview);
  assert.equal(report.prompt_equal,false);
  assert.equal(report.validator_passed,true);
});

test('frozen output schema drift is distinct from current callback compatibility',async()=>{
  const [row]=await rows(),request=JSON.parse(row.messages[1].content);
  request.output_schema={type:'object'};row.messages[1].content=JSON.stringify(request);
  const report=await checkMemoryRow(row,requestCombinedStateReview);
  assert.equal(report.schema_equal,false);
  assert.equal(report.validator_passed,true);
});

test('current callback rejects missing audits even if approval is true',async()=>{
  const [row]=await rows(),answer=JSON.parse(row.messages[2].content);
  answer.state.audits=[];row.messages[2].content=JSON.stringify(answer);
  const report=await checkMemoryRow(row,requestCombinedStateReview);
  assert.equal(report.validator_passed,false);
  assert.equal(report.error,'current_callback_rejected');
});

test('private validator exception text is never reported',async()=>{
  const [row]=await rows();
  const report=await checkMemoryRow(row,async()=>{throw new Error('PRIVATE_SOURCE_EXCERPT');});
  assert.equal(report.validator_passed,false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_SOURCE_EXCERPT'));
});

test('a request implementation that never supplies its callback is not a pass',async()=>{
  const [row]=await rows();
  assert.equal((await checkMemoryRow(row,async()=>({}))).validator_passed,false);
});

test('memory scope refuses a hidden safety or question judgment',async()=>{
  const [row]=await rows(),answer=JSON.parse(row.messages[2].content);
  answer.safety={approved:true};row.messages[2].content=JSON.stringify(answer);
  assert.equal((await checkMemoryRow(row,requestCombinedStateReview)).validator_passed,false);
});

test('gzip partitions count only memory tasks and do not imply semantic approval',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contract-check-'));
  try {
    const file=path.join(dir,'rows.jsonl.gz'),memory=await rows();
    fs.writeFileSync(file,gzipSync([...memory,{task:'answer_review'}].map(r=>JSON.stringify(r)+'\n').join('')));
    const before=fs.readFileSync(file),report=await checkFiles([file],requestCombinedStateReview);
    assert.equal(report.rows_checked,4);assert.equal(report.rows_rejected,0);
    assert.equal(report.status,'compatible');assert.equal(report.semantic_quality_evaluated,false);
    assert.equal(report.previous_semantic_approval_reused,false);assert.equal(report.model_calls,0);
    assert.deepEqual(fs.readFileSync(file),before);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('zero matching rows is not a successful coverage check',async()=>{
  assert.equal((await checkFiles([],requestCombinedStateReview)).status,'not_covered');
});
