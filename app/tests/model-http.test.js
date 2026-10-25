import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { modelHttpFetch } from '../src/model-http.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}
const options = (extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', ...extra });

test('IPv6 loopback API preserves the configured endpoint and JSON transport', async t => {
  let received;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received={url:req.url,body:Buffer.concat(chunks).toString(),authorization:req.headers.authorization};
    res.setHeader('content-type','application/json');res.end('{"ok":true}');
  });
  const error=await new Promise(resolve=>{
    server.once('error',resolve);server.listen(0,'::1',()=>resolve(null));
  });
  if(error&&['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code)){t.skip('IPv6 loopback is unavailable on this host');return;}
  if(error)throw error;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const response=await modelHttpFetch(`http://[::1]:${server.address().port}/v1/chat/completions`,
    options({body:'{"synthetic":true}',headers:{Authorization:'Bearer synthetic-ipv6-only'}}));
  assert.deepEqual(await response.json(),{ok:true});
  assert.deepEqual(received,{url:'/v1/chat/completions',body:'{"synthetic":true}',authorization:'Bearer synthetic-ipv6-only'});
});

test('model metadata GET preserves authentication without a request body', async t => {
  let received;
  const url = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { method:req.method, headers:req.headers, bytes:Buffer.concat(chunks).length };
    res.end(JSON.stringify({model:'synthetic',max_output_tokens:8192,max_context_tokens:69632}));
  });
  const response = await modelHttpFetch(url, {method:'GET',headers:{Authorization:'Bearer synthetic-test-only'}});
  assert.equal((await response.json()).max_output_tokens,8192);
  assert.equal(received.method,'GET');
  assert.equal(received.headers.authorization,'Bearer synthetic-test-only');
  assert.equal(received.bytes,0);
  assert.equal(received.headers['content-length'],undefined);
});

test('model HTTP transport preserves POST bytes, headers, status, clone and JSON semantics', async t => {
  const body = '{ "message": "한글", "temperature": 0.2 }\n';
  let received;
  const url = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'present' });
    res.end('{"ok":true}');
  });
  const response = await modelHttpFetch(url, options({ body, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-test-only' } }));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('x-test'), 'present');
  assert.equal(response.bodyUsed, false);
  const copy = response.clone();
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await copy.text(), '{"ok":true}');
  assert.equal(response.bodyUsed, true);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/chat/completions');
  assert.deepEqual(received.body, Buffer.from(body));
  assert.equal(received.headers.authorization, 'Bearer synthetic-test-only');
  assert.equal(received.headers['content-length'], String(Buffer.byteLength(body)));
});

test('headers and body can each arrive later while the caller deadline remains active', async t => {
  const controller = new AbortController();
  const url = await serve(t, async (_req, res) => {
    await delay(35);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    await delay(35);
    res.end('{"late":true}');
  });
  const started = performance.now();
  const response = await modelHttpFetch(url, options({ signal: controller.signal }));
  const headersAt = performance.now();
  assert.deepEqual(await response.json(), { late: true });
  assert.ok(headersAt - started >= 25);
  assert.ok(performance.now() - headersAt >= 25);
  assert.equal(controller.signal.aborted, false);
});

test('aborting before response headers rejects and closes the owned socket', async t => {
  let notifyRequest;
  const received = new Promise(resolve => { notifyRequest = resolve; });
  let closed;
  const url = await serve(t, (req, _res) => {
    closed = once(req.socket, 'close');
    notifyRequest();
  });
  const controller = new AbortController();
  const pending = modelHttpFetch(url, options({ signal: controller.signal }));
  const rejection = assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  await received;
  controller.abort();
  await rejection;
  await closed;
});

test('aborting after headers rejects the body read and closes the owned socket', async t => {
  let closed;
  const url = await serve(t, (req, res) => {
    closed = once(req.socket, 'close');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"unfinished":');
  });
  const controller = new AbortController();
  const response = await modelHttpFetch(url, options({ signal: controller.signal }));
  const rejection = assert.rejects(response.json(), error => ['ABORT_ERR', 'ECONNRESET'].includes(error.code));
  controller.abort();
  await rejection;
  await closed;
});

test('cancelling an unread response body releases the request connection', async t => {
  let closed;
  const url = await serve(t, (req, res) => {
    closed = once(req.socket, 'close');
    res.writeHead(503, { 'Retry-After': '2' });
    res.write('unfinished upstream error');
  });
  const response = await modelHttpFetch(url, options());
  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  await response.body.cancel();
  await closed;
});

test('cancelling a compressed response also releases its source connection', async t => {
  let closed;
  const url = await serve(t, (req, res) => {
    closed = once(req.socket, 'close');
    res.writeHead(503, { 'Content-Encoding': 'gzip' });
    res.write(gzipSync('synthetic unfinished stream'));
  });
  const response = await modelHttpFetch(url, options());
  await response.body.cancel();
  await closed;
});

test('redirects remain visible and never forward authorization or POST body', async t => {
  let destinationCalls = 0;
  const destination = await serve(t, (_req, res) => { destinationCalls++; res.end('{}'); });
  const origin = await serve(t, (_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
  const response = await modelHttpFetch(origin, options({ headers: { Authorization: 'Bearer synthetic-test-only' }, body: '{"private":"synthetic"}' }));
  assert.equal(response.status, 307);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get('location'), destination);
  await response.text();
  assert.equal(destinationCalls, 0);
});

test('socket failures retain a transient code and invalid JSON retains SyntaxError', async t => {
  const reset = await serve(t, req => req.socket.destroy());
  await assert.rejects(modelHttpFetch(reset, options()), error => error.code === 'ECONNRESET');
  const invalid = await serve(t, (_req, res) => res.end('not JSON'));
  const response = await modelHttpFetch(invalid, options());
  await assert.rejects(response.json(), SyntaxError);
});

test('truncated bodies reject with the original transient connection classification', async t => {
  const url = await serve(t, async (req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('{"partial":');
    await delay(15);
    req.socket.destroy();
  });
  const response = await modelHttpFetch(url, options());
  await assert.rejects(response.json(), error => error.code === 'ECONNRESET');
});

for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`standard ${encoding} JSON responses remain readable`, async t => {
    const url = await serve(t, (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': encoding });
      res.end(compress('{"compressed":true}'));
    });
    assert.deepEqual(await (await modelHttpFetch(url, options())).json(), { compressed: true });
  });
}

test('null-body statuses and already-aborted callers retain Response behavior', async t => {
  const url = await serve(t, (_req, res) => { res.writeHead(204); res.end(); });
  const response = await modelHttpFetch(url, options());
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  const reason = new Error('synthetic cancellation');
  await assert.rejects(modelHttpFetch(url, options({ signal: AbortSignal.abort(reason) })), error => error === reason);
});

test('unsupported request forms fail before connecting', async () => {
  for (const url of ['ftp://example.invalid/', 'http://user:password@example.invalid/', 'http://example.invalid/#fragment']) {
    await assert.rejects(modelHttpFetch(url, options()), TypeError);
  }
  await assert.rejects(modelHttpFetch('http://example.invalid/', options({ method: 'GET' })), TypeError);
  await assert.rejects(modelHttpFetch('http://example.invalid/', options({ headers: { 'Content-Length': '1' } })), TypeError);
});

test('HTTPS dispatch keeps TLS verification defaults and disables implicit socket deadlines', async t => {
  const controller = new AbortController();
  let call;
  let socketTimeout;
  t.mock.method(https, 'request', (url, config, callback) => {
    call = { url, config };
    const request = new EventEmitter();
    request.end = bytes => {
      assert.deepEqual(bytes, Buffer.from('{}'));
      queueMicrotask(() => {
        request.emit('socket', { setTimeout: value => { socketTimeout = value; } });
        const response = new PassThrough();
        response.rawHeaders = ['Content-Type', 'application/json'];
        response.statusCode = 200;
        response.statusMessage = 'OK';
        callback(response);
        response.end('{"https":true}');
      });
    };
    return request;
  });
  const response = await modelHttpFetch('https://model.invalid/chat/completions', options({ signal: controller.signal }));
  assert.deepEqual(await response.json(), { https: true });
  assert.equal(call.url.protocol, 'https:');
  assert.equal(call.config.signal, controller.signal);
  assert.equal(call.config.timeout, 0);
  assert.equal(call.config.agent, false);
  assert.equal(Object.hasOwn(call.config, 'rejectUnauthorized'), false);
  assert.equal(socketTimeout, 0);
});
