import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {continuationInput,continuationCardContext,validateContinuation} from '../src/continuation-model.js';

const field=(id,text)=>({id,question:id,type:'text',status:'answered',source:'app_user_report',text,rawText:text,custom:'',selected:[],skipped:false});
const original=()=>({context:{patient:{alias:'친구',fields:{observation:field('observation','친구가 어제는 피곤하다고 말했어요.')}},
  supporter:{fields:{}},user_goal:{},payload:{name:'친구',answers:[field('observation','친구가 어제는 피곤하다고 말했어요.')]},
  profileInput:{name:'친구',answers:{observation:'친구가 어제는 피곤하다고 말했어요.'}},agent_state:{old:true},relationship_state:null,log:[]},
  relationship_analysis:{relationship:{label:'친구',dynamics:[]}}});
const message=(text,role='user')=>({id:randomUUID(),text,role});
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
function mockModel(candidate,{approve=true,safety='unclear',onStage=()=>{}}={}) {
  const stages=[];
  const gateway=new ModelGateway({baseUrl:'http://synthetic.test/v1',apiKey:'synthetic',model:'synthetic',protocol:'relationship_agent',diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const wire=JSON.parse(options.body),input=JSON.parse(wire.messages[1].content),{stage,data}=input;stages.push(stage);onStage(stage,data);
      if(stage==='continuation_answer')return envelope(candidate);
      if(stage==='support_review_continuation')return envelope({review_id:data.review_id,approved:approve,issues:approve?[]:['가정을 사실로 추출했어요.']});
      if(stage==='safety_review_continuation')return envelope({basis:safety,reason:'합성 원문 분류',evidence_ids:safety==='current_physical_danger'?[data.safety_sources.at(-1).id]:[]});
      assert.fail(stage);
    }});
  return {gateway,stages};
}

test('quoted facts bind only actual user text, never assistant output or skipped text',()=>{
  const messages=[message('저는 오늘 쉬고 싶어요.'),message('상대가 동의했어요.','assistant'),{...message('건너뜀'),skipped:true}];
  const input=continuationInput(original(),messages);
  const draft={answer:'쉬는 시간을 말로 전할 수 있어요.',clarification:null,facts:[{message_id:messages[0].id,subject:'supporter',quote:messages[0].text}],superseded:[]};
  assert.equal(validateContinuation(draft,input),draft);
  for(const fact of [{...draft.facts[0],quote:'저는 동의했어요.'},{...draft.facts[0],message_id:messages[1].id,quote:messages[1].text},
    {...draft.facts[0],message_id:messages[2].id,quote:messages[2].text}])assert.throws(()=>validateContinuation({...draft,facts:[fact]},input),{code:'MODEL_INVALID_RESPONSE'});
});

test('card context preserves original and removes explicitly superseded evidence without including assistant/question facts',()=>{
  const record=original(),before=structuredClone(record),messages=[message('친구가 오늘은 괜찮다고 했어요.'),message('만약 또 피곤하다면요?'),message('친구가 화났군요.','assistant')];
  const input=continuationInput(record,messages),draft={answer:'현재 알려 준 내용을 참고할게요.',clarification:null,
    facts:[{message_id:messages[0].id,subject:'patient',quote:messages[0].text}],superseded:[input.original_sources[0].source_id]};
  const context=continuationCardContext(record,messages,draft);
  assert.deepEqual(record,before);assert.equal(context.agent_state,null);assert.equal(context.relationship_state,null);
  assert.equal(context.patient.fields.observation,undefined);assert.equal(context.payload.answers.length,1);
  assert.equal(context.payload.answers[0].text,messages[0].text);
  assert.equal(context.payload.answers.some(a=>a.text.includes('화났')),false);
});

test('gateway uses separate answer, independent content review, and existing independent safety review',async()=>{
  const messages=[message('저도 오늘 쉬고 싶어요.')],candidate={answer:'쉬고 싶다는 마음을 짧게 전해 보세요.',clarification:null,
    facts:[{message_id:messages[0].id,subject:'supporter',quote:messages[0].text}],superseded:[]};
  let safetySawRaw=false;
  const {gateway,stages}=mockModel(candidate,{onStage:(stage,data)=>{if(stage==='safety_review_continuation')safetySawRaw=JSON.stringify(data).includes(messages[0].text);}});
  const result=await gateway.continueConversation({record:original(),messages});
  assert.equal(result.answer,candidate.answer);assert.equal(result.safety.urgent,false);assert.equal(safetySawRaw,true);
  assert.deepEqual(stages,['continuation_answer','support_review_continuation','safety_review_continuation']);
});

test('independent reviewer rejects hypothetical extraction even if quote is literally valid',async()=>{
  const messages=[message('만약 친구가 답장을 하지 않으면요?')],candidate={answer:'다시 물어보세요.',clarification:null,
    facts:[{message_id:messages[0].id,subject:'patient',quote:messages[0].text}],superseded:[]};
  const {gateway,stages}=mockModel(candidate,{approve:false});
  await assert.rejects(gateway.continueConversation({record:original(),messages}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(stages.includes('safety_review_continuation'),false);
});

test('safety review sees entire messages even when fact extraction omitted danger',async()=>{
  const messages=[message('지금 저를 해치려고 칼을 들고 있어요.')],candidate={answer:'지금 안전을 먼저 살펴주세요.',clarification:null,facts:[],superseded:[]};
  const {gateway}=mockModel(candidate,{safety:'current_physical_danger'});
  const result=await gateway.continueConversation({record:original(),messages});
  assert.equal(result.safety.urgent,true);assert.equal(result.safety.evidence.some(x=>x.quote===messages[0].text),true);
});

test('independently reviewed danger omitted from facts remains bound in the new card context',async()=>{
  const record=original(),messages=[message('지금 저를 해치려고 칼을 들고 있어요.')];
  const candidate={answer:'안전을 먼저 확보해 주세요.',clarification:null,facts:[],superseded:[]};
  const {gateway}=mockModel(candidate,{safety:'current_physical_danger'});
  const {safety,...draft}=await gateway.continueConversation({record,messages});
  const context=continuationCardContext(record,messages,draft,safety);
  assert.equal(context.safety_signal.urgent,true);
  assert.ok(context.payload.answers.some(a=>a.text===messages[0].text));
  assert.equal(context.safety_signal.review.basis,'current_physical_danger');
  assert.throws(()=>continuationCardContext(record,messages,draft,{...safety,evidence:[{subject:'supporter',question_id:'invented',quote:'없는 위험 보고'}]}),{code:'MODEL_INVALID_RESPONSE'});
});

test('superseded mood and gap observations cannot survive through the profile observation alias',()=>{
  for(const id of ['mood','gap_obs']) {
    const record=original(),stale='친구가 며칠째 잠을 못 잔다고 했어요.';
    record.context.patient.fields[id]=field(id,stale);record.context.profileInput.obs=stale;
    record.context.payload.answers.push(field(id,stale));
    const messages=[message('정정할게요. 친구는 잠을 잘 자고 있어요.')];
    const source=continuationInput(record,messages).original_sources.find(s=>s.question_id===id);
    const context=continuationCardContext(record,messages,{answer:'정정한 내용을 참고할게요.',clarification:null,
      facts:[{message_id:messages[0].id,subject:'patient',quote:messages[0].text}],superseded:[source.source_id]});
    assert.equal(context.profileInput.obs,'');assert.equal(record.context.profileInput.obs,stale);
  }
});
