import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type StepSummary = {
  name: string;
  ok: boolean;
  status: number | null;
  duration_ms: number;
  code?: string;
  counts?: Record<string, number | boolean>;
};
type ResponseData = { status: number; data: JsonRecord; duration_ms: number };
type MessagePayload = { request_id: string; text: string; skip: boolean; coach_now: boolean };
type EvidenceCounts = {
  answered_count: number;
  addressed_count: number;
  total_questions: number;
  missing_required_count: number;
  context_present: boolean;
  ready: boolean;
  profile_evidence_count: number;
  coaching_citation_count: number;
};
type RunSummary = {
  schema_version: number;
  started_at: string;
  finished_at: string | null;
  mode: "quick" | "full";
  status: "running" | "passed" | "failed";
  server_origin: string | null;
  isolated_project_created: boolean;
  stored_data: string;
  skipped_checks: string[];
  steps: StepSummary[];
  failure_code?: string;
};

class CheckFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const args = process.argv.slice(2);
const usage = [
  "실제 모델 연결 점검 — Node.js 24 이상",
  "  node scripts/live-check.ts              실행하지 않고 안내만 표시",
  "  node scripts/live-check.ts --run --quick 관계 입력 1회 실제 추출",
  "  node scripts/live-check.ts --run         최대 5회 인터뷰·코칭·중복 방지·접근 격리 점검",
  "환경: HOP_URL=http://127.0.0.1:9000, HOP_TIMEOUT_MS=330000",
  "인증: HOP_TEST_EMAIL과 HOP_TEST_PASSWORD로 기존 테스트 계정에 로그인",
  "가상 계정 등록: HOP_ALLOW_REGISTRATION=true와 HOP_TEST_INVITE_CODE가 모두 있을 때만 허용",
  "다른 사용자 격리: 등록 허용 또는 HOP_OTHER_TEST_EMAIL과 HOP_OTHER_TEST_PASSWORD 필요",
  "선택: --output=<요약 JSON 경로>",
  "--run은 테스트 계정에 로그인하고 '실제 모델 연결 점검' 프로젝트를 만들어 가상 사례를 전송합니다.",
  "요약에는 토큰, 프로젝트 ID, 입력 원문, 모델 응답 원문을 저장하지 않습니다."
].join("\n");

const unknown = args.filter((arg) => !["--run", "--quick", "--help"].includes(arg) && !arg.startsWith("--output="));
if (unknown.length || args.filter((arg) => arg.startsWith("--output=")).length > 1) {
  console.error("지원하지 않거나 중복된 실행 옵션입니다.\n" + usage);
  process.exitCode = 2;
} else if (args.includes("--help") || !args.includes("--run")) {
  console.log(usage + "\n\n실행하지 않았습니다. 서버 요청과 파일 저장을 수행하지 않았습니다.");
} else {
  await run();
}

async function run(): Promise<void> {
  const quick = args.includes("--quick");
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const defaultOutput = fileURLToPath(new URL("../artifacts/live-check-summary.json", import.meta.url));
  const outputPath = outputArg ? resolve(outputArg.slice("--output=".length)) : defaultOutput;
  const summary: RunSummary = {
    schema_version: 1,
    started_at: new Date().toISOString(),
    finished_at: null,
    mode: quick ? "quick" : "full",
    status: "running",
    server_origin: null,
    isolated_project_created: false,
    stored_data: "상태, HTTP 코드, 소요 시간, 인터뷰 문항 수, 구조화 근거 수만 저장합니다.",
    skipped_checks: [],
    steps: []
  };
  let base: URL;
  let timeoutMs: number;

  function record(name: string, response: ResponseData | null, ok: boolean, extra: Partial<StepSummary> = {}): void {
    const step: StepSummary = { name, ok, status: response?.status ?? null, duration_ms: response?.duration_ms ?? 0, ...extra };
    summary.steps.push(step);
    console.log((ok ? "PASS" : "FAIL") + " " + name + " · HTTP " + (step.status ?? "없음") + " · " + step.duration_ms + "ms" + (step.code ? " · " + step.code : ""));
  }

  function must(condition: unknown, code: string): asserts condition {
    if (!condition) throw new CheckFailure(code);
  }

  async function request(name: string, path: string, options: { token?: string; body?: JsonRecord; method?: string; accepted?: number[] } = {}): Promise<ResponseData> {
    const url = new URL(path.replace(/^\//, ""), base);
    must(url.origin === base.origin, "cross_origin_request_blocked");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = "Bearer " + options.token;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();
    let response: ResponseData;
    try {
      const result = await fetch(url, {
        method: options.method || "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal, redirect: "error"
      });
      const raw: unknown = await result.json();
      response = { status: result.status, data: object(raw), duration_ms: Math.round(performance.now() - start) };
    } catch (error) {
      const code = error instanceof Error && error.name === "AbortError" ? "client_timeout" : error instanceof SyntaxError ? "invalid_json_response" : "network_request_failed";
      record(name, null, false, { code, duration_ms: Math.round(performance.now() - start) });
      throw new CheckFailure(code);
    } finally { clearTimeout(timer); }
    const accepted = options.accepted || [200, 201];
    const ok = accepted.includes(response.status);
    const code = safeCode(response.data.code);
    record(name, response, ok, code ? { code } : {});
    if (!ok) throw new CheckFailure(code || "unexpected_http_status");
    return response;
  }

  try {
    must(Number(process.versions.node.split(".")[0]) >= 24, "node_24_required");
    must(!outputArg || outputArg.slice("--output=".length).trim(), "empty_output_path");
    base = new URL(process.env.HOP_URL || "http://127.0.0.1:9000");
    must(["http:", "https:"].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash, "invalid_hop_url");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    summary.server_origin = base.origin;
    timeoutMs = Number(process.env.HOP_TIMEOUT_MS || "330000");
    must(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 600000, "invalid_timeout_ms");
    const allowRegistration = process.env.HOP_ALLOW_REGISTRATION === "true";
    const testEmail = process.env.HOP_TEST_EMAIL;
    const testPassword = process.env.HOP_TEST_PASSWORD;
    const testInvite = process.env.HOP_TEST_INVITE_CODE;
    must(Boolean(testEmail) === Boolean(testPassword), "incomplete_test_credentials");
    must(Boolean(testEmail && testPassword) || Boolean(allowRegistration && testInvite), "test_credentials_or_invited_registration_required");
    const otherEmail = process.env.HOP_OTHER_TEST_EMAIL;
    const otherPassword = process.env.HOP_OTHER_TEST_PASSWORD;
    must(Boolean(otherEmail) === Boolean(otherPassword), "incomplete_secondary_credentials");

    async function authenticate(label: string, email?: string, password?: string): Promise<string> {
      let response: ResponseData;
      if (email && password) {
        response = await request(label + "_login", "/api/auth/login", { method: "POST", body: { email, password } });
      } else {
        must(allowRegistration && testInvite, "test_registration_not_authorized");
        response = await request(label + "_register", "/api/auth/register", { method: "POST", body: {
          email: "hop-live-" + Date.now() + "-" + randomUUID().slice(0, 8) + "@example.invalid",
          password: "H0p!" + randomUUID() + randomUUID(),
          invite_code: testInvite
        } });
      }
      must(typeof response.data.token === "string" && response.data.token.length > 0, "login_token_missing");
      return response.data.token;
    }

    const health = await request("health", "/health");
    const ready = await request("model_readiness", "/ready");
    must(ready.data.ready === true, "real_model_not_ready");
    const configuredMode = ready.data.model_mode ?? health.data.model_mode;
    const configuredName = ready.data.model_name ?? health.data.model_name;
    must(typeof configuredMode === "string" && configuredMode.length > 0 && !/(mock|fake|stub|demo|fallback)/i.test(configuredMode), "non_real_model_mode");
    must(typeof configuredName === "string" && configuredName.trim().length > 0, "model_name_missing");
    record("real_model_configuration", null, true, { counts: { ready: true, knowledge_count: nonnegativeInteger(health.data.knowledge_count) } });

    const token = await authenticate("primary_account", testEmail, testPassword);
    await request("authenticated_account", "/api/auth/me", { token });
    const created = await request("create_isolated_project", "/api/projects", { method: "POST", token, body: { title: "실제 모델 연결 점검" } });
    const project = "project" in created.data ? object(created.data.project) : created.data;
    must(typeof project.id === "string" && project.id.length > 0, "project_id_missing");
    const projectPath = "/api/projects/" + encodeURIComponent(project.id);
    summary.isolated_project_created = true;
    await request("get_isolated_project", projectPath, { token });

    const fixtures: Record<string, string> = {
      "1": "저는 대상자의 누나입니다. 저와 동생은 모두 성인이고 함께 살며 매일 대화합니다.",
      "2": "동생은 최근 일이 부담스럽고 사람들과 이야기하는 것이 피곤하다고 직접 말했습니다. 제가 아는 진단이나 치료 정보는 없습니다.",
      "4": "제가 가장 걱정하는 것은 동생에게 계속 말을 걸면 부담을 더 줄 수 있다는 점입니다. 어제 동생은 지금 이야기하고 싶지 않다고 직접 말했고, 저는 질문을 멈췄습니다.",
      "15": "제가 원하는 도움은 동생의 상태를 단정하는 것이 아니라, 동생이 원할 때 이야기를 들어줄 수 있다고 짧게 전하는 표현입니다. 지금 이야기하고 싶지 않다는 동생의 의사를 존중하고 싶습니다.",
      "7": "도움이 되는 활동에 대해 동생이 직접 알려준 적이 있습니다. 평소 저와 조용히 산책하면 대화 부담이 덜하다고 말했습니다. 오늘도 동생이 원할 경우에만 같이 산책하자는 짧은 제안을 하고 싶습니다."
    };
    const order = ["1", "2", "4", "15", "7"];
    const sent = new Set<string>();
    let latest: JsonRecord = {};
    let lastPayload: MessagePayload | null = null;
    let lastReply: unknown;
    const turnLimit = quick ? 1 : 5;

    for (let turn = 0; turn < turnLimit; turn++) {
      const currentProject = object(latest.project);
      const currentReadiness = object(currentProject.readiness);
      const currentQuestion = object(latest.question);
      const nextQuestion = String(currentQuestion.id ?? currentProject.pending_question_id ?? "");
      const missing = Array.isArray(currentReadiness.missing_required_ids) ? currentReadiness.missing_required_ids.filter((id) => typeof id === "string" || typeof id === "number").map(String) : [];
      let questionId = order.find((id) => !sent.has(id)) || "7";
      if (turn > 0 && fixtures[nextQuestion] && !sent.has(nextQuestion)) questionId = nextQuestion;
      else if (turn > 0) questionId = missing.find((id) => fixtures[id] && !sent.has(id)) || questionId;
      const requestCoaching = !quick && turn >= 3 && currentReadiness.ready === true && !latest.coaching;
      const payload: MessagePayload = { request_id: randomUUID(), text: requestCoaching ? "" : fixtures[questionId], skip: false, coach_now: requestCoaching };
      if (!requestCoaching) sent.add(questionId);
      const response = await request("message_turn_" + (turn + 1), projectPath + "/messages", { token, method: "POST", body: payload });
      latest = response.data;
      lastPayload = payload;
      lastReply = latest.reply;
      must(typeof latest.reply === "string" && latest.reply.trim().length > 0, "reply_missing");
      must(typeof latest.model_mode === "string" && !/(mock|fake|stub|demo|fallback)/i.test(latest.model_mode), "non_real_response_mode");
      const updated = object(latest.project);
      must(updated.id === project.id, "response_project_mismatch");
      const readiness = object(updated.readiness);
      const counts = readinessCounts(readiness, updated.profile, latest.coaching);
      must(counts.answered_count <= counts.total_questions && counts.addressed_count <= counts.total_questions, "invalid_question_counts");
      must(counts.answered_count <= counts.addressed_count, "answered_count_exceeds_addressed_count");
      must(counts.total_questions === 17, "unexpected_question_total");
      must(counts.profile_evidence_count > 0, "profile_evidence_missing");
      record("turn_" + (turn + 1) + "_structured_evidence", response, true, { counts });
      if (quick) {
        must(readiness.ready === false && !latest.coaching, "relation_only_premature_coaching");
        must(counts.answered_count > 0, "relation_not_extracted");
        break;
      }
      if (turn >= 2 && readiness.ready === true && latest.coaching) break;
    }

    const messagesBefore = await request("saved_messages", projectPath + "/messages", { token });
    must(Array.isArray(messagesBefore.data.messages) && messagesBefore.data.messages.length > 0, "messages_not_saved");
    if (!quick) {
      const currentReadiness = object(object(latest.project).readiness);
      must(currentReadiness.ready === true, "insufficient_information_after_five_turns");
      const coaching = object(latest.coaching);
      must(Object.keys(coaching).length > 0, "coaching_missing");
      must(Array.isArray(coaching.citations), "coaching_citations_invalid");
      const sources = Array.isArray(latest.sources) ? latest.sources.map(object) : [];
      const sourceIds = new Set(sources.map(source => source.id));
      must(coaching.citations.every(id => typeof id === 'string' && sourceIds.has(id)), "coaching_citation_not_retrieved");
      const validation = object(latest.validation);
      must(validation.approved === true && validation.clinical_validation === false, "coaching_validation_missing");
      must(validation.cited_count === coaching.citations.length && validation.retrieved_count === sources.length, "grounding_counts_mismatch");
      must(validation.grounding === (coaching.citations.length ? 'retrieved_reference_used' : 'no_reference_used'), "grounding_status_mismatch");
      must(lastPayload, "replay_payload_missing");
      const replay = await request("idempotent_replay", projectPath + "/messages", { token, method: "POST", body: lastPayload });
      must(replay.data.reply === lastReply, "replay_reply_changed");
      const replayReadiness = object(object(replay.data.project).readiness);
      must(replayReadiness.answered_count === currentReadiness.answered_count && replayReadiness.addressed_count === currentReadiness.addressed_count, "replay_changed_question_counts");
      const messagesAfter = await request("messages_after_replay", projectPath + "/messages", { token });
      must(Array.isArray(messagesAfter.data.messages) && messagesAfter.data.messages.length === messagesBefore.data.messages.length, "replay_duplicated_messages");
      record("idempotency_invariant", null, true, { counts: { stored_message_count: messagesAfter.data.messages.length } });

      function assertDeniedBody(response: ResponseData): void {
        const keys = ["project", "messages", "profile", "reply", "content", "title"];
        must(!keys.some((key) => Object.hasOwn(response.data, key)), "denied_response_contains_project_data");
        const body = JSON.stringify(response.data);
        must(!body.includes("실제 모델 연결 점검") && !(typeof lastReply === "string" && lastReply.length > 10 && body.includes(lastReply)), "denied_response_leaks_content");
      }
      assertDeniedBody(await request("reject_unauthenticated_project_read", projectPath, { accepted: [401, 403, 404] }));
      assertDeniedBody(await request("reject_unauthenticated_message_read", projectPath + "/messages", { accepted: [401, 403, 404] }));
      if ((otherEmail && otherPassword) || (allowRegistration && testInvite)) {
        must(!testEmail || !otherEmail || testEmail.trim().toLowerCase() !== otherEmail.trim().toLowerCase(), "secondary_account_must_differ");
        const otherToken = await authenticate("secondary_account", otherEmail, otherPassword);
        must(otherToken !== token, "isolated_login_token_missing");
        assertDeniedBody(await request("reject_foreign_project_read", projectPath, { token: otherToken, accepted: [403, 404] }));
        assertDeniedBody(await request("reject_foreign_message_read", projectPath + "/messages", { token: otherToken, accepted: [403, 404] }));
        assertDeniedBody(await request("reject_foreign_message_write", projectPath + "/messages", { token: otherToken, method: "POST", accepted: [403, 404], body: { request_id: randomUUID(), text: "접근 격리 확인용 가상 입력입니다.", skip: false, coach_now: false } }));
      } else {
        summary.skipped_checks.push("cross_user_isolation_secondary_credentials_missing");
        console.log("SKIP 다른 사용자 격리 · 보조 테스트 계정이 설정되지 않았습니다.");
      }
    }
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.failure_code = error instanceof CheckFailure ? error.code : "live_check_internal_error";
    record("run_result", null, false, { code: summary.failure_code });
    process.exitCode = 1;
    console.error("점검 실패: " + summary.failure_code + ". 응답 원문과 토큰은 기록하지 않습니다.");
  } finally {
    summary.finished_at = new Date().toISOString();
    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      console.log("요약 저장: " + outputPath);
    } catch (_) {
      process.exitCode = 1;
      console.error("점검 요약 파일을 저장하지 못했습니다.");
    }
  }
}

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function evidenceCount(value: unknown): number {
  return Object.values(object(value)).filter((entry) => {
    const fact = object(entry);
    return typeof fact.evidence === "string" && fact.evidence.trim().length > 0 && typeof fact.message_id === "string" && fact.message_id.length > 0;
  }).length;
}

function readinessCounts(readiness: JsonRecord, profile: unknown, coachingValue: unknown): EvidenceCounts {
  const coaching = object(coachingValue);
  return {
    answered_count: nonnegativeInteger(readiness.answered_count),
    addressed_count: nonnegativeInteger(readiness.addressed_count),
    total_questions: nonnegativeInteger(readiness.total_questions),
    missing_required_count: Array.isArray(readiness.missing_required_ids) ? readiness.missing_required_ids.length : 0,
    context_present: readiness.context_present === true,
    ready: readiness.ready === true,
    profile_evidence_count: evidenceCount(profile),
    coaching_citation_count: Array.isArray(coaching.citations) ? coaching.citations.length : 0
  };
}
