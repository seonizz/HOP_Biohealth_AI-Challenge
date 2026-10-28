import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAnswerField } from '../app/src/answer-sources.js';
import { createIntake, answerIntake, currentView, backIntake, buildContext } from '../app/src/intake.js';
import { validateEvidence } from '../app/src/relationship-agent.js';
import { sourceDocuments } from '../app/src/relationship-retrieval.js';
import { sourceFingerprint } from '../app/src/source-identity.js';
import { Store } from '../app/src/store.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const field = (id, text, extra = {}) => ({ id, question:id, status:'answered', text,
  rawText:text, custom:'', selected:[], ...extra });
const context = (patient = {}, supporter = {}) => ({ patient:{ fields:patient },
  supporter:{ fields:supporter }, user_goal:{} });
const reference = (subject, question_id, quote) => ({ subject, question_id, quote });

// Authored for app contract checks. These are not counselling data or human observations.
export const SCENARIOS = Object.freeze([
  { id:'FC01', task:'현재 원문 찾기', observation:'지난 목요일 동료가 점심 모임에 나오지 않았어요.',
    manual:'관찰 항목에 원문과 출처 위치를 함께 적으면 같은 연결을 표현할 수 있다.' },
  { id:'FC02', task:'두 사람의 관점 구분', observation:'동생이 주말 약속을 다음 주로 옮겼어요.',
    feeling:'제가 말을 잘못 꺼낼까 걱정돼요.',
    manual:'관찰과 나의 감정을 별도 항목에 두고 작성자가 주체를 대조할 수 있다.' },
  { id:'FC03', task:'모름과 직접 전한 사실 보존', observation:'도움을 받는지는 모르지만 어제 도서관에 갔다고 들었어요.',
    manual:'모르는 부분과 직접 들은 사실을 각각 적을 수 있다.' },
  { id:'FC04', task:'모름만 있는 답변',
    manual:'모름을 그대로 두고 관찰 사실을 추가하지 않을 수 있다.' },
  { id:'FC05', task:'정정 후 현재 근거', observation:'지난 금요일 모임에 오지 않았어요.',
    correction:'일정을 잘못 알았고 모임에는 참석했어요.',
    manual:'정정문과 이전 내용의 폐기 여부를 직접 표시하고 관련 메모도 갱신할 수 있다.' },
  { id:'FC06', task:'미응답을 사실로 만들지 않기', observation:'이 문장은 아직 답변으로 제출되지 않았어요.',
    manual:'미응답·생략·거절을 사실과 구분해 표시할 수 있다.' },
  { id:'FC07', task:'입력에 없는 원문 인용', observation:'친구가 이번 주 약속 시간을 바꾸었어요.',
    invented:'친구가 매일 아침 수영한다고 했어요.',
    manual:'작성자가 원문을 대조해 없는 문장을 제외할 수 있다.' },
  { id:'FC08', task:'전체 삭제의 소유자 인자',
    manual:'자신이 관리하는 문서·첨부·사본을 확인해 직접 삭제할 수 있다. 범위는 도구 설정에 따른다.' },
]);

function quoteOutcome(validate, ref, input) {
  try { validate(ref, input); return 'accepted'; }
  catch (error) {
    if (error.code === 'MODEL_INVALID_RESPONSE' && error.modelReason === 'agent_evidence') return 'rejected';
    throw error;
  }
}

export async function runComparison({ validate = validateEvidence, documents = sourceDocuments,
  removeConversations = Store.prototype.removeConversations } = {}) {
  const before = sourceFingerprint(resolve(ROOT, 'app'));
  const checks = [];
  const check = (id, name, expected, actual) => {
    checks.push({ scenario_id:id, name, expected, observed:actual,
      passed:JSON.stringify(expected) === JSON.stringify(actual) });
  };
  const [current, perspectives, mixed, unknown, correction, unanswered, invented, deletion] = SCENARIOS;
  const currentContext = context({ describe:field('describe', current.observation) });
  check(current.id, 'original_quote_accepted', 'accepted', quoteOutcome(validate,
    reference('patient', 'describe', current.observation), currentContext));
  check(current.id, 'retrieval_retains_exact_source', true,
    documents(currentContext).some(row => row.text === current.observation && row.subject === 'patient'));

  const perspectivesContext = context({ describe:field('describe', perspectives.observation) },
    { feeling:field('feeling', perspectives.feeling) });
  check(perspectives.id, 'supporter_quote_accepted_as_supporter', 'accepted', quoteOutcome(validate,
    reference('supporter', 'feeling', perspectives.feeling), perspectivesContext));
  check(perspectives.id, 'supporter_quote_rejected_as_patient', 'rejected', quoteOutcome(validate,
    reference('patient', 'describe', perspectives.feeling), perspectivesContext));

  const mixedField = normalizeAnswerField(field('help', `잘 모르겠어요, ${mixed.observation}`, {
    status:'unknown', custom:mixed.observation, selected:[{ label:'잘 모르겠어요' }],
  }));
  const mixedContext = context({ help:mixedField });
  check(mixed.id, 'uncertainty_selection_retained', 'unknown', mixedField.selection_status);
  check(mixed.id, 'direct_report_remains_evidence', 'accepted', quoteOutcome(validate,
    reference('patient', 'help', mixed.observation), mixedContext));
  check(mixed.id, 'retrieval_retains_direct_input', true,
    documents(mixedContext).some(row => row.question_id === 'help' && row.text === mixed.observation));

  const unknownContext = context({ help:normalizeAnswerField(field('help', '잘 모르겠어요', {
    status:'unknown', selected:[{ label:'잘 모르겠어요' }],
  })) });
  check(unknown.id, 'unknown_is_not_factual_evidence', 'rejected', quoteOutcome(validate,
    reference('patient', 'help', '잘 모르겠어요'), unknownContext));
  check(unknown.id, 'unknown_has_no_source_document', 0, documents(unknownContext).length);

  const questionSet = { version:'synthetic-comparison-v1', gapQuestion:null, questions:[
    { id:'name', type:'text', q:'합성 별칭', subject:'patient', required:true },
    { id:'describe', type:'text', q:'관찰한 내용', subject:'patient', required:true },
    { id:'feeling', type:'text', q:'나의 마음', subject:'supporter', required:true },
  ] };
  let intake = createIntake(questionSet);
  intake = answerIntake(intake, { question_id:'name', text:'합성 동료' });
  intake = answerIntake(intake, { question_id:'describe', text:correction.observation });
  intake.agentMemory = { summary:'이전 설명' };
  intake.agentResult = { stale:true };
  intake = backIntake(intake);
  check(correction.id, 'back_restores_observation_question', 'describe', currentView(intake).question.id);
  check(correction.id, 'back_invalidates_old_derived_state', true,
    intake.agentMemory === undefined && intake.agentResult === undefined);
  intake = answerIntake(intake, { question_id:'describe', text:correction.correction });
  const correctedContext = buildContext(intake);
  check(correction.id, 'corrected_quote_accepted', 'accepted', quoteOutcome(validate,
    reference('patient', 'describe', correction.correction), correctedContext));
  check(correction.id, 'superseded_quote_rejected', 'rejected', quoteOutcome(validate,
    reference('patient', 'describe', correction.observation), correctedContext));

  for (const status of ['not_asked', 'auto_skipped', 'skipped', 'refused']) {
    const input = context({ describe:field('describe', unanswered.observation, { status }) });
    check(unanswered.id, `${status}_not_promoted_to_fact`, 'rejected', quoteOutcome(validate,
      reference('patient', 'describe', unanswered.observation), input));
    check(unanswered.id, `${status}_not_indexed`, 0, documents(input).length);
  }
  check(invented.id, 'unreported_quote_rejected', 'rejected', quoteOutcome(validate,
    reference('patient', 'describe', invented.invented),
    context({ describe:field('describe', invented.observation) })));

  // Observe the real method's query contract. This recorder is not a database:
  // no transaction, cascade, physical deletion or cross-user integration claim is made.
  const queries = [], owner = 'synthetic-owner-A';
  await removeConversations.call({}, { async query(sql, values) {
    queries.push({ sql:sql.replace(/\s+/g, ' ').trim(), values });
    return { rows:[], rowCount:0 };
  } }, owner);
  check(deletion.id, 'owner_bound_delete_query_contract', [
    { sql:'DELETE FROM records WHERE owner=$1', values:[owner] },
    { sql:'DELETE FROM intakes WHERE owner=$1', values:[owner] },
  ], queries);

  const after = sourceFingerprint(resolve(ROOT, 'app'));
  assert.equal(after.sha256, before.sha256, 'App source changed while comparing; rerun on one source version.');
  return {
    schema:'malssi-final-workflow-comparison-v1', synthetic:true,
    executed_at:new Date().toISOString(), app_source_sha256:before.sha256,
    scenario_sha256:hash(JSON.stringify(SCENARIOS)),
    scenario_count:SCENARIOS.length, contract_check_count:checks.length,
    passed_checks:checks.filter(row => row.passed).length, passed:checks.every(row => row.passed),
    checks,
    manual_baseline:SCENARIOS.map(({ id, task, manual }) => ({ scenario_id:id, task,
      correctly_completed_manual_representation:'possible', required_human_action:manual,
      observed_human_result:null, automated_baseline_pass_rate:null })),
    participants:0, human_observation_status:'not_started', user_preference:null,
    branded_service_ui_executed:false, database_executed:false,
    model_executed:false, model_quality_evaluated:false, processing_time_evaluated:false,
    limitations:[
      'This checks eight synthetic scenarios against current app functions, not users or clinical outcomes.',
      'Correct manual completion is possible; unimplemented automation is not counted as a baseline failure.',
      'Deletion observes SQL and owner bindings only; database, backup, restoration and physical deletion need separate evidence.',
      'Official alternative documentation is inspected separately; this script does not execute those products.',
      'No result demonstrates user preference, market uniqueness, adoption, or independent model performance.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node tools/final_workflow_comparison.mjs [--output report.json]');
    const report = await runComparison();
    if (args.length) {
      const path = resolve(args[1]);
      await mkdir(dirname(path), { recursive:true });
      await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify({ passed:report.passed, scenarios:report.scenario_count,
      passed_checks:report.passed_checks, checks:report.contract_check_count, participants:report.participants,
      app_source_sha256:report.app_source_sha256 }));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
