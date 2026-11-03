import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModelTokenPolicy } from '../src/model-token-policy.js';

const config = { baseUrl: 'https://model.test/service/v1', apiKey: 'synthetic-private-key', model: 'test-model' };
const metadata = { model: config.model, max_output_tokens: 8192, max_context_tokens: 32768, max_input_tokens: 24576 };
const discover = (value, options = {}) => discoverModelTokenPolicy({ ...config,
  fetchImpl: async () => new Response(JSON.stringify(value)), ...options });

test('discovery sends an authenticated GET beside v1 and returns only validated model budgets', async () => {
  const controller = new AbortController();
  for (const [baseUrl, expected] of [
    ['https://model.test/service/v1', 'https://model.test/service/healthz'],
    ['https://model.test/service/v1/', 'https://model.test/service/healthz'],
    ['http://model.test:11434/v1', 'http://model.test:11434/healthz'],
    ['https://model.test/service', 'https://model.test/service/healthz'],
    ['https://model.test/service/v10', 'https://model.test/service/v10/healthz'],
    ['https://model.test/', 'https://model.test/healthz'],
  ]) {
    const policy = await discover(metadata, { baseUrl, signal: controller.signal, fetchImpl: async (url, request) => {
      assert.equal(url, expected);
      assert.deepEqual(request, { method: 'GET', headers: { Authorization: 'Bearer ' + config.apiKey }, signal: controller.signal, redirect: 'error' });
      assert.equal(Object.hasOwn(request, 'body'), false);
      return new Response(JSON.stringify({ ...metadata, private_detail: 'must not escape' }));
    } });
    assert.deepEqual(policy, { maxOutputTokens: 8192, maxContextTokens: 32768, maxInputTokens: 24576 });
  }
});

test('unsupported health endpoints retain server defaults and release unread bodies', async () => {
  for (const status of [404, 405]) {
    let cancelled = false;
    const policy = await discover(null, { fetchImpl: async () => ({ status, ok: false, bodyUsed: false,
      body: { async cancel() { cancelled = true; } }, json() { assert.fail('unsupported body must not be read'); } }) });
    assert.equal(policy, null);
    assert.equal(cancelled, true);
  }
});

test('unrelated and absent metadata never supply a policy for the selected model', async () => {
  for (const value of [null, [], true, 'healthy', {}, { status: 'ok' }, { model: config.model },
    { ...metadata, model: 'other-model' }, { ...metadata, model: undefined },
    { model: config.model, max_input_tokens: 24576 }]) assert.equal(await discover(value), null);
});

test('advertised matching-model budgets must both be safe positive integers with output below context', async () => {
  for (const value of [
    { model: config.model, max_output_tokens: 8192 }, { model: config.model, max_context_tokens: 32768 },
    ...[undefined, null, 0, -1, 0.5, '8192', true, Number.MAX_SAFE_INTEGER + 1].map(max_output_tokens => ({ ...metadata, max_output_tokens })),
    ...[null, 0, -1, 0.5, '32768', true, Number.MAX_SAFE_INTEGER + 1, 8192, 8191].map(max_context_tokens => ({ ...metadata, max_context_tokens })),
  ]) await assert.rejects(discover(value), { message: 'model_token_policy_invalid' });
});

test('optional input budget is included only when valid and within the server context', async () => {
  for (const max_input_tokens of [undefined, null, 0, -1, 0.5, '24576', true, 32769, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await discover({ ...metadata, max_input_tokens }), { maxOutputTokens: 8192, maxContextTokens: 32768 });
  }
  assert.equal((await discover({ ...metadata, max_input_tokens: 32768 })).maxInputTokens, 32768);
});

test('only an opaque well-formed guarded policy revision may enable reuse',async()=>{
  for(const token_policy_revision of [undefined,null,42,'','a'.repeat(63),'A'.repeat(64),'private arbitrary text'])
    assert.equal(Object.hasOwn(await discover({...metadata,token_policy_revision}),'revision'),false);
  assert.equal((await discover({...metadata,token_policy_revision:'a'.repeat(64)})).revision,'a'.repeat(64));
});

test('HTTP and transport failures do not silently use a small default or expose response details', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 429, 500, 503]) {
    await assert.rejects(discover(null, { fetchImpl: async () => new Response('private server detail', { status }) }),
      { message: 'model_token_policy_unavailable' });
  }
  await assert.rejects(discover(null, { fetchImpl: async () => { throw new Error('private transport detail ' + config.apiKey); } }),
    { message: 'model_token_policy_unavailable' });
  await assert.rejects(discover(null, { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('private body detail'); } }) }),
    { message: 'model_token_policy_unavailable' });
  await assert.rejects(discover(null, { fetchImpl: async () => new Response('{private malformed metadata') }),
    { message: 'model_token_policy_invalid' });
});

test('caller cancellation is honored before dispatch and passed to an in-flight lookup', async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error('private cancellation reason'));
  await assert.rejects(discover(null, { signal: cancelled.signal, fetchImpl: async () => assert.fail('aborted lookup must not dispatch') }),
    { message: 'model_token_policy_unavailable' });
  const controller = new AbortController();
  const lookup = discover(null, { signal: controller.signal, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    assert.equal(signal, controller.signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  controller.abort(new Error('private cancellation reason'));
  await assert.rejects(lookup, { message: 'model_token_policy_unavailable' });
});
