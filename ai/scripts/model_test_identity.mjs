import { sha256 } from './evaluation_evidence.mjs';

// Explicit allowlist: do not serialize the gateway, environment, API key,
// transport functions or URLs. Unknown future fields require conscious review.
export const MODEL_IDENTITY_FIELDS = Object.freeze({
  model:'model_requested', protocol:'protocol', agentFormat:'agent_format',
  stateMode:'state_mode', reasoningEffort:'reasoning_effort',
  timeoutMs:'timeout_ms', skipFinalExtras:'skip_final_extras', reuseFinalDraft:'reuse_final_draft',
  stageScopedQuestionRules:'stage_scoped_question_rules', blockScopedInputs:'block_scoped_inputs',
  compactReviewInputs:'compact_review_inputs', scopedQualityRefinement:'scoped_quality_refinement',
  reuseTokenPolicy:'reuse_token_policy', discoverTokenLimits:'discover_token_limits',
  preserveStringLimits:'preserve_string_limits', streamJson:'stream_json',
  streamCompleteJson:'stream_complete_json', retryFailures:'retry_failures', retryDelayMs:'retry_delay_ms',
  apiProfile:'api_profile', serverGpuOnly:'server_gpu_only',
});

export function describeModelGateway(model) {
  const identity = {endpoint_sha256:sha256(model.baseUrl)};
  for (const [field, name] of Object.entries(MODEL_IDENTITY_FIELDS)) {
    const value = model[field];
    identity[name] = ['string','boolean'].includes(typeof value) || Number.isFinite(value) ? value : null;
  }
  return {...identity, effective_config_sha256:sha256(JSON.stringify(identity)), runtime_model_identity_verified:false};
}
