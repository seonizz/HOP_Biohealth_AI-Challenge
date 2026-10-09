import pg from 'pg';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HttpError } from './errors.js';
import { buildContext } from './intake.js';
import { initialQuestionRows, createQuestionSet } from './question-bank.js';

const { Pool } = pg;
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const notFound = () => new HttpError(404, 'NOT_FOUND', '기록을 찾을 수 없어요.');

export function loadContentKey(path, provided = process.env.CONTENT_KEY) {
  if (provided) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(provided)) throw new Error('CONTENT_KEY must be a 32-byte base64 key');
    return Buffer.from(provided, 'base64');
  }
  const keyPath = resolve(path);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath)) {
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Invalid content key');
  chmodSync(keyPath, 0o600);
  return key;
}

export class Store {
  constructor(pool, key, sessionDays = 30) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte content key is required');
    if (!Number.isFinite(sessionDays) || sessionDays <= 0) throw new Error('Session lifetime must be positive');
    this.pool = pool;
    this.key = key;
    this.sessionDays = sessionDays;
  }

  static async connect(databaseUrl, key, sessionDays = 30, { schema = 'public' } = {}) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    // Idle-connection errors are handled without printing database credentials.
    pool.on('error', () => {});
    const store = new Store(pool, key, sessionDays);
    try {
      await store.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))', [`malssi:${schema}:migrate`]);
        const namespace = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
        if (!namespace.rowCount) throw new Error('PostgreSQL schema does not exist');
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        for (const version of ['001_initial.sql', '002_questions.sql']) {
          const source = readFileSync(new URL(`../migrations/${version}`, import.meta.url), 'utf8');
          const checksum = digest(source);
          const applied = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
          if (applied.rowCount && applied.rows[0].checksum !== checksum) throw new Error('Applied database migration checksum does not match');
          if (!applied.rowCount) {
            await client.query(source);
            if (version === '002_questions.sql') {
              for (const row of initialQuestionRows) {
                await client.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
                  VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
                [row.id, row.kind, row.sort_order, row.enabled, row.subject, JSON.stringify(row.definition)]);
              }
            }
            await client.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [version, checksum]);
          }
        }
        // A replaced/lost content key must fail startup rather than make old data unreadable later.
        const sample = await client.query(`SELECT owner,id,content,'intake' AS kind FROM intakes
          UNION ALL SELECT owner,id,content,'record' AS kind FROM records LIMIT 1`);
        if (sample.rowCount) {
          const row = sample.rows[0];
          try { store.open(row.content, `${row.owner}:${row.kind}:${row.id}`); }
          catch { throw new Error('Content key cannot decrypt existing database content'); }
        }
      });
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close() { await this.pool.end(); }

  async questionSet() {
    const result = await this.pool.query(`SELECT id,kind,sort_order,enabled,subject,definition FROM questions
      WHERE enabled ORDER BY sort_order,id`);
    return createQuestionSet(result.rows);
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the operation failure. */ }
      throw error;
    } finally { client.release(); }
  }

  seal(value, aad) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  open(value, aad) {
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  }

  async createBrowser() {
    const token = randomBytes(32).toString('base64url');
    const browser = { id: randomUUID(), csrf: randomBytes(32).toString('base64url') };
    await this.pool.query('INSERT INTO browsers(id,token_hash,csrf,expires_at) VALUES ($1,$2,$3,$4)',
      [browser.id, digest(token), browser.csrf, new Date(Date.now() + this.sessionDays * 86400000)]);
    return { ...browser, token };
  }

  async browser(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const result = await this.pool.query('SELECT id,csrf FROM browsers WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP', [digest(token)]);
    return result.rows[0] || null;
  }

  async writeContext(client, owner, id, revision, state, reason) {
    const context = buildContext(state);
    await client.query(`INSERT INTO patient_states(intake_id,owner,revision,content,updated_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(intake_id) DO UPDATE SET revision=EXCLUDED.revision,content=EXCLUDED.content,updated_at=EXCLUDED.updated_at`,
      [id, owner, revision, this.seal(context, `${owner}:patient:${id}:${revision}`), now()]);
    await client.query('INSERT INTO patient_state_revisions(intake_id,owner,revision,reason,content) VALUES ($1,$2,$3,$4,$5)',
      [id, owner, revision, reason, this.seal(context, `${owner}:patient-history:${id}:${revision}`)]);
  }

  async createIntake(owner, state) {
    const id = randomUUID();
    return this.transaction(async client => {
      await client.query('INSERT INTO intakes(id,owner,revision,content,updated_at) VALUES ($1,$2,$3,$4,$5)',
        [id, owner, 0, this.seal(state, `${owner}:intake:${id}`), now()]);
      await this.writeContext(client, owner, id, 0, state, 'created');
      return { id, revision: 0, state };
    });
  }

  async intake(owner, id) {
    const result = await this.pool.query('SELECT revision,content FROM intakes WHERE id=$1 AND owner=$2', [id, owner]);
    if (!result.rowCount) throw notFound();
    const row = result.rows[0];
    return { id, revision: row.revision, state: this.open(row.content, `${owner}:intake:${id}`) };
  }

  async context(owner, id) {
    const result = await this.pool.query('SELECT revision,content FROM patient_states WHERE intake_id=$1 AND owner=$2', [id, owner]);
    if (!result.rowCount) throw notFound();
    const row = result.rows[0];
    return { id, revision: row.revision, context: this.open(row.content, `${owner}:patient:${id}:${row.revision}`) };
  }

  async updateIntake(owner, id, revision, operation, reason = 'user_answer') {
    if (!['user_answer', 'correction', 'model_update'].includes(reason)) throw new Error('Invalid patient state revision reason');
    return this.transaction(async client => {
      const result = await client.query('SELECT revision,content FROM intakes WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner]);
      if (!result.rowCount) throw notFound();
      const current = result.rows[0];
      if (current.revision !== revision) throw new HttpError(409, 'REVISION_CONFLICT', '다른 요청이 먼저 반영됐어요. 현재 질문을 다시 확인해 주세요.');
      const state = await operation(this.open(current.content, `${owner}:intake:${id}`));
      await client.query('UPDATE intakes SET revision=$1,content=$2,updated_at=$3 WHERE id=$4 AND owner=$5',
        [revision + 1, this.seal(state, `${owner}:intake:${id}`), now(), id, owner]);
      await this.writeContext(client, owner, id, revision + 1, state, reason);
      return { id, revision: revision + 1, state };
    });
  }

  async records(owner) {
    const result = await this.pool.query('SELECT id,content FROM records WHERE owner=$1 ORDER BY created_at DESC,id DESC', [owner]);
    return result.rows.map(row => this.open(row.content, `${owner}:record:${row.id}`));
  }

  async nextRecordId() {
    const result = await this.pool.query("SELECT nextval('record_ids')::text AS id");
    return Number(result.rows[0].id);
  }

  async record(owner, id) {
    const result = await this.pool.query('SELECT content FROM records WHERE owner=$1 AND id=$2', [owner, String(id)]);
    if (!result.rowCount) throw notFound();
    return this.open(result.rows[0].content, `${owner}:record:${id}`);
  }

  async saveRecord(owner, record, intakeId = null) {
    return this.transaction(async client => {
      // Serializing saves for this browser makes retries idempotent even when they arrive together.
      const browser = await client.query('SELECT id FROM browsers WHERE id=$1 FOR UPDATE', [owner]);
      if (!browser.rowCount) throw notFound();
      if (intakeId) {
        const intake = await client.query('SELECT id FROM intakes WHERE id=$1 AND owner=$2', [intakeId, owner]);
        if (!intake.rowCount) throw notFound();
        const previous = await client.query('SELECT id,content FROM records WHERE owner=$1 AND intake_id=$2', [owner, intakeId]);
        if (previous.rowCount) {
          const row = previous.rows[0];
          return this.open(row.content, `${owner}:record:${row.id}`);
        }
      }
      const id = String(record.id);
      const prior = await client.query('SELECT content FROM records WHERE owner=$1 AND id=$2', [owner, id]);
      if (prior.rowCount) {
        const previous = this.open(prior.rows[0].content, `${owner}:record:${id}`);
        if (JSON.stringify(previous) === JSON.stringify(record)) return previous;
        throw new HttpError(409, 'RECORD_CONFLICT', '같은 ID의 기록이 이미 있어요.');
      }
      await client.query('INSERT INTO records(id,owner,intake_id,content,created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, owner, intakeId, this.seal(record, `${owner}:record:${id}`), record.date]);
      return record;
    });
  }

  async deleteRecord(owner, id) {
    return this.transaction(async client => {
      await client.query('SELECT id FROM browsers WHERE id=$1 FOR UPDATE', [owner]);
      const row = await client.query('DELETE FROM records WHERE owner=$1 AND id=$2 RETURNING intake_id', [owner, String(id)]);
      if (!row.rowCount) throw notFound();
      if (row.rows[0].intake_id) await client.query('DELETE FROM intakes WHERE owner=$1 AND id=$2', [owner, row.rows[0].intake_id]);
    });
  }

  async columnState(owner) {
    const result = await this.pool.query('SELECT article,read,saved FROM column_states WHERE owner=$1 ORDER BY article', [owner]);
    return { read: result.rows.filter(r => r.read).map(r => r.article), saved: result.rows.filter(r => r.saved).map(r => r.article) };
  }

  async setColumnState(owner, article, patch) {
    await this.pool.query(`INSERT INTO column_states(owner,article,read,saved) VALUES ($1,$2,$3,$4)
      ON CONFLICT(owner,article) DO UPDATE SET read=column_states.read OR EXCLUDED.read,
      saved=CASE WHEN $5 THEN EXCLUDED.saved ELSE column_states.saved END`,
      [owner, article, patch.read === true, patch.saved === true, patch.saved !== undefined]);
    return this.columnState(owner);
  }
}
