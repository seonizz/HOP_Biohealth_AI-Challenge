import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError } from './flow.ts';

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve,reject)=>scrypt(password,salt,64,{N,r,p,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
const N = 32768, r = 8, p = 1;
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const result = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt}$${result.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const fields = encoded.split('$');
  if (fields.length !== 6 || fields[0] !== 'scrypt' || fields[1] !== String(N) || fields[2] !== String(r) || fields[3] !== String(p) || !/^[a-f0-9]{32}$/.test(fields[4]) || !/^[a-f0-9]{128}$/.test(fields[5])) return false;
  const result = await derive(password, fields[4]);
  return timingSafeEqual(result, Buffer.from(fields[5], 'hex'));
}
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function credentials(input: any, registration: boolean) {
  const keys = registration ? ['email','password','invite_code'] : ['email','password'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!keys.includes(k))) throw new HttpError(422,'로그인 입력 형식을 확인해 주세요.');
  if (typeof input.email !== 'string' || input.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new HttpError(422,'올바른 이메일을 입력해 주세요.');
  if (typeof input.password !== 'string' || input.password.length>128 || input.password.length<(registration?12:1)) throw new HttpError(422,registration?'비밀번호는 12~128자로 입력해 주세요.':'비밀번호를 입력해 주세요.');
  if (input.invite_code!==undefined && (typeof input.invite_code!=='string' || input.invite_code.length>200)) throw new HttpError(422,'초대 코드 형식을 확인해 주세요.');
  return {email:input.email.trim().toLowerCase(),password:input.password,invite_code:input.invite_code || ''};
}
export function cookie(token: string, secure: boolean, clear=false, sameSite = 'strict') {
  if (!['strict','lax','none'].includes(sameSite) || (sameSite === 'none' && !secure)) throw new Error('Invalid cookie configuration');
  return `hop_session=${clear?'':token}; Path=/; HttpOnly; SameSite=${sameSite[0].toUpperCase()+sameSite.slice(1)}; Max-Age=${clear?0:604800}${secure?'; Secure':''}`;
}
export function tokenFromHeaders(headers: Record<string, any>) {
  if (headers.authorization !== undefined) return typeof headers.authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(headers.authorization) ? headers.authorization.slice(7) : '';
  return String(headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('hop_session='))?.slice(12) || '';
}

/** Process-local limiter for the single deployed API instance. A shared limiter
 * is required before horizontal scaling; bounds prevent unbounded key growth. */
export class Limiter {
  entries = new Map<string,{count:number,until:number}>();
  hit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    if (this.entries.size>10000) for (const [k,v] of this.entries) if (v.until<now) this.entries.delete(k);
    if (this.entries.size>20000 && !this.entries.has(key)) throw new HttpError(429,'요청이 많습니다. 잠시 후 다시 시도해 주세요.','rate_limited');
    let row = this.entries.get(key);
    if (!row || row.until<=now) {row={count:0,until:now+windowMs};this.entries.set(key,row);}
    row.count++;
    if (row.count>limit) throw new HttpError(429,'요청이 많습니다. 잠시 후 다시 시도해 주세요.','rate_limited');
  }
}

export function passwordChange(input: unknown): { current_password: string; new_password: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['current_password','new_password'].includes(key))) throw new HttpError(422,'비밀번호 변경 입력 형식을 확인해 주세요.');
  const value = input as Record<string, unknown>;
  if (typeof value.current_password !== 'string' || value.current_password.length < 1 || value.current_password.length > 128 || typeof value.new_password !== 'string' || value.new_password.length < 12 || value.new_password.length > 128) throw new HttpError(422,'현재 비밀번호와 12~128자의 새 비밀번호를 입력해 주세요.');
  if (value.current_password === value.new_password) throw new HttpError(422,'현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.');
  return { current_password:value.current_password, new_password:value.new_password };
}
