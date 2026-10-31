import assert from 'node:assert/strict';
import {evidenceWireFixture} from '../evidence-wire.fixture.js';
import {safetyReviewFixture} from './safety-review.js';

const field=(id,text)=>({id,question:id,status:'answered',text,rawText:text,custom:''});
export const scopeContext=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','밤에 계획표를 고치지만 지금 해칠 생각은 없다고 말했어요.')}},
  supporter:{fields:{feeling:field('feeling','제 생활도 돌보며 이야기를 듣고 싶어요.')}},
  user_goal:{message:field('want','원할 때 이야기를 듣고 싶어요.')},latest_answer:{subject:'patient',question_id:'mood'},answered_count:4,
  adaptive_questions:true,question_candidates:[{id:'daily',subject:'patient',question:'생활은 어떤가요?',required:false,noSkip:false},
    {id:'extra',subject:'patient',question:'추가할 이야기가 있나요?'}],
  clarification_candidates:[{id:'support_requested',subject:'patient',question:'원하는 도움이 있나요?'}]});
const ref=ctx=>({subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.rawText});
export const scopeDraft=ctx=>({state:{patient_state:{facts:[{...ref(ctx),certainty:'reported'}],unknowns:['이용자가 함께할 수 있는 시간']},
  name_index:{alias:'지민',source_question_id:'name',quote:'지민'},relationship_memory:{patient:[{certainty:'reported',evidence:[ref(ctx)]}],
    supporter:[],relationship:[],unknowns:['현재 원하는 도움의 범위']}},questions:ctx.adaptive_questions?{
      skip:[{question_id:'daily',reason:'already_covered',explanation:'앞서 생활 장면을 보고했습니다.',evidence:[ref(ctx)]}],
      clarify:['support_requested'],safety:{urgent:false,evidence_ids:[]}}:null});
export const scopeBlock=(value,block)=>structuredClone(block==='name_index'?{name_index:value.state.name_index}:block==='questions'?value.questions:value.state[block]);
export const scopeReview=(data,reject=false)=>data.proposed_safety?safetyReviewFixture(data):data.claims?
  {audits:data.claims.map(({id})=>({id,verdict:'supported',reason:'합성 원문 대조'}))}:{state:{approved:!reject,
    issues:reject?[{reason:'현재 범위를 다시 검토해야 합니다.',repair:'원문의 범위를 다시 선택하세요.'}]:[],
    audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'
      ?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},questions:null,safety:null};

// Only provider output is synthetic; gateway schemas, retries and independent
// review orchestration execute. No real HTTP or model call is made.
export function scopeProbe(Gateway,{enabled,blockScopedInputs=false,ctx:givenContext,value:givenValue,response,stateMode='combined_blocks',adaptive=true,rejectOnce=false,rejectAlways=false,
  malformedOnce=false,fallback=false}={}) {
  const ctx=givenContext?structuredClone(givenContext):scopeContext();ctx.adaptive_questions=adaptive;
  const value=givenValue?structuredClone(givenValue):scopeDraft(ctx),calls=[],requests=[];let reviews=0,patientAttempts=0;
  const gateway=new Gateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-only',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,stateMode,
    ...(enabled===undefined?{}:{stageScopedQuestionRules:enabled}),blockScopedInputs,diagnosticLogger:null,
    fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      const call={...input,prompt:body.messages[0].content};calls.push(call);requests.push(body);let output;
      if(call.data.output_block){
        output=scopeBlock(value,call.data.output_block);
        if(malformedOnce&&call.data.output_block==='patient_state'&&++patientAttempts===1)delete output.unknowns;
      }else if(call.stage.startsWith('turn_draft')){
        output=structuredClone(value);if(fallback)delete output.state.relationship_memory.unknowns;
      }else if(call.stage.includes('review'))output=scopeReview(call.data,
        call.stage.startsWith('turn_review')&&(rejectAlways||rejectOnce&&++reviews===1));
      else assert.fail('Unexpected scope probe stage '+call.stage);
      const changed=await response?.(call,output);
      if(changed instanceof Response)return changed;
      if(changed!==undefined)output=changed;
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(call,output))}}]}));
    }});
  return {ctx,value,calls,requests,gateway,run:options=>gateway.updateState(ctx,null,options)};
}
