import type { AuthResponse, LoginRequest, RegisterRequest, PasswordChangeRequest, CurrentUser, Questions, Project, ProjectList, MessageList, MessageRequest, MessageResult } from './types.ts';
export type * from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly messageSaved: boolean | null;
  readonly retryAfterMs: number;
  readonly traceId: string | null;
  constructor(message: string, details: { status: number; code: string; retryable?: boolean; messageSaved?: boolean | null; retryAfterMs?: number; traceId?: string | null }) {
    super(message); this.name = 'ApiError'; this.status = details.status; this.code = details.code;
    this.retryable = details.retryable ?? false; this.messageSaved = details.messageSaved ?? null;
    this.retryAfterMs = details.retryAfterMs ?? 0; this.traceId = details.traceId ?? null;
  }
}
export type ClientOptions = {
  /** Empty means the current origin. Never include credentials or query parameters. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Omit for HttpOnly browser cookies. Tokens are never persisted by the client. */
  getToken?: () => string | null | Promise<string | null>;
  timeoutMs?: number;
  /** Only GET and idempotent sendMessage calls retry, using exactly the same body. */
  retries?: number;
};
export type RequestOptions = { signal?: AbortSignal };
export type PageOptions = RequestOptions & { limit?: number; cursor?: string };
/** Create once per user action; keep this object to retry an uncertain network result. */
export function createMessage(input: Omit<MessageRequest, 'request_id'>): MessageRequest {
  return { ...input, request_id: globalThis.crypto.randomUUID() };
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject)=>{
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = ()=>{ clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(()=>{ signal?.removeEventListener('abort',onAbort); resolve(); },ms);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}
function query(options: PageOptions): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit',String(options.limit));
  if (options.cursor !== undefined) params.set('cursor',options.cursor);
  return params.size ? '?' + params.toString() : '';
}
export class HopClient {
  private readonly options: ClientOptions;
  private readonly base: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(options: ClientOptions = {}) {
    this.options = options; this.base = (options.baseUrl ?? '').replace(/\/$/,'');
    if (this.base) {
      const url = new URL(this.base);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment');
    }
    if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2)) throw new Error('retries must be between 0 and 2');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) throw new Error('timeoutMs must be positive');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}, idempotent = false): Promise<T> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const attempts = method === 'GET' || idempotent ? (this.options.retries ?? 0) + 1 : 1;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 330000);
      const signal = options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
      try {
        const token = await this.options.getToken?.();
        const response = await this.fetcher(this.base + path, {
          method, signal, cache:'no-store', credentials:this.options.getToken ? 'omit' : 'include',
          headers:{ Accept:'application/json', ...(encoded !== undefined ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:'Bearer '+token} : {}) },
          ...(encoded === undefined ? {} : {body:encoded}),
        });
        let data: Record<string, unknown>;
        try {
          const value: unknown = await response.json();
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object response required');
          data = value as Record<string, unknown>;
        }
        catch { throw new ApiError('서버 응답 형식을 확인할 수 없습니다.',{status:response.status,code:'invalid_response',retryable:response.status>=500,traceId:response.headers.get('x-request-id')}); }
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : Math.max(0,Date.parse(retryAfter)-Date.now())) : 0;
          throw new ApiError(typeof data.detail === 'string' ? data.detail : '요청을 완료할 수 없습니다.', {
            status:response.status,code:typeof data.code === 'string' ? data.code : 'http_error',
            retryable:data.retryable === true || [429,502,503,504].includes(response.status),
            messageSaved:typeof data.message_saved === 'boolean' ? data.message_saved : null,
            retryAfterMs:Number.isFinite(delay) ? delay : 0,traceId:response.headers.get('x-request-id'),
          });
        }
        return data as T;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const failure = error instanceof ApiError ? error : new ApiError(timeout.aborted ? '응답 대기 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.' : '서버 연결을 확인해 주세요.',{status:0,code:timeout.aborted?'timeout':'network_error',retryable:true});
        if (attempt + 1 >= attempts || !failure.retryable || failure.retryAfterMs > 60000) throw failure;
        await pause(Math.max(failure.retryAfterMs,500 * 2 ** attempt),options.signal);
      }
    }
  }
  register(input: RegisterRequest, options?: RequestOptions) { return this.request<AuthResponse>('POST','/api/auth/register',input,options); }
  login(input: LoginRequest, options?: RequestOptions) { return this.request<AuthResponse>('POST','/api/auth/login',input,options); }
  me(options?: RequestOptions) { return this.request<CurrentUser>('GET','/api/auth/me',undefined,options); }
  logout(options?: RequestOptions) { return this.request<{logged_out:true}>('POST','/api/auth/logout',{},options); }
  changePassword(input: PasswordChangeRequest, options?: RequestOptions) { return this.request<AuthResponse>('POST','/api/auth/password',input,options); }
  questions(options?: RequestOptions) { return this.request<Questions>('GET','/api/questions',undefined,options); }
  projects(options: PageOptions = {}) { return this.request<ProjectList>('GET','/api/projects'+query(options),undefined,options); }
  project(id: string, options?: RequestOptions) { return this.request<Project>('GET','/api/projects/'+encodeURIComponent(id),undefined,options); }
  createProject(title?: string, options?: RequestOptions) { return this.request<Project>('POST','/api/projects',{...(title === undefined ? {} : {title})},options); }
  deleteProject(id: string, options?: RequestOptions) { return this.request<{deleted:true}>('DELETE','/api/projects/'+encodeURIComponent(id),undefined,options); }
  messages(id: string, options: PageOptions = {}) { return this.request<MessageList>('GET','/api/projects/'+encodeURIComponent(id)+'/messages'+query(options),undefined,options); }
  sendMessage(id: string, input: MessageRequest, options?: RequestOptions) { return this.request<MessageResult>('POST','/api/projects/'+encodeURIComponent(id)+'/messages',input,options,true); }
}
