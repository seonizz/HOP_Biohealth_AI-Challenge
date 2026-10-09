import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSettings } from '../backend/src/config.ts';
import { runRetention } from '../backend/scripts/malssi-retention.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' || !process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.writeHead(401, { 'Cache-Control': 'no-store' }); res.end(); return;
  }
  try {
    const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const publicOrigin = process.env.HOP_PUBLIC_ORIGIN || (domain ? `https://${domain}` : '');
    const result = await runRetention(getSettings({ publicOrigin, cookieSecure: true, migrateOnStart: false }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Retention task failed' }));
  }
}
