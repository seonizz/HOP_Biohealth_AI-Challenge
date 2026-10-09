import test from "node:test";
import assert from "node:assert/strict";
import { ModelGateway, ModelError } from "../src/llm.ts";
import type { GatewaySettings } from "../src/llm.ts";

const settings = (overrides: Partial<GatewaySettings> = {}): GatewaySettings => ({ llmBaseUrl: "http://127.0.0.1:11434", llmModel: "local-model", llmTimeoutMs: 500, maxConcurrentModelRequests: 1, ...overrides });
const extraction = () => ({ answers: [{ question_id: 1, value: "친구 관계", status: "answered", source: "observation", evidence: "친구" }], domains: [], safety_flag: false });
const coaching = () => ({ reply: "먼저 이야기해도 괜찮은지 물어보세요.", suggested_words: ["이야기해도 괜찮을까요?"], actions: [], avoid: [], citations: [] as string[] });
const response = (value: unknown, backend = "ollama", extra: object = {}) => {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return Response.json(backend === "ollama" ? { message: { content }, done: true, done_reason: "stop", ...extra } : { choices: [{ message: { content }, finish_reason: "stop", ...extra }] });
};
const gateway = (value: unknown, options: Partial<GatewaySettings> = {}) => new ModelGateway(settings(options), async () => response(value, options.llmBackend));
const fails = (promise: Promise<unknown>, code = "invalid_output") => assert.rejects(promise, (error: unknown) => error instanceof ModelError && error.code === code);

test("Ollama uses configured endpoint, strict JSON schema, no thinking, and no cloud key", async () => {
  let captured: any;
  const model = new ModelGateway(settings(), async (url, init) => {
    captured = { url, init, body: JSON.parse(String(init?.body)) };
    return response(extraction());
  });
  assert.deepEqual(await model.extract({ current_message: "친구가 연락을 피합니다." }), extraction());
  assert.equal(captured.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.format.additionalProperties, false);
  assert.equal(captured.body.format.properties.answers.items.properties.question_id.maximum, 17);
  assert.equal(captured.body.keep_alive, "5m");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.Authorization, undefined);
});

test("OpenAI-compatible endpoint remains supported without SDK", async () => {
  let captured: any;
  const model = new ModelGateway(settings({ llmBackend: "openai", llmBaseUrl: "http://127.0.0.1:8001/v1" }), async (url, init) => {
    captured = { url, body: JSON.parse(String(init?.body)) };
    return response(coaching(), "openai");
  });
  assert.deepEqual(await model.coach({}), coaching());
  assert.equal(captured.url, "http://127.0.0.1:8001/v1/chat/completions");
  assert.equal(captured.body.response_format.type, "json_schema");
  assert.equal(captured.body.response_format.json_schema.name, "hop_coach");
  assert.equal(captured.body.response_format.json_schema.strict, true);
  assert.equal(captured.body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(captured.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(captured.body.stream, false);
});

test("plain JSON compatibility mode is explicit and still validates locally", async () => {
  let captured: any;
  const model = new ModelGateway(settings({ llmBackend: "openai", structuredOutputs: "json_object" }), async (_, init) => {
    captured = JSON.parse(String(init?.body));
    return response(coaching(), "openai");
  });
  assert.deepEqual(await model.coach({}), coaching());
  assert.deepEqual(captured.response_format, { type: "json_object" });
});

test("one current message can answer multiple questions", async () => {
  const data = extraction();
  data.answers.push({ question_id: 2, value: "연락을 피함", status: "answered", source: "observation", evidence: "연락을 피합니다" });
  assert.equal((await gateway(data).extract({ current_message: "친구가 연락을 피합니다" })).answers.length, 2);
});

for (const [name, mutate] of [
  ["string question id", (data: any) => { data.answers[0].question_id = "1"; }],
  ["out-of-range question id", (data: any) => { data.answers[0].question_id = 18; }],
  ["extra severity key", (data: any) => { data.severity = 90; }],
  ["string boolean", (data: any) => { data.safety_flag = "false"; }],
  ["invalid source", (data: any) => { data.answers[0].source = "diagnosis"; }],
  ["invalid status", (data: any) => { data.answers[0].status = "diagnosed"; }],
  ["duplicate question", (data: any) => { data.answers.push(data.answers[0]); }],
  ["invalid domain", (data: any) => { data.domains = [{ label: "diagnosed_depression", evidence: "친구" }]; }],
  ["blank answer", (data: any) => { data.answers[0].value = " "; }],
] as const) {
  test(`strict extraction rejects ${name}`, async () => {
    const data = extraction(); mutate(data);
    await fails(gateway(data).extract({ current_message: "친구" }));
  });
}

test("evidence must be exact text in current message, not prior history", async () => {
  await fails(gateway(extraction()).extract({ current_message: "모르겠습니다", recent_messages: [{ content: "친구" }] }), "ungrounded_output");
  await fails(gateway({ answers: [], domains: [{ label: "anxiety", evidence: "불안" }], safety_flag: false }).extract({ current_message: "친구" }), "ungrounded_output");
});

test("only retrieved citation IDs are allowed", async () => {
  const data = { ...coaching(), citations: ["case-1"] };
  assert.deepEqual((await gateway(data).coach({ knowledge: [{ id: "case-1", text: "fixture" }] })).citations, ["case-1"]);
  await fails(gateway(data).coach({ knowledge: [] }), "ungrounded_output");
  await fails(gateway({ ...data, citations: ["case-1", "case-1"] }).coach({ knowledge: [{ id: "case-1" }] }));
});

for (const content of ["not JSON", "[]", "<think>unfinished", '{"reply":"<think>secret</think>"}', '{"reply":"first","reply":"second"}', '{"reply":1e999}', 'prefix {} suffix', '{"reply":"\\u003cthink\\u003esecret\\u003c/think\\u003e"}'.replaceAll("\\\\", "\\")]) {
  test(`rejects malformed or unsafe JSON: ${content.slice(0, 35)}`, async () => {
    await fails(gateway(content).coach({}));
  });
}

test("complete reasoning prefix is discarded without exposing it", async () => {
  const data = `<think>PRIVATE REASONING</think>\n\`\`\`json\n${JSON.stringify(coaching())}\n\`\`\``;
  assert.deepEqual(await gateway(data).coach({}), coaching());
});

test("encoded reasoning and duplicate keys are rejected even in otherwise valid coaching", async () => {
  const tagged = JSON.stringify({ ...coaching(), reply: "<think>secret</think>" }).replaceAll("<", "\\u003c");
  await fails(gateway(tagged).coach({}));
  const duplicate = JSON.stringify(coaching()).replace('"reply":', '"reply":"first","reply":');
  await fails(gateway(duplicate).coach({}));
});

test("Ollama and OpenAI truncated output never becomes a successful response", async () => {
  const ollama = new ModelGateway(settings(), async () => response(coaching(), "ollama", { done_reason: "length" }));
  const openai = new ModelGateway(settings({ llmBackend: "openai" }), async () => response(coaching(), "openai", { finish_reason: "length" }));
  await fails(ollama.coach({})); await fails(openai.coach({}));
});

test("redirects, server errors, and invalid envelopes do not fall back to mock", async () => {
  let count = 0;
  const model = new ModelGateway(settings({ llmApiKey: "test-secret" }), async () => { count++; return new Response(null, { status: 307, headers: { Location: "https://unrelated.invalid" } }); });
  await fails(model.coach({}), "redirect"); assert.equal(count, 1);
  await fails(new ModelGateway(settings(), async () => new Response("PRIVATE", { status: 503 })).coach({}), "http_error");
  await fails(new ModelGateway(settings(), async () => new Response("not JSON")).coach({}));
  await fails(new ModelGateway(settings(), async () => Response.json({ message: { content: "{}" } })).coach({}));
  await assert.rejects(new ModelGateway(settings(), async () => { throw new Error("secret url details"); }).coach({}), (error: unknown) => error instanceof ModelError && !error.message.includes("secret"));
});

test("deadline cancels even an injected fetch that ignores abort", async () => {
  const model = new ModelGateway(settings({ llmTimeoutMs: 15 }), async () => new Promise<Response>(() => {}));
  await fails(model.coach({}), "timeout");
});

test("deadline includes queue wait and expired requests never reach fetch", async () => {
  let count = 0;
  const model = new ModelGateway(settings({ llmTimeoutMs: 20 }), async () => { count++; return new Promise<Response>(() => {}); });
  const first = model.coach({});
  // The first request has a longer configured deadline already captured.
  model.settings.llmTimeoutMs = 5;
  const second = model.coach({});
  await fails(second, "timeout");
  assert.equal(count, 1);
  await fails(first, "timeout");
});

test("body-reading has the same total deadline", async () => {
  const fake = { status: 200, ok: true, text: () => new Promise<string>(() => {}) } as Response;
  await fails(new ModelGateway(settings({ llmTimeoutMs: 10 }), async () => fake).coach({}), "timeout");
});

test("a timed-out request releases its slot for later requests", async () => {
  let calls = 0;
  const model = new ModelGateway(settings({ llmTimeoutMs: 10 }), async () => {
    calls++;
    return calls === 1 ? new Promise<Response>(() => {}) : response(coaching());
  });
  await fails(model.coach({}), "timeout");
  assert.deepEqual(await model.coach({}), coaching());
  assert.equal(calls, 2);
});

test("concurrent calls obey the configured limit", async () => {
  let active = 0; let peak = 0;
  const model = new ModelGateway(settings(), async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return response(coaching());
  });
  await Promise.all([model.coach({}), model.coach({}), model.coach({})]);
  assert.equal(peak, 1);
});

test("title uses separate CPU model, 64-token cap, and separate endpoint", async () => {
  let captured: any;
  const model = new ModelGateway(settings({ titleBaseUrl: "http://127.0.0.1:11435", titleModel: "tiny-title" }), async (url, init) => { captured = { url, body: JSON.parse(String(init?.body)) }; return response({ title: "친구와 대화 준비" }); });
  assert.equal(await model.title({ current_message: "친구를 돕고 싶어요" }), "친구와 대화 준비");
  assert.equal(captured.url, "http://127.0.0.1:11435/api/chat");
  assert.equal(captured.body.model, "tiny-title");
  assert.equal(captured.body.options.num_gpu, 0);
  assert.equal(captured.body.options.num_predict, 64);
  await fails(gateway({ title: "친구\n대화" }).title({}));
});

test("llama.cpp CPU title endpoint receives the title schema and model alias", async () => {
  let captured: any;
  const model = new ModelGateway(settings({ llmBackend: "openai", titleBaseUrl: "http://127.0.0.1:8002/v1", titleModel: "hop-title" }), async (url, init) => {
    captured = { url, body: JSON.parse(String(init?.body)) };
    return response({ title: "친구와 대화 준비" }, "openai");
  });
  assert.equal(await model.title({}), "친구와 대화 준비");
  assert.equal(captured.url, "http://127.0.0.1:8002/v1/chat/completions");
  assert.equal(captured.body.model, "hop-title");
  assert.equal(captured.body.max_tokens, 64);
  assert.equal(captured.body.response_format.json_schema.name, "hop_title");
  assert.deepEqual(captured.body.response_format.json_schema.schema.required, ["title"]);
});

test("a separate CPU title endpoint can answer while the main GPU model is busy", async () => {
  let finishMain: ((value: Response) => void) | undefined;
  const model = new ModelGateway(settings({ llmBackend: "openai", titleBaseUrl: "http://127.0.0.1:8002/v1", titleModel: "hop-title" }), async (_, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === "hop-title") return response({ title: "친구와 대화 준비" }, "openai");
    return new Promise<Response>((resolve) => { finishMain = resolve; });
  });
  const main = model.coach({});
  assert.equal(await model.title({}), "친구와 대화 준비");
  assert.equal(typeof finishMain, "function");
  finishMain!(response(coaching(), "openai"));
  assert.deepEqual(await main, coaching());
});

test("title has a bounded three-second deadline even with a long model timeout", async () => {
  const start = Date.now();
  const model = new ModelGateway(settings({ llmTimeoutMs: 100000 }), async () => new Promise<Response>(() => {}));
  await fails(model.title({}), "timeout");
  assert.ok(Date.now() - start < 4500);
});

for (const [verdict, valid] of [
  [{ approved: true, issues: [] }, true],
  [{ approved: false, issues: ["근거 없는 사실을 제거해 주세요."] }, true],
  [{ approved: true, issues: ["문제"] }, false],
  [{ approved: false, issues: [] }, false],
  [{ approved: "true", issues: [] }, false],
] as const) {
  test(`verification verdict ${JSON.stringify(verdict)}`, async () => {
    if (valid) assert.deepEqual(await gateway(verdict).verify({ draft: coaching() }), verdict);
    else await fails(gateway(verdict).verify({ draft: coaching() }));
  });
}

test("explicit mock is synthetic and never infers diagnoses", async () => {
  const model = new ModelGateway(settings({ modelMode: "mock" }), async () => { throw new Error("must not call fetch"); });
  const result = await model.extract({ current_message: "친구가 연락을 피합니다. 어떤 말을 하면 좋을까요?" });
  assert.deepEqual(result.answers.map((item) => item.question_id), [1, 2, 15]);
  assert.deepEqual(result.domains, []);
  assert.match((await model.coach({})).reply, /합성 테스트/);
  assert.deepEqual((await model.extract({ current_message: "네" })).answers, []);
  const unknown = await model.extract({ current_message: "모르겠습니다", pending_question_id: 5 });
  assert.equal(unknown.answers[0].status, "unknown");
  assert.equal(unknown.answers[0].source, "unknown");
});


test('unknown answer status and source must agree', async () => {
  const unknown = extraction();
  unknown.answers[0] = { ...unknown.answers[0], status: 'unknown' as any, source: 'unknown' as any };
  assert.equal((await gateway(unknown).extract({ current_message: '친구' })).answers[0].status, 'unknown');
  await fails(gateway({ ...unknown, answers: [{ ...unknown.answers[0], source: 'observation' }] }).extract({ current_message: '친구' }));
  await fails(gateway({ ...unknown, answers: [{ ...unknown.answers[0], status: 'answered' }] }).extract({ current_message: '친구' }));
});
test('oversized model envelopes stop reading and cancel the source', async () => {
  let canceled = false, chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(65_536)); },
    cancel() { canceled = true; },
  });
  await fails(new ModelGateway(settings(), async () => new Response(body)).coach({}));
  assert.equal(canceled, true);
  assert.ok(chunks <= 19);
});
test('declared oversized model envelope is rejected before reading', async () => {
  await fails(new ModelGateway(settings(), async () => new Response('{}', { headers: { 'Content-Length': '2000000' } })).coach({}));
});
test('parent turn deadline aborts a pending model call and releases its slot', async () => {
  let calls = 0;
  const model = new ModelGateway(settings(), async () => ++calls === 1 ? new Promise<Response>(() => {}) : response(coaching()));
  const controller = new AbortController();
  const pending = model.coach({}, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await fails(pending, 'timeout');
  assert.deepEqual(await model.coach({}), coaching());
  assert.equal(calls, 2);
});
test('already expired parent deadline never invokes the model', async () => {
  let calls = 0;
  const model = new ModelGateway(settings(), async () => { calls++; return response(coaching()); });
  await fails(model.coach({}, AbortSignal.abort()), 'timeout');
  assert.equal(calls, 0);
});


import { Flow, HttpError, MAX_TURN_MS } from '../src/flow.ts';
function isolatedFlow() {
  const id = '11111111-1111-4111-8111-111111111111';
  let project = { id, title: '새 도움 프로젝트', status: 'interviewing', profile: {}, domains: [], pending_question_id: 1, revision: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  let saved = 0;
  const store = { get: async () => structuredClone(project), messages: async () => [], cached: async () => null,
    saveTurn: async (_owner: string, _revision: number, update: typeof project) => { project = structuredClone(update); saved++; } };
  const methods = { extract: async (_context: any, _signal?: AbortSignal) => ({ answers: [], domains: [], safety_flag: false }),
    coach: async (_context: any, _signal?: AbortSignal) => coaching(), verify: async (_context: any, _signal?: AbortSignal) => ({ approved: true, issues: [] }),
    title: async (_context: any, _signal?: AbortSignal) => '친구와 대화 준비' };
  const flow = new Flow(store as any, methods as any, { search: () => [] } as any, { modelMode: 'local', titleBaseUrl: 'http://127.0.0.1:8002/v1', titleModel: 'title' } as any);
  return { flow, methods, id, saved: () => saved, project: () => structuredClone(project) };
}
test('in-flight identical requests reuse one result; different requests are immediately busy', async () => {
  const { flow } = isolatedFlow();
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = async () => { calls++; await gate; return { result: 'same' }; };
  const pending = flow.locked('project', operation, { id: 'request', digest: 'same' });
  const duplicate = flow.locked('project', operation, { id: 'request', digest: 'same' });
  await assert.rejects(flow.locked('project', operation, { id: 'next-request', digest: 'next' }), (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === 'project_busy');
  await assert.rejects(flow.locked('project', operation, { id: 'request', digest: 'changed' }), (error: unknown) => error instanceof HttpError && error.code === 'request_id_conflict');
  await assert.rejects(flow.locked('project', operation), (error: unknown) => error instanceof HttpError && error.code === 'project_busy');
  assert.equal(calls, 1);
  release();
  assert.strictEqual(await pending, await duplicate);
  assert.equal(flow.locks.size, 0);
});
test('failed in-flight operation releases the project for a new request', async () => {
  const { flow } = isolatedFlow();
  await assert.rejects(flow.locked('project', async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(await flow.locked('project', async () => 'recovered'), 'recovered');
  assert.equal(flow.locks.size, 0);
});
test('urgent safety response does not wait for extraction, coaching or project-title models', async () => {
  const f = isolatedFlow();
  for (const name of ['extract', 'coach', 'verify', 'title'] as const) (f.methods as any)[name] = async () => { throw new Error('model must not run'); };
  const result = await f.flow.send('owner', f.id, { request_id: '22222222-2222-4222-8222-222222222222', text: '동생이 지금 자살하려 한다고 말했습니다.', skip: false, coach_now: false });
  assert.equal(result.validation.method, 'safety_response');
  assert.equal(result.validation.safety_flag, true);
  assert.equal(result.question, null);
  assert.equal(result.coaching, null);
  assert.equal(f.saved(), 1);
});
test('coaching without retrieved citations explicitly records no reference use and keeps limited profile', async () => {
  const f = isolatedFlow();
  const seen: AbortSignal[] = [];
  for (const name of ['extract', 'coach', 'verify', 'title'] as const) {
    const original = f.methods[name];
    (f.methods as any)[name] = async (context: any, signal: AbortSignal) => { seen.push(signal); return original(context, signal); };
  }
  const result = await f.flow.send('owner', f.id, { request_id: '22222222-2222-4222-8222-222222222222', text: '친구를 돕는 말을 부탁드립니다.', skip: false, coach_now: true });
  assert.equal(result.validation.grounding, 'no_reference_used');
  assert.equal(result.validation.retrieved_count, 0);
  assert.equal(result.validation.cited_count, 0);
  assert.equal(result.validation.limited_profile, true);
  assert.equal(result.validation.clinical_validation, false);
  assert.equal(result.project.readiness.ready, false);
  assert.equal(new Set(seen).size, 1);
  assert.ok(seen[0] instanceof AbortSignal);
  assert.equal(MAX_TURN_MS, 300000);
});
