import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkResponse,validateOutputs} from './validate_role_outputs.mjs';
import {sourceContext} from './project_chat_cases.mjs';
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

test('JSON schema and absent output are not semantic approvals',()=>{
  const request={format:'json',task:'final_card_script',messages:[{role:'user',content:JSON.stringify({
    output_schema:{type:'object',properties:{script:{type:'string',minLength:1}},required:['script'],additionalProperties:false}})}]};
  assert.throws(()=>checkResponse(request,null,{}));
  assert.throws(()=>checkResponse(request,'{"script":42}',{}));
  assert.throws(()=>checkResponse(request,'{"script":"ok","extra":true}',{}));
  assert.doesNotThrow(()=>checkResponse(request,'{"script":"ok"}',{}));
});

test('missing requests fail family schema and unbound checkpoints are rejected',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'role-eval-contract-'));
  try {
    const folder=path.join(root,'chat_12b/development');fs.mkdirSync(folder,{recursive:true});
    const input={case_id:'unit',requests:[{request_id:'unit-one',format:'text',messages:[{role:'user',content:'Original source'}]}]};
    const reference={case_id:'unit',input_sha256:digest(input)};
    const suite={cases:[{case_id:'unit',input_sha256:digest(input),reference_sha256:digest(reference)}],model_role:'chat_12b',schema:'malssi-role-evaluation-suite-v1',split:'development'};
    fs.writeFileSync(path.join(folder,'SUITE.json'),JSON.stringify(suite));
    fs.writeFileSync(path.join(folder,'INPUTS.jsonl'),JSON.stringify(input)+'\n');
    fs.writeFileSync(path.join(folder,'REFERENCES.jsonl'),JSON.stringify(reference)+'\n');
    const output={schema:'malssi-role-model-outputs-v1',model_role:'chat_12b',split:'development',
      suite_sha256:digest(suite),checkpoint_sha256:'a'.repeat(64),responses:[]};
    const out=path.join(root,'output.json');fs.writeFileSync(out,JSON.stringify(output));
    const result=validateOutputs(root,'chat_12b','development',out);
    assert.equal(result.schema_valid_by_case.unit,false);assert.equal(result.semantic_quality_evaluated,false);
    output.checkpoint_sha256=null;fs.writeFileSync(out,JSON.stringify(output));
    assert.throws(()=>validateOutputs(root,'chat_12b','development',out),/binding/);
    output.checkpoint_sha256='a'.repeat(64);fs.writeFileSync(out,JSON.stringify(output));
    input.requests[0].messages[0].content='Replacement source with unchanged frozen suite';
    fs.writeFileSync(path.join(folder,'INPUTS.jsonl'),JSON.stringify(input)+'\n');
    assert.throws(()=>validateOutputs(root,'chat_12b','development',out),/frozen suite/);
    input.requests[0].messages[0].content='Original source';
    fs.writeFileSync(path.join(folder,'INPUTS.jsonl'),JSON.stringify(input)+'\n');
    fs.writeFileSync(path.join(folder,'REFERENCES.jsonl'),JSON.stringify({...reference,source_context:{}})+'\n');
    assert.throws(()=>validateOutputs(root,'chat_12b','development',out),/frozen suite/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('current and superseded source spans use identical neutral metadata',()=>{
  const earlier={subject:'patient',turn:1,quote:'Earlier report.'},current={subject:'patient',turn:2,quote:'Corrected report.'};
  const item={case_id:'unit',turn1:'Earlier report.',turn2:'Corrected report.',facts:[current],superseded:[earlier],
    redundant_question:{...current,text:'What was corrected?',reason:'Source answers it.'},
    needed_question:{subject:'patient',text:'What date is available?',reason:'Date is missing.'}};
  const {context}=sourceContext(item);const fields=Object.values(context.patient.fields);
  assert.equal(fields.length,2);assert.ok(fields.every(f=>/^s_[0-9a-f]{12}$/.test(f.id)));
  assert.deepEqual(fields.map(f=>f.question),['1차 발화에서 보고한 내용','2차 발화에서 보고한 내용']);
  const swapped=sourceContext({...item,facts:[earlier],superseded:[current]}).context;
  assert.deepEqual(swapped,context,'Changing evaluator labels must not change model source context');
});
