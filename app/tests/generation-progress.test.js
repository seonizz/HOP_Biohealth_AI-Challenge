import test from 'node:test';
import assert from 'node:assert/strict';
import { generationProgress } from '../src/generation-progress.js';

const finishStage=(progress,stage,attempt=1)=>{
  progress.event({stage,status:'started',attempt});
  progress.event({stage,status:'completed',attempt});
};

test('bundled reviews use existing public phases and repair still invalidates downstream completion',()=>{
  const progress=generationProgress();
  finishStage(progress,'guide_write');
  finishStage(progress,'card_review_bundle_care');
  assert.equal(progress.state.step_index,2);
  finishStage(progress,'final_review_bundle');
  assert.equal(progress.state.step_index,3);
  assert.equal(progress.state.current,'최종 답안 검토');
  progress.event({stage:'guide_repair_card_care',status:'started'});
  assert.equal(progress.state.step_index,2);
  assert.equal(progress.state.completed.some(item=>item.label==='최종 답안 검토'),false);
  finishStage(progress,'final_review_bundle_after_review');
  progress.finish('saving');assert.equal(progress.state.step_index,4);
  progress.finish('complete');assert.equal(progress.state.progress,100);
  assert.doesNotMatch(JSON.stringify(progress.state),/bundle|schema|prompt/);
});
const statuses=progress=>progress.state.steps.map(step=>step.status);

test('generation advances at real phase boundaries and reaches 100 only after storage completes',()=>{
  const progress=generationProgress();
  assert.equal(progress.state.progress,0);
  assert.equal(progress.state.step_total,5);
  assert.deepEqual(statuses(progress),['current','pending','pending','pending','pending']);
  for(const stage of ['state_observations','relationship_memory','state_review','relationship_analysis','analysis_review'])finishStage(progress,stage);
  assert.equal(progress.state.progress,0);
  finishStage(progress,'communication_plan');
  assert.equal(progress.state.progress,20);
  finishStage(progress,'plan_review');
  for(const stage of ['guide_write','card_care','card_doList','card_avoid','card_next','guide_quality','guide_refine','guide_quality_check','speech_opening','speech_listening','speech_offer','speech_write'])finishStage(progress,stage);
  assert.equal(progress.state.progress,40);
  for(const stage of ['speech_review','support_review','guide_review','speech_detail','speech_detail_review'])finishStage(progress,stage);
  assert.equal(progress.state.progress,60);
  assert.deepEqual(statuses(progress),['complete','complete','complete','current','pending']);
  progress.finish('saving');
  assert.equal(progress.state.progress,80);
  assert.equal(progress.state.current,'결과 저장하기');
  assert.deepEqual(statuses(progress),['complete','complete','complete','complete','current']);
  progress.finish('complete');
  assert.equal(progress.state.progress,100);
  assert.equal(progress.state.step_index,5);
  assert.deepEqual(statuses(progress),Array(5).fill('complete'));
});

test('stage retries and duplicate completion events do not add completed phases',()=>{
  const progress=generationProgress();
  finishStage(progress,'relationship_analysis');
  finishStage(progress,'communication_plan');
  const completed=structuredClone(progress.state.completed);
  progress.event({stage:'plan_review',status:'started',attempt:2});
  assert.equal(progress.state.progress,20);
  assert.equal(progress.state.attempt,2);
  assert.deepEqual(progress.state.completed,completed);
  finishStage(progress,'plan_review',2);
  const count=progress.state.completed.length;
  progress.event({stage:'plan_review',status:'completed',attempt:2});
  assert.equal(progress.state.completed.length,count);
  assert.equal(progress.state.progress,20);
});

test('whole operation retry discards every completed phase and resumes at the beginning',()=>{
  const progress=generationProgress();
  for(const stage of ['relationship_analysis','communication_plan','guide_write','speech_review'])finishStage(progress,stage);
  assert.equal(progress.state.progress,60);
  progress.event({stage:'retry',status:'started',attempt:1});
  assert.equal(progress.state.progress,0);
  assert.equal(progress.state.step_index,0);
  assert.equal(progress.state.attempt,2);
  assert.deepEqual(progress.state.completed,[]);
  assert.deepEqual(statuses(progress),['current','pending','pending','pending','pending']);
  finishStage(progress,'relationship_analysis');
  finishStage(progress,'communication_plan');
  assert.equal(progress.state.progress,20);
  assert.deepEqual(progress.state.completed.map(item=>item.label),['관계 분석','말하기 전략 작성']);
});

test('late analysis repair invalidates the dependent plan, guide and reviews',()=>{
  const progress=generationProgress();
  for(const stage of ['relationship_analysis','communication_plan','guide_write','guide_review'])finishStage(progress,stage);
  progress.event({stage:'analysis_repair_after_guide_review',status:'started'});
  assert.equal(progress.state.progress,0);
  assert.deepEqual(progress.state.completed,[]);
  assert.deepEqual(statuses(progress),['current','pending','pending','pending','pending']);
  for(const stage of ['analysis_repair_after_guide_review','analysis_review_after_guide_review_repair','communication_plan_after_analysis_repair'])finishStage(progress,stage);
  assert.equal(progress.state.progress,20);
});

test('rewriting a guide preserves earlier valid phases and invalidates later completed work',()=>{
  const progress=generationProgress();
  for(const stage of ['relationship_analysis','communication_plan','guide_write','guide_review'])finishStage(progress,stage);
  progress.event({stage:'guide_write_after_analysis_repair',status:'started'});
  assert.equal(progress.state.progress,40);
  assert.deepEqual(statuses(progress),['complete','complete','current','pending','pending']);
  assert.deepEqual(progress.state.completed.map(item=>item.label),['관계 분석','말하기 전략 작성']);
});

test('failed or unknown stages cannot imply completion or expose raw stage data',()=>{
  const progress=generationProgress();
  finishStage(progress,'guide_write');
  progress.event({stage:'private raw input <do not display>',status:'started'});
  assert.equal(progress.state.progress,40);
  assert.doesNotMatch(JSON.stringify(progress.state),/private raw input|do not display/);
  progress.finish('failed');
  assert.equal(progress.state.status,'failed');
  assert.equal(progress.state.progress,40);
  assert.equal(progress.state.steps.at(-1).status,'pending');
});


test('parallel completions do not invalidate stages already reviewing another card',()=>{
  const progress=generationProgress();
  finishStage(progress,'guide_write');finishStage(progress,'speech_review');
  finishStage(progress,'card_care');
  assert.equal(progress.state.progress,60);
  assert.ok(progress.state.completed.some(item=>item.label==='건넬 말과 행동의 근거 검토'));
});

test('partial cards are immutable snapshots with stable completion order and explicit invalidation',()=>{
  const progress=generationProgress(),care={feel:'승인된 공감',tips:['쉬어가세요']};
  progress.card({type:'upsert',id:'care',value:care});care.feel='뒤늦은 변경';
  progress.card({type:'upsert',id:'next',value:'작은 제안'});
  const snapshot=progress.cards();assert.equal(snapshot[0].value.feel,'승인된 공감');
  snapshot[0].value.feel='외부 변경';assert.equal(progress.cards()[0].value.feel,'승인된 공감');
  progress.card({type:'upsert',id:'care',value:{feel:'검토된 수정',tips:[]}});
  assert.deepEqual(progress.cards().map(card=>card.id),['care','next']);
  progress.card({type:'remove',id:'care'});assert.deepEqual(progress.cards().map(card=>card.id),['next']);
  progress.card({type:'upsert',id:'private',value:'비공개'});assert.equal(progress.cards().length,1);
  progress.card({type:'reset'});assert.deepEqual(progress.cards(),[]);
});
