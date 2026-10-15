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
    deploymentId:env.MODEL_DEPLOYMENT_ID || null,
  };
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('invalid_model_timeout');
  if (env.MODEL_CHECKPOINT_SHA256 && !/^[a-f0-9]{64}$/.test(env.MODEL_CHECKPOINT_SHA256)) throw new Error('invalid_checkpoint_sha256');
  if (config.deploymentId && (typeof config.deploymentId !== 'string' || !config.deploymentId.trim() || config.deploymentId.length > 1024)) throw new Error('invalid_deployment_id');
  return config;
}

function endpointHash(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    // The path can itself contain credentials: persist only the hash, never the URL.
    return sha256(url.toString().replace(/\/+$/, ''));
  } catch { throw new Error('invalid_model_endpoint'); }
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
    endpoint_sha256_declared:endpointHash(config.baseUrl),
    deployment_id_sha256_declared:config.deploymentId ? sha256(config.deploymentId) : null,
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
  const attempts = new Map(), conflicts = new Set();
  let legacy = 0, unknown = 0;
  const waits = [], preflight = [];
  for (const row of trace) {
    if (row.event === 'model_retry_wait') { waits.push(row); continue; }
    if (row.event === 'model_request_failure') { preflight.push(row); continue; }
    if (row.event && row.event !== 'model_attempt') { unknown++; continue; }
    // Older traces include backoff deadlines as attempts. Their request count cannot be recovered safely.
    if (typeof row.attempt_id !== 'string' || !row.attempt_id) { legacy++; continue; }
    if (attempts.has(row.attempt_id) && JSON.stringify(attempts.get(row.attempt_id)) !== JSON.stringify(row)) conflicts.add(row.attempt_id);
    else attempts.set(row.attempt_id, row);
  }
  const verified = legacy === 0 && unknown === 0 && conflicts.size === 0;
  const rows = [...attempts.values()];
  const validDuration = row => Number.isFinite(row.duration_ms) && row.duration_ms >= 0;
  const durations = rows.every(validDuration) ? rows.map(row => row.duration_ms) : null;
  const tokenTotal = key => verified && rows.length && rows.every(row => Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0)
    ? rows.reduce((sum,row) => sum + row.usage[key], 0) : null;
  return {
    attempt_count_verified:verified, legacy_attempt_events:legacy,
    conflicting_attempt_ids:conflicts.size, unknown_trace_events:unknown,
    attempts:verified ? rows.length : null,
    failed_attempts:verified ? rows.filter(row => row.reason !== 'success').length : null,
    retries:verified ? rows.filter(row => row.attempt > 1).length : null,
    attempt_wait_ms:verified && durations ? durations.reduce((sum,value) => sum+value, 0) : null,
    attempt_p50_ms:verified && durations ? percentile(durations, .5) : null,
    attempt_p95_ms:verified && durations ? percentile(durations, .95) : null,
    retry_wait_events:verified ? waits.length : null,
    retry_wait_deadlines:verified ? waits.filter(row => row.reason === 'deadline').length : null,
    retry_wait_ms:verified && waits.every(validDuration) ? waits.reduce((sum,row) => sum+row.duration_ms, 0) : null,
    preflight_failures:verified ? preflight.length : null,
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
    const endpointKnown = /^[a-f0-9]{64}$/.test(row.identity.endpoint_sha256_declared || '');
    const key = JSON.stringify([row.identity.model_requested, row.identity.checkpoint_sha256_declared,
      endpointKnown ? row.identity.endpoint_sha256_declared : ['unknown_endpoint', row.run_id],
      row.identity.deployment_id_sha256_declared,
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
      endpoint_identity_complete:rows.every(row=>/^[a-f0-9]{64}$/.test(row.identity.endpoint_sha256_declared || '')),
      environment_identity_verified:false,
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
