import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {configuredModelGateway} from './model-config.js';
import {createModelReferralProvider} from './referral-provider.js';
import {TRIAGE_VERSION} from './risk-classification.js';

// Reuse the configured model by default. Never infer eligibility from prose or IP.
export function configuredReferralProvider({gateway, env = process.env} = {}) {
  if ((env.REFERRAL_GUIDANCE_ENABLED ?? 'true') !== 'true') return null;
  let selected = gateway;
  if (env.REFERRAL_MODEL_BASE_URL || env.DEMO_CONTAINER === 'true' && env.REFERRAL_MODEL_DOCKER_BASE_URL) {
    if (!env.REFERRAL_MODEL_NAME) throw new Error('Missing referral model configuration');
    selected = configuredModelGateway({env:{
      DEMO_CONTAINER:env.DEMO_CONTAINER,
      MODEL_BASE_URL:env.REFERRAL_MODEL_BASE_URL,
      MODEL_DOCKER_BASE_URL:env.REFERRAL_MODEL_DOCKER_BASE_URL,
      MODEL_API_KEY:env.REFERRAL_MODEL_API_KEY,
      MODEL_NAME:env.REFERRAL_MODEL_NAME,
      MODEL_PROTOCOL:'relationship_agent',
      MODEL_AGENT_FORMAT:env.REFERRAL_MODEL_AGENT_FORMAT || env.MODEL_AGENT_FORMAT || 'json_schema',
      MODEL_REASONING_EFFORT:env.REFERRAL_MODEL_REASONING_EFFORT || env.MODEL_REASONING_EFFORT || 'none',
      MODEL_SCHEMA_STRING_LIMITS:env.MODEL_SCHEMA_STRING_LIMITS,
      MODEL_STREAM_JSON:env.REFERRAL_MODEL_STREAM_JSON,
      MODEL_STREAM_COMPLETE_JSON:env.REFERRAL_MODEL_STREAM_COMPLETE_JSON,
      MODEL_DISCOVER_TOKEN_LIMITS:env.REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS ?? env.MODEL_DISCOVER_TOKEN_LIMITS,
      MODEL_TIMEOUT_MS:'0',
    }});
  }
  if (!selected) return null;
  const country = env.REFERRAL_COUNTRY || null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new Error('Invalid referral country');
  const eligibilitySource=readFileSync(new URL('../seeds/referral-eligibility.json', import.meta.url),'utf8');
  const provider=createModelReferralProvider({gateway:selected,
    eligibilityById:JSON.parse(eligibilitySource),
    modelVersion:env.REFERRAL_MODEL_NAME || 'configured-primary',
    resolveRoutingContext:() => ({country, region:null, age:null, requester:'supporter'})});
  Object.defineProperty(provider,'cacheKey',{value:JSON.stringify([TRIAGE_VERSION,selected.baseUrl||null,selected.model||null,selected.protocol||null,
    selected.agentFormat||null,selected.reasoningEffort||null,selected.streamJson||false,selected.streamCompleteJson||false,
    country,createHash('sha256').update(eligibilitySource).digest('hex')])});
  return provider;
}
