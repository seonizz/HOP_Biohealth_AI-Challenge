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
    agentFormat:env.MODEL_AGENT_FORMAT || 'json_schema',
    reasoningEffort:env.MODEL_REASONING_EFFORT || 'none',
    timeoutMs:env.MODEL_TIMEOUT_MS === undefined ? 600000 : Number(env.MODEL_TIMEOUT_MS),
    deploymentId:env.MODEL_DEPLOYMENT_ID || null,
  };
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('invalid_model_timeout');
  if (!['json_schema', 'json_object', 'prompt'].includes(config.agentFormat)) throw new Error('invalid_model_agent_format');
  if (!['omit', 'none', 'low', 'medium', 'high'].includes(config.reasoningEffort)) throw new Error('invalid_model_reasoning_effort');
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
    agent_format:config.agentFormat || 'json_schema', reasoning_effort:config.reasoningEffort || 'none',
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

const terminalReasons = new Set(['success', 'deadline', 'internal_failure', 'authentication', 'http_rejected',
  'retry_after_limit', 'connection_failure', 'envelope_read_failure']);
// Matches ModelGateway.request's fixed retry ceiling; lower attempts must record their next step.
const maxAttemptsPerGeneration = 3;
const transientReasons = new Set(['connection_transient', 'http_transient']);
const validDuration = row => Number.isFinite(row.duration_ms) && row.duration_ms >= 0;
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

function inspectTrace(trace) {
  const attempts = new Map(), waits = new Map(), generations = new Map(), conflicts = new Set(), errors = new Set();
  const preflight = [];
  let legacy = 0, unknown = 0;
  if (!Array.isArray(trace)) errors.add(trace == null ? 'missing_trace' : 'invalid_trace');
  else if (!trace.length) errors.add('empty_trace');
  for (const row of Array.isArray(trace) ? trace : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.add('invalid_event'); continue; }
    if (!row.event || (row.event === 'model_attempt' && !nonempty(row.attempt_id))) {
      legacy++; errors.add('legacy_attempt_event'); continue;
    }
    if (!['model_attempt', 'model_retry_wait', 'model_request_failure'].includes(row.event)) {
      unknown++; errors.add('unknown_trace_event'); continue;
    }
    const isWait = row.event === 'model_retry_wait';
    const isAttempt = row.event === 'model_attempt';
    if (!nonempty(row.generation_id) || !nonempty(row.generation) || !Number.isSafeInteger(row.attempt)
        || row.attempt < 1 || row.attempt > maxAttemptsPerGeneration
        || !(row.request_id === null || nonempty(row.request_id)) || !validDuration(row) || !nonempty(row.reason)
        || (isWait ? !nonempty(row.after_attempt_id) || !Number.isFinite(row.delay_ms) || row.delay_ms <= 0
          || !['retry_ready', 'deadline'].includes(row.reason)
          : !Object.hasOwn(row, 'status') || !Object.hasOwn(row, 'finish_reason') || !Object.hasOwn(row, 'usage')
            || (isAttempt ? !nonempty(row.attempt_id) : row.attempt_id !== null))) {
      errors.add('invalid_event_fields'); continue;
    }
    const records = isWait ? waits : isAttempt ? attempts : null;
    const id = isWait ? row.after_attempt_id : row.attempt_id;
    if (records?.has(id)) {
      if (JSON.stringify(records.get(id)) !== JSON.stringify(row)) {
        errors.add(isWait ? 'conflicting_retry_wait' : 'conflicting_attempt_id');
        if (isAttempt) conflicts.add(id);
      }
      continue; // Identical repeated delivery is one event, including wait duration.
    }
    let generation = generations.get(row.generation_id);
    if (!generation) {
      generation = {name:row.generation, requestId:row.request_id, last:null, wait:null};
      generations.set(row.generation_id, generation);
    }
    if (generation.name !== row.generation || generation.requestId !== row.request_id) errors.add('generation_identity_mismatch');
    if (isWait) {
      const previous = attempts.get(row.after_attempt_id);
      if (!previous) errors.add('orphan_retry_wait');
      else if (previous !== generation.last || previous.generation_id !== row.generation_id
          || previous.attempt !== row.attempt || previous.request_id !== row.request_id) errors.add('retry_wait_mismatch');
      if (previous && (!transientReasons.has(previous.reason) || previous.attempt === maxAttemptsPerGeneration)) errors.add('retry_wait_after_terminal');
      waits.set(id, row); generation.wait = row;
      continue;
    }
    if (row.attempt !== (generation.last?.attempt || 0) + 1) errors.add('attempt_sequence');
    if (generation.last && (generation.last.event === 'model_request_failure' || terminalReasons.has(generation.last.reason)
        || generation.wait?.reason === 'deadline')) errors.add('attempt_after_terminal');
    if (transientReasons.has(generation.last?.reason) && !generation.wait) errors.add('missing_retry_wait');
    generation.last = row; generation.wait = null;
    if (isAttempt) attempts.set(id, row);
    else {
      if (row.reason === 'success') errors.add('invalid_preflight_failure');
      preflight.push(row);
    }
  }
  for (const generation of generations.values()) {
    if (generation.wait?.reason === 'retry_ready' || (!generation.wait && transientReasons.has(generation.last?.reason)
        && generation.last.attempt < maxAttemptsPerGeneration)) errors.add('unfinished_retry');
  }
  return {attempts:[...attempts.values()], waits:[...waits.values()], preflight, legacy, unknown, conflicts, errors};
}

function metricsForTraces(traces) {
  const inspected = traces.map(inspectTrace);
  const errors = new Set(inspected.flatMap(result => [...result.errors]));
  const rows = inspected.flatMap(result => result.attempts), waits = inspected.flatMap(result => result.waits);
  const conflicts = new Set(inspected.flatMap(result => [...result.conflicts]));
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.attempt_id)) { conflicts.add(row.attempt_id); errors.add('attempt_id_reused_across_traces'); }
    ids.add(row.attempt_id);
  }
  const verified = errors.size === 0;
  const durations = rows.map(row => row.duration_ms);
  const tokenTotal = key => verified && rows.length && rows.every(row => Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0)
    ? rows.reduce((sum,row) => sum + row.usage[key], 0) : null;
  return {
    attempt_count_verified:verified, attempt_count_scope:'validated_trace_events',
    // Internal consistency cannot prove that an entire generation was never lost by a log collector.
    trace_completeness_verified:false, trace_integrity_errors:[...errors].sort(),
    legacy_attempt_events:inspected.reduce((sum,result) => sum + result.legacy, 0),
    conflicting_attempt_ids:conflicts.size, unknown_trace_events:inspected.reduce((sum,result) => sum + result.unknown, 0),
    attempts:verified ? rows.length : null,
    failed_attempts:verified ? rows.filter(row => row.reason !== 'success').length : null,
    retries:verified ? rows.filter(row => row.attempt > 1).length : null,
    attempt_wait_ms:verified ? durations.reduce((sum,value) => sum+value, 0) : null,
    attempt_p50_ms:verified ? percentile(durations, .5) : null,
    attempt_p95_ms:verified ? percentile(durations, .95) : null,
    retry_wait_events:verified ? waits.length : null,
    retry_wait_deadlines:verified ? waits.filter(row => row.reason === 'deadline').length : null,
    retry_wait_ms:verified ? waits.reduce((sum,row) => sum+row.duration_ms, 0) : null,
    preflight_failures:verified ? inspected.reduce((sum,result) => sum + result.preflight.length, 0) : null,
    prompt_tokens:tokenTotal('prompt_tokens'), completion_tokens:tokenTotal('completion_tokens'),
    cost_measured:false,
  };
}

export function attemptMetrics(trace) {
  return metricsForTraces([trace]);
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
      row.incremental, row.web_context, row.identity.timeout_ms,
      row.identity.agent_format, row.identity.reasoning_effort]);
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
      ...metricsForTraces(rows.map(row => row.trace)),
      independent_test:false, human_review:'pending', clinical_effectiveness_verified:false,
    };
  });
}
