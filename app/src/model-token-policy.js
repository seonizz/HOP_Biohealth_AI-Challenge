const unavailable = () => new Error('model_token_policy_unavailable');
const invalid = () => new Error('model_token_policy_invalid');
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

// Custom model servers advertise their supported budgets here. Servers such as
// Ollama may have no health policy; their own generation defaults still apply.
export async function discoverModelTokenPolicy({ baseUrl, apiKey, model, signal, fetchImpl }) {
  let url;
  try {
    url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '') + '/healthz';
  } catch { throw unavailable(); }
  if (signal?.aborted) throw unavailable();

  let response;
  try {
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET', headers: { Authorization: 'Bearer ' + apiKey }, signal, redirect: 'error',
      });
    } catch { throw unavailable(); }
    if (signal?.aborted) throw unavailable();
    if ([404, 405].includes(response?.status)) return null;
    if (!response?.ok) throw unavailable();

    let metadata;
    try { metadata = await response.json(); }
    catch (error) { throw error instanceof SyntaxError ? invalid() : unavailable(); }
    if (signal?.aborted) throw unavailable();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.model !== model) return null;
    if (!Object.hasOwn(metadata, 'max_output_tokens') && !Object.hasOwn(metadata, 'max_context_tokens')) return null;
    const output = metadata.max_output_tokens, context = metadata.max_context_tokens;
    if (!positiveInteger(output) || !positiveInteger(context) || output >= context) throw invalid();
    const input = metadata.max_input_tokens;
    return {
      maxOutputTokens: output, maxContextTokens: context,
      ...(positiveInteger(input) && input <= context ? { maxInputTokens: input } : {}),
      // Only servers that reject stale revisions before dispatch may advertise
      // this contract. Readiness itself is never cached.
      ...(typeof metadata.token_policy_revision === 'string' && /^[a-f0-9]{64}$/u.test(metadata.token_policy_revision)
        ? { revision: metadata.token_policy_revision } : {}),
    };
  } finally {
    // Release unsupported/error responses without reading or retaining details.
    try { if (response?.body && !response.bodyUsed) await response.body.cancel(); } catch { /* Already closed or aborted. */ }
  }
}
