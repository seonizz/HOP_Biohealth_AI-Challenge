import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModelGateway, ModelError } from './llm.ts';
import { MalssiService } from './v2/service.ts';
import { fail, keys, record, text, uuid } from './v2/errors.ts';

const catalog = JSON.parse(readFileSync(new URL('../data/original-frontend.json', import.meta.url), 'utf8'));
const byId = new Map<string, any>(catalog.questions.map((q: any) => [q.id, q]));
const topicNames: Record<string, string> = {depression:'우울', anxiety:'불안', addiction:'중독', other:'일반'};
const unscored = () => ({우울:null, 불안:null, 중독:null});
// Explicit prototype mode executes the exact ea9c607 reference on the server.
// It never substitutes for a failing live model or starts model/GPU processes.
const prototypeSandbox: any = {};
runInNewContext(readFileSync(new URL('../data/original-model-utils.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../data/original-mock-model.js',import.meta.url),'utf8')+'\nglobalThis.model=Model;',prototypeSandbox,{timeout:1000});
const prototypeModel=prototypeSandbox.model;

// Preserve the original 30 questions, including their option metadata. Never trust
// a browser-supplied weight, symptom, risk, protection label or flow tag.
export function originalPayload(input: any) {
  keys(record(input), ['name','answers','tags'], ['name','answers','tags']);
  const name = text(input.name, 20);
  if (!Array.isArray(input.answers) || input.answers.length > 31 || !Array.isArray(input.tags)) fail('INVALID_ANSWER');
  const seen = new Set<string>(), tags = new Set<string>();
  const answers = input.answers.map((raw: any) => {
    keys(record(raw), ['id','question','type','freeText','text','custom','skipped','selected'], ['id','question','type','freeText','text','custom','skipped','selected']);
    const q = byId.get(raw.id);
    if (!q || seen.has(raw.id) || raw.type !== q.type || typeof raw.skipped !== 'boolean' || !Array.isArray(raw.selected) || raw.selected.length > (q.opts?.length || 0)) fail('INVALID_ANSWER');
    seen.add(raw.id);
    for (const k of ['question','text','custom']) if (typeof raw[k] !== 'string' || raw[k].length > 8000) fail('INVALID_ANSWER');
    const selectedLabels = new Set<string>();
    const selected = raw.selected.map((option: any) => {
      keys(record(option), ['label','meta'], ['label','meta']);
      const original = q.opts?.find((o: any) => (Array.isArray(o) ? o[0] : o) === option.label);
      if (!original || selectedLabels.has(option.label)) fail('INVALID_OPTION');
      selectedLabels.add(option.label);
      const {g,none,input:needsInput,ph,...meta} = Array.isArray(original) ? original[1] || {} : {};
      if (meta.t) tags.add(meta.t);
      return {label:option.label, meta};
    });
    if (raw.skipped && (selected.length || raw.custom)) fail('INVALID_ANSWER');
    if (q.required && (raw.skipped || !raw.text.trim() || raw.text.startsWith('('))) fail('INVALID_ANSWER');
    if (q.type === 'one' && selected.length > 1) fail('INVALID_OPTION');
    if (selected.length > 1 && raw.selected.some((o: any) => q.opts.some((v: any) => Array.isArray(v) && v[0] === o.label && v[1]?.none))) fail('INVALID_OPTION');
    return {id:q.id, question:raw.question, type:q.type, freeText:!!q.cue, text:raw.text, custom:raw.custom, skipped:raw.skipped, selected};
  });
  for (const q of catalog.questions) if (q.required && !q.conditional && !seen.has(q.id)) fail('INVALID_ANSWER');
  return {name, answers, tags:[...tags]};
}

function modelContext(payload: any) {
  // Option metadata helps navigation only; it is never a numerical model score.
  return {current_message:payload.answers.filter((a: any) => !a.skipped).map((a: any) => `${a.question}\n${a.text}${a.custom ? '\n'+a.custom : ''}`).join('\n\n'), original_answers:payload.answers, profile:{alias:payload.name}, knowledge:[], recent_messages:[]};
}
function profile(payload: any, context: any, scores: any = unscored()) {
  const answers = Object.fromEntries(payload.answers.map((a: any) => [a.id,a.text]));
  const value = (id: string) => answers[id] && !answers[id].startsWith('(') ? answers[id] : undefined;
  return {name:payload.name, rel:value('rel'), contact:value('contact'), obs:payload.answers.find((a: any) => a.id==='mood')?.custom || value('gap_obs') || '', concern:value('concern'), moment:value('moment'), feeling:value('feeling'), want:value('want'), scores, safety:context.safety, symptoms:context.symptoms, risks:context.risks, protect:context.protect, tags:payload.tags, answers};
}

export class OriginalFrontendService {
  readonly service: MalssiService;
  readonly gateway: ModelGateway;
  readonly mode: string;
  constructor(service: MalssiService, gateway: ModelGateway,mode='local') {this.service=service; this.gateway=gateway;this.mode=mode;}
  async data(owner: string, id: string) {
    return this.service.db.transaction(owner, async tx => {
      await tx.consent(); const p=await tx.project(uuid(id));
      if (!p.data.original_frontend) fail('NOT_FOUND',404);
      return p.data.original_frontend;
    });
  }
  async create(owner: string, input: any) {
    keys(record(input), ['request_id','payload'], ['request_id','payload']);
    const payload=originalPayload(input.payload);
    return this.service.db.write(owner,'original_frontend_create',input,async tx => {
      const consents=await tx.consent(); await tx.rate('original_frontend_create',10);
      const project_id=await this.service.db.createProject(tx,{alias:payload.name,title:payload.name,original_frontend:{payload,model_mode:this.mode}},!consents.history_storage);
      return {project_id};
    });
  }
  async context(owner: string, id: string, input: any) {
    keys(record(input), ['request_id'], ['request_id']); uuid(input.request_id);
    const saved=await this.data(owner,id);
    if (saved.context) return {context:saved.context,scores:saved.scores,model_mode:saved.model_mode};
    let context:any,scores:any;
    if(saved.model_mode==='prototype'){
      context=await prototypeModel.extractContext(saved.payload);
      scores=await prototypeModel.scoreAnswers(saved.payload,context);
    }else{
      if (!this.service.modelEnabled) fail('MODEL_UNAVAILABLE',503);
      const extracted=await this.gateway.extract(modelContext(saved.payload),AbortSignal.timeout(45000));
      const selected=saved.payload.answers.flatMap((a: any) => a.selected.map((o: any) => o.meta));
      const labels=(key: string) => [...new Set(selected.map((m: any) => m[key]).filter(Boolean))];
      context={symptoms:labels('s'),risks:labels('r'),protect:labels('p'),safety:extracted.safety_flag || selected.some((m: any) => m.s==='suicidal'),topics:extracted.domains};
      scores=unscored();
    }
    await this.service.db.write(owner,'original_frontend_context:'+id,input,async tx => {
      await tx.consent(); const p=await tx.project(id);
      if(!p.data.original_frontend.context){p.data.original_frontend.context=context;p.data.original_frontend.scores=scores;}p.revision++; await tx.saveProject(p);
      return {project_id:id};
    });
    const final=await this.data(owner,id);return {context:final.context,scores:final.scores,model_mode:final.model_mode};
  }
  async draft(owner: string, id: string, input: any) {
    keys(record(input), ['request_id'], ['request_id']); uuid(input.request_id);
    const saved=await this.data(owner,id);
    if (saved.draft) return {project_id:id};
    if(saved.model_mode==='prototype'){
      if(!saved.context)fail('INVALID_STATE',409);
      const guide=await prototypeModel.guide(profile(saved.payload,saved.context,saved.scores));
      await this.service.db.write(owner,'original_frontend_draft:'+id,input,async tx=>{
        await tx.consent();const p=await tx.project(id);p.data.original_frontend.draft ??= {prototype_guide:guide};p.revision++;await tx.saveProject(p);return {project_id:id};
      });
      return {project_id:id};
    }
    if (!saved.context || !this.service.modelEnabled) fail('MODEL_UNAVAILABLE',503);
    const context={...modelContext(saved.payload),profile:profile(saved.payload,saved.context),safety_flag:saved.context.safety};
    const draft=await this.gateway.coach(context,AbortSignal.timeout(45000));
    if (!draft.suggested_words.length || !draft.actions.length) fail('INVALID_MODEL_OUTPUT');
    await this.service.db.write(owner,'original_frontend_draft:'+id,input,async tx => {
      await tx.consent();const p=await tx.project(id);
      p.data.original_frontend.draft ??= draft;p.revision++;await tx.saveProject(p);
      return {project_id:id};
    });
    return {project_id:id};
  }
  async guide(owner: string, id: string, input: any) {
    keys(record(input), ['request_id'], ['request_id']); uuid(input.request_id);
    const saved=await this.data(owner,id);
    if(saved.guide)return {guide:saved.guide};
    if(saved.model_mode==='prototype'){
      if(!saved.draft?.prototype_guide)fail('INVALID_STATE',409);
      await this.service.db.write(owner,'original_frontend_guide:'+id,input,async tx=>{
        await tx.consent();const p=await tx.project(id);p.data.original_frontend.guide ??= saved.draft.prototype_guide;p.revision++;await tx.saveProject(p);return {project_id:id};
      });
      return {guide:(await this.data(owner,id)).guide,model_mode:'prototype'};
    }
    if(!saved.draft||!saved.context||!this.service.modelEnabled)fail('MODEL_UNAVAILABLE',503);
    const context={...modelContext(saved.payload),profile:profile(saved.payload,saved.context),safety_flag:saved.context.safety};
    const draft=saved.draft;
    const verification=await this.gateway.verify({...context,draft},AbortSignal.timeout(45000));
    if (!verification.approved) fail('FAILED_VERIFICATION',503);
    const guide={top:topicNames[saved.context.topics[0]?.label] || '일반',care:{feel:draft.reply,tips:draft.actions.slice(0,3)},script:draft.suggested_words.join('\n\n'),doList:draft.actions,avoid:draft.avoid,next:draft.actions.at(-1)};
    await this.service.db.write(owner,'original_frontend_guide:'+id,input,async tx => {
      await tx.consent(); const p=await tx.project(id);
      p.data.original_frontend.guide ??= guide; p.revision++; await tx.saveProject(p);
      return {project_id:id};
    });
    return {guide:(await this.data(owner,id)).guide};
  }
  async complete(owner: string, id: string, input: any) {
    keys(record(input), ['request_id','record_id','date','log','followUps'], ['request_id','record_id','date','log','followUps']);
    if (!Number.isSafeInteger(input.record_id) || input.record_id < 1 || typeof input.date!=='string' || !Number.isFinite(Date.parse(input.date)) || !Number.isInteger(input.followUps) || input.followUps<0 || input.followUps>40 || !Array.isArray(input.log) || input.log.length>180) fail('INVALID_ANSWER');
    const log=input.log.map((m: any) => {
      keys(record(m), ['who','text','fu'], ['who','text']);
      if (!['ai','me'].includes(m.who) || typeof m.text!=='string' || m.text.length>8000 || (m.fu!==undefined && typeof m.fu!=='boolean')) fail('INVALID_ANSWER');
      return m;
    });
    return this.service.db.write(owner,'original_frontend_complete:'+id,input,async tx => {
      await tx.consent(); const p=await tx.project(id),saved=p.data.original_frontend;
      if (!saved?.guide || !saved.context) fail('INVALID_STATE',409);
      saved.record={id:input.record_id,server_id:id,title:saved.payload.name,date:input.date,profile:profile(saved.payload,saved.context,saved.scores),guide:saved.guide,log,followUps:input.followUps,model_mode:saved.model_mode};
      p.revision++; await tx.saveProject(p); return {project_id:id};
    });
  }
  async list(owner: string) {
    return this.service.db.transaction(owner,async tx => {
      await tx.consent();
      const ids=await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1 AND expires_at>now() ORDER BY created_at DESC',[owner]);
      const records=[];
      for (const {id} of ids.rows) {
        try {const p=await tx.project(id);if(p.data.original_frontend?.record)records.push(p.data.original_frontend.record);}
        catch(error) {if ((error as any)?.status!==410) throw error;}
      }
      return {records};
    });
  }
  async delete(owner: string, id: string, input: any) {
    keys(record(input), ['request_id'], ['request_id']);
    // The reference-only journal makes ambiguous deletion responses replayable.
    return this.service.db.write(owner,'original_frontend_delete:'+id,input,async tx => {
      const p=await tx.project(uuid(id),true); if(!p.data.original_frontend)fail('NOT_FOUND',404);
      await tx.invalidate(id,'CANCELLED');const receipt=await tx.receipt('delete_project',id);
      await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[id,owner]);
      return {deletion_id:receipt.id};
    });
  }
}

export async function routeOriginalFrontend(req: IncomingMessage,res: ServerResponse,owner: string,service: MalssiService|null,gateway: ModelGateway,mode='local') {
  const path=new URL(req.url||'/','http://localhost').pathname;
  if(!path.startsWith('/api/v2/frontend/'))return false;
  if(!service)fail('FEATURE_UNAVAILABLE',503);
  const adapter=new OriginalFrontendService(service,gateway,mode),send=(value: any,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  let input:any=null;
  if(req.method!=='GET') {
    if(!(req.headers['content-type']||'').startsWith('application/json'))fail('UNSUPPORTED_MEDIA_TYPE',415);
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>262144)fail('BODY_TOO_LARGE',413);chunks.push(chunk);}
    try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('MALFORMED_JSON',400);}
  }
  try {
    if(path==='/api/v2/frontend/records' && req.method==='GET')send(await adapter.list(owner));
    else if(path==='/api/v2/frontend/records' && req.method==='POST')send(await adapter.create(owner,input),201);
    else {
      const match=/^\/api\/v2\/frontend\/records\/([a-f0-9-]{36})(?:\/(context|draft|guide|complete))?$/.exec(path);
      if(!match)fail('NOT_FOUND',404);
      const [,id,action]=match;
      if(req.method==='POST'&&action==='context')send(await adapter.context(owner,id,input));
      else if(req.method==='POST'&&action==='draft')send(await adapter.draft(owner,id,input));
      else if(req.method==='POST'&&action==='guide')send(await adapter.guide(owner,id,input));
      else if(req.method==='POST'&&action==='complete')send(await adapter.complete(owner,id,input));
      else if(req.method==='DELETE'&&!action)send(await adapter.delete(owner,id,input),202);
      else fail('NOT_FOUND',404);
    }
  } catch(error) {
    if(error instanceof ModelError)fail('MODEL_UNAVAILABLE',503);
    throw error;
  }
  return true;
}
