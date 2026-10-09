import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSettings, ROOT } from './config.ts';
import type { Settings } from './config.ts';
import { Store, Conflict } from './storage.ts';
import { QUESTIONS } from './questions.ts';
import { Flow, HttpError, publicProject, messageBody } from './flow.ts';
import { ModelGateway, ModelError } from './llm.ts';
import type { GatewaySettings } from './llm.ts';
import { KnowledgeBase } from './knowledge.ts';
import { credentials, passwordChange, passwordHash, verifyPassword, sameSecret, cookie, tokenFromHeaders, Limiter } from './auth.ts';
import { ContentCipher } from './v2/crypto.ts';
import { V2Database } from './v2/db.ts';
import { MalssiService, CONSENT_VERSION } from './v2/service.ts';
import { publicV2, routeV2 } from './v2/routes.ts';
import { V2Error } from './v2/errors.ts';

function json(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type: application/json을 사용해 주세요.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'JSON 형식을 확인해 주세요.'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pagination(url: URL, fallback: number, maximum: number) {
  const value = url.searchParams.get('limit'), cursor = url.searchParams.get('cursor');
  if (url.searchParams.getAll('limit').length>1 || url.searchParams.getAll('cursor').length>1 || (value !== null && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value)>maximum)) || cursor === '') throw new HttpError(422,'페이지 크기 또는 커서를 확인해 주세요.','invalid_pagination');
  return {limit:value === null ? fallback : Number(value),cursor};
}
function encodeCursor(kind: string, scope: string, position: Record<string,string>) { return Buffer.from(JSON.stringify({v:1,kind,scope,...position})).toString('base64url'); }
function decodeCursor(value: string, kind: string, scope: string): Record<string,unknown> {
  try {
    if (value.length>512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if (!cursor || cursor.v!==1 || cursor.kind!==kind || cursor.scope!==scope) throw new Error();
    return cursor;
  } catch { throw new HttpError(422,'페이지 커서를 확인해 주세요.','invalid_cursor'); }
}

export async function createApp(settings: Settings = getSettings(), gateway: ModelGateway = new ModelGateway(settings as GatewaySettings)) {
  if (settings.restorePending) throw new Error('Deletion ledger replay is required before serving a restored database');
  const store = await Store.connect(settings.databaseUrl,{schema:settings.databaseSchema,migrate:settings.migrateOnStart});
  let knowledge: KnowledgeBase;
  try {
    knowledge = new KnowledgeBase(settings.knowledgePath);
    if (settings.requireKnowledge && knowledge.count === 0) throw new Error('HOP_REQUIRE_KNOWLEDGE requires a nonempty knowledge file');
  } catch (error) { await store.close(); throw error; }
  const flow = new Flow(store, gateway, knowledge, settings);
  let malssi: MalssiService | null = null;
  try {
    if (settings.v2Enabled) {
      const db = new V2Database(store.pool,new ContentCipher(settings.contentKey));
      await db.assertRuntimeRole();
      malssi = new MalssiService(db,{allowDraft:settings.v2AllowDraft,modelEnabled:settings.v2ModelEnabled});
    }
  } catch(error) {await store.close();throw error;}
  const limiter = new Limiter();
  const dummyPasswordHash = await passwordHash('timing-only-unusable-placeholder-password');
  const server = createServer(async (req, res) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The demo HTML has inline code; it never renders user/model HTML.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const origin = req.headers.origin;
    const permittedOrigins = [settings.publicOrigin,...settings.corsOrigins];
    if (origin && permittedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,If-Match,Last-Event-ID');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After,X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    try {
      if (origin && !permittedOrigins.includes(origin) && !['GET','HEAD'].includes(req.method || '')) throw new HttpError(403,'허용되지 않은 요청 출처입니다.','origin_denied');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (await publicV2(req,res,malssi,store)) return;
      if(req.method==='GET' && req.url==='/health/service') {
        await store.pool.query('SELECT 1');
        json(res,200,{ready:true,v2_enabled:Boolean(malssi)});return;
      }
      const socketIp = req.socket.remoteAddress || 'unknown';
      const proxyAllowed = settings.trustedProxy && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(socketIp);
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim() || '';
      const ip = proxyAllowed && isIP(forwarded) ? forwarded : socketIp;
      limiter.hit('http:'+ip,300,60000);
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const path = requestUrl.pathname;
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(resolve(ROOT,'public/index.html'))); return;
      }
      if (req.method === 'GET' && path === '/openapi.json') {
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(readFileSync(resolve(ROOT,'openapi.json')));return;
      }
      if (req.method === 'GET' && path === '/health') {
        json(res,200,{status:'ok',model_mode:settings.modelMode,model_name:settings.llmModel,knowledge_count:knowledge.count,model_ready:'unchecked',runtime:'nodejs',database:'postgresql',scope:settings.demoEnabled?'internal-demo-and-team-invite':'team-invite-only'}); return;
      }
      if (req.method === 'GET' && path === '/ready') {
        const readyJson = (status: number, value: Record<string,unknown>) => json(res,status,{knowledge_count:knowledge.count,model_mode:settings.modelMode,...value});
        try { await store.pool.query('SELECT 1'); } catch { readyJson(503,{ready:false,reason:'데이터베이스에 연결할 수 없습니다.'}); return; }
        if (settings.modelMode === 'mock') { readyJson(503,{ready:false,model_mode:'mock',reason:'테스트용 모델 모드입니다.'}); return; }
        try {
          const url = settings.llmBaseUrl.replace(/\/$/,'') + (settings.llmBackend === 'ollama' ? '/api/tags' : '/models');
          const result = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(5000), headers: settings.llmApiKey ? {Authorization:'Bearer '+settings.llmApiKey} : {} });
          if (!result.ok) throw new Error('Model unavailable');
          const data = await result.json() as any;
          const ids = settings.llmBackend === 'ollama' ? (data.models || []).map((m: any) => m.name) : (data.data || []).map((m: any) => m.id);
          const ready = ids.includes(settings.llmModel);
          readyJson(ready?200:503,{ready,model_name:settings.llmModel,model_mode:'local',reason:ready?undefined:'설정된 모델이 서빙 목록에 없습니다.'});
        } catch { readyJson(503,{ready:false,model_name:settings.llmModel,model_mode:'local',reason:'모델 서버 연결을 확인해 주세요.'}); }
        return;
      }
      if (req.method === 'GET' && path === '/api/auth/demo') {
        json(res,200,{enabled:Boolean(settings.demoEnabled && malssi)}); return;
      }
      if (req.method === 'POST' && path === '/api/auth/demo') {
        if (!settings.demoEnabled || !malssi) throw new HttpError(404,'시연 모드를 사용할 수 없습니다.','not_found');
        limiter.hit('demo:'+ip,5,60000);
        const input=await body(req);
        if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length) throw new HttpError(422,'빈 JSON 객체를 보내 주세요.','invalid_demo_request');
        const visitor=await store.createDemoUser();
        try {
          await malssi.setConsents(visitor.id,{request_id:randomUUID(),version:CONSENT_VERSION,purposes:{service_processing:true,sensitive_processing:true,history_storage:false,cross_session_memory:false}});
          const project=await malssi.createProject(visitor.id,{request_id:randomUUID(),alias:'친구',title:'말씨 시연'});
          const conversation=await malssi.createConversation(visitor.id,project.project_id,{request_id:randomUUID(),goal:'what_to_say'});
          const token=await store.newSession(visitor.id);
          res.setHeader('Set-Cookie',cookie(token,settings.cookieSecure,false,settings.cookieSameSite));
          json(res,201,{user:visitor,project_id:project.project_id,conversation_id:conversation.conversation_id});
        } catch(error) {
          await store.pool.query('DELETE FROM users WHERE id=$1',[visitor.id]);
          throw error;
        }
        return;
      }
      if (req.method === 'POST' && ['/api/auth/register','/api/auth/login'].includes(path)) {
        limiter.hit('auth:'+ip,15,60000);
        const registering = path.endsWith('/register');
        const input = credentials(await body(req),registering);
        limiter.hit('email:'+input.email,10,60000);
        let user, credentialHash: string;
        if (registering) {
          if (!settings.allowRegistration || !settings.inviteCode || !sameSecret(input.invite_code,settings.inviteCode)) throw new HttpError(403,'유효한 팀 초대 코드가 필요합니다.','invite_required');
          const encoded = await passwordHash(input.password); credentialHash = encoded;
          try {user=await store.createUser(input.email,encoded);} catch(error) {if(error instanceof Conflict || (error as any).code==='23505') throw new HttpError(409,'가입을 완료할 수 없습니다. 기존 계정으로 로그인해 주세요.','registration_conflict'); throw error;}
        } else {
          const stored = await store.findUserByEmail(input.email);
          const valid = await verifyPassword(input.password,stored?.password_hash || dummyPasswordHash);
          if (!stored || !valid) throw new HttpError(401,'이메일 또는 비밀번호를 확인해 주세요.','invalid_credentials');
          user={id:stored.id,email:stored.email}; credentialHash = stored.password_hash;
        }
        const previous = tokenFromHeaders(req.headers);
        if (previous) await store.revokeSession(previous);
        const token=await store.newSession(user.id,credentialHash);
        res.setHeader('Set-Cookie',cookie(token,settings.cookieSecure,false,settings.cookieSameSite));
        json(res,registering?201:200,{user,token,token_type:'bearer'}); return;
      }
      const token = tokenFromHeaders(req.headers);
      const owner = token ? await store.authenticate(token) : null;
      if (!owner) throw new HttpError(401,'유효한 접속 토큰이 필요합니다.','unauthorized');
      if (!['GET','HEAD','OPTIONS'].includes(req.method || '') && req.headers.authorization === undefined && !origin) throw new HttpError(403,'쿠키 인증 변경 요청에는 허용된 Origin이 필요합니다.','origin_required');
      if (req.method === 'DELETE' && path === '/api/auth/demo') {
        await body(req);
        const visitor=await store.getUser(owner);
        if (!visitor?.is_demo || !malssi) throw new HttpError(403,'시연 계정만 삭제할 수 있습니다.','not_demo');
        await malssi.db.transaction(owner,async tx=>{
          const projects=await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1',[owner]);
          for(const p of projects.rows) await tx.invalidate(p.id,'CANCELLED');
          await tx.receipt('delete_account',owner,randomBytes(32).toString('base64url'));
          await tx.query('DELETE FROM users WHERE id=$1',[owner]);
        });
        res.setHeader('Set-Cookie',cookie('',settings.cookieSecure,true,settings.cookieSameSite));
        json(res,200,{deleted:true}); return;
      }
      if (await routeV2(req,res,owner,malssi,store)) return;
      if (req.method === 'POST' && path === '/api/auth/password') {
        limiter.hit('password:'+owner,5,60000);
        const input = passwordChange(await body(req));
        const current = await store.getUser(owner);
        const stored = current ? await store.findUserByEmail(current.email) : null;
        if (!stored || !await verifyPassword(input.current_password,stored.password_hash)) throw new HttpError(401,'현재 비밀번호를 확인해 주세요.','invalid_credentials');
        const nextToken = await store.changePassword(owner,stored.password_hash,await passwordHash(input.new_password));
        res.setHeader('Set-Cookie',cookie(nextToken,settings.cookieSecure,false,settings.cookieSameSite));
        json(res,200,{user:current,token:nextToken,token_type:'bearer'}); return;
      }
      if(req.method==='GET' && path==='/api/auth/me') {json(res,200,{user:await store.getUser(owner)});return;}
      if(req.method==='POST' && path==='/api/auth/logout') {await body(req);await store.revokeSession(token);res.setHeader('Set-Cookie',cookie('',settings.cookieSecure,true,settings.cookieSameSite));json(res,200,{logged_out:true});return;}
      if (req.method === 'GET' && path === '/api/questions') { json(res,200,{questions:QUESTIONS,scored_scale:false}); return; }
      if (path === '/api/projects') {
        if (req.method === 'GET') {
          const page = pagination(requestUrl,50,100), cursor = page.cursor ? decodeCursor(page.cursor,'projects',owner) : null;
          if (cursor && (typeof cursor.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(cursor.updated_at) || !Number.isFinite(Date.parse(cursor.updated_at)) || typeof cursor.id !== 'string' || !UUID.test(cursor.id))) throw new HttpError(422,'페이지 커서를 확인해 주세요.','invalid_cursor');
          if (cursor) {
            const date = (cursor.updated_at as string).slice(0,10), [year,month,day] = date.split('-').map(Number);
            if (new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10)!==date) throw new HttpError(422,'페이지 커서를 확인해 주세요.','invalid_cursor');
          }
          const result = await store.listPage(owner,page.limit,cursor ? {updated_at:cursor.updated_at as string,id:cursor.id as string} : undefined);
          json(res,200,{projects:result.projects.map(publicProject),next_cursor:result.next ? encodeCursor('projects',owner,result.next) : null}); return;
        }
        if (req.method === 'POST') {
          const input = await body(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>k!=='title') || (input.title!==undefined && (typeof input.title!=='string' || input.title.length>80))) throw new HttpError(422,'프로젝트 이름은 80자 이내 문자열이어야 합니다.');
          limiter.hit('projects:'+owner,30,60000);
          json(res,201,publicProject(await store.create(owner,input.title?.trim() || '새 도움 프로젝트'))); return;
        }
      }
      const match = /^\/api\/projects\/([^/]+)(\/messages)?$/.exec(path);
      if (match) {
        const id = match[1];
        const version = UUID.test(id) ? await store.pool.query('SELECT api_version FROM projects WHERE id=$1 AND owner=$2',[id,owner]) : null;
        if (version?.rows[0]?.api_version===2) throw new HttpError(409,'이 프로젝트는 /api/v2/projects에서 이용해 주세요.','v2_project');
        const project = await flow.owned(owner,id);
        if (!match[2] && req.method === 'GET') { json(res,200,publicProject(project)); return; }
        if (!match[2] && req.method === 'DELETE') { await flow.locked(id,async()=>{await flow.owned(owner,id);await store.delete(owner,id);}); json(res,200,{deleted:true}); return; }
        if (match[2] && req.method === 'GET') {
          const page = pagination(requestUrl,100,500), cursor = page.cursor ? decodeCursor(page.cursor,'messages',id) : null;
          if (cursor && (typeof cursor.before !== 'string' || !/^[1-9][0-9]{0,18}$/.test(cursor.before) || BigInt(cursor.before)>9223372036854775807n)) throw new HttpError(422,'페이지 커서를 확인해 주세요.','invalid_cursor');
          const result = await store.messagesPage(id,page.limit,cursor?.before as string | undefined);
          json(res,200,{messages:result.messages,next_cursor:result.next ? encodeCursor('messages',id,{before:result.next}) : null}); return;
        }
        if (match[2] && req.method === 'POST') {limiter.hit('messages:'+owner,30,60000); json(res,200,await flow.send(owner,id,messageBody(await body(req)))); return; }
      }
      throw new HttpError(404,'경로를 찾을 수 없습니다.','not_found');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if ((req.url || '').startsWith('/api/v2/')) {
        const v2 = error instanceof V2Error ? error : error instanceof HttpError ? new V2Error(error.status,error.status===401?'UNAUTHENTICATED':error.status===403?'ORIGIN_REJECTED':'INVALID_ANSWER',error.message) : new V2Error(503,'STORAGE_UNAVAILABLE','처리를 완료하지 못했습니다. 같은 요청 ID로 다시 확인해 주세요.');
        if(v2.status===429)res.setHeader('Retry-After','60');json(res,v2.status,v2.response());
      }
      else if (error instanceof ModelError) json(res,503,{detail:error.message,code:error.code,retryable:true,message_saved:false});
      else if (error instanceof Conflict) json(res,409,{detail:error.message,code:'conflict',message_saved:false});
      else if (error instanceof HttpError) {if(error.status===429) res.setHeader('Retry-After','60'); json(res,error.status,{detail:error.message,code:error.code,retryable:error.status===429 || error.code==='project_busy',message_saved:false});}
      else { console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError'); json(res,500,{detail:'서버 처리 오류입니다.',code:'internal_error',retryable:true,message_saved:null}); }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, store, settings, knowledge, flow, malssi };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp();
  app.server.listen(app.settings.port,app.settings.host,()=>console.log(`HOP backend: http://${app.settings.host}:${app.settings.port} | model=${app.settings.llmModel}`));
  let closing = false;
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
    if (closing) return; closing = true;
    const deadline = setTimeout(()=>{app.server.closeAllConnections();process.exit(1);},30000);
    deadline.unref();
    app.server.close(async()=>{
      try { await app.store.close(); clearTimeout(deadline); process.exit(0); }
      catch { process.exit(1); }
    });
  });
}
