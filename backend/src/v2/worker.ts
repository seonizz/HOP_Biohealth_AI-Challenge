import { randomUUID } from 'node:crypto';
import { V2Database } from './db.ts';
import type { Row, Transaction } from './db.ts';
import { MalssiService } from './service.ts';
import { RunBudget, fitContext, validateExtraction, validateGuidance } from './model.ts';
import type { AgentModel, ModelContext } from './model.ts';
import { V2Error, fail, keys, record } from './errors.ts';
import { question } from './questions.ts';
import { assessSafety } from './safety.ts';
import {CUES,validateAssessment,validateResponse,unknownAssessment,comparison,decidePolicy,decideAlerts,thresholds,RUBRIC_VERSION} from './assessment.ts';
import type {EvidenceMessage,HistoryEntry,Assessment} from './assessment.ts';

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
  async dualTurn(run:Row,controller:AbortController,budget:RunBudget){
    const loaded=await this.context(run),context=loaded.context;
    const runData=loaded.run.data,modelHash=runData.model_artifact_hash,promptVersion=runData.prompt_version,profile=runData.prompt_profile||process.env.HOP_DUAL_PROMPT_PROFILE||'test',setting=thresholds();
    const identity=this.model.identity;
    if(identity&&(identity.model_id!==runData.model_id||identity.checkpoint_sha256.toLowerCase()!==String(modelHash).toLowerCase()||identity.prompt_version!==promptVersion||identity.prompt_profile!==profile))fail('MODEL_IDENTITY_MISMATCH',409);
    const existing=await this.db.transaction(run.owner_id,async tx=>{
      await tx.conversation(run.conversation_id);
      const result=await tx.query('SELECT * FROM turn_assessments WHERE owner_id=$1 AND run_id=$2 AND turn_id=$3',[run.owner_id,run.id,context.message_id]);
      if(!result.rowCount)return null;
      const row=result.rows[0],data=tx.decode(row).data;
      return {assessmentId:row.id,status:row.evaluation_status,normalized:data.normalized,previous_valid:data.previous_valid,trend:data.trend,responsePolicy:data.response_policy,reasons:data.reasons,thresholdVersion:row.threshold_version};
    });
    if(existing){await this.finishDual(run,context,existing,budget,modelHash,promptVersion);return;}
    const messages:EvidenceMessage[]=[...context.recent_messages.filter((item:any)=>item.role==='user').map((item:any)=>({id:item.id,content:item.content,speaker:'supporter' as const})),{id:context.message_id,content:context.current_message,speaker:'supporter' as const}].filter(item=>item.id).slice(-6);
    const evaluationInput={current_message:context.current_message,target:{patient_id:run.project_id,project_id:run.project_id,conversation_id:run.conversation_id,speaker:'supporter'},messages:messages.map((item,index)=>({message_index:index,content:item.content,speaker:item.speaker})),rubric_version:RUBRIC_VERSION};
    const requestedTimeout=Number(process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS||10000);
    if(!Number.isInteger(requestedTimeout)||requestedTimeout<1||requestedTimeout>10000)throw new Error('Invalid HOP_DUAL_EVALUATION_TIMEOUT_MS');
    const bDeadline=Math.min(Date.now()+requestedTimeout,new Date(run.deadline_at).getTime());
    let raw:any=null,normalized:Assessment=unknownAssessment(),attempts=0,bError:string|null=null;
    for(let retry=0;retry<2&&Date.now()<bDeadline;retry++){
      attempts++;
      try{
        budget.check();budget.calls++;
        raw=await this.model.call('assess',{...evaluationInput,_model_request_id:`${run.id}.B.${run.fence_token}.${attempts}`},AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,bDeadline-Date.now()))]));
        normalized=validateAssessment(raw,messages);bError=null;break;
      }catch(error){bError=error instanceof V2Error?error.code:'MODEL_UNAVAILABLE';raw=null;}
    }
    if(!attempts)bError='DEADLINE_EXCEEDED';
    const status=bError?3:CUES.every(key=>normalized[key].score<0)?1:CUES.some(key=>normalized[key].score<0)?2:0;
    const snapshot=await this.db.transaction(run.owner_id,async tx=>{
      const row=await tx.query('SELECT status,fence_token FROM agent_runs WHERE id=$1 AND owner_id=$2 FOR UPDATE',[run.id,run.owner_id]);
      if(!row.rowCount||row.rows[0].status!=='RUNNING'||String(row.rows[0].fence_token)!==String(run.fence_token))return null;
      const {c,p}=await tx.conversation(run.conversation_id),epoch=await tx.query('SELECT consent_epoch FROM users WHERE id=$1',[run.owner_id]),consents=await tx.consent(false);
      if(c.revision!==run.input_revision||p.revision!==run.project_revision||p.memory_revision!==run.memory_revision||c.safety_revision!==run.safety_revision||p.deletion_epoch!==run.deletion_epoch||epoch.rows[0]?.consent_epoch!==run.consent_epoch||c.active_run_id!==run.id||c.state==='SAFETY_HOLD'||!consents.service_processing||!consents.sensitive_processing)return null;
      const rows=await tx.query('SELECT * FROM turn_assessments WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 5',[run.owner_id,c.id]);
      const history:HistoryEntry[]=rows.rows.map(item=>({turn_id:item.turn_id,status:item.evaluation_status,model_sha256:item.model_sha256,prompt_version:item.prompt_version,rubric_version:item.rubric_version,normalized:tx.decode(item).data.normalized,created_at:new Date(item.created_at).toISOString()}));
      const {previous_valid,trend}=comparison(normalized,history,modelHash,promptVersion),responsePolicy=decidePolicy(normalized,status),reasons=decideAlerts(normalized,trend,status,setting),assessmentId=randomUUID();
      await tx.query(`INSERT INTO turn_assessments(id,owner_id,project_id,conversation_id,turn_id,run_id,input_revision,evaluation_status,model_id,model_sha256,prompt_profile,prompt_version,schema_version,rubric_version,threshold_version,attempts,encrypted_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16)`,[assessmentId,run.owner_id,p.id,c.id,context.message_id,run.id,run.input_revision,status,runData.model_id,modelHash,profile,promptVersion,RUBRIC_VERSION,setting.version,attempts,tx.seal(p.id,assessmentId,{raw,normalized,previous_valid,trend,response_policy:responsePolicy,reasons,error_code:bError,message_ids:messages.map(message=>message.id)})]);
      for(const message of messages)await tx.query('INSERT INTO assessment_sources(owner_id,project_id,conversation_id,assessment_id,source_id) VALUES($1,$2,$3,$4,$5)',[run.owner_id,p.id,c.id,assessmentId,message.id]);
      return {assessmentId,status,normalized,previous_valid,trend,responsePolicy,reasons,thresholdVersion:setting.version};
    });
    if(!snapshot)return;
    await this.finishDual(run,context,snapshot,budget,modelHash,promptVersion);
  }
  async finishDual(run:Row,context:ModelContext,snapshot:{assessmentId:string;status:number;normalized:Assessment;previous_valid:any;trend:any;responsePolicy:string;reasons:string[];thresholdVersion:string},budget:RunBudget,modelHash:string,promptVersion:string){
    const answerInput={target:{patient_id:run.project_id,speaker:'supporter'},current_message:context.current_message,recent_messages:context.recent_messages.slice(-6),patient_cue_context:{evaluation_status:snapshot.status,current:snapshot.normalized,previous_valid:snapshot.previous_valid,trend:snapshot.trend,response_policy:snapshot.responsePolicy,assessment_available:snapshot.status!==3,rubric_version:RUBRIC_VERSION,model_sha256:modelHash,prompt_version:promptVersion,do_not_diagnose:true}};
    let answer:{message:string}|null=null,aError:string|null=null;
    try{answer=validateResponse(await budget.call(this.model,'respond',{...answerInput,_model_request_id:`${run.id}.A.${run.fence_token}`}));}
    catch(error){aError=error instanceof V2Error?error.code:'MODEL_UNAVAILABLE';}
    await this.commitDual(run,snapshot.assessmentId,answer,aError,snapshot.reasons,snapshot.thresholdVersion);
  }
  async commitDual(run:Row,assessmentId:string,answer:{message:string}|null,error:string|null,reasons:string[],thresholdVersion:string){
    return this.db.transaction(run.owner_id,async tx=>{
      const saved=await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND owner_id=$2 FOR UPDATE',[run.id,run.owner_id]);
      if(!saved.rowCount)return false;
      const row=saved.rows[0],{c,p}=await tx.conversation(run.conversation_id),epoch=await tx.query('SELECT consent_epoch FROM users WHERE id=$1',[run.owner_id]),consents=await tx.consent(false);
      const valid=String(row.fence_token)===String(run.fence_token)&&row.status==='RUNNING'&&c.revision===run.input_revision&&p.revision===run.project_revision&&p.memory_revision===run.memory_revision&&c.safety_revision===run.safety_revision&&p.deletion_epoch===run.deletion_epoch&&epoch.rows[0]?.consent_epoch===run.consent_epoch&&c.active_run_id===run.id&&c.state!=='SAFETY_HOLD'&&consents.service_processing&&consents.sensitive_processing&&new Date(run.deadline_at).getTime()>Date.now();
      if(!valid){await tx.query('DELETE FROM turn_assessments WHERE id=$1 AND owner_id=$2',[assessmentId,run.owner_id]);if(row.status==='RUNNING')await tx.query("UPDATE agent_runs SET status='SUPERSEDED' WHERE id=$1 AND owner_id=$2",[run.id,run.owner_id]);return false;}
      const payload=tx.decode(row).data;
      if(answer&&!error){
        const message=await tx.insert('v2_messages',c,{role:'assistant',content:answer.message,kind:'dual_reply',turn_id:payload.message_id,assessment_id:assessmentId},'visible');
        await tx.query('UPDATE turn_assessments SET response_id=$3 WHERE id=$1 AND owner_id=$2',[assessmentId,run.owner_id,message.id]);
        for(const reason of reasons)await tx.query('INSERT INTO assessment_alerts(id,owner_id,project_id,conversation_id,assessment_id,turn_id,response_id,reason_code,threshold_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(assessment_id,reason_code) DO NOTHING',[randomUUID(),run.owner_id,p.id,c.id,assessmentId,payload.message_id,message.id,reason,thresholdVersion]);
        payload.result={response_id:message.id,turn_id:payload.message_id};payload.error=null;
        await tx.event(c,'response.completed',message.id);if(reasons.length)await tx.event(c,'alert.available',message.id);
      }else payload.error={code:error||'INVALID_MODEL_OUTPUT',retryable:true};
      await tx.query('UPDATE agent_runs SET status=$3,encrypted_payload=$4 WHERE id=$1 AND owner_id=$2',[run.id,run.owner_id,answer&&!error?'SUCCEEDED':'FAILED',tx.seal(p.id,run.id,payload)]);
      c.active_run_id=null;c.revision++;await tx.saveConversation(c);await tx.event(c,answer&&!error?'conversation.changed':'run.failed',run.id);
      await tx.query('DELETE FROM agent_queue WHERE run_id=$1',[run.id]);
      await tx.query('UPDATE model_slots SET run_id=null,lease_until=null WHERE id=1 AND run_id=$1 AND fence_token=$2',[run.id,run.fence_token]);
      return true;
    });
  }
  async tick() {
    const run=await this.claim();if(!run)return false;
    const controller=new AbortController();let renewing=false;
    const timer=setInterval(()=>{if(renewing)return;renewing=true;this.heartbeat(run).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});},10000);timer.unref();
    const budget=new RunBudget(new Date(run.deadline_at).getTime(),controller.signal);
    let result:any={calls:0,excluded:[]};
    try {
      const kind=await this.db.transaction(run.owner_id,async tx=>{await tx.conversation(run.conversation_id);return tx.decode(run).data.kind;});
      if(kind==='dual_turn'){
        await this.dualTurn(run,controller,budget);
        return true;
      }
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
