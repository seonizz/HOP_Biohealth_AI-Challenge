import { ModelGateway } from './model.js';

const DEFAULT_MODEL = 'gemma4:12b';
const invalid = scope => new Error(`Invalid ${scope} configuration: check model endpoint, credentials and model options`);
const absent = value => value === undefined || value === null || value === '';

function loopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function localEndpoint(baseUrl) {
  const hostname = new URL(baseUrl).hostname;
  if (loopbackHost(hostname) || hostname === 'host.docker.internal') return true;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

// Resolve only the configured destination. No server probing or fallback can
// move a conversation to another endpoint when that destination is unavailable.
export function resolveModelBaseUrl(baseUrl, {dockerBaseUrl, container = false} = {}) {
  const selected = container && !absent(dockerBaseUrl) ? dockerBaseUrl : baseUrl;
  if (absent(selected)) return '';
  try {
    if (typeof selected !== 'string' || !selected.trim()) throw invalid('MODEL');
    const url = new URL(selected);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('MODEL');
    if (container && absent(dockerBaseUrl) && loopbackHost(url.hostname)) url.hostname = 'host.docker.internal';
    let path = url.pathname.replace(/\/+$/u, '');
    if (/\/v1\/chat\/completions$/u.test(path)) path = path.slice(0, -'/chat/completions'.length);
    url.pathname = path || '/v1';
    return url.toString().replace(/\/+$/u, '');
  } catch { throw invalid('MODEL'); }
}

function discoverSetting(env, key, scope) {
  if (env[key] === undefined) return true;
  if (env[key] === 'true') return true;
  if (env[key] === 'false') return false;
  throw invalid(scope);
}

function skipFinalExtrasSetting(env) {
  if(env.MODEL_SKIP_FINAL_EXTRAS===undefined||env.MODEL_SKIP_FINAL_EXTRAS==='false')return false;
  if(env.MODEL_SKIP_FINAL_EXTRAS==='true')return true;
  throw invalid('MODEL');
}

function reuseFinalDraftSetting(env) {
  if(env.MODEL_REUSE_FINAL_DRAFT===undefined||env.MODEL_REUSE_FINAL_DRAFT==='false')return false;
  if(env.MODEL_REUSE_FINAL_DRAFT==='true')return true;
  throw invalid('MODEL');
}

function turnInputSettings(env) {
  const options={};
  for(const [option,key] of [['stageScopedQuestionRules','MODEL_STAGE_SCOPED_QUESTION_RULES'],['blockScopedInputs','MODEL_BLOCK_SCOPED_INPUTS']]) {
    if(env[key]===undefined||env[key]==='false')options[option]=false;
    else if(env[key]==='true')options[option]=true;
    else throw invalid('MODEL');
  }
  return options;
}

function optInSetting(env, key, scope = 'MODEL') {
  if(env[key]===undefined||env[key]==='false')return false;
  if(env[key]==='true')return true;
  throw invalid(scope);
}

function endpoint(env, prefix) {
  try {
    return resolveModelBaseUrl(env[prefix + '_BASE_URL'], {
      dockerBaseUrl:env[prefix + '_DOCKER_BASE_URL'], container:env.DEMO_CONTAINER === 'true',
    });
  } catch { throw invalid(prefix); }
}

function serverGpuOnlySetting(env) {
  if (env.MODEL_SERVER_GPU_ONLY === undefined || env.MODEL_SERVER_GPU_ONLY === 'false') return false;
  if (env.MODEL_SERVER_GPU_ONLY === 'true') return true;
  throw invalid('MODEL');
}

function wireOptions(env, prefix, {serverGpuOnly = false, protocol = 'relationship_agent'} = {}) {
  const apiProfile = env[prefix + '_API_PROFILE'] === undefined ? (serverGpuOnly ? 'trained_chat' : 'default') : env[prefix + '_API_PROFILE'];
  if (!['default', 'trained_chat'].includes(apiProfile) || serverGpuOnly && apiProfile !== 'trained_chat') throw invalid(prefix);
  const trained = apiProfile === 'trained_chat';
  const agentFormat = trained && env[prefix + '_AGENT_FORMAT'] !== undefined ? env[prefix + '_AGENT_FORMAT'] : env[prefix + '_AGENT_FORMAT'] ?? (trained ? 'prompt' : 'json_schema');
  const reasoningEffort = trained && env[prefix + '_REASONING_EFFORT'] !== undefined ? env[prefix + '_REASONING_EFFORT'] : env[prefix + '_REASONING_EFFORT'] ?? (trained ? 'omit' : 'none');
  if (trained && (protocol === 'json_schema' || agentFormat !== 'prompt' || reasoningEffort !== 'omit' ||
    ['_STREAM_JSON', '_STREAM_COMPLETE_JSON'].some(suffix => env[prefix + suffix] !== undefined && env[prefix + suffix] !== 'false'))) throw invalid(prefix);
  return {apiProfile, agentFormat, reasoningEffort,
    streamJson:env[prefix + '_STREAM_JSON'] === 'true', streamCompleteJson:env[prefix + '_STREAM_COMPLETE_JSON'] === 'true'};
}

function serverGpuTarget(env) {
  const baseUrl = endpoint(env, 'MODEL'), model = env.MODEL_NAME, apiKey = env.MODEL_API_KEY;
  if (!baseUrl || typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' || !apiKey.trim() ||
    (env.MODEL_PROTOCOL ?? 'relationship_agent') !== 'relationship_agent') throw invalid('MODEL');
  return {baseUrl, model, apiKey};
}

function assertSharedTarget(env, prefix, target) {
  const baseUrl = endpoint(env, prefix);
  if (baseUrl && baseUrl !== target.baseUrl ||
    env[prefix + '_NAME'] !== undefined && env[prefix + '_NAME'] !== target.model ||
    env[prefix + '_API_KEY'] !== undefined && env[prefix + '_API_KEY'] !== target.apiKey) throw invalid(prefix);
}

// This is an explicit routing contract, not proof of the remote hardware.
// Shared-target mode never keeps an old local reviewer/referral override.
export function configuredServerGpuReferralGateway({gateway, env = process.env} = {}) {
  const enabled = serverGpuOnlySetting(env) || gateway?.serverGpuOnly === true;
  if (!enabled) return null;
  if (!(gateway instanceof ModelGateway) || !gateway.configured || !gateway.serverGpuOnly ||
    gateway.apiProfile !== 'trained_chat' || gateway.protocol !== 'relationship_agent') throw invalid('REFERRAL_MODEL');
  const target = {baseUrl:gateway.baseUrl, model:gateway.model, apiKey:gateway.apiKey};
  if (serverGpuOnlySetting(env)) {
    const primary = serverGpuTarget(env);
    if (Object.keys(primary).some(key => primary[key] !== target[key])) throw invalid('REFERRAL_MODEL');
  }
  assertSharedTarget(env, 'REFERRAL_MODEL', target);
  wireOptions(env, 'REFERRAL_MODEL', {serverGpuOnly:true});
  return gateway;
}

// A separate reviewer is opt-in. It uses the same destination rules as the
// writer while retaining independent wire-format and reasoning settings.
export function configuredReviewGateway({env = process.env, defaultModel = DEFAULT_MODEL, diagnosticLogger, fetchImpl, retryFailures = true} = {}) {
  const serverGpuOnly = serverGpuOnlySetting(env);
  const target = serverGpuOnly ? serverGpuTarget(env) : null;
  if (target) assertSharedTarget(env, 'MODEL_REVIEW', target);
  const baseUrl = target?.baseUrl ?? endpoint(env, 'MODEL_REVIEW');
  if (!baseUrl) return null;
  const {apiProfile, ...wire} = wireOptions(env, 'MODEL_REVIEW', {serverGpuOnly});
  const gateway = new ModelGateway({
    baseUrl, apiKey:target?.apiKey ?? env.MODEL_REVIEW_API_KEY ?? 'local-ollama',
    model:target?.model ?? env.MODEL_REVIEW_NAME ?? defaultModel,
    protocol:'relationship_agent', ...wire,
    timeoutMs:0, retryFailures,
    preserveStringLimits:env.MODEL_REVIEW_SCHEMA_STRING_LIMITS === 'true',
    discoverTokenLimits:discoverSetting(env, 'MODEL_REVIEW_DISCOVER_TOKEN_LIMITS', 'MODEL_REVIEW'),
    reuseTokenPolicy:optInSetting(env, 'MODEL_REUSE_TOKEN_POLICY'),
    compactReviewOutput:optInSetting(env, 'MODEL_REVIEW_COMPACT_REVIEW_OUTPUT','MODEL_REVIEW'),
    diagnosticLogger, fetchImpl,
  });
  if (!gateway.configured) throw invalid('MODEL_REVIEW');
  Object.assign(gateway, {apiProfile, serverGpuOnly});
  return gateway;
}

export function configuredModelGateway({env = process.env, diagnosticLogger, fetchImpl, retryFailures = true} = {}) {
  const serverGpuOnly = serverGpuOnlySetting(env);
  const target = serverGpuOnly ? serverGpuTarget(env) : null;
  const baseUrl = target?.baseUrl ?? endpoint(env, 'MODEL');
  if (!baseUrl) return null;
  let apiKey = env.MODEL_API_KEY;
  if (!serverGpuOnly && (apiKey == null || typeof apiKey === 'string' && !apiKey.trim()) && localEndpoint(baseUrl)) apiKey = 'local-ollama';
  const protocol = env.MODEL_PROTOCOL ?? 'relationship_agent';
  if (!['json_schema', 'json_prompt', 'relationship_agent'].includes(protocol)) throw invalid('MODEL');
  const {apiProfile, ...wire} = wireOptions(env, 'MODEL', {serverGpuOnly, protocol});
  if (serverGpuOnly) {
    assertSharedTarget(env, 'REFERRAL_MODEL', target);
    wireOptions(env, 'REFERRAL_MODEL', {serverGpuOnly:true});
  }
  const gateway = new ModelGateway({
    baseUrl, apiKey, model:env.MODEL_NAME ?? DEFAULT_MODEL, protocol,
    timeoutMs:Number(env.MODEL_TIMEOUT_MS ?? 0), retryFailures,
    ...wire, stateMode:env.MODEL_STATE_MODE ?? 'combined',
    // Opt in only on the isolated test service; required independent reviews remain.
    skipFinalExtras:skipFinalExtrasSetting(env),
    reuseFinalDraft:reuseFinalDraftSetting(env),
    ...turnInputSettings(env),
    compactReviewInputs:optInSetting(env, 'MODEL_COMPACT_REVIEW_INPUTS'),
    scopedQualityRefinement:optInSetting(env, 'MODEL_SCOPED_QUALITY_REFINEMENT'),
    reuseTokenPolicy:optInSetting(env, 'MODEL_REUSE_TOKEN_POLICY'),
    preserveStringLimits:env.MODEL_SCHEMA_STRING_LIMITS === 'true',
    bundleFinalReviews:optInSetting(env, 'MODEL_BUNDLE_FINAL_REVIEWS'),
    shareReviewSources:optInSetting(env, 'MODEL_SHARE_REVIEW_SOURCES'),
    repairReviewBundleTasks:optInSetting(env, 'MODEL_REPAIR_REVIEW_BUNDLE_TASKS'),
    extendedFinalEvidenceIds:optInSetting(env, 'MODEL_EXTENDED_FINAL_EVIDENCE_IDS'),
    bundleTurnReviews:optInSetting(env, 'MODEL_BUNDLE_TURN_REVIEWS'),
    bundleCombinedTurnReviews:optInSetting(env, 'MODEL_BUNDLE_COMBINED_TURN_REVIEWS'),
    bundleAnalysisPlan:optInSetting(env, 'MODEL_BUNDLE_ANALYSIS_PLAN'),
    compactReviewOutput:optInSetting(env, 'MODEL_COMPACT_REVIEW_OUTPUT'),
    reuseReviewedName:optInSetting(env, 'MODEL_REUSE_REVIEWED_NAME'),
    reuseReviewedSafety:optInSetting(env, 'MODEL_REUSE_REVIEWED_SAFETY'),
    discoverTokenLimits:discoverSetting(env, 'MODEL_DISCOVER_TOKEN_LIMITS', 'MODEL'),
    diagnosticLogger, fetchImpl,
  });
  if (!gateway.configured) throw invalid('MODEL');
  Object.assign(gateway, {apiProfile, serverGpuOnly});
  gateway.reviewGateway = configuredReviewGateway({env, defaultModel:gateway.model, diagnosticLogger, fetchImpl, retryFailures});
  return gateway;
}
