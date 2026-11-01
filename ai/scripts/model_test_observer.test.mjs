import test from 'node:test';
import assert from 'node:assert/strict';
import { observeGateway } from './model_test_observer.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
const endpoint = 'http://private-user:private-password@example.test/private-prefix/v1/chat/completions?key=private-query';

test('arbitrary call counts are observed without a fixed stage or retry contract', async () => {
  for (const count of [1, 3, 7]) {
    const gateway = {async fetchImpl() { return new Response(null, {status:200}); }};
    const observer = observeGateway(gateway);
    for (let index = 0; index < count; index++) await gateway.fetchImpl(endpoint, {method:'POST'});
    assert.equal(observer.httpCalls.length, count);
    const summary = observer.snapshot();
    assert.equal(summary.total, count);
    assert.equal(summary.headers_received, count);
    assert.equal(summary.peak_outstanding_until_headers, 1);
    assert.equal(summary.pending, 0);
    assert.deepEqual(summary.by_route, {chat_completions:count});
    assert.equal(new Set(observer.httpCalls.map(row => row.id)).size, count);
  }
});

test('overlapping requests remain overlapping and settle in their original order', async () => {
  const deferreds = Array.from({length:7}, deferred), completed = [];
  let next = 0;
  const gateway = {fetchImpl() { return deferreds[next++].promise; }};
  const observer = observeGateway(gateway);
  const pending = deferreds.map((_, index) => gateway.fetchImpl(endpoint, {method:'POST'}).then(() => completed.push(index)));
  assert.equal(next, 7);
  assert.equal(observer.snapshot().pending, 7);
  assert.equal(observer.snapshot().peak_outstanding_until_headers, 7);
  for (const index of [3, 5, 1, 6, 0, 4, 2]) {
    deferreds[index].resolve(new Response(null));
    await pending[index];
  }
  assert.deepEqual(completed, [3, 5, 1, 6, 0, 4, 2]);
  assert.equal(observer.snapshot().pending, 0);
  assert.ok(observer.httpCalls.every(row => row.end_ms >= row.start_ms && row.duration_ms >= 0));
});

test('writer and reviewer transports share one dynamic summary without duplicate cyclic wrapping', async () => {
  const writer = {async fetchImpl() { return {status:200}; }};
  const reviewer = {async fetchImpl() { return {status:404}; }};
  writer.reviewGateway = reviewer; reviewer.reviewGateway = writer;
  const observer = observeGateway(writer);
  await writer.fetchImpl('http://example.test/healthz', {method:'GET'});
  await reviewer.fetchImpl('http://example.test/v1/models/private-model', {method:'GET'});
  await reviewer.fetchImpl('http://example.test/future-endpoint', {method:'POST'});
  assert.equal(observer.snapshot().total, 3);
  assert.deepEqual(observer.snapshot().by_role, {writer:1, reviewer:2});
  assert.deepEqual(observer.snapshot().by_route, {model_discovery:2, other:1});
  assert.equal(observer.snapshot().http_error_responses, 2);
});

test('this, arguments, response identity and unread streaming body are preserved', async () => {
  let streamController, observedThis, observedArgs;
  const body = new ReadableStream({start(controller) { streamController = controller; }});
  const response = new Response(body, {status:201});
  const gateway = {async fetchImpl(...args) { observedThis = this; observedArgs = args; return response; }};
  const observer = observeGateway(gateway), caller = {custom:true};
  const options = {method:'POST', headers:{Authorization:'Bearer private-header'}, body:'private-body'};
  const extra = {opaque:true};
  const returned = await gateway.fetchImpl.call(caller, endpoint, options, extra);
  assert.equal(observedThis, caller);
  assert.equal(observedArgs[0], endpoint); assert.equal(observedArgs[1], options); assert.equal(observedArgs[2], extra);
  assert.equal(returned, response); assert.equal(returned.body, body);
  assert.equal(returned.bodyUsed, false); assert.equal(body.locked, false);
  assert.equal(observer.snapshot().pending, 0);
  assert.equal(observer.snapshot().response_bodies_observed, false);
  streamController.enqueue(new TextEncoder().encode('delayed body'));
  streamController.close();
  assert.equal(await returned.text(), 'delayed body');
  assert.equal(observer.snapshot().total, 1);
  const saved = JSON.stringify({calls:observer.httpCalls, summary:observer.snapshot()});
  for (const privateValue of ['private-user', 'private-password', 'private-prefix', 'private-query', 'private-header', 'private-body', 'example.test']) {
    assert.equal(saved.includes(privateValue), false);
  }
});

test('original synchronous throws and rejected values propagate without leaking error details', async () => {
  const secret = new Error('private-host private-key private-payload');
  let synchronous = true;
  const gateway = {fetchImpl() { if (synchronous) throw secret; return Promise.reject(secret); }};
  const observer = observeGateway(gateway);
  assert.throws(() => gateway.fetchImpl(endpoint, {method:'POST'}), error => error === secret);
  synchronous = false;
  await assert.rejects(gateway.fetchImpl(endpoint, {method:'POST'}), error => error === secret);
  assert.equal(observer.snapshot().transport_errors, 2);
  assert.equal(observer.snapshot().pending, 0);
  assert.ok(observer.httpCalls.every(row => row.error === 'TRANSPORT_ERROR' && row.status === null));
  assert.equal(JSON.stringify(observer.httpCalls).includes('private-'), false);
});

test('unknown response statuses and unusual inputs stay observable without changing transport values', async () => {
  const responses = [{}, {status:NaN}, {status:700}, {get status() { throw new Error('private-status'); }}];
  let next = 0;
  const gateway = {fetchImpl() { return responses[next++]; }};
  const observer = observeGateway(gateway);
  for (const response of responses) assert.equal(gateway.fetchImpl('not a URL', {method:'private-method'}), response);
  assert.equal(observer.snapshot().unknown_status_responses, 4);
  assert.ok(observer.httpCalls.every(row => row.method === 'UNKNOWN' && row.route === 'other' && row.status === null));
  assert.equal(observer.snapshot().transport_errors, 0);
});

test('Request and URL inputs record only bounded route and method labels', async () => {
  const gateway = {async fetchImpl() { return new Response(null); }};
  const observer = observeGateway(gateway);
  await gateway.fetchImpl(new URL('http://example.test/api/tags?secret=private'));
  await gateway.fetchImpl(new Request('http://example.test/v1/chat/completions', {method:'POST', body:'private'}));
  assert.deepEqual(observer.httpCalls.map(row => [row.method,row.route]), [['GET','model_discovery'],['POST','chat_completions']]);
});
