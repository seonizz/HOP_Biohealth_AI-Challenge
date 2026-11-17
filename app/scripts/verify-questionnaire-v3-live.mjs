import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelHttpFetch } from '../src/model-http.js';

export const BUNDLE_ID = 'malssi-intake-3.0.0-rc1';
export const MAX_HTTP_REQUESTS = 18;
const BASE_IDS = Array.from({length:9}, (_, index) => `q3_${String(index + 1).padStart(2, '0')}`);
const PERSONAL_IDS = ['q3_personal_01','q3_personal_02'];
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const kst = time => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul', dateStyle:'short', timeStyle:'medium', hour12:false}).format(new Date(time)) + ' KST';

class VerificationError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const requireValue = (condition, code) => { if (!condition) throw new VerificationError(code); };

export function configuration(options = {}) {
  const base = new URL(options.baseUrl || 'http://127.0.0.1:9000');
  requireValue(['http:','https:'].includes(base.protocol) && ['127.0.0.1','localhost','[::1]'].includes(base.hostname) &&
    !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'LOOPBACK_URL_REQUIRED');
  const values = {
    estimateMinSeconds:options.estimateMinSeconds ?? 1800,
    estimateMaxSeconds:options.estimateMaxSeconds ?? 5400,
    timeoutSeconds:options.timeoutSeconds ?? 7200,
    requestTimeoutSeconds:options.requestTimeoutSeconds ?? Math.min(1800, options.timeoutSeconds ?? 7200),
  };
  for (const value of Object.values(values)) requireValue(Number.isFinite(value) && value > 0 && value <= 86400, 'INVALID_TIME_LIMIT');
  requireValue(values.estimateMinSeconds <= values.estimateMaxSeconds, 'INVALID_ESTIMATE');
  requireValue(values.requestTimeoutSeconds <= values.timeoutSeconds, 'INVALID_TIME_LIMIT');
  return { ...values, baseUrl:base.origin,
    output:resolve(options.output || resolve(appRoot, 'runtime', `questionnaire-v3-live-${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`)) };
}

export function parseArgs(argv) {
  const names = {'--base-url':'baseUrl','--output':'output','--estimate-min-seconds':'estimateMinSeconds',
    '--estimate-max-seconds':'estimateMaxSeconds','--timeout-seconds':'timeoutSeconds','--request-timeout-seconds':'requestTimeoutSeconds'};
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]], value = argv[index + 1];
    requireValue(key && value && !value.startsWith('--') && !Object.hasOwn(options, key), 'INVALID_ARGUMENTS');
    options[key] = key.endsWith('Seconds') ? Number(value) : value;
  }
  return configuration(options);
}

const reports = {
  q3_01:'검증용 가상 상황입니다. 친구가 동호회 발표를 준비 중이라고 했어요. 제가 무리하지 않는 범위에서 말을 꺼내고 도울 방법과 대화문을 정리하고 싶어요.',
  q3_02:'실제 인물이 아닌 검증용 가상 친구와의 상황이에요.',
  q3_03:'가상 사례에서 친구는 다음 동호회 발표를 준비하면서 자료의 도입 부분에 대한 의견을 제게 부탁했어요. 아직 도와주겠다고 답하지는 않았어요.',
  q3_04:'가상 친구가 제게 직접 “도입 부분이 자연스러운지 한번 봐 줄래?”라고 말했어요.',
  q3_05:'가상 사례에서 아직 자료를 읽거나 도와주겠다고 답하지 않았어요. 그래서 그 뒤의 반응도 아직 알 수 없어요.',
  q3_06:'가상 상황에서 저는 친구를 응원하고 싶고 제 일정도 지키고 싶어요.',
  q3_07:'가상 친구는 “도입 부분에 대한 의견만 필요하고, 대신 발표문을 써 줄 필요는 없어”라고 제게 직접 말했어요.',
  q3_08:'가상 사례에서 이번 토요일 오후에 20분 정도 자료를 읽고 메시지로 의견을 전할 수 있어요. 아직 약속한 것은 아니에요.',
  q3_09:'가상 친구에게 도입 부분을 20분 정도 읽고 제 의견을 전하겠다고 제안하고 싶어요. 발표문 전체 작성은 맡지 않으려 해요.',
};

export function syntheticAnswer(question) {
  requireValue(question && (BASE_IDS.includes(question.id) || question.id === 'q3_10' || PERSONAL_IDS.includes(question.id)), 'UNREGISTERED_QUESTION');
  requireValue(nonempty(question.instance_id), 'MISSING_QUESTION_INSTANCE');
  const common = {question_id:question.id, instance_id:question.instance_id, follow_up:Boolean(question.follow_up)};
  if (PERSONAL_IDS.includes(question.id)) {
    requireValue(question.personalized === true && question.follow_up === true && question.type === 'text' && nonempty(question.q), 'INVALID_PERSONALIZED_QUESTION');
    // Unknown is honest synthetic input: never invent an answer to generated prose.
    return {...common, response_event:'unknown', text:'', selected:[], custom:'', skipped:false};
  }
  if (question.id === 'q3_10') {
    requireValue(question.follow_up === true && question.binding?.bundle_id === BUNDLE_ID &&
      ['actor','execution','source','time','agreement','modality'].includes(question.binding.axis) &&
      BASE_IDS.includes(question.binding.source_question_id) && Number.isInteger(question.binding.source_revision), 'UNBOUND_CLARIFICATION');
    return {...common, response_event:'unknown', text:'', selected:[], custom:'', skipped:false};
  }
  requireValue(!question.follow_up, 'LEGACY_FOLLOWUP');
  if (question.type === 'text') return {...common, response_event:'answered', text:reports[question.id]};
  requireValue(['one','multi'].includes(question.type) && Array.isArray(question.opts), 'INVALID_QUESTION_FORMAT');
  const preferred = {q3_01:'T6',q3_02:'friend',q3_05:'no_action_yet',q3_08:'contact'}[question.id];
  const selected = preferred ? [question.opts.findIndex(option => Array.isArray(option) && option[1]?.value === preferred)] : [];
  requireValue(selected.every(index => index >= 0), 'MISSING_QUESTION_OPTION');
  const custom = reports[question.id];
  const text = [...selected.map(index => Array.isArray(question.opts[index]) ? question.opts[index][0] : question.opts[index]), custom].join(', ');
  return {...common, response_event:'answered', selected, custom, text};
}

function questionProgress(context) {
  requireValue(context?.bundle_id === BUNDLE_ID && nonempty(context.question_set_version), 'BUNDLE_MISMATCH');
  const fields = Object.assign({}, context.patient?.fields, context.supporter?.fields);
  for (const id of BASE_IDS) requireValue(fields[id]?.id === id, 'MISSING_SOURCE_FIELD');
  const skipped = [], unasked = [];
  for (const id of BASE_IDS) {
    const field = fields[id];
    requireValue(['answered','unknown','skipped','refused','stopped','auto_skipped','not_asked'].includes(field.status), 'SOURCE_STATUS_MISMATCH');
    if (!['auto_skipped','not_asked'].includes(field.status)) continue;
    requireValue(!nonempty(field.text) && !nonempty(field.rawText) && !nonempty(field.custom), 'FABRICATED_UNANSWERED_SOURCE');
    (field.status === 'auto_skipped' ? skipped : unasked).push(id);
  }
  return {skipped_question_ids:skipped, unasked_question_ids:unasked};
}

export function verifyContext(context, submitted) {
  const progress = questionProgress(context);
  requireValue(context.user_stopped !== true, 'UNEXPECTED_STOP');
  const fields = Object.assign({}, context.patient?.fields, context.supporter?.fields);
  for (const id of [...BASE_IDS,'q3_10',...PERSONAL_IDS]) {
    const field = fields[id], input = submitted.get(id);
    if (!input) {
      if (field) requireValue(['not_asked','auto_skipped'].includes(field.status) &&
        !nonempty(field.text) && !nonempty(field.rawText) && !nonempty(field.custom), 'FABRICATED_UNANSWERED_SOURCE');
      continue;
    }
    requireValue(field && (id === 'q3_10' || PERSONAL_IDS.includes(id) ? field.status === 'unknown' : field.status === 'answered'), 'SOURCE_STATUS_MISMATCH');
    if (nonempty(input.text)) requireValue(field.rawText === input.text, 'SOURCE_TEXT_MISMATCH');
    if (input.custom !== undefined) requireValue((field.custom || '') === input.custom, 'SOURCE_TEXT_MISMATCH');
    if (PERSONAL_IDS.includes(id)) requireValue(field.response_event === 'unknown' && field.personalization?.kind === 'follow_up' &&
      submitted.has(field.personalization.source_question_id) && field.assignment === undefined, 'UNBOUND_PERSONALIZED_QUESTION');
    if (id === 'q3_10') requireValue(field.response_event === 'unknown' && field.assignment?.value === 'unknown', 'CLARIFICATION_NOT_UNKNOWN');
  }
  requireValue(Array.isArray(context.payload?.answers) && context.payload.answers.every(answer => submitted.has(answer.id)), 'FABRICATED_UNANSWERED_SOURCE');
  requireValue(Object.values(context.profileInput?.answers || {}).some(text => text.includes('검증용 가상 상황')), 'SYNTHETIC_MARKER_MISSING');
  return progress;
}

export function verifyRecord(record, submitted) {
  requireValue(record && /^\d+$/.test(String(record.id)), 'INVALID_RECORD_ID');
  const guide = record.guide;
  requireValue(guide && nonempty(guide.top) && nonempty(guide.script) && nonempty(guide.next) && nonempty(guide.care?.feel) &&
    [guide.doList, guide.avoid, guide.care?.tips].every(list => Array.isArray(list) && list.length > 0 && list.every(nonempty)), 'INVALID_CARD_SHAPE');
  requireValue(record.provenance?.kind === 'model' && nonempty(record.provenance.model), 'MODEL_PROVENANCE_MISSING');
  return verifyContext(record.context, submitted);
}

async function atomicFile(path, contents) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, {mode:0o600, flag:'wx'});
  await rename(temporary, path);
}

function statusMarkdown(state) {
  const stages = state.stages.map(stage => `- ${stage.at}: ${stage.stage}${stage.question_id ? ` (${stage.question_id})` : ''}`).join('\n');
  return `# 말씨 v3 실제 대화 검증\n\n상태: ${state.status}\n\n현재 단계: ${state.stage}\n\n` +
    `시작: ${state.started_at}\n\n최근 갱신: ${state.updated_at}\n\n예상 완료: ${state.estimated_finish.earliest} ~ ${state.estimated_finish.latest}\n\n` +
    `최대 실행 종료: ${state.deadline_at}\n\n예상 시간은 초기 로컬 모델 측정 기반의 범위이며 완료 보장이 아닙니다.\n\n` +
    `PID: ${state.pid}\n\nHTTP 요청: ${state.request_count}/${MAX_HTTP_REQUESTS}\n\n` +
    `검증 대화: ${state.intake_id || '아직 없음'}\n\n저장 기록: ${state.record_id || '아직 없음'}\n\n` +
    (state.question_progress.status === 'verified'
      ? `확인된 자동 생략: ${state.skipped_question_ids.join(', ') || '없음'}\n\n아직 묻지 않은 문항: ${state.unasked_question_ids.join(', ') || '없음'}\n\n`
      : '자동 생략·미질문 진행 상태: 미확인\n\n') +
    (state.error ? `실패 코드: ${state.error.code}${state.error.http_status ? ` (HTTP ${state.error.http_status})` : ''}\n\n` : '') +
    `별도 세션의 가상 사례만 사용합니다. 모델 응답의 임상적 정확도를 평가하는 검사는 아닙니다.\n\n${stages}\n`;
}

export async function runVerification(options, {fetchImpl = modelHttpFetch, onStart = () => {}} = {}) {
  const config = configuration(options);
  await mkdir(config.output, {recursive:true, mode:0o700});
  // Never overwrite another run or issue a second conversation under the same output path.
  const lock = await open(resolve(config.output, '.run.lock'), 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
  const started = Date.now(), deadline = started + config.timeoutSeconds * 1000;
  const state = {schema_version:'1.0', run_id:randomUUID(), verification:'v3_live_conversation_and_saved_record', synthetic:true,
    status:'initializing', stage:'initializing', pid:process.pid, timezone:'Asia/Seoul', base_url:config.baseUrl,
    started_at:kst(started), updated_at:kst(started), deadline_at:kst(deadline),
    estimated_finish:{earliest:kst(started + config.estimateMinSeconds * 1000), latest:kst(started + config.estimateMaxSeconds * 1000),
      min_seconds:config.estimateMinSeconds, max_seconds:config.estimateMaxSeconds, basis:'initial_local_model_measurement_heuristic'},
    request_timeout_seconds:config.requestTimeoutSeconds, request_count:0, answered_question_ids:[], skipped_question_ids:[], unasked_question_ids:[],
    question_progress:{status:'unverified'}, stages:[], checks:[]};
  let cookie, csrf;
  const saveStatus = async (stage, detail = {}) => {
    Object.assign(state, detail, {stage, updated_at:kst(Date.now()), elapsed_seconds:Math.round((Date.now() - started) / 1000)});
    state.stages.push({stage, at:state.updated_at, ...(detail.question_id ? {question_id:detail.question_id} : {})});
    await atomicFile(resolve(config.output, 'status.json'), JSON.stringify(state, null, 2) + '\n');
    await atomicFile(resolve(config.output, 'status.md'), statusMarkdown(state));
  };
  const request = async (path, method = 'GET', body, maxTimeoutMs = Infinity) => {
    requireValue(state.request_count < MAX_HTTP_REQUESTS, 'REQUEST_LIMIT');
    const remaining = deadline - Date.now();
    requireValue(remaining > 0, 'OVERALL_TIMEOUT');
    state.request_count++;
    const controller = new AbortController();
    const timeoutMs = Math.min(config.requestTimeoutSeconds * 1000, remaining, maxTimeoutMs);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new VerificationError(timeoutMs === remaining ? 'OVERALL_TIMEOUT' : 'REQUEST_TIMEOUT');
        reject(error);
        controller.abort(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(config.baseUrl + path, {method, redirect:'error', signal:controller.signal,
          headers:{'content-type':'application/json', ...(cookie ? {cookie, 'x-csrf-token':csrf} : {})},
          ...(body === undefined ? {} : {body:JSON.stringify(body)})});
        const raw = await response.text();
        requireValue(raw.length <= 8 * 1024 * 1024, 'RESPONSE_TOO_LARGE');
        let data;
        try { data = JSON.parse(raw); } catch { throw new VerificationError('INVALID_JSON_RESPONSE', response.status); }
        if (!response.ok) {
          const code = typeof data?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.error.code) ? data.error.code : 'HTTP_ERROR';
          throw new VerificationError(code, response.status);
        }
        if (path === '/api/bootstrap') {
          const setCookie = response.headers.get('set-cookie');
          cookie = setCookie?.split(';')[0];
          csrf = data.csrf_token;
          requireValue(/^malssi_session=[A-Za-z0-9_-]+$/.test(cookie || '') && nonempty(csrf), 'SESSION_NOT_CREATED');
        }
        return data;
      })()]);
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError('NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  };
  try {
    await saveStatus('initializing');
    onStart({status:'running', pid:state.pid, output:config.output, started_at:state.started_at,
      estimated_finish:structuredClone(state.estimated_finish), deadline_at:state.deadline_at});
    state.status = 'running';
    await saveStatus('bootstrap');
    const bootstrap = await request('/api/bootstrap');
    requireValue(bootstrap.model_connected === true, 'MODEL_NOT_CONNECTED');
    requireValue(Array.isArray(bootstrap.questions) && isDeepStrictEqual(bootstrap.questions.map(q => q.id), BASE_IDS) &&
      bootstrap.questions.every((q, index) => q.source_id === `Q3-${String(index + 1).padStart(2,'0')}`), 'QUESTION_BANK_MISMATCH');
    requireValue(Number.isInteger(bootstrap.conversation_epoch), 'INVALID_CONVERSATION_EPOCH');
    state.checks.push('v3_question_bank');
    await saveStatus('create_intake');
    let view = await request('/api/intakes', 'POST', {conversation_epoch:bootstrap.conversation_epoch});
    requireValue(typeof view.id === 'string' && /^[0-9a-f-]{36}$/.test(view.id), 'INVALID_INTAKE_ID');
    state.intake_id = view.id;
    const submitted = new Map();
    while (view.status === 'active') {
      requireValue(view.bundle_id === BUNDLE_ID && Number.isInteger(view.revision) && view.revision >= 0, 'BUNDLE_MISMATCH');
      requireValue(view.user_stopped !== true && view.input_locked !== true && view.model_pending !== true, 'UNEXPECTED_PENDING_STATE');
      const limit = view.maxQuestions ?? 10;
      requireValue([10,12].includes(limit) && submitted.size < limit && Number.isInteger(view.question_instances) && view.question_instances <= limit, 'QUESTION_LIMIT');
      const input = syntheticAnswer(view.question);
      requireValue(!submitted.has(input.question_id), 'REPEATED_QUESTION');
      if (input.question_id === 'q3_10') requireValue(submitted.has(view.question.binding.source_question_id), 'UNBOUND_CLARIFICATION');
      await saveStatus('answer_question', {question_id:input.question_id});
      const next = await request(`/api/intakes/${state.intake_id}/answers`, 'POST', {...input,revision:view.revision});
      requireValue(next.id === state.intake_id && Number.isInteger(next.revision) && next.revision > view.revision, 'REVISION_NOT_ADVANCED');
      submitted.set(input.question_id, input);
      state.answered_question_ids = [...submitted.keys()];
      view = next;
    }
    requireValue(view.status === 'ready' && view.bundle_id === BUNDLE_ID && view.user_stopped !== true && submitted.has('q3_01') &&
      view.question_instances <= (view.maxQuestions ?? 10) && [10,12].includes(view.maxQuestions ?? 10) && view.model_pending !== true, 'INTAKE_NOT_READY');
    state.checks.push('bounded_adaptive_conversation');
    await saveStatus('verify_input_context');
    const context = await request(`/api/intakes/${state.intake_id}/context`);
    Object.assign(state, verifyContext(context.context, submitted), {question_progress:{status:'verified', source:'input_context'}});
    state.checks.push('exact_submitted_sources', 'unasked_sources_not_fabricated');
    await saveStatus('generate_result');
    const generated = await request(`/api/intakes/${state.intake_id}/result`, 'POST', {revision:view.revision});
    if (/^\d+$/.test(String(generated.record?.id))) state.record_id = String(generated.record.id);
    verifyRecord(generated.record, submitted);
    state.guide_sha256 = createHash('sha256').update(JSON.stringify(generated.record.guide)).digest('hex');
    state.checks.push('nonempty_result_cards', 'model_provenance');
    await saveStatus('verify_saved_record');
    const saved = await request(`/api/records/${state.record_id}`);
    verifyRecord(saved.record, submitted);
    requireValue(isDeepStrictEqual(saved.record, generated.record), 'RECORD_MISMATCH');
    await atomicFile(resolve(config.output, 'result.json'), JSON.stringify(saved.record, null, 2) + '\n');
    await saveStatus('verify_records_list');
    const history = await request('/api/records');
    requireValue(Array.isArray(history.records) && history.records.some(record => String(record.id) === state.record_id), 'RECORD_NOT_LISTED');
    requireValue(!history.incomplete_intakes?.some(intake => intake.id === state.intake_id), 'INTAKE_STILL_INCOMPLETE');
    state.checks.push('saved_record_exact_match', 'saved_record_listed');
    state.status = 'passed';
    await saveStatus('complete', {completed_at:kst(Date.now())});
  } catch (error) {
    state.status = 'failed';
    state.error = {code:error instanceof VerificationError ? error.code : 'RUNNER_ERROR',
      ...(error instanceof VerificationError && error.httpStatus ? {http_status:error.httpStatus} : {})};
    // A failed answer may follow independently approved skips. Read only this
    // intake once, within the existing request/deadline limits, and never turn
    // an unacknowledged answer into a successfully submitted answer.
    if (state.stage === 'answer_question' && error instanceof VerificationError && error.httpStatus &&
        state.intake_id && state.request_count < MAX_HTTP_REQUESTS && deadline > Date.now()) {
      try {
        const progress = await request(`/api/intakes/${state.intake_id}/context`, 'GET', undefined, 3000);
        requireValue(progress.id === state.intake_id, 'INVALID_INTAKE_ID');
        Object.assign(state, questionProgress(progress.context), {question_progress:{status:'verified', source:'failure_context'}});
      } catch (progressError) {
        state.question_progress = {status:'unavailable', code:progressError instanceof VerificationError ? progressError.code : 'RUNNER_ERROR'};
      }
    }
    await saveStatus('failed', {failed_stage:state.stage, completed_at:kst(Date.now())});
  }
  await atomicFile(resolve(config.output, 'report.json'), JSON.stringify(state, null, 2) + '\n');
  return structuredClone(state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runVerification(options, {onStart:state => console.log(JSON.stringify({event:'verification_started', ...state}))});
    console.log(JSON.stringify({status:report.status, stage:report.stage, report_path:resolve(options.output,'report.json'),
      intake_id:report.intake_id || null, record_id:report.record_id || null, ...(report.error ? {error:report.error} : {})}));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({status:'failed', error:{code:error instanceof VerificationError ? error.code : error?.code === 'EEXIST' ? 'OUTPUT_ALREADY_USED' : 'RUNNER_START_FAILED'}}));
    process.exitCode = 1;
  }
}
