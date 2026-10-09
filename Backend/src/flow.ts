import { randomUUID } from 'node:crypto';
import { Store, hash, timestamp } from './storage.ts';
import type { Project, Message } from './storage.ts';
import { QUESTIONS, readiness, nextQuestion } from './questions.ts';
import { ModelError } from './llm.ts';
import type { ModelGateway, Coaching } from './llm.ts';
import type { KnowledgeBase } from './knowledge.ts';
import type { Settings } from './config.ts';

export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, message: string, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
export const publicProject = (project: Project) => ({ ...project, readiness: readiness(project.profile) });
export const isUUID = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const MAX_TURN_MS = 300_000;
type Body = { request_id: string; text: string; skip: boolean; coach_now: boolean };
export function messageBody(raw: any): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['request_id','text','skip','coach_now'].includes(k))) throw new HttpError(422, '메시지 형식을 확인해 주세요.');
  if (!isUUID(raw.request_id)) throw new HttpError(422, 'request_id에는 UUID가 필요합니다.');
  if (raw.text !== undefined && typeof raw.text !== 'string') throw new HttpError(422, 'text는 문자열이어야 합니다.');
  if (['skip','coach_now'].some(k => raw[k] !== undefined && typeof raw[k] !== 'boolean')) throw new HttpError(422, '동작 설정은 boolean이어야 합니다.');
  const body = { request_id: raw.request_id, text: (raw.text || '').trim(), skip: raw.skip || false, coach_now: raw.coach_now || false };
  if (body.text.length > 8000 || (!body.text && !body.skip && !body.coach_now) || (body.skip && (body.text || body.coach_now))) throw new HttpError(422, '메시지 길이 또는 동작 조합을 확인해 주세요.');
  return body;
}
export function urgentSignal(text: string) {
  const normalized = text.replace(/\s/g, '');
  return ['지금자살','자살하려','자살할거','죽으려고','죽을거라고','목숨을끊','약을한꺼번에','약을많이먹었','뛰어내리려','칼을들고','죽이겠','의식이없'].some(p => normalized.includes(p));
}
export function deterministicIssues(coaching: Coaching) {
  // Forbidden phrases may legitimately appear as examples of what to avoid.
  // The semantic verifier still evaluates every field, including avoid.
  const text = [coaching.reply,...coaching.suggested_words,...coaching.actions].join(' ');
  const issues = [];
  if (/(우울|불안|중독|위험도|중증도|개선율|발병확률)[^\n.!?]{0,18}\d+(?:\.\d+)?\s*(?:점|%|퍼센트)/.test(text)) issues.push('근거 없는 임상 점수 또는 확률을 제거해 주세요.');
  if (/(우울증|불안장애|중독장애)(?:이|가)?\s*(?:확실|분명|맞습니다|입니다)/.test(text)) issues.push('확정 진단을 제거하고 관찰 내용으로 표현해 주세요.');
  return issues;
}

export class Flow {
  store!: Store; gateway!: ModelGateway; knowledge!: KnowledgeBase; settings!: Settings;
  locks = new Map<string, { promise: Promise<unknown>; request?: { id: string; digest: string } }>();
  constructor(store: Store, gateway: ModelGateway, knowledge: KnowledgeBase, settings: Settings) { Object.assign(this, {store,gateway,knowledge,settings}); }
  async owned(owner: string, id: string) {
    if (!isUUID(id)) throw new HttpError(422, '프로젝트 ID 형식을 확인해 주세요.');
    const project = await this.store.get(owner, id);
    if (!project) throw new HttpError(404, '프로젝트를 찾을 수 없습니다.');
    return project;
  }
  async locked<T>(id: string, operation: () => Promise<T>, request?: { id: string; digest: string }): Promise<T> {
    const active = this.locks.get(id);
    if (active) {
      if (request && active.request?.id === request.id) {
        if (active.request.digest !== request.digest) throw new HttpError(409, '동일한 request_id에 다른 내용을 보낼 수 없습니다.', 'request_id_conflict');
        return active.promise as Promise<T>;
      }
      throw new HttpError(409, '이 프로젝트의 이전 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.', 'project_busy');
    }
    const current = Promise.resolve().then(operation);
    const entry = { promise: current, request };
    this.locks.set(id, entry);
    try { return await current; }
    finally { if (this.locks.get(id) === entry) this.locks.delete(id); }
  }
  async send(owner: string, id: string, body: Body) {
    await this.owned(owner, id);
    const digest = hash(JSON.stringify(body));
    return this.locked(id, async () => {
      const signal = AbortSignal.timeout(MAX_TURN_MS);
      const project = await this.owned(owner, id), oldRevision = project.revision;
      const cached = await this.store.cached(id, body.request_id, digest);
      if (cached) return cached;
      const message: Message = { id: randomUUID(), role: 'user', content: body.text || (body.skip ? '[질문 건너뛰기]' : '[현재 정보로 코칭 요청]'), created_at: timestamp() };
      const prior = await this.store.messages(id, 6);
      const context: any = { questions: QUESTIONS, profile: this.compactProfile(project), current_message: body.text,
        pending_question_id: project.pending_question_id, project_title: project.title,
        recent_messages: prior.map(m => ({ role: m.role, content: m.content.slice(0, 700) })) };
      let danger = urgentSignal(body.text);
      if (body.skip) {
        const pending = project.pending_question_id;
        if (!pending) throw new HttpError(409, '건너뛸 질문이 없습니다.');
        project.profile[String(pending)] = { status: 'skipped', value: null, source: 'unknown', evidence: '', message_id: message.id, updated_at: timestamp() };
      } else if (body.text && !danger) {
        const extracted = await this.gateway.extract(context, signal);
        for (const answer of extracted.answers) {
          if (!answer.evidence.trim() || !body.text.includes(answer.evidence)) throw new ModelError('추출 정보의 발화 근거를 확인하지 못했습니다.', 'invalid_evidence');
          const previous = project.profile[String(answer.question_id)];
          const history = previous ? [...(previous.previous_reports || []),{status:previous.status,value:previous.value,source:previous.source,evidence:previous.evidence,message_id:previous.message_id,updated_at:previous.updated_at}].slice(-8) : [];
          project.profile[String(answer.question_id)] = { ...answer, message_id: message.id, updated_at: timestamp(), previous_reports: history };
        }
        // Topics remain explicitly tied to the current utterance, not diagnoses.
        // The durable profile preserves older facts and their source messages.
        project.domains = extracted.domains.map(d => ({ ...d, message_id: message.id, scope: 'conversation_topic_not_diagnosis' }));
        danger = extracted.safety_flag;
      }
      const available = readiness(project.profile);
      let question = nextQuestion(project.profile), coaching: Coaching | null = null;
      let validation: any = { approved: true, method: 'server_question_selection' };
      let sources: ReturnType<KnowledgeBase['search']> = [];
      let reply: string;
      if (danger) {
        reply = '말씀하신 내용에 당장의 안전을 확인해야 할 신호가 있습니다. 지금 실제 위험이 있는지 먼저 확인해 주세요. 즉각적인 위험이 있다면 가까운 응급기관에 도움을 요청하세요. 한국에서는 119 또는 112로 연락할 수 있습니다. 직접 개입하는 것이 위험하다면 안전한 곳에서 도움을 요청해 주세요.';
        question = null;
        validation = { approved: true, method: 'safety_response', safety_flag: true };
      } else if (available.ready || body.coach_now || project.status === 'coaching' || !question) {
        const query = (body.text + '\n' + Object.values(project.profile).map(v => (v.value || '').slice(0,500)).join('\n')).slice(0,32000);
        sources = this.knowledge.search(query, 3);
        Object.assign(context, { profile: this.compactProfile(project), knowledge: sources.map(s=>({...s,text:s.text.slice(0,1500)})), limited_profile: !available.ready });
        coaching = await this.gateway.coach(context, signal);
        for (let attempt = 0; attempt < 2; attempt++) {
          const issues = deterministicIssues(coaching);
          const verdict = await this.gateway.verify({ ...context, draft: coaching }, signal);
          issues.push(...verdict.issues);
          if (verdict.approved && !issues.length) {
            validation = { approved: true, method: 'schema_evidence_and_model_review', attempts: attempt + 1, limited_profile: !available.ready, clinical_validation: false, retrieved_count: sources.length, cited_count: coaching.citations.length, grounding: coaching.citations.length ? 'retrieved_reference_used' : 'no_reference_used' };
            break;
          }
          if (attempt === 1) throw new ModelError('생성 답변이 검증을 통과하지 못했습니다. 입력을 보완하거나 다시 시도해 주세요.', 'verification_failed');
          coaching = await this.gateway.coach({ ...context, revision_requirements: issues }, signal);
        }
        reply = coaching.reply;
        project.status = 'coaching';
        question = null;
      } else {
        reply = question.text;
        project.status = 'interviewing';
      }
      if (!danger && project.title === '새 도움 프로젝트' && body.text) {
        if (this.settings.titleBaseUrl && this.settings.titleModel) {
          try { project.title = await this.gateway.title({ current_message: body.text.slice(0, 600) }, signal); }
          catch (error) { if (!(error instanceof ModelError)) throw error; project.title = '도움 프로젝트 ' + project.created_at.slice(0,10); }
        } else project.title = '도움 프로젝트 ' + project.created_at.slice(0,10);
      }
      project.pending_question_id = question?.id || null;
      project.revision++;
      project.updated_at = timestamp();
      const response = { reply, project: publicProject(project), question, coaching, sources, validation, model_mode: this.settings.modelMode, request_id: body.request_id };
      const assistant: Message = { id: randomUUID(), role: 'assistant', content: reply, created_at: timestamp(), metadata: { question, coaching, validation, source_ids: sources.map(s => s.id) } };
      if (signal.aborted) throw new ModelError('전체 대화 처리 제한 시간이 초과되었습니다.', 'timeout');
      await this.store.saveTurn(owner, oldRevision, project, [message,assistant], body.request_id, digest, response);
      return response;
    }, { id: body.request_id, digest });
  }
  compactProfile(project: Project) {
    return Object.fromEntries(Object.entries(project.profile).map(([id, entry]) => [id, { status: entry.status, source: entry.source, value: entry.value?.slice(0,500) || null, evidence: entry.evidence.slice(0,300), message_id: entry.message_id,
      previous_reports:(entry.previous_reports || []).slice(-2).map(p=>({status:p.status,source:p.source,value:p.value?.slice(0,200)||null,evidence:p.evidence.slice(0,200),message_id:p.message_id,updated_at:p.updated_at})),
      history_rule:'과거 보고입니다. 최신 정정과 충돌하면 과거 보고를 현재 사실로 단정하지 마세요. 새 해석이 앞선 관찰을 자동으로 부정하지도 않습니다.' }]));
  }
}
