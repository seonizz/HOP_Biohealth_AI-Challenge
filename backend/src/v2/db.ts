import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ContentCipher, inputHash } from './crypto.ts';
import { V2Error, fail, uuid } from './errors.ts';

export const contentTables = ['question_instances','v2_messages','answer_revisions','memory_items','conversation_summaries','safety_episodes','guidance_versions','action_plans','plan_feedback'] as const;
export type ContentTable = typeof contentTables[number];
export type Row = Record<string, any>;
export class Transaction {
  readonly client: pg.PoolClient;
  readonly owner: string;
  readonly cipher: ContentCipher;
  readonly projectCiphers = new Map<string,ContentCipher>();
  constructor(client: pg.PoolClient, owner: string, cipher: ContentCipher) { this.client=client; this.owner=owner; this.cipher=cipher; }
  async query(sql: string, args: unknown[] = []) { return this.client.query(sql,args); }
  async consent(required = true) {
    const result = await this.query('SELECT DISTINCT ON(purpose) purpose,accepted,version FROM consent_records WHERE owner_id=$1 ORDER BY purpose,sequence_id DESC',[this.owner]);
    const purposes = Object.fromEntries(result.rows.map(r => [r.purpose,r.accepted]));
    if (required && (!purposes.service_processing || !purposes.sensitive_processing)) fail('CONSENT_REQUIRED',403);
    return purposes;
  }
  async project(id: string, includeExpired = false): Promise<Row> {
    uuid(id);
    const r = await this.query('SELECT * FROM v2_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,this.owner]);
    if (!r.rowCount) fail('NOT_FOUND',404);
    const p = r.rows[0];
    if (!includeExpired && new Date(p.expires_at).getTime() <= Date.now()) fail('RESOURCE_DELETED',410);
    let cipher = this.cipher;
    if (p.temporary) {
      const key = await this.query('SELECT encrypted_key FROM temporary_content_keys WHERE id=$1 AND owner_id=$2 AND expires_at>now()',[id,this.owner]);
      if (!key.rowCount) fail('RESOURCE_DELETED',410);
      cipher = new ContentCipher(this.cipher.open(key.rows[0].encrypted_key,`${this.owner}:${id}:key`),id);
    }
    this.projectCiphers.set(id,cipher);
    return {...p,data:cipher.open(p.encrypted_payload,`${this.owner}:${id}`)};
  }
  seal(project: string, id: string, data: unknown) {
    const cipher = this.projectCiphers.get(project);
    if (!cipher) throw new Error('Project context not loaded');
    return cipher.seal(data,`${this.owner}:${id}`);
  }
  decode(row: Row): Row {
    const cipher = this.projectCiphers.get(row.project_id);
    if (!cipher) throw new Error('Project context not loaded');
    const {encrypted_payload,...safe} = row;
    return {...safe,data:cipher.open(encrypted_payload,`${this.owner}:${row.id}`)};
  }
  async conversation(id: string): Promise<{c:Row,p:Row}> {
    uuid(id);
    const first = await this.query('SELECT project_id FROM conversations WHERE id=$1 AND owner_id=$2',[id,this.owner]);
    if (!first.rowCount) fail('NOT_FOUND',404);
    const p = await this.project(first.rows[0].project_id);
    const rows = await this.query('SELECT * FROM conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,this.owner]);
    return {c:this.decode(rows.rows[0]),p};
  }
  async saveConversation(c: Row) {
    await this.query('UPDATE conversations SET revision=$3,safety_revision=$4,state=$5,active_run_id=$6,encrypted_payload=$7 WHERE id=$1 AND owner_id=$2',[c.id,this.owner,c.revision,c.safety_revision,c.state,c.active_run_id,this.seal(c.project_id,c.id,c.data)]);
  }
  async saveProject(p: Row) {
    await this.query('UPDATE v2_projects SET revision=$3,memory_revision=$4,deletion_epoch=$5,encrypted_payload=$6,updated_at=now() WHERE id=$1 AND owner_id=$2',[p.id,this.owner,p.revision,p.memory_revision,p.deletion_epoch,this.seal(p.id,p.id,p.data)]);
  }
  async rows(table: ContentTable, project: string, conversation?: string) {
    if (!contentTables.includes(table)) throw new Error('Unknown content table');
    const r = await this.query(`SELECT * FROM ${table} WHERE owner_id=$1 AND project_id=$2 ${conversation ? 'AND conversation_id=$3' : ''} ORDER BY sequence_id`,[this.owner,project,...(conversation?[conversation]:[])]);
    return r.rows.map(row => this.decode(row));
  }
  async get(table: ContentTable, id: string): Promise<Row> {
    uuid(id);
    const r = await this.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2`,[id,this.owner]);
    if (!r.rowCount) fail('NOT_FOUND',404);
    await this.project(r.rows[0].project_id);
    return this.decode(r.rows[0]);
  }
  async insert(table: ContentTable, c: Row, data: unknown, status = 'active', extras: Record<string,unknown> = {}) {
    const id = randomUUID();
    const extraKeys = Object.keys(extras);
    if (extraKeys.some(k => !['question_instance_id','answer_revision'].includes(k))) throw new Error('Invalid insert field');
    const values = [id,this.owner,c.project_id,c.id,status,this.seal(c.project_id,id,data),...Object.values(extras)];
    const result = await this.query(`INSERT INTO ${table}(id,owner_id,project_id,conversation_id,status,encrypted_payload${extraKeys.length?','+extraKeys.join(','):''}) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values);
    return this.decode(result.rows[0]);
  }
  async update(table: ContentTable, row: Row) {
    await this.query(`UPDATE ${table} SET revision=$3,status=$4,encrypted_payload=$5 WHERE id=$1 AND owner_id=$2`,[row.id,this.owner,row.revision,row.status,this.seal(row.project_id,row.id,row.data)]);
  }
  async event(c: Row, type: string, resource?: string) {
    const r = await this.query('UPDATE conversations SET event_sequence=event_sequence+1 WHERE id=$1 AND owner_id=$2 RETURNING event_sequence',[c.id,this.owner]);
    await this.query('INSERT INTO outbox_events(id,owner_id,project_id,conversation_id,sequence_id,type,resource_ref) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),this.owner,c.project_id,c.id,r.rows[0].event_sequence,type,resource || null]);
  }
  async invalidate(project: string, status = 'SUPERSEDED') {
    await this.query("UPDATE agent_runs SET status=$3 WHERE owner_id=$1 AND project_id=$2 AND status IN ('ACCEPTED','RUNNING')",[this.owner,project,status]);
    await this.query('UPDATE conversations SET active_run_id=null WHERE owner_id=$1 AND project_id=$2',[this.owner,project]);
    await this.query('DELETE FROM agent_queue WHERE run_id IN (SELECT id FROM agent_runs WHERE owner_id=$1 AND project_id=$2)',[this.owner,project]);
  }
  async rate(bucket: string, max: number) {
    const r = await this.query(`INSERT INTO v2_rate_limits(owner_id,bucket,started_at,count) VALUES($1,$2,now(),1)
      ON CONFLICT(owner_id,bucket) DO UPDATE SET count=CASE WHEN v2_rate_limits.started_at<now()-interval '60 seconds' THEN 1 ELSE v2_rate_limits.count+1 END, started_at=CASE WHEN v2_rate_limits.started_at<now()-interval '60 seconds' THEN now() ELSE v2_rate_limits.started_at END RETURNING count`,[this.owner,bucket]);
    if (r.rows[0].count>max) fail('RATE_LIMITED',429);
  }
  async receipt(scope: string, id: string, accountReceipt?: string) {
    const deletion = randomUUID();
    const r = await this.query(`INSERT INTO deletion_requests(id,owner_id,scope,random_resource_id,online_purged,derived_purged,receipt_hash,receipt_expires_at) VALUES($1,$2,$3,$4,true,true,$5,CASE WHEN $5::text IS NOT NULL THEN now()+interval '1 hour' END) RETURNING id,scope,online_purged,derived_purged,backup_expires_at`,[deletion,this.owner,scope,id,accountReceipt ? inputHash(accountReceipt) : null]);
    await this.query('INSERT INTO deletion_index(id,owner_id) VALUES($1,$2)',[deletion,this.owner]);
    return r.rows[0];
  }
}
export class V2Database {
  readonly pool: pg.Pool; readonly cipher: ContentCipher;
  constructor(pool: pg.Pool, cipher: ContentCipher) { this.pool=pool; this.cipher=cipher; }
  async transaction<T>(owner: string, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    uuid(owner); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_id',$1,true)",[owner]);
      // Serialize owner writes across API instances; project/row locks remain the ledger boundary.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('malssi_owner'),hashtext($1))",[owner]);
      const result = await operation(new Transaction(client,owner,this.cipher));
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async write(owner: string, scope: string, input: any, operation: (tx: Transaction) => Promise<any>) {
    uuid(input.request_id);
    return this.transaction(owner,async tx => {
      const fingerprint = inputHash({scope,input});
      const previous = await tx.query('SELECT * FROM requests_v2 WHERE owner_id=$1 AND scope_id=$2 AND request_id=$3',[owner,scope,input.request_id]);
      if (previous.rowCount) {
        if (previous.rows[0].canonical_input_hash !== fingerprint) fail('IDEMPOTENCY_CONFLICT',409);
        return {...previous.rows[0].response_ref,replayed:true};
      }
      const result = await operation(tx);
      await tx.query('INSERT INTO audit_events(owner_id,action,resource_id,result) VALUES($1,$2,$3,$4)',[owner,scope.split(':')[0],result.project_id || result.conversation_id || result.memory_id || null,'saved']);
      // References only: no aliases, answers or guidance duplicated in the idempotency journal.
      const response = {schema_version:'2.0',request_id:input.request_id,saved:true,...result};
      await tx.query('INSERT INTO requests_v2(owner_id,scope_id,request_id,canonical_input_hash,response_ref) VALUES($1,$2,$3,$4,$5)',[owner,scope,input.request_id,fingerprint,response]);
      return response;
    });
  }
  async assertRuntimeRole() {
    const r = await this.pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    const owner = await this.pool.query("SELECT 1 FROM pg_class WHERE oid='v2_projects'::regclass AND pg_get_userbyid(relowner)=current_user");
    if (r.rows[0].rolsuper || r.rows[0].rolbypassrls || owner.rowCount) throw new Error('V2 requires a non-owner non-superuser non-BYPASSRLS runtime role');
  }
  async createProject(tx: Transaction, data: any, temporary: boolean) {
    const id = randomUUID(), cipher = temporary ? new ContentCipher(randomBytes(32).toString('base64'),id) : this.cipher;
    // Generate a separately wrapped key; it never appears in API responses or logs.
    let tempKey: string | undefined;
    if (temporary) { tempKey=randomBytes(32).toString('base64'); tx.projectCiphers.set(id,new ContentCipher(tempKey,id)); }
    else tx.projectCiphers.set(id,cipher);
    await tx.query("INSERT INTO projects(id,owner,title,status,api_version) VALUES($1,$2,'말씨 프로젝트','v2',2)",[id,tx.owner]);
    await tx.query(`INSERT INTO v2_projects(id,owner_id,encrypted_payload,temporary,expires_at) VALUES($1,$2,$3,$4,now()+CASE WHEN $4 THEN interval '24 hours' ELSE interval '90 days' END)`,[id,tx.owner,tx.seal(id,id,data),temporary]);
    if (tempKey) await tx.query("INSERT INTO temporary_content_keys(id,owner_id,encrypted_key,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",[id,tx.owner,this.cipher.seal(tempKey,`${tx.owner}:${id}:key`)]);
    return id;
  }
}
