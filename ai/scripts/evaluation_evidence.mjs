import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sourceFingerprint } from '../../app/src/source-identity.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function modelConfig(env, legacy = {}) {
  // An explicit endpoint must have its own explicit model and credential.
  const explicit = Boolean(env.MODEL_BASE_URL);
  const config = {
    baseUrl:env.MODEL_BASE_URL || (legacy.ollama_url ? legacy.ollama_url.replace(/\/$/, '') + '/v1' : undefined),
    apiKey:explicit ? env.MODEL_API_KEY : (env.MODEL_API_KEY || legacy.api_key),
    model:env.MODEL_NAME || (!explicit && legacy.ollama_url ? 'gemma4:12b' : undefined),
    protocol:'relationship_agent',
    timeoutMs:env.MODEL_TIMEOUT_MS === undefined ? 600000 : Number(env.MODEL_TIMEOUT_MS),
  };
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('invalid_model_timeout');
  if (env.MODEL_CHECKPOINT_SHA256 && !/^[a-f0-9]{64}$/.test(env.MODEL_CHECKPOINT_SHA256)) throw new Error('invalid_checkpoint_sha256');
  return config;
}

export function evaluationIdentity({ backend, fixtureBytes, questionsBytes, promptVersion, config, context = null,
  contextSource = 'synthetic_fixture', checkpointSha256 = null }) {
  const evaluatorFiles=['evaluate_relationship_agent.mjs','evaluation_evidence.mjs'].map(path=>({
    path,sha256:sha256(readFileSync(new URL(path,import.meta.url))),
  }));
  return {
    source:sourceFingerprint(backend), prompt_version:promptVersion,
    evaluator:{sha256:sha256(JSON.stringify(evaluatorFiles)),files:evaluatorFiles},
    fixture_sha256:sha256(fixtureBytes), questions_sha256:sha256(questionsBytes),
    context_sha256:context===null?null:sha256(JSON.stringify(context)),context_source:contextSource,
    model_requested:config.model || null, checkpoint_sha256_declared:checkpointSha256,
    runtime_model_identity_verified:false,
    protocol:config.protocol, timeout_ms:config.timeoutMs,
    // Local source and evaluator identities do not verify a remote web deployment.
    deployment_verified:false, independent_test:false, human_review:'pending',
  };
}

export function assertWebSessionIdentity(saved,current) {
  for(const key of ['source_sha256','prompt_version','model_requested','model_protocol']) {
    if(typeof current?.[key]!=='string'||!current[key]||saved?.[key]!==current[key]) {
      throw new Error('test_session_identity_mismatch');
    }
  }
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length*fraction)-1)];
}

export function attemptMetrics(trace) {
  const durations = trace.map(row => row.duration_ms).filter(value => Number.isFinite(value) && value >= 0);
  const tokenTotal = key => trace.length && trace.every(row => Number.isSafeInteger(row.usage?.[key]))
    ? trace.reduce((sum,row) => sum + row.usage[key], 0) : null;
  return {
    attempts:trace.length, failed_attempts:trace.filter(row => row.reason !== 'success').length,
    retries:trace.filter(row => row.attempt > 1).length,
    attempt_wait_ms:durations.reduce((sum,value) => sum+value, 0),
    attempt_p50_ms:percentile(durations, .5), attempt_p95_ms:percentile(durations, .95),
    prompt_tokens:tokenTotal('prompt_tokens'), completion_tokens:tokenTotal('completion_tokens'),
    cost_measured:false,
  };
}

export function summarizeRuns(reports) {
  if (!reports.length) throw new Error('no_evaluation_runs');
  if (reports.some(row => !row.run_id || !row.identity || !['passed','failed'].includes(row.status)
      || !Number.isFinite(row.duration_ms) || row.duration_ms < 0)) throw new Error('invalid_evaluation_run');
  if (new Set(reports.map(row => row.run_id)).size !== reports.length) throw new Error('duplicate_run_id');
  const groups = new Map();
  for (const row of reports) {
    const key = JSON.stringify([row.identity.model_requested, row.identity.checkpoint_sha256_declared,
      row.identity.source.sha256, row.identity.evaluator?.sha256, row.identity.prompt_version,
      row.identity.questions_sha256, row.identity.context_source, row.identity.protocol, row.mode,
      row.incremental, row.web_context, row.identity.timeout_ms]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const {fixture_sha256,context_sha256,...identity}=rows[0].identity;
    return {
      identity, mode:rows[0].mode, incremental:Boolean(rows[0].incremental), web_context:Boolean(rows[0].web_context),
      fixture_sha256:[...new Set(rows.map(row=>row.identity.fixture_sha256))],
      context_sha256:[...new Set(rows.map(row=>row.identity.context_sha256).filter(Boolean))],
      runs:rows.length, unique_cases:rows.some(row=>row.web_context&&!row.identity.context_sha256)?null
        :new Set(rows.map(row => row.identity.context_sha256||row.identity.fixture_sha256)).size,
      context_identity_complete:rows.every(row=>Boolean(row.identity.context_sha256)),
      passed:rows.filter(row => row.status === 'passed').length,
      failed:rows.filter(row => row.status === 'failed').length,
      automatic_pass_rate:rows.filter(row => row.status === 'passed').length / rows.length,
      // Includes unsuccessful runs. This is evaluator elapsed time, not a user's session duration.
      elapsed_total_ms:rows.reduce((sum,row) => sum+row.duration_ms, 0),
      elapsed_p50_ms:percentile(rows.map(row => row.duration_ms), .5),
      elapsed_p95_ms:percentile(rows.map(row => row.duration_ms), .95),
      ...attemptMetrics(rows.flatMap(row => row.trace || [])),
      independent_test:false, human_review:'pending', clinical_effectiveness_verified:false,
    };
  });
}
