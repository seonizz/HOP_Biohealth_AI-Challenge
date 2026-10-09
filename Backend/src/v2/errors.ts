import { randomUUID } from 'node:crypto';

export class V2Error extends Error {
  readonly status: number;
  readonly code: string;
  readonly revision?: number;
  constructor(status: number, code: string, message = '요청 내용을 확인해 주세요.', revision?: number) {
    super(message); this.status = status; this.code = code; this.revision = revision;
  }
  response() { return { error: { code: this.code, message: this.message, retryable: this.status >= 500 || this.status === 429, field_errors: [], request_id: null, trace_id: randomUUID() }, input_saved: false, run_id: null, current_revision: this.revision }; }
}
export function fail(code = 'INVALID_ANSWER', status = 422): never { throw new V2Error(status, code); }
export const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, any>;
};
export function keys(value: Record<string, any>, allowed: string[], required: string[] = []) {
  if (Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) fail();
}
export function text(value: unknown, max = 2000, min = 1): string {
  if (typeof value !== 'string') fail();
  const result = (value as string).normalize('NFC');
  if ([...result].length > max || [...result.trim()].length < min || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) fail();
  return result;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) fail();
  return value as string;
}
export function revision(expected: unknown, current: number) {
  if (!Number.isInteger(expected) || Number(expected) < 0) fail();
  if (expected !== current) throw new V2Error(409, 'REVISION_CONFLICT', '대화가 변경되었습니다. 최신 상태를 불러와 주세요.', current);
}
