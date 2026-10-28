import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDocuments } from '../app/src/relationship-retrieval.js';
import { runComparison, SCENARIOS } from './final_workflow_comparison.mjs';

test('eight authored scenarios pass real app contracts without claiming user or database results', async () => {
  const report = await runComparison();
  assert.equal(report.passed, true);
  assert.equal(report.scenario_count, 8);
  assert.equal(new Set(SCENARIOS.map(row => row.id)).size, 8);
  assert.equal(report.passed_checks, report.contract_check_count);
  assert.equal(report.participants, 0);
  assert.equal(report.user_preference, null);
  assert.equal(report.database_executed, false);
  assert.equal(report.branded_service_ui_executed, false);
  assert.equal(report.model_executed, false);
  assert.equal(report.processing_time_evaluated, false);
  assert.match(report.app_source_sha256, /^[a-f0-9]{64}$/);
  for (const row of report.manual_baseline) {
    assert.equal(row.correctly_completed_manual_representation, 'possible');
    assert.equal(row.observed_human_result, null);
    assert.equal(row.automated_baseline_pass_rate, null);
  }
});

test('a validator accepting every quote fails the negative comparisons', async () => {
  const report = await runComparison({ validate:ref => ref });
  assert.equal(report.passed, false);
  const failed = report.checks.filter(row => !row.passed).map(row => row.name);
  for (const name of ['supporter_quote_rejected_as_patient', 'unknown_is_not_factual_evidence',
    'superseded_quote_rejected', 'unreported_quote_rejected']) assert.ok(failed.includes(name));
});

test('losing mixed direct input is detected instead of being counted as uncertainty handling success', async () => {
  const report = await runComparison({ documents:input => sourceDocuments(input).filter(row => row.question_id !== 'help') });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(row => row.name === 'retrieval_retains_direct_input').passed, false);
});

test('a deletion implementation without owner scope cannot pass the query-contract observation', async () => {
  const report = await runComparison({ async removeConversations(client) {
    await client.query('DELETE FROM records', []);
    await client.query('DELETE FROM intakes', []);
  } });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(row => row.name === 'owner_bound_delete_query_contract').passed, false);
});

test('unexpected infrastructure errors do not masquerade as correctly rejected evidence', async () => {
  await assert.rejects(runComparison({ validate() { throw new Error('synthetic unexpected error'); } }),
    /synthetic unexpected error/);
});
