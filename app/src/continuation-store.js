import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

const notFound = () => new HttpError(404, 'NOT_FOUND', '추가 대화를 찾을 수 없어요.');
const conflict = () => new HttpError(409, 'REVISION_CONFLICT', '대화가 변경됐어요. 최신 내용을 다시 확인해 주세요.');
const statuses = new Set(['active', 'pending', 'retryable', 'completed']);
const aad = (owner, id) => `${owner}:continuation:${id}`;
const metadata = row => ({
  id:row.id, owner:row.owner, source_record_id:row.source_record_id, source_intake_id:row.source_intake_id,
  revision:row.revision, status:row.status, created_at:row.created_at.toISOString(), updated_at:row.updated_at.toISOString(),
});
const open = (store, row) => ({...metadata(row), state:store.open(row.content, aad(row.owner, row.id))});

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !statuses.has(state.status) ||
      !Array.isArray(state.messages) || !state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests)) {
    throw new Error('Invalid continuation state');
  }
}

export async function createContinuation(store, owner, recordId, epoch, requestId) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new HttpError(422, 'INVALID_REVISION', '현재 대화 목록을 다시 확인해 주세요.');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw new HttpError(422, 'INVALID_REQUEST_ID', '요청을 다시 확인해 주세요.');
  }
  recordId = String(recordId);
  return store.transaction(async client => {
    const browser = await store.lockOwner(client, owner);
    if (browser.conversation_epoch !== epoch) throw new HttpError(409, 'CONVERSATIONS_CHANGED', '대화 목록이 변경됐어요. 내 기록을 새로 확인해 주세요.');
    const source = await client.query(`SELECT r.intake_id,i.content FROM records r
      JOIN intakes i ON i.id=r.intake_id AND i.owner=r.owner WHERE r.owner=$1 AND r.id=$2`, [owner, recordId]);
    if (!source.rowCount) throw notFound();
    const intakeId = source.rows[0].intake_id;
    const state = store.open(source.rows[0].content, `${owner}:intake:${intakeId}`);
    if (state.status !== 'ready' || state.modelPending) {
      throw new HttpError(409, 'INTAKE_NOT_COMPLETE', '기존 결과가 준비된 뒤 추가 질문을 시작해 주세요.');
    }
    const previous = await client.query(`SELECT q.source_record_id AS requested_record_id,s.* FROM continuation_creation_requests q
      LEFT JOIN continuation_sessions s ON s.id=q.continuation_id AND s.owner=q.owner
      WHERE q.owner=$1 AND q.request_id=$2`, [owner, requestId]);
    if (previous.rowCount) {
      if (previous.rows[0].requested_record_id !== recordId) throw new HttpError(409, 'REQUEST_CONFLICT', '이미 다른 요청에 사용된 요청이에요.');
      if (!previous.rows[0].id) throw notFound();
      return open(store, previous.rows[0]);
    }
    let current = await client.query(`SELECT * FROM continuation_sessions
      WHERE owner=$1 AND source_record_id=$2 AND status<>'completed'`, [owner, recordId]);
    if (!current.rowCount) {
      const id = randomUUID();
      const initial = {status:'active', messages:[], requests:{}, pending:null, summary:null, cards:[]};
      current = await client.query(`INSERT INTO continuation_sessions
        (id,owner,source_record_id,source_intake_id,revision,status,content)
        VALUES ($1,$2,$3,$4,0,'active',$5) RETURNING *`,
      [id, owner, recordId, intakeId, store.seal(initial, aad(owner, id))]);
    }
    const row = current.rows[0];
    await client.query('INSERT INTO continuation_creation_requests(owner,request_id,source_record_id,continuation_id) VALUES ($1,$2,$3,$4)', [owner, requestId, recordId, row.id]);
    return open(store, row);
  });
}

export async function listContinuations(store, owner, recordId) {
  return store.transaction(async client => {
    await store.lockOwner(client, owner, 'SHARE');
    const source = await client.query('SELECT id FROM records WHERE owner=$1 AND id=$2', [owner, String(recordId)]);
    if (!source.rowCount) throw notFound();
    const rows = await client.query(`SELECT id,owner,source_record_id,source_intake_id,revision,status,created_at,updated_at
      FROM continuation_sessions WHERE owner=$1 AND source_record_id=$2 ORDER BY sequence`, [owner, String(recordId)]);
    return rows.rows.map(metadata);
  });
}

export async function getContinuation(store, owner, id) {
  return store.transaction(async client => {
    await store.lockOwner(client, owner, 'SHARE');
    const rows = await client.query('SELECT * FROM continuation_sessions WHERE owner=$1 AND id=$2', [owner, id]);
    if (!rows.rowCount) throw notFound();
    return open(store, rows.rows[0]);
  });
}

export async function updateContinuation(store, owner, id, revision, mutate, {invalidateLater = false} = {}) {
  return store.transaction(async client => {
    await store.lockOwner(client, owner);
    const rows = await client.query('SELECT * FROM continuation_sessions WHERE owner=$1 AND id=$2 FOR UPDATE', [owner, id]);
    if (!rows.rowCount) throw notFound();
    if (rows.rows[0].revision !== revision) throw conflict();
    const state = mutate(store.open(rows.rows[0].content, aad(owner, id)));
    // Model/network work belongs outside the transaction. A stale completion
    // must re-enter with its captured revision and cannot overwrite newer input.
    if (state && typeof state.then === 'function') throw new Error('Continuation mutation must be synchronous');
    validateState(state);
    const updated = await client.query(`UPDATE continuation_sessions SET revision=revision+1,status=$1,content=$2,
      updated_at=clock_timestamp() WHERE owner=$3 AND id=$4 RETURNING *`, [state.status, store.seal(state, aad(owner, id)), owner, id]);
    const invalidated = invalidateLater ? await invalidateLaterSessions(store, client, owner, updated.rows[0]) : [];
    return {...open(store, updated.rows[0]), invalidated_ids:invalidated};
  });
}

async function invalidateLaterSessions(store, client, owner, source) {
  // Later rounds can contain quotations/interpretations from the changed round.
  // Keep their own user input, discard derived content, and fence old workers.
  const later = await client.query(`SELECT * FROM continuation_sessions WHERE owner=$1 AND source_record_id=$2
    AND sequence>$3 ORDER BY sequence FOR UPDATE`, [owner, source.source_record_id, source.sequence]);
  for (const row of later.rows) {
    const previous = store.open(row.content, aad(owner, row.id));
    // Retain only the replay fence. Dropping request IDs would let a refreshed
    // client resubmit an old message as a new turn after this invalidation.
    const requests = Object.fromEntries(Object.entries(previous.requests).map(([id, request]) =>
      [id, {action:request.action, hash:request.hash, status:'invalidated'}]));
    const state = {status:previous.status === 'completed' ? 'completed' : 'active',
      messages:previous.messages.filter(message => message.role === 'user'), requests, pending:null, summary:null, cards:[],
      context_invalidated:true};
    await client.query(`UPDATE continuation_sessions SET revision=revision+1,status=$1,content=$2,
      updated_at=clock_timestamp() WHERE owner=$3 AND id=$4`, [state.status, store.seal(state, aad(owner, row.id)), owner, row.id]);
  }
  return later.rows.map(row => row.id);
}

export async function deleteContinuation(store, owner, id) {
  return store.transaction(async client => {
    await store.lockOwner(client, owner);
    const rows = await client.query('DELETE FROM continuation_sessions WHERE owner=$1 AND id=$2 RETURNING *', [owner, id]);
    if (!rows.rowCount) throw notFound();
    const removed = rows.rows[0];
    const invalidated = await invalidateLaterSessions(store, client, owner, removed);
    return {id, source_record_id:removed.source_record_id, source_intake_id:removed.source_intake_id,
      invalidated_ids:invalidated};
  });
}
