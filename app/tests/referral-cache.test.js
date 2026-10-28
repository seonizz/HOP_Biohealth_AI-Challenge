import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {createIntake,answerIntake} from '../src/intake.js';
import {createReferralGuidance} from '../src/referral-guidance.js';
import {createReferralDirectory} from '../src/referral-directory.js';
import {createCharacterRegistry} from '../src/guide-characters.js';

const owner='owner-a',id='intake-a';
const text='  합성 원문 첫 줄.\n잠들기 어려워서 상담할 곳을 알아보고 싶다고 했어요.  ';
const readyState=()=>({...answerIntake(answerIntake(createIntake(),{question_id:'name',text:'합성 친구'}),{question_id:'want',text}),status:'ready'});
const directory=(name='합성 상담 기관')=>createReferralDirectory({schema_version:'1.0',institutions:[{id:'synthetic-center',name,active:true,
  urgencies:['immediate','soon','planned','undetermined'],phone:null,booking_url:'https://example.invalid/book',last_verified_on:'2026-10-18'}]});
const plan=input=>{const source=input.sources.find(source=>source.question_id==='want');return {
  schema_version:'1.0',subject:'patient',urgency:'soon',reviewed:true,evidence_source_ids:[source.id],
  institution_ids:['synthetic-center'],model_version:'synthetic-model-v1',
  concerns:[{code:'mental_health_concern',subject:'patient',evidence_source_ids:[source.id]}],
};};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

// Exercise real encrypted Store reads/writes, transactions and revision checks
// using a small relational adapter; no database or model server is contacted.
function fixture({provider=plan,status='ready',...options}={}){
  let row,transactionRow,ownerActive=true,clock=1000000,calls=0;
  const queries=[];
  const client={release(){},async query(sql,params=[]){
    queries.push(sql);
    if(sql==='BEGIN'){transactionRow=row?structuredClone(row):null;return {rowCount:0,rows:[]};}
    if(sql==='COMMIT'){row=transactionRow;return {rowCount:0,rows:[]};}
    if(sql==='ROLLBACK'){transactionRow=null;return {rowCount:0,rows:[]};}
    if(sql.includes('SELECT conversation_epoch FROM browsers'))return {rowCount:ownerActive&&params[0]===owner?1:0,rows:[{conversation_epoch:0}]};
    if(sql.includes('SELECT revision,content FROM intakes'))return {rowCount:transactionRow&&params[0]===id&&params[1]===owner?1:0,rows:transactionRow?[structuredClone(transactionRow)]:[]};
    if(sql.startsWith('UPDATE intakes SET content=')){transactionRow.content=params[0];return {rowCount:1,rows:[]};}
    if(sql.startsWith('UPDATE intakes SET revision=')){transactionRow={revision:params[0],content:params[1]};return {rowCount:1,rows:[]};}
    if(sql.startsWith('INSERT INTO patient_'))return {rowCount:1,rows:[]};
    throw new Error('Unexpected test query');
  }};
  const pool={connect:async()=>client,query:async(sql,params)=>{
    queries.push(sql);
    if(sql.includes('SELECT revision,content FROM intakes'))return {rowCount:row&&params[0]===id&&params[1]===owner?1:0,rows:row?[structuredClone(row)]:[]};
    throw new Error('Unexpected test pool query');
  }};
  const store=new Store(pool,randomBytes(32)),initial=readyState();initial.status=status;
  row={revision:4,content:store.seal(initial,`${owner}:intake:${id}`)};
  const trusted=input=>{calls++;return provider(input);};
  if(provider.cacheKey)Object.defineProperty(trusted,'cacheKey',{value:provider.cacheKey});
  const makeService=extra=>createReferralGuidance({store,directory:directory(),provider:trusted,cacheVersion:'test-policy-v1',now:()=>clock,...options,...extra});
  const service=makeService();
  const assess=(revision=row?.revision??4,extra={})=>service.assess(owner,id,{revision,...extra},'synthetic-request');
  const state=()=>row?store.open(row.content,`${owner}:intake:${id}`):null;
  const change=operation=>{const next=state();operation(next);row.content=store.seal(next,`${owner}:intake:${id}`);};
  return {store,service,makeService,assess,state,change,queries,calls:()=>calls,clock:value=>{clock=value;},delete:()=>{row=null;},expire:()=>{ownerActive=false;},revision:()=>row?.revision};
}

test('a completed validated guide survives refresh and service restart without another model classification',async()=>{
  const f=fixture(),first=await f.assess();
  const second=await f.assess();assert.deepEqual(second,first);assert.equal(f.calls(),1);
  const restarted=f.makeService();assert.deepEqual(await restarted.assess(owner,id,{revision:4},'after-restart'),first);assert.equal(f.calls(),1);
  const cache=f.state().referralAssessment;assert.equal(cache.revision,4);assert.equal(cache.schema_version,'1.0');
  assert.equal(JSON.stringify(cache).includes(text),false);assert.deepEqual(first.guidance.concerns[0].quotes,[{question_id:'want',text}]);
  const updates=f.queries.filter(sql=>sql.startsWith('UPDATE intakes'));
  assert.equal(updates.length,1);assert.doesNotMatch(updates[0],/updated_at|SET revision/u);assert.equal(f.revision(),4);
});

test('cached plan keeps current presentation and does not persist derived character or raw quotation fields',async()=>{
  const characters=createCharacterRegistry({schema_version:'1.0',default_character_id:'bulssi',characters:[
    {id:'bulssi',display_name:'불씨',avatar_path:null,state_assets:{}},{id:'other',display_name:'다른 불씨',avatar_path:null,state_assets:{}},
  ]});
  const f=fixture({characters}),first=await f.assess(),second=await f.assess(4,{character_id:'other'});
  assert.equal(second.presentation.id,'other');assert.deepEqual(first.guidance,second.guidance);assert.equal(f.calls(),1);
  assert.equal(f.state().referralAssessment.presentation,undefined);assert.equal(f.state().referralAssessment.guidance,undefined);
});

test('cached completion has a bounded TTL and expiration performs full classification again',async()=>{
  const f=fixture({cacheTtlMs:100});await f.assess();f.clock(1000099);await f.assess();assert.equal(f.calls(),1);
  f.clock(1000100);await f.assess();assert.equal(f.calls(),2);assert.equal(f.state().referralAssessment.saved_at,1000100);
});

test('routing calendar rollover expires a cached contact before its assessment TTL',async()=>{
  const f=fixture();f.clock(86399999);await f.assess();f.clock(86400000);await f.assess();assert.equal(f.calls(),2);
});

test('a policy, provider model, catalog, or source change cannot reuse an older assessment',async()=>{
  for(const kind of ['policy','model','catalog','source']){
    const f=fixture();await f.assess();let next,replacementCalls=0;
    if(kind==='policy')next=f.makeService({cacheVersion:'new-policy'});
    if(kind==='model'){const provider=input=>{replacementCalls++;return plan(input);};Object.defineProperty(provider,'cacheKey',{value:'new-model'});next=f.makeService({provider});}
    if(kind==='catalog')next=f.makeService({directory:directory('변경된 합성 기관')});
    if(kind==='source'){f.change(state=>{state.ans.want.rawText=state.ans.want.text='새로운 합성 답변';});next=f.makeService();}
    await next.assess(owner,id,{revision:4},'new-assessment');
    if(kind==='model')assert.equal(replacementCalls,1);else assert.equal(f.calls(),2);
  }
});

test('malformed cached plans are revalidated against current source IDs and never bypass the model boundary',async()=>{
  for(const mutate of [cache=>{cache.plan.concerns[0].evidence_source_ids=['forged'];},cache=>{cache.plan.institution_ids=['forged'];},cache=>{cache.saved_at=Infinity;},cache=>{cache.saved_at=1000001;},cache=>{cache.revision=3;}]){
    const f=fixture();await f.assess();f.change(state=>mutate(state.referralAssessment));await f.assess();assert.equal(f.calls(),2);
  }
});

test('failed or active classifications are not retained as completed guide assessments',async()=>{
  for(const settings of [{status:'active'},{provider:()=>{throw new Error('private provider error');}}]){
    const f=fixture(settings);await f.assess();assert.equal(f.state().referralAssessment,undefined);
    assert.equal(f.queries.some(sql=>sql.startsWith('UPDATE intakes SET content=')),false);
  }
});

test('stored assessment before final guide creation is carried into the final revision without losing either result',async()=>{
  for(const mutateInPlace of [false,true]){
    const f=fixture();const first=await f.assess();
    await f.store.updateIntake(owner,id,4,state=>mutateInPlace?Object.assign(state,{agentRecord:{id:7,guide:{script:'저장된 합성 말'}}}):
      {...state,agentRecord:{id:7,guide:{script:'저장된 합성 말'}}},'model_update');
    assert.equal(f.state().agentRecord.guide.script,'저장된 합성 말');assert.equal(f.state().referralAssessment.revision,5);
    const reloaded=await f.assess(5);assert.deepEqual(reloaded.guidance,first.guidance);assert.equal(f.calls(),1);
  }
});

test('final guide saved before a running assessment is retained when that assessment commits',async()=>{
  const started=deferred(),release=deferred();const f=fixture({provider:async input=>{started.resolve();await release.promise;return plan(input);}});
  const pending=f.assess();await started.promise;
  await f.store.updateIntake(owner,id,4,state=>({...state,agentRecord:{id:8,guide:{script:'먼저 완료한 가이드'}}}),'model_update');
  release.resolve();await assert.rejects(pending,{code:'REVISION_CONFLICT'});
  assert.equal(f.state().agentRecord.guide.script,'먼저 완료한 가이드');assert.equal(f.state().referralAssessment.revision,5);
  const refreshed=await f.assess(5);assert.equal(refreshed.guidance.concerns[0].quotes[0].text,text);assert.equal(f.calls(),1);
});

test('ordinary corrections remove cached assessments even when their literal source happens to remain unchanged',async()=>{
  const f=fixture();await f.assess();await f.store.updateIntake(owner,id,4,state=>({...state,status:'active'}),'correction');
  assert.equal(f.state().referralAssessment,undefined);await f.assess(5);assert.equal(f.calls(),2);
});

test('a guide completion changing source evidence cannot carry a previous assessment into its new revision',async()=>{
  const f=fixture();await f.assess();await f.store.updateIntake(owner,id,4,state=>{
    state.ans.want.rawText=state.ans.want.text='변경한 합성 원문';return {...state,agentRecord:{id:9}};
  },'model_update');assert.equal(f.state().referralAssessment,undefined);
});

test('a correction or deletion while classification runs cannot save or return stale guidance',async()=>{
  for(const deletion of [false,true]){
    const started=deferred(),release=deferred();const f=fixture({provider:async input=>{started.resolve();await release.promise;return plan(input);}});
    const pending=f.assess();await started.promise;
    if(deletion)f.delete();else await f.store.updateIntake(owner,id,4,state=>({...state,status:'active'}),'correction');
    release.resolve();await assert.rejects(pending,deletion?{status:404}:{code:'REVISION_CONFLICT'});assert.equal(f.state()?.referralAssessment,undefined);
  }
});

test('cached data still requires owner access and disappears with its original intake',async()=>{
  const f=fixture();await f.assess();await assert.rejects(f.service.assess('other-owner',id,{revision:4},'foreign'),{status:404});
  f.delete();await assert.rejects(f.assess(),{status:404});assert.equal(f.calls(),1);
});

test('cancellation and expired owner checks prevent classification metadata writes',async()=>{
  const started=deferred(),release=deferred();const f=fixture({provider:async input=>{started.resolve();await release.promise;return plan(input);}});
  const signal=new AbortController(),pending=f.service.assess(owner,id,{revision:4},'cancelled',{signal:signal.signal});
  await started.promise;signal.abort();await assert.rejects(pending,{code:'REFERRAL_CANCELLED'});release.resolve();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state().referralAssessment,undefined);
  const existing=fixture();await existing.assess();const assessment=existing.state().referralAssessment;existing.expire();
  await assert.rejects(existing.store.saveReferralAssessment(owner,id,4,assessment),{status:404});
});
