import test from 'node:test';
import assert from 'node:assert/strict';
import { answerComponents } from '../src/answer-sources.js';
import { ModelGateway } from '../src/model.js';
import { agentContext, canonicalRelationshipSelection, groundedEvidenceSchema,
  relationshipSelectionSchema, safetySources } from '../src/relationship-agent.js';
import { retrieveSources, sourceDocuments } from '../src/relationship-retrieval.js';

const field = (id, text, extra = {}) => ({ id, question:`${id} 원질문`, status:'answered', rawText:text, text, custom:'', ...extra });
const context = text => ({
  patient:{ alias:'지민', fields:{ name:field('name', '지민'), rel:field('rel', '친구'), risk:field('risk', text) } },
  supporter:{ fields:{} }, user_goal:{}, question_candidates:[], name_index:null,
  relationship_state:{ patient:[], supporter:[], relationship:[], unknowns:[] },
});
const source = (ctx, subject = 'patient', questionId = 'risk') => safetySources(ctx)
  .find(row => row.subject === subject && row.question_id === questionId);
const selection = (ids, urgent = false) => ({
  observations:{ patient:[], supporter:[] },
  relationship:{ label:'친구', supporter_role:'친구', dynamics:[], strengths:[], boundaries:[] },
  unknowns:[], safety:{ urgent, evidence_ids:ids },
});
const hydrate = (ctx, value, retrieval = retrieveSources(ctx)) => canonicalRelationshipSelection(value, ctx, retrieval);
const rejected = (run, modelReason = 'agent_schema') => assert.throws(run, { code:'MODEL_INVALID_RESPONSE', modelReason });
const longText = label => {
  const prefix = `${label} 과거 자해 이야기를 전달했어요. `, suffix = ' 지금 본인의 위험은 없다고 정정했어요.';
  return prefix + '가'.repeat(10000 - prefix.length - suffix.length) + suffix;
};

test('a bounded safety ID restores a maximum-length original without placing that original in the safety wire schema', () => {
  const text = longText('최대 입력');
  const ctx = context(text), id = source(ctx).id, wire = selection([id]);
  assert.equal(text.length, 10000);
  const schema = groundedEvidenceSchema(relationshipSelectionSchema, ctx);
  assert.deepEqual(Object.keys(schema.properties.safety.properties).sort(), ['evidence_ids', 'urgent']);
  assert.ok(schema.properties.safety.properties.evidence_ids.items.enum.includes(id));
  assert.equal(JSON.stringify(schema.properties.safety).includes(text), false);
  assert.ok(Buffer.byteLength(JSON.stringify(wire.safety)) < 150);
  for (const urgent of [false, true]) {
    const result = hydrate(ctx, selection([id], urgent));
    assert.equal(result.safety.urgent, urgent, 'source hydration must not replace the model’s urgency decision');
    assert.deepEqual(result.safety.evidence, [{ subject:'patient', question_id:'risk', quote:text }]);
  }
});

test('one selected question restores all six distinct raw, normalized, custom and follow-up components', () => {
  const texts = Array.from({ length:6 }, (_, index) => longText(`원문 ${index}`));
  const ctx = context(texts[0]);
  Object.assign(ctx.patient.fields.risk, { text:texts[1], custom:texts[2], followUp:{ question:'현재 누구의 이야기인가요?',
    answer:{ rawText:texts[3], text:texts[4], custom:texts[5] } } });
  assert.ok(texts.every(text => text.length === 10000));
  const bundle = source(ctx);
  assert.equal(bundle.components.length, 6);
  const wire = selection([bundle.id]);
  const result = hydrate(ctx, wire);
  assert.deepEqual(result.safety.evidence.map(ref => ref.quote), texts);
  assert.equal(result.safety.evidence.reduce((length, ref) => length + ref.quote.length, 0), 60000);
  assert.deepEqual(wire, selection([bundle.id]), 'hydration must not mutate the model output');
});

test('contained and identical follow-ups retain their origin, field aliases and follow-up question', () => {
  for (const identical of [false, true]) {
    const follow = '지금은 안전해요.';
    const base = identical ? follow : `그는 “${follow}”라는 말은 사실이 아니라고 했어요.`;
    const ctx = context(base), question = '앞선 보고를 정정한 현재 상태인가요?';
    ctx.patient.fields.risk.followUp = { question, answer:{ rawText:follow, text:follow, custom:'' } };
    const components = answerComponents(ctx.patient.fields.risk);
    assert.equal(components.length, 2);
    assert.deepEqual(components.map(row => row.origin), ['answer_snapshot', 'follow_up']);
    assert.deepEqual(components.map(row => row.fields), [['rawText', 'text'], ['rawText', 'text']]);
    assert.equal(components[1].question, question);
    assert.equal(components[1].text, follow);
    assert.deepEqual(agentContext(ctx).patient.find(row => row.question_id === 'risk').answers, components);
    const documents = sourceDocuments(ctx).filter(row => row.question_id === 'risk');
    assert.equal(documents.length, 2);
    assert.equal(new Set(documents.map(row => row.source_id)).size, 2);
    assert.equal(documents.find(row => row.origin === 'follow_up').question, question);
    const id = source(ctx).id;
    const result = hydrate(ctx, selection([id]));
    assert.ok(result.safety.evidence.some(ref => ref.quote === follow));
    const withoutFollowUp = structuredClone(ctx); delete withoutFollowUp.patient.fields.risk.followUp;
    assert.notEqual(source(withoutFollowUp).id, id);
    rejected(() => hydrate(withoutFollowUp, selection([id])));
    const changedQuestion = structuredClone(ctx); changedQuestion.patient.fields.risk.followUp.question += ' 다시 확인해 주세요.';
    assert.notEqual(source(changedQuestion).id, id);
  }
});

test('source IDs are reproducible but change with current content, actor, question or source provenance', () => {
  const ctx = context('현재 답변 원문이에요.'), id = source(ctx).id;
  assert.equal(source(structuredClone(ctx)).id, id);
  const corrected = structuredClone(ctx); corrected.patient.fields.risk = field('risk', '정정된 현재 답변이에요.');
  rejected(() => hydrate(corrected, selection([id])));
  const otherActor = structuredClone(ctx);
  otherActor.supporter.fields.risk = otherActor.patient.fields.risk;
  delete otherActor.patient.fields.risk;
  assert.notEqual(source(otherActor, 'supporter').id, id);
  rejected(() => hydrate(otherActor, selection([id])));
  const otherQuestion = structuredClone(ctx);
  otherQuestion.patient.fields.changed = { ...otherQuestion.patient.fields.risk, id:'changed' };
  delete otherQuestion.patient.fields.risk;
  rejected(() => hydrate(otherQuestion, selection([id])));
  const sameWordsNewOrigin = structuredClone(ctx);
  sameWordsNewOrigin.patient.fields.risk.followUp = { answer:{ text:ctx.patient.fields.risk.text } };
  rejected(() => hydrate(sameWordsNewOrigin, selection([id])));
});

test('unknown, refused, skipped, unasked and unretrieved IDs cannot become safety evidence', () => {
  const original = context('현재 확인된 답변이에요.'), id = source(original).id;
  for (const status of ['unknown', 'refused', 'skipped', 'auto_skipped', 'not_asked']) {
    const ctx = structuredClone(original); ctx.patient.fields.risk.status = status;
    assert.equal(source(ctx), undefined);
    rejected(() => hydrate(ctx, selection([id])));
  }
  const ctx = context('현재 위험은 없어요.');
  for (let index = 0; index < 30; index++) ctx.patient.fields[`noise${index}`] = field(`noise${index}`, `zz${index}qq`);
  ctx.patient.fields.unretrieved = field('unretrieved', 'zzopaqueqq');
  const unseen = source(ctx, 'patient', 'unretrieved'), retrieval = retrieveSources(ctx);
  assert.equal(retrieval.documents.some(row => row.question_id === 'unretrieved'), false);
  rejected(() => hydrate(ctx, selection([unseen.id]), retrieval));
});

test('forged IDs, duplicate IDs, quote-shaped legacy output and mixed wire formats fail before hydration', () => {
  const ctx = context('현재 위험은 없어요.'), id = source(ctx).id;
  rejected(() => hydrate(ctx, selection(['safety_' + '0'.repeat(24)])));
  rejected(() => hydrate(ctx, selection([id, id])), 'agent_safety_source');
  const quote = { subject:'patient', question_id:'risk', quote:ctx.patient.fields.risk.rawText };
  const legacy = selection([id]); legacy.safety = { urgent:false, evidence:[quote] };
  rejected(() => hydrate(ctx, legacy));
  const mixed = selection([id]); mixed.safety.evidence = [quote];
  rejected(() => hydrate(ctx, mixed));
  rejected(() => hydrate(ctx, selection([{ id, subject:'supporter' }])));
  rejected(() => hydrate(ctx, selection([], true)), 'agent_safety_evidence');
});

test('hydration rejects missing follow-up provenance even when its text remains in another retrieved component', () => {
  const follow = '지금은 안전해요.';
  for (const base of ['어제 자해 이야기를 들었어요.', `“${follow}”라는 말은 과거 이야기였어요.`, follow]) {
    const ctx = context(base);
    ctx.patient.fields.risk.followUp = { answer:{ text:follow } };
    const retrieval = retrieveSources(ctx);
    retrieval.documents = retrieval.documents.filter(row => row.origin !== 'follow_up');
    rejected(() => hydrate(ctx, selection([source(ctx).id]), retrieval), 'agent_retrieval_evidence');
  }
});

const memory = () => ({ summary:'사용자가 보고한 호칭입니다.', facts:[{ subject:'patient', question_id:'name',
  quote:'지민', interpretation:'사용자가 보고한 호칭입니다.', certainty:'reported' }], unknowns:[], user_goal:'확인되지 않음' });
const plan = () => ({ voice:'친구에게 차분히 말하기', opening_evidence:[], user_intent:'상황을 이해하기',
  patient_choice:'말하고 싶은 범위 선택', supporter_care:['자신의 여유 확인'], avoid_patterns:['재촉하지 않기'], next_step:'편한 시간 확인' });
const guide = () => ({ guide:{ top:'통합', script:'지민아, 지금 이야기해도 괜찮을까? 네 이야기를 듣고 싶어.',
  doList:['편한 시간을 물어보세요.'], avoid:['답을 재촉하지 마세요.'], next:'다음 대화 시간을 함께 정해 보세요.',
  care:{ feel:'걱정하는 마음도 살펴보세요.', tips:['자신의 여유를 확인하세요.'] } }, assessment:{ safety:false } });
const issue = { field:'relationship_analysis', reason:'현재 원문을 다시 확인해 주세요.', repair:'근거를 다시 선택해 주세요.' };
const analysisStages = new Set(['relationship_analysis', 'analysis_repair', 'analysis_repair_after_guide_review']);

function pipeline(ctx, { repairAt, attackStage, attack = value => { value.safety.evidence_ids = ['safety_' + '0'.repeat(24)]; } } = {}) {
  const requests = [], selected = selection([source(ctx).id]);
  const model = new ModelGateway({ baseUrl:'https://synthetic.invalid/v1', apiKey:'synthetic-key', model:'synthetic-model',
    protocol:'relationship_agent', diagnosticLogger:null, fetchImpl:async (_url, request) => {
      const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content), { stage, data } = input;
      requests.push({ stage, data, schema:body.response_format.json_schema.schema, maxTokens:body.max_tokens });
      let result;
      if (analysisStages.has(stage)) {
        result = structuredClone(selected);
        if (stage === attackStage) attack(result);
      } else if(stage.startsWith('card_')) {
        const key=Object.keys(input.output_schema.properties)[0];result={[key]:guide().guide[key]};
      } else if(/^speech_(opening|listening|offer)/u.test(stage)) result=Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'원문을 확인하며 이야기를 듣고 싶어.']));
      else if(stage.startsWith('speech_write')) result={script:guide().guide.script};
      else if(stage.startsWith('speech_detail')&&!stage.startsWith('speech_detail_review')) {
        const text=data.script,n=Math.floor(text.length/3);
        result=Object.fromEntries(['opening','listening','offer'].map((key,index)=>[key,{excerpt:text.slice(index*n,index===2?undefined:(index+1)*n),
          why:'보고한 호칭으로 대화를 시작하는 제안이에요.',evidence:[{subject:'patient',question_id:'name',quote:'지민'}]}]));
      } else if (stage === 'analysis_review' && repairAt === 'early') result = { approved:false, issues:[issue] };
      else if (stage === 'guide_review' && repairAt === 'late') result = { approved:false, issues:[issue] };
      else if (stage.includes('review')) result = { approved:true, issues:[] };
      else if (stage.startsWith('communication_plan')) result = plan();
      else if (stage.startsWith('guide_write')) result = guide();
      else if (stage.startsWith('guide_quality')) result = { improvements:[] };
      else throw new Error(`unexpected_test_stage:${stage}`);
      if(input.output_schema.properties.audits)result.audits=data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'현재 원문 전체에 근거해요.'}));
      return new Response(JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content:JSON.stringify(result) } }] }));
    } });
  return { requests, run:() => model.respond(ctx, memory()) };
}

test('the complete pipeline and both analysis repair paths receive short selections and review hydrated long originals', async () => {
  const text = longText('장문');
  for (const repairAt of [undefined, 'early', 'late']) {
    const ctx = context(text), follow = '앞선 말은 제삼자의 과거 이야기였고 현재는 안전해요.';
    ctx.patient.fields.risk.followUp = { question:'현재 누구의 상태인가요?', answer:{ text:follow } };
    const { requests, run } = pipeline(ctx, { repairAt });
    const result = await run();
    assert.deepEqual(result.relationship_analysis.safety.evidence.map(ref => ref.quote), [text, follow]);
    assert.equal(result.agent.reviewed, true);
    for (const request of requests.filter(row => analysisStages.has(row.stage))) {
      assert.equal(request.maxTokens, 2400);
      assert.deepEqual(request.schema.properties.safety.required, ['urgent', 'evidence_ids']);
      assert.equal(Object.hasOwn(request.schema.properties.safety.properties, 'evidence'), false);
    }
    for (const request of requests.filter(row => row.data.analysis)) {
      assert.deepEqual(request.data.analysis.safety.evidence.map(ref => ref.quote), [text, follow]);
    }
    assert.ok(requests.some(row => row.stage === 'guide_review'));
    if (repairAt) assert.ok(requests.some(row => row.stage === (repairAt === 'early' ? 'analysis_repair' : 'analysis_repair_after_guide_review')));
  }
});

test('invalid selections cannot cross the initial, early repair or late repair pipeline boundaries', async () => {
  for (const [attackStage, repairAt, blockedStage] of [
    ['relationship_analysis', undefined, 'analysis_review'],
    ['analysis_repair', 'early', 'analysis_review_after_repair'],
    ['analysis_repair_after_guide_review', 'late', 'analysis_review_after_guide_review_repair'],
  ]) {
    const ctx = context('현재는 위험이 없다고 확인했어요.');
    const { requests, run } = pipeline(ctx, { repairAt, attackStage });
    await assert.rejects(run(), { code:'MODEL_INVALID_RESPONSE', modelReason:'agent_schema' });
    assert.ok(requests.some(row => row.stage === attackStage));
    assert.equal(requests.some(row => row.stage === blockedStage), false);
    if (repairAt === 'late') assert.equal(requests.some(row => row.stage === 'communication_plan_after_analysis_repair'), false);
  }
});

test('a quote-shaped legacy response cannot bypass selection validation during a late repair', async () => {
  const ctx = context('앞선 이야기는 현재 위험에 대한 보고가 아니에요.');
  const { requests, run } = pipeline(ctx, { repairAt:'late', attackStage:'analysis_repair_after_guide_review', attack:value => {
    value.safety = { urgent:false, evidence:[{ subject:'patient', question_id:'risk', quote:ctx.patient.fields.risk.rawText }] };
  } });
  await assert.rejects(run(), { code:'MODEL_INVALID_RESPONSE', modelReason:'agent_schema' });
  assert.equal(requests.some(row => row.stage === 'analysis_review_after_guide_review_repair'), false);
});
