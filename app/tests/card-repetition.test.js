import test from 'node:test';
import assert from 'node:assert/strict';
import {cardRepetition,cardRepetitionIssue} from '../src/card-repetition.js';
import {fixture,guide,assertDetail} from './helpers/final-flow-fixture.js';

const repeated='네가 원하지 않으면 지금은 이야기하지 않아도 괜찮아.';
const loop=()=>Array(16).fill(repeated).join(' ');
test('detects a clear exact sentence generation loop without changing text',()=>{
 const value=loop();const detail=cardRepetition('script',value);
 assert.equal(detail.maximum_occurrences,16);assert.equal(value,loop());
 assert.equal(cardRepetitionIssue('script',value).field,'script');
});
test('does not reject ordinary short or sparse repetition',()=>{
 assert.equal(cardRepetition('script',repeated+' 다른 방법도 생각해 볼 수 있어. '+repeated),null);
 assert.equal(cardRepetition('next',Array(7).fill(repeated).join(' ')),null);
 const unique=Array.from({length:80},(_,i)=>`서로 다른 합성 안내 ${i}번의 내용을 확인해 보세요.`).join(' ');
 assert.equal(cardRepetition('script',Array(8).fill(repeated).join(' ')+unique),null);
 assert.equal(cardRepetition('script','네. '.repeat(100)),null);
});
test('care and array cards retain exact independent values for the diagnostic',()=>{
 const care={feel:loop(),tips:['잠시 쉬어 보세요.']},before=structuredClone(care);
 assert.ok(cardRepetition('care',care));assert.deepEqual(care,before);
 assert.ok(cardRepetition('doList',[loop()]));
});
for(const prioritizeSpeechPreview of [false,true])test(`repairs only looping cards before any review; preview=${prioritizeSpeechPreview}`,async()=>{
 const valid=guide(),bad=structuredClone(valid);bad.guide.script=valid.guide.script+' '+loop();bad.guide.next=loop();
 const p=fixture({prioritizeSpeechPreview,compactReviewInputs:true,shareReviewSources:true,response:input=>{
  if(input.stage==='guide_write')return bad;
 }});
 const result=await p.run();assertDetail(result);assert.deepEqual(result.guide,valid.guide);
 const stages=p.stages(),repairs=stages.filter(stage=>stage.includes('_repetition_'));
 assert.equal(stages.filter(stage=>stage==='guide_write').length,1);
 assert.deepEqual(repairs,['guide_repair_card_script_repetition_1','guide_repair_card_next_repetition_1']);
 const firstReview=stages.findIndex(stage=>stage.startsWith('speech_review_card_')||stage.startsWith('final_review_bundle_initial'));
 assert.ok(firstReview>stages.indexOf(repairs[1]));
 const writer=p.requests.find(r=>r.input.stage==='guide_write').input.data;
 for(const request of p.requests.filter(r=>r.input.stage.includes('_repetition_'))){
  assert.equal(Object.hasOwn(request.input.data,'current'),false);
  assert.deepEqual(request.input.data.answers,writer.answers);
  assert.equal(request.input.data.repetition_diagnostic.maximum_occurrences,16);
  assert.equal(JSON.stringify(request.input.data).includes(loop()),false);
 }
 for(const request of p.logicalRequests.filter(r=>/^(?:speech|support|guide)_review|^guide_quality/u.test(r.stage)))
  assert.equal(JSON.stringify(request.data).includes(loop()),false);
 for(const event of p.events)assert.equal(JSON.stringify(event).includes(loop()),false);
});
test('repeated regeneration stops after two field repairs without review or publication',async()=>{
 const bad=guide();bad.guide.next=loop();
 const p=fixture({response:input=>input.stage==='guide_write'?bad:input.stage.startsWith('guide_repair_card_next')?{next:loop()}:undefined});
 await assert.rejects(p.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_card_repetition'});
 assert.deepEqual(p.stages().filter(s=>s.includes('_repetition_')),['guide_repair_card_next_repetition_1','guide_repair_card_next_repetition_2']);
 assert.equal(p.stages().some(s=>s.startsWith('final_review_bundle_initial')||s.startsWith('speech_review_card_')),false);
 assert.equal(p.events.some(e=>e.type==='upsert'&&e.id!=='relationship'),false);
});
