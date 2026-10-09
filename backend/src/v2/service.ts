import { randomUUID, randomBytes } from 'node:crypto';
import { catalog, catalogHash, alias, assertCatalogPublishable, coverage, eligibility, nextQuestion, question, questionSnapshot, readiness, validateAnswer } from './questions.ts';
import type { Answers } from './questions.ts';
import { V2Database, Transaction, contentTables } from './db.ts';
import type { Row } from './db.ts';
import { fail, keys, record, revision, text, uuid } from './errors.ts';
import { assessSafety, inputText, SAFETY_TEXT } from './safety.ts';

export const CONSENT_VERSION = 'malssi-consent-v1';
export const PURPOSES = ['service_processing','sensitive_processing','history_storage','cross_session_memory'];
export const GOALS = Object.keys(catalog.goal_priorities);
const TERMINAL = ['COMPLETED','ARCHIVED'];
const meta = (c: Row, next: string[] = []) => ({conversation_id:c.id,resource_revision:c.revision,state:c.state,run_id:c.active_run_id || null,next_actions:next});

export class MalssiService {
  readonly db: V2Database; readonly allowDraft: boolean; readonly modelEnabled: boolean;
  constructor(db: V2Database, options: {allowDraft?:boolean;modelEnabled?:boolean} = {}) { this.db=db; this.allowDraft=options.allowDraft ?? false; this.modelEnabled=options.modelEnabled ?? false; }
  checkCatalog() { if (!this.allowDraft) assertCatalogPublishable(); }
  async answers(tx: Transaction, c: Row): Promise<Answers> {
    const rows = await tx.rows('answer_revisions',c.project_id,c.id);
    return Object.fromEntries(rows.filter(r=>r.status==='current').map(r=>[r.data.question_id,{...r.data,id:r.id,revision:r.answer_revision}]));
  }
  async ask(tx: Transaction, c: Row, p: Row, explicit?: string, topic?: string) {
    const answers = await this.answers(tx,c);
    if (c.data.pending_instance_id) {
      const previous = await tx.get('question_instances',c.data.pending_instance_id);
      if (previous.status === 'pending') { previous.status='deferred'; await tx.update('question_instances',previous); }
    }
    const id = nextQuestion(answers,c.data.goal,explicit,topic);
    if (!id) { c.data.pending_instance_id=null; c.state='REVIEWING'; return; }
    const instance = await tx.insert('question_instances',c,questionSnapshot(id,p.data.alias,answers),'pending');
    c.data.pending_instance_id=instance.id;
    await tx.event(c,'question.ready',instance.id);
  }
  async consents(owner: string) { return this.db.transaction(owner,async tx=>({version:CONSENT_VERSION,purposes:await tx.consent(false)})); }
  async setConsents(owner: string, input: any) {
    keys(record(input),['request_id','version','purposes'],['request_id','version','purposes']);
    if (input.version !== CONSENT_VERSION) fail('CONSENT_REQUIRED',403);
    keys(record(input.purposes),PURPOSES,PURPOSES);
    if (Object.values(input.purposes).some(v=>typeof v !== 'boolean')) fail();
    if (input.purposes.cross_session_memory && !input.purposes.history_storage) fail();
    return this.db.write(owner,'consents',input,async tx=>{
      const previous = await tx.consent(false);
      for (const purpose of PURPOSES) await tx.query('INSERT INTO consent_records(id,owner_id,purpose,version,accepted) VALUES($1,$2,$3,$4,$5)',[randomUUID(),owner,purpose,input.version,input.purposes[purpose]]);
      await tx.query('UPDATE users SET consent_epoch=consent_epoch+1 WHERE id=$1',[owner]);
      const projects = await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1',[owner]);
      for (const project of projects.rows) await tx.invalidate(project.id,'CANCELLED');
      if (PURPOSES.some(p=>previous[p] && !input.purposes[p])) await this.applyWithdrawal(tx, PURPOSES.filter(p=>previous[p] && !input.purposes[p]));
      return {resource_revision:0,next_actions:['create_project']};
    });
  }
  async applyWithdrawal(tx: Transaction, purposes: string[]) {
    const projects = await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1',[tx.owner]);
    for (const {id} of projects.rows) {
      await tx.invalidate(id,'CANCELLED');
      if (purposes.some(p=>['service_processing','sensitive_processing','history_storage'].includes(p))) {
        await tx.receipt('delete_project',id);
        await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[id,tx.owner]);
        await tx.query("DELETE FROM requests_v2 WHERE owner_id=$1 AND scope_id NOT IN ('consents','withdraw')",[tx.owner]);
      } else if (purposes.includes('cross_session_memory')) {
        await tx.query("UPDATE memory_items SET status='revoked' WHERE owner_id=$1 AND project_id=$2",[tx.owner,id]);
        await tx.query('UPDATE v2_projects SET memory_revision=memory_revision+1 WHERE id=$1 AND owner_id=$2',[id,tx.owner]);
      }
    }
  }
  async withdraw(owner: string, input: any) {
    keys(record(input),['request_id','purposes'],['request_id','purposes']);
    if (!Array.isArray(input.purposes) || !input.purposes.length || new Set(input.purposes).size !== input.purposes.length || input.purposes.some((p: string)=>!PURPOSES.includes(p))) fail();
    return this.db.write(owner,'withdraw',input,async tx=>{
      for (const purpose of input.purposes) await tx.query('INSERT INTO consent_records(id,owner_id,purpose,version,accepted) VALUES($1,$2,$3,$4,false)',[randomUUID(),owner,purpose,CONSENT_VERSION]);
      await tx.query('UPDATE users SET consent_epoch=consent_epoch+1 WHERE id=$1',[owner]);
      await this.applyWithdrawal(tx,input.purposes);
      const receipt = await tx.receipt('withdraw_consent',owner);
      return {deletion_id:receipt.id,resource_revision:0,next_actions:['view_deletion']};
    });
  }
  async createProject(owner: string, input: any) {
    keys(record(input),['request_id','alias','title'],['request_id']);
    const name = input.alias === undefined ? '그분' : alias(input.alias);
    const titleValue = input.title === undefined ? '말씨 상담' : text(input.title,80);
    return this.db.write(owner,'projects',input,async tx=>{
      const consents = await tx.consent(); await tx.rate('general',60);
      const id = await this.db.createProject(tx,{alias:name,alias_origin:input.alias === undefined?'default':'user',title:titleValue},!consents.history_storage);
      return {project_id:id,resource_revision:0,next_actions:['start_conversation']};
    });
  }
  async readProject(owner: string, id: string) {
    return this.db.transaction(owner,async tx=>{ await tx.consent(); const p=await tx.project(id); return this.publicProject(p); });
  }
  publicProject(p: Row) { return {id:p.id,revision:p.revision,memory_revision:p.memory_revision,...p.data,temporary:p.temporary,expires_at:p.expires_at}; }
  async listProjects(owner: string, limit = 50, cursor?: string) {
    if (!Number.isInteger(limit)||limit<1||limit>50) fail(); if(cursor) uuid(cursor);
    return this.db.transaction(owner,async tx=>{
      await tx.consent();
      const rows = await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1 AND expires_at>now() AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[owner,cursor || null,limit+1]);
      const projects=[]; for(const r of rows.rows.slice(0,limit)) projects.push(this.publicProject(await tx.project(r.id)));
      return {projects,next_cursor:rows.rows.length>limit?projects.at(-1)?.id:null};
    });
  }
  async patchProject(owner: string, id: string, input: any) {
    keys(record(input),['request_id','expected_revision','alias','title'],['request_id','expected_revision']);
    if (input.alias === undefined && input.title === undefined) fail();
    return this.db.write(owner,'project:'+id,input,async tx=>{
      await tx.consent(); const p=await tx.project(id); revision(input.expected_revision,p.revision);
      if(input.alias!==undefined) {p.data.alias=alias(input.alias);p.data.alias_origin='user';}
      if(input.title!==undefined) p.data.title=text(input.title,80);
      p.revision++; await tx.invalidate(id); await tx.saveProject(p);
      return {project_id:id,resource_revision:p.revision,next_actions:['view_project']};
    });
  }
  async createConversation(owner: string, id: string, input: any) {
    keys(record(input),['request_id','goal','questionnaire_version'],['request_id','goal']);
    if(!GOALS.includes(input.goal)) fail('INVALID_OPTION');
    if(input.questionnaire_version && input.questionnaire_version!==catalog.questionnaire_version) fail('QUESTION_RETIRED',410);
    this.checkCatalog();
    return this.db.write(owner,'conversations:'+id,input,async tx=>{
      await tx.consent(); const p=await tx.project(id), cid=randomUUID();
      const c:Row={id:cid,project_id:id,owner_id:owner,revision:0,safety_revision:0,state:'SETUP',active_run_id:null,data:{goal:input.goal,questionnaire_version:catalog.questionnaire_version,catalog_hash:catalogHash,pending_instance_id:null,collection_turns:0}};
      await tx.query('INSERT INTO conversations(id,owner_id,project_id,state,encrypted_payload) VALUES($1,$2,$3,$4,$5)',[cid,owner,id,c.state,tx.seal(id,cid,c.data)]);
      await this.ask(tx,c,p); await tx.saveConversation(c);
      return meta(c,['answer','select_topic','request_guidance','finish']);
    });
  }
  async readConversation(owner: string, id: string) {
    return this.db.transaction(owner,async tx=>{
      await tx.consent(); const {c,p}=await tx.conversation(id), answers=await this.answers(tx,c);
      const pending=c.data.pending_instance_id ? await tx.get('question_instances',c.data.pending_instance_id):null;
      return {...meta(c),project_id:p.id,safety_revision:c.safety_revision,goal:c.data.goal,question:pending?{id:pending.id,...pending.data}:null,coverage:coverage(answers),ready_for:readiness(answers,c.data.goal),offer_guidance:c.data.collection_turns>=6,answers:Object.values(answers),next_actions:c.state==='SAFETY_HOLD'?['safety_update','resume_after_safety','finish']:TERMINAL.includes(c.state)?['archive','restore']:['answer','select_topic','select_question','request_guidance','finish']};
    });
  }
  async safety(tx: Transaction, c: Row, assessment: ReturnType<typeof assessSafety>, messageId?: string) {
    await tx.invalidate(c.project_id,'CANCELLED'); c.active_run_id=null; c.state='SAFETY_HOLD'; c.safety_revision++;
    const episode=await tx.insert('safety_episodes',c,{...assessment,message_id:messageId || null,acknowledged:false},'open');
    c.data.safety_episode_id=episode.id;
    await tx.insert('v2_messages',c,{role:'assistant',content:assessment.route==='urgent'?SAFETY_TEXT:'말씀하신 내용이 지금 일어나고 있는 위험인지, 누구의 상황인지 확인해 주실 수 있을까요?',kind:'safety'},'visible');
    await tx.event(c,'safety.required',episode.id);
  }
  async answer(tx: Transaction, c: Row, p: Row, payload: any, old?: Row) {
    keys(record(payload),['question_instance_id','question_id','question_version','disposition','value'],['question_instance_id','question_id','question_version','disposition','value']);
    const instance=await tx.get('question_instances',uuid(payload.question_instance_id));
    if(instance.conversation_id!==c.id || (!old && (instance.id!==c.data.pending_instance_id || instance.status!=='pending')) || instance.data.question_id!==payload.question_id || payload.question_version!==c.data.questionnaire_version) fail('INVALID_ANSWER');
    const answers=await this.answers(tx,c), value=validateAnswer(payload.question_id,payload.disposition,payload.value,answers);
    const message=await tx.insert('v2_messages',c,{role:'user',content:inputText(value),value,kind:'answer',question_id:payload.question_id},'visible');
    const previous=old || (await tx.rows('answer_revisions',c.project_id,c.id)).findLast(a=>a.data.question_id===payload.question_id && a.status==='current');
    if(previous) {previous.status='superseded';await tx.update('answer_revisions',previous);await this.invalidateSources(tx,p,[previous.id,previous.data.message_id],false);}
    const count=await tx.query('SELECT coalesce(max(answer_revision),0) AS revision FROM answer_revisions WHERE question_instance_id=$1 AND owner_id=$2',[instance.id,tx.owner]);
    const answer=await tx.insert('answer_revisions',c,{question_id:payload.question_id,disposition:payload.disposition,value,message_id:message.id,supersedes:previous?.id || null,derived_from_answer_id:payload.disposition==='not_applicable'?answers.T09?.id:null},'current',{question_instance_id:instance.id,answer_revision:Number(count.rows[0].revision)+1});
    instance.status='answered';await tx.update('question_instances',instance);
    if(payload.question_id==='T09') {
      for(const dependent of ['T10','T11']) {
        const prior=(await tx.rows('answer_revisions',p.id,c.id)).filter(a=>a.data.question_id===dependent&&a.status==='current');
        for(const item of prior) if(item.data.derived_from_answer_id || value?.option_ids?.includes('none')) {item.status='superseded';await tx.update('answer_revisions',item);}
        if(payload.disposition==='answered'&&value?.option_ids?.includes('none')) {
          const derivedInstance=await tx.insert('question_instances',c,questionSnapshot(dependent,p.data.alias,{...answers,T09:{...answer.data,id:answer.id}}),'derived');
          await tx.insert('answer_revisions',c,{question_id:dependent,disposition:'not_applicable',value:null,message_id:null,derived_from_answer_id:answer.id},'current',{question_instance_id:derivedInstance.id,answer_revision:1});
        }
      }
    }
    if(payload.question_id==='N00') {p.data.alias=value?.text || '그분';p.data.alias_origin=value?'user':'default';p.revision++;}
    if(value && payload.question_id!=='N00') {
      const q=question(payload.question_id), direct=!inputText(value), now=new Date().toISOString();
      const memory=await tx.insert('memory_items',c,{entity:q.entity,kind:q.id.startsWith('C')?'episodic':'semantic',field_path:q.slot || 'relationship',value,confirmation_status:direct?'confirmed':'unconfirmed',source_type:direct?'direct_choice':'self_report',source_refs:[{message_id:message.id,answer_revision_id:answer.id,start_cp:0,end_cp:[...inputText(value)].length}],reported_at:now,confirmed_at:direct?now:null,expires_at:new Date(Date.now()+(q.id.startsWith('C')?30:180)*86400000).toISOString(),consent_version:CONSENT_VERSION,extracted_by:'explicit_question_answer',revision:0},direct?'validated':'candidate');
      for(const source of [message.id,answer.id]) await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5)',[tx.owner,p.id,source,memory.id,'memory_items']);
      p.memory_revision++; await tx.invalidate(p.id); c.active_run_id=null;
    }
    await tx.saveProject(p);
    const assessment=assessSafety(inputText(value));
    if(assessment.route!=='no_signal') {await this.safety(tx,c,assessment,message.id);return;}
    c.state='EXPLORING';c.data.collection_turns++;
    await this.ask(tx,c,p);
  }
  async enqueue(tx: Transaction, c: Row, p: Row, kind: string, messageId?: string, guidanceKind?: string) {
    if (!this.modelEnabled) fail('MODEL_UNAVAILABLE',503);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('malssi_queue'))");
    const count=await tx.query('SELECT count(*)::integer AS n FROM agent_queue');
    if(count.rows[0].n>=3) fail('QUEUE_FULL',503);
    await tx.rate('model',3);
    const id=randomUUID(), epoch=await tx.query('SELECT consent_epoch FROM users WHERE id=$1',[tx.owner]);
    const data={kind,message_id:messageId || null,guidance_kind:guidanceKind || null,questionnaire_version:c.data.questionnaire_version,policy_version:'malssi-v1',prompt_version:'malssi-v1',decision_log:[],model_id:process.env.HOP_LLM_MODEL || 'local',model_artifact_hash:process.env.HOP_MODEL_ARTIFACT_HASH || 'unverified'};
    await tx.query(`INSERT INTO agent_runs(id,owner_id,project_id,conversation_id,status,input_revision,project_revision,memory_revision,safety_revision,consent_epoch,deletion_epoch,encrypted_payload) VALUES($1,$2,$3,$4,'ACCEPTED',$5,$6,$7,$8,$9,$10,$11)`,[id,tx.owner,p.id,c.id,c.revision,p.revision,p.memory_revision,c.safety_revision,epoch.rows[0].consent_epoch,p.deletion_epoch,tx.seal(p.id,id,data)]);
    await tx.query('INSERT INTO agent_queue(run_id,owner_id) VALUES($1,$2)',[id,tx.owner]);
    c.active_run_id=id; await tx.event(c,'run.accepted',id);
  }
  async turn(owner: string, id: string, input: any) {
    keys(record(input),['request_id','expected_revision','action','payload'],['request_id','expected_revision','action','payload']);
    const payload=record(input.payload);
    const contracts:Record<string,string[]>={answer:['question_instance_id','question_id','question_version','disposition','value'],message:['text'],select_topic:['topic_id'],select_question:['question_id'],request_guidance:['guidance_kind'],correct_answer:['answer_revision_id','replacement'],safety_update:['safety_episode_id','text'],resume_after_safety:['safety_episode_id','acknowledgement','text'],finish:['reason'],archive:[],restore:[],confirm_summary:['summary_id','accepted_memory_ids']};
    if(!contracts[input.action]) fail();
    keys(payload,contracts[input.action],input.action==='finish'?[]:input.action==='safety_update'?['text']:contracts[input.action]);
    if(!Number.isInteger(input.expected_revision)||input.expected_revision<0)fail();
    return this.db.write(owner,'turn:'+id,input,async tx=>{
      await tx.consent(); const {c,p}=await tx.conversation(id), action=input.action;
      // Safety and cancellation precede ordinary revision/run gates.
      const assessment=assessSafety(inputText(payload));
      if(assessment.route!=='no_signal') {
        if(action==='answer') {
          const instance=await tx.get('question_instances',uuid(payload.question_instance_id));
          if(instance.conversation_id!==c.id||instance.data.question_id!==payload.question_id||payload.question_version!==c.data.questionnaire_version)fail();
          validateAnswer(payload.question_id,payload.disposition,payload.value,await this.answers(tx,c));
        }
        if(action==='correct_answer') {
          const answer=await tx.get('answer_revisions',uuid(payload.answer_revision_id));
          if(answer.conversation_id!==c.id||answer.status!=='current')fail();
          const replacement=record(payload.replacement);keys(replacement,['disposition','value'],['disposition','value']);
          validateAnswer(answer.data.question_id,replacement.disposition,replacement.value,await this.answers(tx,c));
        }
        const message=await tx.insert('v2_messages',c,{role:'user',content:text(inputText(payload),8000),kind:'safety'},'visible');
        c.revision++;await this.safety(tx,c,assessment,message.id);await tx.saveConversation(c);
        return {...meta(c,['safety_update','resume_after_safety','finish']),safety_episode_id:c.data.safety_episode_id};
      }
      revision(input.expected_revision,c.revision);
      if(c.data.catalog_hash!==catalogHash)fail('QUESTION_RETIRED',410);
      if(c.state==='SAFETY_HOLD' && !['safety_update','resume_after_safety','finish'].includes(action)) fail('INVALID_STATE',409);
      if(TERMINAL.includes(c.state) && !['archive','restore'].includes(action)) fail('INVALID_STATE',409);
      const interrupts=['finish','safety_update','resume_after_safety','correct_answer'];
      if(c.active_run_id && !interrupts.includes(action) && !(action==='answer' && assessment.route!=='no_signal')) fail('RUN_IN_PROGRESS',409);
      if(!interrupts.includes(action)) await tx.rate('general',60);
      c.revision++;
      if(action==='answer') await this.answer(tx,c,p,payload);
      else if(action==='correct_answer') {
        const old=await tx.get('answer_revisions',uuid(payload.answer_revision_id));
        if(old.conversation_id!==c.id || old.status!=='current') fail('INVALID_ANSWER');
        const instance=await tx.get('question_instances',old.question_instance_id);
        const replacement=record(payload.replacement);keys(replacement,['disposition','value'],['disposition','value']);
        await this.answer(tx,c,p,{question_instance_id:instance.id,question_id:instance.data.question_id,question_version:c.data.questionnaire_version,...replacement},old);
      } else if(action==='select_question' || action==='select_topic') {
        if(action==='select_topic' && !catalog.topics.some((t:any)=>t.id===payload.topic_id)) fail('INVALID_OPTION');
        await this.ask(tx,c,p,action==='select_question'?payload.question_id:undefined,action==='select_topic'?payload.topic_id:undefined);c.state='EXPLORING';
      } else if(action==='message' || action==='request_guidance') {
        if(action==='request_guidance' && !['communication_guidance',...GOALS].includes(payload.guidance_kind)) fail('INVALID_OPTION');
        let message:Row|undefined;
        if(action==='message') message=await tx.insert('v2_messages',c,{role:'user',content:text(payload.text,8000),kind:'message'},'visible');
        // When inference is disabled, still retain the user's accepted message and report an explicit failed run.
        if(!this.modelEnabled && message) {
          await this.ask(tx,c,p); c.state='EXPLORING';
          await tx.saveConversation(c);
          return {...meta(c,['answer','request_guidance']),model_unavailable:true,input_saved:true};
        }
        await this.enqueue(tx,c,p,action,message?.id,payload.guidance_kind);
      } else if(action==='safety_update') {
        if(c.state!=='SAFETY_HOLD') fail('INVALID_STATE',409);
        if(payload.safety_episode_id && payload.safety_episode_id!==c.data.safety_episode_id) fail('NOT_FOUND',404);
        await tx.insert('v2_messages',c,{role:'user',content:text(payload.text,8000),kind:'safety_update'},'visible');
      } else if(action==='resume_after_safety') {
        if(c.state!=='SAFETY_HOLD' || payload.safety_episode_id!==c.data.safety_episode_id || payload.acknowledgement!=='no_current_immediate_danger') fail('INVALID_STATE',409);
        // A fresh explicit statement is mandatory; a generic 'next' can never release the hold.
        text(payload.text,2000); if(!/현재|지금/u.test(payload.text) || !/없|않|안전한\s*곳/u.test(payload.text)) fail('INVALID_ANSWER');
        const episode=await tx.get('safety_episodes',payload.safety_episode_id);episode.status='user_acknowledged';episode.data.acknowledged=true;await tx.update('safety_episodes',episode);
        c.state='REVIEWING';c.safety_revision++;await tx.invalidate(p.id,'CANCELLED');c.active_run_id=null;
      } else if(action==='finish') {if(payload.reason!==undefined) text(payload.reason,500);await tx.invalidate(p.id,'CANCELLED');c.active_run_id=null;c.state='COMPLETED';c.data.pending_instance_id=null;}
      else if(action==='archive') {if(c.state!=='COMPLETED') fail('INVALID_STATE',409);c.state='ARCHIVED';}
      else if(action==='restore') {if(c.state!=='ARCHIVED') fail('INVALID_STATE',409);c.state='COMPLETED';}
      else if(action==='confirm_summary') {
        const summary=await tx.get('conversation_summaries',uuid(payload.summary_id));
        if(summary.conversation_id!==c.id || summary.status!=='valid' || !Array.isArray(payload.accepted_memory_ids)) fail();
        for(const mid of payload.accepted_memory_ids) {
          if(!summary.data.memory_ids?.includes(mid)) fail();
          const memory=await tx.get('memory_items',uuid(mid));await this.confirm(tx,memory,p);
        }
        c.active_run_id=null;c.state='REVIEWING';
      }
      await tx.saveConversation(c); await tx.event(c,'conversation.changed',c.id);
      return meta(c,c.active_run_id?['poll_run','cancel_run','safety_update']:c.state==='SAFETY_HOLD'?['safety_update','resume_after_safety','finish']:['answer','request_guidance','finish']);
    });
  }
  async messages(owner: string, id: string, limit=100, cursor?: string) {
    if(!Number.isInteger(limit)||limit<1||limit>100 || (cursor && !/^\d+$/.test(cursor))) fail();
    return this.db.transaction(owner,async tx=>{
      await tx.consent(); const {c}=await tx.conversation(id);
      const all=(await tx.rows('v2_messages',c.project_id,c.id)).filter(m=>!cursor || BigInt(m.sequence_id)>BigInt(cursor));
      return {messages:all.slice(0,limit).map(m=>({id:m.id,revision:m.revision,sequence_id:m.sequence_id,visibility:m.status,...m.data})),next_cursor:all.length>limit?all[limit-1].sequence_id:null};
    });
  }
  async confirm(tx: Transaction, memory: Row, p: Row) {
    const consents=await tx.consent();
    if(!consents.cross_session_memory || !consents.history_storage || p.temporary) fail('CONSENT_REQUIRED',403);
    if(!['candidate','validated','active','stale'].includes(memory.status)) fail('INVALID_STATE',409);
    memory.status='active';memory.revision++;memory.data.confirmation_status='confirmed';memory.data.confirmed_by='user';memory.data.confirmed_at=new Date().toISOString();
    memory.data.expires_at=new Date(Date.now()+(memory.data.entity==='supporter'?30:180)*86400000).toISOString();
    await tx.update('memory_items',memory); p.memory_revision++;await tx.invalidate(p.id);await tx.saveProject(p);
  }
  async memories(owner: string, id: string, status?: string, entity?: string) {
    if(status && !['candidate','validated','active','stale','superseded','revoked'].includes(status)) fail();
    if(entity && !['subject','supporter','relationship'].includes(entity)) fail();
    return this.db.transaction(owner,async tx=>{
      await tx.consent();const p=await tx.project(id), rows=await tx.rows('memory_items',id);
      let changed=false;
      for(const row of rows) if(row.status==='active' && Date.parse(row.data.expires_at)<=Date.now()) {row.status='stale';row.revision++;await tx.update('memory_items',row);changed=true;}
      if(changed) {p.memory_revision++;await tx.invalidate(id);await tx.saveProject(p);}
      return {memories:rows.filter(r=>(!status||r.status===status)&&(!entity||r.data.entity===entity)).map(r=>({...r.data,id:r.id,revision:r.revision,status:r.status})),memory_revision:p.memory_revision};
    });
  }
  async invalidateSources(tx: Transaction, p: Row, sourceIds: string[], suppress: boolean) {
    // Conservative dependency invalidation: suppress entire source messages, never reconstruct forgotten spans.
    for(const source of sourceIds.filter(Boolean)) {
      if(suppress) await tx.query('INSERT INTO memory_suppressions(owner_id,project_id,source_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tx.owner,p.id,source]);
      const derived=await tx.query('WITH RECURSIVE descendants(id) AS (SELECT child_id FROM memory_derivations WHERE owner_id=$1 AND project_id=$2 AND parent_id=$3 UNION SELECT d.child_id FROM memory_derivations d JOIN descendants x ON x.id=d.parent_id WHERE d.owner_id=$1 AND d.project_id=$2) SELECT id FROM descendants',[tx.owner,p.id,source]);
      const ids=derived.rows.map(r=>r.id);
      for(const table of ['memory_items','conversation_summaries','guidance_versions','action_plans'] as const) {
        if(ids.length) await tx.query(`DELETE FROM ${table} WHERE owner_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,[tx.owner,p.id,ids]);
      }
    }
    // Summaries and guidance are caches. Conservative deletion avoids dangling indirect references.
    for(const table of ['conversation_summaries','guidance_versions','action_plans','plan_feedback']) await tx.query(`DELETE FROM ${table} WHERE owner_id=$1 AND project_id=$2`,[tx.owner,p.id]);
    p.memory_revision++;p.deletion_epoch++;await tx.invalidate(p.id);await tx.saveProject(p);
    // Completed run payloads can contain final guidance; erase those copies as well.
    await tx.query('DELETE FROM agent_runs WHERE owner_id=$1 AND project_id=$2',[tx.owner,p.id]);
  }
  async mutateMemory(owner: string, id: string, input: any, action: 'confirm'|'correct'|'forget') {
    keys(record(input),['request_id','expected_revision',...(action==='correct'?['corrected_value']:action==='forget'?['scope']:[])],['request_id','expected_revision',...(action==='correct'?['corrected_value']:action==='forget'?['scope']:[])]);
    if(action==='forget' && input.scope!=='forget_memory') fail();
    return this.db.write(owner,'memory:'+action+':'+id,input,async tx=>{
      await tx.consent();const memory=await tx.get('memory_items',id),p=await tx.project(memory.project_id);revision(input.expected_revision,memory.revision);
      if(action==='confirm') await this.confirm(tx,memory,p);
      else if(action==='forget') {
        const sources=memory.data.source_refs.flatMap((s:any)=>[s.message_id,s.answer_revision_id]).filter(Boolean);
        await this.invalidateSources(tx,p,sources,true);await tx.query('DELETE FROM memory_items WHERE id=$1 AND owner_id=$2',[id,owner]);
        const receipt=await tx.receipt('forget_memory',id);return {deletion_id:receipt.id,resource_revision:p.memory_revision,next_actions:['view_deletion']};
      } else {
        const replacement=text(input.corrected_value,2000), {c}=await tx.conversation(memory.conversation_id);
        await this.invalidateSources(tx,p,memory.data.source_refs.flatMap((s:any)=>[s.message_id,s.answer_revision_id]).filter(Boolean),true);
        const message=await tx.insert('v2_messages',c,{role:'user',content:replacement,kind:'memory_correction'},'visible');
        const corrected=await tx.insert('memory_items',c,{...memory.data,value:replacement,source_type:'self_report',source_refs:[{message_id:message.id,start_cp:0,end_cp:[...replacement].length}],supersedes_memory_id:id,confirmation_status:'unconfirmed',confirmed_by:null},'candidate');
        await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5)',[owner,p.id,message.id,corrected.id,'memory_items']);
        const assessment=assessSafety(replacement);if(assessment.route!=='no_signal'){c.revision++;await this.safety(tx,c,assessment,message.id);await tx.saveConversation(c);}
        return {memory_id:corrected.id,resource_revision:corrected.revision,next_actions:['confirm_memory']};
      }
      return {memory_id:id,resource_revision:memory.revision,next_actions:['view_memories']};
    });
  }
  async deleteSource(owner: string, id: string, input: any) {
    keys(record(input),['request_id','expected_revision','scope'],['request_id','expected_revision','scope']);if(input.scope!=='delete_source')fail();
    return this.db.write(owner,'delete_source:'+id,input,async tx=>{
      const message=await tx.get('v2_messages',id),p=await tx.project(message.project_id);revision(input.expected_revision,message.revision);
      const answers=(await tx.rows('answer_revisions',p.id)).filter(a=>a.data.message_id===id);
      await this.invalidateSources(tx,p,[id,...answers.map(a=>a.id)],true);
      for(const answer of answers) await tx.query('DELETE FROM answer_revisions WHERE id=$1 AND owner_id=$2',[answer.id,owner]);
      await tx.query('DELETE FROM v2_messages WHERE id=$1 AND owner_id=$2',[id,owner]);
      const receipt=await tx.receipt('delete_source',id);
      return {deletion_id:receipt.id,resource_revision:p.memory_revision,next_actions:['view_deletion']};
    });
  }
  async deleteProject(owner: string, id: string, input: any) {
    keys(record(input),['request_id','expected_revision'],['request_id','expected_revision']);
    return this.db.write(owner,'delete_project:'+id,input,async tx=>{
      const p=await tx.project(id,true);revision(input.expected_revision,p.revision);await tx.invalidate(id,'CANCELLED');
      const receipt=await tx.receipt('delete_project',id);
      await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[id,owner]);
      await tx.query("DELETE FROM requests_v2 WHERE owner_id=$1 AND scope_id NOT IN ('consents','withdraw')",[owner]);
      return {deletion_id:receipt.id,resource_revision:p.revision+1,next_actions:['view_deletion']};
    });
  }
  async deletion(owner: string,id:string) {return this.db.transaction(owner,async tx=>{uuid(id);const r=await tx.query('SELECT id,scope,online_purged,derived_purged,backup_expires_at,created_at FROM deletion_requests WHERE owner_id=$1 AND id=$2',[owner,id]);return r.rows[0] || fail('NOT_FOUND',404);});}
  async run(owner: string,id:string) {
    return this.db.transaction(owner,async tx=>{await tx.consent();uuid(id);const r=await tx.query('SELECT * FROM agent_runs WHERE owner_id=$1 AND id=$2',[owner,id]);if(!r.rowCount)fail('NOT_FOUND',404);await tx.project(r.rows[0].project_id);const run=tx.decode(r.rows[0]);return {id,status:run.status,input_saved:true,result:run.status==='SUCCEEDED'?run.data.result || null:null,error:run.data.error || null,deadline_at:run.deadline_at};});
  }
  async cancel(owner:string,id:string,input:any) {
    keys(record(input),['request_id'],['request_id']);
    return this.db.write(owner,'cancel:'+id,input,async tx=>{uuid(id);const r=await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND owner_id=$2',[id,owner]);if(!r.rowCount)fail('NOT_FOUND',404);const {c}=await tx.conversation(r.rows[0].conversation_id);if(['ACCEPTED','RUNNING'].includes(r.rows[0].status)){await tx.query("UPDATE agent_runs SET status='CANCELLED' WHERE id=$1 AND owner_id=$2",[id,owner]);await tx.query('DELETE FROM agent_queue WHERE run_id=$1',[id]);c.active_run_id=null;c.revision++;await tx.saveConversation(c);await tx.event(c,'run.cancelled',id);}return meta(c,['view_conversation']);});
  }
  async choosePlan(owner:string,id:string,input:any) {
    keys(record(input),['request_id','guidance_id','action_index','user_edited_text'],['request_id','guidance_id']);
    return this.db.write(owner,'plans:'+id,input,async tx=>{
      await tx.consent();const {c}=await tx.conversation(id);if(c.state!=='GUIDANCE')fail('INVALID_STATE',409);
      const guidance=await tx.get('guidance_versions',uuid(input.guidance_id));if(guidance.conversation_id!==id||guidance.status!=='verified')fail();
      if(input.user_edited_text===undefined && (!Number.isInteger(input.action_index)||!guidance.data.actions[input.action_index]))fail();
      const chosen=input.user_edited_text===undefined?guidance.data.actions[input.action_index]:{title:text(input.user_edited_text,500)};
      const assessment=assessSafety(inputText({text:chosen.title}));if(assessment.route!=='no_signal'){c.revision++;await this.safety(tx,c,assessment);await tx.saveConversation(c);return meta(c,['safety_update']);}
      const plan=await tx.insert('action_plans',c,{guidance_id:guidance.id,chosen_action:chosen,selected_at:new Date().toISOString(),expires_at:new Date(Date.now()+7*86400000).toISOString()},'selected');
      await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5)',[owner,c.project_id,guidance.id,plan.id,'action_plans']);
      return {plan_id:plan.id,resource_revision:0,next_actions:['plan_feedback']};
    });
  }
  async feedback(owner:string,id:string,input:any) {
    keys(record(input),['request_id','expected_revision','status','reported_outcome','burden_change','notes'],['request_id','expected_revision','status','reported_outcome','burden_change']);
    if(!['tried','paused','completed','discarded'].includes(input.status)||!['helpful','unhelpful','mixed','unknown','not_tried'].includes(input.reported_outcome)||!['increased','decreased','same','unknown'].includes(input.burden_change))fail();
    return this.db.write(owner,'feedback:'+id,input,async tx=>{
      await tx.consent();const plan=await tx.get('action_plans',id);revision(input.expected_revision,plan.revision);const {c}=await tx.conversation(plan.conversation_id);
      if(TERMINAL.includes(c.state))fail('INVALID_STATE',409);
      const notes=input.notes===undefined?'':text(input.notes,2000);const report=await tx.insert('plan_feedback',c,{plan_id:id,status:input.status,reported_outcome:input.reported_outcome,burden_change:input.burden_change,notes},'reported');
      plan.status=input.status;plan.revision++;await tx.update('action_plans',plan);
      const assessment=assessSafety(notes);c.revision++;if(assessment.route!=='no_signal')await this.safety(tx,c,assessment);else if(c.state!=='SAFETY_HOLD')c.state='FOLLOW_UP';await tx.saveConversation(c);
      return {feedback_id:report.id,plan_id:id,resource_revision:plan.revision,next_actions:c.state==='SAFETY_HOLD'?['safety_update']:['request_guidance','finish']};
    });
  }
}
