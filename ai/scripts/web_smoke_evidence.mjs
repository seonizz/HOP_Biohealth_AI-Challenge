import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failureCodes = new Set([
  'invalid_response', 'http_error', 'connection_error', 'model_identity_mismatch',
  'application_source_mismatch', 'invalid_test_session', 'test_session_identity_mismatch',
  'test_run_exists_use_resume', 'missing_synthetic_answer', 'missing_synthetic_choice',
  'missing_internal_analysis', 'question_loop', 'missing_agent_result', 'unexpected_prompt_version',
  'missing_original_observations', 'record_mismatch', 'unexpected_safety', 'unexpected_relationship',
  'invented_script_role', 'missing_required_script_intent',
  'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_INVALID_RESPONSE', 'MODEL_AUTH_FAILED',
  'MODEL_CONTEXT_TOO_LONG', 'MODEL_NOT_CONFIGURED', 'MODEL_NOT_CONNECTED', 'MODEL_UPSTREAM_ERROR',
  'NOT_FOUND', 'REVISION_CONFLICT', 'RECORD_CONFLICT', 'JSON_REQUIRED', 'BODY_TOO_LARGE',
  'INVALID_JSON', 'INVALID_REVISION', 'HOST_REJECTED', 'ORIGIN_REJECTED', 'METHOD_NOT_ALLOWED',
  'INVALID_PATH', 'RATE_LIMITED', 'SESSION_REQUIRED', 'CSRF_REJECTED', 'INVALID_FILTER',
  'INVALID_DATE', 'INVALID_STATE', 'INVALID_INPUT', 'INTAKE_NOT_READY', 'INTERNAL_ERROR',
]);

// Unexpected exceptions and remote messages may contain credentials or response text.
export function webSmokeFailureCode(error) {
  if (failureCodes.has(error?.code)) return error.code;
  if (failureCodes.has(error?.message)) return error.message;
  return 'web_smoke_error';
}

export function webSmokeSessionId(previous) {
  const id = previous?.session_id ?? previous?.intake_id;
  if (!UUID.test(id)) throw new Error('invalid_test_session');
  return id;
}

// The mutable resume file is separate from this append-only invocation history.
// An unfinished started.json remains visible if the process stops before a result.
export function beginWebSmokeAttempt({ directory, runId = '', sessionId = null, resumed = false,
  attemptId = randomUUID() }) {
  if (!UUID.test(attemptId) || (sessionId !== null && !UUID.test(sessionId)) ||
      (runId !== '' && !/^[a-z0-9_-]{1,40}$/.test(runId))) throw new Error('invalid_web_smoke_identity');
  mkdirSync(directory, { recursive:true, mode:0o700 });
  const attemptDirectory = join(directory, attemptId);
  // Exclusive directory creation reserves the ID before any evidence can be written.
  mkdirSync(attemptDirectory, { mode:0o700 });
  const metadata = { kind:'synthetic_relationship_web_smoke_attempt', schema_version:1, synthetic:true,
    attempt_id:attemptId, session_id:sessionId, run_id:runId || null, resumed:Boolean(resumed),
    started_at:new Date().toISOString() };
  writeFileSync(join(attemptDirectory, 'started.json'), JSON.stringify(metadata, null, 2) + '\n', { flag:'wx', mode:0o600 });
  const resultPath = join(attemptDirectory, 'result.json');
  return {
    attemptId, resultPath,
    finish({ status, error, intake_id, question_id, turns = [], identity, record_id, final_duration_ms, record }) {
      if (!['passed', 'failed'].includes(status)) throw new Error('invalid_web_smoke_status');
      const result = { ...metadata, finished_at:new Date().toISOString(), status,
        ...(status === 'failed' ? { code:webSmokeFailureCode(error) } : {}),
        intake_id, question_id, turns, identity, record_id, final_duration_ms, record };
      // No update path: duplicate completion must fail without changing the first outcome.
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag:'wx', mode:0o600 });
      return result;
    },
  };
}
