import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWebSmokeAttempt, webSmokeFailureCode, webSmokeSessionId } from './web_smoke_evidence.mjs';

function historyDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'web-smoke-evidence-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  return directory;
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));

test('two failed invocations then a successful resume preserve all outcomes for one session', async t => {
  const directory = historyDirectory(t);
  const session = { session_id:randomUUID(), intake_id:randomUUID(), cookie:'private-cookie', csrf:'private-csrf' };
  const failures = ['MODEL_TIMEOUT', 'MODEL_INVALID_RESPONSE'];
  const saved = [];
  const snapshots = [];
  // Model/API behavior is injected; no HTTP connection or credential is needed.
  const invoke = async number => {
    const attempt = beginWebSmokeAttempt({ directory, runId:'same-run',
      sessionId:webSmokeSessionId(session), resumed:number > 0 });
    try {
      await Promise.resolve().then(() => {
        if (number < 2) throw Object.assign(new Error('remote detail'), { code:failures[number] });
      });
      attempt.finish({ status:'passed', intake_id:session.intake_id, turns:[{ question_id:'goal' }] });
    } catch (error) {
      attempt.finish({ status:'failed', error, intake_id:session.intake_id, turns:[] });
    }
    return attempt.resultPath;
  };
  for (let number = 0; number < 3; number++) {
    saved.push(await invoke(number));
    snapshots.push(readFileSync(saved[number], 'utf8'));
    for (let prior = 0; prior <= number; prior++) assert.equal(readFileSync(saved[prior], 'utf8'), snapshots[prior]);
  }
  const outcomes = saved.map(read);
  assert.equal(readdirSync(directory).length, 3);
  assert.equal(new Set(outcomes.map(result => result.attempt_id)).size, 3);
  assert.deepEqual(outcomes.map(result => result.session_id), Array(3).fill(session.session_id));
  assert.deepEqual(outcomes.map(result => result.run_id), Array(3).fill('same-run'));
  assert.deepEqual(outcomes.map(result => result.resumed), [false, true, true]);
  assert.deepEqual(outcomes.map(result => result.status), ['failed', 'failed', 'passed']);
  assert.deepEqual(outcomes.map(result => result.code), [...failures, undefined]);
  assert.equal(outcomes.filter(result => result.status === 'passed').length / outcomes.length, 1 / 3);
  assert.equal(JSON.stringify(outcomes).includes('private-'), false);
});

test('attempt ID collisions and repeated completion are rejected without changing evidence', t => {
  const directory = historyDirectory(t);
  const options = { directory, runId:'collision', sessionId:randomUUID(), attemptId:randomUUID() };
  const attempt = beginWebSmokeAttempt(options);
  attempt.finish({ status:'failed', error:new Error('connection_error') });
  const startPath = join(directory, options.attemptId, 'started.json');
  const beforeStart = readFileSync(startPath, 'utf8');
  const beforeResult = readFileSync(attempt.resultPath, 'utf8');
  assert.throws(() => beginWebSmokeAttempt(options), { code:'EEXIST' });
  assert.throws(() => attempt.finish({ status:'passed' }), { code:'EEXIST' });
  assert.equal(readFileSync(startPath, 'utf8'), beforeStart);
  assert.equal(readFileSync(attempt.resultPath, 'utf8'), beforeResult);
  assert.equal(readdirSync(directory).length, 1);
});

test('an interrupted attempt keeps its start marker and cannot be silently reused', t => {
  const directory = historyDirectory(t);
  const attemptId = randomUUID();
  beginWebSmokeAttempt({ directory, attemptId });
  assert.deepEqual(readdirSync(join(directory, attemptId)), ['started.json']);
  assert.equal(read(join(directory, attemptId, 'started.json')).session_id, null);
  assert.throws(() => beginWebSmokeAttempt({ directory, attemptId }), { code:'EEXIST' });
});

test('unknown errors and unexpected credential fields are excluded from evidence', t => {
  const directory = historyDirectory(t);
  const secrets = { cookie:'session=secret-cookie', csrf:'secret-csrf' };
  const attempt = beginWebSmokeAttempt({ directory, ...secrets });
  const error = Object.assign(new Error(`Cookie: ${secrets.cookie}`), { code:secrets.csrf });
  const result = attempt.finish({ status:'failed', error, ...secrets });
  const text = readFileSync(attempt.resultPath, 'utf8');
  assert.equal(result.code, 'web_smoke_error');
  assert.equal(webSmokeFailureCode(error), 'web_smoke_error');
  assert.equal(webSmokeFailureCode(new Error('missing_agent_result')), 'missing_agent_result');
  for (const secret of Object.values(secrets)) assert.equal(text.includes(secret), false);
  assert.equal(text.includes('Cookie:'), false);
});

test('legacy sessions retain a stable ID across resumes and invalid identities cannot create files', t => {
  const directory = historyDirectory(t);
  const intakeId = randomUUID();
  assert.equal(webSmokeSessionId({ intake_id:intakeId }), intakeId);
  const sessionId = randomUUID();
  assert.equal(webSmokeSessionId({ session_id:sessionId, intake_id:intakeId }), sessionId);
  assert.throws(() => webSmokeSessionId({ session_id:'invalid', intake_id:intakeId }), /invalid_test_session/);
  for (const options of [{ attemptId:'../escape' }, { sessionId:'invalid' }, { runId:'../escape' }]) {
    assert.throws(() => beginWebSmokeAttempt({ directory, ...options }), /invalid_web_smoke_identity/);
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('raw synthetic traces are stored with owner-only permissions', t => {
  const directory = historyDirectory(t);
  const attempt = beginWebSmokeAttempt({ directory });
  attempt.finish({ status:'passed', turns:[{ internal_analysis:{ synthetic:'original report' } }] });
  const attemptDirectory = join(directory, attempt.attemptId);
  assert.equal(statSync(attemptDirectory).mode & 0o777, 0o700);
  for (const file of ['started.json', 'result.json']) assert.equal(statSync(join(attemptDirectory, file)).mode & 0o777, 0o600);
});
