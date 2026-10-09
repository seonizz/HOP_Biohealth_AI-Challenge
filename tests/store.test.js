import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/store.js';
import { createIntake, answerIntake, backIntake, buildContext, currentView } from '../src/intake.js';
import { initialQuestionRows, initialQuestionSet } from '../src/question-bank.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = (name, run) => test(name, { skip: !databaseUrl && 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, run);

async function fixture(t) {
  const schema = `test_store_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const f = { schema, key: randomBytes(32), admin, store: null };
  // Only this test's randomly named schema is dropped; the supplied database remains intact.
  t.after(async () => {
    try { await f.store?.close(); }
    finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  f.store = await Store.connect(databaseUrl, f.key, 30, { schema });
  return f;
}

const exampleRecord = (id = 'demo-record') => ({ id, date: '2026-10-09T01:00:00.000Z', name: '동생', text: '요즘 식사량이 줄었어요.' });
const answer = (state, question_id, text) => answerIntake(state, { question_id, text });

databaseTest('anonymous browser tokens expire while server verification records remain and stay isolated', async t => {
  const { store } = await fixture(t);
  const first = await store.createBrowser();
  const other = await store.createBrowser();
  assert.deepEqual(await store.browser(first.token), { id: first.id, csrf: first.csrf });
  assert.equal(await store.browser('invalid'), null);
  const tokenRow = (await store.pool.query('SELECT token_hash FROM browsers WHERE id=$1', [first.id])).rows[0];
  assert.notEqual(tokenRow.token_hash, first.token);
  const intake = await store.createIntake(first.id, createIntake());
  await store.saveRecord(first.id, exampleRecord(), intake.id);
  await store.setColumnState(first.id, 'article-1', { saved: true });
  assert.deepEqual(await store.records(other.id), []);
  assert.deepEqual(await store.columnState(other.id), { read: [], saved: [] });
  await assert.rejects(store.intake(other.id, intake.id), { status: 404 });
  await assert.rejects(store.context(other.id, intake.id), { status: 404 });
  await assert.rejects(store.record(other.id, 'demo-record'), { status: 404 });
  await assert.rejects(store.deleteRecord(other.id, 'demo-record'), { status: 404 });
  await assert.rejects(store.updateIntake(other.id, intake.id, 0, state => state), { status: 404 });
  await assert.rejects(store.saveRecord(other.id, exampleRecord('foreign'), intake.id), { status: 404 });
  await store.pool.query('UPDATE browsers SET expires_at=CURRENT_TIMESTAMP-INTERVAL \'1 second\' WHERE id=$1', [first.id]);
  assert.equal(await store.browser(first.token), null);
  for (const table of ['intakes', 'patient_states', 'patient_state_revisions', 'records', 'column_states']) {
    assert.equal((await store.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE owner=$1`, [first.id])).rows[0].count, 1);
  }
  assert.deepEqual(await store.record(first.id, 'demo-record'), exampleRecord());
  assert.deepEqual((await store.context(first.id, intake.id)).context, buildContext(intake.state));
  assert.ok(await store.browser(other.token));
});

databaseTest('intake, patient context and immutable revision history are encrypted and atomically updated', async t => {
  const { store } = await fixture(t);
  const browser = await store.createBrowser();
  const initial = await store.createIntake(browser.id, createIntake());
  assert.deepEqual(await store.context(browser.id, initial.id), { id: initial.id, revision: 0, context: buildContext(initial.state) });
  const named = await store.updateIntake(browser.id, initial.id, 0, state => answer(state, 'name', '민수_비밀이름'));
  const desired = await store.updateIntake(browser.id, initial.id, 1, state => answer(state, 'want', '식사량이 줄어 걱정된다는 말을 하고 싶어요.'));
  const corrected = await store.updateIntake(browser.id, initial.id, 2, state => backIntake(state), 'correction');
  assert.equal(corrected.revision, 3);
  assert.deepEqual((await store.context(browser.id, initial.id)).context, buildContext(corrected.state));
  assert.equal((await store.intake(browser.id, initial.id)).state.ans.want, undefined);
  const history = (await store.pool.query('SELECT revision,reason,content FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision', [initial.id])).rows;
  assert.deepEqual(history.map(row => [row.revision, row.reason]), [[0, 'created'], [1, 'user_answer'], [2, 'user_answer'], [3, 'correction']]);
  assert.deepEqual(store.open(history[2].content, `${browser.id}:patient-history:${initial.id}:2`), buildContext(desired.state));
  const encrypted = await store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1`, [initial.id]);
  for (const row of encrypted.rows) {
    assert.equal(row.content.includes('민수_비밀이름'), false);
    assert.equal(row.content.includes('식사량'), false);
  }
  const intakeRow = (await store.pool.query('SELECT content FROM intakes WHERE id=$1', [initial.id])).rows[0];
  assert.throws(() => store.open(intakeRow.content, `different-owner:intake:${initial.id}`));
  await assert.rejects(store.updateIntake(browser.id, initial.id, named.revision, state => state), { code: 'REVISION_CONFLICT' });
  await assert.rejects(store.updateIntake(browser.id, initial.id, 3, () => { throw new Error('rejected correction'); }), /rejected correction/);
  assert.equal((await store.intake(browser.id, initial.id)).revision, 3);
  assert.equal((await store.pool.query('SELECT COUNT(*)::INTEGER AS count FROM patient_state_revisions WHERE intake_id=$1', [initial.id])).rows[0].count, 4);
  const modeled = await store.updateIntake(browser.id, initial.id, 3, state => ({
    ...state, agentMemory: { summary: '보고된 환자 정보를 확인했어요.' },
  }), 'model_update');
  assert.equal(modeled.revision, 4);
  assert.deepEqual((await store.context(browser.id, initial.id)).context, buildContext(modeled.state));
  assert.equal((await store.pool.query('SELECT reason FROM patient_state_revisions WHERE intake_id=$1 AND revision=4', [initial.id])).rows[0].reason, 'model_update');
});

databaseTest('concurrent answers enforce optimistic revision without overwriting patient evidence', async t => {
  const { store } = await fixture(t);
  const browser = await store.createBrowser();
  const intake = await store.createIntake(browser.id, createIntake());
  const results = await Promise.allSettled([
    store.updateIntake(browser.id, intake.id, 0, state => answer(state, 'name', '민수')),
    store.updateIntake(browser.id, intake.id, 0, state => answer(state, 'name', '지수')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const persisted = await store.intake(browser.id, intake.id);
  assert.equal(persisted.revision, 1);
  assert.equal((await store.context(browser.id, intake.id)).context.patient.alias, persisted.state.name);
  assert.equal((await store.pool.query('SELECT COUNT(*)::INTEGER AS count FROM patient_state_revisions WHERE intake_id=$1', [intake.id])).rows[0].count, 2);
});

databaseTest('duplicate completions are idempotent, record IDs stay owner-scoped, and deletion cascades patient state', async t => {
  const { store } = await fixture(t);
  const first = await store.createBrowser();
  const other = await store.createBrowser();
  const intake = await store.createIntake(first.id, createIntake());
  const attempts = await Promise.all([
    store.saveRecord(first.id, exampleRecord('first-result'), intake.id),
    store.saveRecord(first.id, exampleRecord('retry-result'), intake.id),
  ]);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal((await store.records(first.id)).length, 1);
  const saved = attempts[0];
  assert.deepEqual(await store.saveRecord(first.id, saved), saved);
  await assert.rejects(store.saveRecord(first.id, { ...saved, text: 'different' }), { code: 'RECORD_CONFLICT' });
  await store.saveRecord(other.id, { ...saved, text: '다른 브라우저의 기록' });
  const recordCipher = (await store.pool.query('SELECT content FROM records WHERE owner=$1', [first.id])).rows[0].content;
  assert.equal(recordCipher.includes(saved.text), false);
  await store.deleteRecord(first.id, saved.id);
  assert.deepEqual(await store.records(first.id), []);
  await assert.rejects(store.intake(first.id, intake.id), { status: 404 });
  await assert.rejects(store.context(first.id, intake.id), { status: 404 });
  assert.equal((await store.pool.query('SELECT COUNT(*)::INTEGER AS count FROM patient_state_revisions WHERE intake_id=$1', [intake.id])).rows[0].count, 0);
  assert.equal((await store.record(other.id, saved.id)).text, '다른 브라우저의 기록');
});

databaseTest('column read status is one-way while bookmark updates and omitted values preserve current state', async t => {
  const { store } = await fixture(t);
  const browser = await store.createBrowser();
  assert.deepEqual(await store.setColumnState(browser.id, 'article-2', { read: true, saved: true }), { read: ['article-2'], saved: ['article-2'] });
  assert.deepEqual(await store.setColumnState(browser.id, 'article-2', { read: false }), { read: ['article-2'], saved: ['article-2'] });
  assert.deepEqual(await store.setColumnState(browser.id, 'article-2', { saved: false }), { read: ['article-2'], saved: [] });
});

databaseTest('restart preserves encrypted data, startup rejects a changed key, and migrations verify their checksum', async t => {
  const f = await fixture(t);
  const browser = await f.store.createBrowser();
  const intake = await f.store.createIntake(browser.id, createIntake());
  await f.store.saveRecord(browser.id, exampleRecord(), intake.id);
  await f.store.close();
  f.store = null;
  await assert.rejects(Store.connect(databaseUrl, randomBytes(32), 30, { schema: f.schema }), /cannot decrypt/);
  f.store = await Store.connect(databaseUrl, f.key, 30, { schema: f.schema });
  assert.deepEqual(await f.store.record(browser.id, 'demo-record'), exampleRecord());
  assert.deepEqual((await f.store.context(browser.id, intake.id)).context, buildContext(intake.state));
  assert.equal((await f.store.pool.query('SELECT COUNT(*)::INTEGER AS count FROM schema_migrations')).rows[0].count, 3);
  await f.store.pool.query('UPDATE schema_migrations SET checksum=$1', ['tampered-checksum']);
  await assert.rejects(Store.connect(databaseUrl, f.key, 30, { schema: f.schema }), /checksum/);
});

databaseTest('database questions seed once and edits, additions, ordering and removals survive restart', async t => {
  const f = await fixture(t);
  const before = await f.store.questionSet();
  assert.equal(before.questions.length, 30);
  assert.equal(before.gapQuestion.id, 'gap_obs');
  const browser = await f.store.createBrowser();
  const old = await f.store.createIntake(browser.id, createIntake(before));
  const originalPrompt = currentView(old.state).question.q;
  await f.store.pool.query(`UPDATE questions SET definition=jsonb_set(definition,'{q}',to_jsonb($1::text)),
    updated_at=CURRENT_TIMESTAMP WHERE id='name'`, ['수정된 이름 질문입니다.']);
  await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
    VALUES ('demo_note','base',-10,TRUE,'patient',$1::jsonb)`,
  [JSON.stringify({ type:'text', q:'시연 메모를 알려 주세요.', sec:'추가 메모', face:'listen' })]);
  await f.store.pool.query("UPDATE questions SET sort_order=-20 WHERE id='contact'");
  await f.store.pool.query("UPDATE questions SET enabled=FALSE WHERE id='mysupport'");
  await f.store.pool.query("DELETE FROM questions WHERE id='extra'");
  const changed = await f.store.questionSet();
  assert.notEqual(changed.version, before.version);
  assert.deepEqual(changed.questions.slice(0, 2).map(question => question.id), ['contact', 'demo_note']);
  assert.equal(changed.questions.find(question => question.id === 'name').q, '수정된 이름 질문입니다.');
  assert.equal(changed.questions.some(question => ['extra','mysupport'].includes(question.id)), false);
  const fresh = await f.store.createIntake(browser.id, createIntake(changed));
  assert.equal(currentView(fresh.state).question.id, 'contact');
  assert.equal(currentView((await f.store.intake(browser.id, old.id)).state).question.q, originalPrompt);
  await f.store.close();
  f.store = null;
  f.store = await Store.connect(databaseUrl, f.key, 30, { schema:f.schema });
  assert.deepEqual(await f.store.questionSet(), changed);
  assert.equal((await f.store.pool.query("SELECT COUNT(*)::INTEGER AS count FROM questions WHERE id='extra'")).rows[0].count, 0);
  assert.equal((await f.store.pool.query("SELECT enabled FROM questions WHERE id='mysupport'")).rows[0].enabled, false);
  assert.equal(currentView((await f.store.intake(browser.id, old.id)).state).question.q, originalPrompt);
});

databaseTest('frontend name migration upgrades only the default and preserves legacy encrypted intake snapshots', async t => {
  const f = await fixture(t);
  const defaultName = initialQuestionRows.find(row => row.id === 'name');
  const latestName = (await f.store.questionSet()).questions.find(question => question.id === 'name');
  assert.equal(latestName.required, true);
  assert.equal(latestName.follow_up, undefined);
  // Reconstruct an existing 002 database without modifying its legacy seed or snapshot.
  await f.store.pool.query("DELETE FROM schema_migrations WHERE version='003_frontend_name.sql'");
  await f.store.pool.query("UPDATE questions SET definition=$1::jsonb WHERE id='name'", [JSON.stringify(defaultName.definition)]);
  const browser = await f.store.createBrowser();
  const old = await f.store.createIntake(browser.id, createIntake(initialQuestionSet));
  const oldContext = await f.store.context(browser.id, old.id);
  const encryptedBefore = (await f.store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1`, [old.id])).rows;
  await f.store.close();
  f.store = null;
  f.store = await Store.connect(databaseUrl, f.key, 30, { schema:f.schema });
  const migratedName = (await f.store.questionSet()).questions.find(question => question.id === 'name');
  assert.equal(migratedName.required, true);
  assert.equal(migratedName.follow_up, undefined);
  assert.deepEqual((await f.store.intake(browser.id, old.id)).state, old.state);
  assert.deepEqual(await f.store.context(browser.id, old.id), oldContext);
  assert.deepEqual((await f.store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1`, [old.id])).rows, encryptedBefore);
  assert.equal(currentView(old.state).question.required, undefined);
  const fresh = createIntake(await f.store.questionSet());
  assert.equal(currentView(fresh).question.required, true);
  const migrationTime = (await f.store.pool.query("SELECT updated_at FROM questions WHERE id='name'")).rows[0].updated_at;
  // Once applied, 003 cannot overwrite a later administrator's deliberate edit.
  await f.store.pool.query("UPDATE questions SET definition=$1::jsonb WHERE id='name'", [JSON.stringify(defaultName.definition)]);
  await f.store.close();
  f.store = null;
  f.store = await Store.connect(databaseUrl, f.key, 30, { schema:f.schema });
  const unchanged = (await f.store.pool.query("SELECT definition,updated_at FROM questions WHERE id='name'")).rows[0];
  assert.deepEqual(unchanged.definition, defaultName.definition);
  assert.deepEqual(unchanged.updated_at, migrationTime);
});

databaseTest('frontend name migration never overwrites customized question definitions or row settings', async t => {
  const f = await fixture(t);
  const defaultName = initialQuestionRows.find(row => row.id === 'name');
  const variants = [
    { ...defaultName, definition:{ ...defaultName.definition, q:'관리자가 정한 이름 질문' } },
    { ...defaultName, definition:{ ...defaultName.definition, required:false } },
    { ...defaultName, sort_order:50 },
    { ...defaultName, enabled:false },
  ];
  for (const row of variants) {
    await f.store.pool.query("DELETE FROM schema_migrations WHERE version='003_frontend_name.sql'");
    await f.store.pool.query(`UPDATE questions SET kind=$1,sort_order=$2,enabled=$3,subject=$4,
      definition=$5::jsonb,updated_at='2026-01-01T00:00:00Z' WHERE id='name'`,
    [row.kind,row.sort_order,row.enabled,row.subject,JSON.stringify(row.definition)]);
    const before = (await f.store.pool.query("SELECT * FROM questions WHERE id='name'")).rows[0];
    await f.store.close();
    f.store = null;
    f.store = await Store.connect(databaseUrl, f.key, 30, { schema:f.schema });
    assert.deepEqual((await f.store.pool.query("SELECT * FROM questions WHERE id='name'")).rows[0], before);
    assert.equal((await f.store.pool.query("SELECT COUNT(*)::INTEGER AS count FROM schema_migrations WHERE version='003_frontend_name.sql'")).rows[0].count, 1);
  }
});

databaseTest('invalid or empty database questions fail instead of substituting the original catalog', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.pool.query("UPDATE questions SET definition='{}'::jsonb WHERE id='name'"), { code:'23514' });
  await assert.rejects(store.pool.query("UPDATE questions SET subject='invented' WHERE id='name'"), { code:'23514' });
  await store.pool.query(`UPDATE questions SET definition=jsonb_set(definition,'{when}',
    '{"execute":"process.exit()"}'::jsonb) WHERE id='name'`);
  await assert.rejects(store.questionSet(), { code:'QUESTION_BANK_INVALID' });
  await store.pool.query("UPDATE questions SET definition=definition-'when' WHERE id='name'");
  await store.pool.query('UPDATE questions SET enabled=FALSE');
  await assert.rejects(store.questionSet(), { code:'QUESTION_BANK_INVALID' });
});

test('PostgreSQL schema names reject connection-option or identifier injection', async () => {
  await assert.rejects(Store.connect('postgresql://localhost/test', randomBytes(32), 30, { schema: 'public;drop' }), /schema name/);
  await assert.rejects(Store.connect('postgresql://localhost/test', randomBytes(32), 30, { schema: 'public -c statement_timeout=1' }), /schema name/);
});
