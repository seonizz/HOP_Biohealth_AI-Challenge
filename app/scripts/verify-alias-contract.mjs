import assert from 'node:assert/strict';
import {configuredModelGateway} from '../src/model-config.js';
import {createIntake,currentView,answerIntake,prepareModelAnswer,completeModelAnswer,buildContext} from '../src/intake.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {modelHttpFetch} from '../src/model-http.js';
import {assertStableSingleCall} from '../src/model-promotion.js';
import {modelResponseFormat} from '../src/model-schema.js';

export const ALIAS_REPORT='친구의 가명은 지민이에요.';

// The v3 relationship answer can report an alias without creating a source
// for the legacy, dedicated name-question index.
export function assertAliasContract(value,nameSchema){
  assert.deepEqual(nameSchema,{type:'null'},'v3 has no dedicated name source');
  assert.equal(value.name_index,null,'v3 cannot manufacture a legacy name index');
  assert.ok(value.patient_state?.facts?.some(fact=>fact.subject==='patient'&&fact.question_id==='q3_02'&&
    fact.certainty==='reported'&&fact.quote===ALIAS_REPORT),'Exact reported alias source must survive');
}

export function aliasContractScenario(){
  const input=(state,text)=>{const question=currentView(state).question;return {
    question_id:question.id,instance_id:question.instance_id,follow_up:Boolean(question.follow_up),
    response_event:'answered',...(question.type==='text'?{text}:{custom:text,selected:[]}),
  };};
  let state=createIntake(activeQuestionSet);
  state=answerIntake(state,input(state,'친구에게 부담 없이 이야기를 시작할 방법을 찾고 싶어요.'));
  assert.equal(currentView(state).question.id,'q3_03');
  // This qualification deliberately selects the optional relationship source;
  // ordinary new conversations finish after the core when no choice is made.
  const scene=prepareModelAnswer(state,input(state,'호칭을 넣어 편지를 쓰려는데 상대를 어떻게 부를지 정리하고 싶어요.'),0);
  const source=buildContext(scene).patient.fields.q3_03;
  state=completeModelAnswer(scene,{name_index:null,patient_state:{},question_plan:{skip:[]},personalization:{
    kind:'next',question_id:'q3_02',subject:'patient',source_question_id:source.id,source_revision:source.source_revision,
    component:'rawText',quote:source.rawText,quote_start:0,quote_end:Array.from(source.rawText).length,
    question:null,focus:null,reason:'요청한 편지에 쓸 호칭이 아직 없어 상대를 부르는 표현을 확인합니다.',
  }});
  assert.equal(currentView(state).question.id,'q3_02');
  const pending=prepareModelAnswer(state,input(state,ALIAS_REPORT),0),context=buildContext(pending);
  const nameSchema=modelResponseFormat(context).json_schema.schema.properties.name_index;
  assert.deepEqual(nameSchema,{type:'null'});
  return {pending,context,nameSchema};
}

// Tap only bytes consumed by the real gateway. Unlike response.clone().json(),
// this preserves both ordinary JSON and SSE and cancels an unfinished upstream
// stream when the gateway's JSON-completion boundary cancels its reader.
function captureResponse(response,capture){
  capture.status=response.status;capture.contentType=response.headers.get('content-type');capture.chunks=[];
  if(!response.body)return response;
  const reader=response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller){
      try{
        const part=await reader.read();
        if(part.done){reader.releaseLock();controller.close();}
        else {capture.chunks.push(part.value.slice());controller.enqueue(part.value);}
      }catch(error){reader.releaseLock();controller.error(error);}
    },
    async cancel(reason){try{await reader.cancel(reason);}finally{reader.releaseLock();}},
  }),{status:response.status,statusText:response.statusText,headers:response.headers});
}

function replayResponse(capture){
  const bytes=new Uint8Array(capture.chunks.reduce((size,chunk)=>size+chunk.length,0));
  let offset=0;for(const chunk of capture.chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Response(bytes,{status:capture.status,headers:capture.contentType?{'content-type':capture.contentType}:{}});
}

// Importing this module performs no requests. A caller owns endpoint authority,
// cancellation and any ignored runtime receipt destination. The audit reuses
// the exact writer response; it may never regenerate a rejected draft.
export async function verifyAliasContract({env=process.env,fetchImpl=modelHttpFetch,signal}={}){
  const started=performance.now(),capture={};let calls=0,audits=0,value,reviewed,nameSchema;
  const receipt={id:'explicit_alias_v3_contract',synthetic:true,status:'running',started_at:new Date().toISOString()};
  try{
    if(env.MODEL_SINGLE_CALL_QUESTION_ONLY==='true')throw Object.assign(
      new Error('Combined-draft alias qualification does not support deferred question-only state'),
      {code:'UNSUPPORTED_QUALIFICATION_MODE'});
    const scenario=aliasContractScenario();nameSchema=scenario.nameSchema;
    const shared={...env,MODEL_STATE_MODE:'combined',MODEL_BUNDLE_COMBINED_TURN_REVIEWS:'false',MODEL_BUNDLE_TURN_REVIEWS:'false'};
    const gateway=configuredModelGateway({env:{...shared,MODEL_SINGLE_CALL_TURNS:'true'},retryFailures:false,diagnosticLogger:null,
      fetchImpl:async(url,init)=>{
        if(init.method!=='POST')return fetchImpl(url,init);
        assert.equal(++calls,1,'Answer route attempted more than one model call');
        return captureResponse(await fetchImpl(url,init),capture);
      }});
    assert.equal(gateway?.singleCallTurns,true);
    value=await gateway.updateState(scenario.context,null,{signal});
    assert.equal(calls,1);assert.equal(value.state_agent.reviewed,false);assertAliasContract(value,nameSchema);
    completeModelAnswer(scenario.pending,value);
    let replays=0;
    const reviewer=configuredModelGateway({env:{...shared,MODEL_SINGLE_CALL_TURNS:'false'},retryFailures:false,diagnosticLogger:null,
      fetchImpl:async(url,init)=>{
        if(init.method==='POST'){
          const payload=JSON.parse(JSON.parse(init.body).messages.at(-1).content);
          if(payload.stage==='turn_draft'){
            assert.equal(++replays,1,'Independent audit attempted to regenerate the alias draft');
            return replayResponse(capture);
          }
          assert.ok(!payload.stage.startsWith('turn_draft'),'Independent audit rejected the original alias draft; regeneration forbidden');
          audits++;
        }
        return fetchImpl(url,init);
      }});
    reviewed=await reviewer.updateState(scenario.context,null,{signal});
    assert.ok(audits>0,'An independent audit must run');
    assertStableSingleCall(value,reviewed);assertAliasContract(reviewed,nameSchema);
    receipt.status='passed';
  }catch(error){receipt.status='failed';receipt.error={code:error.code??error.name,reason:error.modelReason??error.message};}
  return {...receipt,value,reviewed,name_schema:nameSchema,answer_model_calls:calls,offline_audit_calls:audits,
    seconds:(performance.now()-started)/1000,completed_at:new Date().toISOString()};
}
