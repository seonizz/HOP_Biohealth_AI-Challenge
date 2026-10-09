/** HTTP + real PostgreSQL integration tests. Only the model boundary is injected.
 * DATABASE_URL or HOP_TEST_DATABASE_URL must use a test/migrator role that can
 * create isolated schemas. Every test uses and removes only its own schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.ts';
import { getSettings } from '../src/config.ts';
import { ModelError } from '../src/llm.ts';
import type { ModelGateway, Extraction, Coaching, Verification } from '../src/llm.ts';
import { Store } from '../src/storage.ts';

const databaseUrl = process.env.HOP_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const integration = databaseUrl ? test : test.skip;

type Context = Record<string, any>;
class FakeGateway {
  answerIds = [1];
  answerSource: 'observation' | 'reported' | 'interpretation' = 'observation';
  coachingOverride: Partial<Coaching> = {};
  unknown = false;
  failAt: 'extract' | 'coach' | 'verify' | null = null;
  rejectFirst = false;
  rejectAlways = false;
  safetyFlag = false;
  calls = { extract: 0, coach: 0, verify: 0, title: 0 };
  contexts: { extract: Context[]; coach: Context[]; verify: Context[] } = { extract: [], coach: [], verify: [] };
  async extract(context: Context): Promise<Extraction> {
    this.calls.extract++;
    this.contexts.extract.push(structuredClone(context));
    if (this.failAt === 'extract') throw new ModelError('테스트 모델 연결 실패', 'connection');
    return {
      answers: this.answerIds.map(question_id => ({
        question_id,
        value: String(context.current_message),
        status: this.unknown ? 'unknown' : 'answered',
        source: this.unknown ? 'unknown' : this.answerSource,
        evidence: String(context.current_message),
      })),
      domains: [],
      safety_flag: this.safetyFlag,
    };
  }
  async coach(context: Context): Promise<Coaching> {
    this.calls.coach++;
    this.contexts.coach.push(structuredClone(context));
    if (this.failAt === 'coach') throw new ModelError('테스트 코칭 연결 실패', 'connection');
    return {
      reply: '먼저 상대가 이야기할 준비가 되었는지 확인해 보세요.',
      suggested_words: ['괜찮다면 요즘 어떻게 지내는지 듣고 싶어요.'],
      actions: ['상대가 편한 대화 시간을 물어보세요.'],
      avoid: ['답변을 재촉하지 마세요.'],
      citations: [],
      ...this.coachingOverride,
    };
  }
  async verify(context: Context): Promise<Verification> {
    this.calls.verify++;
    this.contexts.verify.push(structuredClone(context));
    if (this.failAt === 'verify') throw new ModelError('테스트 검증 연결 실패', 'connection');
    if (this.rejectAlways || (this.rejectFirst && this.calls.verify === 1)) return { approved: false, issues: ['상대의 의사를 먼저 확인하는 표현을 넣어주세요.'] };
    return { approved: true, issues: [] };
  }
  async title(): Promise<string> { this.calls.title++; return '친구를 위한 도움 대화'; }
}

async function harness(t: { after: (callback: () => Promise<void>) => void }, gateway = new FakeGateway()) {
  const schema = 'hop_test_' + randomUUID().replaceAll('-', '');
  const settings = getSettings({ databaseUrl, databaseSchema: schema, migrateOnStart: false, port: 0, host: '127.0.0.1', modelMode: 'local', allowRegistration: true, inviteCode: 'test-invite', cookieSecure: false, publicOrigin: 'http://127.0.0.1:9000' });
  const migrator = await Store.connect(databaseUrl, { schema });
  let app: Awaited<ReturnType<typeof createApp>>;
  let base = '';
  let stopped = true;
  async function start() {
    app = await createApp(settings, gateway as unknown as ModelGateway);
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
    stopped = false;
  }
  async function stop() {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    await app.store.close();
  }
  t.after(async () => {
    try { await stop(); }
    finally {
      // This identifier was generated here and validated before schema creation.
      assert.match(schema, /^hop_test_[a-f0-9]{32}$/u);
      try { await migrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await migrator.close(); }
    }
  });
  await start();
  async function request(method: string, path: string, body?: unknown, token?: string, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { assert.fail(`Expected JSON for ${method} ${path}: HTTP ${response.status}`); }
    }
    return { status: response.status, data, headers: response.headers };
  }
  async function session() {
    const credentials = { email: `test-${randomUUID()}@example.invalid`, password: `Test-Aa3!-${randomUUID()}` };
    const registration = await request('POST', '/api/auth/register', { ...credentials, invite_code: 'test-invite' });
    assert.ok([200, 201].includes(registration.status), JSON.stringify(registration.data));
    const result = await request('POST', '/api/auth/login', credentials);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(typeof result.data.token, 'string');
    assert.ok(result.data.token.length >= 32);
    return result.data.token as string;
  }
  async function project(token: string, title = '친구 도움 기록') {
    const result = await request('POST', '/api/projects', { title }, token);
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
    assert.equal(typeof result.data.id, 'string');
    return result.data;
  }
  return {
    gateway, settings, request, session, project,
    get app() { return app; },
    async restart() { await stop(); await start(); },
  };
}

const message = (text = '저는 친구이고 매주 연락합니다.', extra: Record<string, unknown> = {}) => ({ request_id: randomUUID(), text, ...extra });
const readiness = (data: any) => data.readiness ?? data.project?.readiness;
const good = (result: { status: number; data: any }) => assert.equal(result.status, 200, JSON.stringify(result.data));

integration('protected routes require a valid session bearer token', async t => {
  const h = await harness(t);
  assert.equal((await h.request('GET', '/api/projects')).status, 401);
  assert.equal((await h.request('GET', '/api/projects', undefined, 'invalid')).status, 401);
  assert.equal((await h.request('POST', '/api/projects', { title: '기록' })).status, 401);
});

integration('sessions are independent; another owner cannot list, read, mutate or delete a project', async t => {
  const h = await harness(t);
  const owner = await h.session(), other = await h.session();
  assert.notEqual(owner, other);
  const project = await h.project(owner);
  const otherList = await h.request('GET', '/api/projects', undefined, other);
  good(otherList); assert.deepEqual(otherList.data.projects, []);
  for (const [method, path, body] of [
    ['GET', `/api/projects/${project.id}`, undefined],
    ['GET', `/api/projects/${project.id}/messages`, undefined],
    ['POST', `/api/projects/${project.id}/messages`, message()],
    ['DELETE', `/api/projects/${project.id}`, undefined],
  ] as const) assert.equal((await h.request(method, path, body, other)).status, 404);
  good(await h.request('GET', `/api/projects/${project.id}`, undefined, owner));
  assert.equal(h.gateway.calls.extract, 0);
});

integration('a new project begins with the relation question and no fabricated answers', async t => {
  const h = await harness(t);
  const token = await h.session();
  const project = await h.project(token);
  assert.equal(project.title, '친구 도움 기록');
  assert.equal(project.pending_question_id, 1);
  assert.equal(project.revision, 0);
  assert.deepEqual(project.profile, {});
  const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
  good(history); assert.deepEqual(history.data.messages, []);
});

integration('an interview turn saves grounded profile, messages and next question atomically', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token);
  const payload = message();
  const response = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(response);
  assert.equal(response.data.project.revision, 1);
  assert.equal(response.data.project.profile['1'].status, 'answered');
  assert.equal(response.data.project.profile['1'].evidence, payload.text);
  assert.equal(response.data.project.profile['1'].source, 'observation');
  assert.equal(response.data.question.id, 2);
  assert.equal(readiness(response.data).ready, false);
  assert.equal(response.data.model_mode, 'local');
  const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
  assert.deepEqual(history.data.messages.map((entry: any) => entry.role), ['user', 'assistant']);
  assert.equal(history.data.messages[0].content, payload.text);
});

integration('same request UUID and payload return the cached response without duplicate model calls or messages', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token), payload = message();
  const first = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  const second = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(first); good(second); assert.deepEqual(second.data, first.data);
  assert.equal(h.gateway.calls.extract, 1);
  const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
  assert.equal(history.data.messages.length, 2);
});

integration('reusing a request UUID for changed text or flags produces 409', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token), payload = message();
  good(await h.request('POST', `/api/projects/${project.id}/messages`, payload, token));
  for (const changed of [{ ...payload, text: '바뀐 답변입니다.' }, { ...payload, coach_now: true }]) {
    assert.equal((await h.request('POST', `/api/projects/${project.id}/messages`, changed, token)).status, 409);
  }
  assert.equal(h.gateway.calls.extract, 1);
});

integration('one rich initial response can satisfy readiness and start coaching before all 17 questions', async t => {
  const gateway = new FakeGateway(); gateway.answerIds = [1, 2, 4, 15, 7];
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message('저는 매주 만나는 친구입니다. 친구가 잠들기 힘들다고 했고 혼자 지낼까 걱정됩니다. 부담 없이 건넬 말을 알고 싶고 산책을 함께할 수 있습니다.'), token);
  good(result);
  assert.equal(readiness(result.data).ready, true);
  assert.equal(readiness(result.data).answered_count, 5);
  assert.equal(result.data.question, null);
  assert.ok(result.data.coaching?.reply);
  assert.equal(gateway.calls.coach, 1);
  assert.equal(gateway.calls.verify, 1);
});

integration('unknown answers remain unknown and do not increase readiness', async t => {
  const gateway = new FakeGateway(); gateway.unknown = true;
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message('잘 모르겠습니다.'), token);
  good(result);
  assert.equal(result.data.project.profile['1'].status, 'unknown');
  assert.equal(readiness(result.data).answered_count, 0);
  assert.equal(readiness(result.data).ready, false);
  assert.equal(result.data.question.id, 2);
});

integration('skipping all 17 questions terminates the interview as limited without claiming readiness', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token);
  let last: any;
  const asked = new Set<number>();
  for (let index = 0; index < 17; index++) {
    const result = await h.request('POST', `/api/projects/${project.id}/messages`, message('', { skip: true }), token);
    good(result); last = result.data;
    if (last.question) {
      assert.ok(!asked.has(last.question.id));
      asked.add(last.question.id);
    }
  }
  assert.equal(last.project.status, 'coaching');
  assert.equal(last.validation.limited_profile, true);
  assert.equal(last.question, null);
  assert.equal(readiness(last).ready, false);
  assert.equal(readiness(last).answered_count, 0);
  assert.equal(readiness(last).addressed_count, 17);
  assert.equal(h.gateway.calls.extract, 0);
});

integration('explicit immediate coaching works with a partial profile while readiness remains false', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message('저는 친구이고 지금 어떤 말을 건네면 좋을지 알고 싶습니다.', { coach_now: true }), token);
  good(result);
  assert.ok(result.data.coaching?.reply);
  assert.equal(readiness(result.data).ready, false);
  assert.equal(result.data.project.status, 'coaching');
  assert.equal(result.data.validation.limited_profile, true);
  assert.equal(h.gateway.calls.coach, 1);
  assert.equal(h.gateway.calls.verify, 1);
});

for (const stage of ['extract', 'coach', 'verify'] as const) {
  integration(`${stage} failure saves no partial turn and the same request can succeed after recovery`, async t => {
    const gateway = new FakeGateway(); gateway.failAt = stage;
    const h = await harness(t, gateway);
    const token = await h.session(), project = await h.project(token);
    const payload = message('저는 매주 연락하는 친구입니다.', { coach_now: true });
    const failed = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
    assert.ok([502, 503, 504].includes(failed.status), JSON.stringify(failed.data));
    const unchanged = await h.request('GET', `/api/projects/${project.id}`, undefined, token);
    good(unchanged);
    assert.equal(unchanged.data.revision, 0);
    assert.deepEqual(unchanged.data.profile, {});
    const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
    assert.deepEqual(history.data.messages, []);
    gateway.failAt = null;
    const recovered = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
    good(recovered); assert.equal(recovered.data.project.revision, 1);
  });
}

integration('failed intermediate validation causes a revised draft and a second verification', async t => {
  const gateway = new FakeGateway(); gateway.rejectFirst = true;
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message(undefined, { coach_now: true }), token);
  good(result);
  assert.equal(gateway.calls.coach, 2);
  assert.equal(gateway.calls.verify, 2);
  assert.match(JSON.stringify(gateway.contexts.coach[1]), /상대의 의사를 먼저 확인/u);
  assert.equal(result.data.validation.approved, true);
});

integration('an explicit immediate danger message uses static local help without waiting for a model', async t => {
  const gateway = new FakeGateway(); gateway.failAt = 'extract';
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message('친구가 지금 자살하겠다고 했어요.'), token);
  good(result);
  assert.match(result.data.reply, /119|112/u);
  assert.equal(gateway.calls.extract, 0);
  assert.equal(gateway.calls.coach, 0);
  assert.equal(gateway.calls.verify, 0);
});

integration('project memory, session authentication and request cache survive server and PostgreSQL pool reopen', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token), payload = message('저는 매주 연락하는 오래된 친구입니다.');
  const first = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(first);
  await h.restart();
  const listed = await h.request('GET', '/api/projects', undefined, token);
  good(listed); assert.equal(listed.data.projects[0].id, project.id);
  const cached = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(cached); assert.deepEqual(cached.data, first.data);
  assert.equal(h.gateway.calls.extract, 1);
  const continued = await h.request('POST', `/api/projects/${project.id}/messages`, message('이전에 말씀드린 내용에서 이어서 이야기하고 싶습니다.'), token);
  good(continued);
  assert.match(JSON.stringify(h.gateway.contexts.extract.at(-1)), /매주 연락하는 오래된 친구/u);
  assert.equal(continued.data.project.revision, 2);
});

integration('deleting a project removes dependent history and cached requests while leaving other projects', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token), other = await h.project(token, '다른 도움 기록');
  good(await h.request('POST', `/api/projects/${project.id}/messages`, message(), token));
  const removed = await h.request('DELETE', `/api/projects/${project.id}`, undefined, token);
  assert.ok([200, 204].includes(removed.status));
  assert.equal((await h.request('GET', `/api/projects/${project.id}`, undefined, token)).status, 404);
  for (const table of ['messages', 'requests', 'profile_versions']) {
    const result = await h.app.store.pool.query(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE project_id=$1`, [project.id]);
    assert.equal(result.rows[0].n, 0);
  }
  const listed = await h.request('GET', '/api/projects', undefined, token);
  assert.deepEqual(listed.data.projects.map((entry: any) => entry.id), [other.id]);
});

integration('invalid message inputs fail before model work or state mutation', async t => {
  const h = await harness(t);
  const token = await h.session(), project = await h.project(token);
  for (const payload of [message(' '), message(undefined, { request_id: 'not-a-uuid' }), message(undefined, { coach_now: 'true' }), message(undefined, { skip: 'false' }), message('x'.repeat(30_000))]) {
    const result = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
    assert.ok([400, 413, 422].includes(result.status), JSON.stringify(result.data));
  }
  assert.equal(h.gateway.calls.extract, 0);
  const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
  assert.deepEqual(history.data.messages, []);
});

integration('registration requires the team invite; duplicate email and incorrect passwords are rejected', async t => {
  const h = await harness(t);
  const credentials = { email: `auth-${randomUUID()}@example.invalid`, password: 'Correct-test-passphrase-123!' };
  assert.equal((await h.request('POST', '/api/auth/register', credentials)).status, 403);
  const registered = await h.request('POST', '/api/auth/register', { ...credentials, invite_code: 'test-invite' });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.user.email, credentials.email);
  assert.equal(registered.data.user.password_hash, undefined);
  assert.equal((await h.request('POST', '/api/auth/register', { ...credentials, email: credentials.email.toUpperCase(), invite_code: 'test-invite' })).status, 409);
  assert.equal((await h.request('POST', '/api/auth/login', { ...credentials, password: 'Wrong-password' })).status, 401);
  assert.equal((await h.request('POST', '/api/auth/login', { ...credentials, email: 'missing@example.invalid' })).status, 401);
  assert.notEqual((await h.request('POST', '/api/sessions', {})).status, 201);
});

integration('HttpOnly SameSite cookie authenticates and logout revokes that session', async t => {
  const h = await harness(t);
  const registered = await h.request('POST', '/api/auth/register', { email: `cookie-${randomUUID()}@example.invalid`, password: 'Cookie-test-password-123!', invite_code: 'test-invite' });
  assert.equal(registered.status, 201);
  const setCookie = registered.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  const cookie = setCookie.split(';')[0];
  const me = await h.request('GET', '/api/auth/me', undefined, undefined, { Cookie: cookie });
  good(me); assert.equal(me.data.user.id, registered.data.user.id);
  const logout = await h.request('POST', '/api/auth/logout', {}, undefined, { Cookie: cookie, Origin:h.settings.publicOrigin });
  good(logout); assert.equal(logout.data.logged_out, true);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/u);
  assert.equal((await h.request('GET', '/api/auth/me', undefined, undefined, { Cookie: cookie })).status, 401);
  assert.equal((await h.request('GET', '/api/auth/me', undefined, registered.data.token)).status, 401);
});

integration('foreign-origin mutation is denied even with a valid bearer token', async t => {
  const h = await harness(t);
  const token = await h.session();
  assert.equal((await h.request('POST', '/api/projects', { title: '기록' }, token, { Origin: 'https://untrusted.invalid' })).status, 403);
  const list = await h.request('GET', '/api/projects', undefined, token);
  assert.deepEqual(list.data.projects, []);
});

integration('two rejected drafts are discarded without saving a user turn or profile', async t => {
  const gateway = new FakeGateway(); gateway.rejectAlways = true;
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message(undefined, { coach_now: true }), token);
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'verification_failed');
  assert.equal(result.data.message_saved, false);
  assert.equal(gateway.calls.coach, 2);
  assert.equal(gateway.calls.verify, 2);
  const persisted = await h.request('GET', `/api/projects/${project.id}`, undefined, token);
  assert.equal(persisted.data.revision, 0);
  assert.deepEqual((await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token)).data.messages, []);
});

integration('a later interpretation preserves the earlier observation and its provenance across reopen and replay', async t => {
  const gateway = new FakeGateway(); gateway.answerIds = [2];
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const observed = '친구가 지난주 세 번 연락을 피하는 것을 직접 봤습니다.';
  const first = await h.request('POST', `/api/projects/${project.id}/messages`, message(observed), token);
  good(first);
  const original = first.data.project.profile['2'];
  assert.equal(original.source, 'observation');
  assert.deepEqual(original.previous_reports, []);

  gateway.answerSource = 'interpretation';
  const interpreted = '제가 보기에는 답장이 늦는 이유가 업무 때문인 것 같습니다.';
  const payload = message(interpreted, { coach_now: true });
  const second = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(second);
  const current = second.data.project.profile['2'];
  assert.equal(current.value, interpreted);
  assert.equal(current.source, 'interpretation');
  assert.equal(current.evidence, interpreted);
  assert.notEqual(current.message_id, original.message_id);
  assert.deepEqual(current.previous_reports, [{
    status: original.status, value: observed, source: 'observation', evidence: observed,
    message_id: original.message_id, updated_at: original.updated_at,
  }]);
  const modelProfile = gateway.contexts.coach.at(-1)!.profile['2'];
  assert.equal(modelProfile.source, 'interpretation');
  assert.equal(modelProfile.previous_reports[0].source, 'observation');
  assert.equal(modelProfile.previous_reports[0].message_id, original.message_id);
  assert.match(modelProfile.history_rule, /과거 보고/u);

  await h.restart();
  const persisted = await h.request('GET', `/api/projects/${project.id}`, undefined, token);
  good(persisted);
  assert.deepEqual(persisted.data.profile['2'], current);
  const replayed = await h.request('POST', `/api/projects/${project.id}/messages`, payload, token);
  good(replayed);
  assert.deepEqual(replayed.data, second.data);
  assert.equal(replayed.data.project.profile['2'].previous_reports.length, 1);
  assert.equal(gateway.calls.extract, 2);
});

integration('report history retains eight past observations while coaching receives only the two most recent bounded excerpts', async t => {
  const gateway = new FakeGateway(); gateway.answerIds = [2];
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const reports = Array.from({ length: 10 }, (_, index) => `관찰 ${index}: ${'친구가 연락을 늦게 확인했습니다. '.repeat(16)}`.trim());
  let latest: any;
  for (const [index, report] of reports.entries()) {
    const response = await h.request('POST', `/api/projects/${project.id}/messages`, message(report, { coach_now: index === reports.length - 1 }), token);
    good(response); latest = response.data.project.profile['2'];
  }
  assert.equal(latest.value, reports[9]);
  assert.equal(latest.previous_reports.length, 8);
  assert.deepEqual(latest.previous_reports.map((entry: any) => entry.value), reports.slice(1, 9));
  assert.deepEqual(latest.previous_reports.map((entry: any) => entry.evidence), reports.slice(1, 9));
  assert.equal(new Set(latest.previous_reports.map((entry: any) => entry.message_id)).size, 8);
  assert.ok(latest.previous_reports.every((entry: any) => entry.source === 'observation' && !('previous_reports' in entry)));

  const compact = gateway.contexts.coach.at(-1)!.profile['2'];
  assert.equal(compact.value, reports[9]);
  assert.equal(compact.previous_reports.length, 2);
  assert.deepEqual(compact.previous_reports.map((entry: any) => entry.value), reports.slice(7, 9).map(value => value.slice(0, 200)));
  assert.deepEqual(compact.previous_reports.map((entry: any) => entry.evidence), reports.slice(7, 9).map(value => value.slice(0, 200)));
  assert.deepEqual(compact.previous_reports.map((entry: any) => entry.message_id), latest.previous_reports.slice(-2).map((entry: any) => entry.message_id));
  const persisted = await h.request('GET', `/api/projects/${project.id}`, undefined, token);
  assert.deepEqual(persisted.data.profile['2'], latest);
});

integration('diagnostic claims quoted only as phrases to avoid pass deterministic checks and still reach the semantic verifier', async t => {
  const gateway = new FakeGateway();
  const avoid = ['“우울증입니다”라고 상대를 단정하는 표현', '“불안 90점”처럼 근거 없이 점수를 붙이는 말'];
  gateway.coachingOverride = { avoid };
  const h = await harness(t, gateway);
  const token = await h.session(), project = await h.project(token);
  const result = await h.request('POST', `/api/projects/${project.id}/messages`, message(undefined, { coach_now: true }), token);
  good(result);
  assert.deepEqual(result.data.coaching.avoid, avoid);
  assert.equal(result.data.validation.approved, true);
  assert.equal(result.data.validation.attempts, 1);
  assert.equal(gateway.calls.coach, 1);
  assert.equal(gateway.calls.verify, 1);
  assert.deepEqual(gateway.contexts.verify[0].draft.avoid, avoid);
  const history = await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token);
  assert.equal(history.data.messages.length, 2);
  assert.deepEqual(history.data.messages[1].metadata.coaching.avoid, avoid);
});

for (const [field, override] of [
  ['reply', { reply: '우울증입니다.' }],
  ['suggested_words', { suggested_words: ['불안장애입니다.'] }],
  ['actions', { actions: ['불안 90점이라고 설명하세요.'] }],
] as const) {
  integration(`unsupported diagnostic claims in ${field} remain blocked even when the semantic verifier approves`, async t => {
    const gateway = new FakeGateway(); gateway.coachingOverride = structuredClone(override) as Partial<Coaching>;
    const h = await harness(t, gateway);
    const token = await h.session(), project = await h.project(token);
    const result = await h.request('POST', `/api/projects/${project.id}/messages`, message(undefined, { coach_now: true }), token);
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'verification_failed');
    assert.equal(result.data.message_saved, false);
    assert.equal(gateway.calls.coach, 2);
    assert.equal(gateway.calls.verify, 2);
    const persisted = await h.request('GET', `/api/projects/${project.id}`, undefined, token);
    assert.equal(persisted.data.revision, 0);
    assert.deepEqual((await h.request('GET', `/api/projects/${project.id}/messages`, undefined, token)).data.messages, []);
  });
}

integration('cookie changes require an allowed Origin and CORS preflight exposes usable headers', async t => {
  const h = await harness(t), token = await h.session();
  const cookie = 'hop_session='+token;
  const denied = await h.request('POST','/api/projects',{title:'기록'},undefined,{Cookie:cookie});
  assert.equal(denied.status,403); assert.equal(denied.data.code,'origin_required');
  assert.equal((await h.request('POST','/api/projects',{title:'기록'},undefined,{Cookie:cookie,Origin:h.settings.publicOrigin})).status,201);
  assert.equal((await h.request('GET','/api/auth/me',undefined,undefined,{Cookie:cookie,Authorization:'Basic invalid'})).status,401);
  const preflight = await h.request('OPTIONS','/api/projects',undefined,undefined,{Origin:h.settings.publicOrigin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),h.settings.publicOrigin);
  assert.match(preflight.headers.get('access-control-expose-headers') || '',/Retry-After/);
  assert.ok(preflight.headers.get('x-request-id'));
});

integration('password change invalidates every previous session and preserves the newly issued session', async t => {
  const h = await harness(t);
  const input = {email:'password-'+randomUUID()+'@example.invalid',password:'Previous-safe-password-123!'};
  const first = await h.request('POST','/api/auth/register',{...input,invite_code:'test-invite'});
  const second = await h.request('POST','/api/auth/login',input);
  const invalid = await h.request('POST','/api/auth/password',{current_password:'Wrong-password',new_password:'New-safe-password-123!'},first.data.token);
  assert.equal(invalid.status,401);
  good(await h.request('GET','/api/auth/me',undefined,second.data.token));
  const changed = await h.request('POST','/api/auth/password',{current_password:input.password,new_password:'New-safe-password-123!'},first.data.token);
  good(changed); assert.notEqual(changed.data.token,first.data.token);
  assert.equal((await h.request('GET','/api/auth/me',undefined,first.data.token)).status,401);
  assert.equal((await h.request('GET','/api/auth/me',undefined,second.data.token)).status,401);
  good(await h.request('GET','/api/auth/me',undefined,changed.data.token));
  assert.equal((await h.request('POST','/api/auth/login',input)).status,401);
  good(await h.request('POST','/api/auth/login',{...input,password:'New-safe-password-123!'}));
});

integration('project and history cursors cover every item without duplicates and reject invalid scopes', async t => {
  const h = await harness(t), token = await h.session(), other = await h.session();
  const projects = await Promise.all([h.project(token,'첫째'),h.project(token,'둘째'),h.project(token,'셋째')]);
  const ids: string[] = [];
  let cursor: string | null = null, firstCursor = '';
  do {
    const page = await h.request('GET','/api/projects?limit=1'+(cursor?'&cursor='+cursor:''),undefined,token);
    good(page); ids.push(...page.data.projects.map((p: any)=>p.id));
    cursor = page.data.next_cursor; if (!firstCursor && cursor) firstCursor=cursor;
  } while (cursor);
  assert.equal(new Set(ids).size,3); assert.deepEqual(new Set(ids),new Set(projects.map(p=>p.id)));
  assert.equal((await h.request('GET','/api/projects?cursor='+firstCursor,undefined,other)).status,422);
  for (const query of ['limit=0','limit=101','limit=1&limit=2','cursor=bad','cursor=']) assert.equal((await h.request('GET','/api/projects?'+query,undefined,token)).status,422);
  const project=projects[0];
  for(let i=0;i<3;i++) good(await h.request('POST','/api/projects/'+project.id+'/messages',message('답변 '+i),token));
  let combined: any[] = [], messageCursor: string | null = null;
  do {
    const page = await h.request('GET','/api/projects/'+project.id+'/messages?limit=2'+(messageCursor?'&cursor='+messageCursor:''),undefined,token);
    good(page); combined=[...page.data.messages,...combined]; messageCursor=page.data.next_cursor;
    if(messageCursor) assert.equal((await h.request('GET','/api/projects/'+projects[1].id+'/messages?cursor='+messageCursor,undefined,token)).status,422);
  } while(messageCursor);
  const full=await h.request('GET','/api/projects/'+project.id+'/messages',undefined,token);
  assert.equal(combined.length,6);assert.equal(new Set(combined.map(m=>m.id)).size,6);assert.deepEqual(combined,full.data.messages);
});
