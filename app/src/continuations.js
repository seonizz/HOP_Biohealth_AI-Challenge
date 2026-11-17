import {randomUUID, createHash} from 'node:crypto';
import {HttpError, object, string} from './errors.js';
import {hasAnswerContent} from './catalog.js';
import {continuationInput, continuationCardContext, validateContinuation} from './continuation-model.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const conflict=()=>new HttpError(409,'REVISION_CONFLICT','대화가 변경됐어요. 최신 내용을 확인해 주세요.');
const missing=()=>new HttpError(404,'NOT_FOUND','대화를 찾을 수 없어요.');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const urgentText='지금 즉각적인 위험이 있다면 대화를 이어가기보다 응급 도움을 요청하고, 당신의 안전을 먼저 확보해 주세요. 혼자 감당하지 않도록 주변 도움을 함께 요청해 주세요.';
const revision=value=>{if(!Number.isInteger(value)||value<0)throw new HttpError(422,'INVALID_REVISION','현재 대화 버전을 확인해 주세요.');return value;};
const requestId=value=>{if(typeof value!=='string'||!uuid.test(value))throw new HttpError(422,'INVALID_REQUEST_ID','요청을 다시 준비해 주세요.');return value;};
const publicMessage=({id,role,text,kind,clarification,skipped})=>({id,role,text,kind,...(clarification?{clarification}:{}),...(skipped?{skipped:true}:{})});
export const continuationView=row=>({id:row.id,source_record_id:row.source_record_id,revision:row.revision,
  status:row.state.status,messages:row.state.messages.map(publicMessage),pending:row.state.pending||null,
  summary:row.state.summary||null,cards:row.state.cards||[],safety_urgent:Boolean(row.state.safety_urgent)});

export function createContinuations({store,gateway,sharedRun,subscribeRun,resolveGateway=()=>gateway}) {
  const runs=new Map();
  const cancel=(owner,intakeId,reason=conflict())=>{
    for(const [key,run] of runs) if(run.owner===owner&&(intakeId===undefined||run.intakeId===intakeId)) {
      run.controller.abort(reason);runs.delete(key);
    }
  };
  const cancelSession=(owner,id,reason=conflict())=>{
    for(const [key,run] of runs) if(run.owner===owner&&run.id===id) {run.controller.abort(reason);runs.delete(key);}
  };
  const available=selected=>{
    if(typeof selected?.continueConversation!=='function')throw new HttpError(503,'MODEL_NOT_CONNECTED','모델 연결 설정을 확인해 주세요.');
  };
  async function sources(owner,row) {
    const {record,messages}=await store.continuationSources(owner,row.id,row.revision);
    continuationInput(record,messages); // Fail closed on legacy records with no source context.
    return {record,messages};
  }
  function normalized(action,input) {
    const allowed={messages:['text','reply_to','skipped'],corrections:['answer_ref','replacement'],cards:[],complete:[]}[action];
    object(input,['revision','request_id',...allowed]);revision(input.revision);requestId(input.request_id);
    if(action==='messages') {
      if(input.skipped!==undefined&&typeof input.skipped!=='boolean')throw new HttpError(422,'INVALID_INPUT','건너뛰기 값을 확인해 주세요.');
      const text=string(input.text??'',10000);
      if(!input.skipped&&!hasAnswerContent(text))throw new HttpError(422,'ANSWER_REQUIRED','궁금한 점이나 추가 상황을 적어 주세요.');
      if(input.skipped&&hasAnswerContent(text))throw new HttpError(422,'INVALID_INPUT','건너뛰기와 답변은 함께 보낼 수 없어요.');
      if(input.reply_to!==undefined&&(typeof input.reply_to!=='string'||!uuid.test(input.reply_to)))throw new HttpError(422,'INVALID_INPUT','확인 질문을 다시 불러와 주세요.');
      return {text,skipped:input.skipped===true,reply_to:input.reply_to??null};
    }
    if(action==='corrections') {
      requestId(input.answer_ref);const replacement=string(input.replacement,10000,false);
      if(!hasAnswerContent(replacement))throw new HttpError(422,'ANSWER_REQUIRED','정정할 내용을 적어 주세요.');
      return {answer_ref:input.answer_ref,replacement};
    }
    return {};
  }
  function previous(row,id,action,hash) {
    const saved=row.state.requests[id];
    if(!saved)return null;
    if(saved.action!==action||saved.hash!==hash||saved.status==='invalidated')throw conflict();
    return saved;
  }
  function response(row,saved) {
    const card=saved?.card_id&&(row.state.cards||[]).find(c=>c.id===saved.card_id);
    return {continuation:continuationView(row),...(card?{card}:{})};
  }
  function invalidatePending(state) {
    if(state.pending&&state.requests[state.pending.request_id])state.requests[state.pending.request_id].status='invalidated';
    state.pending=null;
  }
  async function mutate(owner,id,action,input,{signal,requestId:traceId}={}) {
    const data=normalized(action,input), hash=fingerprint(data), rid=input.request_id;
    let row=await store.getContinuation(owner,id), saved=previous(row,rid,action,hash);
    if(saved?.status==='done')return response(row,saved);
    if(action==='complete'||action==='corrections') {
      if(row.revision!==input.revision)throw conflict();
      cancelSession(owner,id);
      row=await store.updateContinuation(owner,id,row.revision,state=>{
        const unreviewedMessage=state.pending?.action==='messages';
        invalidatePending(state);
        if(action==='corrections') {
          const message=state.messages.find(m=>m.id===data.answer_ref&&m.role==='user'&&!m.skipped);
          if(!message)throw new HttpError(422,'INVALID_MESSAGE','정정할 사용자 메시지를 확인해 주세요.');
          message.edits=[...(message.edits||[]),message.text];message.text=data.replacement;
          message.kind='correction';
          // Every derived response may depend on the corrected text. Retain
          // user reports, discard answers/cards instead of displaying stale advice.
          state.messages=state.messages.filter(m=>m.role==='user');state.cards=[];state.reviewed=null;
          state.summary=null;state.safety_urgent=false;
          for(const item of Object.values(state.requests))item.status='invalidated';
          if(state.status!=='completed')state.status='active';
        } else {
          state.status='completed';
          const reports=unreviewedMessage?[]:state.reviewed?.facts||[];
          state.summary=reports.length?reports.map(f=>f.quote).join('\n'):'이번 대화를 마쳤어요. 주고받은 내용은 아래에서 다시 확인할 수 있어요.';
        }
        state.requests[rid]={action,hash,status:'done'};
        return state;
      },{invalidateLater:action==='corrections'});
      for(const later of row.invalidated_ids||[])cancelSession(owner,later);
      return response(row);
    }
    available(resolveGateway(await store.record(owner,row.source_record_id)));
    if(!saved) {
      if(row.revision!==input.revision)throw conflict();
      if(row.state.pending)throw new HttpError(409,'CONTINUATION_PENDING','진행 중인 답변을 다시 시도하거나 대화를 마쳐 주세요.');
      if(action==='messages'&&row.state.status==='completed')throw new HttpError(409,'CONTINUATION_COMPLETE','마친 대화예요. 새 회차에서 이어서 질문해 주세요.');
      if(action==='messages'&&(data.skipped||data.reply_to)) {
        const latest=row.state.messages.at(-1);
        if(!latest?.clarification||data.reply_to!==latest.id)throw new HttpError(422,'INVALID_CLARIFICATION','현재 확인 질문을 선택해 주세요.');
      }
      if(action==='cards'&&!row.state.messages.some(m=>m.role==='user'&&!m.skipped))throw new HttpError(409,'NO_NEW_FACTS','추가 상황을 먼저 들려주세요.');
      try {
        row=await store.updateContinuation(owner,id,row.revision,state=>{
          if(action==='messages') {
            state.messages.push({id:randomUUID(),role:'user',kind:data.skipped?'skipped':'question',text:data.text,skipped:data.skipped,reply_to:data.reply_to});
            // A new report can correct any previously reviewed fact. Until its
            // own review succeeds, no old fact set may summarize this revision.
            state.reviewed=null;
          }
          state.requests[rid]={action,hash,status:'pending'};
          state.pending={action,request_id:rid,input:{...input},resume_status:state.status};
          // A completed older round may generate cards while a newer round is
          // active. Its temporary work must not acquire the unique active slot.
          if(state.status!=='completed')state.status='pending';
          return state;
        });
      }catch(error){
        if(error.code!=='REVISION_CONFLICT')throw error;
        row=await store.getContinuation(owner,id);saved=previous(row,rid,action,hash);
        if(!saved)throw error;
        if(saved.status==='done')return response(row,saved);
      }
    } else if(!row.state.pending||row.state.pending.request_id!==rid)throw conflict();
    const pendingRow=row;
    const run=async runSignal=>{
      try {
        const inputSources=await sources(owner,pendingRow);
        const selectedGateway=resolveGateway(inputSources.record);available(selectedGateway);
        runSignal.throwIfAborted();
        const reviewed=await selectedGateway.continueConversation(inputSources,{signal:runSignal,requestId:traceId});
        // Validate again at the persistence boundary, including injected gateways.
        const {safety,...draft}=reviewed;
        validateContinuation(draft,continuationInput(inputSources.record,inputSources.messages));
        if(typeof safety?.urgent!=='boolean')throw new HttpError(502,'MODEL_INVALID_RESPONSE','안전 검토 결과를 확인하지 못했어요.');
        runSignal.throwIfAborted();
        let card;
        if(action==='cards') {
          if(!draft.facts.length&&!safety.urgent)throw new HttpError(409,'NO_NEW_FACTS','새 카드에 반영할 실제 추가 상황을 먼저 들려주세요. 가정이나 질문만으로 사실을 만들지 않아요.');
          if(typeof selectedGateway.respond!=='function')throw new HttpError(503,'MODEL_NOT_CONNECTED','카드 생성 모델을 확인해 주세요.');
          const context=continuationCardContext(inputSources.record,inputSources.messages,draft,safety);
          const result=await selectedGateway.respond(context,null,{signal:runSignal,requestId:traceId});
          runSignal.throwIfAborted();
          if(safety.urgent&&!result.assessment.safety)throw new HttpError(502,'MODEL_INVALID_RESPONSE','현재 안전 상황을 반영한 카드를 다시 준비해 주세요.');
          card={id:randomUUID(),date:new Date().toISOString(),
            profile:{...context.profileInput,scores:{},safety:result.assessment.safety,symptoms:[],risks:[],protect:[]},
            guide:result.guide,...(result.relationship_analysis?{relationship_analysis:result.relationship_analysis}:{}),
            ...(result.conversation_detail?{conversation_detail:result.conversation_detail}:{}),
            source_revision:pendingRow.revision,provenance:{kind:'model',model:selectedGateway.model||'unknown',source_record_id:row.source_record_id,
              ...(inputSources.record.provenance?.model_profile_id!==undefined?{model_profile_id:inputSources.record.provenance.model_profile_id}:{})}};
        }
        row=await store.updateContinuation(owner,id,pendingRow.revision,state=>{
          runSignal.throwIfAborted();
          if(state.pending?.request_id!==rid)throw conflict();
          const resume=state.pending.resume_status;
          state.pending=null;state.reviewed=draft;state.safety_urgent=safety.urgent;
          state.status=safety.urgent||resume==='completed'?'completed':'active';
          if(action==='messages')state.messages.push({id:randomUUID(),role:'assistant',kind:'response',
            text:safety.urgent?urgentText:draft.answer,clarification:safety.urgent?null:draft.clarification});
          if(card) {state.cards||=[];state.cards.push(card);}
          if(safety.urgent)state.summary=urgentText;
          state.requests[rid]={action,hash,status:'done',...(card?{card_id:card.id}:{})};
          return state;
        });
        return response(row,row.state.requests[rid]);
      }catch(error){
        // Keep failed model input pending for same-ID retry. A no-new-facts
        // decision is terminal for this card attempt, allowing more messages.
        if(error.code==='NO_NEW_FACTS') {
          await store.updateContinuation(owner,id,pendingRow.revision,state=>{
            if(state.pending?.request_id!==rid)throw conflict();
            state.status=state.pending.resume_status;state.pending=null;
            state.requests[rid].status='invalidated';return state;
          });
        }
        throw error;
      }
    };
    return subscribeRun(sharedRun(runs,`${owner}:${id}:${row.revision}`,
      {owner,id,intakeId:row.source_intake_id,revision:row.revision},run),signal);
  }
  return {
    cancel,
    async create(owner,recordId,input){
      object(input,['request_id','conversation_epoch']);requestId(input.request_id);revision(input.conversation_epoch);
      // Check source compatibility before allocating a new session.
      continuationInput(await store.record(owner,recordId),[]);
      return {continuation:continuationView(await store.createContinuation(owner,recordId,input.conversation_epoch,input.request_id))};
    },
    async list(owner,recordId){return {continuations:(await store.listContinuations(owner,recordId)).map(({owner:_owner,...row})=>row)};},
    async get(owner,id){return {continuation:continuationView(await store.getContinuation(owner,id))};},
    mutate,
    async prune(){
      for(const run of runs.values()) {
        try{await store.getContinuation(run.owner,run.id);}
        catch(error){if(error.status===404)cancelSession(run.owner,run.id,missing());else throw error;}
      }
    },
    async remove(owner,id){
      const result=await store.deleteContinuation(owner,id);cancelSession(owner,id,missing());
      for(const later of result.invalidated_ids||[])cancelSession(owner,later);
      return {deleted:true};
    },
    close(){for(const run of runs.values())run.controller.abort();runs.clear();}
  };
}
