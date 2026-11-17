import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {streamJsonResponse} from '../src/model-stream.js';
import {validateSchema} from '../src/relationship-agent.js';
import {HttpError} from '../src/errors.js';

const encoder=new TextEncoder();
const event=(content,finish_reason=null)=>'data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason}]})+'\n\n';
const response=(fragments,{open=false,onCancel=()=>{},bytes=false}={})=>new Response(new ReadableStream({
  start(controller){
    const wire=fragments.map(value=>event(value)).join('')+(open?'':event('','stop'));
    if(bytes)for(const byte of encoder.encode(wire))controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoder.encode(wire));
    if(!open)controller.close();
  },cancel:onCancel,
}),{headers:{'content-type':'text/event-stream'}});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',minLength:1,maxLength:8000};
const schema=object({guide:object({script:text})});
const question='잠깐 이야기해도 괜찮아?';
const gateway=(fetchImpl,options={})=>new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic',
  model:'synthetic',protocol:'relationship_agent',streamJson:true,skipFinalExtras:true,timeoutMs:0,
  diagnosticLogger:null,fetchImpl,...options});
const generate=(model,{stage='guide_write',definition=schema,validate=value=>{validateSchema(value,definition);return value;},maxAttempts=3}={})=>
  model.operation({},operation=>model.agentComplete(stage,'원문을 보존하세요.',{source:'synthetic source'},definition,operation,validate,{maxAttempts}));

test('optional string inspection decodes split escapes, surrogate pairs and UTF-8 bytes with exact paths',async()=>{
  const value={guide:{script:'한글 😀 \n\t\b\f\r"\\/ A'},rows:['first',{text:'second'}]};
  const json=JSON.stringify(value).replace('😀','\\ud83d\\ude00').replace(' A',' \\u0041');
  const complete=[];
  const restored=await streamJsonResponse(response([...json],{bytes:true}),{validateString:(path,value,{complete:done})=>{
    if(done)complete.push([path,value]);
  }});
  assert.deepEqual(JSON.parse((await restored.json()).choices[0].message.content),value);
  assert.deepEqual(complete,[['output.guide.script',value.guide.script],['output.rows[0]','first'],['output.rows[1].text','second']]);
});

test('an unfinished repeated guide speech cancels each attempt without validating or returning partial output',{timeout:1000},async()=>{
  const requests=[],signals=[],logs=[];let cancelled=0,validations=0;
  const model=gateway(async(_url,options)=>{
    requests.push(JSON.parse(options.body));signals.push(options.signal);
    return response(['{"guide":{"script":"'+question+' '+question+' '],{open:true,onCancel:()=>cancelled++});
  },{retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  await assert.rejects(generate(model,{validate:()=>{validations++;}}),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_speech_repeat');
    assert.equal(error.modelAttempts,3);return true;
  });
  assert.equal(requests.length,3);assert.equal(cancelled,3);assert.equal(validations,0);
  assert.ok(signals.every(signal=>signal.aborted));
  assert.ok(requests.every(body=>body.response_format.type==='json_schema'));
  assert.ok(logs.filter(entry=>entry.event==='model_attempt').every(entry=>entry.reason==='agent_speech_repeat'));
  assert.equal(logs.some(entry=>entry.event==='model_operation_retry'),false);
  const feedback=JSON.parse(JSON.parse(requests[1].messages.at(-1).content).validation_feedback);
  assert.deepEqual(feedback.permission_questions,[question,question]);
  assert.equal(feedback.partial_output,true);assert.equal(feedback.max_permission_questions,1);
});

test('early repeat feedback repairs within the original attempt budget and still runs the original validator',async()=>{
  const requests=[],seen=[];let cancelled=0;
  const model=gateway(async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(requests.length===1)return response(['{"guide":{"script":"'+question+' '+question+' '],{open:true,onCancel:()=>cancelled++});
    if(requests.length===2){
      const input=JSON.parse(body.messages.at(-1).content);
      assert.equal(input.rejected_output,undefined);assert.deepEqual(input.data,{source:'synthetic source'});
      assert.match(body.messages[0].content,/최초의 허락 질문만 남기세요/u);
    }
    return response([JSON.stringify({guide:{script:requests.length===2?'unsupported':'trusted'}})]);
  });
  const result=await generate(model,{validate:value=>{
    validateSchema(value,schema);seen.push(value.guide.script);
    if(value.guide.script!=='trusted')throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic source failure'),{modelReason:'agent_evidence'});
    return value;
  }});
  assert.equal(result.guide.script,'trusted');assert.deepEqual(seen,['unsupported','trusted']);
  assert.equal(requests.length,3);assert.equal(cancelled,1);
});

test('a partial repeat never reuses an older complete rejected candidate as the current failed output',async()=>{
  let attempts=0;
  const model=gateway(async(_url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    if(++attempts===1)return response([JSON.stringify({guide:{script:'older rejected candidate'}})]);
    if(attempts===2){
      assert.equal(input.rejected_output.guide.script,'older rejected candidate');
      return response(['{"guide":{"script":"'+question+' '+question+' '],{open:true});
    }
    assert.equal(input.rejected_output,undefined);
    return response([JSON.stringify({guide:{script:'trusted'}})]);
  });
  const result=await generate(model,{validate:value=>{
    if(value.guide.script!=='trusted')throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic source failure'),{modelReason:'agent_evidence'});
    return value;
  }});
  assert.equal(result.guide.script,'trusted');assert.equal(attempts,3);
});

test('permission repeats split across JSON escapes and Unicode deltas stop before closing the value',{timeout:1000},async()=>{
  let cancelled=0;
  const encoded=JSON.stringify({guide:{script:question+' '+question+' '}}).replaceAll(' ','\\u0020').slice(0,-3);
  const model=gateway(async()=>response([...encoded],{open:true,bytes:true,onCancel:()=>cancelled++}));
  await assert.rejects(generate(model,{maxAttempts:1}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_speech_repeat'});
  assert.equal(cancelled,1);
});

test('a partial sentence is not classified until whitespace after punctuation, a newline, or string completion',async()=>{
  const script=question+' 지금 이야기해도 괜찮아?상담 이야기를 원할 때 해요.';
  const model=gateway(async()=>response(['{"guide":{"script":"'+question+' 지금 이야기해도 괜찮아?',
    '상담 이야기를 원할 때 해요."}}']));
  assert.equal((await generate(model)).guide.script,script);
});

test('valid permission plus open question and explicit deferral remains unchanged',async()=>{
  const script=question+' 어떤 이야기를 하고 싶어? 지금 대화가 부담되면 나중에 이야기해도 괜찮아.';
  const model=gateway(async()=>response([...JSON.stringify({guide:{script}})]));
  assert.equal((await generate(model)).guide.script,script);
});

test('closed strings still reject repeated permission questions without a trailing separator',async()=>{
  const model=gateway(async()=>response([JSON.stringify({guide:{script:question+' '+question}})]));
  await assert.rejects(generate(model,{maxAttempts:1}),{modelReason:'agent_speech_repeat'});
});

for(const stage of ['guide_review','speech_review','question_plan','guide_writeup','guide_refine','guide_repair'])
test('unrelated stage retains its existing validator: '+stage,async()=>{
  const value={guide:{script:question+' '+question}};
  const model=gateway(async()=>response([JSON.stringify(value)]));
  assert.deepEqual(await generate(model,{stage}),value);
});

test('drafts that do not yet validate speech preserve the existing later-repair path',async()=>{
  const value={guide:{script:question+' '+question}};
  const model=gateway(async()=>response([JSON.stringify(value)]),{skipFinalExtras:false});
  assert.deepEqual(await generate(model),value);
});

test('ordinary drafts stop twelve exact completed permission questions as a generation stall',{timeout:1000},async()=>{
  let cancelled=0;
  const model=gateway(async()=>response(['{"guide":{"script":"'+(question+' ').repeat(12)],
    {open:true,onCancel:()=>cancelled++}),{skipFinalExtras:false});
  await assert.rejects(generate(model,{maxAttempts:1}),error=>{
    assert.equal(error.modelReason,'agent_speech_repeat');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.stream_repetition_count,12);assert.equal(feedback.stream_repetition_threshold,12);
    assert.equal(feedback.max_permission_questions,1);assert.equal(feedback.partial_output,true);
    return true;
  });
  assert.equal(cancelled,1);
});

test('the draft stall threshold does not reject eleven copies or combine different permission sentences',async()=>{
  for(const script of [(question+' ').repeat(11),
    (question+' ').repeat(6)+('지금 이야기해도 괜찮을까? ').repeat(6)]){
    const model=gateway(async()=>response([JSON.stringify({guide:{script}})]),{skipFinalExtras:false});
    assert.equal((await generate(model)).guide.script,script);
  }
});

test('guide suffixes retain the guard but other fields and nested or ambiguous guide paths do not',async()=>{
  const value={guide:{script:question+' 어떤 이야기를 하고 싶어?',evidence:(question+' ').repeat(12)},
    review:{guide:{script:(question+' ').repeat(12)}},'guide.script':(question+' ').repeat(12)};
  const definition=object({guide:object({script:text,evidence:text}),review:object({guide:object({script:text})}),'guide.script':text});
  const model=gateway(async()=>response([JSON.stringify(value)]));
  assert.deepEqual(await generate(model,{stage:'guide_write_after_repair',definition}),value);
  const repeated=gateway(async()=>response([JSON.stringify({guide:{script:question+' '+question}})]));
  await assert.rejects(generate(repeated,{stage:'guide_write_after_repair',maxAttempts:1}),{modelReason:'agent_speech_repeat'});
});
