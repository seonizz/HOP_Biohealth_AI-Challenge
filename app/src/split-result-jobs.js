import {randomUUID} from 'node:crypto';
import {HttpError} from './errors.js';

// Jobs refer to encrypted intake snapshots. No answers or model outputs are
// duplicated in the queue. A revision change removes the previous job.
export async function syncSplitResultJob(client, owner, id, revision, state) {
  await client.query('DELETE FROM split_result_jobs WHERE intake_id=$1 AND owner=$2', [id, owner]);
  if (state.status === 'ready' && !state.modelPending && !state.agentRecord &&
      (!state.v3?.stopped || state.safetySignal?.urgent || state.safetyReviewPending?.urgent)) {
    await client.query('INSERT INTO split_result_jobs(intake_id,owner,revision) VALUES($1,$2,$3)', [id, owner, revision]);
  }
}

export async function assertSplitResultClaim(client, owner, id, revision, token) {
  const result = await client.query(`SELECT 1 FROM split_result_jobs
    WHERE owner=$1 AND intake_id=$2 AND revision=$3 AND run_token=$4
      AND lease_until>clock_timestamp() FOR UPDATE`, [owner, id, revision, token]);
  if (!result.rowCount) throw new HttpError(409, 'REVISION_CONFLICT', '대화가 변경됐어요. 최신 내용으로 다시 확인해 주세요.');
}

export async function splitResultJob(store, owner, id, revision) {
  const result = await store.pool.query('SELECT status FROM split_result_jobs WHERE owner=$1 AND intake_id=$2 AND revision=$3',
    [owner, id, revision]);
  return result.rows[0]?.status;
}

export async function retrySplitResultJob(store, owner, id, revision) {
  await store.pool.query(`UPDATE split_result_jobs SET status='queued', queued_at=clock_timestamp()
    WHERE owner=$1 AND intake_id=$2 AND revision=$3 AND status='failed'`, [owner, id, revision]);
}

const leaseSeconds = 30;
const renewMs = 10000;
async function claimNext(store) {
  const token = randomUUID();
  const result = await store.pool.query(`WITH next_job AS (
    SELECT j.intake_id FROM split_result_jobs j
    JOIN intakes i ON i.id=j.intake_id AND i.owner=j.owner AND i.revision=j.revision
    JOIN browsers b ON b.id=j.owner
    WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp()))
      AND b.last_active_at>clock_timestamp()-make_interval(days=>$3)
    ORDER BY j.queued_at,j.intake_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE split_result_jobs j SET status='running', run_token=$1,
    lease_until=clock_timestamp()+make_interval(secs=>$2)
  FROM next_job WHERE j.intake_id=next_job.intake_id
  RETURNING j.intake_id AS id,j.owner,j.revision,j.run_token AS token`, [token, leaseSeconds, store.retentionDays]);
  return result.rows[0];
}

async function renew(store, {owner,id,revision,token}) {
  const result = await store.pool.query(`UPDATE split_result_jobs
    SET lease_until=clock_timestamp()+make_interval(secs=>$5)
    WHERE owner=$1 AND intake_id=$2 AND revision=$3 AND run_token=$4 AND lease_until>clock_timestamp()`,
  [owner,id,revision,token,leaseSeconds]);
  return result.rowCount === 1;
}

async function release(store, {owner,id,revision,token}, status) {
  const result = await store.pool.query(`UPDATE split_result_jobs SET status=$5, run_token=NULL, lease_until=NULL
    WHERE owner=$1 AND intake_id=$2 AND revision=$3 AND run_token=$4`, [owner,id,revision,token,status]);
  return result.rowCount === 1;
}

// One active job per process. A renewable claim fences stale workers if an
// instance exits, loses its claim, or races a correction on another instance.
export function createSplitResultWorker(store, run, onError) {
  let draining, tick, active, closed = false;
  async function drain() {
    while (!closed) {
      const job = await claimNext(store);
      if (!job) return;
      if (closed) {
        await release(store, job, 'queued');
        return;
      }
      const controller = active = new AbortController();
      let renewal, timer;
      const heartbeat = () => {
        timer = setTimeout(() => {
          renewal = renew(store, job).then(owned => {
            if (owned && !controller.signal.aborted) heartbeat();
            else controller.abort(new HttpError(409, 'REVISION_CONFLICT', '대화가 변경됐어요. 최신 내용으로 다시 확인해 주세요.'));
          }).catch(error => controller.abort(error));
        }, renewMs);
        timer.unref();
      };
      heartbeat();
      try {
        await run(job, controller.signal);
      } catch (error) {
        const interrupted = closed || controller.signal.aborted;
        const released = await release(store, job, interrupted ? 'queued' : 'failed');
        if (!interrupted && released) onError(error);
      } finally {
        clearTimeout(timer);
        controller.abort();
        await renewal;
        active = null;
      }
    }
  }
  function wake() {
    if (!closed && !draining) draining = drain().catch(onError).finally(() => { draining = null; });
  }
  return {
    wake,
    start() { tick = setInterval(wake, 1000); tick.unref(); wake(); },
    close() { closed = true; clearInterval(tick); active?.abort(); return draining; }
  };
}
