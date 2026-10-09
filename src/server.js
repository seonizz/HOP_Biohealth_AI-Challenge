import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Store, loadContentKey } from './store.js';
import { HttpError, object } from './errors.js';
import { columns, categories } from './catalog.js';
import { questionCatalogOf } from './question-bank.js';
import { createIntake, currentView, answerIntake, backIntake, buildContext, applyModelUpdate,
  prepareModelAnswer, completeModelAnswer, discardModelAnswer } from './intake.js';
import { ModelGateway } from './model.js';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIMES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.ttf':'font/ttf', '.woff2':'font/woff2', '.json':'application/json; charset=utf-8' };
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON_REQUIRED', 'JSON 형식으로 보내 주세요.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new HttpError(413, 'BODY_TOO_LARGE', '요청 내용이 너무 길어요.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', '요청 내용을 읽을 수 없어요.'); }
}

const tokenFrom = req => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('malssi_session='))?.slice(15);
const revisionOf = value => {
  if (!Number.isInteger(value) || value < 0) throw new HttpError(422, 'INVALID_REVISION', '현재 대화 버전을 확인해 주세요.');
  return value;
};
const sameAnswer = (a, b) => JSON.stringify([
  a.question_id, a.text ?? '', a.selected ?? [], a.custom ?? '', a.skipped === undefined ? false : a.skipped, a.follow_up === undefined ? false : a.follow_up,
]) === JSON.stringify([
  b.question_id, b.text ?? '', b.selected ?? [], b.custom ?? '', b.skipped === undefined ? false : b.skipped, b.follow_up === undefined ? false : b.follow_up,
]);
const revisionConflict = () => new HttpError(409, 'REVISION_CONFLICT', '다른 요청이 먼저 반영됐어요. 현재 질문을 다시 확인해 주세요.');

export async function createApp({ databaseUrl = process.env.DATABASE_URL, schema = 'public', key, sessionDays = 30, publicOrigin, allowedOrigins = [], rateLimit = 600, gateway } = {}) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(value => {
    try { const url = new URL(value); return url.origin !== value || !['http:', 'https:'].includes(url.protocol) || url.username || url.password; }
    catch { return true; }
  })) throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  const store = await Store.connect(databaseUrl, key || loadContentKey(resolve('./runtime/content.key')), sessionDays, { schema });
  if (gateway === undefined) gateway = process.env.MODEL_BASE_URL && process.env.MODEL_API_KEY ? new ModelGateway({
    baseUrl:process.env.MODEL_BASE_URL, apiKey:process.env.MODEL_API_KEY,
    model:process.env.MODEL_NAME || 'malssi-gemma4-31b-step100',
    timeoutMs:process.env.MODEL_TIMEOUT_MS ? Number(process.env.MODEL_TIMEOUT_MS) : undefined,
    protocol:process.env.MODEL_PROTOCOL
  }) : null;
  const limits = new Map();
  const resultRuns = new Map();
  const modelRuns = new Map();
  const view = row => ({ id: row.id, revision: row.revision, name:row.state.name, chat_title:row.state.chatTitle || '', ...currentView(row.state), log: row.state.log });
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestStarted = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const expectedOrigin = publicOrigin || `http://127.0.0.1:${server.address()?.port}`;
      const origins = [expectedOrigin, ...allowedOrigins];
      const hostOrigin = origins.find(value => new URL(value).host === req.headers.host);
      if (!hostOrigin) throw new HttpError(403, 'HOST_REJECTED', '이 주소에서는 접근할 수 없어요.');
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw new HttpError(403, 'ORIGIN_REJECTED', '같은 앱에서 요청해 주세요.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN_REJECTED', '같은 앱에서 요청해 주세요.');
      const url = new URL(req.url, expectedOrigin), path = url.pathname, method = req.method;
      if (path === '/health' && method === 'GET') return json(res, 200, { status:'ok', model_configured:Boolean(gateway), mode:'personal_demo' });
      if (!path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청이에요.');
        let decoded;
        try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, 'INVALID_PATH', '주소를 확인해 주세요.'); }
        const file = resolve(ROOT, '.' + (decoded === '/' ? '/index.html' : decoded));
        if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || !MIMES[extname(file)] || decoded.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없어요.');
        try {
          if (!(await stat(file)).isFile()) throw new Error('not file');
          const content = await readFile(file);
          res.writeHead(200, { 'Content-Type':MIMES[extname(file)] });
          return res.end(method === 'HEAD' ? undefined : content);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없어요.');
        }
      }
      const ip = req.socket.remoteAddress;
      const entry = limits.get(ip);
      if (!entry || entry.until < Date.now()) limits.set(ip, { count:1, until:Date.now() + 60000 });
      else if (++entry.count > rateLimit) { res.setHeader('Retry-After', '60'); throw new HttpError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.'); }
      if (limits.size > 1000) for (const [address, limit] of limits) if (limit.until < Date.now()) limits.delete(address);
      let browser = await store.browser(tokenFrom(req));
      if (method === 'GET' && path === '/api/bootstrap') {
        if (!browser) {
          browser = await store.createBrowser();
          const secure = (req.headers.origin || hostOrigin).startsWith('https:') ||
            (req.headers['x-forwarded-proto'] === 'https' && origins.some(value => value.startsWith('https:')));
          res.setHeader('Set-Cookie', `malssi_session=${browser.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 86400}${secure ? '; Secure' : ''}`);
        }
        return json(res, 200, {
          schema_version:'1.0', csrf_token:browser.csrf,
          mode:'personal_demo', model_connected:Boolean(gateway),
          records:await store.records(browser.id), column_state:await store.columnState(browser.id),
          columns, categories, questions:questionCatalogOf(await store.questionSet())
        });
      }
      if (!browser) throw new HttpError(401, 'SESSION_REQUIRED', '앱을 새로고침해 주세요.');
      if (!['GET','HEAD'].includes(method) && !safeEqual(req.headers['x-csrf-token'], browser.csrf)) throw new HttpError(403, 'CSRF_REJECTED', '앱을 새로고침한 뒤 다시 시도해 주세요.');
      const owner = browser.id;
      if (method === 'GET' && path === '/api/questions') return json(res, 200, { questions:questionCatalogOf(await store.questionSet()) });
      if (method === 'GET' && path === '/api/columns') {
        const category = url.searchParams.get('category') || '전체', only = url.searchParams.get('only') || '';
        if (!['전체', ...categories.map(c => c[0])].includes(category) || !['','unread','saved'].includes(only)) throw new HttpError(422, 'INVALID_FILTER', '분류를 확인해 주세요.');
        const state = await store.columnState(owner);
        const list = columns.filter(a => (category === '전체' || a.cat === category) && (only !== 'unread' || !state.read.includes(a.art)) && (only !== 'saved' || state.saved.includes(a.art)));
        return json(res, 200, { columns:list, categories, state, garden:{ read:state.read.length, total:columns.length } });
      }
      if (method === 'GET' && path === '/api/columns/today') {
        const date = url.searchParams.get('date');
        const parsedDate = new Date(date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw new HttpError(422, 'INVALID_DATE', '날짜를 확인해 주세요.');
        const [year,month,day] = date.split('-').map(Number);
        return json(res, 200, { column:columns[(year * 372 + (month - 1) * 31 + day) % columns.length] });
      }
      if (method === 'GET' && path === '/api/columns/random') {
        const exclude = url.searchParams.get('exclude');
        const pool = columns.filter(a => a.art !== exclude);
        return json(res, 200, { column:pool[Math.floor(Math.random() * pool.length)] });
      }
      const columnMatch = /^\/api\/columns\/([a-z]+)(\/state)?$/.exec(path);
      if (columnMatch) {
        const article = columns.find(a => a.art === columnMatch[1]);
        if (!article) throw new HttpError(404, 'NOT_FOUND', '글을 찾을 수 없어요.');
        if (method === 'GET' && !columnMatch[2]) return json(res, 200, { column:article, state:await store.columnState(owner) });
        if (method === 'PATCH' && columnMatch[2]) {
          const input = object(await body(req), ['read','saved']);
          if (!Object.keys(input).length || (input.read !== undefined && input.read !== true) || (input.saved !== undefined && typeof input.saved !== 'boolean')) throw new HttpError(422, 'INVALID_STATE', '읽음과 담음 상태를 확인해 주세요.');
          return json(res, 200, { state:await store.setColumnState(owner, article.art, input) });
        }
      }
      if (method === 'POST' && path === '/api/intakes') {
        object(await body(req), []);
        return json(res, 201, view(await store.createIntake(owner, createIntake(await store.questionSet()))));
      }
      const intakeMatch = /^\/api\/intakes\/([^/]+)(?:\/(answers|back|context|result))?$/.exec(path);
      if (intakeMatch) {
        const [,id,action] = intakeMatch;
        if (!UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', '대화를 찾을 수 없어요.');
        if (method === 'GET' && !action) return json(res, 200, view(await store.intake(owner, id)));
        if (method === 'GET' && action === 'context') return json(res, 200, await store.context(owner, id));
        if (method === 'POST' && ['answers','back'].includes(action)) {
          const input = object(await body(req), action === 'back' ? ['revision'] : ['revision','question_id','text','selected','custom','skipped','follow_up']);
          const revision = revisionOf(input.revision);
          if (gateway && action === 'answers' && !input.skipped) {
            let row = await store.intake(owner, id);
            const retry = row.state.modelPending && sameAnswer(row.state.modelPending.input, input);
            if (revision !== row.revision && !(retry && revision === row.state.modelPending.sourceRevision)) throw revisionConflict();
            if (!retry) {
              try {
                row = await store.updateIntake(owner, id, row.revision,
                  state => prepareModelAnswer(state, input, revision), 'user_answer');
              } catch (error) {
                if (!(error instanceof HttpError) || error.code !== 'REVISION_CONFLICT') throw error;
                // Identical concurrent submissions share the saved pending turn.
                const latest = await store.intake(owner, id);
                if (latest.state.modelPending?.sourceRevision !== revision || !sameAnswer(latest.state.modelPending.input, input)) throw error;
                row = latest;
              }
            }
            const runKey = `${owner}:${id}:${row.revision}`;
            const run = async () => {
              const context = buildContext(row.state);
              const memory = await gateway.updateState(context, row.state.agentMemory || null, { requestId });
              return store.updateIntake(owner, id, row.revision,
                state => completeModelAnswer(state, memory), 'model_update');
            };
            if (!modelRuns.has(runKey)) modelRuns.set(runKey, run().finally(() => modelRuns.delete(runKey)));
            // The pending input remains saved; an error cannot advance a prompt.
            return json(res, 200, view(await modelRuns.get(runKey)));
          }
          const row = await store.updateIntake(owner, id, revision, state => {
            const next = action === 'back' ? backIntake(state) : answerIntake(discardModelAnswer(state), input);
            // A correction invalidates model interpretations of the reverted answers.
            if (action === 'back') { delete next.agentMemory; delete next.agentResult; delete next.agentRecord; }
            return next;
          }, action === 'back' ? 'correction' : 'user_answer');
          return json(res, 200, view(row));
        }
        if (method === 'POST' && action === 'result') {
          const input = object(await body(req), ['revision']);
          const revision = revisionOf(input.revision);
          const runKey = `${owner}:${id}:${revision}`;
          const run = async () => {
            let row = await store.intake(owner, id);
            if (row.state.agentRecord) return { record:await store.saveRecord(owner, row.state.agentRecord, id), revision:row.revision };
            if (row.revision !== revision || row.state.status !== 'ready') throw new HttpError(409, 'INTAKE_NOT_READY', '대화를 마친 뒤 결과를 확인해 주세요.');
            if (!gateway) throw new HttpError(503, 'MODEL_NOT_CONNECTED', '모델 API 설정을 확인해 주세요.');
            const context = (await store.context(owner, id)).context;
            const result = await gateway.respond(context, row.state.agentMemory || null, { requestId });
            const recordId = await store.nextRecordId();
            const p = { ...context.profileInput, scores:{}, safety:result.assessment.safety,
              symptoms:[], risks:[], protect:[] };
            // Keep the existing UI's explicit self-harm-option safety card safeguard.
            p.safety ||= context.payload.answers.some(a => a.selected.some(o => o.meta.s === 'suicidal') || /죽고\s?싶|사라지고\s?싶|없어지고\s?싶|자살|자해/.test(a.type === 'text' ? a.text : a.custom));
            row = await store.updateIntake(owner, id, revision, state => {
              const next = { ...applyModelUpdate(state, { patient_state:result.patient_state,
                name_index:result.name_index, question_plan:{ skip:[] } }), agentResult:result };
              next.log = [...state.log, { who:'ai', text:'고마워요. 들려주신 이야기를 바탕으로 말하는 방법을 정리했어요.', fu:false, face:'thanks' }];
              next.agentRecord = {
                id:recordId, title:next.chatTitle || next.name || '그분', date:new Date().toISOString(),
                profile:{ ...p, name:next.name }, guide:result.guide, log:next.log, followUps:state.fuCount,
                provenance:{ kind:'model', model:gateway.model || 'gemma4:12b', clinically_validated:false }
              };
              next.agentRecord.context = buildContext(next);
              return next;
            }, 'model_update');
            return { record:await store.saveRecord(owner, row.state.agentRecord, id), revision:row.revision };
          };
          if (!resultRuns.has(runKey)) resultRuns.set(runKey, run().finally(() => resultRuns.delete(runKey)));
          return json(res, 200, await resultRuns.get(runKey));
        }
      }
      if (method === 'GET' && path === '/api/records') return json(res, 200, { records:await store.records(owner) });
      const recordMatch = /^\/api\/records\/(\d+)$/.exec(path);
      if (recordMatch) {
        if (method === 'GET') return json(res, 200, { record:await store.record(owner, recordMatch[1]) });
        if (method === 'DELETE') { await store.deleteRecord(owner, recordMatch[1]); return json(res, 200, { deleted:true }); }
      }
      throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없어요.');
    } catch (error) {
      const known = error instanceof HttpError;
      if (known && error.code.startsWith('MODEL_')) console.error(JSON.stringify({
        event:'model_request_failed', request_id:requestId, operation_id:error.modelRequestId || requestId, code:error.code,
        status:error.status, elapsed_ms:Date.now() - requestStarted,
      }));
      if (!known) console.error(`[${requestId}] request failed`); // No inputs, credentials or counselling content.
      if (!res.headersSent) json(res, known ? error.status : 500, { error:{ code:known ? error.code : 'INTERNAL_ERROR', message:known ? error.message : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.', request_id:requestId } });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => { store.close().catch(() => {}); });
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 9000);
  if ((host !== '127.0.0.1' && !(host === '0.0.0.0' && process.env.DEMO_CONTAINER === 'true')) || !Number.isInteger(port) || port < 1 || port > 65535 || process.env.NODE_ENV === 'production') throw new Error('This demo is restricted to local or Docker demonstration use');
  const publicOrigin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || !['http:','https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  if (process.env.DEMO_CONTAINER !== 'true' && (!['127.0.0.1','localhost'].includes(origin.hostname) || Number(origin.port || 80) !== port)) throw new Error('Use Docker for a remote demonstration server');
  const sessionDays = Number(process.env.SESSION_TTL_DAYS || 30);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 90) throw new Error('SESSION_TTL_DAYS must be 1..90');
  const key = loadContentKey(resolve('./runtime/content.key'));
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const { server } = await createApp({ sessionDays, publicOrigin, allowedOrigins, key });
  const modelStatus = process.env.MODEL_BASE_URL && process.env.MODEL_API_KEY ? '설정 완료' : '설정 없음';
  server.listen(port, host, () => console.log(`말씨 개인 시연: ${publicOrigin} (모델 API ${modelStatus})`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
}
