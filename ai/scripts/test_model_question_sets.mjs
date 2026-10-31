import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createIntake, createTestIntake, buildContext, applyModelUpdate } from '../../app/src/intake.js';
import { initialQuestionSet, createQuestionSet, questionCatalogOf } from '../../app/src/question-bank.js';
import { configuredModelGateway } from '../../app/src/model-config.js';
import { PROMPT_VERSION } from '../../app/src/relationship-prompts.js';
import { sourceFingerprint } from '../../app/src/source-identity.js';
import { attemptMetrics, percentile, sha256 } from './evaluation_evidence.mjs';
import { applyFinalResult, runIntakeWorkflow, workflowAnswerSlots } from './model_test_workflow.mjs';
import { observeGateway } from './model_test_observer.mjs';

const root = resolve(import.meta.dirname, '../..');
const privateRoot = join(root, 'ai/outputs/model-tests/private');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'MODEL_TEST_ERROR';
const traceEvents = new Set(['model_attempt', 'model_retry_wait', 'model_request_failure']);

// Validate the batch before any request. Workflow semantics are validated by
// the app when it chooses each question; only structure is knowable upfront.
export function prepareSuite(data, questionSet = initialQuestionSet, mode = 'final') {
  if (!['final','state','workflow'].includes(mode)) fail('INVALID_RUN_OPTIONS');
  if (!exact(data, ['cases']) || !Array.isArray(data.cases) || !data.cases.length || data.cases.length > 100) fail('INVALID_SUITE');
  const ids = new Set();
  return data.cases.map(item => {
    if (!exact(item, ['id', 'answers', 'expectations']) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id) || ids.has(item.id)) fail('INVALID_CASE_ID');
    ids.add(item.id);
    const expectations = item.expectations === undefined ? [] : item.expectations;
    if (!Array.isArray(expectations) || expectations.length > 100) fail('INVALID_EXPECTATIONS');
    for (const check of expectations) {
      if (!exact(check, ['path', 'operator', 'value']) || typeof check.path !== 'string' || check.path.length > 200 ||
          !check.path.split('.').every(key => /^[a-zA-Z0-9_]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)) ||
          !['equals', 'contains', 'not_contains', 'exists'].includes(check.operator)) fail('INVALID_EXPECTATION');
      if (check.operator === 'exists' ? Object.hasOwn(check, 'value') : !Object.hasOwn(check, 'value')) fail('INVALID_EXPECTATION_VALUE');
      if (['contains', 'not_contains'].includes(check.operator) && (typeof check.value !== 'string' || !check.value)) fail('INVALID_EXPECTATION_VALUE');
    }
    if (mode === 'workflow') {
      if (!Array.isArray(item.answers) || !item.answers.length || item.answers.length > 400) fail('INVALID_WORKFLOW_ANSWERS');
      const slotKey = answer => JSON.stringify([answer.question_id,Boolean(answer.follow_up)]);
      const allowed = new Set(workflowAnswerSlots(questionSet).map(slotKey)), seen = new Set();
      for (const answer of item.answers) {
        if (!exact(answer, ['question_id','text','selected','custom','skipped','follow_up']) ||
            typeof answer.question_id !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(answer.question_id) ||
            ['text','custom'].some(key => answer[key] !== undefined && (typeof answer[key] !== 'string' || answer[key].length > 10000)) ||
            ['skipped','follow_up'].some(key => answer[key] !== undefined && typeof answer[key] !== 'boolean') ||
            answer.selected !== undefined && (!Array.isArray(answer.selected) || answer.selected.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(answer.selected).size !== answer.selected.length)) fail('INVALID_WORKFLOW_ANSWER');
        const key = slotKey(answer);
        if (!allowed.has(key)) fail('UNKNOWN_WORKFLOW_QUESTION');
        if (seen.has(key)) fail('DUPLICATE_WORKFLOW_ANSWER');
        seen.add(key);
      }
    }
    const state = mode === 'workflow' ? createIntake(questionSet) : createTestIntake(item.answers, questionSet);
    const context = buildContext(state);
    return { id:item.id, context, state, questionSet, answers:structuredClone(item.answers), expectations,
      input_sha256:sha256(JSON.stringify(item.answers)) };
  });
}

export function checkExpectations(result, expectations) {
  return expectations.map(check => {
    let actual = result, found = true;
    for (const key of check.path.split('.')) {
      if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key)) { found = false; actual = undefined; break; }
      actual = actual[key];
    }
    const passed = found && (check.operator === 'exists' ? true : check.operator === 'equals'
      ? isDeepStrictEqual(actual, check.value) : typeof actual === 'string' &&
        (check.operator === 'contains' ? actual.includes(check.value) : !actual.includes(check.value)));
    return { ...check, passed, found, ...(found ? {actual} : {}) };
  });
}

export function summarize(results, planned) {
  const checked = results.filter(row => ['passed','failed'].includes(row.status) && row.checks.length);
  const passed = checked.filter(row => row.status === 'passed').length;
  const totalTokens = key => results.length && results.every(row => Number.isFinite(row.metrics[key]))
    ? results.reduce((sum, row) => sum + row.metrics[key], 0) : null;
  return {
    planned, finished:results.length, passed,
    failed:results.filter(row => row.status === 'failed').length,
    errors:results.filter(row => row.status === 'error').length,
    awaiting_input:results.filter(row => row.status === 'awaiting_input').length,
    without_expectations:results.filter(row => row.status === 'completed').length,
    expectation_pass_rate:checked.length ? passed / checked.length : null,
    expectation_pass_rate_denominator:checked.length,
    safety_flagged:results.filter(row => row.result?.assessment?.safety === true).length,
    prompt_tokens:totalTokens('prompt_tokens'), completion_tokens:totalTokens('completion_tokens'),
    elapsed_p50_ms:percentile(results.map(row => row.duration_ms), 0.5),
    elapsed_p95_ms:percentile(results.map(row => row.duration_ms), 0.95),
    human_review:'pending', clinical_effectiveness_verified:false, competition_score:null,
  };
}

// Each case/repetition gets a fresh gateway: no memory or token-policy cache leaks
// between independent cases. No database, service session or saved record is used.
export async function runSuite(cases, { env = process.env, mode = 'final', repeat = 1, timeoutMs = 600000,
  gatewayFactory = configuredModelGateway, onResult = () => {}, signal } = {}) {
  if (!['final', 'state', 'workflow'].includes(mode) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) fail('INVALID_RUN_OPTIONS');
  const results = [];
  for (const item of cases) for (let repetition = 1; repetition <= repeat; repetition++) {
    if (signal?.aborted) return results;
    const trace = [], progress = [], cards = [];
    // Keep the application's retry policy and scheduler. The outer deadline is
    // only a test-run bound; the runner never dictates calls, stages or order.
    const gateway = gatewayFactory({ env, diagnosticLogger:event => trace.push(structuredClone(event)) });
    if (!gateway) fail('MODEL_NOT_CONFIGURED');
    const observer = observeGateway(gateway);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('CASE_TIMEOUT'), {code:'CASE_TIMEOUT'})), timeoutMs);
    const caseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const started = performance.now();
    const row = { case_id:item.id, repetition, request_id:randomUUID(), mode, input_sha256:item.input_sha256,
      context_sha256:sha256(JSON.stringify(item.context)), answered_count:item.context.answered_count,
      model_requested:gateway.model, protocol:gateway.protocol, checks:[], trace, progress, cards, turns:[] };
    try {
      const options = {
        requestId:row.request_id, signal:caseSignal,
        onProgress:event => progress.push({elapsed_ms:Math.round(performance.now() - started), ...structuredClone(event)}),
        onCard:event => cards.push({elapsed_ms:Math.round(performance.now() - started), ...structuredClone(event)}),
      };
      if (mode === 'workflow') {
        const outcome = await runIntakeWorkflow({answers:item.answers, questionSet:item.questionSet, gateway, options,
          onCheckpoint:(workflow, result) => {
            row.workflow = workflow;
            row.turns = workflow.turns;
            row.answered_count = workflow.answered_count;
            row.result = result;
            row.result_scope = result ? 'last_applied_turn' : 'none';
          }});
        row.result = outcome.result;
        row.result_scope = outcome.workflow.completed ? 'final' : outcome.result ? 'last_applied_turn' : 'none';
        row.workflow = outcome.workflow;
        row.answered_count = outcome.workflow.answered_count;
        if (outcome.awaitingInput) row.status = 'awaiting_input';
      } else {
        row.result = await gateway[mode === 'state' ? 'updateState' : 'respond'](structuredClone(item.context), null, options);
        caseSignal.throwIfAborted();
        if (mode === 'final') applyFinalResult(item.state, row.result);
        else applyModelUpdate(item.state, row.result);
        row.app_state_applied = true;
      }
      caseSignal.throwIfAborted();
      if (row.status !== 'awaiting_input') {
        row.checks = checkExpectations(row.result, item.expectations);
        row.status = !row.checks.length ? 'completed' : row.checks.every(check => check.passed) ? 'passed' : 'failed';
      }
    } catch (error) {
      row.status = 'error';
      // Raw exception messages can contain URLs, response bodies or credentials.
      row.error_code = signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'CASE_TIMEOUT' : codeOf(error);
    } finally { clearTimeout(timer); }
    row.duration_ms = Math.round(performance.now() - started);
    row.metrics = attemptMetrics(trace.filter(event => traceEvents.has(event.event)));
    row.metrics.excluded_diagnostic_events = trace.filter(event => !traceEvents.has(event.event)).length;
    row.http = {calls:observer.httpCalls, summary:observer.snapshot()};
    row.stages = [...new Set(trace.map(event => event.generation).filter(Boolean))];
    results.push(row);
    await onResult(row, results);
  }
  return results;
}

const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';

function atomicWrite(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, {mode:0o600,flag:'wx'});
    renameSync(temporary, path);
  } finally { rmSync(temporary, {force:true}); }
}
export function renderCsv(results) {
  const columns = ['case_id', 'repetition', 'status', 'error_code', 'answered_count', 'duration_ms',
    'safety', 'checks_passed', 'checks_total', 'http_calls', 'model_http_calls', 'peak_http_until_headers',
    'attempts', 'retries', 'prompt_tokens', 'completion_tokens'];
  return [columns, ...results.map(row => [row.case_id, row.repetition, row.status, row.error_code, row.answered_count,
    row.duration_ms, row.result?.assessment?.safety, row.checks.filter(check => check.passed).length, row.checks.length,
    row.http?.summary.total, row.http?.summary.by_route.chat_completions || 0, row.http?.summary.peak_outstanding_until_headers,
    row.metrics.attempts, row.metrics.retries, row.metrics.prompt_tokens, row.metrics.completion_tokens])]
    .map(cells => cells.map(csvCell).join(',')).join('\n') + '\n';
}

export function writeReports(directory, identity, results, planned, status) {
  const summary = summarize(results, planned);
  const report = { schema_version:'malssi-model-question-tests-v2', status, identity, summary, results };
  const json = JSON.stringify(report, null, 2) + '\n';
  atomicWrite(join(directory, 'results.csv'), '\uFEFF' + renderCsv(results));
  const rows = results.map(row => `| ${row.case_id} | ${row.repetition} | ${row.status} | ${row.checks.filter(check => check.passed).length}/${row.checks.length} | ${row.error_code || '—'} |`);
  atomicWrite(join(directory, 'summary.md'), [
    '# AI 질문셋 테스트 결과', '', `상태: ${status} · 완료: ${summary.finished}/${planned}`,
    `기대값 통과: ${summary.passed} · 불일치: ${summary.failed} · 실행 오류: ${summary.errors} · 입력 대기: ${summary.awaiting_input} · 기대값 없음: ${summary.without_expectations}`, '',
    '| 사례 | 반복 | 결과 | 기대값 검사 | 오류 |', '|---|---:|---|---:|---|', ...rows, '',
    '전체 생성 결과·상태·근거·단계별 진단은 report.json, 수치 비교는 results.csv를 확인하세요.',
    'completed는 생성 완료이며 품질 합격을 뜻하지 않습니다. 오류 사례는 기대값 통과율 분모에서 제외되어 errors로 별도 집계합니다.',
    '토큰 미제공·진단 불완전 시 수치는 null( CSV에서는 빈 칸 )입니다. 시간은 참고 측정이며 대회 점수가 아닙니다.',
    '키워드·필드 검사만으로 사실성, 상담 적절성, 임상 효과를 증명하지 않습니다. 사람 검토: 대기.', '',
  ].join('\n'));
  // report.json is the canonical snapshot. Publish it only after both derived
  // files are written, and never expose a truncated JSON document to readers.
  atomicWrite(join(directory, 'report.json'), json);
  return report;
}

function readJson(path) {
  if (statSync(path).size > 5 * 1024 * 1024) fail('INPUT_TOO_LARGE');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('INVALID_JSON'); }
}

const example = {cases:[{id:'synthetic_friend', answers:[
  {question_id:'name', text:'테스트 친구'},
  {question_id:'want', text:'부담을 주지 않고 이야기를 듣고 싶어요.'},
  {question_id:'rel', selected:[4]},
  {question_id:'concern', text:'최근 일이 많아 피곤하다고 말했어요. 다른 상황은 아직 몰라요.'},
  {question_id:'feeling', text:'걱정되지만 내 생각으로 단정하고 싶지는 않아요.'},
], expectations:[{path:'guide.script', operator:'exists'}, {path:'assessment.safety', operator:'equals', value:false}]}]};

export async function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({args:argv, options:{
    input:{type:'string'}, questions:{type:'string'}, mode:{type:'string', default:'final'},
    repeat:{type:'string', default:'1'}, 'timeout-ms':{type:'string', default:'600000'},
    'dry-run':{type:'boolean'}, 'list-questions':{type:'boolean'}, init:{type:'boolean'}, help:{type:'boolean'}, describe:{type:'boolean'},
  }});
  if (values.describe) {
    console.log(JSON.stringify({tool:'malssi-model-question-tests', version:2,
      commands:{questions:['node','ai/scripts/test_model_question_sets.mjs','--list-questions'],
        template:['node','ai/scripts/test_model_question_sets.mjs','--init'],
        validate:['node','ai/scripts/test_model_question_sets.mjs','--input','INPUT.json','--mode','workflow','--dry-run'],
        validate_snapshot:['node','ai/scripts/test_model_question_sets.mjs','--input','INPUT.json','--mode','final','--dry-run'],
        run:['node','--env-file-if-exists=app/.env','ai/scripts/test_model_question_sets.mjs','--input','INPUT.json','--mode','workflow'],
        snapshot:['node','--env-file-if-exists=app/.env','ai/scripts/test_model_question_sets.mjs','--input','INPUT.json','--mode','final']},
      input_schema:readJson(join(root, 'ai/docs/model_question_tests.schema.json')),
      output_format:'JSONL stdout; report.json contains full generated results and assertion details',
      modes:{final:'App final response from a complete input snapshot; applies final state validation',
        state:'State/memory from a complete snapshot; no active next-question candidates',
        workflow:'Actual app question selection, pending answer, state update, memory application and final response; pauses for missing answers'},
      workflow_boundaries:{shared:['intake','question routing','model gateway','review','state application'],
        excluded:['HTTP auth/CSRF','database persistence','record retrieval','UI rendering'],
        scheduling:'Application-owned; call counts and parallel ordering are observed, never prescribed'},
      limits:{cases:100, repeat:20, input_bytes:5242880, case_timeout_ms:86400000},
      exit_codes:{0:'Validated input or generation finished without errors/failed expectations; not a quality certification',
        1:'Model error or expectation mismatch; inspect report.json', 2:'Invalid input, configuration or runner error',
        3:'Workflow needs an explicitly supplied answer; inspect results[].workflow.next_question', 130:'Cancelled; inspect partial report'},
      data_policy:'Inputs and raw outputs stay local; never commit them. Omitted answers are not invented.',
    }));
    return 0;
  }
  if (values.help) {
    console.log('npm run ai:model-test -- --input FILE [--mode final|state|workflow] [--repeat 1..20] [--timeout-ms 600000] [--dry-run] [--questions ROWS.json]\n--describe: machine-readable agent contract and input JSON Schema\n--init: create a local synthetic input template\n--list-questions: print app question IDs and choices\nReports: ai/outputs/model-tests/private/<run>/');
    return 0;
  }
  const commands = [values.init, values['list-questions'], Boolean(values.input)].filter(Boolean).length;
  if (commands !== 1) fail('CHOOSE_INPUT_INIT_OR_LIST_QUESTIONS');
  const questionSet = values.questions ? createQuestionSet(readJson(resolve(values.questions))) : initialQuestionSet;
  if (values['list-questions']) { console.log(JSON.stringify({status:'questions', version:questionSet.version,
    questions:questionCatalogOf(questionSet), workflow_answer_slots:workflowAnswerSlots(questionSet)})); return 0; }
  if (values.init) {
    if (values.questions) fail('INIT_USES_DEFAULT_QUESTIONS');
    mkdirSync(privateRoot, {recursive:true, mode:0o700});
    const path = join(privateRoot, `questions-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(example, null, 2) + '\n', {mode:0o600, flag:'wx'});
    console.log(JSON.stringify({status:'input_template_created', input:path})); return 0;
  }
  const repeat = Number(values.repeat), timeoutMs = Number(values['timeout-ms']), mode = values.mode;
  if (!['final', 'state', 'workflow'].includes(mode) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) fail('INVALID_RUN_OPTIONS');
  const data = readJson(resolve(values.input));
  const cases = prepareSuite(data, questionSet, mode);
  if (values['dry-run']) {
    console.log(JSON.stringify({status:'input_validated', model_called:false, validation_scope:mode === 'workflow' ? 'structure_and_question_slots' : 'all_snapshot_answers', mode, repeat, planned:cases.length * repeat,
      question_version:questionSet.version, cases:cases.map(item => ({id:item.id, answered_count:item.context.answered_count, expectations:item.expectations.length}))}));
    return 0;
  }
  // Configuration validation does not call the model. Never persist env or keys.
  const gateway = configuredModelGateway({diagnosticLogger:null});
  if (!gateway) fail('MODEL_NOT_CONFIGURED');
  const describe = model => ({model_requested:model.model, protocol:model.protocol,
    endpoint_sha256:sha256(model.baseUrl), agent_format:model.agentFormat, state_mode:model.stateMode,
    reasoning_effort:model.reasoningEffort, discover_token_limits:model.discoverTokenLimits,
    api_profile:model.apiProfile, runtime_model_identity_verified:false});
  const identity = {started_at:new Date().toISOString(), input_sha256:sha256(JSON.stringify(data)),
    questions_sha256:questionSet.version, prompt_version:PROMPT_VERSION, source:sourceFingerprint(join(root, 'app')),
    runner_sha256:sha256(readFileSync(new URL(import.meta.url))),
    runner_modules:Object.fromEntries(['model_test_workflow.mjs','model_test_observer.mjs','evaluation_evidence.mjs'].map(name =>
      [name,sha256(readFileSync(new URL(name,import.meta.url)))])),
    writer:describe(gateway), reviewer:gateway.reviewGateway ? describe(gateway.reviewGateway) : null,
    mode, repeat, case_timeout_ms:timeoutMs, independent_test:false};
  mkdirSync(privateRoot, {recursive:true, mode:0o700});
  const directory = mkdtempSync(join(privateRoot, 'run-'));
  chmodSync(directory, 0o700);
  const planned = cases.length * repeat;
  writeReports(directory, identity, [], planned, 'running');
  console.log(JSON.stringify({status:'running', planned, output:directory}));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const results = await runSuite(cases, {mode, repeat, timeoutMs, signal:controller.signal, onResult:(_row, rows) => {
      writeReports(directory, identity, rows, planned, 'running');
      console.log(JSON.stringify({finished:rows.length, planned, status:_row.status}));
    }});
    const status = controller.signal.aborted ? 'cancelled' : 'finished';
    const report = writeReports(directory, identity, results, planned, status);
    console.log(JSON.stringify({status, output:directory,
      artifacts:{report:join(directory,'report.json'), csv:join(directory,'results.csv'), summary:join(directory,'summary.md')}, summary:report.summary}));
    return controller.signal.aborted ? 130 : results.some(row => ['error', 'failed'].includes(row.status)) ? 1
      : results.some(row => row.status === 'awaiting_input') ? 3 : 0;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(JSON.stringify({status:'error', code:codeOf(error)})); process.exitCode = 2; }
}
