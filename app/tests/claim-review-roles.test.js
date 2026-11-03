import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {auditSchema} from '../src/grounding-audit.js';
import {claimReviewRequest,guidanceReviewPayload,reviewSchema,knownSpeechIssues} from '../src/relationship-agent.js';
import {SPEECH_REVIEW,SUPPORT_REVIEW,PROMPT_VERSION,GUIDANCE_REVIEW_BOUNDARY,CARD_ROLES,QUALITY,QUALITY_CHECK} from '../src/relationship-prompts.js';

const warning='피할 말·행동: “무조건 해결해 줄게.” 이유: 가능한 도움의 범위를 넘는 약속을 피하세요. 대신 어떤 도움이 필요한지 물어보세요.';
const claim=(id,field,text)=>({id,field,claim:text,certainty:'reported'});
const claims=()=>[claim('avoid.0','avoid',warning),claim('avoid.1','avoid','피할 말·행동: 답을 재촉하기. 이유: 선택할 시간을 남겨야 합니다. 대신 편한 시간을 물어보세요.'),
  claim('doList.0','doList','대화할 여유가 있는지 물어보세요.')];
function fixture(items=claims()) {
  const texts=field=>items.filter(c=>c.field===field).map(c=>c.claim);
  const guide=Object.fromEntries([...new Set(items.map(c=>c.field))].map(field=>[field,field==='care'
    ?{feel:texts(field)[0],tips:texts(field).slice(1)}:['script','next'].includes(field)?texts(field).join('\n\n'):texts(field)]));
  const payload={answers:{patient:[{question_id:'mood',answers:[{text:'PRIVATE_SYNTHETIC_FULL_SOURCE. 이후의 정정도 함께 유지합니다.'}]}],
    supporter:[],user_goal:[]},guide,
    plan:{intent:'상대의 의사를 물어보기'},claims:items,revision:{before:{avoid:['이미 없어진 합성 문장입니다.']},previous_review:{approved:false}},
    retrieval:{documents:[{text:'PRIVATE_SYNTHETIC_FULL_SOURCE. 이후의 정정도 함께 유지합니다.'}]}};
  const schema=structuredClone(reviewSchema);schema.properties.audits=auditSchema(items);schema.required.push('audits');
  const request=claimReviewRequest(payload,schema);
  const approval=()=>({approved:true,issues:[],audits:items.map(c=>({id:c.id,reason:'전체 원문과 현재 항목의 역할을 독립적으로 대조했습니다.',
    verdict:c.field==='avoid'?'sound_avoidance':'sound_guidance'}))});
  return {payload,schema,request,approval};
}
const rejected=(f,verdict='problem_in_recommended_content')=>{
  const output=f.approval();output.approved=false;output.audits[0].verdict=verdict;
  output.issues=[{field:'avoid',reason:'현재 대안에 원문으로 확인되지 않은 동의를 추가했습니다.',repair:'동의를 전제하지 말고 현재 의사를 물어보세요.'}];return output;
};

test('mixed avoidance review keeps all canonical text, sources, IDs, bounds and history while typing only wire labels',()=>{
  const f=fixture(),before=structuredClone({payload:f.payload,schema:f.schema}),wire=f.request;
  assert.deepEqual(wire.payload.claims.map(({claim_kind,...rest})=>rest),f.payload.claims.map(({certainty,...rest})=>rest));
  assert.deepEqual(wire.payload.claims.map(c=>c.claim_kind),['avoidance_guidance','avoidance_guidance','guidance']);
  assert.ok(wire.payload.claims.every(c=>!Object.hasOwn(c,'certainty')));
  assert.ok(f.payload.claims.every(c=>c.certainty==='reported'));
  for(const key of ['answers','guide','plan','revision','retrieval'])assert.deepEqual(wire.payload[key],f.payload[key]);
  assert.deepEqual(Object.keys(wire.schema.properties),['audits','issues','approved']);
  assert.deepEqual(wire.schema.properties.issues,f.schema.properties.issues);
  assert.equal(wire.schema.properties.audits.minItems,3);assert.equal(wire.schema.properties.audits.maxItems,3);
  const branches=wire.schema.properties.audits.items.anyOf;
  assert.deepEqual(branches.map(b=>b.properties.id.enum),[['avoid.0','avoid.1'],['doList.0']]);
  assert.deepEqual(branches.map(b=>b.properties.verdict.enum),[['sound_avoidance','problem_in_recommended_content','unclear'],['sound_guidance','problem_in_guidance','unclear']]);
  for(const branch of branches){assert.deepEqual(Object.keys(branch.properties),['id','reason','verdict']);assert.deepEqual(branch.required,['id','reason','verdict']);}
  const output=f.approval(),original=structuredClone(output),result=wire.validate(output);
  assert.deepEqual(result.claims,f.payload.claims);assert.ok(result.claims.every(c=>!Object.hasOwn(c,'claim_kind')));
  assert.deepEqual(result.audits.map(a=>a.verdict),['supported','supported','supported']);
  assert.deepEqual(result.audits.map(a=>a.reason),output.audits.map(a=>a.reason));
  assert.equal(result.approved,output.approved);assert.deepEqual(result.issues,output.issues);
  assert.deepEqual(output,original);assert.deepEqual({payload:f.payload,schema:f.schema},before);
  assert.equal(PROMPT_VERSION,'relationship-v3.25-source-attribution');
  assert.match(wire.prompt,/잘못된 회피 권고, 이유의 오류/u);assert.match(wire.prompt,/원문 밖 사실·마음·동의·지원 약속/u);
  assert.match(wire.prompt,/일반 발화의 sound_guidance\/problem_in_guidance 기준은 avoidance_guidance가 아닌 주장/u);
  assert.match(wire.prompt,/아래 안내 판정은 claim_kind=guidance인 항목에만 적용/u);
  assert.match(wire.prompt,/avoidance_guidance에는 sound_avoidance, problem_in_recommended_content, unclear 판정만 사용/u);
});

test('review helper applies the tested validity boundary after the actual current, causal and single-card instructions',()=>{
  assert.equal(GUIDANCE_REVIEW_BOUNDARY,'\n검토 경계: 사실·안전·선택권·카드 역할을 실제 원문 근거에 비추어 판단하세요. 돌봄 안내에는 이용자가 이미 하지 않았더라도 자신의 한계를 살피고, 휴식하거나 부담을 나누는 선택을 제안할 수 있습니다. 단지 표현이 일반적이거나 더 구체적인 조언이 가능하다는 이유만으로 근거 위반 판정을 내리지 말고, 그런 품질 차이는 별도 품질 단계에 남기세요. 반대로 원문에 없는 과거 행동, 현재 감정, 동의 또는 지원 자원을 사실로 추가하면 반려하세요. 각 판단은 현재 카드와 원문을 확인한 뒤 내리세요.');
  const f=fixture([claim('care.0','care','걱정되는 마음 때문에 무리하지 않도록 자신의 한계를 살펴보세요.')]);
  f.payload.review_scope={guide_fields:['care']};f.payload.semantic_review_focus=['care.0'];
  const before=structuredClone({payload:f.payload,schema:f.schema}),request=claimReviewRequest(f.payload,f.schema);
  const markers=['현재 검토 대상은 이번 claims와 guide입니다.','semantic_review_focus의 각 id는',
    '이번 호출에서는 guide의 care 카드 하나만 원문과 대조하세요.',GUIDANCE_REVIEW_BOUNDARY];
  for(const marker of markers)assert.equal(request.prompt.split(marker).length-1,1);
  assert.deepEqual(markers.map(marker=>request.prompt.indexOf(marker)),markers.map(marker=>request.prompt.indexOf(marker)).sort((a,b)=>a-b));
  assert.ok(request.prompt.endsWith(GUIDANCE_REVIEW_BOUNDARY));
  assert.deepEqual({payload:f.payload,schema:f.schema},before);
  assert.deepEqual(request.payload,guidanceReviewPayload(f.payload));assert.notEqual(request.schema,f.schema);
  assert.ok(f.request.prompt.endsWith(GUIDANCE_REVIEW_BOUNDARY));
  assert.ok(!f.request.prompt.includes('이번 호출에서는 guide의'));
  assert.ok(!f.request.prompt.includes('semantic_review_focus의 각 id는'));
});

test('care warmth and later usability checks preserve facts and actual role or action defects',()=>{
  assert.match(CARD_ROLES.care,/원문에서 표현한 감정과 구체적인 부담/u);
  assert.match(CARD_ROLES.care,/원문에 없는 성품·덕목·태도를 칭찬하거나 새로운 감정을 덧붙이지 마세요/u);
  assert.match(CARD_ROLES.care,/도울 범위를 정하는 방법, 다른 사람과 도움을 나누는 방법/u);
  assert.match(QUALITY_CHECK,/실제로 사용할 수 있다면 더 구체적으로 표현할 수 있다는 선택적인 개선을 새 필수 조건으로 만들지 마세요/u);
  assert.match(QUALITY_CHECK,/행동 방법이나 대안이 실제로 없거나 역할·안전·원문 근거의 오류가 남은 경우는 계속 지적하세요/u);
  assert.match(QUALITY,/중복과 일반론을 줄이며 가장 도움이 되는 수정 최대 3개/u);
  for(const prompt of [QUALITY,QUALITY_CHECK])assert.ok(!prompt.includes(GUIDANCE_REVIEW_BOUNDARY));
});

test('the guidance boundary never turns unsupported or uncertain care content into approval',()=>{
  for(const text of ['당신은 늘 용감하게 문제를 해결해 온 사람이군요.','지금 깊은 죄책감을 느끼고 계시군요.']){
    const f=fixture([claim('care.0','care',text)]);
    for(const [verdict,canonical] of [['problem_in_guidance','unsupported'],['unclear','plausible']]){
      const output={approved:false,issues:[{field:'care',reason:'현재 공감 문장에 원문에 없는 인물 평가나 감정을 추가했습니다.',repair:'보고한 감정에만 공감하세요.'}],
        audits:[{id:'care.0',verdict,reason:'원문은 이 인물 평가나 감정을 확인하지 않습니다.'}]};
      const original=structuredClone(output),result=f.request.validate(output);
      assert.equal(result.approved,false);assert.deepEqual(result.issues,original.issues);
      assert.deepEqual(result.audits,[{...original.audits[0],verdict:canonical}]);
      assert.deepEqual(output,original);
      assert.throws(()=>f.request.validate({...output,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
    }
  }
});

test('single-role requests use direct strict audit branches and preserve original canonical output contracts',()=>{
  const only=fixture(claims().slice(0,2)).request;
  assert.equal(only.schema.properties.audits.items.anyOf,undefined);
  assert.deepEqual(only.schema.properties.audits.items.properties.id.enum,['avoid.0','avoid.1']);
  for(const items of [[],claims().slice(2)]){
    const f=fixture(items);assert.deepEqual(f.request.payload,guidanceReviewPayload(f.payload));assert.notEqual(f.request.schema,f.schema);
    assert.equal(f.request.schema.properties.audits.items.anyOf,undefined);
    assert.deepEqual(f.request.schema.properties.audits.items.properties.verdict.enum,['sound_guidance','problem_in_guidance','unclear']);
    assert.deepEqual(Object.keys(f.request.schema.properties),['audits','issues','approved']);
    assert.deepEqual(Object.keys(f.request.schema.properties.audits.items.properties),['id','reason','verdict']);
    assert.match(f.request.prompt,/현재 검토 대상은 이번 claims와 guide/u);
    assert.deepEqual(f.request.validate(f.approval()).audits,f.approval().audits.map(a=>({...a,verdict:'supported'})));
  }
});

test('guidance projection copies only wire role metadata and keeps every original claim and source field intact',()=>{
  const f=fixture(),payload={...f.payload,claims:f.payload.claims.map(c=>({...c,evidence:[{quote:'합성 근거 전체'}]})),
    review_scope:{guide_fields:['avoid','doList']},semantic_review_focus:['avoid.0']};
  const before=structuredClone(payload),wire=guidanceReviewPayload(payload);
  assert.notEqual(wire,payload);assert.notEqual(wire.claims,payload.claims);
  for(const [key,value]of Object.entries(payload))if(key!=='claims')assert.deepEqual(wire[key],value,key);
  for(let index=0;index<payload.claims.length;index++){
    const {certainty,...canonical}=payload.claims[index],{claim_kind,...projected}=wire.claims[index];
    assert.equal(certainty,'reported');assert.deepEqual(projected,canonical);
    assert.equal(claim_kind,canonical.field==='avoid'?'avoidance_guidance':'guidance');
    assert.notEqual(wire.claims[index],payload.claims[index]);
  }
  assert.deepEqual(payload,before);
});

test('speech and support role instructions distinguish proposals from factual premises without approving by role',()=>{
  for(const prompt of [SPEECH_REVIEW,SUPPORT_REVIEW]){
    assert.match(prompt,/claim_kind=guidance는 생성한 안내 항목이라는 역할 표시이며 보고된 사실이나 승인 표시가 아닙니다/u);
    assert.match(prompt,/사실 서술·질문의 전제·열린 확인 질문·앞으로의 행동 제안이 섞일 수/u);
    assert.match(prompt,/사실과 질문의 전제는 같은 사람·시점의 원문 근거가 필요/u);
    assert.match(prompt,/원문에 없는 감정·동의·지원 자원·과거 행동을 질문이나 제안 속에 넣어도 계속 거절/u);
    assert.match(prompt,/화자가 표현하는 자신의 걱정·의도는 그 화자의 원문과 대조/u);
    assert.match(prompt,/역할 표시만으로 supported를 주지 말고 기존 판정 기준을 적용/u);
  }
  assert.ok(!SPEECH_REVIEW.includes('문장 하나에 관찰과 마음 추정이 함께 있으면'));
  assert.match(SPEECH_REVIEW,/원문으로 확인되지 않은 감정·동기·행동 원인의 단정/u);
  assert.match(SPEECH_REVIEW,/이용자가 직접 보고한 자신의 걱정이나 감정을 그 화자의 발화로 표현하는 것은 대상자의 내면 추정이 아닙니다/u);
  assert.match(SPEECH_REVIEW,/강요·책임 전가를 더하지 않았다면/u);
  assert.match(SPEECH_REVIEW,/원문에 없는 원인을 전제하면 unsupported/u);
});

test('support helper retains full current inputs, distinct scope, strict labels and original canonical review checks',()=>{
  const f=fixture([claim('care.0','care','원할 때 쉬는 시간을 정해 보세요.')]);
  f.payload.review_scope={guide_fields:['care']};f.payload.semantic_review_focus=['care.0'];
  f.payload.revision={changes:[{field:'care',before:{feel:'이미 지운 합성 감정 평가입니다.'},after:structuredClone(f.payload.guide.care)}]};
  const before=structuredClone({payload:f.payload,schema:f.schema});
  const request=claimReviewRequest(f.payload,f.schema,{support:true});
  assert.deepEqual(request.payload,guidanceReviewPayload(f.payload));
  assert.match(request.prompt,/역할: next와 care만 원문으로 검토/u);
  assert.equal(request.prompt.split('이번 호출에서는 guide의 care 카드 하나만').length-1,1);
  assert.ok(!request.prompt.includes('semantic_review_focus의 각 id는'));
  assert.ok(!request.prompt.includes('script만 대상자에게 그대로 건넬 직접 발화입니다'));
  assert.ok(request.prompt.endsWith(GUIDANCE_REVIEW_BOUNDARY));
  assert.deepEqual(Object.keys(request.schema.properties),['audits','issues','approved']);
  assert.deepEqual(request.schema.properties.audits.items.properties.verdict.enum,['sound_guidance','problem_in_guidance','unclear']);
  const approved=request.validate(f.approval());assert.equal(approved.approved,true);assert.equal(approved.audits[0].verdict,'supported');
  assert.deepEqual(approved.claims,f.payload.claims);
  const rejection=()=>({approved:false,issues:[{field:'care',reason:'현재 문장에 원문 밖 전제가 있습니다.',repair:'원문에 없는 전제를 제외하세요.'}],
    audits:[{id:'care.0',verdict:'problem_in_guidance',reason:'현재 전제를 원문에서 확인할 수 없습니다.'}]});
  for(const verdict of ['problem_in_guidance','unclear']){
    const output=rejection();output.audits[0].verdict=verdict;
    assert.equal(request.validate(output).approved,false);
    assert.throws(()=>request.validate({...output,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
  }
  for(const label of ['supported','unsupported','plausible','sound_avoidance','problem_in_recommended_content']){
    const output=rejection();output.audits[0].verdict=label;
    assert.throws(()=>request.validate(output),{code:'MODEL_INVALID_RESPONSE'});
  }
  const stale=rejection();stale.issues[0].reason='현재 문안에 포함된 “이미 지운 합성 감정 평가입니다.”는 원문 근거가 없습니다.';
  assert.throws(()=>request.validate(stale),{modelReason:'agent_review_stale'});
  const noop=rejection();noop.issues[0].repair=f.payload.claims[0].claim;
  assert.throws(()=>request.validate(noop),{modelReason:'agent_review_noop'});
  const missing=rejection();missing.issues[0].field='next';
  assert.throws(()=>request.validate(missing),{modelReason:'agent_review_targets'});
  assert.deepEqual({payload:f.payload,schema:f.schema},before);
});

for(const field of ['script','doList','next','care'])test(field+' wire guidance keeps canonical supported-only acceptance and exact audit coverage',()=>{
  const f=fixture([claim(field+'.0',field,'함께하기로 동의했으니 어떤 도움부터 받을지 물어보세요.'),
    claim(field+'.1',field,'도울 사람이 정해졌으니 그 사람에게 연락해 보세요.')]);
  assert.notEqual(f.request.schema,f.schema);
  assert.ok(f.request.payload.claims.every(c=>c.claim_kind==='guidance'&&!Object.hasOwn(c,'certainty')));
  const approved=f.request.validate(f.approval());
  assert.deepEqual(approved.claims,f.payload.claims);
  assert.ok(approved.claims.every(c=>c.certainty==='reported'&&!Object.hasOwn(c,'claim_kind')));
  for(const [verdict,canonical] of [['problem_in_guidance','unsupported'],['unclear','plausible']]){
    const output=f.approval();output.approved=false;output.audits[0].verdict=verdict;
    output.issues=[{field,reason:'제안에 포함된 동의 전제를 원문에서 확인할 수 없습니다.',repair:'동의를 전제하지 말고 현재 의사를 확인하세요.'}];
    const expected=structuredClone(output),result=f.request.validate(output);
    assert.equal(result.approved,false);assert.deepEqual(result.audits,expected.audits.map((a,index)=>({...a,verdict:index===0?canonical:'supported'})));assert.deepEqual(result.issues,expected.issues);
    assert.deepEqual(output,expected);
    assert.throws(()=>f.request.validate({...output,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
    // Support callers use the same strict adapter and original canonical claims.
    if(['care','next'].includes(field))assert.throws(()=>claimReviewRequest(f.payload,f.schema,{support:true}).validate({...output,approved:true,issues:[]}),{modelReason:'agent_claim_audit'});
  }
  for(const mutate of [o=>o.audits.pop(),o=>o.audits[1]={...o.audits[0]},o=>o.audits[0].id='missing.0',o=>o.audits[0].verdict='sound_avoidance']){
    const output=f.approval();mutate(output);assert.throws(()=>f.request.validate(output),{code:'MODEL_INVALID_RESPONSE'});
  }
});

for(const [wire,canonical] of [['problem_in_recommended_content','unsupported'],['unclear','plausible']])
test('rejected avoidance '+wire+' maps mechanically without changing approval, issues or reasons',()=>{
  const f=fixture(),output=rejected(f,wire),original=structuredClone(output),result=f.request.validate(output);
  assert.equal(result.audits[0].verdict,canonical);assert.equal(result.approved,false);
  assert.deepEqual(result.issues,output.issues);assert.equal(result.audits[0].reason,output.audits[0].reason);assert.deepEqual(output,original);
  const falseApproval={...output,approved:true,issues:[]};
  assert.throws(()=>f.request.validate(falseApproval),{modelReason:'agent_claim_audit'});
});

test('ordinary negative verdicts and a concrete issue despite all positive audits remain rejections',()=>{
  for(const [verdict,canonical] of [['problem_in_guidance','unsupported'],['unclear','plausible']]){
    const f=fixture(),output=f.approval();output.approved=false;output.audits[2].verdict=verdict;
    output.issues=[{field:'doList',reason:'현재 제안의 원문 범위가 맞지 않습니다.',repair:'실제 원문에 맞는 범위로 다시 작성하세요.'}];
    const result=f.request.validate(output);assert.equal(result.approved,false);assert.deepEqual(result.audits[2],{...output.audits[2],verdict:canonical});
  }
  const f=fixture(),output=rejected(f,'sound_avoidance'),result=f.request.validate(output);
  assert.equal(result.approved,false);assert.deepEqual(result.issues,output.issues);
});

for(const [name,mutate] of [
  ['missing audit',o=>o.audits.pop()],['duplicate ID',o=>o.audits[1]={...o.audits[0]}],
  ['invented ID',o=>o.audits[0].id='avoid.9'],['wrong field ID',o=>o.audits[0].id='script.0'],
  ['missing reason',o=>delete o.audits[0].reason],['blank reason',o=>o.audits[0].reason=' '],
  ['unknown label',o=>o.audits[0].verdict='correct'],['typed label on ordinary claim',o=>o.audits[2].verdict='sound_avoidance'],
  ...['supported','unsupported','plausible'].map(label=>['legacy avoidance label '+label,o=>o.audits[0].verdict=label]),
  ...['supported','unsupported','plausible'].map(label=>['legacy guidance label '+label,o=>o.audits[2].verdict=label]),
  ['guidance label on avoidance',o=>o.audits[0].verdict='sound_guidance'],
  ['extra approval metadata',o=>o.audits[0].approved=true],
])test('actual wire audit fails before canonical mapping: '+name,()=>{
  const f=fixture(),output=rejected(f);mutate(output);
  assert.throws(()=>f.request.validate(output),{code:'MODEL_INVALID_RESPONSE'});
});

test('typed rejection retains original stale-history, no-op repair and missing-target validation',()=>{
  const f=fixture();
  const stale=rejected(f);stale.issues[0].reason='현재 문안에 포함된 “이미 없어진 합성 문장입니다.”는 원문 근거가 없습니다.';
  assert.throws(()=>f.request.validate(stale),{modelReason:'agent_review_stale'});
  const noop=rejected(f);noop.issues[0].repair=f.payload.claims[0].claim;
  assert.throws(()=>f.request.validate(noop),{modelReason:'agent_review_noop'});
  const missing=rejected(f);missing.issues[0].field='doList';
  assert.throws(()=>f.request.validate(missing),{modelReason:'agent_review_targets'});
});

test('existing content checks still reject an unbounded recommended promise after a typed model approval',()=>{
  const f=fixture([claim('avoid.0','avoid','피할 말·행동: 질문을 재촉하기. 이유: 선택할 시간을 남겨야 합니다. 대신 “나는 항상 네 곁에 있을게.”라고 말하세요.')]);
  assert.equal(f.request.validate(f.approval()).approved,true,'fixture intentionally models a reviewer miss');
  const guide={script:'',doList:[],avoid:f.payload.guide.avoid,next:'',care:{feel:'',tips:[]}};
  assert.ok(knownSpeechIssues(guide,{patient:{fields:{}},supporter:{fields:{}}}).some(issue=>issue.field==='avoid'&&issue.reason==='이용자가 밝히지 않은 상시 지원을 약속합니다.'));
});

test('gateway rejects old wire verdicts on every attempt instead of interpreting them as new approval labels',async()=>{
  const f=fixture(),calls=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-only',protocol:'relationship_agent',diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      calls.push(JSON.parse(options.body));const output=f.approval();output.audits[0].verdict='supported';
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  await assert.rejects(model.operation({},operation=>model.agentComplete('speech_review',f.request.prompt,f.request.payload,
    f.request.schema,operation,f.request.validate)),{modelReason:'agent_schema',modelAttempts:3});
  assert.equal(calls.length,3);
  for(const body of calls){const data=JSON.parse(body.messages.at(-1).content).data;assert.deepEqual(data.answers,f.payload.answers);assert.deepEqual(data.guide,f.payload.guide);}
});

test('typed stale feedback invokes a fresh current-only review with all current strings and sources retained',async()=>{
  const f=fixture(claims().slice(0,2)),calls=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-only',protocol:'relationship_agent',diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);calls.push(input);
      assert.deepEqual(input.data.answers,f.payload.answers);assert.deepEqual(input.data.guide,f.payload.guide);
      assert.deepEqual(input.data.claims,f.request.payload.claims);
      const output=calls.length===1?rejected(f):f.approval();
      if(calls.length===1)output.issues[0].reason='현재 문안에 포함된 “이미 없어진 합성 문장입니다.”는 원문 근거가 없습니다.';
      else {
        assert.equal(input.data.revision,undefined);assert.equal(input.rejected_output,undefined);
        assert.match(input.validation_feedback,/agent_review_stale/u);
        assert.ok(!JSON.stringify(input).includes('이미 없어진 합성 문장입니다.'));
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  const result=await model.operation({},operation=>model.agentComplete('speech_review_card_avoid_after_repair_1',f.request.prompt,
    f.request.payload,f.request.schema,operation,f.request.validate));
  assert.equal(calls.length,2);assert.equal(result.approved,true);assert.deepEqual(result.claims,f.payload.claims);
});
