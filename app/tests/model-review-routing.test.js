import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const gateway=(baseUrl,fetchImpl,options={})=>new ModelGateway({baseUrl,apiKey:'synthetic-key',model:'synthetic-model',
  protocol:'relationship_agent',timeoutMs:0,fetchImpl,diagnosticLogger:()=>{},...options});
const complete=(model,stage,validate=value=>value,options={})=>model.operation(options,operation=>
  model.agentComplete(stage,'Synthetic instructions',{source:'synthetic'},schema,operation,validate));

test('review endpoint receives review stages and its own model settings without writer token policy',async()=>{
  const writerCalls=[],reviewCalls=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async(url,request)=>{
    reviewCalls.push({url,body:JSON.parse(request.body)});return response({ok:true});
  },{model:'synthetic-reviewer'});
  const writer=gateway('http://127.0.0.1:11434/v1',async(url,request)=>{
    writerCalls.push({url,body:JSON.parse(request.body)});return response({ok:true});
  },{reviewGateway:reviewer});
  for(const stage of ['turn_review','state_review_after_review','analysis_review_after_guide_review_repair',
    'plan_review_after_repair','speech_review_after_repair_2','support_review','guide_review_after_repair',
    'speech_detail_review_repair','safety_review','question_review','guide_quality','guide_quality_check',
    'speech_review_card_script_after_repair_1','support_review_card_care']){
    await writer.operation({},operation=>{
      operation.tokenPolicy={maxOutputTokens:17};
      return writer.agentComplete(stage,'Synthetic instructions',{},schema,operation,value=>value);
    });
  }
  assert.equal(reviewCalls.length,14);assert.equal(writerCalls.length,0);
  for(const call of reviewCalls){
    assert.equal(call.url,'http://192.0.2.2:11434/v1/chat/completions');
    assert.equal(call.body.model,'synthetic-reviewer');assert.equal(call.body.max_tokens,undefined);
  }
  for(const stage of ['turn_draft','state_observations','relationship_analysis','communication_plan',
    'guide_write','guide_refine','speech_write','guide_repair_2','analysis_repair_after_guide_review'])await complete(writer,stage);
  assert.equal(writerCalls.length,9);assert.equal(reviewCalls.length,14);
});

test('an independent writer request and reviewer request can run concurrently',async()=>{
  const started=[];let release;
  const bothStarted=new Promise(resolve=>{release=resolve;});
  const transport=endpoint=>async()=>{
    started.push(endpoint);if(started.length===2)release();
    await bothStarted;return response({ok:true});
  };
  const reviewer=gateway('http://192.0.2.2:11434/v1',transport('reviewer'));
  const writer=gateway('http://127.0.0.1:11434/v1',transport('writer'),{reviewGateway:reviewer});
  const result=await Promise.all([complete(writer,'guide_write'),complete(writer,'speech_review')]);
  assert.deepEqual(started,['writer','reviewer']);assert.deepEqual(result,[{ok:true},{ok:true}]);
});

test('reviewer output still passes the original validator and relays progress',async()=>{
  let writerCalls=0,reviewCalls=0,validations=0;const events=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async()=>{reviewCalls++;return response({ok:false});});
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>{writerCalls++;return response({ok:true});},{reviewGateway:reviewer});
  await assert.rejects(complete(writer,'speech_review',()=>{
    validations++;const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic rejection');
    error.modelReason='agent_claim_audit';throw error;
  },{onProgress:event=>events.push(event)}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_claim_audit'});
  assert.equal(writerCalls,0);assert.equal(reviewCalls,3);assert.equal(validations,3);
  assert.equal(events.filter(event=>event.stage==='speech_review'&&event.status==='started').length,3);
  assert.equal(events.some(event=>event.status==='completed'),false);
});

test('delegated validation failures stop after three attempts when writer recovery is disabled',async()=>{
  const controller=new AbortController(),records=[],inputs=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async(_url,request)=>{
    inputs.push(JSON.parse(JSON.parse(request.body).messages[1].content));
    if(inputs.length===6)controller.abort(); // Bound the regression if nested recovery returns.
    return response({ok:false});
  },{retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('No writer request expected'),{reviewGateway:reviewer});
  await assert.rejects(complete(writer,'speech_review',()=>{
    const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic rejection');
    error.modelReason='agent_review_targets';error.modelFeedback='Missing issue field doList';throw error;
  },{signal:controller.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_review_targets'});
  assert.equal(inputs.length,3);assert.equal(reviewer.retryFailures,true);
  assert.deepEqual(inputs.map(input=>Object.hasOwn(input,'rejected_output')),[false,true,true]);
  assert.ok(inputs.slice(1).every(input=>input.validation_feedback.includes('Missing issue field doList')));
  assert.equal(records.some(entry=>entry.event==='model_operation_retry'),false);
});

test('delegated transient failures keep the request retry ceiling without nested operation recovery',async()=>{
  let calls=0;const records=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async()=>{
    calls++;return calls<=3?new Response('',{status:503}):response({ok:true});
  },{retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('No writer request expected'),{reviewGateway:reviewer});
  await assert.rejects(complete(writer,'guide_review'),{code:'MODEL_UNAVAILABLE',modelReason:'http_transient'});
  assert.equal(calls,3);assert.equal(reviewer.retryFailures,true);
  assert.equal(records.filter(entry=>entry.event==='model_retry_wait').length,2);
  assert.equal(records.some(entry=>entry.event==='model_operation_retry'),false);
});

test('an exhausted delegated review cannot restart either operation with recovery enabled',async()=>{
  let calls=0,operations=0;const writerRecords=[],reviewRecords=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async()=>response({ok:++calls>3}),
    {retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>reviewRecords.push(entry)});
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('No writer request expected'),
    {reviewGateway:reviewer,retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>writerRecords.push(entry)});
  const run=()=>writer.operation({},operation=>{
    operations++;
    return writer.agentComplete('speech_review','Synthetic instructions',{},schema,operation,value=>{
      if(!value.ok){const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic rejection');error.modelReason='agent_claim_audit';throw error;}
      return value;
    });
  });
  await assert.rejects(run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_claim_audit',modelAttempts:3});
  assert.equal(calls,3);assert.equal(operations,1);
  assert.deepEqual(await run(),{ok:true});assert.equal(calls,4);assert.equal(operations,2);
  assert.equal(writerRecords.filter(entry=>entry.event==='model_operation_retry').length,0);
  assert.equal(reviewRecords.some(entry=>entry.event==='model_operation_retry'),false);
  assert.equal(reviewer.retryFailures,true);
});

test('reviewer authentication failure cannot silently fall back to the writer',async()=>{
  let writerCalls=0;
  const reviewer=gateway('http://192.0.2.2:11434/v1',async()=>new Response('{}',{status:401}));
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>{writerCalls++;return response({ok:true});},{reviewGateway:reviewer});
  await assert.rejects(complete(writer,'guide_review'),{code:'MODEL_AUTH_FAILED'});assert.equal(writerCalls,0);
});

test('cancelling the owning request aborts the separate reviewer request',async()=>{
  const controller=new AbortController();let started,reviewSignal;
  const requestStarted=new Promise(resolve=>{started=resolve;});
  const reviewer=gateway('http://192.0.2.2:11434/v1',async(_url,{signal})=>{
    reviewSignal=signal;started();return new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  });
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>{throw Error('Writer must not be called');},{reviewGateway:reviewer});
  const result=complete(writer,'guide_review',value=>value,{signal:controller.signal});
  const rejected=assert.rejects(result,{code:'MODEL_CANCELLED'});
  await requestStarted;controller.abort();await rejected;assert.equal(reviewSignal.aborted,true);
});

test('invalid or recursive reviewer configuration fails before any model request',async()=>{
  const fetchImpl=async()=>{throw Error('No network expected');};
  const invalid=gateway('invalid',fetchImpl);
  const writer=gateway('http://127.0.0.1:11434/v1',fetchImpl,{reviewGateway:invalid});
  assert.equal(writer.configured,false);await assert.rejects(complete(writer,'guide_write'),{code:'MODEL_NOT_CONFIGURED'});
  writer.reviewGateway=writer;assert.equal(writer.configured,false);
  const nested=gateway('http://192.0.2.2:11434/v1',fetchImpl,{reviewGateway:writer});
  writer.reviewGateway=nested;assert.equal(writer.configured,false);
});

test('operation retries reset approved previews and close callbacks belonging to earlier attempts',async()=>{
  const events=[],callbacks=[];let attempts=0;
  const model=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('No transport needed'),{retryFailures:true,retryDelayMs:1});
  const result=await model.operation({onCard:event=>events.push(event)},async operation=>{
    callbacks.push(operation.onCard);attempts++;
    if(attempts===1){
      operation.onCard({type:'upsert',id:'care',value:'first approved attempt'});
      throw new HttpError(503,'MODEL_UNAVAILABLE','Synthetic interruption');
    }
    callbacks[0]({type:'upsert',id:'script',value:'late previous attempt'});
    assert.deepEqual(events,[{type:'upsert',id:'care',value:'first approved attempt'},{type:'reset'}]);
    operation.onCard({type:'upsert',id:'care',value:'current approved attempt'});
    return {ok:true};
  });
  callbacks[1]({type:'upsert',id:'next',value:'late completed attempt'});
  assert.deepEqual(result,{ok:true});assert.equal(attempts,2);
  assert.deepEqual(events,[{type:'upsert',id:'care',value:'first approved attempt'},{type:'reset'},
    {type:'upsert',id:'care',value:'current approved attempt'}]);
});

test('cancellation resets previews once and prevents all later card events',async()=>{
  const controller=new AbortController(),events=[];let callback;
  const model=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('No transport needed'));
  await assert.rejects(model.operation({signal:controller.signal,onCard:event=>events.push(event)},async operation=>{
    callback=operation.onCard;callback({type:'upsert',id:'relationship',value:{approved:true}});
    controller.abort();callback({type:'upsert',id:'care',value:'late cancelled card'});
    return {ok:true};
  }),{code:'MODEL_CANCELLED'});
  callback({type:'upsert',id:'next',value:'late settled card'});
  assert.deepEqual(events,[{type:'upsert',id:'relationship',value:{approved:true}},{type:'reset'}]);
});

test('review operations receive the card callback without resetting writer previews after a successful review',async()=>{
  const events=[];
  const reviewer=gateway('http://192.0.2.2:11434/v1',async()=>response({ok:true}));
  const reviewOperation=reviewer.operation.bind(reviewer);let forwarded=false;
  reviewer.operation=(options,...args)=>{forwarded=typeof options.onCard==='function';return reviewOperation(options,...args);};
  const writer=gateway('http://127.0.0.1:11434/v1',async()=>assert.fail('Only reviewer expected'),{reviewGateway:reviewer});
  await writer.operation({onCard:event=>events.push(event)},async operation=>{
    operation.onCard({type:'upsert',id:'relationship',value:{approved:true}});
    await writer.agentComplete('speech_review_card_care','Synthetic instructions',{},schema,operation,value=>value);
    operation.onCard({type:'upsert',id:'care',value:'approved card'});
  });
  assert.equal(forwarded,true);
  assert.deepEqual(events.map(event=>event.type),['upsert','upsert']);
});
