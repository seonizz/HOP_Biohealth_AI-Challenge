import test from 'node:test';
import assert from 'node:assert/strict';
import {unknownAssessment,validateAssessment,validateResponse,comparison,decideAlerts,decidePolicy,thresholds,RUBRIC_VERSION} from '../src/v2/assessment.ts';
const message=(content:string)=>[{id:'turn-1',content,speaker:'supporter' as const}];
const reported=(content:string,key='anxiety',score=2,timeframe=1)=>{
  const result:any={schema_version:1,...unknownAssessment()};
  result[key]={score,source:2,timeframe,evidence:[{message_index:0,start_cp:0,end_cp:[...content].length}]};
  return result;
};
test('B output is numeric-only, exact schema and grounded to the patient',()=>{
  const content='엄마가 요즘 불안해서 잠을 못 주무세요.';
  const value=validateAssessment(reported(content),message(content));
  assert.equal(value.anxiety.score,2);assert.equal(value.anxiety.evidence[0].message_id,'turn-1');
  assert.throws(()=>validateAssessment({...reported(content),explanation:'high'},message(content)));
  assert.throws(()=>validateAssessment({...reported(content),anxiety:{...reported(content).anxiety,score:'2'}},message(content)));
  assert.throws(()=>validateAssessment(reported('제가 요즘 불안해요'),message('제가 요즘 불안해요')));
  assert.throws(()=>validateAssessment(reported(content,'anxiety',2,3),message(content)));
  assert.throws(()=>validateAssessment(reported(content,'anxiety',2,1),message('엄마는 괜찮아요')));
  assert.equal(validateAssessment({schema_version:1,...unknownAssessment()},message(content)).anxiety.score,-1);
});
test('comparison excludes unknown, other subject metadata and incompatible model/rubric',()=>{
  const content='엄마가 요즘 불안해요';
  const current=validateAssessment(reported(content,'anxiety',3),message(content));
  const old=unknownAssessment();old.anxiety={...current.anxiety,score:1};
  const history=[{turn_id:'old',status:0,model_sha256:'same',prompt_version:'v1',rubric_version:RUBRIC_VERSION,normalized:old,created_at:'2026-10-09T00:00:00Z'}];
  const change=comparison(current,history,'same','v1');
  assert.deepEqual(change.trend.anxiety,{comparable:true,delta:2});
  assert.equal(comparison(current,history,'other','v1').trend.anxiety.comparable,false);
  assert.equal(decidePolicy(current,0),'reflect_and_clarify');
  assert.ok(decideAlerts(current,change.trend,0,thresholds()).includes('anxiety_absolute'));
  assert.deepEqual(decideAlerts(unknownAssessment(),change.trend,3,thresholds()),['assessment_unavailable']);
});
test('A response exposes only a verified message',()=>{
  assert.deepEqual(validateResponse({message:' 천천히 이야기해 주세요. '}),{message:'천천히 이야기해 주세요.'});
  assert.throws(()=>validateResponse({message:'안녕하세요',score:3}));
  assert.throws(()=>validateResponse({message:'<script>alert(1)</script>'}));
  assert.throws(()=>validateResponse({message:'그분은 불안장애입니다.'}));
  assert.throws(()=>validateResponse({message:'약을 끊으세요.'}));
});
