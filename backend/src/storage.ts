import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Profile } from './questions.ts';

export const timestamp = () => new Date().toISOString();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Conflict extends Error {
  constructor(message: string) { super(message); this.name = 'Conflict'; }
}
export type Project = { id: string; title: string; status: string; profile: Profile; domains: unknown[]; pending_question_id: number | null; revision: number; created_at: string; updated_at: string };
export type Message = { id: string; role: string; content: string; created_at: string; metadata?: any };
export type User = { id: string; email: string; is_demo?: boolean };
export type StoredUser = User & { password_hash: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const emailKey = (email: string): string => email.trim().toLowerCase();

/** Async PostgreSQL store. The migration and every turn commit transactionally.
 * Schemas isolate tests; sessions store hashed tokens with a seven-day expiry.
 */
export class Store {
  readonly pool: pg.Pool;
  readonly schema: string;
  private constructor(pool: pg.Pool, schema: string) { this.pool = pool; this.schema = schema; }

  static async connect(databaseUrl: string, options: { schema?: string; migrate?: boolean } = {}): Promise<Store> {
    if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) throw new Error('PostgreSQL connection URL is required');
    const schema = options.schema ?? 'public';
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error('Invalid PostgreSQL schema identifier');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000` });
    // Idle connection errors must not become unhandled EventEmitter errors.
    // Active queries reject normally. Never log URLs or credentials here.
    pool.on('error', () => {});
    const store = new Store(pool, schema);
    try {
      if (options.migrate === false) await store.validateMigration();
      else await store.migrate();
      return store;
    }
    catch (error) { await pool.end(); throw error; }
  }

  private async validateMigration(): Promise<void> {
    for (const migration of this.migrations()) {
      const existing = await this.pool.query('SELECT checksum FROM schema_migrations WHERE version=$1', [migration.version]);
      if (existing.rowCount !== 1 || existing.rows[0].checksum !== migration.checksum) throw new Error('Required PostgreSQL migration is missing or differs; run migrations with the migrator role');
    }
  }

  private migrations() {
    const directory = new URL('../migrations/', import.meta.url);
    return readdirSync(directory).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort().map((name,index) => {
      const version = Number(name.slice(0,3)), source = readFileSync(new URL(name,directory),'utf8');
      if (version !== index+1) throw new Error('Migration sequence has a gap or duplicate');
      return {name,version,source,checksum:hash(source)};
    });
  }

  private async migrate(): Promise<void> {
    const migrations = this.migrations(), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // DDL can legitimately exceed the runtime query budget on shared disks.
      await client.query("SET LOCAL statement_timeout = '60s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hop_schema_migrations'), hashtext($1))", [this.schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY,name text NOT NULL,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const {version,name,source,checksum} of migrations) {
        const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== checksum) throw new Error('Applied PostgreSQL migration checksum differs from bundled migration');
        } else {
          await client.query(source);
          await client.query('INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)', [version,name,checksum]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }
  async createUser(email: string, passwordHash: string): Promise<User> {
    const normalized = emailKey(email);
    if (!normalized || normalized.length > 254 || !passwordHash || passwordHash.length > 4096) throw new Error('Invalid user fields');
    try {
      const result = await this.pool.query('INSERT INTO users(id,email,password_hash) VALUES ($1,$2,$3) RETURNING id,email', [randomUUID(), normalized, passwordHash]);
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new Conflict('이미 등록된 이메일입니다.');
      throw error;
    }
  }
  async createDemoUser(): Promise<User> {
    const result = await this.pool.query("INSERT INTO users(id,email,password_hash,demo_expires_at) VALUES ($1,$2,$3,now()+interval '24 hours') RETURNING id,email", [randomUUID(),randomUUID()+'@demo.invalid',randomBytes(32).toString('hex')]);
    return {...result.rows[0],is_demo:true};
  }
  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const result = await this.pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [emailKey(email)]);
    return result.rows[0] ?? null;
  }
  async getUser(id: string): Promise<User | null> {
    if (!UUID.test(id)) return null;
    const result = await this.pool.query('SELECT id,email,demo_expires_at IS NOT NULL AS is_demo FROM users WHERE id=$1 AND (demo_expires_at IS NULL OR demo_expires_at>now())', [id]);
    const user=result.rows[0];
    return user ? user.is_demo ? user : {id:user.id,email:user.email} : null;
  }
  async newSession(ownerId: string, expectedPasswordHash?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url'), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT password_hash,demo_expires_at FROM users WHERE id=$1 AND (demo_expires_at IS NULL OR demo_expires_at>now()) FOR UPDATE', [ownerId]);
      if (!user.rowCount || (expectedPasswordHash !== undefined && user.rows[0].password_hash !== expectedPasswordHash)) throw new Conflict('계정 정보가 변경되었습니다. 다시 로그인해 주세요.');
      await client.query('DELETE FROM sessions WHERE owner=$1 AND expires_at<=now()', [ownerId]);
      await client.query("INSERT INTO sessions(token_hash,owner,expires_at) VALUES ($1,$2,LEAST(now() + interval '7 days',COALESCE($3::timestamptz,now() + interval '7 days')))", [hash(token), ownerId,user.rows[0].demo_expires_at]);
      await client.query('COMMIT');
      return token;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async changePassword(ownerId: string, previousHash: string, nextHash: string): Promise<string> {
    const token = randomBytes(32).toString('base64url'), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND password_hash=$3 RETURNING id', [nextHash,ownerId,previousHash]);
      if (updated.rowCount !== 1) throw new Conflict('계정 정보가 변경되었습니다. 다시 로그인해 주세요.');
      await client.query('DELETE FROM sessions WHERE owner=$1', [ownerId]);
      await client.query("INSERT INTO sessions(token_hash,owner,expires_at) VALUES ($1,$2,now() + interval '7 days')", [hash(token),ownerId]);
      await client.query('COMMIT');
      return token;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async authenticate(token: string): Promise<string | null> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const result = await this.pool.query('SELECT s.owner FROM sessions s JOIN users u ON u.id=s.owner WHERE s.token_hash=$1 AND s.expires_at>now() AND (u.demo_expires_at IS NULL OR u.demo_expires_at>now())', [hash(token)]);
    return result.rows[0]?.owner ?? null;
  }
  async revokeSession(token: string): Promise<void> { await this.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token)]); }
  static decode(row: any): Project | null {
    if (!row) return null;
    return { id: row.id,title: row.title,status: row.status,profile: row.profile,domains: row.domains,pending_question_id: row.pending_question_id,revision: row.revision,created_at: iso(row.created_at),updated_at: iso(row.updated_at) };
  }
  async create(owner: string, title: string): Promise<Project> {
    const result = await this.pool.query("INSERT INTO projects(id,owner,title,status,profile,domains,pending_question_id,revision) VALUES ($1,$2,$3,'interviewing','{}'::jsonb,'[]'::jsonb,1,0) RETURNING *", [randomUUID(), owner, title]);
    return Store.decode(result.rows[0])!;
  }
  async get(owner: string, id: string): Promise<Project | null> {
    if (!UUID.test(owner) || !UUID.test(id)) return null;
    const result = await this.pool.query('SELECT * FROM projects WHERE id=$1 AND owner=$2', [id, owner]);
    return Store.decode(result.rows[0]);
  }
  async list(owner: string): Promise<Project[]> {
    const result = await this.pool.query('SELECT * FROM projects WHERE owner=$1 ORDER BY updated_at DESC,id', [owner]);
    return result.rows.map(row => Store.decode(row)!);
  }
  async listPage(owner: string, limit = 50, cursor?: { updated_at: string; id: string }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Project limit must be between 1 and 100');
    const result = await this.pool.query('SELECT *,updated_at::text AS cursor_updated_at FROM projects WHERE owner=$1 AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::uuid)) ORDER BY updated_at DESC,id DESC LIMIT $4', [owner,cursor?.updated_at ?? null,cursor?.id ?? null,limit+1]);
    const rows = result.rows.slice(0,limit), last = rows.at(-1);
    return { projects: rows.map(row => Store.decode(row)!), next:result.rows.length>limit && last ? {updated_at:last.cursor_updated_at as string,id:last.id as string} : null };
  }
  async messagesPage(id: string, limit = 100, before?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Message limit must be between 1 and 500');
    const result = await this.pool.query('SELECT id,role,content,created_at,metadata,sequence_id::text AS sequence_id FROM messages WHERE project_id=$1 AND ($2::bigint IS NULL OR sequence_id<$2::bigint) ORDER BY sequence_id DESC LIMIT $3', [id,before ?? null,limit+1]);
    const rows = result.rows.slice(0,limit), last = rows.at(-1);
    return { messages:rows.reverse().map(({sequence_id,...row}) => ({...row,created_at:iso(row.created_at)}) as Message), next:result.rows.length>limit && last ? last.sequence_id as string : null };
  }
  async messages(id: string, limit = 500): Promise<Message[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Message limit must be between 1 and 1000');
    const result = await this.pool.query('SELECT id,role,content,created_at,metadata FROM messages WHERE project_id=$1 ORDER BY sequence_id DESC LIMIT $2', [id, limit]);
    return result.rows.reverse().map(row => ({ ...row, created_at: iso(row.created_at) }));
  }
  async cached(projectId: string, requestId: string, digest: string): Promise<any | null> {
    const result = await this.pool.query('SELECT input_hash,response FROM requests WHERE project_id=$1 AND request_id=$2', [projectId, requestId]);
    if (!result.rowCount) return null;
    if (result.rows[0].input_hash !== digest) throw new Conflict('동일한 request_id를 다른 입력에 사용할 수 없습니다.');
    return result.rows[0].response;
  }
  async saveTurn(owner: string, oldRevision: number, project: Project, messages: Message[], requestId: string, digest: string, response: unknown): Promise<void> {
    if (!Number.isInteger(oldRevision) || project.revision !== oldRevision + 1) throw new Conflict('프로젝트 변경 순서를 확인해 주세요.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query('UPDATE projects SET title=$1,status=$2,profile=$3::jsonb,domains=$4::jsonb,pending_question_id=$5,revision=$6,updated_at=$7 WHERE id=$8 AND owner=$9 AND revision=$10 RETURNING id', [project.title,project.status,JSON.stringify(project.profile),JSON.stringify(project.domains),project.pending_question_id,project.revision,project.updated_at,project.id,owner,oldRevision]);
      if (changed.rowCount !== 1) throw new Conflict('다른 요청이 먼저 완료되었습니다. 프로젝트를 새로 불러온 뒤 다시 보내주세요.');
      for (const message of messages) await client.query('INSERT INTO messages(id,project_id,role,content,created_at,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [message.id,project.id,message.role,message.content,message.created_at,JSON.stringify(message.metadata ?? {})]);
      await client.query('INSERT INTO profile_versions(project_id,revision,profile,created_at) VALUES ($1,$2,$3::jsonb,$4)', [project.id,project.revision,JSON.stringify(project.profile),project.updated_at]);
      await client.query('INSERT INTO requests(project_id,request_id,input_hash,response) VALUES ($1,$2,$3,$4::jsonb)', [project.id,requestId,digest,JSON.stringify(response)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new Conflict('이미 처리된 요청입니다. 프로젝트를 다시 불러와 주세요.');
      throw error;
    } finally { client.release(); }
  }
  async delete(owner: string, id: string): Promise<boolean> {
    if (!UUID.test(owner) || !UUID.test(id)) return false;
    const result = await this.pool.query('DELETE FROM projects WHERE id=$1 AND owner=$2', [id, owner]);
    return result.rowCount === 1;
  }
}
