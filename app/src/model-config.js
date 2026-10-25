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

function endpoint(env, prefix) {
  try {
    return resolveModelBaseUrl(env[prefix + '_BASE_URL'], {
      dockerBaseUrl:env[prefix + '_DOCKER_BASE_URL'], container:env.DEMO_CONTAINER === 'true',
    });
  } catch { throw invalid(prefix); }
}

// A separate reviewer is opt-in. It uses the same destination rules as the
// writer while retaining independent wire-format and reasoning settings.
export function configuredReviewGateway({env = process.env, defaultModel = DEFAULT_MODEL, diagnosticLogger, fetchImpl, retryFailures = true} = {}) {
  const baseUrl = endpoint(env, 'MODEL_REVIEW');
  if (!baseUrl) return null;
  const gateway = new ModelGateway({
    baseUrl, apiKey:env.MODEL_REVIEW_API_KEY ?? 'local-ollama',
    model:env.MODEL_REVIEW_NAME ?? defaultModel,
    protocol:'relationship_agent', agentFormat:env.MODEL_REVIEW_AGENT_FORMAT ?? 'json_schema',
    reasoningEffort:env.MODEL_REVIEW_REASONING_EFFORT ?? 'none',
    timeoutMs:0, retryFailures, streamJson:env.MODEL_REVIEW_STREAM_JSON === 'true',
    streamCompleteJson:env.MODEL_REVIEW_STREAM_COMPLETE_JSON === 'true',
    preserveStringLimits:env.MODEL_REVIEW_SCHEMA_STRING_LIMITS === 'true',
    discoverTokenLimits:discoverSetting(env, 'MODEL_REVIEW_DISCOVER_TOKEN_LIMITS', 'MODEL_REVIEW'),
    diagnosticLogger, fetchImpl,
  });
  if (!gateway.configured) throw invalid('MODEL_REVIEW');
  return gateway;
}

export function configuredModelGateway({env = process.env, diagnosticLogger, fetchImpl, retryFailures = true} = {}) {
  const baseUrl = endpoint(env, 'MODEL');
  if (!baseUrl) return null;
  let apiKey = env.MODEL_API_KEY;
  if ((apiKey == null || typeof apiKey === 'string' && !apiKey.trim()) && localEndpoint(baseUrl)) apiKey = 'local-ollama';
  const protocol = env.MODEL_PROTOCOL ?? 'relationship_agent';
  if (!['json_schema', 'json_prompt', 'relationship_agent'].includes(protocol)) throw invalid('MODEL');
  const gateway = new ModelGateway({
    baseUrl, apiKey, model:env.MODEL_NAME ?? DEFAULT_MODEL, protocol,
    timeoutMs:Number(env.MODEL_TIMEOUT_MS ?? 0), retryFailures,
    agentFormat:env.MODEL_AGENT_FORMAT ?? 'json_schema', stateMode:env.MODEL_STATE_MODE ?? 'combined',
    reasoningEffort:env.MODEL_REASONING_EFFORT ?? 'none',
    streamJson:env.MODEL_STREAM_JSON === 'true', preserveStringLimits:env.MODEL_SCHEMA_STRING_LIMITS === 'true',
    streamCompleteJson:env.MODEL_STREAM_COMPLETE_JSON === 'true',
    discoverTokenLimits:discoverSetting(env, 'MODEL_DISCOVER_TOKEN_LIMITS', 'MODEL'),
    diagnosticLogger, fetchImpl,
  });
  if (!gateway.configured) throw invalid('MODEL');
  gateway.reviewGateway = configuredReviewGateway({env, defaultModel:gateway.model, diagnosticLogger, fetchImpl, retryFailures});
  return gateway;
}
