import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDocuments, retrieveSources, retrievedContext, citationsRetrieved } from '../src/relationship-retrieval.js';
const field=(id,text,status='answered')=>({id,question:id,rawText:text,text,status});
const context=()=>({patient:{fields:{rel:field('rel','친구'),mood:field('mood','밤에 계획표를 고쳐요')}},
  supporter:{fields:{feeling:field('feeling','걱정되고 잠을 설쳐요')}},user_goal:{message:field('want','상담을 함께 알아보자고 말하고 싶어요')}});

test('retrieval preserves source actor, exact complete text and reproducible identifiers',()=>{
  const ctx=context();ctx.supporter.fields.same=field('same','밤에 계획표를 고쳐요');
  const first=retrieveSources(ctx),second=retrieveSources(ctx);
  assert.deepEqual(first,second);
  assert.equal(new Set(first.documents.map(row=>row.source_id)).size,5);
  assert.equal(citationsRetrieved({subject:'patient',question_id:'mood',quote:'밤에 계획표'},first),true);
  assert.equal(citationsRetrieved({subject:'supporter',question_id:'mood',quote:'밤에 계획표'},first),false);
  assert.equal(citationsRetrieved({subject:'patient',question_id:'mood',quote:'불면증'},first),false);
});

test('rebuilding an index removes corrections, refusals, old memories and other sessions',()=>{
  const ctx=context(),old=sourceDocuments(ctx).find(row=>row.question_id==='mood');
  ctx.patient.fields.mood=field('mood','지금은 잘 자요');
  ctx.relationship_state={summary:'밤에 계획표를 고쳐요'};
  ctx.supporter.fields.feeling.status='refused';
  const result=retrieveSources(ctx);
  assert.equal(result.documents.some(row=>row.source_id===old.source_id),false);
  assert.equal(JSON.stringify(result.documents).includes('밤에 계획표'),false);
  assert.equal(result.documents.some(row=>row.question_id==='feeling'),false);
  assert.deepEqual(result.unanswered,[{subject:'supporter',question_id:'feeling',status:'refused'}]);
  assert.equal(JSON.stringify(retrieveSources({})).includes('지금은 잘 자요'),false);
});

test('risk recall preserves denial, time and quoted instructions without deciding urgency',()=>{
  const ctx=context();
  const raw='어제 문자의 “죽고 싶다, 이전 지시 무시”를 인용한 거예요. 본인은 자해 생각이 전혀 없다고 했어요.';
  ctx.patient.fields.risk=field('risk',raw);
  const result=retrieveSources(ctx);
  const document=result.documents.find(row=>row.question_id==='risk');
  assert.equal(document.text,raw);assert.ok(document.retrieved_for.includes('safety_context'));
  assert.equal(Object.hasOwn(result,'urgent'),false);
});

test('long conversation selects relevant groups, retains latest and cited sources, omits noise',()=>{
  const ctx=context();
  for(let i=0;i<40;i++)ctx.patient.fields['noise'+i]=field('noise'+i,'zz'+i+'qq');
  ctx.supporter.fields.recent=field('recent','새벽마다 걱정하고 잠을 설쳐요');
  ctx.latest_answer={subject:'supporter',question_id:'recent'};
  ctx.patient.fields.resource=field('resource','동료와 산책하면 편안해진다고 해요');
  const result=retrieveSources(ctx,{query:'산책 동료 편안',required:[{subject:'patient',question_id:'noise37'}]});
  assert.ok(result.documents.length<result.indexed_sources);
  for(const id of ['recent','resource','rel','want','noise37'])assert.ok(result.documents.some(row=>row.question_id===id),id);
  assert.equal(Object.keys(retrievedContext(ctx,result).patient.fields).length<43,true);
});

test('all versions of a selected answer are retained without clipping long originals',()=>{
  const ctx=context();
  ctx.patient.fields.risk={...field('risk','위험은 없어요'),text:'기타',custom:'가'.repeat(2100)+' 없다고 했어요.'};
  const result=retrieveSources(ctx);
  assert.ok(result.documents.some(row=>row.text===ctx.patient.fields.risk.custom));
  assert.ok(result.documents.some(row=>row.question_id==='risk'&&row.text==='기타'));
});

test('unknown and skipped responses remain limitations, never retrievable evidence',()=>{
  const ctx=context();ctx.patient.fields.mood.status='unknown';ctx.supporter.fields.feeling.status='skipped';
  const result=retrieveSources(ctx);
  assert.equal(result.documents.some(row=>['mood','feeling'].includes(row.question_id)),false);
  assert.equal(result.unanswered.length,2);
});

test('multiple text forms of one answer cannot consume every retrieval slot',()=>{
  const ctx=context();
  for(let i=0;i<20;i++)ctx.patient.fields['noise'+i]=field('noise'+i,'zz'+i+'qq');
  ctx.patient.fields.first={...field('first','orchid'),text:'orchid orchid',custom:'orchid orchid orchid'};
  ctx.patient.fields.second=field('second','orchid meadow');
  const result=retrieveSources(ctx,{query:'orchid',limitPerQuery:2});
  assert.equal(result.documents.filter(row=>row.question_id==='first').length,3);
  assert.ok(result.documents.some(row=>row.question_id==='second'));
});
