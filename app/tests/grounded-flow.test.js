import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway, inferenceSchema } from '../src/model.js';
import { canonicalRelationshipState, relationshipStateRequest, relationshipQuestionRequest, validateRelationshipQuestions, questionReviewRequest, applyQuestionReview, validateSchema, hasQuestionSpecificAnswer, knownSpeechIssues, safetySources } from '../src/relationship-agent.js';
import { createIntake, answerIntake, currentView, applyModelUpdate, buildContext, prepareModelAnswer, completeModelAnswer, backIntake } from '../src/intake.js';
import { createQuestionSet } from '../src/question-bank.js';
import { claimsOf, validateAudits } from '../src/grounding-audit.js';

const field=(id,text,status='answered')=>({id,question:id,status,text,rawText:text,custom:''});
const ctx=()=>({patient:{fields:{mood:field('mood','계획을 여러 번 고치고 괜찮은지 물어봐요.')}},
  supporter:{fields:{feeling:field('feeling','밤에는 쉬고 싶어요.')}},user_goal:{},question_candidates:[],name_index:null,
  latest_answer:{subject:'supporter',question_id:'feeling'}});
const observation=()=>({patient_state:{facts:[{subject:'patient',question_id:'mood',quote:'계획을 여러 번 고치고 괜찮은지 물어봐요.',certainty:'reported'}],unknowns:[]},name_index:null});
const emptyMemory=()=>({patient:[],supporter:[],relationship:[],unknowns:[]});
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const model=handler=>new ModelGateway({baseUrl:'http://example.test/v1',apiKey:'synthetic',protocol:'relationship_agent',diagnosticLogger:null,
  fetchImpl:async(_url,request)=>handler(JSON.parse(request.body))});

test('state responsibilities are separate sequential calls sharing one deadline, followed by question planning',async()=>{
  const context=ctx();context.adaptive_questions=true;
  context.clarification_candidates=[{id:'clarify_help',question:'직접 원한 도움은 무엇인가요?'}];
  const stages=[],operations=[];
  const gateway=model(body=>{
    const input=JSON.parse(body.messages[1].content);stages.push(input.stage);
    if(input.stage==='state_observations'){
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),['patient_state','name_index']);
      assert.equal(input.data.prior_state,undefined);assert.equal(input.data.prior_relationship_memory,undefined);
      return envelope(observation());
    }
    if(input.stage==='relationship_memory'){
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),['relationship_memory']);
      assert.deepEqual(input.data.observations,observation());return envelope({relationship_memory:emptyMemory()});
    }
    if(input.stage==='state_review'){
      assert.ok(input.data.state.patient_state.facts.some(fact=>fact.question_id==='feeling'));
      return envelope({approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'원문 인용입니다.'}))});
    }
    if(input.stage==='question_plan')return envelope({skip:[],clarify:['clarify_help'],safety:{urgent:false,evidence_ids:[]}});
    assert.equal(input.stage,'question_review');
    return envelope({audits:input.data.claims.map(c=>({id:c.id,verdict:'supported',reason:'아직 원하는 도움은 답하지 않았어요.'}))});
  });
  const call=gateway.agentComplete.bind(gateway);gateway.agentComplete=(...args)=>{operations.push(args[5]);return call(...args);};
  const result=await gateway.updateState(context);
  assert.deepEqual(stages,['state_observations','relationship_memory','state_review','question_plan','question_review']);
  assert.ok(operations.every(operation=>operation===operations[0]));
  assert.deepEqual(result.state_agent.stages,stages);assert.equal(result.clarification,'clarify_help');
});

test('rejected state is regenerated from the source and reviewed once; persistent rejection cannot be saved',async()=>{
  for(const succeeds of [true,false]){
    const stages=[];
    const gateway=model(body=>{
      const input=JSON.parse(body.messages[1].content);stages.push(input.stage);
      if(input.stage.startsWith('state_observations'))return envelope(observation());
      if(input.stage.startsWith('relationship_memory'))return envelope({relationship_memory:emptyMemory()});
      const approved=succeeds&&input.stage.endsWith('_after_review');
      return envelope({approved,audits:input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'원문 인용입니다.'})),issues:approved?[]:[{reason:'인용이 원인을 뒷받침하지 않아요.',repair:'보고된 행동만 유지하세요.'}]});
    });
    if(succeeds)assert.equal((await gateway.updateState(ctx())).state_agent.reviewed,true);
    else await assert.rejects(gateway.updateState(ctx()),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
    assert.deepEqual(stages,['state_observations','relationship_memory','state_review','state_observations_after_review','relationship_memory_after_review','state_review_after_review']);
  }
});

test('a proposed urgent handoff requires an independent review of current physical danger',async()=>{
  for(const [report,basis,urgent] of [
    ['계획을 여러 번 고치고 괜찮은지 물어봐요.','distress_without_immediate_danger',false],
    ['지금 자해할 생각은 없다고 말했어요.','negated',false],
    ['지금 오늘 자신을 해치겠다고 직접 말했어요.','current_physical_danger',true],
  ]){
    const context=ctx();context.adaptive_questions=true;context.patient.fields.mood=field('mood',report);
    const stages=[];
    const gateway=model(body=>{
      const input=JSON.parse(body.messages[1].content);stages.push(input.stage);
      if(input.stage==='state_observations')return envelope({patient_state:{facts:[{subject:'patient',question_id:'mood',quote:report,certainty:'reported'}],unknowns:[]},name_index:null});
      if(input.stage==='relationship_memory')return envelope({relationship_memory:emptyMemory()});
      if(input.stage==='state_review')return envelope({approved:true,issues:[],audits:input.data.claims.map(c=>({id:c.id,verdict:'supported',reason:'원문 보고입니다.'}))});
      if(input.stage==='question_plan')return envelope({skip:[],clarify:[],safety:{urgent:true,evidence_ids:[safetySources(context).find(source=>source.question_id==='mood').id]}});
      assert.equal(input.stage,'safety_review');return envelope({basis,reason:'현재 시점과 명시된 신체 위험을 원문에 대조했어요.'});
    });
    const result=await gateway.updateState(context);
    assert.equal(result.finish_early,urgent);assert.equal(result.safety_signal.urgent,urgent);
    assert.equal(stages.at(-1),'safety_review');
  }
});

test('latest complete report survives early-memory selection, while refusal never becomes a fact',()=>{
  const context=ctx(),payload={...observation(),relationship_memory:emptyMemory()};
  const result=canonicalRelationshipState(payload,context);
  assert.ok(result.patient_state.facts.some(fact=>fact.quote==='밤에는 쉬고 싶어요.'));
  assert.deepEqual(result.relationship_memory.supporter,[]);
  context.supporter.fields.feeling.status='refused';
  const refused=canonicalRelationshipState(payload,context);
  assert.equal(refused.patient_state.facts.some(f=>f.question_id==='feeling'),false);
  assert.deepEqual(refused.relationship_memory.supporter,[]);
});

test('runtime length validation remains strict when runner grammar omits string repetition bounds',()=>{
  const context=ctx(),schema=relationshipStateRequest(context,null).schema;
  const wire=inferenceSchema(schema);
  assert.equal(JSON.stringify(wire).includes('maxLength'),false);
  assert.equal(JSON.stringify(schema).includes('maxLength'),true);
  const payload={...observation(),relationship_memory:emptyMemory()};
  payload.patient_state.unknowns=['가'.repeat(2001)];
  assert.throws(()=>canonicalRelationshipState(payload,context,schema),{code:'MODEL_INVALID_RESPONSE'});
});

const ordinarySafety={urgent:false,evidence_ids:[]};
test('question decisions require actual same-person evidence and cannot invent or repeat confirmation IDs',()=>{
  const context=ctx();context.question_candidates=[
    {id:'burden',subject:'supporter',question:'당신의 부담은 무엇인가요?'},
    {id:'need',subject:'patient',question:'어떤 도움이 필요한가요?'}];
  context.supporter.fields.burden=field('burden','','not_asked');
  context.clarification_candidates=[{id:'clarify_help',question:'직접 말한 도움'}];
  const request=relationshipQuestionRequest(context);
  const value={skip:[{question_id:'burden',reason:'already_covered',explanation:'밤에는 쉬고 싶다고 이미 답했어요.',
    evidence:[{subject:'supporter',question_id:'feeling',quote:'밤에는 쉬고 싶어요.'}]}],clarify:[],safety:ordinarySafety};
  assert.equal(validateRelationshipQuestions(value,context,request).question_plan.skip.length,1);
  for(const mutate of [v=>v.clarify=['invented'],v=>v.skip[0].reason='not_needed',v=>v.skip[0].evidence[0].subject='patient']){
    const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateRelationshipQuestions(bad,context,request));
  }
  const urgent={skip:[],clarify:[],safety:{urgent:true,evidence_ids:[]}};
  assert.throws(()=>validateRelationshipQuestions(urgent,context,request),{modelReason:'agent_safety_evidence'});
});

test('question review cancels merely related evidence and redundant confirmations without blocking the original question',()=>{
  const context=ctx();context.question_candidates=[{id:'values',subject:'patient',question:'생활 배경이나 중요하게 여기는 가치는 무엇인가요?'},{id:'last',subject:'patient',question:'마지막 질문'}];
  context.clarification_candidates=[{id:'clarify_help',question:'직접 원한 도움'}];
  const decision={question_plan:{skip:[{question_id:'values',reason:'already_covered',explanation:'계획 변경을 말했어요.',evidence:[{subject:'patient',question_id:'mood',quote:context.patient.fields.mood.text}]}]},clarification:'clarify_help',finish_early:false};
  const request=questionReviewRequest(decision,relationshipQuestionRequest(context));
  const audits=request.claims.map(c=>({id:c.id,verdict:'unsupported',reason:'행동 설명은 가치관의 답이 아니며 도움 의향은 이미 답했습니다.'}));
  assert.deepEqual(applyQuestionReview({audits},decision,request),{question_plan:{skip:[]},clarification:null,finish_early:false});
  assert.throws(()=>applyQuestionReview({audits:audits.slice(1)},decision,request),{code:'MODEL_INVALID_RESPONSE'});
});

test('grounded question reference enums cannot conflict with their actor, question or 160-character quote constraints',()=>{
  const context=ctx();context.patient.fields.mood=field('mood','계획을 여러 번 고치고 괜찮은지 물어봐요. '.repeat(12));
  context.question_candidates=[{id:'values',subject:'patient',question:'생활 배경은요?'},{id:'last',subject:'patient',question:'마지막 질문'}];
  const request=relationshipQuestionRequest(context);
  let checked=0;
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='object'&&node.enum){for(const ref of node.enum)assert.doesNotThrow(()=>validateSchema(ref,node));checked++;}
    for(const [key,value] of Object.entries(node))if(key!=='enum'){
      if(Array.isArray(value))value.forEach(visit);else visit(value);
    }
  };
  visit(request.schema);assert.ok(checked>0);
});

test('symptoms cannot replace a reported priority, another speaker’s view, or an invitation for additional information',()=>{
  const behavior=['계획을 다시 짜고 저한테 “엄마, 이거 괜찮은 거야?”라고 물어요.'];
  for(const id of ['concern','others_why','others_help','extra'])assert.equal(hasQuestionSpecificAnswer(id,behavior),false);
  assert.equal(hasQuestionSpecificAnswer('concern',['밤에 못 자는 모습이 가장 걱정돼요.']),true);
  assert.equal(hasQuestionSpecificAnswer('others_why',['남편은 “시험 끝나면 괜찮아진다”고 말해요.']),true);
  assert.equal(hasQuestionSpecificAnswer('others_help',['담임 선생님은 상담을 권하셨어요.']),true);
  assert.equal(hasQuestionSpecificAnswer('extra',['더 이야기할 게 없어요.']),false);
});

test('known mind-reading fails in recommended action/alternative speech while prohibited examples remain allowed',()=>{
  const guide={script:'어떤 점이 걱정되는지 듣고 싶어.',
    doList:['“완벽하게 해내고 싶어서 많이 애쓰고 있구나”라고 말해주세요.'],
    avoid:['재촉하기. 대신 “네가 얼마나 노력하는지 엄마는 알고 있어”라고 말해요.']};
  assert.deepEqual(knownSpeechIssues(guide).map(issue=>issue.field),['doList','avoid']);
  guide.doList=['어떤 도움이 필요한지 물어보세요.'];
  guide.avoid=['“완벽하게 하고 싶은 마음 때문에 힘든 거야”라고 단정하기. 대신 “어떤 점이 걱정돼?”라고 물어보세요.'];
  assert.deepEqual(knownSpeechIssues(guide),[]);
  guide.doList=['따뜻하게 안아주세요.'];assert.equal(knownSpeechIssues(guide)[0].field,'doList');
  guide.doList=['“안아줘도 괜찮을까?”라고 먼저 물어보고 상대가 원하면 안아주세요.'];assert.deepEqual(knownSpeechIssues(guide),[]);
});

const set=()=>createQuestionSet([{id:'mood',kind:'base',enabled:true,sort_order:1,subject:'patient',definition:{q:'어떤 모습인가요?',type:'text'}}]);
const output=clarification=>({patient_state:{summary:'원문',facts:[],unknowns:[],user_goal:'확인되지 않음'},name_index:null,question_plan:{skip:[]},clarification});
function ready(){return answerIntake(createIntake(set()),{question_id:'mood',text:'계획을 자주 바꿔요.'});}

test('optional clarification answers use the same pending, retry, attribution and back/correction contracts',()=>{
  const state=applyModelUpdate(ready(),output('clarify_help'));
  assert.equal(currentView(state).question.follow_up,true);
  const pending=prepareModelAnswer(state,{question_id:'clarify_help',follow_up:true,text:'지금은 조언보다 들어줬으면 좋겠다고 했어요.'},1);
  const context=buildContext(pending);
  assert.equal(context.latest_answer.subject,'patient');
  assert.equal(context.patient.fields.clarify_help.rawText,'지금은 조언보다 들어줬으면 좋겠다고 했어요.');
  assert.ok(context.payload.answers.some(answer=>answer.id==='clarify_help'));
  const next=completeModelAnswer(pending,output('clarify_boundary'));
  assert.equal(currentView(next).question.id,'clarify_boundary');
  assert.ok(!buildContext(pending).clarification_candidates.some(q=>q.id==='clarify_help'));
  const restored=backIntake(next);
  assert.equal(currentView(restored).question.id,'clarify_help');
  assert.equal(buildContext(restored).patient.fields.clarify_help,undefined);
  assert.equal(restored.agentMemory,undefined);
});

test('three optional confirmations terminate; skipped and unknown responses are never asked again',()=>{
  let state=ready();
  for(const id of ['clarify_help','clarify_response','clarify_boundary']){
    state=applyModelUpdate(state,output(id));
    state=answerIntake(state,{question_id:id,follow_up:true,skipped:true});
    assert.ok(!buildContext(state).clarification_candidates.some(q=>q.id===id));
  }
  assert.equal(state.status,'ready');assert.deepEqual(buildContext(state).clarification_candidates,[]);
  assert.throws(()=>applyModelUpdate(state,output('clarify_help')),{code:'INVALID_CLARIFICATION'});
});

test('current urgent handoff ends ordinary questions without fabricating unanswered responses',()=>{
  const state=applyModelUpdate(ready(),{...output(null),finish_early:true});
  assert.equal(state.status,'ready');assert.equal(state.pendingFollow,null);
  assert.match(state.log.at(-1).text,/응급 도움/);
  assert.deepEqual(Object.keys(state.ans),['mood']);
});

test('claim audits cannot omit a claim, duplicate IDs or approve an unsupported reported assertion',()=>{
  const claims=claimsOf({patient:[{interpretation:'두려워한다는 추정',certainty:'reported',evidence:[]},
    {interpretation:'확인을 반복하는 양상일 수 있어요.',certainty:'tentative',evidence:[]}]});
  const audit=claims.map(claim=>({id:claim.id,verdict:'supported',reason:'전체 주장을 대조했어요.'}));
  validateAudits(audit,claims,true);
  for(const bad of [audit.slice(1),[null,audit[1]],[[],audit[1]],[audit[0],audit[0]],[{...audit[0],verdict:'plausible'},audit[1]],[audit[0],{...audit[1],verdict:'unsupported'}]]){
    assert.throws(()=>validateAudits(bad,claims,true),{modelReason:'agent_claim_audit'});
  }
  validateAudits([{...audit[0],verdict:'unsupported'},audit[1]],claims,false);
});

test('follow-up corrections retain complete original and follow-up reports with their attribution',()=>{
  const context=ctx();context.supporter.fields.feeling.followUp={answer:{rawText:'정정할게요. 밤에도 제가 돕겠다는 뜻은 아니에요.'}};
  const result=canonicalRelationshipState({...observation(),relationship_memory:emptyMemory()},context);
  assert.deepEqual(result.patient_state.facts.filter(fact=>fact.question_id==='feeling').map(fact=>fact.quote),
    ['밤에는 쉬고 싶어요.','정정할게요. 밤에도 제가 돕겠다는 뜻은 아니에요.']);
});

test('replacement models keep agent stages and validators across all wire formats',async()=>{
  for(const agentFormat of ['json_schema','json_object','prompt']) {
    let calls=0;
    const gateway=new ModelGateway({baseUrl:'http://example.test/v1',apiKey:'synthetic',model:'our-finetuned-model',
      protocol:'relationship_agent',agentFormat,reasoningEffort:'omit',diagnosticLogger:null,
      fetchImpl:async(_url,request)=>{
        const body=JSON.parse(request.body);calls++;
        assert.equal(body.model,'our-finetuned-model');assert.equal('reasoning_effort' in body,false);
        if(agentFormat==='prompt')assert.equal('response_format' in body,false);
        else assert.equal(body.response_format.type,agentFormat);
        const input=JSON.parse(body.messages[1].content);
        assert.equal(input.output_schema.type,'object');
        if(input.stage==='state_observations')return envelope(observation());
        if(input.stage==='relationship_memory')return envelope({relationship_memory:emptyMemory()});
        if(input.stage==='state_review')return envelope({approved:true,issues:[],audits:input.data.claims.map(c=>({id:c.id,verdict:'supported',reason:'직접 보고된 원문'}))});
        if(input.stage==='question_plan')return envelope({skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}});
        throw new Error('unexpected_stage');
      }});
    const context=ctx();context.adaptive_questions=true;
    const result=await gateway.updateState(context);
    assert.deepEqual(result.state_agent.stages,['state_observations','relationship_memory','state_review','question_plan']);
    assert.equal(calls,4);
  }
});

test('prompt wire mode still rejects invented evidence and exhausts bounded retries',async()=>{
  let calls=0;
  const gateway=new ModelGateway({baseUrl:'http://example.test/v1',apiKey:'synthetic',model:'our-finetuned-model',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',diagnosticLogger:null,
    fetchImpl:async()=>{calls++;const result=observation();result.patient_state.facts[0].quote='원문에 없는 진단';return envelope(result);}});
  await assert.rejects(()=>gateway.updateState(ctx()),error=>error.code==='MODEL_INVALID_RESPONSE');
  assert.equal(calls,3);
});

test('unknown model capabilities fail configuration rather than silently weakening validation',()=>{
  const options={baseUrl:'http://example.test/v1',apiKey:'synthetic',protocol:'relationship_agent'};
  assert.equal(new ModelGateway({...options,agentFormat:'auto'}).configured,false);
  assert.equal(new ModelGateway({...options,reasoningEffort:'unsupported'}).configured,false);
});

test('observed live failures are rejected even when a model reviewer approves them',()=>{
  const base={script:'내가 네 곁에 있을게. 네가 편할 때 같이 밥 먹고 싶어.',doList:[],avoid:[]};
  assert.deepEqual(knownSpeechIssues(base),[]);
  assert.equal(knownSpeechIssues({...base,script:'어떤 점이 걱정되는지 들어줄 수 있어?'})[0].field,'script');
  assert.equal(knownSpeechIssues({...base,script:'네 곁에 항상 있을게.'})[0].field,'script');
  assert.deepEqual(knownSpeechIssues({...base,script:'어떤 점이 걱정되는지 말해줄 수 있어?'}),[]);
  assert.equal(knownSpeechIssues({...base,script:'네가 내 곁에 있다는 걸 알려주고 싶어.'})[0].field,'script');
  assert.equal(knownSpeechIssues({...base,script:'하루빨리 괜찮아져서 같이 외식하고 싶어.'})[0].field,'script');
  assert.equal(knownSpeechIssues({...base,avoid:['강요 대신 “지금 말하기 편한지 먼저 물어보세요”라고 말해보세요.']})[0].field,'avoid');
  assert.deepEqual(knownSpeechIssues({...base,avoid:['“빨리 나아져” 대신 “네가 편할 때 같이 밥 먹을까?”라고 물어보세요.']}),[]);
});

test('different family opinions cannot become unreported neglect even as a tentative memory',()=>{
  const context=ctx();context.supporter.fields.cgchange_more=field('cgchange_more','다른 가족들은 그냥 놔두래요');
  const payload={...observation(),relationship_memory:emptyMemory()};
  payload.relationship_memory.relationship=[{interpretation:'가능한 해석: 다른 가족들은 방관하고 있을 수 있어요.',certainty:'tentative',
    evidence:[{subject:'supporter',question_id:'cgchange_more',quote:'다른 가족들은 그냥 놔두래요'}]}];
  assert.throws(()=>canonicalRelationshipState(payload,context),error=>error.modelReason==='agent_unreported_label');
  payload.relationship_memory.relationship[0].interpretation='가능한 해석: 가족 사이에 대응 의견이 다를 수 있어요.';
  assert.doesNotThrow(()=>canonicalRelationshipState(payload,context));
});

test('all-card guards reject invented sibling roles, conditional recovery and helper promises',()=>{
  const context=ctx();context.patient.fields.rel=field('rel','형제자매');
  const base={script:'편할 때 같이 밥 먹고 싶어.',doList:[],avoid:[],next:'동의하면 상담 정보를 함께 찾아보세요.',care:{feel:'걱정되는 마음을 들려주셨어요.',tips:[]}};
  assert.deepEqual(knownSpeechIssues(base,context),[]);
  assert.equal(knownSpeechIssues({...base,care:{feel:'형으로서 당연해요.',tips:[]}},context)[0].field,'care');
  context.supporter.fields.feeling.question='예: 형, 누나';
  assert.equal(knownSpeechIssues({...base,care:{feel:'형으로서 당연해요.',tips:[]}},context)[0].field,'care');
  context.supporter.fields.feeling.text='제가 형이에요.';context.supporter.fields.feeling.rawText='제가 형이에요.';
  assert.deepEqual(knownSpeechIssues({...base,care:{feel:'형으로서 걱정되셨군요.',tips:[]}},context),[]);
  assert.equal(knownSpeechIssues({...base,avoid:['재촉 대신 “네가 괜찮아지면 같이 외식하고 싶어”라고 하세요.']})[0].field,'avoid');
  assert.equal(knownSpeechIssues({...base,doList:['언제든 내가 도와줄 준비가 되어 있어.']})[0].field,'doList');
  assert.equal(knownSpeechIssues({...base,next:'원하시면 기관 찾기를 도와드릴 수 있습니다.'})[0].field,'next');
});

test('expanded recommendations cannot turn recovery into a meal condition or family disagreement into sole responsibility',()=>{
  const context=ctx();context.supporter.fields.feeling=field('feeling','걱정돼요.');
  context.supporter.fields.cgchange_more=field('cgchange_more','가족들과 의견이 달라요.');
  const base={script:'어떤 도움이 필요한지 듣고 싶어.',doList:['원하면 함께 먹고 싶은 메뉴를 물어보세요.'],avoid:['재촉 대신 대화 의사를 물어보세요.'],next:'기분이 괜찮아지면 같이 맛있는 거 먹으러 가자.',care:{feel:'혼자 감당해야 하는 부담감이 무거우시겠어요.',tips:['지금은 쉬고 싶구나라고 말해 보세요.']}};
  const issues=knownSpeechIssues(base,context);
  assert.ok(issues.some(issue=>issue.field==='next'&&issue.reason.includes('회복')));
  assert.ok(issues.some(issue=>issue.field==='care'&&issue.reason.includes('혼자')));
  assert.ok(issues.some(issue=>issue.field==='care'&&issue.reason.includes('거절')));
  const corrected={...base,next:'원하면 같이 먹고 싶은 메뉴를 골라보자.',care:{feel:'가족과 의견이 달라 마음이 쓰이시겠어요.',tips:['친구에게 이야기할 여유가 있는지 물어보세요.']}};
  assert.equal(knownSpeechIssues(corrected,context).length,0);
});


test('a prohibited recovery phrase in care is distinguished from the recommended alternative',()=>{
 const draft={script:'이야기를 듣고 싶어.',doList:['대답을 기다려 주세요.'],avoid:[],next:'원하면 같이 알아보세요.',care:{feel:'걱정되실 수 있어요.',tips:["'빨리 나아져야만 가능하다'는 조건보다는 '네가 원할 때 같이 가고 싶어'라고 전해 보세요."]}};
 assert.equal(knownSpeechIssues(draft,ctx()).length,0);
 draft.care.tips=["'빨리 나아져서 같이 가자'라고 말해 보세요."];
 assert.ok(knownSpeechIssues(draft,ctx()).some(issue=>issue.field==='care'));
});


test('adaptive safety selection hydrates complete long source bundles and rejects legacy excerpts or missing provenance',()=>{
  const context=ctx(),original='과거 이야기: '+'가'.repeat(9950)+' 지금은 해당 위험을 부정했어요.';
  context.patient.fields.mood=field('mood',original);
  context.patient.fields.mood.followUp={question:'누구의 현재 상태인가요?',answer:{rawText:'앞선 말은 다른 사람의 과거 이야기예요.',text:'앞선 말은 다른 사람의 과거 이야기예요.'}};
  const request=relationshipQuestionRequest(context),id=safetySources(context).find(source=>source.question_id==='mood').id;
  const value={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[id]}};
  assert.deepEqual(request.schema.properties.safety.required,['urgent','evidence_ids']);
  assert.equal(JSON.stringify(request.schema.properties.safety).includes(original),false);
  const result=validateRelationshipQuestions(value,context,request);
  assert.deepEqual(result.safety_signal.evidence.map(ref=>ref.quote),[original,context.patient.fields.mood.followUp.answer.text]);
  for(const safety of [{urgent:false,evidence_ids:[id,id]},{urgent:false,evidence:[{subject:'patient',question_id:'mood',quote:'위험'}]}]){
    assert.throws(()=>validateRelationshipQuestions({...value,safety},context,request),{code:'MODEL_INVALID_RESPONSE'});
  }
  const incomplete=structuredClone(request);
  incomplete.retrieval.documents=incomplete.retrieval.documents.filter(document=>document.origin!=='follow_up');
  assert.throws(()=>validateRelationshipQuestions(value,context,incomplete),{modelReason:'agent_retrieval_evidence'});
});
