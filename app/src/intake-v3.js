import { isV3BundleId } from './v3-bundles.js';
import { HttpError } from './errors.js';

export const isV3Intake = value => isV3BundleId((value?.questionSet || value)?.bundle_id);
const fail = (code, message, status = 422) => { throw new HttpError(status, code, message); };
const controls = ['answered', 'unknown', 'skipped', 'refused', 'not_understood', 'stop'];
const controlText = { unknown:'잘 모르겠어요', skipped:'(건너뛰었어요)', refused:'이 내용은 답하지 않을게요', not_understood:'질문을 이해하기 어려워요', stop:'여기까지 할게요' };

export function initializeV3(state) {
  state.v3 ||= { issued:{}, input_revision:0, goal_epoch:0, stopped:false, reports:[],
    personalization:{version:1, questions:{}, presentations:{}, answer_order:[], progress:0} };
  return state.v3;
}

export function issueV3(state, question) {
  const progress = initializeV3(state);
  if (!progress.issued[question.id]) {
    if (Object.keys(progress.issued).length >= (progress.personalization?.version === 1 ? 12 : 10)) fail('QUESTION_BUDGET_EXHAUSTED', '안내 질문을 모두 확인했어요.');
    progress.issued[question.id] = { instance_id:`${state.questionSet.bundle_id}:${question.id}:1`, help_displays:0 };
  }
  return progress.issued[question.id];
}

export function normalizeV3Answer(question, input, normalize, hasContent) {
  const event = input.response_event ?? (input.skipped ? 'skipped' : 'answered');
  if (!controls.includes(event)) fail('invalid_answer', '답변 상태를 확인해 주세요.', 400);
  if (event === 'answered') {
    const answer = normalize(question, input);
    const unknown = answer.sel.some(index => question.opts[index]?.[1]?.value === 'unknown');
    return { ...answer, ...(typeof input.text === 'string' && hasContent(input.text) ? { rawText:input.text } : {}),
      response_event:answer.skipped ? 'skipped' : unknown ? 'unknown' : 'answered',
      ...(unknown ? { ordinary_usable:hasContent(answer.custom), selection_status:'unknown' } : {}) };
  }
  const rawText = input.text ?? '', custom = input.custom ?? '', selected = input.selected ?? [];
  if (typeof rawText !== 'string' || typeof custom !== 'string' || rawText.length > 10000 || custom.length > 10000 ||
      !Array.isArray(selected) || selected.length || (input.skipped !== undefined && typeof input.skipped !== 'boolean')) {
    fail('invalid_answer', '답변 내용과 상태를 확인해 주세요.', 400);
  }
  // A control is explicit protocol data. Quoted words in normal text never become controls.
  const content = [rawText, custom].filter(hasContent).filter((value, index, all) => all.indexOf(value) === index).join('\n');
  return { text:content || controlText[event], rawText, custom:hasContent(custom) ? custom : '', sel:[],
    skipped:['skipped','refused','not_understood','stop'].includes(event), response_event:event,
    ordinary_usable:event === 'unknown' && Boolean(content), selection_status:event === 'unknown' ? 'unknown' : undefined };
}

export function stampV3Answer(state, question, answer) {
  const progress = initializeV3(state);
  const revision = ++progress.input_revision;
  return { ...answer, source_revision:revision, source_message_id:`${question.id}:${revision}`,
    source_timestamp:new Date().toISOString(), source_timezone:'Asia/Seoul',
    instance_id:progress.issued[question.id]?.instance_id };
}

export function v3FieldStatus(answer) {
  if (answer.response_event === 'refused') return 'refused';
  if (answer.response_event === 'stop') return 'stopped';
  if (answer.response_event === 'unknown') return answer.ordinary_usable ? 'answered' : 'unknown';
  return answer.skipped ? 'skipped' : 'answered';
}

export function v3ClarificationAvailable(state) {
  return isV3Intake(state) && !state.v3?.stopped && !state.v3?.issued?.q3_10 && !state.safetySignal?.urgent;
}

function sourceForBinding(state, binding) {
  const question = state.questionSet.questions.find(q => q.id === binding.source_question_id) ||
    state.v3?.personalization?.questions?.[binding.source_question_id]?.question;
  const answer = state.ans[binding.source_question_id] || state.clarificationAnswers?.[binding.source_question_id];
  if (!question || !answer || v3FieldStatus(answer) !== 'answered' || answer.response_event === 'unknown' ||
      !Number.isInteger(binding.source_revision) || binding.source_revision < 1 ||
      answer.source_revision !== binding.source_revision || !['rawText','custom'].includes(binding.component)) {
    fail('INVALID_CLARIFICATION', '현재 답변에서 확인할 내용을 찾지 못했어요.');
  }
  const source = answer[binding.component];
  const points = typeof source === 'string' ? Array.from(source) : [];
  if (typeof binding.quote !== 'string' || !binding.quote.trim() || !Number.isInteger(binding.quote_start) ||
      !Number.isInteger(binding.quote_end) || binding.quote_start < 0 || binding.quote_end <= binding.quote_start ||
      binding.quote_end > points.length || points.slice(binding.quote_start, binding.quote_end).join('') !== binding.quote ||
      typeof binding.event_id !== 'string' || !binding.event_id.trim() || binding.event_id.length > 120) {
    fail('INVALID_CLARIFICATION', '확인할 원문과 범위가 일치하지 않아요.');
  }
  return { question, answer };
}

export function createV3Clarification(state, requested) {
  if (!v3ClarificationAvailable(state) || !requested || typeof requested !== 'object' || Array.isArray(requested)) {
    fail('INVALID_CLARIFICATION', '추가 확인은 한 번만 할 수 있어요.');
  }
  const keys = ['source_question_id','source_revision','component','event_id','quote','quote_start','quote_end','axis','role','agreement_item_id'];
  if (Object.keys(requested).some(key => !keys.includes(key))) fail('INVALID_CLARIFICATION', '확인 질문의 연결 정보를 확인해 주세요.');
  const binding = structuredClone(requested);
  const { question:sourceQuestion, answer } = sourceForBinding(state, binding);
  const axes = state.questionSet.bundle.questions.clarification.axes;
  const variant = Object.hasOwn(axes, binding.axis) ? axes[binding.axis] : null;
  if (!variant || (binding.axis === 'actor' && !Object.hasOwn(variant.role_labels, binding.role)) ||
      (binding.axis === 'agreement' && (typeof binding.agreement_item_id !== 'string' || !binding.agreement_item_id.trim() || binding.agreement_item_id.length > 120))) {
    fail('INVALID_CLARIFICATION', '확인할 한 가지 항목을 지정해 주세요.');
  }
  binding.source_message_id = answer.source_message_id;
  binding.bundle_id = state.questionSet.bundle_id;
  binding.goal_epoch = state.v3.goal_epoch;
  const question = { id:'q3_10', source_id:'Q3-10', subject:sourceQuestion.subject, sec:'한 가지 확인', face:'ponder',
    type:'one', q:variant.text.replace('「…」', `「${binding.quote}」`) +
      (binding.axis === 'actor' ? ` (${variant.role_labels[binding.role]})` : ''),
    help:variant.help.text, response_controls:true, topic_scope:sourceQuestion.topic_scope,
    opts:variant.options.map(option => [option.label, { value:option.value }]),
    noOwn:binding.axis !== 'time', allowCustomWithSelection:binding.axis === 'time',
    ...(binding.axis === 'time' ? { ownPh:'아는 범위의 시점을 적어 주세요.' } : {}), follow_up:true };
  binding.instance_id = issueV3(state, question).instance_id;
  question.instance_id = binding.instance_id;
  question.binding = structuredClone(binding);
  state.v3.clarification = { binding, question, status:'issued' };
  return question;
}

export function answerV3Clarification(state, question, answer) {
  const clarification = state.v3.clarification;
  if (!clarification || clarification.status !== 'issued') fail('STALE_CLARIFICATION', '이 확인 질문은 더 이상 사용할 수 없어요.', 409);
  try { sourceForBinding(state, clarification.binding); }
  catch { fail('STALE_CLARIFICATION', '원문이 바뀌었어요. 이전 확인 답변은 저장하지 않아요.', 409); }
  const binding = clarification.binding;
  let value = 'unknown', timeText;
  if (!answer.skipped && answer.response_event !== 'unknown') {
    const option = answer.sel.length === 1 ? question.opts[answer.sel[0]]?.[1]?.value : null;
    if (binding.axis === 'time' && (answer.custom || option === 'specified')) {
      timeText = answer.custom?.trim();
      if (!timeText) fail('answer_required', '아는 범위의 시점을 적어 주세요.', 400);
      value = 'specified';
    } else if (option) value = option;
    else fail('invalid_selection', '확인 항목의 보기 하나를 골라 주세요.', 400);
  }
  clarification.status = answer.skipped ? answer.response_event : 'answered';
  // Store exactly one assignment. Never derive execution, agreement or another actor from it.
  clarification.assignment = { event_id:binding.event_id, axis:binding.axis, value,
    ...(binding.axis === 'actor' ? { role:binding.role } : {}),
    ...(binding.axis === 'agreement' ? { agreement_item_id:binding.agreement_item_id } : {}),
    ...(timeText ? { time_text:timeText, source_timestamp:answer.source_timestamp, source_timezone:answer.source_timezone } : {}) };
  return { ...answer, binding:structuredClone(binding), assignment:structuredClone(clarification.assignment) };
}

export function invalidateV3Clarification(state, questionId) {
  const clarification = state.v3?.clarification;
  if (clarification?.binding.source_question_id === questionId) {
    clarification.status = 'obsolete';
    delete clarification.assignment;
    delete state.clarificationAnswers?.q3_10;
  }
}
