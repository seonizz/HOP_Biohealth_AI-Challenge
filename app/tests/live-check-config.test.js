import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('live check sends the configured v11 prompt format and combined state request', async t => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(404); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    // A terminal synthetic rejection ends the check after the first real HTTP
    // request. No trained model, actual API credential or application DB is used.
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{"error":{"type":"synthetic_test_only"}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/live-check.js', import.meta.url))], {
    env: { PATH: process.env.PATH, MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      MODEL_API_KEY: 'synthetic-test-only', MODEL_NAME: 'malssi-gemma4-31b-v11-epoch3',
      MODEL_PROTOCOL: 'relationship_agent', MODEL_AGENT_FORMAT: 'prompt',
      MODEL_REASONING_EFFORT: 'omit', MODEL_STATE_MODE: 'combined', MODEL_TIMEOUT_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const guard = setTimeout(() => child.kill('SIGTERM'), 15000);
  t.after(() => clearTimeout(guard));
  const [code] = await once(child, 'close');
  assert.equal(code, 1, Buffer.concat(stderr).toString());
  assert.equal(received.length, 1);
  assert.equal(received[0].model, 'malssi-gemma4-31b-v11-epoch3');
  assert.equal(received[0].stream, false);
  assert.equal(Object.hasOwn(received[0], 'response_format'), false);
  assert.equal(Object.hasOwn(received[0], 'reasoning_effort'), false);
  assert.equal(JSON.parse(received[0].messages.at(-1).content).stage, 'turn_draft');
  assert.equal(JSON.parse(Buffer.concat(stdout).toString()).code, 'MODEL_AUTH_FAILED');
  assert.doesNotMatch(Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString(), /synthetic-test-only/);
});
