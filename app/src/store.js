import pg from 'pg';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HttpError } from './errors.js';
import { buildContext } from './intake.js';
import { normalizeAnswerContext } from './answer-sources.js';
import { initialQuestionRows, createQuestionSet } from './question-bank.js';
import { referralSnapshotFingerprint } from './referral-guidance.js';
import * as continuationStore from './continuation-store.js';

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
  constructor(pool, key, sessionDays = 30, retentionDays = 30) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte content key is required');
    if (!Number.isFinite(sessionDays) || sessionDays <= 0) throw new Error('Session lifetime must be positive');
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) throw new Error('DATA_RETENTION_DAYS must be 1..90');
    this.pool = pool;
    this.key = key;
    this.sessionDays = sessionDays;
    this.retentionDays = retentionDays;
  }

  static async connect(databaseUrl, key, sessionDays = 30, { schema = 'public', retentionDays = 30 } = {}) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    // Idle-connection errors are handled without printing database credentials.
    pool.on('error', () => {});
    const store = new Store(pool, key, sessionDays, retentionDays);
    try {
      await store.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))', [`malssi:${schema}:migrate`]);
        const namespace = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
        if (!namespace.rowCount) throw new Error('PostgreSQL schema does not exist');
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        for (const version of ['001_initial.sql', '002_questions.sql', '003_frontend_name.sql', '004_frontend_questions.sql', '005_conversation_epoch.sql', '006_data_retention.sql', '007_natural_prompts.sql', '008_record_access_keys.sql', '009_continuations.sql']) {
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

  createContinuation(owner, recordId, epoch, requestId) { return continuationStore.createContinuation(this, owner, recordId, epoch, requestId); }
  listContinuations(owner, recordId) { return continuationStore.listContinuations(this, owner, recordId); }
  getContinuation(owner, id) { return continuationStore.getContinuation(this, owner, id); }
  updateContinuation(owner, id, revision, mutate, options) { return continuationStore.updateContinuation(this, owner, id, revision, mutate, options); }
  deleteContinuation(owner, id) { return continuationStore.deleteContinuation(this, owner, id); }

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

  openRecord(value, owner, id) {
    const record = this.open(value, `${owner}:record:${id}`);
    return record.context ? {...record, context:normalizeAnswerContext(record.context)} : record;
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
    // UPDATE takes the same owner-row lock as deletion. An expired owner cannot
    // be revived by an access racing the cleanup job.
    const result = await this.pool.query(`UPDATE browsers SET last_active_at=clock_timestamp()
      WHERE token_hash=$1 AND expires_at>clock_timestamp()
      AND last_active_at>clock_timestamp()-make_interval(days=>$2)
      RETURNING id,csrf`, [digest(token), this.retentionDays]);
    return result.rows[0] || null;
  }

  async lockOwner(client, owner, mode = 'UPDATE') {
    const result = await client.query(`SELECT conversation_epoch FROM browsers
      WHERE id=$1 AND last_active_at>clock_timestamp()-make_interval(days=>$2) FOR ${mode}`,
    [owner, this.retentionDays]);
    if (!result.rowCount) throw notFound();
    return result.rows[0];
  }

  async purgeExpired() {
    // FK cascades remove sessions, conversations, results, revisions and column
    // state in one statement. PostgreSQL rechecks activity after lock waits.
    const result = await this.pool.query(`DELETE FROM browsers
      WHERE last_active_at<=clock_timestamp()-make_interval(days=>$1)`, [this.retentionDays]);
    return { deleted_owners:result.rowCount };
  }

  async createDeletionKey(owner) {
    const key = randomBytes(32).toString('base64url');
    await this.transaction(async client => {
      await this.lockOwner(client, owner);
      await client.query('UPDATE browsers SET deletion_key_hash=$1 WHERE id=$2', [digest(key), owner]);
    });
    return key;
  }

  async createRecordAccessKey(owner, id) {
    const key = randomBytes(32).toString('base64url');
    await this.transaction(async client => {
      await this.lockOwner(client, owner);
      const result = await client.query('UPDATE records SET access_key_hash=$1 WHERE owner=$2 AND id=$3 RETURNING id', [digest(key), owner, String(id)]);
      if (!result.rowCount) throw notFound();
    });
    return key;
  }

  async revokeRecordAccessKey(owner, id) {
    await this.transaction(async client => {
      await this.lockOwner(client, owner);
      const result = await client.query('UPDATE records SET access_key_hash=NULL WHERE owner=$1 AND id=$2 RETURNING id', [owner, String(id)]);
      if (!result.rowCount) throw notFound();
    });
  }

  async recordWithAccessKey(key) {
    const invalid = () => new HttpError(404, 'ACCESS_KEY_INVALID', '보관키를 확인해 주세요. 교체·해제되거나 보유기간이 지난 키는 사용할 수 없어요.');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw invalid();
    return this.transaction(async client => {
      // Lock both rows so rotation, deletion and retention cleanup serialize
      // with this read. Key access does not renew the owner's retention period.
      const result = await client.query(`SELECT r.id,r.owner,r.content FROM records r
        JOIN browsers b ON b.id=r.owner WHERE r.access_key_hash=$1
        AND b.last_active_at>clock_timestamp()-make_interval(days=>$2)
        FOR SHARE OF b,r`, [digest(key), this.retentionDays]);
      if (!result.rowCount) throw invalid();
      const row = result.rows[0];
      return this.openRecord(row.content, row.owner, row.id);
    });
  }

  async deleteConversationsWithKey(key, token) {
    const invalid = () => new HttpError(404, 'DELETION_KEY_INVALID', '삭제 키를 확인해 주세요. 보유기간이 지나 이미 삭제됐을 수도 있어요.');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw invalid();
    return this.transaction(async client => {
      const browser = await client.query(`UPDATE browsers SET conversation_epoch=conversation_epoch+1
        WHERE deletion_key_hash=$1 RETURNING id,token_hash,conversation_epoch`, [digest(key)]);
      if (!browser.rowCount) throw invalid();
      const row = browser.rows[0];
      await this.removeConversations(client, row.id);
      // Keep the key valid for retry after a lost response. It never grants read access.
      // Matching an expired cookie only tells the UI to clear its old cache;
      // it does not restore the session or authorize any read.
      const current = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && digest(token) === row.token_hash;
      return { current_session:current, ...(current ? {conversation_epoch:row.conversation_epoch} : {}) };
    });
  }

  async writeContext(client, owner, id, revision, state, reason) {
    const context = buildContext(state);
    await client.query(`INSERT INTO patient_states(intake_id,owner,revision,content,updated_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(intake_id) DO UPDATE SET revision=EXCLUDED.revision,content=EXCLUDED.content,updated_at=EXCLUDED.updated_at`,
      [id, owner, revision, this.seal(context, `${owner}:patient:${id}:${revision}`), now()]);
    await client.query('INSERT INTO patient_state_revisions(intake_id,owner,revision,reason,content) VALUES ($1,$2,$3,$4,$5)',
      [id, owner, revision, reason, this.seal(context, `${owner}:patient-history:${id}:${revision}`)]);
  }

  async createIntake(owner, state, epoch) {
    const id = randomUUID();
    return this.transaction(async client => {
      const browser = await this.lockOwner(client, owner);
      if (epoch !== undefined && epoch !== browser.conversation_epoch) {
        throw new HttpError(409, 'CONVERSATIONS_CHANGED', '대화 목록이 변경됐어요. 내 기록을 새로 확인한 뒤 시작해 주세요.');
      }
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
    return { id, revision: row.revision, context: normalizeAnswerContext(this.open(row.content, `${owner}:patient:${id}:${row.revision}`)) };
  }

  async updateIntake(owner, id, revision, operation, reason = 'user_answer') {
    if (!['user_answer', 'correction', 'model_update'].includes(reason)) throw new Error('Invalid patient state revision reason');
    return this.transaction(async client => {
      await this.lockOwner(client, owner);
      const result = await client.query('SELECT revision,content FROM intakes WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner]);
      if (!result.rowCount) throw notFound();
      const current = result.rows[0];
      if (current.revision !== revision) throw new HttpError(409, 'REVISION_CONFLICT', '다른 요청이 먼저 반영됐어요. 현재 질문을 다시 확인해 주세요.');
      const previous=this.open(current.content, `${owner}:intake:${id}`);
      const assessment=previous.referralAssessment?structuredClone(previous.referralAssessment):null;
      const wasReady=previous.status==='ready'&&!previous.modelPending&&!previous.agentRecord;
      const state = await operation(previous);
      const finalizing=reason==='model_update'&&wasReady&&Boolean(state.agentRecord);
      if(finalizing&&assessment?.revision===revision&&assessment.source_hash===referralSnapshotFingerprint(state)){
        state.referralAssessment={...structuredClone(assessment),revision:revision+1};
      }else delete state.referralAssessment;
      await client.query('UPDATE intakes SET revision=$1,content=$2,updated_at=$3 WHERE id=$4 AND owner=$5',
        [revision + 1, this.seal(state, `${owner}:intake:${id}`), now(), id, owner]);
      await this.writeContext(client, owner, id, revision + 1, state, reason);
      return { id, revision: revision + 1, state };
    });
  }

  async saveReferralAssessment(owner,id,revision,assessment,{signal}={}) {
    signal?.throwIfAborted();
    return this.transaction(async client=>{
      await this.lockOwner(client,owner);
      const result=await client.query('SELECT revision,content FROM intakes WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner]);
      if(!result.rowCount)throw notFound();
      const current=result.rows[0],state=this.open(current.content,`${owner}:intake:${id}`);
      const finalStored=current.revision===revision+1&&Boolean(state.agentRecord);
      if((current.revision!==revision&&!finalStored)||state.status!=='ready'||state.modelPending||
        assessment.revision!==revision||assessment.source_hash!==referralSnapshotFingerprint(state))
        throw new HttpError(409,'REVISION_CONFLICT','대화가 변경됐어요. 최신 내용으로 다시 확인해 주세요.');
      signal?.throwIfAborted();
      state.referralAssessment={...structuredClone(assessment),revision:current.revision};
      // Read the current encrypted state under its row lock; never overwrite a
      // newly saved guide with the snapshot the classifier originally read.
      await client.query('UPDATE intakes SET content=$1 WHERE id=$2 AND owner=$3 AND revision=$4',
        [this.seal(state,`${owner}:intake:${id}`),id,owner,current.revision]);
      signal?.throwIfAborted();
      return {id,revision:current.revision,state};
    });
  }

  async records(owner, client = this.pool) {
    const result = await client.query('SELECT id,content FROM records WHERE owner=$1 ORDER BY created_at DESC,id DESC', [owner]);
    return result.rows.map(row => this.openRecord(row.content, owner, row.id));
  }

  async history(owner) {
    return this.transaction(async client => {
      // Keep the two lists and creation epoch consistent with deletions and saves.
      const browser = await this.lockOwner(client, owner, 'SHARE');
      const records = await this.records(owner, client);
      const incomplete = await client.query(`SELECT i.id,i.content,i.updated_at FROM intakes i
        WHERE i.owner=$1 AND NOT EXISTS (SELECT 1 FROM records r WHERE r.owner=i.owner AND r.intake_id=i.id)
        ORDER BY i.updated_at DESC,i.id DESC`, [owner]);
      return { records, conversation_epoch:browser.conversation_epoch,
        incomplete_intakes:incomplete.rows.map(row => {
          const state = this.open(row.content, `${owner}:intake:${row.id}`);
          return { id:row.id, title:state.chatTitle || state.name || '미완료 대화', updated_at:row.updated_at.toISOString() };
        }) };
    });
  }

  async nextRecordId() {
    const result = await this.pool.query("SELECT nextval('record_ids')::text AS id");
    return Number(result.rows[0].id);
  }

  async record(owner, id) {
    const result = await this.pool.query('SELECT content FROM records WHERE owner=$1 AND id=$2', [owner, String(id)]);
    if (!result.rowCount) throw notFound();
    return this.openRecord(result.rows[0].content, owner, id);
  }

  async saveRecord(owner, record, intakeId = null) {
    return this.transaction(async client => {
      // Serializing saves for this browser makes retries idempotent even when they arrive together.
      await this.lockOwner(client, owner);
      if (intakeId) {
        const intake = await client.query('SELECT id FROM intakes WHERE id=$1 AND owner=$2', [intakeId, owner]);
        if (!intake.rowCount) throw notFound();
        const previous = await client.query('SELECT id,content FROM records WHERE owner=$1 AND intake_id=$2', [owner, intakeId]);
        if (previous.rowCount) {
          const row = previous.rows[0];
          return this.openRecord(row.content, owner, row.id);
        }
      }
      const id = String(record.id);
      const prior = await client.query('SELECT content FROM records WHERE owner=$1 AND id=$2', [owner, id]);
      if (prior.rowCount) {
        const previous = this.open(prior.rows[0].content, `${owner}:record:${id}`);
        if (JSON.stringify(previous) === JSON.stringify(record)) return this.openRecord(prior.rows[0].content, owner, id);
        throw new HttpError(409, 'RECORD_CONFLICT', '같은 ID의 기록이 이미 있어요.');
      }
      await client.query('INSERT INTO records(id,owner,intake_id,content,created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, owner, intakeId, this.seal(record, `${owner}:record:${id}`), record.date]);
      return record;
    });
  }

  async deleteRecord(owner, id) {
    return this.transaction(async client => {
      await this.lockOwner(client, owner);
      const row = await client.query('DELETE FROM records WHERE owner=$1 AND id=$2 RETURNING intake_id', [owner, String(id)]);
      if (!row.rowCount) throw notFound();
      if (row.rows[0].intake_id) await client.query('DELETE FROM intakes WHERE owner=$1 AND id=$2', [owner, row.rows[0].intake_id]);
      return { intake_id:row.rows[0].intake_id };
    });
  }

  async deleteIntake(owner, id) {
    return this.transaction(async client => {
      await this.lockOwner(client, owner);
      const records = await client.query('SELECT id FROM records WHERE owner=$1 AND intake_id=$2', [owner, id]);
      const row = await client.query('DELETE FROM intakes WHERE owner=$1 AND id=$2 RETURNING id', [owner, id]);
      if (!row.rowCount) throw notFound();
      return { record_ids:records.rows.map(record => record.id) };
    });
  }

  async deleteConversations(owner) {
    return this.transaction(async client => {
      await this.lockOwner(client, owner);
      const browser = await client.query(`UPDATE browsers SET conversation_epoch=conversation_epoch+1
        WHERE id=$1 RETURNING conversation_epoch`, [owner]);
      if (!browser.rowCount) throw notFound();
      await this.removeConversations(client, owner);
      return { conversation_epoch:browser.rows[0].conversation_epoch };
    });
  }

  async removeConversations(client, owner) {
    // Also remove legacy records without an intake. Column state is independent.
    await client.query('DELETE FROM records WHERE owner=$1', [owner]);
    await client.query('DELETE FROM intakes WHERE owner=$1', [owner]);
  }

  async columnState(owner, client = this.pool) {
    const result = await client.query('SELECT article,read,saved FROM column_states WHERE owner=$1 ORDER BY article', [owner]);
    return { read: result.rows.filter(r => r.read).map(r => r.article), saved: result.rows.filter(r => r.saved).map(r => r.article) };
  }

  async setColumnState(owner, article, patch) {
    return this.transaction(async client => {
      await this.lockOwner(client, owner);
      await client.query(`INSERT INTO column_states(owner,article,read,saved) VALUES ($1,$2,$3,$4)
        ON CONFLICT(owner,article) DO UPDATE SET read=column_states.read OR EXCLUDED.read,
        saved=CASE WHEN $5 THEN EXCLUDED.saved ELSE column_states.saved END`,
        [owner, article, patch.read === true, patch.saved === true, patch.saved !== undefined]);
      return this.columnState(owner, client);
    });
  }
}
