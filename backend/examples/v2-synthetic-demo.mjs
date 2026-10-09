// Explicitly creates synthetic demo data, then deletes only its own new account.
import { randomUUID, randomBytes } from 'node:crypto';
const args = process.argv.slice(2);
if (args[0] !== '--synthetic-demo' || args.length > 2) throw new Error('Usage: node --env-file=runtime.env examples/v2-synthetic-demo.mjs --synthetic-demo [http://127.0.0.1:19010]');
const base = new URL(args[1] || 'http://127.0.0.1:19010');
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.protocol !== 'http:' || base.port !== '19010' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use the isolated loopback demo API on port 19010');
if (!/^malssi_handoff_[a-z0-9_]{1,40}$/.test(process.env.HOP_DATABASE_SCHEMA || '') || !process.env.HOP_INVITE_CODE) throw new Error('Load the handoff runtime.env, not a production profile');
const password = randomBytes(24).toString('base64url');
const email = 'synthetic-' + randomUUID() + '@example.invalid';
const report = { synthetic: true, stages: [] };
let token, accountCreated = false;
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Origin: base.origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('HTTP_' + response.status + '_' + (data.error?.code || data.code || 'REQUEST_FAILED'));
  return data;
}
try {
  const auth = await request('/api/auth/register', 'POST', { email, password, invite_code: process.env.HOP_INVITE_CODE });
  token = auth.token; accountCreated = true; report.stages.push('register');
  const login = await request('/api/auth/login', 'POST', { email, password });
  token = login.token; report.stages.push('login');
  const capabilities = await request('/api/v2/capabilities');
  report.model_execution_enabled = capabilities.model_execution_enabled;
  await request('/api/v2/consents', 'POST', {
    request_id: randomUUID(), version: 'malssi-consent-v1',
    purposes: { service_processing: true, sensitive_processing: true, history_storage: false, cross_session_memory: false },
  });
  report.stages.push('synthetic_consents');
  const project = await request('/api/v2/projects', 'POST', { request_id: randomUUID(), title: '합성 인계 점검' });
  const conversation = await request('/api/v2/projects/' + project.project_id + '/conversations', 'POST', { request_id: randomUUID(), goal: 'understand' });
  const before = await request('/api/v2/conversations/' + conversation.conversation_id);
  if (before.question?.question_id !== 'N00') throw new Error('UNEXPECTED_FIRST_QUESTION');
  await request('/api/v2/conversations/' + conversation.conversation_id + '/turns', 'POST', {
    request_id: randomUUID(), expected_revision: before.resource_revision, action: 'answer',
    payload: { question_instance_id: before.question.id, question_id: before.question.question_id, question_version: before.question.question_version, disposition: 'answered', value: { text: '가족' } },
  });
  const after = await request('/api/v2/conversations/' + conversation.conversation_id);
  if (after.resource_revision !== before.resource_revision + 1) throw new Error('REVISION_NOT_ADVANCED');
  report.stages.push('project', 'conversation', 'read_question', 'answer', 'read_next_question');
  report.next_question_id = after.question?.question_id || null;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : 'DEMO_FAILED';
} finally {
  if (accountCreated && token) {
    try {
      const deletion = await request('/api/v2/account', 'DELETE', { request_id: randomUUID(), current_password: password });
      report.synthetic_account_deleted = deletion.online_purged === true;
      if (!report.synthetic_account_deleted) report.passed = false;
    } catch { report.synthetic_account_deleted = false; report.passed = false; }
  }
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.passed ? 0 : 1;
