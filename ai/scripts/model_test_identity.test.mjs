import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../../app/src/model.js';
import { configuredModelGateway } from '../../app/src/model-config.js';
import { describeModelGateway, MODEL_IDENTITY_FIELDS } from './model_test_identity.mjs';

const env = {MODEL_BASE_URL:'http://127.0.0.1:11434/v1', MODEL_PROTOCOL:'relationship_agent',
  MODEL_DISCOVER_TOKEN_LIMITS:'false', MODEL_API_KEY:'synthetic-secret-identity'};
const make = settings => configuredModelGateway({env:{...env,...settings}, diagnosticLogger:null});

test('effective settings distinguish previously colliding configurations', () => {
  const baseline = describeModelGateway(make());
  const changed = describeModelGateway(make({MODEL_SKIP_FINAL_EXTRAS:'true',MODEL_TIMEOUT_MS:'10000'}));
  assert.equal(baseline.skip_final_extras, false);
  assert.equal(changed.skip_final_extras, true);
  assert.equal(changed.timeout_ms, 10000);
  assert.notEqual(changed.effective_config_sha256, baseline.effective_config_sha256);
  assert.deepEqual(describeModelGateway(make()), baseline);
});

test('every gateway-owned configuration field is explicitly classified', () => {
  const excluded = new Set(['baseUrl','apiKey','fetchImpl','diagnosticLogger','reviewGateway']);
  for (const gateway of [new ModelGateway(), make()]) {
    assert.deepEqual(Object.keys(gateway).filter(key => !excluded.has(key) && !Object.hasOwn(MODEL_IDENTITY_FIELDS,key)), []);
  }
});

test('every allowlisted scalar setting contributes to the configuration digest', () => {
  const gateway = make();
  const baseline = describeModelGateway(gateway);
  for (const [field, name] of Object.entries(MODEL_IDENTITY_FIELDS)) {
    const original = gateway[field];
    gateway[field] = typeof original === 'boolean' ? !original : typeof original === 'number' ? original + 1 : `${original}-changed`;
    const changed = describeModelGateway(gateway);
    assert.equal(changed[name], gateway[field]);
    assert.notEqual(changed.effective_config_sha256, baseline.effective_config_sha256, field);
    gateway[field] = original;
  }
});

test('writer and reviewer retain their own settings without keys, URLs, functions or unknown properties', () => {
  const gateway = make({MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435/v1',
    MODEL_REVIEW_API_KEY:'synthetic-review-secret', MODEL_REVIEW_NAME:'synthetic-reviewer',
    MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false', MODEL_TIMEOUT_MS:'10000'});
  assert.ok(gateway.reviewGateway);
  gateway.unexpectedSecret = 'secret-added-later';
  const writer = describeModelGateway(gateway), reviewer = describeModelGateway(gateway.reviewGateway);
  assert.equal(writer.timeout_ms, 10000);
  assert.equal(reviewer.timeout_ms, 0);
  assert.equal(reviewer.model_requested, 'synthetic-reviewer');
  assert.notEqual(writer.endpoint_sha256, reviewer.endpoint_sha256);
  const text = JSON.stringify({writer,reviewer});
  for (const value of ['synthetic-secret-identity','synthetic-review-secret','secret-added-later','http://','fetchImpl','diagnosticLogger','apiKey']) {
    assert.equal(text.includes(value), false, value);
  }
  assert.equal(writer.runtime_model_identity_verified, false);
});
