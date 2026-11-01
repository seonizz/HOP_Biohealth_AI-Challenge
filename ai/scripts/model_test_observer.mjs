import { randomUUID } from 'node:crypto';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
const elapsed = started => Math.max(0, performance.now() - started);

function requestMetadata(input, options) {
  let method = 'UNKNOWN', route = 'other';
  try {
    const candidate = options?.method ?? (input instanceof Request ? input.method : 'GET');
    if (typeof candidate === 'string' && methods.has(candidate.toUpperCase())) method = candidate.toUpperCase();
    const value = typeof input === 'string' || input instanceof URL ? input : input instanceof Request ? input.url : null;
    if (value !== null) {
      const path = new URL(value).pathname.replace(/\/+$/u, '');
      if (/\/chat\/completions$/u.test(path)) route = 'chat_completions';
      else if (/\/(?:healthz|models(?:\/[^/]+)?|api\/(?:show|tags|ps))$/u.test(path)) route = 'model_discovery';
    }
  } catch { /* Metadata must not change how the original transport handles input. */ }
  return {method, route};
}

function responseStatus(response) {
  try {
    const value = response?.status;
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  } catch { return null; }
}

// Observe the real transport boundary without prescribing stages, retry ceilings,
// call counts or scheduling. A fetch resolves at headers, so this deliberately
// measures outstanding requests until headers, never full inference concurrency.
export function observeGateway(gateway) {
  const httpCalls = [], visited = new WeakSet(), started = performance.now();
  let outstanding = 0, peak = 0;
  function attach(target, role) {
    if (!target || typeof target !== 'object' || visited.has(target)) return;
    visited.add(target);
    if (typeof target.fetchImpl === 'function') {
      const original = target.fetchImpl;
      target.fetchImpl = function (...args) {
        const row = {id:randomUUID(), role, ...requestMetadata(args[0], args[1]),
          start_ms:elapsed(started), end_ms:null, duration_ms:null, status:null, outcome:'pending', error:null};
        httpCalls.push(row);
        peak = Math.max(peak, ++outstanding);
        const finish = (response, failed) => {
          row.end_ms = elapsed(started);
          row.duration_ms = Math.max(0, row.end_ms - row.start_ms);
          row.status = failed ? null : responseStatus(response);
          row.outcome = failed ? 'transport_error' : 'headers_received';
          row.error = failed ? 'TRANSPORT_ERROR' : null;
          outstanding--;
        };
        let result;
        try { result = Reflect.apply(original, this, args); }
        catch (error) { finish(null, true); throw error; }
        // Preserve synchronous transports too; real app transports are promises.
        if (!result || typeof result.then !== 'function') { finish(result, false); return result; }
        return result.then(response => { finish(response, false); return response; }, error => {
          finish(null, true); throw error;
        });
      };
    }
    attach(target.reviewGateway, 'reviewer');
  }
  attach(gateway, 'writer');
  return {
    httpCalls,
    snapshot() {
      const byRole = {}, byRoute = {};
      for (const row of httpCalls) {
        byRole[row.role] = (byRole[row.role] || 0) + 1;
        byRoute[row.route] = (byRoute[row.route] || 0) + 1;
      }
      return {
        scope:'observed_fetch_invocations_until_headers',
        total:httpCalls.length,
        headers_received:httpCalls.filter(row => row.outcome === 'headers_received').length,
        transport_errors:httpCalls.filter(row => row.outcome === 'transport_error').length,
        http_error_responses:httpCalls.filter(row => row.status >= 400).length,
        unknown_status_responses:httpCalls.filter(row => row.outcome === 'headers_received' && row.status === null).length,
        pending:outstanding, peak_outstanding_until_headers:peak,
        by_role:byRole, by_route:byRoute,
        response_bodies_observed:false, inference_concurrency_verified:false,
      };
    },
  };
}
