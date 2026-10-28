import assert from 'node:assert/strict';
import test from 'node:test';
import {ModelGateway} from '../src/model.js';
import {createIntake,currentView,answerIntake,applyModelUpdate,buildContext,backIntake} from '../src/intake.js';
import {canonicalPatientState,safetySources,urgentGuideActions} from '../src/relationship-agent.js';

const danger='민서가 지금 다른 사람을 때리고 있어요. 폭력이 계속되고 있어요.';
function approvedIntake(){
let state=createIntake();
for(let i=0;i<8;i++){
 const q=currentView(state).question;
 const input=q.id==='name'?{text:'민서'}:q.id==='want'?{text:'걱정된다는 마음을 전하고 싶어요.'}
  :q.id==='rel'?{selected:[4]}:q.id==='mood'?{selected:[],custom:danger}:{selected:[0]};
 state=answerIntake(state,{question_id:q.id,follow_up:Boolean(q.follow_up),...input});
 if(q.id==='mood')break;
}
const initial=buildContext(state),ref={subject:'patient',question_id:'mood',quote:danger};
const memory=canonicalPatientState({summary:'합성 원문',facts:[{...ref,interpretation:'이용자의 보고',certainty:'reported'}],unknowns:[],user_goal:'걱정된다는 마음을 전하고 싶어요.'},initial);
state=applyModelUpdate(state,{patient_state:memory,name_index:{alias:'민서',source_question_id:'name',quote:'민서'},
 question_plan:{skip:[]},relationship_memory:{patient:[{interpretation:'이용자의 보고',evidence:[ref],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]},
 safety_signal:{urgent:true,evidence:[ref],review:{basis:'current_physical_danger',reason:'현재 폭력 보고'}},finish_early:true});
assert.equal(state.status,'ready');assert.equal(state.safetySignal.urgent,true);
return state;
}
const ref={subject:'patient',question_id:'mood',quote:danger};
const benignGuide={top:'통합',script:'민서야, 네 이야기를 듣고 싶어. 지금 이야기할 여유가 있으면 말해 줄래? 편한 때 이야기해도 괜찮아.',
 doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하는 말. 이유: 대답할 여유를 남겨야 합니다. 대신 편한 시간을 물어보세요.'],
 next:'다음 대화 시간을 함께 정해 보세요.',care:{feel:'자신의 여유를 살펴보세요.',tips:['잠시 쉬어 보세요.']}};
const avoidWire={avoid_phrase:'재촉하는 말.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'};
const plan={voice:'친구가 친구에게 건네는 말',opening_evidence:[ref],user_intent:'걱정된다는 마음을 전하고 싶어요.',patient_choice:'원할 때 이야기해 주세요.',supporter_care:['자신의 휴식도 살펴보세요.'],avoid_patterns:['재촉 대신 허락 구하기'],next_step:'다음 대화 시간을 함께 정하기'};
async function probe(state,{finalUrgent=true,legacyBasis='current_physical_danger'}={}){
 const context=buildContext(state),stages=[];
 const guide=finalUrgent?{...benignGuide,...urgentGuideActions(context.name_index),care:{...benignGuide.care,...urgentGuideActions(context.name_index).care}}:benignGuide;
 const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-only',model:'synthetic',protocol:'relationship_agent',retryFailures:false,diagnosticLogger:null,
 fetchImpl:async (_url,options)=>{
  const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content),{stage,data,output_schema:schema}=input;stages.push(stage);let output;
  if(stage==='safety_review_final')output={basis:legacyBasis,reason:'현재 원문 전체를 다시 검토',evidence_ids:[safetySources(context).find(x=>x.question_id==='mood').id]};
  else if(stage==='relationship_analysis')output={observations:{patient:[ref],supporter:[]},relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:false?[safetySources(context).find(x=>x.question_id==='mood').id]:[]}};
  else if(stage==='communication_plan')output=plan;
  else if(stage==='guide_write')output={guide,assessment:{safety:finalUrgent}};
  else if(stage==='guide_quality')output={improvements:[]};
  else if(stage.startsWith('card_')){const key=stage.slice(5);output=key==='avoid'?{avoid:[avoidWire]}:{[key]:guide[key]};}
  else if(/^speech_(opening|listening|offer)$/.test(stage))output=Object.fromEntries(Object.keys(schema.properties).map(key=>[key,'네 이야기를 듣고 싶어.']));
  else if(stage==='speech_write')output={script:guide.script};
  else if(stage==='speech_detail')output={opening_end:1,listening_end:2,...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 상황을 바탕으로 제안합니다.',evidence:[ref]}]))};
  else if(stage.includes('review'))output={approved:true,issues:[],...(schema.properties.audits?{audits:(data.claims??[]).map(c=>({id:c.id,verdict:c.claim_kind==='avoidance_guidance'?'sound_avoidance':c.claim_kind==='guidance'?'sound_guidance':'supported',reason:'원문과 대조했다고 가정한 합성 승인'}))}:{})};
  else throw new Error('Unexpected stage '+stage);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
 }});
 const result=await gateway.respond(context,state.agentMemory);
 return {finalUrgent,resultSafety:result.assessment.safety,reviewed:result.agent.reviewed,
  fixedUrgentActions:result.agent.safety_guidance_version??null,stages,result};
}


test('approved current danger survives a false final analysis and preserves fixed urgent actions',async()=>{
 const state=approvedIntake(),context=buildContext(state);
 assert.equal(context.safety_signal.urgent,true);
 const out=await probe(state);
 assert.equal(out.resultSafety,true);assert.equal(out.fixedUrgentActions,'immediate-help-v1');
 assert.equal(out.result.agent.safety_signal.source_snapshot,context.safety_signal.source_snapshot);
 assert.equal(out.stages.includes('safety_review_final'),false);
 const stored=applyModelUpdate(state,{patient_state:out.result.patient_state,name_index:out.result.name_index,question_plan:{skip:[]}});
 assert.deepEqual(stored.safetySignal,state.safetySignal,'final persistence without a new signal must preserve the approval');
 assert.equal(buildContext(stored).safety_signal.urgent,true);
});

for(const basis of ['current_physical_danger','past_only'])test('legacy approval remains readable and requires independent current-source review: '+basis,async()=>{
 const state=approvedIntake();delete state.safetySignal.source_snapshot;
 const context=buildContext(state);
 assert.equal(context.safety_signal,undefined);assert.equal(context.safety_review_required,true);
 const urgent=basis==='current_physical_danger',out=await probe(state,{finalUrgent:urgent,legacyBasis:basis});
 assert.equal(out.stages[0],'safety_review_final');assert.equal(out.resultSafety,urgent);
 const stored=applyModelUpdate(state,{patient_state:out.result.patient_state,name_index:out.result.name_index,
   question_plan:{skip:[]},safety_signal:out.result.agent.safety_signal});
 assert.equal(stored.safetySignal.urgent,urgent);
 assert.equal(buildContext(stored).safety_review_required,undefined);
});

test('changed source snapshots never silently inherit approved danger, and normal back clears approval',()=>{
 const state=approvedIntake();
 state.ans.want.text='정정할게요. 지금 상황을 다시 확인하려고 해요.';state.ans.want.rawText=state.ans.want.text;
 const changed=buildContext(state);
 assert.equal(changed.safety_signal,undefined);assert.equal(changed.safety_review_required,true);
 assert.throws(()=>applyModelUpdate(state,{patient_state:state.agentMemory,name_index:state.nameIndex,question_plan:{skip:[]},safety_signal:state.safetySignal}),{code:'MODEL_INVALID_RESPONSE'});
 const active=approvedIntake();active.status='active';
 const back=backIntake(active);
 assert.equal(back.safetySignal,undefined);assert.equal(buildContext(back).safety_review_required,undefined);
});
