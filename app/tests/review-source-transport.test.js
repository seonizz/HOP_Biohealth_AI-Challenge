import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSourceTransport,restoreReviewSources} from '../src/final-review-bundle.js';

const document=(id,subject='patient',text='합성 원문의 부정과 시점을 그대로 보존합니다. '.repeat(20))=>({source_id:id,subject,question_id:'mood',kind:'raw',text,question:'합성 질문'});
function fixture() {
  const first=document('one'),second=document('two','supporter',first.text);
  return {shared_inputs:{input_1:{retrieval:{stage:'shared',documents:[{...second,retrieved_for:['context']}],unanswered:[]}}},
    tasks:Array.from({length:8},(_,index)=>({id:'task_'+index,input:{retrieval:{stage:'stage_'+index,
      documents:[{...first,retrieved_for:['query_'+index]},...(index%2?[{...second,retrieved_for:['required']}]:[])],unanswered:['unanswered_'+index]}}})),
    retrieval:{stage:'bundle',documents:[{...first,retrieved_for:['union']},{...second,retrieved_for:['union']}],unanswered:[]}};
}
test('source table restores every task and union exactly without merging people or retrieval reasons',()=>{
  const original=fixture(),before=structuredClone(original),transport=reviewSourceTransport(original);
  assert.ok(transport);assert.equal(transport.payload.shared_sources.length,2);
  assert.deepEqual(restoreReviewSources(transport.payload),original);assert.deepEqual(original,before);
  assert.equal(transport.payload.tasks[0].input.retrieval.document_refs.length,1);
  assert.deepEqual(transport.payload.tasks[0].input.retrieval.document_refs[0].retrieved_for,['query_0']);
  assert.ok(Buffer.byteLength(JSON.stringify(transport.payload))+Buffer.byteLength(transport.instruction)<Buffer.byteLength(JSON.stringify(original)));
});
for(const field of ['subject','question_id','kind','text','question'])test('same source ID cannot conceal a '+field+' conflict',()=>{
  const original=fixture();original.tasks[1].input.retrieval.documents[0][field]='different';
  assert.throws(()=>reviewSourceTransport(original),{modelReason:'agent_review_sources'});
});
for(const change of ['unknown','duplicate_table','duplicate_ref','missing_table','unreferenced','conflict','mixed_documents'])
test('source decoder rejects '+change,()=>{
  const payload=structuredClone(reviewSourceTransport(fixture()).payload),retrieval=payload.tasks[0].input.retrieval;
  if(change==='unknown')retrieval.document_refs[0].id='missing';
  if(change==='duplicate_table')payload.shared_sources.push(payload.shared_sources[0]);
  if(change==='duplicate_ref')retrieval.document_refs.push(retrieval.document_refs[0]);
  if(change==='missing_table')payload.shared_sources.pop();
  if(change==='unreferenced')payload.shared_sources.push({id:'extra',document:document('extra')});
  if(change==='conflict')payload.shared_sources.push({id:'conflict',document:{...payload.shared_sources[0].document,text:'altered'}});
  if(change==='mixed_documents')retrieval.documents=[];
  assert.throws(()=>restoreReviewSources(payload),{modelReason:'agent_review_sources'});
});
test('small retrieval and absent pools retain the original representation including instruction cost',()=>{
  assert.equal(reviewSourceTransport({retrieval:{documents:[document('one','patient','짧음')]}}),null);
  assert.equal(reviewSourceTransport({answers:{text:'not a retrieval source'}}),null);
  const original={retrieval:{documents:[]}};assert.deepEqual(restoreReviewSources(original),original);
});
