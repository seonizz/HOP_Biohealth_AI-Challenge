import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {serializeAnswer,answerText} from '../frontend/src/questions.js';
const catalog=JSON.parse(readFileSync(new URL('../backend/docs/MALSSI_QUESTIONNAIRE_V1.json',import.meta.url)));
const q=id=>catalog.questions.find(q=>q.id===id);
const form=values=>{const data=new FormData();for(const [k,v] of Object.entries(values))for(const item of Array.isArray(v)?v:[v])data.append(k,item);return data;};
test('NFC Korean and emoji respect code point limits',()=>{
  assert.deepEqual(serializeAnswer(q('N00'),form({text:'한글'})),{text:'한글'});
  assert.doesNotThrow(()=>serializeAnswer(q('N00'),form({text:'😀'.repeat(30)})));
  assert.throws(()=>serializeAnswer(q('N00'),form({text:'가'.repeat(31)})));
});
test('relationship is composite; partial unknown stays unknown',()=>{
  assert.deepEqual(serializeAnswer(q('T01'),form({relation:'friend',contact_frequency_status:'unknown'})),{relation:{status:'answered',option_id:'friend'},contact_frequency:{status:'unknown'}});
  assert.throws(()=>serializeAnswer(q('T01'),form({relation_status:'unknown',contact_frequency_status:'skipped'})));
});
test('other requires detail; direct text and exclusive options are preserved',()=>{
  assert.throws(()=>serializeAnswer(q('T02'),form({options:'other'})));
  assert.deepEqual(serializeAnswer(q('T02'),form({options:'other',detail:'특별한 상황'})),{option_ids:['other'],detail:'특별한 상황'});
  assert.deepEqual(serializeAnswer(q('T02'),form({direct:'직접 관찰한 이야기'})),{text:'직접 관찰한 이야기'});
  const exclusive=catalog.questions.find(q=>q.answer_schema.fields[0].mutually_exclusive_option_ids?.length&&q.answer_schema.fields[0].max_selected>1);
  const f=exclusive.answer_schema.fields[0];assert.throws(()=>serializeAnswer(exclusive,form({options:[f.mutually_exclusive_option_ids[0],f.options.find(o=>!f.mutually_exclusive_option_ids.includes(o.id)).id]})));
});
test('stored choice values render catalog labels and skipped answers',()=>{
  assert.equal(answerText({disposition:'answered',value:{option_ids:['low_mood']}},{answer_schema:q('T02').answer_schema}),'기분 저하');
  assert.equal(answerText({disposition:'skipped',value:null},q('N00')),'건너뛰었어요');
});
