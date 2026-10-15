import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyEvidenceQuotes, riskEvidenceQuotes, evidenceQuotes } from '../src/model-schema.js';
import { trainedContext } from '../src/model-context.js';
import { groundedEvidenceSchema, relationshipDraftSchema, canonicalRelationship } from '../src/relationship-agent.js';

const field=(id,text,extra={})=>({id,question:id,status:'answered',text,rawText:text,custom:'',...extra});
const context=text=>({patient:{fields:{name:field('name','지민'),rel:field('rel','친구'),risk:field('risk',text)}},
  supporter:{fields:{}},user_goal:{},question_candidates:[]});
const reference=(quote,subject='patient',question_id='risk')=>({subject,question_id,quote});
const analysis=(quotes,urgent=false)=>({observations:{patient:[],supporter:[]},
  relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],
  safety:{urgent,evidence:quotes.map(quote=>reference(quote))}});
const denialOfLength=length=>{
  const start='다른 사람이 작년에 자해를 언급했다는 일을 전하면서 ',end=' 지금 본인은 그런 생각이 없으며 현재 위험은 없다고 정정했어요.';
  return start+'가'.repeat(length-start.length-end.length)+end;
};

test('safety candidates preserve full attribution, time and denial across old 160/1000-character boundaries',()=>{
  for(const length of [159,160,161,319,1000,1001,10000]) {
    const text=denialOfLength(length),ctx=context(text);
    assert.equal(text.length,length);
    assert.deepEqual(safetyEvidenceQuotes(ctx.patient.fields.risk),[text]);
    const schema=groundedEvidenceSchema(relationshipDraftSchema,ctx);
    const candidates=schema.properties.safety.properties.evidence.items.enum;
    assert.ok(candidates.some(ref=>ref.quote===text));
    assert.equal(candidates.some(ref=>ref.question_id==='risk'&&ref.quote!==text),false);
    assert.doesNotThrow(()=>canonicalRelationship(analysis([text]),ctx));
    const cut=text.slice(0,text.indexOf(' 지금'));
    assert.throws(()=>canonicalRelationship(analysis([cut],true),ctx),{modelReason:'agent_safety_context'});
  }
});

test('a later sentence, a newline and a quoted speaker cannot be discarded from safety evidence',()=>{
  const text='친구는 다른 사람의 과거 자해 이야기를 전했어요.\n지민 자신의 말이 아니며 지금은 안전하다고 분명히 말했어요.';
  const ctx=context(text);
  assert.deepEqual(riskEvidenceQuotes(ctx.patient.fields.risk),[text]);
  assert.throws(()=>canonicalRelationship(analysis([text.split('\n')[0]],true),ctx),{modelReason:'agent_safety_context'});
  assert.doesNotThrow(()=>canonicalRelationship(analysis([text]),ctx));
});

test('safety evidence requires separate custom and follow-up corrections from the same actor and question',()=>{
  const raw='어제 자해 얘기를 들었어요.',custom='그 말은 친구가 전달한 제삼자의 말이었어요.',followUp='정정할게요. 지민은 지금 위험하지 않다고 했어요.';
  const ctx=context(raw);
  ctx.patient.fields.risk.custom=custom;
  ctx.patient.fields.risk.followUp={answer:{rawText:followUp,text:followUp,custom:''}};
  assert.deepEqual(safetyEvidenceQuotes(ctx.patient.fields.risk),[raw,custom,followUp]);
  for(const quotes of [[raw],[raw,custom],[raw,followUp]]) {
    assert.throws(()=>canonicalRelationship(analysis(quotes,true),ctx),{modelReason:'agent_safety_context'});
  }
  assert.doesNotThrow(()=>canonicalRelationship(analysis([raw,custom,followUp]),ctx));
  const wrong=analysis([raw,custom,followUp]);wrong.safety.evidence[2].subject='supporter';
  assert.throws(()=>canonicalRelationship(wrong,ctx),{modelReason:'agent_safety_context'});
  ctx.patient.fields.risk=field('risk',followUp);
  assert.throws(()=>canonicalRelationship(analysis([raw],true),ctx),{modelReason:'agent_evidence'});
});

test('a suicidal selected label cannot bypass the complete answer and its current denial',()=>{
  const label='죽고 싶다고 말했어요',text=label+', 하지만 과거에 한 말이며 지금은 그런 생각이 없다고 답했어요.';
  const ctx=context(text);ctx.patient.fields.risk.selected=[{label,meta:{s:'suicidal'}}];
  assert.deepEqual(riskEvidenceQuotes(ctx.patient.fields.risk),[text]);
  assert.ok(evidenceQuotes(ctx.patient.fields.risk).includes(label));
  assert.throws(()=>canonicalRelationship(analysis([label],true),ctx),{modelReason:'agent_safety_context'});
  assert.doesNotThrow(()=>canonicalRelationship(analysis([text]),ctx));
});

test('critical model projections preserve complete Unicode answers and follow-up corrections in every mode',()=>{
  const text='😀'.repeat(100)+'어제 자해라는 말을 들었지만 '+'상황 설명 '.repeat(100)+'지금 위험은 없어요.';
  const followUp='이 이야기는 대상자 자신의 말이 아니라 친구가 전해 준 이야기예요.';
  const ctx=context(text);ctx.patient.fields.risk.followUp={answer:field('risk',followUp)};
  for(const final of [false,true])for(const tighter of [false,true]) {
    const row=trainedContext(ctx,null,{final,tighter}).patient.find(row=>row[0]==='risk');
    assert.deepEqual(row[3],[text,followUp]);
    assert.ok(row[3].every(quote=>quote.isWellFormed()));
  }
});

test('full current danger evidence stays admissible even when an earlier sentence denied past danger',()=>{
  const text='어제까지는 자해 생각이 없다고 했어요. '+'주변 상황을 자세히 전해요. '.repeat(12)+'하지만 지금은 자신을 해치겠다고 말하며 위험한 곳에 있어요.';
  const ctx=context(text);
  assert.doesNotThrow(()=>canonicalRelationship(analysis([text],true),ctx));
  const unknown=context(text);unknown.patient.fields.risk.status='unknown';
  assert.throws(()=>canonicalRelationship(analysis([text],true),unknown),{modelReason:'agent_evidence'});
});
