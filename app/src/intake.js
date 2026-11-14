import { hasAnswerContent, isThin, optLabel, optMeta, renderQuestion, renderText } from './catalog.js';
import { initialQuestionSet, conditionMatches, followMatches, mergeFollow, branchGateIds } from './question-bank.js';
import { HttpError } from './errors.js';
import { validateNameIndex, validateQuestionPlan } from './agent-state.js';
import { clarificationQuestions, clarificationCandidates } from './clarifications.js';
import { validateRelationshipMemory, validateSafetyEvidence, safetySnapshotFingerprint, currentApprovedSafety, currentReviewedSafety } from './relationship-agent.js';
import { normalizeAnswerField } from './answer-sources.js';
import { isV3Intake, initializeV3, issueV3, normalizeV3Answer, stampV3Answer, v3FieldStatus,
  v3ClarificationAvailable, createV3Clarification, answerV3Clarification, invalidateV3Clarification } from './intake-v3.js';

const SKIP = '(건너뛰었어요)';
const WELCOME = '안녕하세요, 말씨예요. 누군가에게 다가가려는 마음을 먹으셨군요.\n천천히 답해 주셔도 괜찮아요.';
const CHEER = [
  [1 / 3, '벌써 3분의 1을 함께 왔어요. 들려주신 이야기 하나하나가 큰 도움이 돼요. 조금만 더 함께해 주세요.'],
  [0.66, '거의 다 왔어요! 이제 몇 가지만 더 여쭤볼게요. 끝까지 함께해 주셔서 고마워요.'],
];
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
    clarificationAnswers: state.clarificationAnswers || {},
    modelSkipped: state.modelSkipped || {}, nameIndex: state.nameIndex || null, chatTitle: state.chatTitle || '',
  });
}

// Existing intakes have at most two saved prompts. New intakes keep each prompt.
const historyOf = state => state.history || [state.prev, state.cur].filter(Boolean);

function addPrompt(state, question, followUp = false) {
  const rendered = renderQuestion(question, state);
  if (rendered.intro && !followUp) {
    state.log.push({ who: 'ai', text: rendered.intro, fu: false, face: rendered.face });
  }
  state.log.push({ who: 'ai', text: rendered.q, fu: followUp || Boolean(rendered.fu), face: rendered.face || 'ponder', ...(rendered.why ? { why: rendered.why } : {}),
    ...(isV3Intake(state) ? { question_id:question.id } : {}) });
}

function advance(state, previous) {
  const { questions, gapQuestion } = questionSetOf(state);
  while (state.i < questions.length && ((isV3Intake(state) && state.ans[questions[state.i].id] && state.v3.editingQuestion !== questions[state.i].id) ||
    state.modelSkipped?.[questions[state.i].id] ||
    (questions[state.i].when && !conditionMatches(questions[state.i].when, state)))) state.i++;
  if (state.i >= questions.length) {
    if (!isV3Intake(state) && gapQuestion && !state.ans.mood?.sel.length && !state.extraObs && isThin(state.ans.concern?.text, 1) &&
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
  state.history ||= [];
  if (previous === undefined) state.history.push(state.cur);
  else state.history[state.history.length - 1] = state.cur;
  const previousIndex = state.history.at(-2)?.i ?? -1;
  const cheer = CHEER.find(([ratio]) => state.i >= Math.ceil(ratio * questions.length) && previousIndex < Math.ceil(ratio * questions.length))?.[1];
  if (cheer && !isV3Intake(state)) state.log.push({ who:'ai', text:cheer, fu:false, face:'cheer' });
  if (isV3Intake(state)) issueV3(state, questions[state.i]);
  addPrompt(state, questions[state.i]);
}

export function createIntake(questionSet = initialQuestionSet) {
  const state = {
    questionSet: structuredClone(questionSet),
    i: 0, ans: {}, tags: [], name: '', fuCount: 0, extraObs: '',
    log: [{ who: 'ai', text: WELCOME, fu: false, face: 'hello' }],
    prev: null, cur: null, history: [], pendingFollow: null, status: 'active',
    modelSkipped: {}, nameIndex: null, chatTitle: '',
  };
  if (isV3Intake(state)) initializeV3(state);
  advance(state);
  return state;
}

function activeQuestion(state) {
  const { questions, gapQuestion } = questionSetOf(state);
  if (state.pendingFollow?.kind === 'v3_clarification') return state.v3.clarification.question;
  if (state.pendingFollow?.kind === 'clarification') return { ...clarificationQuestions.find(q=>q.id===state.pendingFollow.questionId), follow_up:true };
  if (state.pendingFollow?.kind === 'gap') return { ...gapQuestion, follow_up: true };
  if (state.pendingFollow) {
    return { ...questions[state.i].follow_up.question, id: state.pendingFollow.questionId,
      sec: questions[state.i].sec, required: true, face: 'ponder', follow_up: true };
  }
  return state.status === 'active' ? questions[state.i] : null;
}

export function currentView(state) {
  const { questions } = questionSetOf(state);
  const stopped = isV3Intake(state) && Boolean(state.v3.stopped || state.modelPending?.prepared?.v3?.stopped);
  const question = activeQuestion(state);
  const rendered = question ? renderQuestion(question, state) : null;
  if (rendered && isV3Intake(state)) rendered.instance_id = state.v3.issued[question.id]?.instance_id;
  return {
    question: rendered,
    progress: state.status === 'ready' ? 100 : state.i / questions.length * 100,
    section: rendered?.sec || (state.i >= questions.length ? questions.at(-1).sec : ''),
    canGoBack: isV3Intake(state) ? state.status === 'active' && !stopped && questions.slice(0, state.i).some(q => state.ans[q.id])
      : state.status === 'active' && (state.pendingFollow ? historyOf(state).length > 0 : historyOf(state).length > 1),
    status: state.status,
    pendingFollow: Boolean(state.pendingFollow),
    totalQuestions: questions.length,
    questionIndex: state.i,
    ...(isV3Intake(state) ? { bundle_id:state.questionSet.bundle_id, question_instances:Object.keys(state.v3.issued).length, maxQuestions:10,
      user_stopped:stopped, input_locked:stopped, safety_urgent:Boolean(state.safetySignal?.urgent) } : {}),
    ...(state.modelPending ? { model_pending:true, pending_answer:structuredClone(state.modelPending.input) } : {}),
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
    // Empty input and the reserved UI skip marker are absence of an answer,
    // including requests from older clients which omitted the skipped flag.
    if (!hasAnswerContent(rawText)) {
      if (question.required || question.noSkip) invalid('answer_required', '이 질문은 꼭 답해 주세요.');
      return { text: SKIP, sel: [], custom: '', skipped: true, rawText };
    }
    return { text: rawText, sel: [], custom: '', skipped: false, rawText };
  }
  if (selected.some(index => index < 0 || index >= question.opts.length)) invalid('invalid_selection', '선택한 보기가 없어요.');
  if (question.type === 'one' && selected.length > 1) invalid('invalid_selection', '하나의 보기만 골라 주세요.');
  if (selected.length > 1 && selected.some(index => optMeta(question.opts[index]).none)) {
    invalid('exclusive_selection', '없음 또는 모름 보기는 다른 보기와 함께 고를 수 없어요.');
  }
  if (question.noOwn && custom) invalid('custom_not_allowed', '이 질문은 제시된 보기에서 골라 주세요.');
  const hasCustom = hasAnswerContent(custom);
  if (question.type === 'one' && !selected.length && !hasCustom) {
    invalid('answer_required', '하나의 보기를 고르거나 직접 입력해 주세요.');
  }
  if (question.noOwn && !selected.length) invalid('invalid_selection', '이 질문은 제시된 보기에서 골라 주세요.');
  if ((question.required || question.noSkip) && !selected.length && !hasCustom) invalid('answer_required', '이 질문은 꼭 답해 주세요.');
  if (question.type === 'one' && selected.length && custom && !question.allowCustomWithSelection) invalid('invalid_answer', '선택한 보기와 직접 입력을 함께 보낼 수 없어요.');

  let text;
  if (question.type === 'one' && selected.length && optMeta(question.opts[selected[0]]).input) {
    const label = optLabel(question.opts[selected[0]]);
    // The original UI combines the chosen "네" option and its detail textarea.
    text = hasAnswerContent(rawText) ? (rawText === label || rawText.startsWith(`${label}, `) ? rawText : `${label}, ${rawText}`) : label;
  } else {
    const parts = selected.map(index => optLabel(question.opts[index]));
    if (hasCustom) parts.push(custom);
    text = parts.length ? parts.join(', ') : '해당 없음';
  }
  const detailInput = question.type === 'one' && selected.length && optMeta(question.opts[selected[0]]).input;
  return { text, sel: [...selected], custom: hasCustom ? custom : '', skipped: false, rawText:detailInput ? rawText : text };
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

function answerV3(originalState, question, input) {
  const state = structuredClone(originalState), progress = initializeV3(state);
  if (input.instance_id !== undefined && input.instance_id !== progress.issued[question.id]?.instance_id) {
    invalid('question_mismatch', '현재 질문에 답해 주세요.', 409);
  }
  let answer = stampV3Answer(state, question, normalizeV3Answer(question, input, normalizeAnswer, hasAnswerContent));
  delete progress.helpReplay;
  delete progress.editingQuestion;
  if (state.ans[question.id]) state.log = state.log.filter(entry => entry.question_id !== question.id);
  state.log.push({ who:'me', text:answer.text, fu:Boolean(state.pendingFollow), question_id:question.id, source_revision:answer.source_revision });
  if (answer.response_event === 'not_understood' && progress.issued[question.id].help_displays === 0) {
    if (typeof question.help !== 'string' || !question.help.trim()) invalid('QUESTION_BANK_INVALID', '질문 도움말을 확인해 주세요.', 503);
    progress.issued[question.id].help_displays++;
    progress.helpReplay = true;
    progress.reports.push({ question:structuredClone(question), answer });
    state.log.push({ who:'ai', text:question.help, face:question.face || 'ponder', fu:Boolean(state.pendingFollow) });
    addPrompt(state, question, Boolean(state.pendingFollow));
    return state;
  }
  if (state.pendingFollow?.kind === 'v3_clarification') {
    answer = answerV3Clarification(state, question, answer);
    state.clarificationAnswers ||= {};
    state.clarificationAnswers.q3_10 = answer;
    state.pendingFollow = null;
  } else {
    const correction = Object.hasOwn(state.ans, question.id);
    if (correction) invalidateV3Clarification(state, question.id);
    commitAnswer(state, question, answer);
    if (question.id === 'q3_01') progress.goal_epoch++;
    // Previously skipped, unshown questions are reconsidered against every new source.
    state.modelSkipped = {};
    // A changed goal reopens eligibility of every unshown question, including
    // priorities before the prompt from which the user returned to edit it.
    state.i = correction && question.id !== 'q3_01' ? progress.returnIndex ?? state.i + 1 : 0;
    delete progress.returnIndex;
  }
  if (answer.response_event === 'stop') {
    progress.stopped = true;
    state.status = 'ready';
    state.pendingFollow = null;
    return state;
  }
  while (state.i < state.questionSet.questions.length && state.ans[state.questionSet.questions[state.i].id]) state.i++;
  advance(state);
  return state;
}

// Final-output testing supplies an explicit snapshot, not a simulated interview.
// Missing questions remain unasked; only supplied answers become model evidence.
export function createTestIntake(answers, questionSet = initialQuestionSet) {
  const questions = questionSet.questions;
  if (!Array.isArray(answers) || !answers.length || answers.length > questions.length) {
    invalid('invalid_test_answers', '테스트 답변을 하나 이상, 문항 수 이내로 보내 주세요.', 422);
  }
  const inputs = new Map(), ids = new Set(questions.map(question => question.id));
  const keys = ['question_id', 'text', 'selected', 'custom', 'skipped', ...(isV3Intake(questionSet) ? ['response_event'] : [])];
  for (const input of answers) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !keys.includes(key)) ||
        typeof input.question_id !== 'string' || !ids.has(input.question_id)) {
      invalid('invalid_test_answer', '테스트 답변의 문항 ID와 입력 형식을 확인해 주세요.', 422);
    }
    if (inputs.has(input.question_id)) invalid('duplicate_test_answer', '같은 문항의 답변은 한 번만 보내 주세요.', 422);
    if (['text', 'custom'].some(key => Object.hasOwn(input, key) && typeof input[key] !== 'string') ||
        Object.hasOwn(input, 'selected') && !Array.isArray(input.selected) ||
        Object.hasOwn(input, 'skipped') && typeof input.skipped !== 'boolean') {
      invalid('invalid_test_answer', '테스트 답변의 값 형식을 확인해 주세요.', 422);
    }
    inputs.set(input.question_id, input);
  }
  const state = { ...createIntake(questionSet), i:questions.length, status:'ready',
    log:[], history:[], prev:null, cur:null, pendingFollow:null };
  for (const question of questions) {
    const input = inputs.get(question.id);
    if (!input) continue;
    const answer = isV3Intake(state) ? stampV3Answer(state, question, normalizeV3Answer(question, input, normalizeAnswer, hasAnswerContent))
      : normalizeAnswer(question, input);
    if (input.skipped && hasAnswerContent(input.text || '') && !isV3Intake(state)) {
      invalid('invalid_test_answer', '건너뛴 문항에 실제 답변을 함께 넣을 수 없어요.', 422);
    }
    const detail = question.type === 'one' && answer.sel.length === 1 && optMeta(question.opts[answer.sel[0]]).input;
    if (!input.skipped && question.type !== 'text' && input.text && !detail) {
      invalid('invalid_test_answer', '선택형 문항은 보기 번호 또는 직접 입력으로 보내 주세요.', 422);
    }
    addPrompt(state, question);
    state.log.push({ who:'me', text:answer.text, fu:false });
    commitAnswer(state, question, answer);
  }
  return state;
}

export function answerIntake(originalState, input) {
  const { questions } = questionSetOf(originalState);
  if (isV3Intake(originalState) && (originalState.v3.stopped || originalState.modelPending?.prepared?.v3?.stopped)) {
    invalid('INTAKE_STOPPED', '종료한 대화에는 새 답변을 추가할 수 없어요. 새 대화를 시작해 주세요.', 409);
  }
  if (originalState.status !== 'active') invalid('intake_complete', '이미 모든 질문에 답했어요.', 409);
  const question = activeQuestion(originalState);
  if (input?.follow_up !== undefined && typeof input.follow_up !== 'boolean') {
    invalid('invalid_answer', '후속 질문 값이 올바르지 않아요.');
  }
  if (input?.question_id !== question.id || Boolean(input?.follow_up) !== Boolean(originalState.pendingFollow)) {
    invalid('question_mismatch', '현재 질문에 답해 주세요.', 409);
  }
  if (isV3Intake(originalState)) return answerV3(originalState, question, input);
  const answer = normalizeAnswer(question, input);
  const state = structuredClone(originalState);
  state.history = structuredClone(historyOf(originalState));
  const detail = question.type === 'one' && answer.sel.length === 1 && optMeta(question.opts[answer.sel[0]]);
  if (detail?.input && detail.ask) {
    state.log.push({ who:'ai', text:renderText(detail.ask, state), face:question.face || 'ponder', fu:true });
  }
  state.log.push({ who: 'me', text: answer.text, fu: Boolean(state.pendingFollow) });

  if (state.pendingFollow) {
    const pending = state.pendingFollow;
    state.pendingFollow = null;
    if (pending.kind === 'clarification') {
      const prior=structuredClone(originalState);delete prior.clarificationHistory;
      state.clarificationHistory=[...(originalState.clarificationHistory||[]),prior];
      state.clarificationAnswers ||= {};
      state.clarificationAnswers[question.id]=answer;
      state.status='ready';
      return state;
    }
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

// A model turn persists the submitted text while leaving the visible question
// and its history at the state before the answer. Only validated model output
// commits the prepared next prompt.
export function discardModelAnswer(originalState) {
  const state = structuredClone(originalState);
  // The control was durably submitted before the model started. Discarding a
  // failed review must not restore an active interview or lose its safety text.
  if (isV3Intake(state) && state.modelPending?.prepared?.v3?.stopped) return preparedModelState(state);
  if (state.modelPending) {
    if (isV3Intake(state) && state.modelPending.originalLog) state.log = state.modelPending.originalLog;
    else state.log.length = state.modelPending.logLen;
    delete state.modelPending;
  }
  return state;
}

export function prepareModelAnswer(originalState, input, sourceRevision) {
  if (isV3Intake(originalState) && (originalState.v3.stopped || originalState.modelPending?.prepared?.v3?.stopped)) {
    const comparable = value => JSON.stringify([value?.question_id, Boolean(value?.follow_up), value?.text ?? '',
      value?.selected ?? [], value?.custom ?? '', Boolean(value?.skipped), value?.response_event ?? 'answered', value?.instance_id ?? null]);
    if (originalState.modelPending?.input?.response_event === 'stop' && comparable(originalState.modelPending.input) === comparable(input)) {
      const retry = structuredClone(originalState);
      retry.v3.stopped = true;
      return retry;
    }
    invalid('INTAKE_STOPPED', '종료 요청을 유지하고 있어요. 같은 요청을 다시 확인하거나 새 대화를 시작해 주세요.', 409);
  }
  const state = discardModelAnswer(originalState);
  const prepared = answerIntake(state, input);
  if (isV3Intake(state)) {
    // The next prompt exists only in an uncommitted preparation. It has not consumed a display.
    for (const id of Object.keys(prepared.v3.issued)) if (!state.v3.issued[id]) delete prepared.v3.issued[id];
  }
  const logLen = state.log.length;
  const originalLog = isV3Intake(state) ? structuredClone(state.log) : null;
  const evidenceEnd = isV3Intake(state) ? prepared.log.findLastIndex(item => item.who === 'me') + 1
    : prepared.log.findIndex((item, index) => index >= logLen && item.who === 'me') + 1;
  if (isV3Intake(state)) {
    state.log = structuredClone(prepared.log.slice(0, evidenceEnd));
    state.v3.input_revision = prepared.v3.input_revision;
    if (prepared.v3.stopped) state.v3.stopped = true;
  } else state.log.push(...structuredClone(prepared.log.slice(logLen, evidenceEnd)));
  // The question snapshot is already held by the base state.
  delete prepared.questionSet;
  state.modelPending = { sourceRevision, input:structuredClone(input), logLen, prepared, ...(originalLog ? { originalLog } : {}) };
  return state;
}

function preparedModelState(state) {
  return { ...structuredClone(state.modelPending.prepared), questionSet:questionSetOf(state) };
}

export function completeModelAnswer(state, output) {
  if (!state.modelPending) invalid('REVISION_CONFLICT', '현재 질문을 다시 확인해 주세요.', 409);
  return applyModelUpdate(preparedModelState(state), output);
}

export function backIntake(originalState) {
  if (isV3Intake(originalState) && (originalState.v3.stopped || originalState.modelPending?.prepared?.v3?.stopped)) {
    invalid('INTAKE_STOPPED', '종료한 대화에는 돌아갈 수 없어요. 새 대화를 시작해 주세요.', 409);
  }
  const hadPendingModel = Boolean(originalState.modelPending);
  originalState = discardModelAnswer(originalState);
  if (isV3Intake(originalState) && currentView(originalState).canGoBack) {
    const state = structuredClone(originalState);
    const questions = state.questionSet.questions;
    const previousIndex = questions.findLastIndex((question, index) => index < state.i && state.ans[question.id]);
    state.v3.returnIndex ??= state.i;
    state.i = previousIndex;
    state.v3.editingQuestion = questions[previousIndex].id;
    state.pendingFollow = null;
    state.modelSkipped = {};
    delete state.v3.helpReplay;
    if (state.v3.clarification?.status === 'issued') {
      state.v3.clarification.status = 'obsolete';
      delete state.v3.clarification.assignment;
    }
    for (const key of ['safetySignal','agentStateExecution','agentMemory','agentRelationshipMemory','agentResult','agentRecord']) delete state[key];
    state.modelStatus = 'not_connected';
    advance(state);
    return state;
  }
  if (!currentView(originalState).canGoBack) {
    // The first question has no preceding prompt; cancelling its uncommitted
    // answer still lets a concurrent correction invalidate the model request.
    if (hadPendingModel) {
      delete originalState.safetySignal; delete originalState.agentStateExecution; delete originalState.agentMemory; delete originalState.agentRelationshipMemory; delete originalState.agentResult; delete originalState.agentRecord;
      originalState.modelStatus = 'not_connected';
      return originalState;
    }
    invalid('back_unavailable', '지금은 이전 질문으로 돌아갈 수 없어요.', 409);
  }
  if (originalState.pendingFollow?.kind==='clarification' && originalState.clarificationHistory?.length) {
    const history=structuredClone(originalState.clarificationHistory),state=history.pop();
    state.clarificationHistory=history;
    delete state.safetySignal; delete state.agentStateExecution; delete state.agentMemory;delete state.agentRelationshipMemory;delete state.agentResult;delete state.agentRecord;
    state.modelStatus='not_connected';
    return state;
  }
  const state = structuredClone(originalState);
  state.history = structuredClone(historyOf(originalState));
  delete state.clarificationHistory;
  if (!state.pendingFollow) state.history.pop();
  const previous = state.history.pop();
  const { logLen, ...values } = previous;
  Object.assign(state, values, { status: 'active', pendingFollow: null, prev: null, cur: null,
    modelSkipped: values.modelSkipped || {}, nameIndex: values.nameIndex || null, chatTitle: values.chatTitle || '' });
  state.log.length = logLen;
  delete state.safetySignal; delete state.agentStateExecution; delete state.agentMemory; delete state.agentRelationshipMemory; delete state.agentResult; delete state.agentRecord;
  state.modelStatus = 'not_connected';
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
  state.history = structuredClone(historyOf(originalState));
  state.agentMemory = structuredClone(output.patient_state);
  if (output.state_agent) state.agentStateExecution=structuredClone(output.state_agent);
  if (output.safety_signal) {
    const signal=structuredClone(output.safety_signal);
    validateSafetyEvidence({urgent:signal.urgent,evidence:signal.evidence},context);
    const fingerprint=safetySnapshotFingerprint(context);
    if(signal.source_snapshot!==undefined&&signal.source_snapshot!==fingerprint)
      invalid('MODEL_INVALID_RESPONSE','안전 판단의 근거가 변경됐어요. 현재 답변으로 다시 확인해 주세요.',502);
    signal.source_snapshot=fingerprint;
    if(signal.urgent)currentApprovedSafety({...context,safety_signal:signal});
    state.safetySignal=signal;
  }
  if (output.relationship_memory) state.agentRelationshipMemory=validateRelationshipMemory(output.relationship_memory,context);
  else delete state.agentRelationshipMemory;
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
  if (output.finish_early===true) {
    // A short base answer may already have prepared a follow-up. Preserve that
    // report before ending intake; no follow-up answer has been supplied yet.
    if (state.pendingFollow?.kind==='question') {
      commitAnswer(state,questionSetOf(state).questions[state.i],state.pendingFollow.answer);
    }
    state.log.length=state.log.findLastIndex(item=>item.who==='me')+1;
    state.pendingFollow=null;state.status='ready';
    state.log.push({who:'ai',face:'ponder',fu:false,text:'지금 즉각적인 위험이 있다면 대화를 이어가기보다 응급 도움을 요청하고, 당신의 안전을 먼저 확보해 주세요. 혼자 감당하지 않도록 주변 도움을 함께 요청해 주세요.'});
  }
  if (state.status === 'active' && !state.pendingFollow && !state.v3?.helpReplay) {
    // The next prompt was prepared before the external model call and has not been displayed yet.
    const previous = state.prev;
    state.log.length = state.cur.logLen;
    state.cur = null;
    advance(state, previous);
  }
  if (isV3Intake(state) && !output.finish_early && output.clarification && !state.v3.stopped && !state.v3.helpReplay) {
    // Clarification preempts the prepared, still-unshown ordinary question.
    if (state.status === 'active' && !state.pendingFollow) {
      state.log.length = state.cur.logLen;
      if (!originalState.v3.issued[state.questionSet.questions[state.i].id]) delete state.v3.issued[state.questionSet.questions[state.i].id];
    }
    const question = createV3Clarification(state, output.clarification);
    state.pendingFollow = { kind:'v3_clarification', questionId:'q3_10' };
    state.status = 'active';
    state.fuCount = 1;
    addPrompt(state, question, true);
  } else if (!isV3Intake(state) && !output.finish_early && output.clarification && state.status==='ready') {
    const question=clarificationCandidates(state).find(q=>q.id===output.clarification);
    if (!question) invalid('INVALID_CLARIFICATION','이미 확인한 질문은 다시 묻지 않아요.',422);
    state.pendingFollow={kind:'clarification',questionId:question.id};
    state.status='active';state.fuCount++;
    addPrompt(state,question,true);
  }
  return state;
}

function stripUiMeta({ g, none, input, ph, ask, ...meta }) { return meta; }

function payloadAnswer(question, answer, state) {
  return {
    id: question.id, question: renderQuestion(question, state).q, type: question.type,
    freeText: Boolean(question.cue), text: answer.text, custom: answer.custom || '',
    skipped: Boolean(answer.skipped),
    ...(isV3Intake(state) ? { response_event:answer.response_event, source_revision:answer.source_revision,
      source_message_id:answer.source_message_id, source_timestamp:answer.source_timestamp, source_timezone:answer.source_timezone,
      ordinary_usable:answer.ordinary_usable ?? !['refused','stop','skipped','not_understood'].includes(answer.response_event),
      ...(answer.selection_status ? { selection_status:answer.selection_status } : {}),
      ...(answer.binding ? { binding:structuredClone(answer.binding), assignment:structuredClone(answer.assignment) } : {}) } : {}),
    selected: answer.sel.map(index => ({ label: optLabel(question.opts[index]), meta: { ...stripUiMeta(optMeta(question.opts[index])) } })),
  };
}

function evidenceField(question, state) {
  const answer = state.ans[question.id];
  if (!answer) return { id: question.id, question: renderQuestion(question, state).q,
    status: state.modelSkipped?.[question.id] ? 'auto_skipped' : 'not_asked', source: 'app_user_report',
    ...(state.modelSkipped?.[question.id] ? { skip_decision: structuredClone(state.modelSkipped[question.id]) } : {}) };
  const payload = payloadAnswer(question, answer, state);
  return normalizeAnswerField({
    ...payload, status: isV3Intake(state) ? v3FieldStatus(answer) : answer.skipped ? 'skipped' : 'answered',
    source: 'app_user_report', rawText: answer.rawText ?? answer.text,
    ...(answer.followUp ? { followUp: structuredClone(answer.followUp) } : {}),
  });
}

export function buildContext(state) {
  // Verification history and model evidence include the saved pending answer,
  // but never expose the prepared next prompt before the model accepts it.
  const latestAnswerId=state.modelPending?.input?.question_id;
  if (state.modelPending) state = { ...preparedModelState(state), log:state.log };
  const { questions, gapQuestion, version } = questionSetOf(state);
  const v3 = isV3Intake(state);
  const extraQuestions = v3 ? (state.v3.clarification ? [state.v3.clarification.question] : []) : clarificationQuestions;
  const latestQuestion=latestAnswerId ? [...questions,...extraQuestions].find(question=>question.id===latestAnswerId)||
    (gapQuestion?.id===latestAnswerId ? gapQuestion : null) : null;
  const gates = branchGateIds(questionSetOf(state));
  // A thin first answer is already evidence even while its follow-up is pending.
  const pending = state.pendingFollow?.kind === 'question' ? state.pendingFollow : null;
  const evidenceState = pending ? { ...state, ans:{ ...state.ans, [pending.questionId]:pending.answer } } : state;
  const answers = questions.filter(question => evidenceState.ans[question.id])
    .map(question => payloadAnswer(question, evidenceState.ans[question.id], evidenceState));
  if (state.ans.gap_obs && gapQuestion) answers.push(payloadAnswer(gapQuestion, state.ans.gap_obs, state));
  for (const question of extraQuestions) if(state.clarificationAnswers?.[question.id]) {
    answers.push(payloadAnswer(question,state.clarificationAnswers[question.id],state));
  }
  const fields = Object.fromEntries(questions.map(question => [question.id, {
    ...evidenceField(question, evidenceState),
    ...(pending?.questionId === question.id ? { follow_up_pending:true } : {})
  }]));
  const extraFields=Object.fromEntries(extraQuestions.filter(q=>state.clarificationAnswers?.[q.id]).map(q=>[q.id,
    evidenceField(q,{...state,ans:state.clarificationAnswers})]));
  const value = id => state.ans[id]?.skipped ? '' : state.ans[id]?.text || '';
  const context = {
    schema_version: '1.0',
    adaptive_questions:true,
    clarification_candidates:clarificationCandidates(state).map(q=>({...q,question:renderQuestion(q,state).q})),
    question_set_version:version,
    ...(v3 ? { bundle_id:state.questionSet.bundle_id, questionnaire_bundle:structuredClone(state.questionSet.bundle),
      question_policy:{ minimum_answer_count:0, maximum_question_instances:10, maximum_clarification_instances:1 },
      clarification_available:v3ClarificationAvailable(state),
      clarification_axes:structuredClone(state.questionSet.bundle.questions.clarification.axes),
      input_revision:state.v3.input_revision, goal_epoch:state.v3.goal_epoch, user_stopped:state.v3.stopped,
      issued_question_ids:Object.keys(state.v3.issued),
      clarification_state:state.v3.clarification ? structuredClone(state.v3.clarification) : null } : {}),
    answered_count: Object.values(evidenceState.ans).filter(answer => !answer.skipped).length,
    latest_answer: latestQuestion ? {question_id:latestAnswerId,subject:subjectOf(latestQuestion)} : null,
    question_candidates: state.status === 'active' ? questions.slice(state.i)
      .filter(question => !['name','want','cause'].includes(question.id) && !gates.has(question.id) && !evidenceState.ans[question.id] &&
        !state.modelSkipped?.[question.id] && (!v3 || !state.v3.issued[question.id]) && (!question.when || conditionMatches(question.when, evidenceState)))
      .map(question => ({ id:question.id, question:renderQuestion(question, evidenceState).q,
        subject:subjectOf(question),
        required:Boolean(question.required), noSkip:Boolean(question.noSkip) })) : [],
    name_index: state.nameIndex || null,
    chat_title: state.chatTitle || '',
    user_goal: { message: fields[v3 ? 'q3_01' : 'want'], desired_outcomes: fields[v3 ? 'q3_09' : 'goal'] },
    patient: {
      alias: state.name || '그분', relationship: fields[v3 ? 'q3_02' : 'rel'],
      fields: {
        ...Object.fromEntries(questions.filter(question => subjectOf(question) === 'patient').map(question => [question.id, fields[question.id]])),
        ...Object.fromEntries(extraQuestions.filter(q=>q.subject==='patient'&&extraFields[q.id]).map(q=>[q.id,extraFields[q.id]])),
        ...(state.ans.gap_obs && gapQuestion ? { gap_obs:evidenceField(gapQuestion, state) } : {}),
      },
    },
    supporter: {
      role: 'informant',
      fields: {...Object.fromEntries(questions.filter(question => subjectOf(question) === 'supporter').map(question => [question.id, fields[question.id]])),
        ...Object.fromEntries(extraQuestions.filter(q=>q.subject==='supporter'&&extraFields[q.id]).map(q=>[q.id,extraFields[q.id]]))},
    },
    payload: { name: state.name, tags: [...state.tags], answers:v3 ? answers.filter(answer => answer.ordinary_usable !== false) : answers },
    profileInput: {
      name: state.name, rel: value(v3 ? 'q3_02' : 'rel'), contact: value('contact'), obs: state.extraObs,
      concern: value(v3 ? 'q3_03' : 'concern'), moment: value(v3 ? 'q3_05' : 'moment'), feeling: value(v3 ? 'q3_06' : 'feeling'), want: value(v3 ? 'q3_01' : 'want'),
      tags: [...state.tags], answers: Object.fromEntries(Object.entries(state.ans)
        .filter(([, answer]) => !v3 || (v3FieldStatus(answer) === 'answered' && answer.ordinary_usable !== false))
        .map(([id, answer]) => [id, answer.text])),
    },
    agent_state: state.agentMemory || null,
    ...(state.agentStateExecution?.name_reuse||state.agentStateExecution?.safety_reuse
      ?{state_execution:structuredClone(state.agentStateExecution)}:{}),
    relationship_state: state.agentRelationshipMemory || null,
    log: structuredClone(state.log), followUps: state.fuCount, model_status: state.modelStatus || 'not_connected',
  };
  if (v3) for (const report of state.v3.reports) {
    const id = `${report.question.id}_control_${report.answer.source_revision}`;
    const question = { ...report.question, id };
    context[question.subject].fields[id] = evidenceField(question, { ...state, ans:{ [id]:report.answer } });
  }
  if(state.safetySignal) {
    try {context.safety_signal=currentReviewedSafety({...context,safety_signal:state.safetySignal});}
    catch(error) {
      if(!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE')throw error;
      // Old records remain readable. Either unbound/stale verdict must be
      // independently rechecked before another final guide can use it.
      context.safety_review_required=true;
    }
  }
  return context;
}
