import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { fail } from './errors.ts';

export type Envelope = { encryption_version:1; key_id:string; nonce:string; ciphertext:string; tag:string };
export class ContentCipher {
  private readonly key: Buffer;
  readonly keyId: string;
  constructor(encoded: string, keyId = 'v1') {
    this.key = Buffer.from(encoded,'base64'); this.keyId = keyId;
    if (this.key.length !== 32 || this.key.toString('base64') !== encoded) throw new Error('HOP_CONTENT_KEY must be a base64 encoded 32-byte independent key');
  }
  seal(value: unknown, scope: string): Envelope {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,nonce);
    cipher.setAAD(Buffer.from(scope));
    return {encryption_version:1,key_id:this.keyId,nonce:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  }
  open<T = any>(value: Envelope, scope: string): T {
    if (value.key_id !== this.keyId || value.encryption_version !== 1) throw new Error('CONTENT_KEY_UNAVAILABLE');
    const cipher = createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.nonce,'base64'));
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(Buffer.from(value.tag,'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext,'base64')),cipher.final()]).toString('utf8'));
  }
}
export function canonical(value: any, key = ''): any {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) { const result = value.map(v => canonical(v)); return ['option_ids','purposes','accepted_memory_ids'].includes(key) ? result.sort() : result; }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k],k)]));
  return value;
}
export const inputHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function evidence(text: string, quote: string, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || [...text].slice(start,end).join('') !== quote) fail('INVALID_MODEL_OUTPUT');
}
