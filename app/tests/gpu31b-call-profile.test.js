import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {configuredModelGateway} from '../src/model-config.js';

test('optional GPU profile selects two-call orchestration and preserves independent gates',()=>{
  const profile=parseEnv(readFileSync(new URL('../config/gpu31b-call-optimized.env',import.meta.url),'utf8'));
  for(const key of Object.keys(profile))assert.match(key,/^MODEL_/);
  for(const key of ['MODEL_BASE_URL','MODEL_API_KEY','DATABASE_URL','MODEL_MAX_OUTPUT_TOKENS','MODEL_MAX_CONTEXT_TOKENS'])
    assert.equal(Object.hasOwn(profile,key),false);
  const gateway=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434',...profile}});
  assert.equal(gateway.stateMode,'combined');assert.equal(gateway.bundleCombinedTurnReviews,true);
  assert.equal(gateway.bundleTurnReviews,false);assert.equal(gateway.shareReviewSources,true);
  assert.equal(gateway.bundleAnalysisPlan,true);assert.equal(gateway.bundleFinalReviews,true);
  assert.equal(gateway.prioritizeSpeechPreview,true);
  assert.equal(gateway.compactReviewOutput,false);assert.equal(gateway.compactTurnReviewOutput,false);assert.equal(gateway.combinedTurnEvidenceIds,true);assert.equal(gateway.skipFinalExtras,false);
  assert.equal(gateway.stageScopedQuestionRules,true);assert.equal(gateway.blockScopedInputs,true);
  assert.equal(gateway.reuseReviewedSafety,false);assert.equal(gateway.reuseReviewedName,false);
});
