import { randomUUID } from 'node:crypto';
import { V2Database } from './db.ts';
import type { Row, Transaction } from './db.ts';
import { MalssiService } from './service.ts';
import { RunBudget, fitContext, validateExtraction, validateGuidance } from './model.ts';
import type { AgentModel, ModelContext } from './model.ts';
import { V2Error, fail, keys, record } from './errors.ts';
import { question } from './questions.ts';
import { assessSafety } from './safety.ts';

export class AgentWorker {
  readonly db:V2Database;readonly service:MalssiService;readonly model:AgentModel;readonly capacity:number;
  constructor(db:V2Database,service:MalssiService,model:AgentModel,capacity=16384){this.db=db;this.service=service;this.model=model;this.capacity=capacity;}
  async claim():Promise<Row|null> {
    const client=await this.db.pool.connect();
    try{
      await client.query('BEGIN');
      const slot=(await client.query('SELECT * FROM model_slots WHERE id=1 FOR UPDATE')).rows[0];
      if((slot.lease_until && new Date(slot.lease_until).getTime()>Date.now()) || (slot.circuit_until && new Date(slot.circuit_until).getTime()>Date.now())) {await client.query('COMMIT');return null;}
      const queued=await client.query('SELECT * FROM agent_queue ORDER BY created_at,run_id FOR UPDATE SKIP LOCKED LIMIT 1');
      if(!queued.rowCount){await client.query('COMMIT');return null;}
      const {run_id,owner_id}=queued.rows[0];
      await client.query("SELECT set_config('app.owner_id',$1,true)",[owner_id]);
      const existing=await client.query('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE',[run_id]);
      const run=existing.rows[0];
      if(!run || !['ACCEPTED','RUNNING'].includes(run.status)){await client.query('DELETE FROM agent_queue WHERE run_id=$1',[run_id]);await client.query('COMMIT');return null;}
      if(new Date(run.deadline_at).getTime()<=Date.now()||run.attempts>=2){
        await client.query("UPDATE agent_runs SET status='FAILED' WHERE id=$1",[run_id]);
        await client.query('UPDATE conversations SET active_run_id=null WHERE active_run_id=$1',[run_id]);
        await client.query('DELETE FROM agent_queue WHERE run_id=$1',[run_id]);await client.query('COMMIT');return null;
      }
      const claimed=(await client.query("UPDATE agent_runs SET status='RUNNING',fence_token=fence_token+1,attempts=attempts+1,lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *",[run_id])).rows[0];
      await client.query("UPDATE model_slots SET run_id=$1,fence_token=$2,lease_until=now()+interval '30 seconds' WHERE id=1",[run_id,claimed.fence_token]);
      await client.query('COMMIT');return claimed;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async heartbeat(run:Row):Promise<boolean> {
    return this.db.transaction(run.owner_id,async tx=>{
      await tx.query('SELECT id FROM model_slots WHERE id=1 FOR UPDATE');
      const r=await tx.query("UPDATE agent_runs SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND owner_id=$2 AND fence_token=$3 AND status='RUNNING' AND deadline_at>now() RETURNING id",[run.id,run.owner_id,run.fence_token]);
      if(!r.rowCount)return false;
      const slot=await tx.query("UPDATE model_slots SET lease_until=now()+interval '30 seconds' WHERE id=1 AND run_id=$1 AND fence_token=$2 RETURNING id",[run.id,run.fence_token]);return Boolean(slot.rowCount);
    });
  }
  async context(run:Row):Promise<{run:Row;context:ModelContext}> {
    return this.db.transaction(run.owner_id,async tx=>{
      const consents=await tx.consent(),{c,p}=await tx.conversation(run.conversation_id);
      const saved=tx.decode(run);
      const suppression=await tx.query('SELECT source_id FROM memory_suppressions WHERE owner_id=$1 AND project_id=$2',[tx.owner,p.id]);
      const suppressed=new Set(suppression.rows.map(r=>r.source_id));
      const messages=(await tx.rows('v2_messages',p.id,c.id)).filter(m=>m.status==='visible'&&!suppressed.has(m.id));
      const current=messages.find(m=>m.id===saved.data.message_id);
      const memories=(await tx.rows('memory_items',p.id)).filter(m=>m.status==='active'&&m.data.confirmation_status==='confirmed'&&Date.parse(m.data.expires_at)>Date.now()&&(m.conversation_id===c.id || consents.cross_session_memory)&&!m.data.source_refs.some((s:any)=>suppressed.has(s.message_id)||suppressed.has(s.answer_revision_id)));
      const answers=(await tx.rows('answer_revisions',p.id,c.id)).filter(a=>a.status==='current'&&!suppressed.has(a.id)&&!suppressed.has(a.data.message_id));
      const sanitize=(value:any):any=>typeof value==='string'?value.replaceAll(p.data.alias,'<SUBJECT>').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,'<CONTACT>').replace(/(?:01[016789]|0[2-6][1-5]?)[- ]?\d{3,4}[- ]?\d{4}/gu,'<CONTACT>'):Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)])):value;
      const context:ModelContext={current_message:current?.data.content || '',message_id:current?.id,goal:c.data.goal,answers:answers.map(a=>({id:a.id,question_id:a.data.question_id,disposition:a.data.disposition,value:a.data.value})),memories:memories.map(m=>({id:m.id,entity:m.data.entity,field_path:m.data.field_path,value:m.data.value,source_type:m.data.source_type})),recent_messages:messages.filter(m=>m.id!==current?.id).slice(-6).map(m=>({id:m.id,role:m.data.role,content:m.data.content})),knowledge:[],safety:[]};
      // Preserve current-message offsets for extraction. Aliases are replaced only in auxiliary context.
      const clean=sanitize({...context,current_message:''});clean.current_message=context.current_message;
      await tx.event(c,'run.started',run.id);
      return {run:saved,context:clean};
    });
  }
  async commit(run:Row,result:any,error?:string) {
    return this.db.transaction(run.owner_id,async tx=>{
      const saved=await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND owner_id=$2 FOR UPDATE',[run.id,run.owner_id]);
      if(!saved.rowCount)return false;
      const row=saved.rows[0];if(String(row.fence_token)!==String(run.fence_token)||row.status!=='RUNNING')return false;
      const {c,p}=await tx.conversation(run.conversation_id),epoch=await tx.query('SELECT consent_epoch FROM users WHERE id=$1',[run.owner_id]);
      const consents=await tx.consent(false);
      const valid=c.revision===run.input_revision&&p.revision===run.project_revision&&p.memory_revision===run.memory_revision&&c.safety_revision===run.safety_revision&&p.deletion_epoch===run.deletion_epoch&&epoch.rows[0]?.consent_epoch===run.consent_epoch&&c.active_run_id===run.id&&c.state!=='SAFETY_HOLD'&&consents.service_processing&&consents.sensitive_processing;
      const late=new Date(run.deadline_at).getTime()<=Date.now();
      if(!valid) {
        await tx.query("UPDATE agent_runs SET status='SUPERSEDED' WHERE id=$1 AND owner_id=$2",[run.id,run.owner_id]);
        if(c.active_run_id===run.id){c.active_run_id=null;c.revision++;await tx.saveConversation(c);await tx.event(c,'conversation.changed',c.id);}
      } else {
        const payload=tx.decode(row).data;let success=!error&&!late;
        if(success) {
          if(result.extraction?.safety_observations.length) {
            await this.service.safety(tx,c,{route:'clarify',subject:'unknown',temporality:'unknown',policy_version:'malssi-safety-v1'},payload.message_id);success=false;error='SAFETY_REQUIRED';
          } else {
            const memoryIds:string[]=[];
            for(const candidate of result.extraction?.assertion_candidates || []) {
              const q=question(candidate.question_id),memory=await tx.insert('memory_items',c,{entity:candidate.entity,kind:q.id.startsWith('C')?'episodic':'semantic',field_path:q.slot||'relationship',value:candidate.value,confirmation_status:'unconfirmed',source_type:candidate.source_type,source_refs:[{message_id:payload.message_id,quote:candidate.quote,start_cp:candidate.start_cp,end_cp:candidate.end_cp}],reported_at:new Date().toISOString(),event_time:{kind:'unknown'},expires_at:new Date(Date.now()+(q.id.startsWith('C')?30:180)*86400000).toISOString(),consent_version:'malssi-consent-v1',extracted_by:payload.model_id},'candidate');
              memoryIds.push(memory.id);
              await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5)',[tx.owner,p.id,payload.message_id,memory.id,'memory_items']);
            }
            if(memoryIds.length){p.memory_revision++;await tx.saveProject(p);}
            if(result.guidance){
              const render=(value:any):any=>typeof value==='string'?value.replaceAll('<SUBJECT>',p.data.alias):Array.isArray(value)?value.map(render):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,render(v)])):value;
              result.guidance=validateGuidance(render(result.guidance),new Set(result.sourceIds || []));
              const guidance=await tx.insert('guidance_versions',c,result.guidance,'verified');
              for(const source of result.sourceIds || []) await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[tx.owner,p.id,source,guidance.id,'guidance_versions']);
              c.state='GUIDANCE';c.data.pending_instance_id=null;
              payload.result={guidance_id:guidance.id,guidance:result.guidance,personalization:'limited',memory_ids:memoryIds};
              await tx.event(c,'guidance.ready',guidance.id);
            } else {await this.service.ask(tx,c,p);payload.result={memory_ids:memoryIds,question_instance_id:c.data.pending_instance_id};}
            // A summary is a lossless report cache, never an LLM rewrite of the source.
            if(memoryIds.length){const summary=await tx.insert('conversation_summaries',c,{confirmed_reports:[],unconfirmed_reports:result.extraction.assertion_candidates.map((v:any)=>({entity:v.entity,quote:v.quote,source_type:v.source_type})),changes:[],open_questions:[],plans:[],source_message_ids:[payload.message_id],covered_through_sequence:0,summary_version:1,memory_ids:memoryIds},'valid');for(const source of [payload.message_id,...memoryIds])await tx.query('INSERT INTO memory_derivations(owner_id,project_id,parent_id,child_id,child_type) VALUES($1,$2,$3,$4,$5)',[tx.owner,p.id,source,summary.id,'conversation_summaries']);payload.result.summary_id=summary.id;}
          }
        }
        payload.error=success?null:{code:late?'DEADLINE_EXCEEDED':error || 'INVALID_MODEL_OUTPUT',retryable:['MODEL_UNAVAILABLE','DEADLINE_EXCEEDED'].includes(error || '')};
        payload.decision_log={reason_code:success?'VERIFIED_RESULT':'MODEL_FAILED',excluded_ids:result?.excluded || [],calls:result?.calls || 0};
        await tx.query('UPDATE agent_runs SET status=$3,encrypted_payload=$4 WHERE id=$1 AND owner_id=$2',[run.id,run.owner_id,success?'SUCCEEDED':'FAILED',tx.seal(p.id,run.id,payload)]);
        c.active_run_id=null;c.revision++;await tx.saveConversation(c);await tx.event(c,success?'conversation.changed':'run.failed',run.id);
      }
      await tx.query('DELETE FROM agent_queue WHERE run_id=$1',[run.id]);
      await tx.query("UPDATE model_slots SET run_id=null,lease_until=null,consecutive_failures=CASE WHEN $3 THEN consecutive_failures+1 ELSE 0 END,circuit_until=CASE WHEN $3 AND consecutive_failures>=2 THEN now()+interval '60 seconds' ELSE NULL END WHERE id=1 AND run_id=$1 AND fence_token=$2",[run.id,run.fence_token,Boolean(error)]);
      return valid;
    });
  }
  async tick() {
    const run=await this.claim();if(!run)return false;
    const controller=new AbortController();let renewing=false;
    const timer=setInterval(()=>{if(renewing)return;renewing=true;this.heartbeat(run).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});},10000);timer.unref();
    const budget=new RunBudget(new Date(run.deadline_at).getTime(),controller.signal);
    let result:any={calls:0,excluded:[]};
    try {
      const loaded=await this.context(run);const fitted=await fitContext(this.model,loaded.context,this.capacity,controller.signal);result.excluded=fitted.excluded;
      const context=fitted.context;
      const extraction=context.current_message?validateExtraction(await budget.call(this.model,'extract',context),context):null;
      result.extraction=extraction;
      if(loaded.run.data.kind==='request_guidance' && !extraction?.safety_observations.length) {
        const sourceIds=new Set<string>([...context.answers,...context.memories,...context.recent_messages].map((x:any)=>x.id));if(context.message_id)sourceIds.add(context.message_id);
        let draft=await budget.call(this.model,'guide',context),approved=false;
        for(let attempt=0;attempt<2;attempt++) {
          let issues:string[]=[];
          try{validateGuidance(draft,sourceIds);}catch{issues=['구조·근거·안전 요구에 맞게 수정해 주세요.'];}
          if(!issues.length) {
            const verification=record(await budget.call(this.model,'verify',{...context,draft}));keys(verification,['approved','issues'],['approved','issues']);
            if(typeof verification.approved!=='boolean'||!Array.isArray(verification.issues)||verification.issues.some((v:any)=>typeof v!=='string'||!v.trim())||verification.issues.length>8||(verification.approved&&verification.issues.length))fail('INVALID_MODEL_OUTPUT');
            approved=verification.approved;issues=verification.issues;
          }
          if(approved)break;
          if(attempt===0)draft=await budget.call(this.model,'guide',{...context,previous_draft:draft,correction_requirements:issues});
        }
        if(!approved)fail('FAILED_VERIFICATION');
        result.guidance=draft;result.sourceIds=[...sourceIds];
      }
      result.calls=budget.calls;await this.commit(run,result);
    }catch(e){result.calls=budget.calls;await this.commit(run,result,e instanceof V2Error?e.code:'MODEL_UNAVAILABLE');}
    finally {clearInterval(timer);controller.abort();await this.db.pool.query('UPDATE model_slots SET run_id=null,lease_until=null WHERE id=1 AND run_id=$1 AND fence_token=$2',[run.id,run.fence_token]);}
    return true;
  }
}
