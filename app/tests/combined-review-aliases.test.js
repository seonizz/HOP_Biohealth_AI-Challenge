import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {requestCombinedStateReview} from '../src/relationship-turn.js';

const unknown=(group,index,claim)=>({id:group+'.unknowns.'+index,kind:'unresolved_information',claim,certainty:'unknown',evidence:[]});
const originals=()=>[
  {id:'patient.0',kind:'reported_excerpt',claim:'보고된 합성 상태',certainty:'reported',evidence:[{subject:'patient',question_id:'mood',quote:'PRIVATE_SOURCE'}]},
  unknown('patient_state',0,'현재 원하는 도움의 범위'),unknown('relationship_memory',0,'현재 원하는 도움의 범위'),
];
const payload=claims=>({shared_input:{},review_target:{input:{patient:[{question_id:'mood',answers:[{text:'PRIVATE_SOURCE'}]}],
  supporter:[],user_goal:[],retrieval:{documents:[{text:'PRIVATE_SOURCE'}]}},state:{patient_state:{facts:[{quote:'PRIVATE_SOURCE'}]},name_index:null},
  claims,reference_roles:{known_name:null,user_goal_fields:[],supporter_report_fields:[]}},questions:null,safety:null});
const approval=claims=>({state:{approved:true,issues:[],audits:claims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'독립 검토: '+claim.id}))},questions:null,safety:null});
function fixture(claims=originals(),edit=output=>output){
  const input=payload(claims),calls=[],outputs=[];
  const gateway=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'json_schema',timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),request=JSON.parse(body.messages.at(-1).content);calls.push({body,request});
      const output=edit(approval(request.data.review_target.claims),request,calls.length);outputs.push(structuredClone(output));
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {input,calls,outputs,run:()=>gateway.operation({},operation=>requestCombinedStateReview(gateway,input,operation))};
}

test('exact cross-array unknowns use one model audit then regain every original ID with sources unchanged',async()=>{
  const f=fixture(),before=structuredClone(f.input),result=await f.run();
  assert.equal(f.calls.length,1);
  const request=f.calls[0].request,wire=request.data.review_target;
  assert.deepEqual(wire.claims,before.review_target.claims.slice(0,2));
  for(const key of ['input','state','reference_roles'])assert.deepEqual(wire[key],before.review_target[key]);
  const branches=request.output_schema.properties.state.properties.audits.items.anyOf;
  assert.deepEqual(Object.keys(request.output_schema.properties.state.properties),['audits','issues','approved']);
  assert.deepEqual(request.output_schema.properties.state.required,['audits','issues','approved']);
  for(const branch of branches){
    assert.deepEqual(Object.keys(branch.properties),['id','reason','verdict']);
    assert.deepEqual(branch.required,['id','reason','verdict']);
  }
  assert.deepEqual(branches.map(branch=>branch.properties.id.enum),[['patient_state.unknowns.0'],['patient.0']]);
  assert.deepEqual(branches[0].properties.verdict.enum,['still_unknown','already_answered','not_needed','review_uncertain']);
  assert.deepEqual(branches[1].properties.verdict.enum,['supported','plausible','unsupported']);
  assert.equal(request.output_schema.properties.state.properties.audits.minItems,2);
  assert.deepEqual(result.state.audits.map(audit=>audit.id),before.review_target.claims.map(claim=>claim.id));
  assert.deepEqual(result.state.audits[2],{...result.state.audits[1],id:'relationship_memory.unknowns.0'});
  assert.equal(f.outputs[0].state.audits[1].verdict,'still_unknown');
  assert.equal(result.state.audits[1].verdict,'supported');
  assert.equal(result.state.audits[1].reason,f.outputs[0].state.audits[1].reason);
  assert.deepEqual(result.state.issues,f.outputs[0].state.issues);assert.equal(result.state.approved,f.outputs[0].state.approved);
  assert.equal(f.outputs[0].state.audits.length,2);assert.deepEqual(f.input,before);
});

for(const [patientCount,relationshipCount]of [[2,1],[1,2],[2,2],[2,0],[0,2]])
test('cross-array matching is one-to-one and preserves same-group multiplicity: '+patientCount+'/'+relationshipCount,async()=>{
  const claims=[...Array.from({length:patientCount},(_,i)=>unknown('patient_state',i,'동일한 합성 미확인 범위')),
    ...Array.from({length:relationshipCount},(_,i)=>unknown('relationship_memory',i,'동일한 합성 미확인 범위'))];
  const f=fixture(claims),result=await f.run(),wire=f.calls[0].request.data.review_target.claims;
  assert.equal(wire.length,Math.max(patientCount,relationshipCount));assert.equal(result.state.audits.length,claims.length);
  assert.deepEqual(result.state.audits.map(audit=>audit.id),claims.map(claim=>claim.id));
  for(let i=0;i<Math.min(patientCount,relationshipCount);i++){
    const canonical=result.state.audits.find(audit=>audit.id==='patient_state.unknowns.'+i);
    assert.deepEqual(result.state.audits.find(audit=>audit.id==='relationship_memory.unknowns.'+i),{...canonical,id:'relationship_memory.unknowns.'+i});
  }
});

for(const different of ['현재 원하는 도움의 범위 ','현재  원하는 도움의 범위','현재 원하지 않는 도움의 범위','다른 사람의 도움 범위'])
test('different raw strings are never coalesced: '+JSON.stringify(different),async()=>{
  const claims=originals();claims[2].claim=different;const f=fixture(claims),result=await f.run();
  assert.deepEqual(f.calls[0].request.data.review_target.claims,claims);
  assert.deepEqual(result,{...f.outputs[0],state:{...f.outputs[0].state,audits:f.outputs[0].state.audits.map(audit=>({
    ...audit,verdict:'supported',
  }))}});
});

test('Unicode-normalized equivalence is insufficient for review input coalescing',async()=>{
  const claims=originals();claims[1].claim='도움 방식 A';claims[2].claim='도움 방식 Ａ';
  const f=fixture(claims);await f.run();assert.deepEqual(f.calls[0].request.data.review_target.claims,claims);
});

for(const [name,mutate]of [
  ['different kind',claim=>{claim.kind='reported_excerpt';}],
  ['different certainty',claim=>{claim.certainty='reported';}],
  ['nonempty evidence',claim=>{claim.evidence=[{subject:'patient',question_id:'mood',quote:'PRIVATE_SOURCE'}];}],
])test('only unqualified unresolved-information claims may share an audit: '+name,async()=>{
  const claims=originals();mutate(claims[2]);const f=fixture(claims);await f.run();
  assert.deepEqual(f.calls[0].request.data.review_target.claims,claims);
});

for(const [verdict,canonical]of [['already_answered','unsupported'],['not_needed','unsupported'],['review_uncertain','plausible']])
test('a typed rejected unknown maps its verdict and copies its exact reason to every original alias: '+verdict,async()=>{
  const f=fixture(originals(),output=>{
    output.state.approved=false;output.state.issues=[{reason:'현재 범위가 이미 답한 내용을 포함합니다.',repair:'실제 미확인 범위로 수정하세요.'}];
    Object.assign(output.state.audits[1],{verdict,reason:'원문과 범위가 일치하지 않습니다.'});return output;
  });
  const result=await f.run();assert.equal(result.state.approved,false);assert.deepEqual(result.state.issues,f.outputs[0].state.issues);
  assert.deepEqual(result.state.audits[1],{...f.outputs[0].state.audits[1],verdict:canonical});
  assert.deepEqual(result.state.audits[2],{...f.outputs[0].state.audits[1],verdict:canonical,id:'relationship_memory.unknowns.0'});
  assert.equal(f.calls.length,1);
});

for(const [name,mutate]of [
  ['missing actual audit',output=>{output.state.audits.pop();}],
  ['duplicate actual audit',output=>{output.state.audits[1]=output.state.audits[0];}],
  ['unrequested alias instead of actual audit',output=>{output.state.audits[1].id='relationship_memory.unknowns.0';}],
  ['invented audit ID',output=>{output.state.audits[1].id='patient_state.unknowns.7';}],
  ['missing verdict',output=>{delete output.state.audits[1].verdict;}],
  ['unrecognized verdict',output=>{output.state.audits[1].verdict='unknown';}],
  ['supported legacy unknown verdict',output=>{output.state.audits[1].verdict='supported';}],
  ['unsupported canonical self-approval',output=>{output.state.audits[1].verdict='unsupported';}],
  ['plausible canonical self-approval',output=>{output.state.audits[1].verdict='plausible';}],
  ['typed label on a reported claim',output=>{output.state.audits[0].verdict='still_unknown';}],
  ['already answered self-approval',output=>{output.state.audits[1].verdict='already_answered';}],
  ['not needed self-approval',output=>{output.state.audits[1].verdict='not_needed';}],
  ['uncertain self-approval',output=>{output.state.audits[1].verdict='review_uncertain';}],
])test('actual model audit validation fails before any alias expansion: '+name,async()=>{
  const f=fixture(originals(),output=>{mutate(output);return output;});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelAttempts:3});assert.equal(f.calls.length,3);
  for(const {request}of f.calls)assert.deepEqual(request.data.review_target.claims.map(claim=>claim.id),['patient.0','patient_state.unknowns.0']);
});

for(const verdict of ['supported','plausible','unsupported'])
test('legacy unknown verdicts also fail in a rejected wire review: '+verdict,async()=>{
  const f=fixture(originals(),output=>{
    output.state.approved=false;output.state.issues=[{reason:'원문의 범위를 다시 검토해야 합니다.',repair:'범위를 원문과 대조하세요.'}];
    output.state.audits[1].verdict=verdict;return output;
  });
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:3});
});

for(const verdict of ['supported','plausible','unsupported'])
test('ordinary claim verdicts remain verbatim alongside typed unknown audits: '+verdict,async()=>{
  const claims=originals();claims[0].kind='tentative_hypothesis';claims[0].certainty='tentative';
  const f=fixture(claims,output=>{
    output.state.audits[0].verdict=verdict;
    if(verdict==='unsupported'){
      output.state.approved=false;output.state.issues=[{reason:'원문이 현재 가설을 뒷받침하지 않습니다.',repair:'가설을 실제 원문 범위로 수정하세요.'}];
    }
    return output;
  });
  const result=await f.run();assert.deepEqual(result.state.audits[0],f.outputs[0].state.audits[0]);
  assert.equal(result.state.approved,f.outputs[0].state.approved);assert.deepEqual(result.state.issues,f.outputs[0].state.issues);
  assert.deepEqual(result.state.audits.slice(1).map(audit=>audit.verdict),['supported','supported']);
});

test('empty claims retain exact empty coverage and ordinary schema',async()=>{
  const f=fixture([]),result=await f.run();assert.deepEqual(result,f.outputs[0]);
  assert.deepEqual(result.state.audits,[]);assert.equal(f.calls.length,1);
});

test('a missing actual audit must be independently repaired before aliases are expanded',async()=>{
  const f=fixture(originals(),(output,_request,count)=>{if(count===1)output.state.audits.pop();return output;});
  const result=await f.run();assert.equal(f.calls.length,2);assert.equal(result.state.audits.length,3);
  assert.deepEqual(f.calls[1].request.required_audit_ids,['patient.0','patient_state.unknowns.0']);
  assert.deepEqual(f.calls[1].request.data,f.calls[0].request.data);assert.equal(f.calls[1].request.rejected_output,undefined);
});

test('positive canonical audits do not override a concrete missing-correction rejection',async()=>{
  const f=fixture(originals(),output=>{
    output.state.approved=false;output.state.issues=[{reason:'최신 거절을 보존한 finding이 누락됐습니다.',repair:'해당 원문의 거절과 시점을 보존하세요.'}];return output;
  });
  const result=await f.run();assert.equal(result.state.approved,false);assert.deepEqual(result.state.issues,f.outputs[0].state.issues);
  assert.ok(result.state.audits.every(audit=>audit.verdict==='supported'));assert.equal(result.state.audits.length,3);assert.equal(f.calls.length,1);
});
