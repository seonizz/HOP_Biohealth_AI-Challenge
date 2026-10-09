import { isThin, optLabel, optMeta, renderQuestion } from './catalog.js';
import { initialQuestionSet, conditionMatches, followMatches, mergeFollow, branchGateIds } from './question-bank.js';
import { HttpError } from './errors.js';
import { validateNameIndex, validateQuestionPlan } from './agent-state.js';

const SKIP = '(건너뛰었어요)';
const WELCOME = '안녕하세요, 말씨예요. 누군가에게 다가가려는 마음을 먹으셨군요.\n천천히 답해 주셔도 괜찮아요.';
// Old saved intakes keep the original seed; newly created intakes carry their DB snapshot.
const questionSetOf = state => state.questionSet || initialQuestionSet;
const subjectOf = question => question.subject;

function invalid(code, message, status = 400) {
  throw new HttpError(status, code, message);
}

function snapshot(state) {
  return structuredClone({
    i: state.i, ans: state.ans, tags: state.tags, name: state.name,
    fuCount: state.fuCount, extraObs: state.extraObs, logLen: state.log.length,
    modelSkipped: state.modelSkipped || {}, nameIndex: state.nameIndex || null, chatTitle: state.chatTitle || '',
  });
}

function addPrompt(state, question, followUp = false) {
  const rendered = renderQuestion(question, state);
  if (rendered.intro && !followUp) {
    state.log.push({ who: 'ai', text: rendered.intro, fu: false, face: rendered.face });
  }
  state.log.push({ who: 'ai', text: rendered.q, fu: followUp, face: rendered.face || 'ponder', ...(rendered.why ? { why: rendered.why } : {}) });
}

function advance(state, previous) {
  const { questions, gapQuestion } = questionSetOf(state);
  while (state.i < questions.length && (state.modelSkipped?.[questions[state.i].id] ||
    (questions[state.i].when && !conditionMatches(questions[state.i].when, state)))) state.i++;
  if (state.i >= questions.length) {
    if (gapQuestion && !state.ans.mood?.sel.length && !state.extraObs && isThin(state.ans.concern?.text, 1) &&
      !['mood', 'concern'].some(id => state.modelSkipped?.[id]?.reason === 'already_covered')) {
      state.pendingFollow = { kind: 'gap', questionId: 'gap_obs' };
      state.fuCount++;
      addPrompt(state, gapQuestion, true);
    } else {
      state.status = 'ready';
    }
    return;
  }
  state.prev = previous === undefined ? state.cur : previous;
  state.cur = snapshot(state);
  addPrompt(state, questions[state.i]);
}

export function createIntake(questionSet = initialQuestionSet) {
  const state = {
    questionSet: structuredClone(questionSet),
    i: 0, ans: {}, tags: [], name: '', fuCount: 0, extraObs: '',
    log: [{ who: 'ai', text: WELCOME, fu: false, face: 'hello' }],
    prev: null, cur: null, pendingFollow: null, status: 'active',
    modelSkipped: {}, nameIndex: null, chatTitle: '',
  };
  advance(state);
  return state;
}

function activeQuestion(state) {
  const { questions, gapQuestion } = questionSetOf(state);
  if (state.pendingFollow?.kind === 'gap') return { ...gapQuestion, follow_up: true };
  if (state.pendingFollow) {
    return { ...questions[state.i].follow_up.question, id: state.pendingFollow.questionId,
      sec: questions[state.i].sec, required: true, face: 'ponder', follow_up: true };
  }
  return state.status === 'active' ? questions[state.i] : null;
}

export function currentView(state) {
  const { questions } = questionSetOf(state);
  const question = activeQuestion(state);
  const rendered = question ? renderQuestion(question, state) : null;
  return {
    question: rendered,
    progress: state.status === 'ready' ? 100 : state.i / questions.length * 100,
    section: rendered?.sec || (state.i >= questions.length ? questions.at(-1).sec : ''),
    canGoBack: state.status === 'active' && !state.pendingFollow && Boolean(state.prev),
    status: state.status,
    pendingFollow: Boolean(state.pendingFollow),
    totalQuestions: questions.length,
    questionIndex: state.i,
  };
}

function normalizeAnswer(question, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('invalid_answer', '답변 객체가 필요해요.');
  const rawText = input.text ?? '';
  const custom = input.custom ?? '';
  const selected = input.selected ?? [];
  if (typeof rawText !== 'string' || typeof custom !== 'string') invalid('invalid_answer', '입력한 답변은 문자열이어야 해요.');
  if (rawText.length > 10000 || custom.length > 10000) invalid('answer_too_long', '답변은 10,000자 이내로 적어 주세요.');
  if (!Array.isArray(selected) || selected.some(index => !Number.isInteger(index)) || new Set(selected).size !== selected.length) {
    invalid('invalid_selection', '선택한 보기 번호가 올바르지 않아요.');
  }
  if (input.skipped !== undefined && typeof input.skipped !== 'boolean') invalid('invalid_answer', '건너뛰기 값이 올바르지 않아요.');
  const skipped = input.skipped === true;
  if (skipped) {
    if (question.required || question.noSkip) invalid('answer_required', '이 질문은 꼭 답해 주세요.');
    if (selected.length || custom.trim()) invalid('invalid_answer', '건너뛴 답변에는 보기를 선택할 수 없어요.');
    return { text: SKIP, sel: [], custom: '', skipped: true, rawText };
  }
  if (question.type === 'text') {
    if (selected.length || custom) invalid('invalid_answer', '이 질문에는 글로 답해 주세요.');
    if (question.required && !rawText.trim()) invalid('answer_required', '이 질문은 꼭 답해 주세요.');
    return { text: rawText.trim() ? rawText : SKIP, sel: [], custom: '', skipped: false, rawText };
  }
  if (selected.some(index => index < 0 || index >= question.opts.length)) invalid('invalid_selection', '선택한 보기가 없어요.');
  if (question.type === 'one' && selected.length > 1) invalid('invalid_selection', '하나의 보기만 골라 주세요.');
  if (selected.length > 1 && selected.some(index => optMeta(question.opts[index]).none)) {
    invalid('exclusive_selection', '없음 또는 모름 보기는 다른 보기와 함께 고를 수 없어요.');
  }
  if (question.noOwn && custom) invalid('custom_not_allowed', '이 질문은 제시된 보기에서 골라 주세요.');
  if (question.type === 'one' && !selected.length && !custom.trim()) {
    invalid('answer_required', '하나의 보기를 고르거나 직접 입력해 주세요.');
  }
  if (question.noOwn && !selected.length) invalid('invalid_selection', '이 질문은 제시된 보기에서 골라 주세요.');
  if (question.required && !selected.length && !custom.trim()) invalid('answer_required', '이 질문은 꼭 답해 주세요.');
  if (question.type === 'one' && selected.length && custom) invalid('invalid_answer', '선택한 보기와 직접 입력을 함께 보낼 수 없어요.');

  let text;
  if (question.type === 'one' && selected.length && optMeta(question.opts[selected[0]]).input) {
    const label = optLabel(question.opts[selected[0]]);
    // The original UI combines the chosen "네" option and its detail textarea.
    text = rawText.trim() ? (rawText === label || rawText.startsWith(`${label}, `) ? rawText : `${label}, ${rawText}`) : label;
  } else {
    const parts = selected.map(index => optLabel(question.opts[index]));
    if (custom.trim()) parts.push(custom);
    text = parts.length ? parts.join(', ') : '해당 없음';
  }
  const detailInput = question.type === 'one' && selected.length && optMeta(question.opts[selected[0]]).input;
  return { text, sel: [...selected], custom, skipped: false, rawText:detailInput ? rawText : text };
}

function commitAnswer(state, question, answer) {
  // Keep merged selections native and JSON-safe.
  answer = { ...answer, sel: Array.from(answer.sel) };
  state.ans[question.id] = answer;
  if (question.id === 'name') state.name = isThin(answer.text, 1) ? '그분' : answer.text.slice(0, 20);
  if (question.id === 'mood' && answer.custom) state.extraObs = answer.custom;
  for (const index of answer.sel) {
    const tag = optMeta(question.opts[index]).t;
    if (tag && !state.tags.includes(tag)) state.tags.push(tag);
  }
}

export function answerIntake(originalState, input) {
  const { questions } = questionSetOf(originalState);
  if (originalState.status !== 'active') invalid('intake_complete', '이미 모든 질문에 답했어요.', 409);
  const question = activeQuestion(originalState);
  if (input?.follow_up !== undefined && typeof input.follow_up !== 'boolean') {
    invalid('invalid_answer', '후속 질문 값이 올바르지 않아요.');
  }
  if (input?.question_id !== question.id || Boolean(input?.follow_up) !== Boolean(originalState.pendingFollow)) {
    invalid('question_mismatch', '현재 질문에 답해 주세요.', 409);
  }
  const answer = normalizeAnswer(question, input);
  const state = structuredClone(originalState);
  state.log.push({ who: 'me', text: answer.text, fu: Boolean(state.pendingFollow) });

  if (state.pendingFollow) {
    const pending = state.pendingFollow;
    state.pendingFollow = null;
    if (pending.kind === 'gap') {
      state.extraObs = answer.text;
      state.ans.gap_obs = answer;
      state.status = 'ready';
      return state;
    }
    const baseQuestion = questions[state.i];
    const merged = mergeFollow(baseQuestion.follow_up, pending.answer, answer);
    commitAnswer(state, baseQuestion, {
      ...merged, custom: merged.custom || '', skipped: false, rawText: pending.answer.rawText,
      followUp: { question: renderQuestion(question, state).q, answer },
    });
  } else {
    const follow = question.follow_up;
    if (follow && !answer.skipped && followMatches(follow, answer)) {
      state.pendingFollow = { kind: 'question', questionId: question.id, answer };
      state.fuCount++;
      addPrompt(state, activeQuestion(state), true);
      return state;
    }
    commitAnswer(state, questions[state.i], answer);
  }
  state.i++;
  advance(state);
  return state;
}

export function backIntake(originalState) {
  if (originalState.status !== 'active' || originalState.pendingFollow || !originalState.prev) {
    invalid('back_unavailable', '지금은 이전 질문으로 돌아갈 수 없어요.', 409);
  }
  const state = structuredClone(originalState);
  const previous = state.prev;
  const { logLen, ...values } = previous;
  Object.assign(state, values, { status: 'active', pendingFollow: null, prev: null, cur: null,
    modelSkipped: values.modelSkipped || {}, nameIndex: values.nameIndex || null, chatTitle: values.chatTitle || '' });
  state.log.length = logLen;
  advance(state);
  return state;
}

// Decisions are grounded in the same persisted input as the memory update.
// Skipping a question never creates a user answer or an inferred option selection.
export function applyModelUpdate(originalState, output) {
  const context = buildContext(originalState);
  const nameIndex = validateNameIndex(output.name_index, context);
  const plan = validateQuestionPlan(output.question_plan, context);
  const state = structuredClone(originalState);
  state.agentMemory = structuredClone(output.patient_state);
  state.modelStatus = 'connected';
  if (nameIndex) {
    state.name = nameIndex.alias;
    state.chatTitle = nameIndex.alias;
    state.nameIndex = nameIndex;
  } else {
    state.nameIndex = null;
    state.chatTitle = '';
  }
  state.modelSkipped ||= {};
  for (const decision of plan.skip) state.modelSkipped[decision.question_id] = structuredClone(decision);
  if (state.status === 'active' && !state.pendingFollow) {
    // The next prompt was prepared before the external model call and has not been displayed yet.
    const previous = state.prev;
    state.log.length = state.cur.logLen;
    state.cur = null;
    advance(state, previous);
  }
  return state;
}

function stripUiMeta({ g, none, input, ph, ...meta }) { return meta; }

function payloadAnswer(question, answer, state) {
  return {
    id: question.id, question: renderQuestion(question, state).q, type: question.type,
    freeText: Boolean(question.cue), text: answer.text, custom: answer.custom || '',
    skipped: Boolean(answer.skipped),
    selected: answer.sel.map(index => ({ label: optLabel(question.opts[index]), meta: { ...stripUiMeta(optMeta(question.opts[index])) } })),
  };
}

function evidenceField(question, state) {
  const answer = state.ans[question.id];
  if (!answer) return { id: question.id, question: renderQuestion(question, state).q,
    status: state.modelSkipped?.[question.id] ? 'auto_skipped' : 'not_asked', source: 'app_user_report',
    ...(state.modelSkipped?.[question.id] ? { skip_decision: structuredClone(state.modelSkipped[question.id]) } : {}) };
  const payload = payloadAnswer(question, answer, state);
  // Unknown status only reflects an explicit UI option; short free text is retained as reported.
  const explicitlyUnknown = payload.selected.some(option => option.label.includes('잘 모르겠어요'));
  return {
    ...payload, status: answer.skipped ? 'skipped' : explicitlyUnknown ? 'unknown' : 'answered',
    source: 'app_user_report', rawText: answer.rawText ?? answer.text,
    ...(answer.followUp ? { followUp: structuredClone(answer.followUp) } : {}),
  };
}

export function buildContext(state) {
  const { questions, gapQuestion, version } = questionSetOf(state);
  const gates = branchGateIds(questionSetOf(state));
  // A thin first answer is already evidence even while its follow-up is pending.
  const pending = state.pendingFollow?.kind === 'question' ? state.pendingFollow : null;
  const evidenceState = pending ? { ...state, ans:{ ...state.ans, [pending.questionId]:pending.answer } } : state;
  const answers = questions.filter(question => evidenceState.ans[question.id])
    .map(question => payloadAnswer(question, evidenceState.ans[question.id], evidenceState));
  if (state.ans.gap_obs && gapQuestion) answers.push(payloadAnswer(gapQuestion, state.ans.gap_obs, state));
  const fields = Object.fromEntries(questions.map(question => [question.id, {
    ...evidenceField(question, evidenceState),
    ...(pending?.questionId === question.id ? { follow_up_pending:true } : {})
  }]));
  const value = id => state.ans[id]?.skipped ? '' : state.ans[id]?.text || '';
  return {
    schema_version: '1.0',
    question_set_version:version,
    answered_count: Object.values(evidenceState.ans).filter(answer => !answer.skipped).length,
    question_candidates: state.status === 'active' ? questions.slice(state.i)
      .filter(question => !['name','want','cause'].includes(question.id) && !gates.has(question.id) && !evidenceState.ans[question.id] &&
        !state.modelSkipped?.[question.id] && (!question.when || conditionMatches(question.when, evidenceState)))
      .map(question => ({ id:question.id, question:renderQuestion(question, evidenceState).q,
        subject:subjectOf(question),
        required:Boolean(question.required), noSkip:Boolean(question.noSkip) })) : [],
    name_index: state.nameIndex || null,
    chat_title: state.chatTitle || '',
    user_goal: { message: fields.want, desired_outcomes: fields.goal },
    patient: {
      alias: state.name || '그분', relationship: fields.rel,
      fields: {
        ...Object.fromEntries(questions.filter(question => subjectOf(question) === 'patient').map(question => [question.id, fields[question.id]])),
        ...(state.ans.gap_obs && gapQuestion ? { gap_obs:evidenceField(gapQuestion, state) } : {}),
      },
    },
    supporter: {
      role: 'informant',
      fields: Object.fromEntries(questions.filter(question => subjectOf(question) === 'supporter').map(question => [question.id, fields[question.id]])),
    },
    payload: { name: state.name, tags: [...state.tags], answers },
    profileInput: {
      name: state.name, rel: value('rel'), contact: value('contact'), obs: state.extraObs,
      concern: value('concern'), moment: value('moment'), feeling: value('feeling'), want: value('want'),
      tags: [...state.tags], answers: Object.fromEntries(Object.entries(state.ans).map(([id, answer]) => [id, answer.text])),
    },
    agent_state: state.agentMemory || null,
    log: structuredClone(state.log), followUps: state.fuCount, model_status: state.modelStatus || 'not_connected',
  };
}
