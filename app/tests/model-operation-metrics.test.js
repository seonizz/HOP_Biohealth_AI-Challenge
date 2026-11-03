import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const response=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
const make=(records,fetchImpl=async()=>response())=>new ModelGateway({baseUrl:'http://127.0.0.1:18080/v1',apiKey:'private-key',
  protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,fetchImpl,diagnosticLogger:entry=>records.push(entry)});
const stage=(gateway,operation,name,data={})=>gateway.agentComplete(name,'synthetic',data,schema,operation,value=>value);

test('bundled review requests stay on the independent reviewer and count actual HTTP attempts',async()=>{
  const records=[],writer=make(records,()=>assert.fail('review must not use the writer endpoint'));
  writer.reviewGateway=make(records);
  await writer.operation({},async operation=>{
    await stage(writer,operation,'final_review_bundle');
    await stage(writer,operation,'final_review_bundle_after_analysis_repair');
    await stage(writer,operation,'card_review_bundle_care');
    await stage(writer,operation,'card_review_bundle_next_after_review');
    await stage(writer,operation,'turn_review_bundle');
    await stage(writer,operation,'turn_review_bundle_after_review');
  });
  const attempts=records.filter(row=>row.event==='model_attempt');
  assert.equal(attempts.length,6);
  assert.deepEqual(attempts.map(row=>row.model_role),Array(6).fill('reviewer'));
  assert.deepEqual(attempts.map(row=>row.http_attempt_index),[1,2,3,4,5,6]);
  assert.deepEqual(attempts.map(row=>row.family_http_attempts),[
    {final_review_bundle:1},{final_review_bundle:2},{card_review_bundle:1},{card_review_bundle:2},{turn_review_bundle:1},{turn_review_bundle:2}]);
});

test('writer, delegated reviewer and classifier share one operation but distinct attempt roles',async()=>{
  const records=[],writer=make(records);writer.reviewGateway=make(records);
  await writer.operation({},async operation=>{
    await stage(writer,operation,'guide_write');
    await stage(writer,operation,'guide_review');
    await stage(writer,operation,'referral_triage');
    await stage(writer,operation,'referral_triage_independent');
  });
  const attempts=records.filter(row=>row.event==='model_attempt');
  assert.equal(new Set(attempts.map(row=>row.operation_id)).size,1);
  assert.deepEqual(attempts.map(row=>row.http_attempt_index),[1,2,3,4]);
  assert.deepEqual(attempts.map(row=>row.model_role),['writer','reviewer','classifier','classifier']);
  assert.deepEqual(attempts.slice(2).map(row=>row.family_http_attempts.referral_triage),[1,2]);
  assert.equal(new Set(attempts.map(row=>row.gateway_fingerprint)).size,1);
  assert.doesNotMatch(JSON.stringify(records),/private-key|127\.0\.0\.1|synthetic/);
});

test('restarts and repairs retain operation counts without introducing a deadline or restart cap',async()=>{
  const records=[];let count=0;
  const gateway=make(records,async()=>{if(++count<=3)return new Response('busy',{status:503,headers:{'Retry-After':'0'}});return response();});
  gateway.retryFailures=true;gateway.retryDelayMs=1;
  await gateway.operation({},async operation=>{
    assert.equal(operation.deadline,Infinity);
    await stage(gateway,operation,'guide_write');
    await stage(gateway,operation,'guide_repair',{field:'script',private_text:'PRIVATE_PAYLOAD'});
    await stage(gateway,operation,'analysis_repair_after_guide_review');
    await stage(gateway,operation,'analysis_review_after_guide_review_repair');
  });
  const attempts=records.filter(row=>row.event==='model_attempt');
  assert.equal(new Set(attempts.map(row=>row.operation_id)).size,1);
  assert.deepEqual(attempts.map(row=>row.http_attempt_index),[1,2,3,4,5,6,7]);
  assert.equal(attempts[3].operation_restart,1);
  assert.deepEqual(attempts[4].family_http_attempts,{card_script:5});
  assert.deepEqual(attempts[5].family_http_attempts,{final_analysis:1});
  assert.deepEqual(attempts[6].family_http_attempts,{analysis_review:1});
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_PAYLOAD/);
  const id=attempts[0].operation_id;
  await gateway.operation({},operation=>stage(gateway,operation,'guide_write'));
  assert.notEqual(records.at(-1).operation_id,id);
  assert.equal(records.at(-1).http_attempt_index,1);
});

test('parallel stage attempts capture their own immutable indices and telemetry cannot cause output loss',async()=>{
  const records=[],releases=[];
  const gateway=make(records,()=>new Promise(resolve=>releases.push(()=>resolve(response()))));
  const pending=gateway.operation({},async operation=>{
    const all=Promise.all([stage(gateway,operation,'card_care'),stage(gateway,operation,'card_next')]);
    releases[1]();releases[0]();return all;
  });
  assert.equal((await pending).length,2);
  assert.deepEqual(records.map(row=>row.http_attempt_index),[2,1]);
  const failingLogger=make([]);failingLogger.diagnosticLogger=()=>{throw new Error('log failed');};
  assert.deepEqual(await failingLogger.operation({},operation=>stage(failingLogger,operation,'guide_write')),{ok:true});
});

test('an already-cancelled request does not create an HTTP attempt',async()=>{
  const records=[],gateway=make(records,()=>assert.fail('must not dispatch'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(gateway.operation({signal:controller.signal},operation=>stage(gateway,operation,'guide_write')),
    error=>error.code==='MODEL_CANCELLED');
  assert.equal(records.filter(row=>row.event==='model_attempt').length,0);
});
