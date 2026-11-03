import test from 'node:test';
import assert from 'node:assert/strict';
import {previewConfig,isolatePreviewCookies,seedPreview,previewGateway} from '../scripts/preview-continuations.js';
import {initialQuestionSet} from '../src/question-bank.js';

const url='postgresql://postgres@127.0.0.1:49488/hop_followup_preview';
test('preview requires an explicit dedicated loopback database and rejects production or remote targets',()=>{
  assert.deepEqual(previewConfig({PREVIEW_DATABASE_URL:url}),{databaseUrl:url,port:9011,modelMode:'synthetic'});
  for(const env of [{DATABASE_URL:url},{PREVIEW_DATABASE_URL:url,NODE_ENV:'production'},
    {PREVIEW_DATABASE_URL:url.replace('127.0.0.1','example.com')},{PREVIEW_DATABASE_URL:url.replace('hop_followup_preview','production')},
    {PREVIEW_DATABASE_URL:url+'?options=unsafe'},{PREVIEW_DATABASE_URL:url,PREVIEW_PORT:'0'},
    {PREVIEW_DATABASE_URL:url,PREVIEW_MODEL_MODE:'remote'}])assert.throws(()=>previewConfig(env));
});

test('local preview uses a separate port and the full fixed loopback model pipeline',()=>{
  const config=previewConfig({PREVIEW_DATABASE_URL:url,PREVIEW_MODEL_MODE:'local',MODEL_BASE_URL:'https://example.com/v1'});
  assert.deepEqual(config,{databaseUrl:url,port:9012,modelMode:'local'});
  const gateway=previewGateway(config.modelMode);
  assert.equal(gateway.configured,true);assert.equal(gateway.baseUrl,'http://127.0.0.1:11434/v1');
  assert.equal(gateway.model,'gemma4:12b');assert.equal(gateway.protocol,'relationship_agent');
  assert.equal(gateway.stateMode,'combined_blocks');assert.equal(gateway.reasoningEffort,'none');
  assert.equal(gateway.discoverTokenLimits,true);assert.equal(gateway.streamJson,true);assert.equal(gateway.streamCompleteJson,true);
  assert.equal(gateway.retryFailures,true);assert.equal(gateway.timeoutMs,0);
  assert.equal(gateway.skipFinalExtras,false);assert.equal(gateway.reuseFinalDraft,false);
  assert.equal(gateway.reviewGateway,null);assert.throws(()=>previewGateway('remote'));
});

test('preview cookies ignore real app sessions and roundtrip under a dedicated name',()=>{
  const headers={};
  const response=()=>({setHeader(name,value){headers[name]=value;return this;}});
  const incoming={headers:{cookie:'malssi_session=real-app-token; other=value'}},res=response();
  isolatePreviewCookies(incoming,res,9011);
  assert.equal(incoming.headers.cookie,'');
  res.setHeader('Set-Cookie','malssi_session=preview-token; Path=/; HttpOnly; SameSite=Strict');
  assert.equal(headers['Set-Cookie'],'malssi_continuation_preview_9011=preview-token; Path=/; HttpOnly; SameSite=Strict');
  const returning={headers:{cookie:'malssi_session=real-app-token; '+headers['Set-Cookie'].split(';')[0]}};
  isolatePreviewCookies(returning,response(),9011);
  assert.equal(returning.headers.cookie,'malssi_session=preview-token');
  const anotherPort={headers:{cookie:headers['Set-Cookie'].split(';')[0]}};
  const arrayResponse=response();isolatePreviewCookies(anotherPort,arrayResponse,9012);
  assert.equal(anotherPort.headers.cookie,'');
  arrayResponse.setHeader('set-cookie',['malssi_session=another-token; HttpOnly']);
  assert.deepEqual(headers['set-cookie'],['malssi_continuation_preview_9012=another-token; HttpOnly']);
});

test('each seeded browser gets an owned original and an active additional session with separate cards',async()=>{
  const records=[],intakes=[],sessions=[];
  const store={questionSet:async()=>initialQuestionSet,
    createIntake:async(owner,state)=>{const row={id:'intake-'+owner,state};intakes.push(row);return row;},
    nextRecordId:async()=>records.length+1,
    saveRecord:async(owner,record,intakeId)=>records.push({owner,record,intakeId}),
    createContinuation:async(owner,recordId)=>({id:'continuation-'+owner,revision:0,state:{status:'active',messages:[],cards:[]}}),
    updateContinuation:async(owner,id,revision,mutate)=>{const row={id,revision:revision+1,state:mutate({status:'active',messages:[],cards:[]})};sessions.push(row);return row;}};
  const first=await seedPreview(store,'first'),second=await seedPreview(store,'second');
  assert.deepEqual(records.map(r=>r.owner),['first','second']);
  assert.notEqual(first.record.id,second.record.id);assert.notEqual(first.continuation.id,second.continuation.id);
  assert.equal(first.record.title,'[예시] 친구 민서');assert.equal(first.continuation.state.status,'active');
  assert.notEqual(first.record.guide.script,first.continuation.state.cards[0].guide.script);
  assert.equal(first.record.context.patient.fields.describe.status,'answered');
  assert.equal(first.record.context.supporter.fields.feeling.status,'answered');
  first.continuation.state.cards[0].guide.care.tips.push('변경');
  assert.equal(first.record.guide.care.tips.includes('변경'),false);
  assert.equal(second.continuation.state.cards[0].guide.care.tips.includes('변경'),false);
});

test('preview does not turn arbitrary questions into facts and marks its answer simulated',async()=>{
  const result=await previewGateway().continueConversation({messages:[{id:'question',role:'user',text:'만약 친구가 답장이 없다면요?'}]});
  assert.match(result.answer,/미리보기 예시 답변/);assert.deepEqual(result.facts,[]);assert.equal(result.safety.urgent,false);
});

test('local preview seeds only the original, leaving all followup responses and cards to the real model',async()=>{
  const records=[];
  const store={questionSet:async()=>initialQuestionSet,
    createIntake:async(owner,state)=>({id:'intake-'+owner,state}),nextRecordId:async()=>1,
    saveRecord:async(owner,record)=>records.push(record),
    createContinuation:async()=>({id:'continuation',revision:0,state:{status:'active',messages:[],cards:[]}}),
    updateContinuation:async()=>assert.fail('local preview must not seed followup fixtures')};
  const seeded=await seedPreview(store,'local',{modelMode:'local'});
  assert.equal(records.length,1);assert.equal(seeded.record.title,'[예시] 친구 민서');
  assert.equal(seeded.continuation.revision,0);
  assert.deepEqual(seeded.continuation.state.messages,[]);assert.deepEqual(seeded.continuation.state.cards,[]);
  assert.ok(seeded.record.guide.script);assert.ok(seeded.record.relationship_analysis.relationship);
  assert.equal(seeded.record.context.patient.fields.rel.status,'answered');
  assert.equal(seeded.record.context.patient.fields.rel.text,'친구');
  assert.equal(seeded.record.context.profileInput.rel,seeded.record.profile.rel);
});

test('preview delay honors cancellation instead of keeping a fake generation alive',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(previewGateway().respond({},null,{signal:controller.signal}),{name:'AbortError'});
});
