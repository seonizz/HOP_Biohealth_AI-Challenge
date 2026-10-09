import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { modelResponseFormat, evidenceQuotes, riskEvidenceQuotes } from '../src/model-schema.js';
import { trainedContext } from '../src/model-context.js';
import { questions, optLabel, optMeta } from '../src/catalog.js';
import { validateAgentResult, validatePatientState, validateStateResult, validateNameIndex, validateQuestionPlan } from '../src/agent-state.js';

const field = (id, text, extra = {}) => ({ id, question: `${id} 질문`, status: 'answered', source: 'app_user_report', rawText: text, text, custom: '', ...extra });
const context = () => ({
  schema_version: '1.0',
  patient: { alias: '김민지', fields: { name: field('name', '동생 이름은 김민지예요'), mood: field('mood', '밤마다 잠들기 어렵대요'), dur: field('dur', '잘 모르겠어요', { status: 'unknown' }) } },
  supporter: { role: 'informant', fields: { feeling: field('feeling', '저도 지치고 걱정돼요') } },
  user_goal: { message: field('want', '내가 네 편이라는 말을 하고 싶어요'), desired_outcomes: field('goal', '가볍게 대화하기') },
  answered_count: 5,
  question_candidates: [
    { id: 'freq', question: '얼마나 자주 그러나요?', subject: 'patient', required: false, noSkip: false },
    { id: 'describe', question: '어떤 모습을 보았나요?', subject: 'patient', required: true, noSkip: true },
    { id: 'mysupport', question: '내가 받는 도움이 있나요?', subject: 'supporter', required: false, noSkip: false },
  ],
  payload: { answers: [{ selected: [{ meta: { d: 2 } }] }] },
  log: [{ who: 'me', text: '중복 대화 원문' }],
});
const patientState = () => ({
  summary: '이용자는 동생의 수면 어려움을 전해 들었고 본인도 지치고 걱정된다고 보고했습니다.',
  facts: [
    { subject: 'patient', question_id: 'mood', quote: '잠들기 어렵대요', interpretation: '사용자가 전해 들은 수면 어려움입니다.', certainty: 'reported' },
    { subject: 'supporter', question_id: 'feeling', quote: '저도 지치고 걱정돼요', interpretation: '정보 제공자 자신의 감정입니다.', certainty: 'reported' },
  ],
  unknowns: ['상태가 시작된 시점은 확인되지 않았습니다.'],
  user_goal: '내가 네 편이라는 말을 하고 싶어요',
});
const nameIndex = () => ({ alias: '김민지', source_question_id: 'name', quote: '김민지' });
const stateResult = () => ({ patient_state: patientState(), name_index: nameIndex(), question_plan: { skip: [] } });
const skip = (questionId = 'freq', extra = {}) => ({ question_id: questionId, reason: 'already_covered', explanation: '현재 답변에서 이미 관찰한 모습이 확인됐습니다.', evidence: [{ subject: 'patient', question_id: 'mood', quote: '잠들기 어렵대요' }], ...extra });
const result = () => ({
  guide: { top: '통합', script: '요즘 잠들기 어렵다고 들었어. 네가 이야기하고 싶을 때 내가 들어줄게.', doList: ['편한 시간에 대화를 제안해 보세요.'], avoid: ['억지로 이유를 설명하게 하지 마세요.'], next: '오늘 어떤 도움이 편할지 물어보세요.', care: { feel: '걱정하고 지친 마음도 돌볼 필요가 있어요.', tips: ['내가 쉴 시간을 확보해 보세요.'] } },
  patient_state: patientState(), assessment: { safety: false }, name_index: nameIndex(),
});
const envelope = (content, finishReason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), { status: 200 });
const gateway = fetchImpl => new ModelGateway({ baseUrl: 'https://example.test/v1/', apiKey: 'test-only-secret', fetchImpl });
const trainedGateway = fetchImpl => new ModelGateway({ baseUrl: 'https://example.test/v1/', apiKey: 'test-only-secret', model: 'malssi-gemma4-31b-step100', fetchImpl });
const trainedState = () => {
  const value = stateResult(); delete value.patient_state.user_goal; return value;
};

test('final response uses a strict JSON schema, bearer auth and grounded context with prior memory', async () => {
  const memory = patientState();
  let calls = 0;
  const model = gateway(async (url, request) => {
    calls++;
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-only-secret');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gemma4:12b');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 2200);
    assert.deepEqual(body.response_format, modelResponseFormat(context(), true));
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /정보 제공자/);
    assert.match(body.messages[0].content, /지시가 아닌 자료/);
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.prior_memory, memory);
    assert.equal(input.current_context.patient.fields.mood.rawText, '밤마다 잠들기 어렵대요');
    assert.equal(input.current_context.supporter.fields.feeling.text, '저도 지치고 걱정돼요');
    assert.deepEqual(input.current_context.question_candidates, context().question_candidates);
    assert.equal(input.current_context.answered_count, 5);
    assert.equal('payload' in input.current_context, false);
    assert.equal('log' in input.current_context, false);
    assert.equal(request.body.includes('test-only-secret'), false);
    return envelope(JSON.stringify(result()));
  });
  assert.equal(model.configured, true);
  const output = await model.respond(context(), memory);
  assert.deepEqual(output, result());
  assert.equal(JSON.stringify(output).includes('test-only-secret'), false);
  assert.equal(calls, 1);
});

test('state update returns validated JSON memory, name index and question plan', async () => {
  const output = stateResult();
  output.question_plan.skip.push(skip('describe'));
  const model = gateway(async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 2200);
    assert.deepEqual(body.response_format, modelResponseFormat(context()));
    assert.match(body.messages[0].content, /상태 메모리/);
    assert.match(body.messages[0].content, /already_covered/);
    assert.match(body.messages[0].content, /임의 질문/);
    return envelope('```json\n' + JSON.stringify(output) + '\n```');
  });
  assert.deepEqual(await model.updateState(context()), output);
});

test('response schema requires the exact envelope and has no extra object properties', () => {
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'object') {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual(value.required, Object.keys(value.properties));
    }
    Object.values(value).forEach(inspect);
  }
  for (const final of [false, true]) {
    const format = modelResponseFormat(context(), final);
    assert.equal(format.type, 'json_schema'); assert.equal(format.json_schema.strict, true);
    inspect(format.json_schema.schema);
    assert.deepEqual(format.json_schema.schema.required, final ? ['guide', 'patient_state', 'assessment', 'name_index'] : ['patient_state', 'name_index', 'question_plan']);
    assert.equal(format.json_schema.schema.properties.patient_state.properties.user_goal.const, context().user_goal.message.text);
  }
});

test('fact schema only permits current answered or unknown question IDs for the matching person', () => {
  const ctx = context();
  ctx.patient.fields.hidden = field('hidden', '이전 내용', { status: 'auto_skipped' });
  ctx.supporter.fields.unasked = field('unasked', '사용 불가 내용', { status: 'not_asked' });
  const facts = modelResponseFormat(ctx).json_schema.schema.properties.patient_state.properties.facts;
  assert.equal(facts.minItems, 1); assert.equal(facts.maxItems, 8);
  assert.deepEqual(facts.items.anyOf.map(schema => ({ subject: schema.properties.subject.const, id: schema.properties.question_id.const, certainty: schema.properties.certainty })), [
    { subject: 'patient', id: 'name', certainty: { type: 'string', enum: ['reported', 'unknown'] } },
    { subject: 'patient', id: 'mood', certainty: { type: 'string', enum: ['reported', 'unknown'] } },
    { subject: 'patient', id: 'dur', certainty: { type: 'string', const: 'unknown' } },
    { subject: 'supporter', id: 'feeling', certainty: { type: 'string', enum: ['reported', 'unknown'] } },
  ]);
  const empty = modelResponseFormat({}).json_schema.schema.properties;
  assert.equal(empty.patient_state.properties.facts.maxItems, 0);
  assert.equal(empty.patient_state.properties.user_goal.const, '확인되지 않음');
  assert.equal(empty.question_plan.properties.skip.maxItems, 0);
});

test('fact and skip evidence schemas bind exact quote enums to each source question', () => {
  const ctx = context();
  ctx.patient.fields.mood.selected = [{ label: '잠들기 어렵대요' }, { label: '존재하지 않는 보기' }];
  ctx.patient.fields.mood.followUp = { answer: { rawText: '새벽 세 시까지 깨어 있어요', text: '새벽 세 시까지 깨어 있어요', custom: '' } };
  const schema = modelResponseFormat(ctx).json_schema.schema.properties;
  const mood = schema.patient_state.properties.facts.items.anyOf.find(item => item.properties.question_id.const === 'mood');
  assert.deepEqual(mood.properties.quote.enum, ['밤마다 잠들기 어렵대요', '새벽 세 시까지 깨어 있어요', '잠들기 어렵대요']);
  assert.equal(mood.properties.quote.enum.includes(ctx.supporter.fields.feeling.text), false);
  assert.equal(mood.properties.quote.enum.includes(ctx.patient.fields.name.text), false);
  assert.equal(mood.properties.quote.enum.includes('존재하지 않는 보기'), false);
  assert.equal(mood.properties.quote.enum.includes('수면에 어려움이 있습니다'), false);
  for (const variant of schema.question_plan.properties.skip.items.anyOf) {
    for (const evidence of variant.properties.evidence.items.anyOf) {
      assert.equal(evidence.properties.question_id.type, 'string');
      assert.equal(typeof evidence.properties.question_id.const, 'string');
      assert.ok(evidence.properties.quote.enum.length > 0);
      if (evidence.properties.question_id.const === 'mood') assert.deepEqual(evidence.properties.quote.enum, mood.properties.quote.enum);
    }
  }
});

test('long source quote enums contain only bounded original excerpts with no ellipsis or paraphrase', () => {
  const ctx = context();
  const original = Array.from({ length: 20 }, (_, i) => `보고 문장 ${i}번에서 직접 관찰한 내용이에요. `).join('') + '😀'.repeat(90);
  ctx.patient.fields.mood = field('mood', original, { custom: '원문에 있는 추가 관찰이에요' });
  const mood = modelResponseFormat(ctx).json_schema.schema.properties.patient_state.properties.facts.items.anyOf
    .find(item => item.properties.question_id.const === 'mood');
  assert.ok(mood.properties.quote.enum.length > 1 && mood.properties.quote.enum.length <= 8);
  assert.equal(mood.properties.quote.enum.includes(original), false);
  assert.ok(mood.properties.quote.enum.includes(ctx.patient.fields.mood.custom));
  for (const quote of mood.properties.quote.enum) {
    assert.ok(quote.length <= 160 && quote.trim());
    assert.ok(original.includes(quote) || ctx.patient.fields.mood.custom.includes(quote));
    assert.equal(quote.includes('…'), false);
    assert.equal(quote.isWellFormed(), true);
  }
  ctx.patient.fields.mood = field('mood', '가' + '😀'.repeat(90));
  const emojiQuotes = modelResponseFormat(ctx).json_schema.schema.properties.patient_state.properties.facts.items.anyOf
    .find(item => item.properties.question_id.const === 'mood').properties.quote.enum;
  assert.ok(emojiQuotes.length > 1);
  assert.ok(emojiQuotes.every(quote => quote.length <= 160 && quote.isWellFormed() && ctx.patient.fields.mood.rawText.includes(quote)));
});

test('question schema limits candidate IDs, optional skip reasons and evidence subjects', () => {
  const ctx = context();
  ctx.question_candidates.push({ id: 'cause', subject: 'patient', required: false, noSkip: false });
  const plan = modelResponseFormat(ctx).json_schema.schema.properties.question_plan.properties.skip;
  assert.equal(plan.maxItems, 8);
  const variants = plan.items.anyOf;
  assert.deepEqual(variants.map(schema => ({ ids: schema.properties.question_id.enum, reason: schema.properties.reason.const })), [
    { ids: ['freq', 'describe'], reason: 'already_covered' }, { ids: ['freq'], reason: 'not_needed' },
    { ids: ['mysupport'], reason: 'already_covered' }, { ids: ['mysupport'], reason: 'not_needed' },
  ]);
  for (const schema of variants.filter(schema => schema.properties.question_id.enum.includes('mysupport'))) {
    assert.ok(schema.properties.evidence.items.anyOf.every(evidence => evidence.properties.subject.const === 'supporter'));
  }
  ctx.answered_count = 4;
  assert.ok(modelResponseFormat(ctx).json_schema.schema.properties.question_plan.properties.skip.items.anyOf.every(schema => schema.properties.reason.const === 'already_covered'));
});

test('name schema fixes bare aliases while longer name answers remain a grounded extraction', () => {
  const ctx = context(); ctx.patient.fields.name = field('name', '민지');
  let schema = modelResponseFormat(ctx).json_schema.schema.properties.name_index;
  assert.deepEqual(schema.anyOf[1].properties.alias.enum, ['민지']);
  assert.equal(schema.anyOf[1].properties.source_question_id.const, 'name');
  ctx.patient.fields.name = field('name', '친구 이름은 민지예요');
  schema = modelResponseFormat(ctx).json_schema.schema.properties.name_index;
  assert.equal(schema.anyOf[1].properties.alias.maxLength, 20);
  assert.equal('enum' in schema.anyOf[1].properties.alias, false);
  ctx.patient.fields.name.status = 'unknown';
  assert.deepEqual(modelResponseFormat(ctx).json_schema.schema.properties.name_index, { type: 'null' });
});

test('canonical name fallbacks cannot become model identity evidence', () => {
  const ctx = context();
  ctx.patient.fields.name = field('name', '그분', { rawText: '글쎄', followUp: { answer: { rawText: '없어', text: '그분', custom: '' } } });
  assert.throws(() => validateNameIndex({ alias: '그분', source_question_id: 'name', quote: '그분' }, ctx), { code: 'MODEL_INVALID_RESPONSE' });
  const schema = modelResponseFormat(ctx).json_schema.schema.properties.name_index;
  assert.equal('enum' in schema.anyOf[1].properties.alias, false);
  ctx.patient.fields.name.followUp.answer = { rawText: '민지라고 불러', text: '그분', custom: '' };
  assert.doesNotThrow(() => validateNameIndex({ alias: '민지', source_question_id: 'name', quote: '민지라고' }, ctx));
  ctx.patient.fields.name.rawText = ''; ctx.patient.fields.name.followUp.answer = { rawText: '', text: '그분', custom: '' };
  assert.deepEqual(modelResponseFormat(ctx).json_schema.schema.properties.name_index, { type: 'null' });
});

test('unasked and automatically skipped model context fields omit repeated questions and answers', async () => {
  const ctx = context();
  ctx.patient.fields.freq = field('freq', '아직 확인하지 않은 내용', { status: 'not_asked' });
  ctx.patient.fields.hidden = field('hidden', '자동 건너뛴 이전 내용', { status: 'auto_skipped' });
  const model = gateway(async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content).current_context;
    assert.deepEqual(input.patient.fields.freq, { id: 'freq', status: 'not_asked' });
    assert.deepEqual(input.patient.fields.hidden, { id: 'hidden', status: 'auto_skipped' });
    assert.equal(input.patient.fields.mood.question, 'mood 질문');
    assert.equal(input.patient.fields.mood.rawText, ctx.patient.fields.mood.rawText);
    return envelope(JSON.stringify(stateResult()));
  });
  assert.deepEqual(await model.updateState(ctx), stateResult());
});

test('name index only extracts a supplied alias from the current name answer', () => {
  assert.deepEqual(validateNameIndex(nameIndex(), context()), nameIndex());
  assert.equal(validateNameIndex(null, context()), null);
  const withFollowUp = context();
  withFollowUp.patient.fields.name.followUp = { answer: { rawText: '별명은 민지예요' } };
  assert.doesNotThrow(() => validateNameIndex({ alias: '민지', source_question_id: 'name', quote: '별명은 민지' }, withFollowUp));
  for (const change of [
    value => { value.alias = '새 이름'; },
    value => { value.alias = '김민지\n'; },
    value => { value.alias = '김민지\u0000'; },
    value => { value.alias = ' 김민지'; },
    value => { value.alias = '이'.repeat(21); },
    value => { value.source_question_id = 'mood'; },
    value => { value.quote = '존재하지 않는 근거'; },
    value => { value.quote = '동생 이름'; },
    value => { value.gender = '여성'; },
  ]) {
    const value = nameIndex(); change(value);
    assert.throws(() => validateNameIndex(value, context()), { code: 'MODEL_INVALID_RESPONSE' });
  }
  for (const status of ['unknown', 'not_asked', 'skipped', 'auto_skipped']) {
    const ctx = context(); ctx.patient.fields.name.status = status;
    assert.throws(() => validateNameIndex(nameIndex(), ctx), { code: 'MODEL_INVALID_RESPONSE' });
    assert.equal(validateNameIndex(null, ctx), null);
  }
});

test('covered questions require a candidate and grounded evidence for the same person', () => {
  assert.doesNotThrow(() => validateQuestionPlan({ skip: [skip('describe')] }, context()));
  const supported = skip('mysupport', { evidence: [{ subject: 'supporter', question_id: 'feeling', quote: '지치고 걱정돼요' }] });
  assert.doesNotThrow(() => validateQuestionPlan({ skip: [supported] }, context()));
  for (const value of [
    skip('unknown_id'), skip('name'), skip('want'),
    skip('mysupport'),
    skip('freq', { evidence: [{ subject: 'supporter', question_id: 'feeling', quote: '걱정돼요' }] }),
    skip('freq', { evidence: [{ subject: 'patient', question_id: 'mood', quote: '새 근거' }] }),
    skip('freq', { evidence: [] }),
    skip('freq', { reason: 'new_question' }),
  ]) assert.throws(() => validateQuestionPlan({ skip: [value] }, context()), { code: 'MODEL_INVALID_RESPONSE' });
  assert.throws(() => validateQuestionPlan({ skip: [skip(), skip()] }, context()), { code: 'MODEL_INVALID_RESPONSE' });
  const answered = context(); answered.patient.fields.freq = field('freq', '매일');
  assert.throws(() => validateQuestionPlan({ skip: [skip()] }, answered), { code: 'MODEL_INVALID_RESPONSE' });
  answered.patient.fields.freq.status = 'auto_skipped';
  assert.throws(() => validateQuestionPlan({ skip: [skip()] }, answered), { code: 'MODEL_INVALID_RESPONSE' });
  for (const id of ['name', 'want', 'cause']) {
    const ctx = context(); ctx.question_candidates.push({ id, subject: 'patient', required: false, noSkip: false });
    assert.throws(() => validateQuestionPlan({ skip: [skip(id)] }, ctx), { code: 'MODEL_INVALID_RESPONSE' });
  }
});

test('not-needed skips require five answers and an optional question', () => {
  const plan = { skip: [skip('freq', { reason: 'not_needed' })] };
  assert.doesNotThrow(() => validateQuestionPlan(plan, context()));
  const early = context(); early.answered_count = 4;
  assert.throws(() => validateQuestionPlan(plan, early), { code: 'MODEL_INVALID_RESPONSE' });
  assert.throws(() => validateQuestionPlan({ skip: [skip('describe', { reason: 'not_needed' })] }, context()), { code: 'MODEL_INVALID_RESPONSE' });
  const noSkip = context(); noSkip.question_candidates[0].noSkip = true;
  assert.throws(() => validateQuestionPlan(plan, noSkip), { code: 'MODEL_INVALID_RESPONSE' });
  noSkip.question_candidates[0].noSkip = false; noSkip.question_candidates[0].required = true;
  assert.throws(() => validateQuestionPlan(plan, noSkip), { code: 'MODEL_INVALID_RESPONSE' });
});

test('unknown answers cannot cover a question and absent or skipped evidence is rejected', () => {
  const unknown = skip('freq', { evidence: [{ subject: 'patient', question_id: 'dur', quote: '잘 모르겠어요' }] });
  assert.throws(() => validateQuestionPlan({ skip: [unknown] }, context()), { code: 'MODEL_INVALID_RESPONSE' });
  unknown.reason = 'not_needed';
  assert.doesNotThrow(() => validateQuestionPlan({ skip: [unknown] }, context()));
  for (const status of ['not_asked', 'skipped', 'auto_skipped']) {
    const ctx = context(); ctx.patient.fields.mood.status = status;
    assert.throws(() => validateQuestionPlan({ skip: [skip()] }, ctx), { code: 'MODEL_INVALID_RESPONSE' });
  }
});

test('user-goal evidence is read from the goal fields and does not become supporter evidence', () => {
  const goalEvidence = [{ subject: 'user_goal', question_id: 'want', quote: '네 편이라는 말' }];
  assert.doesNotThrow(() => validateQuestionPlan({ skip: [skip('freq', { evidence: goalEvidence })] }, context()));
  assert.throws(() => validateQuestionPlan({ skip: [skip('mysupport', { evidence: goalEvidence })] }, context()), { code: 'MODEL_INVALID_RESPONSE' });
  const ctx = context(); ctx.user_goal.desired_outcomes.status = 'not_asked';
  ctx.question_candidates.push({ id: 'goal', question: '원하는 대화는?', subject: 'user_goal', required: true, noSkip: true });
  assert.doesNotThrow(() => validateQuestionPlan({ skip: [skip('goal', { evidence: goalEvidence })] }, ctx));
  assert.throws(() => validateQuestionPlan({ skip: [skip('goal')] }, ctx), { code: 'MODEL_INVALID_RESPONSE' });
});

test('new JSON envelope rejects missing fields and excessive skip items', () => {
  const old = { patient_state: patientState() };
  assert.throws(() => validateStateResult(old, context()), { code: 'MODEL_INVALID_RESPONSE' });
  const extra = stateResult(); extra.explanation = '추가 출력';
  assert.throws(() => validateStateResult(extra, context()), { code: 'MODEL_INVALID_RESPONSE' });
  const ctx = context();
  ctx.question_candidates = Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, subject: 'patient', required: false, noSkip: false }));
  assert.throws(() => validateQuestionPlan({ skip: ctx.question_candidates.map(q => skip(q.id)) }, ctx), { code: 'MODEL_INVALID_RESPONSE' });
  const final = result(); final.question_plan = { skip: [] };
  assert.throws(() => validateAgentResult(final, context()), { code: 'MODEL_INVALID_RESPONSE' });
});

test('partial early context retains unknown goal and does not invent missing evidence', () => {
  const early = { patient: { fields: {} }, supporter: { fields: {} }, user_goal: {} };
  const state = { summary: '아직 관찰된 상태를 보고받지 않았습니다.', facts: [], unknowns: ['환자의 상태'], user_goal: '확인되지 않음' };
  assert.deepEqual(validatePatientState(state, early), state);
  assert.throws(() => validatePatientState(state, context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
});

test('grounding rejects invented quotes, wrong person, absent/skipped field and an altered user goal', () => {
  for (const mutate of [
    value => { value.patient_state.facts[0].quote = '확인되지 않은 발작'; },
    value => { value.patient_state.facts[1].subject = 'patient'; },
    value => { value.patient_state.facts[0].question_id = 'unknown_question'; },
    value => { value.patient_state.user_goal = '임의로 바꾼 목표'; },
    value => { value.patient_state.facts[0].scores = { 우울: 3 }; },
  ]) {
    const value = result(); mutate(value);
    assert.throws(() => validateAgentResult(value, context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
  }
  const skipped = context(); skipped.patient.fields.mood.status = 'skipped';
  assert.throws(() => validateAgentResult(result(), skipped), { code: 'MODEL_INVALID_RESPONSE' });
});

test('follow-up and custom input are valid sources while unknown is never promoted to reported', () => {
  const ctx = context();
  ctx.patient.fields.mood.followUp = { answer: { rawText: '새벽 세 시까지 깨어 있어요' } };
  ctx.supporter.fields.feeling.custom = '산책하면 조금 나아요';
  const value = result();
  value.patient_state.facts[0].quote = '새벽 세 시까지';
  value.patient_state.facts[1].quote = '산책하면 조금 나아요';
  value.patient_state.facts.push({ subject: 'patient', question_id: 'dur', quote: '잘 모르겠어요', interpretation: '시점을 모른다는 사용자 보고입니다.', certainty: 'unknown' });
  assert.doesNotThrow(() => validateAgentResult(value, ctx));
  value.patient_state.facts.at(-1).certainty = 'reported';
  assert.throws(() => validateAgentResult(value, ctx), { code: 'MODEL_INVALID_RESPONSE' });
});

test('guide and assessment schema reject omissions, extra clinical scores and invalid types', () => {
  for (const mutate of [
    value => { value.guide.top = '진단'; },
    value => { value.guide.script = ''; },
    value => { value.guide.doList = []; },
    value => { value.guide.avoid = '문자열'; },
    value => { delete value.guide.care; },
    value => { value.assessment.safety = 'false'; },
    value => { value.assessment.scores = { 우울: 3 }; },
  ]) {
    const value = result(); mutate(value);
    assert.throws(() => validateAgentResult(value, context()), { code: 'MODEL_INVALID_RESPONSE' });
  }
});

test('empty, invalid JSON, mixed prose and truncated output return a safe 502 error', async () => {
  for (const [content, reason] of [['', 'stop'], ['{', 'stop'], ['설명: ' + JSON.stringify(result()), 'stop'], [JSON.stringify(result()), 'length']]) {
    await assert.rejects(gateway(async () => envelope(content, reason)).respond(context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
  }
  await assert.rejects(gateway(async () => new Response('upstream-private-data')).respond(context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
});

test('busy, down and authentication errors do not read or expose upstream error bodies or retry', async () => {
  for (const [status, code] of [[429, 'MODEL_UNAVAILABLE'], [503, 'MODEL_UNAVAILABLE'], [401, 'MODEL_AUTH_FAILED'], [403, 'MODEL_AUTH_FAILED'], [400, 'MODEL_UPSTREAM_ERROR']]) {
    let calls = 0;
    const model = gateway(async () => {
      calls++;
      return { ok: false, status, json: () => { throw new Error('Must not read secret body'); } };
    });
    await assert.rejects(model.respond(context()), error => error.code === code && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
  await assert.rejects(gateway(async () => { throw new Error('private-network-detail'); }).respond(context()), error => error.status === 503 && !error.message.includes('private-network-detail'));
});

test('model timeout aborts the request and reports 504', async () => {
  const model = new ModelGateway({ baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret', timeoutMs: 15,
    fetchImpl: (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(model.updateState(context()), { status: 504, code: 'MODEL_TIMEOUT' });
});

test('missing credentials or malformed configuration fail before fetching', async () => {
  for (const options of [{}, { baseUrl: 'https://example.test/v1', apiKey: '' }, { baseUrl: 'https://user:password@example.test/v1', apiKey: 'key' }, { baseUrl: 'https://example.test/v1', apiKey: 'key', timeoutMs: 0 }]) {
    const model = new ModelGateway({ ...options, fetchImpl: () => { throw new Error('Must not call'); } });
    assert.equal(model.configured, false);
    await assert.rejects(model.respond(context()), { status: 503, code: 'MODEL_NOT_CONFIGURED' });
  }
});

test('trained profile only sends supported request fields and assembles the original goal', async () => {
  const ctx = context(); ctx.user_goal.message = field('want', '전하고 싶은 진심 '.repeat(600));
  const model = trainedGateway(async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'n', 'stream', 'temperature']);
    assert.equal(body.max_tokens, 2048); assert.equal(body.n, 1); assert.equal(body.stream, false);
    assert.equal(body.temperature, 0); assert.equal(body.model, 'malssi-gemma4-31b-step100');
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
    assert.deepEqual(Object.keys(JSON.parse(body.messages[2].content)), ['patient_state', 'name_index', 'question_plan']);
    assert.match(body.messages[0].content, /희망은 실제 지지/);
    assert.match(body.messages[0].content, /일상 기능 저하/);
    assert.equal(request.body.includes('test-only-secret'), false);
    const projected = JSON.parse(body.messages.at(-1).content);
    assert.equal(projected.partial, true); assert.ok(projected.goal.length <= 160);
    assert.equal(request.body.includes(ctx.user_goal.message.text), false);
    return envelope(JSON.stringify(trainedState()));
  });
  assert.equal(model.protocol, 'json_prompt'); assert.equal(model.timeoutMs, 1800000);
  const output = await model.updateState(ctx);
  assert.equal(output.patient_state.user_goal, ctx.user_goal.message.text);
  assert.deepEqual(output.name_index, nameIndex());
});

test('trained final output reuses validated state and name while receiving guide JSON only', async () => {
  const ctx = context(); ctx.name_index = nameIndex();
  let calls = 0;
  const model = trainedGateway(async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 2048);
    const input = JSON.parse(body.messages.at(-1).content);
    assert.ok(input.patient.some(row => row[0] === 'mood'));
    assert.ok(input.supporter.some(row => row[0] === 'feeling'));
    assert.equal(input.memory.summary, patientState().summary);
    assert.equal('candidates' in input, false);
    const { guide, assessment } = result(); return envelope(JSON.stringify({ guide, assessment }));
  });
  assert.deepEqual(await model.respond(ctx, patientState()), result());
  assert.equal(calls, 1);
});

test('trained final builds a validated state first when no usable memory exists', async () => {
  const prompts = [];
  const model = trainedGateway(async (_url, request) => {
    const body = JSON.parse(request.body); prompts.push(body.messages[0].content);
    if (prompts.length === 1) return envelope(JSON.stringify(trainedState()));
    const { guide, assessment } = result(); return envelope(JSON.stringify({ guide, assessment }));
  });
  assert.deepEqual(await model.respond(context()), result());
  assert.match(prompts[0], /상태 에이전트/); assert.match(prompts[1], /대화 지원/);
  assert.equal(prompts.length, 2);
});

test('trained final projection retains core patient and supporter evidence within bounded input', () => {
  const ctx = context();
  const patientIds = ['dur', 'freq', 'describe', 'concern', 'events', 'need'];
  const supporterIds = ['feeling', 'cgchange', 'mycoping'];
  for (const id of patientIds) ctx.patient.fields[id] = field(id, `${id} 원문 관찰 내용 `.repeat(100));
  for (const id of supporterIds) ctx.supporter.fields[id] = field(id, `${id} 이용자 원문 `.repeat(100));
  ctx.log = [{ who: 'me', text: '별도 전체 로그를 넣으면 안 됨' }];
  const normal = trainedContext(ctx, patientState(), { final: true });
  const tight = trainedContext(ctx, patientState(), { final: true, tighter: true });
  assert.ok(JSON.stringify(normal).length <= 3000); assert.ok(JSON.stringify(tight).length <= 1900);
  for (const id of ['name', 'mood', ...patientIds]) assert.ok(normal.patient.some(row => row[0] === id));
  for (const id of supporterIds) assert.ok(normal.supporter.some(row => row[0] === id));
  assert.equal('payload' in normal, false); assert.equal('log' in normal, false);
  for (const subject of ['patient', 'supporter']) for (const row of normal[subject]) {
    const source = ctx[subject].fields[row[0]];
    assert.ok(row[3].every(quote => source.rawText.includes(quote) || source.text.includes(quote)));
  }
});

for (const limit of [4096, 131072]) test(`trained profile retries the ${limit}-token context-budget 400 once with a smaller projection`, async () => {
  const bodies = [];
  const model = trainedGateway(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `Prompt (${limit}) plus max_tokens (2048) exceeds the ${limit}-token context budget; no text was truncated` } }), { status: 400 });
    return envelope(JSON.stringify(trainedState()));
  });
  assert.deepEqual(await model.updateState(context()), stateResult());
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].messages.at(-1).content.length < bodies[0].messages.at(-1).content.length);
  assert.equal(bodies[1].max_tokens, 2048);
});

test('trained retry stops after two budget errors and never retries unsupported fields or malformed output', async () => {
  let calls = 0;
  const model = trainedGateway(async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Prompt (4097) plus max_tokens (2048) exceeds the 4096-token context budget; no text was truncated' } }), { status: 400 });
  });
  await assert.rejects(model.updateState(context()), { code: 'MODEL_CONTEXT_TOO_LONG', status: 502 });
  assert.equal(calls, 2);
  for (const response of [
    () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unsupported request fields: private-detail' } }), { status: 400 }),
    () => envelope('{'), () => envelope(JSON.stringify(trainedState()), 'length'),
  ]) {
    let attempts = 0;
    const one = trainedGateway(async () => { attempts++; return response(); });
    await assert.rejects(one.updateState(context()), error => error.status === 502 && !error.message.includes('private-detail'));
    assert.equal(attempts, 1);
  }
});

test('trained state and final JSON still reject fabricated evidence or extra keys', async () => {
  const forged = trainedState(); forged.patient_state.facts[0].quote = '만든 근거';
  await assert.rejects(trainedGateway(async () => envelope(JSON.stringify(forged))).updateState(context()), { code: 'MODEL_INVALID_RESPONSE' });
  const echoed = trainedState(); echoed.patient_state.user_goal = context().user_goal.message.text;
  await assert.rejects(trainedGateway(async () => envelope(JSON.stringify(echoed))).updateState(context()), { code: 'MODEL_INVALID_RESPONSE' });
  const ctx = context(); ctx.name_index = nameIndex();
  await assert.rejects(trainedGateway(async () => envelope(JSON.stringify(result()))).respond(ctx, patientState()), { code: 'MODEL_INVALID_RESPONSE' });
});

test('explicit json_prompt works and unknown protocols fail before sending a request', async () => {
  const model = new ModelGateway({ baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret', model: 'custom-trained', protocol: 'json_prompt', fetchImpl: async () => envelope(JSON.stringify(trainedState())) });
  assert.deepEqual(await model.updateState(context()), stateResult());
  const invalid = new ModelGateway({ baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret', protocol: 'unknown', fetchImpl: () => { throw new Error('Must not call'); } });
  assert.equal(invalid.configured, false);
  await assert.rejects(invalid.updateState(context()), { code: 'MODEL_NOT_CONFIGURED' });
});

test('actual mood choices 0 through 8 preserve the suicidal choice before the evidence cap and every projection', () => {
  const ctx = context();
  const mood = questions.find(question => question.id === 'mood');
  const selected = mood.opts.slice(0, 9).map(option => ({ label: optLabel(option), meta: { ...optMeta(option) } }));
  const danger = selected.find(option => option.meta.s === 'suicidal').label;
  ctx.patient.fields.mood = field('mood', selected.map(option => option.label).join(', '), { selected });
  assert.equal(evidenceQuotes(ctx.patient.fields.mood)[0], danger);
  const state = patientState();
  state.facts = [{ ...state.facts[0], quote: selected[0].label }];
  assert.doesNotThrow(() => validatePatientState(state, ctx));
  const schemaMood = modelResponseFormat(ctx).json_schema.schema.properties.patient_state.properties.facts.items.anyOf
    .find(value => value.properties.question_id.const === 'mood');
  assert.ok(schemaMood.properties.quote.enum.includes(danger));
  for (const final of [false, true]) for (const tighter of [false, true]) {
    const projected = trainedContext(ctx, state, { final, tighter });
    const row = projected.patient.find(row => row[0] === 'mood');
    assert.ok(row && row[3].includes(danger));
    assert.equal(row[2], 'answered');
  }
});

test('long raw, custom and follow-up danger excerpts keep negation and attribution when context is reduced', () => {
  const ctx = context();
  const phrase = '그분은 죽고 싶지는 않다고 말했어요.';
  const long = '평소의 모습을 전해 들었어요 '.repeat(50) + phrase + ' 일상 이야기입니다'.repeat(50);
  ctx.patient.fields.extra = field('extra', '추가 내용을 물었어요', { custom: long, followUp: { answer: { rawText: long, text: long, custom: '' } } });
  for (let i = 0; i < 20; i++) ctx.patient.fields[`later${i}`] = field(`later${i}`, '그 밖의 일반적인 이야기입니다 '.repeat(100));
  const phraseAtEnd = '보통 이야기 '.repeat(100) + '자해할 생각은 없다고 했어요.';
  ctx.supporter.fields.cgchange_more = field('cgchange_more', phraseAtEnd);
  const state = patientState();
  for (const final of [false, true]) for (const tighter of [false, true]) {
    const projected = trainedContext(ctx, state, { final, tighter });
    const patient = projected.patient.find(row => row[0] === 'extra');
    const supporter = projected.supporter.find(row => row[0] === 'cgchange_more');
    assert.ok(patient?.[3].some(quote => quote.includes(phrase)));
    assert.ok(supporter?.[3].some(quote => quote.includes('자해할 생각은 없다고 했어요.')));
    for (const quote of patient[3]) assert.ok(long.includes(quote));
    for (const quote of supporter[3]) assert.ok(phraseAtEnd.includes(quote));
  }
});

test('risk excerpts preserve unknown status and never read skipped or unasked fields as evidence', () => {
  const ctx = context();
  ctx.patient.fields.extra = field('extra', '자살 생각은 없다고 들었지만 저는 확실히 모르겠어요.', { status: 'unknown' });
  ctx.patient.fields.unasked_risk = field('unasked_risk', '죽고 싶어요', { status: 'not_asked' });
  ctx.supporter.fields.skipped_risk = field('skipped_risk', '자해', { status: 'skipped' });
  const extra = modelResponseFormat(ctx).json_schema.schema.properties.patient_state.properties.facts.items.anyOf
    .find(value => value.properties.question_id.const === 'extra');
  assert.equal(extra.properties.certainty.const, 'unknown');
  for (const final of [false, true]) for (const tighter of [false, true]) {
    const projected = trainedContext(ctx, patientState(), { final, tighter });
    assert.equal(projected.patient.find(row => row[0] === 'extra')?.[2], 'unknown');
    assert.equal(projected.patient.some(row => row[0] === 'unasked_risk'), false);
    assert.equal(projected.supporter.some(row => row[0] === 'skipped_risk'), false);
  }
});

test('a long user-goal report preserves its original danger clause beside the shortened goal', () => {
  const ctx = context();
  const source = '전하고 싶은 마음 '.repeat(100) + '사라지고 싶다는 뜻은 아니라고 말하고 싶어요.';
  ctx.user_goal.message = field('want', source);
  for (const final of [false, true]) for (const tighter of [false, true]) {
    const projected = trainedContext(ctx, null, { final, tighter });
    const row = projected.user_goal.find(row => row[0] === 'want');
    assert.ok(row[3].some(quote => quote.includes('사라지고 싶다는 뜻은 아니라고')));
    assert.ok(row[3].every(quote => source.includes(quote)));
  }
});

test('reported and unknown memory certainty remain distinct in normal and reduced state or final context', () => {
  const ctx = context();
  const reported = patientState(); reported.facts = [reported.facts[0]];
  const unknown = structuredClone(reported); unknown.facts[0].certainty = 'unknown';
  assert.doesNotThrow(() => validatePatientState(reported, ctx));
  assert.doesNotThrow(() => validatePatientState(unknown, ctx));
  for (const final of [false, true]) for (const tighter of [false, true]) {
    const one = trainedContext(ctx, reported, { final, tighter });
    const two = trainedContext(ctx, unknown, { final, tighter });
    assert.equal(one.memory.facts[0][3], 'reported');
    assert.equal(two.memory.facts[0][3], 'unknown');
    assert.notDeepEqual(one, two);
  }
  assert.ok(riskEvidenceQuotes({ rawText: '😀'.repeat(80) + '자해를 하지는 않아요. ' + '😀'.repeat(80) })
    .every(quote => quote.length <= 160 && quote.isWellFormed() && quote.includes('자해를 하지는 않아요.')));
});
