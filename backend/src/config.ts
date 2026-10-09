import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function getSettings(overrides: Record<string, unknown> = {}) {
  const result = {
    host: process.env.HOP_HOST || '127.0.0.1',
    port: Number(process.env.HOP_PORT || 9000),
    databaseUrl: process.env.DATABASE_URL || process.env.HOP_DATABASE_URL || '',
    databaseSchema: process.env.HOP_DATABASE_SCHEMA || 'public',
    migrateOnStart: process.env.HOP_MIGRATE_ON_START !== 'false',
    v2Enabled: process.env.HOP_V2_ENABLED === 'true',
    v2AllowDraft: process.env.HOP_V2_ALLOW_DRAFT === 'true',
    v2ModelEnabled: process.env.HOP_V2_MODEL_ENABLED === 'true',
    dualEnabled: process.env.HOP_DUAL_ENABLED === 'true',
    contentKey: process.env.HOP_CONTENT_KEY || '',
    restorePending: process.env.HOP_RESTORE_PENDING === 'true',
    requireKnowledge: process.env.HOP_REQUIRE_KNOWLEDGE === 'true',
    knowledgePath: process.env.HOP_KNOWLEDGE || resolve(ROOT, 'data/knowledge.jsonl'),
    modelMode: process.env.HOP_MODEL_MODE || 'local',
    llmBackend: process.env.HOP_LLM_BACKEND || 'openai',
    llmBaseUrl: process.env.HOP_LLM_BASE_URL || 'http://127.0.0.1:8001/v1',
    llmModel: process.env.HOP_LLM_MODEL || 'qwen3.8-27b',
    llmApiKey: process.env.HOP_LLM_API_KEY || '',
    llmTimeoutMs: Number(process.env.HOP_LLM_TIMEOUT_MS || 180000),
    titleBaseUrl: process.env.HOP_TITLE_BASE_URL || '',
    titleModel: process.env.HOP_TITLE_MODEL || '',
    maxConcurrentModelRequests: 1,
    publicOrigin: process.env.HOP_PUBLIC_ORIGIN || 'http://127.0.0.1:9000',
    cookieSecure: process.env.HOP_COOKIE_SECURE === 'true',
    cookieSameSite: process.env.HOP_COOKIE_SAME_SITE || 'strict',
    allowRegistration: process.env.HOP_ALLOW_REGISTRATION === 'true',
    demoEnabled: process.env.HOP_DEMO_ENABLED === 'true',
    inviteCode: process.env.HOP_INVITE_CODE || '',
    trustedProxy: process.env.HOP_TRUST_PROXY === 'true',
    corsOrigins: (process.env.HOP_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    ...overrides,
  };
  if (!['local', 'mock'].includes(String(result.modelMode))) throw new Error('Invalid HOP_MODEL_MODE');
  if (!['ollama', 'openai'].includes(String(result.llmBackend))) throw new Error('Invalid HOP_LLM_BACKEND');
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Invalid HOP_PORT');
  if (!Number.isFinite(result.llmTimeoutMs) || result.llmTimeoutMs < 1) throw new Error('Invalid HOP_LLM_TIMEOUT_MS');
  if (typeof result.databaseUrl !== 'string' || !/^postgres(?:ql)?:\/\//.test(result.databaseUrl)) throw new Error('PostgreSQL DATABASE_URL is required');
  const validOrigin = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }
    catch { return false; }
  };
  if (!validOrigin(result.publicOrigin) || !Array.isArray(result.corsOrigins) || !result.corsOrigins.every(validOrigin)) throw new Error('HOP_PUBLIC_ORIGIN and HOP_CORS_ORIGINS must be exact HTTP(S) origins without paths');
  if (!['strict', 'lax', 'none'].includes(String(result.cookieSameSite))) throw new Error('Invalid HOP_COOKIE_SAME_SITE');
  if (result.cookieSameSite === 'none' && !result.cookieSecure) throw new Error('SameSite=None requires HOP_COOKIE_SECURE=true');
  if (String(result.publicOrigin).startsWith('https://') && !result.cookieSecure) throw new Error('HTTPS deployment requires HOP_COOKIE_SECURE=true');
  return result;
}
export type Settings = ReturnType<typeof getSettings>;
