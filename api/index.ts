import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../backend/src/server.ts';
import { getSettings } from '../backend/src/config.ts';

type Request = IncomingMessage & { url?: string };
let appPromise: ReturnType<typeof createApp> | undefined;

function application() {
  if (!appPromise) {
    const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const publicOrigin = process.env.HOP_PUBLIC_ORIGIN || (domain ? `https://${domain}` : '');
    if (!publicOrigin.startsWith('https://')) throw new Error('HOP_PUBLIC_ORIGIN must be an HTTPS origin');
    appPromise = createApp(getSettings({
      publicOrigin,
      cookieSecure: true,
      migrateOnStart: false,
      v2Enabled: true,
      v2AllowDraft: true,
      v2ModelEnabled: false,
      demoEnabled: true,
      allowRegistration: false,
    })).catch(error => { appPromise = undefined; throw error; });
  }
  return appPromise;
}

export default async function handler(req: Request, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost');
  const route = url.searchParams.get('__hop_path');
  if (!route || !/^(?:api\/(?:auth|v2)(?:\/|$)|health\/(?:live|ready|service)$|help\/safety$|openapi-v2\.json$)/.test(route) || route.includes('..')) {
    res.writeHead(404); res.end(); return;
  }
  url.searchParams.delete('__hop_path');
  req.url = `/${route}${url.search}`;
  try {
    const app = await application();
    await new Promise<void>(resolve => {
      const done = () => resolve();
      res.once('finish', done);
      res.once('close', done);
      app.server.emit('request', req, res);
    });
  } catch {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ detail: '서비스 연결을 확인해 주세요.', code: 'service_unavailable' }));
    }
  }
}
