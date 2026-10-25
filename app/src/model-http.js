import http from 'node:http';
import https from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

// A narrow transport for model JSON POSTs and read-only capability GETs. The
// caller's AbortSignal owns the whole operation deadline, including body reads.
// Unlike fetch, redirects are returned to the caller, never followed: model
// credentials and conversation bodies must stay at the configured endpoint.
export async function modelHttpFetch(input, { method, headers, body, signal } = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Unsupported model endpoint');
  }
  if (!((method === 'POST' && typeof body === 'string') || (method === 'GET' && body === undefined))) {
    throw new TypeError('Expected a JSON POST or a bodyless GET');
  }
  signal?.throwIfAborted();
  const requestHeaders = new Headers(headers);
  const bytes = body === undefined ? undefined : Buffer.from(body);
  if (requestHeaders.has('content-length') && (!bytes || requestHeaders.get('content-length') !== String(bytes.length))) {
    throw new TypeError('Incorrect model request content length');
  }
  if (requestHeaders.has('transfer-encoding')) throw new TypeError('Unsupported model request transfer encoding');
  if (bytes) requestHeaders.set('content-length', String(bytes.length));
  // Avoid negotiating compression, but still accept standard compressed JSON.
  if (!requestHeaders.has('accept-encoding')) requestHeaders.set('accept-encoding', 'identity');

  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers: Object.fromEntries(requestHeaders), signal,
      // No pooled socket or implicit socket deadline can outlive this request.
      agent: false, timeout: 0,
    }, incoming => {
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const status = incoming.statusCode;
        const hasBody = ![204, 205, 304].includes(status);
        let responseBody = null;
        if (hasBody) {
          const decoders = [];
          const encodings = (responseHeaders.get('content-encoding') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          for (const encoding of encodings.reverse()) {
            if (encoding === 'gzip' || encoding === 'x-gzip') decoders.push(createGunzip());
            else if (encoding === 'deflate') decoders.push(createInflate());
            else if (encoding === 'br') decoders.push(createBrotliDecompress());
            else if (encoding !== 'identity') throw new TypeError('Unsupported model response encoding');
          }
          const readable = decoders.length ? pipeline(incoming, ...decoders, () => {}) : incoming;
          responseBody = Readable.toWeb(readable);
        } else {
          incoming.resume();
        }
        resolve(new Response(responseBody, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('socket', socket => socket.setTimeout(0));
    request.once('error', reject);
    request.end(bytes);
  });
}
