import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMemoryCase,checksum} from './project_memory_review_cases.mjs';

// Purpose-made regression fixture; no original counseling/training excerpts.
const fixture=()=>({case_id:'fixture-001',split:'train',origin_type:'test_fixture',
  turn1:'성인 지인이 모임 준비를 맡았다고 했어요. 저는 정리만 도울 수 있어요. 저는 역할을 나누고 싶어요. 장소는 북쪽 방이라고 들었어요.',
  turn2:'장소를 정정할게요. 지인이 남쪽 방으로 옮겼다고 했어요.',
  facts:[{subject:'patient',turn:1,quote:'성인 지인이 모임 준비를 맡았다고 했어요.'},
    {subject:'supporter',turn:1,quote:'저는 정리만 도울 수 있어요.'},
    {subject:'user_goal',turn:1,quote:'저는 역할을 나누고 싶어요.'},
    {subject:'patient',turn:2,quote:'지인이 남쪽 방으로 옮겼다고 했어요.'}],
  superseded:[{subject:'patient',turn:1,quote:'장소는 북쪽 방이라고 들었어요.'}],
  unknowns:['정리를 도울 구체적인 시간']});
const input=row=>JSON.parse(row.messages[1].content);
const target=row=>JSON.parse(row.messages.at(-1).content);

test('each time scope has one accepted and one rejected target; actual app callbacks validate all',async()=>{
  const source=fixture(),result=await projectMemoryCase(source);
  assert.equal(result.case_sha256,checksum(source));
  assert.equal(result.rows.length,4);
  for(const stage of [1,2]) {
    const rows=result.rows.filter(row=>row.review_metadata.stage===stage);
    assert.deepEqual(rows.map(row=>target(row).state.approved),[true,false]);
    assert.deepEqual(rows.map(row=>row.review_metadata.app_structural_validation),[true,true]);
    for(const row of rows) {
      assert.equal(row.task,'memory_review');
      assert.equal(target(row).state.approved,target(row).state.issues.length===0);
    }
  }
});

test('changing only future dialogue, facts and unknowns cannot change first-turn requests or labels',async()=>{
  const before=fixture(),after=fixture();
  after.turn2='추가 정정으로 지인이 다음 주 온라인 모임으로 바꿨다고 했어요.';
  after.facts[3].quote='지인이 다음 주 온라인 모임으로 바꿨다고 했어요.';
  after.unknowns=['온라인 접속 방법'];
  const a=await projectMemoryCase(before),b=await projectMemoryCase(after);
  assert.deepEqual(a.rows.slice(0,2).map(row=>row.messages),b.rows.slice(0,2).map(row=>row.messages));
  assert.ok(!a.rows[0].messages[1].content.includes('남쪽'));
  assert.ok(!a.rows[1].messages[1].content.includes('정리를 도울 구체적인 시간'));
});

test('candidate corruption does not modify original source/context or leak mutation labels into input',async()=>{
  const source=fixture(),original=structuredClone(source),result=await projectMemoryCase(source,1);
  assert.deepEqual(source,original);
  for(const stage of [1,2]) {
    const [good,bad]=result.rows.filter(row=>row.review_metadata.stage===stage).map(input);
    assert.deepEqual(good.data.review_target.input,bad.data.review_target.input);
    assert.deepEqual(good.data.review_target.reference_roles,bad.data.review_target.reference_roles);
    assert.ok(!JSON.stringify(bad).includes('review_metadata'));
    assert.ok(!JSON.stringify(bad).includes(source.case_id));
    assert.ok(!JSON.stringify(bad).includes('source_split'));
    assert.ok(!JSON.stringify(bad).includes('superseded_as_current'));
    assert.deepEqual(Object.keys(bad.data).sort(),['questions','review_target','safety','shared_input']);
  }
});

test('known-as-unknown uses typed app verdict and preserves other unresolved items',async()=>{
  const source=fixture();source.superseded=[];
  const result=await projectMemoryCase(source,0),bad=result.rows[3];
  assert.equal(bad.review_metadata.error_type,'known_as_unknown');
  const answer=target(bad),failed=answer.state.audits.find(a=>a.id===bad.review_metadata.failed_claim_id);
  assert.equal(failed.verdict,'already_answered');
  assert.equal(answer.state.approved,false);
  assert.equal(answer.state.issues.length,1);
  assert.ok(failed.reason.includes(source.facts[3].quote));
  const before=input(result.rows[2]).data.review_target.claims,after=input(bad).data.review_target.claims;
  assert.equal(before.length,after.length);
  assert.ok(after.some(c=>c.id==='patient_state.unknowns.0'&&c.claim===source.unknowns[0]));
  assert.ok(before.find(c=>c.id===bad.review_metadata.failed_claim_id).claim.startsWith('확인되지 않은 정보: “'));
  assert.ok(after.find(c=>c.id===bad.review_metadata.failed_claim_id).claim.startsWith('확인되지 않은 정보: “'));
  const finalGood=target(result.rows[2]);
  assert.ok(finalGood.state.audits.some(a=>a.verdict==='still_unknown'));
});

test('stale correction is injected after canonicalization and remains visible to reviewer',async()=>{
  const source=fixture(),result=await projectMemoryCase(source),bad=result.rows[3];
  assert.equal(bad.review_metadata.error_type,'superseded_as_current');
  const request=input(bad),claim=request.data.review_target.claims.find(c=>c.id===bad.review_metadata.failed_claim_id);
  assert.ok(claim.claim.startsWith('이용자가 대상자에 관해 보고한 답변 원문:\n“'));
  assert.equal(claim.evidence.length,input(result.rows[2]).data.review_target.claims.find(c=>c.id===claim.id).evidence.length);
  assert.ok(claim.claim.includes('북쪽'));
  assert.ok(!claim.claim.includes('남쪽'));
  assert.ok(JSON.stringify(request.data.review_target.input).includes('남쪽'));
  const audit=target(bad).state.audits.find(a=>a.id===claim.id);
  assert.equal(audit.verdict,'unsupported');
  assert.ok(audit.reason.includes('남쪽'));
});

test('memory reviewer does not emit question or safety judgments and audits every visible claim once',async()=>{
  const result=await projectMemoryCase(fixture(),3);
  for(const row of result.rows) {
    const request=input(row),answer=target(row);
    assert.equal(request.stage,'turn_review');
    assert.equal(request.data.questions,null);
    assert.equal(request.data.safety,null);
    assert.equal(answer.questions,null);
    assert.equal(answer.safety,null);
    assert.deepEqual(answer.state.audits.map(a=>a.id).sort(),request.data.review_target.claims.map(c=>c.id).sort());
    assert.equal(new Set(answer.state.audits.map(a=>a.id)).size,answer.state.audits.length);
  }
});


test('normal/error candidates share reported wrappers and claim/unknown counts at each stage',async()=>{
  for(let index=0;index<12;index++) {
    const source=fixture();if(index%2)source.superseded=[];
    const result=await projectMemoryCase(source,index);
    for(const stage of [1,2]) {
      const [good,bad]=result.rows.filter(row=>row.review_metadata.stage===stage);
      const a=input(good).data.review_target.claims,b=input(bad).data.review_target.claims;
      assert.equal(a.length,b.length);
      assert.equal(a.filter(c=>c.kind==='unresolved_information').length,b.filter(c=>c.kind==='unresolved_information').length);
      if(stage===1)assert.ok(b.every(c=>c.kind!=='unresolved_information'));
      for(const claim of [...a,...b].filter(c=>c.certainty==='reported')) {
        assert.match(claim.claim,/^이용자가 (대상자에 관해|자신의 상황에 관해) 보고한 답변 원문:\n“/u);
        assert.ok(claim.claim.endsWith('”'));
      }
    }
  }
});

test('previous perfect style classifier has paired counterexamples, not label information',async()=>{
  let correct=0,total=0;
  for(let index=0;index<12;index++) {
    const source=fixture();if(index%2)source.superseded=[];
    for(const row of (await projectMemoryCase(source,index)).rows) {
      const claims=input(row).data.review_target.claims;
      const predictsRejection=claims.some(c=>c.certainty==='reported'&&!c.claim.startsWith('이용자가 ')||c.claim.includes('라고 보고했는지 여부'));
      correct+=Number(predictsRejection===!target(row).state.approved);total++;
    }
  }
  assert.equal(correct/total,0.5);
});

test('wrong-person and goal negatives use real quoted source evidence under the wrong group',async()=>{
  for(const index of [0,1]) {
    const source=fixture(),row=(await projectMemoryCase(source,index)).rows[1];
    const claim=input(row).data.review_target.claims.find(c=>c.id===row.review_metadata.failed_claim_id);
    assert.equal(claim.group,'patient');
    assert.notEqual(claim.evidence[0].subject,'patient');
    assert.ok(source.turn1.includes(claim.evidence[0].quote));
    assert.ok(claim.claim.includes('“'+claim.evidence[0].quote+'”'));
    assert.equal(target(row).state.audits.find(a=>a.id===claim.id).verdict,'unsupported');
  }
});
