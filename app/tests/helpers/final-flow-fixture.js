import assert from 'node:assert/strict';
import {ModelGateway} from '../../src/model.js';
import {COMMON} from '../../src/relationship-prompts.js';
import {evidenceWireFixture} from '../evidence-wire.fixture.js';
import {restoreReviewSources} from '../../src/final-review-bundle.js';

import {compactReviewTransport} from '../../src/compact-review-transport.js';

// Shared synthetic-only real Gateway fixture; no model/network/database calls.
export const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
export const ref=()=>({subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요'});
export const name=()=>({alias:'지민',source_question_id:'name',quote:'지민'});
export const memory=()=>({summary:'대상자와 이용자의 상황입니다.',facts:[{...ref(),interpretation:'이용자가 관찰했습니다.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'});
export const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','자녀'),mood:field('mood','밤에 계획표를 고쳐요')}},
  supporter:{fields:{feeling:field('feeling','무력하고 걱정돼요')}},user_goal:{message:field('want','이해하고 싶어요')},
  relationship_state:{patient:[{interpretation:'밤에 계획표를 고친다는 관찰입니다.',evidence:[ref()],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]},
  agent_state:memory(),name_index:name(),answered_count:4,question_candidates:[]});
export const analysis=()=>({observations:{patient:[ref()],supporter:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]},
  relationship:{label:'자녀',supporter_role:'부모',dynamics:[{interpretation:'걱정에 응답하는 방식을 살펴볼 수 있어요.',evidence:[ref()],certainty:'tentative'}],strengths:[],boundaries:[]},
  unknowns:['대상자의 도움 의향은 미확인입니다.'],safety:{urgent:false,evidence_ids:[]}});
export const plan=()=>({voice:'부모가 자녀에게 건네는 말',opening_evidence:[ref()],user_intent:'이해하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',
  supporter_care:['자신의 휴식도 살펴보세요.'],avoid_patterns:['재촉 대신 허락 구하기'],next_step:'다음 대화 시간을 함께 정하기'});
export const avoid={avoid_phrase:'재촉하는 말.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'};
export const guide=()=>({guide:{top:'통합',script:'지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',
  doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하는 말. 이유: 대답할 여유를 남겨야 합니다. 대신 편한 시간을 물어보세요.'],
  next:'다음 대화 시간을 함께 정하고 자신도 쉬어 보세요.',care:{feel:'무력하고 걱정된 마음을 들려주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
export const reviewStages=['analysis_review','plan_review',
  ...['script','care','doList','avoid','next'].map(key=>'speech_review_card_'+key),
  'support_review_card_care','support_review_card_next','guide_quality','speech_review','support_review','guide_review','speech_detail_review'];
export const audits=claims=>(claims||[]).map(claim=>({id:claim.id,
  verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':claim.certainty==='tentative'?'plausible':'supported',
  reason:'합성 원문과 선택 가능한 제안입니다.'}));
export const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

export function fixture({reuseFinalDraft=true,compactReviewInputs=false,scopedQualityRefinement=false,bundleFinalReviews=true,
  shareReviewSources=false,repairReviewBundleTasks=false,extendedFinalEvidenceIds=false,bundleAnalysisPlan=false,compactReviewOutput=false,ctx=context(),validGuide=guide(),response:override,httpOverride,wireOverride}={}) {
  const requests=[],responses=[],events=[],logicalRequests=[],originals=new Map();
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined',reuseFinalDraft,compactReviewInputs,scopedQualityRefinement,bundleFinalReviews,
    shareReviewSources,repairReviewBundleTasks,extendedFinalEvidenceIds,bundleAnalysisPlan,compactReviewOutput,
    timeoutMs:0,retryFailures:false,diagnosticLogger:null,fetchImpl:async (_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      requests.push({body,input:structuredClone(input)});
      const original=originals.get(input.stage);
      const codec=(compactReviewOutput||gateway.reviewGateway?.compactReviewOutput)&&original?compactReviewTransport(original):null;
      const logicalSchema=codec?original.schema:input.output_schema;
      input.data=restoreReviewSources(input.data);
      const intercepted=await httpOverride?.(input,body);
      if(intercepted!==undefined)return intercepted;
      const produce=async task=>{
      const {stage,data,output_schema:schema}=task;
      logicalRequests.push(task);
      let payload;
      if(stage==='final_analysis_plan_draft'){payload={analysis:analysis(),plan:plan()};if(!schema.properties.analysis.properties.safety)delete payload.analysis.safety;}
      else if(/^(?:relationship_analysis|analysis_repair)(?:_|$)/u.test(stage)) {
        payload=analysis();if(!schema.properties.safety)delete payload.safety;
      }
      else if(/^communication_plan(?:_|$)/u.test(stage))payload=plan();
      else if(/^guide_(?:write|refine)(?:_|$)/u.test(stage))payload=structuredClone(validGuide);
      else if(/^guide_repair(?:_|$)/u.test(stage)) {
        const key=Object.keys(schema.properties)[0];
        payload=key==='avoid'?{avoid:[structuredClone(avoid)]}:{[key]:structuredClone(validGuide.guide[key])};
      } else if(/^guide_quality(?:_|$)/u.test(stage))payload={improvements:[]};
      else if(/^continuation_context_review(?:_|$)/u.test(stage))payload=null; // Supplied explicitly by continuation scenarios.
      else if(/^(?:analysis_review|speech_review|support_review|speech_detail_review)(?:_|$)/u.test(stage))payload={approved:true,issues:[],audits:audits(data.claims)};
      else if(/^(?:plan_review|guide_review)(?:_|$)/u.test(stage))payload={approved:true,issues:[]};
      else if(stage.startsWith('card_')) {
        const key=Object.keys(schema.properties)[0];
        payload=key==='avoid'?{avoid:[structuredClone(avoid)]}:{[key]:structuredClone(validGuide.guide[key])};
      } else if(/^speech_(?:opening|listening|offer)(?:_|$)/u.test(stage))payload=Object.fromEntries(Object.keys(schema.properties).map(key=>[key,'원문을 확인하고 이야기를 듣고 싶어.']));
      else if(/^speech_write(?:_|$)/u.test(stage))payload={script:validGuide.guide.script};
      else if(/^speech_detail(?:_|$)/u.test(stage))payload={opening_end:1,listening_end:data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}]))};
      else assert.fail('Unexpected stage '+stage);
      const replaced=await override?.(task,body,payload);
      return replaced===undefined?payload:replaced;
      };
      let payload;
      if(input.data.tasks){
        payload={};
        for(const task of input.data.tasks){
          const data={...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,input.data.shared_inputs[id]]))};
          const instructions=task.instructions.map(rule=>rule.text??input.data.shared_instructions[rule.shared_instruction]).join('\n');
          payload[task.id]=await produce({stage:task.stage,data,output_schema:logicalSchema.properties[task.id],prompt:COMMON+'\n'+instructions,bundle_stage:input.stage,key:task.id});
        }
      }else payload=await produce({...input,output_schema:logicalSchema});
      const output=evidenceWireFixture({...input,output_schema:logicalSchema},payload);
      const wire=codec?codec.encode(output):output;
      const reply=(await wireOverride?.(wire,input,original))??wire;
      responses.push({stage:input.stage,bytes:Buffer.byteLength(JSON.stringify(reply)),logical_bytes:Buffer.byteLength(JSON.stringify(payload))});
      return envelope(reply);
    }});
  const originalComplete=gateway.agentComplete.bind(gateway);
  gateway.agentComplete=(stage,prompt,payload,schema,...rest)=>{
    originals.set(stage,{stage,schema:structuredClone(schema),payload:structuredClone(payload)});
    return originalComplete(stage,prompt,payload,schema,...rest);
  };
  return {gateway,requests,responses,events,logicalRequests,ctx,
    stages:()=>requests.map(({input})=>input.stage),
    run:options=>gateway.respond(ctx,ctx.agent_state,{onCard:event=>events.push(structuredClone(event)),...options})};
}

export function assertDetail(output) {
  assert.equal(output.agent.reviewed,true);
  assert.equal(output.agent.quality_reviewed,true);
  assert.deepEqual(Object.keys(output.conversation_detail),['opening','listening','offer']);
  assert.equal(Object.values(output.conversation_detail).map(part=>part.excerpt).join(''),output.guide.script);
  for(const part of Object.values(output.conversation_detail)) {
    assert.ok(part.why.length>0);
    assert.deepEqual(part.evidence,[ref()]);
  }
}
