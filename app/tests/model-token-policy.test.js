import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { trainedContext } from '../src/model-context.js';

const field = (id, text, extra = {}) => ({ id, question: '전체 질문 '.repeat(30), status: 'answered', rawText: text, text, custom: '', ...extra });

test('trained input preserves all source components, people, goals, memory and candidates', () => {
  const text = '합성 원문 😀 '.repeat(700) + ' 마지막에 정정한 내용입니다.';
  const followUp = '이후에 확인한 합성 답변 '.repeat(100);
  const shared = field('shared', text, { custom: '별도 직접 입력 '.repeat(50),
    followUp: { question: '후속 질문', answer: { rawText: followUp, text: followUp, custom: '후속 직접 입력' } } });
  const context = {
    patient: { fields: { shared, ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['p'+i, field('p'+i, text+i)])) } },
    supporter: { fields: { shared: field('shared', '다른 사람의 같은 문항 ID'), unknown: field('unknown', text, { status: 'unknown' }),
      skipped: field('skipped', '제외할 미응답', { status: 'skipped' }) } },
    user_goal: { message: field('want', text), desired_outcomes: field('goal', followUp) },
    answered_count: 28,
    question_candidates: Array.from({ length: 12 }, (_, i) => ({ id: 'next'+i, question: '질문 전체 '.repeat(40), subject: 'patient' })),
  };
  const memory = { summary: text, facts: Array.from({ length: 8 }, (_, i) => ({ subject: 'patient', question_id: 'p'+i, quote: text, certainty: i ? 'reported' : 'unknown' })), unknowns: Array(6).fill(followUp) };
  const before = structuredClone({ context, memory });
  for (const final of [false, true]) {
    const input = trainedContext(context, memory, { final });
    assert.deepEqual(trainedContext(context, memory, { final, tighter: true }), input);
    assert.equal(input.partial, false);
    assert.equal(input.patient.length, 26);
    assert.equal(input.supporter.length, 2);
    assert.deepEqual(input.patient[0], ['shared', shared.question, 'answered', [text, shared.custom, followUp, '후속 직접 입력']]);
    assert.equal(input.supporter[0][3][0], '다른 사람의 같은 문항 ID');
    assert.equal(input.supporter[1][2], 'unknown');
    assert.equal(input.goal, text);
    assert.deepEqual(input.desired, [followUp]);
    assert.equal(input.memory.summary, text);
    assert.deepEqual(input.memory.unknowns, memory.unknowns);
    assert.deepEqual(input.memory.facts, memory.facts.map(fact => [fact.subject, fact.question_id, fact.quote, fact.certainty]));
    if (!final) assert.deepEqual(input.candidates, context.question_candidates.map(candidate => [candidate.id, candidate.question, candidate.subject, 'optional']));
  }
  assert.deepEqual({ context, memory }, before);
});

for (const agentFormat of ['json_schema', 'json_object', 'prompt']) {
  test(`${agentFormat} receives a complete response over the old character and token caps`, async () => {
    const text = '합성 응답 😀 '.repeat(8000) + '마지막 응답';
    const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
    const requests = [], logs = [];
    const gateway = new ModelGateway({ baseUrl: 'http://model.test/v1', apiKey: 'synthetic-key', protocol: 'relationship_agent', agentFormat,
      diagnosticLogger: entry => logs.push(entry), fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text }) } }],
          usage: { prompt_tokens: 9000, completion_tokens: 9000, total_tokens: 18000 } }));
      } });
    const output = await gateway.operation({}, operation => gateway.agentComplete('synthetic_stage', '합성 검증', { source: text }, schema, operation, value => {
      assert.deepEqual(Object.keys(value), ['text']);
      assert.equal(typeof value.text, 'string');
      return value;
    }));
    assert.equal(output.text, text);
    assert.equal(requests.length, 1);
    for (const key of ['max_tokens', 'max_completion_tokens', 'num_predict']) assert.equal(Object.hasOwn(requests[0], key), false);
    assert.equal(JSON.parse(requests[0].messages.at(-1).content).data.source, text);
    assert.equal(logs[0].usage.completion_tokens, 9000);
    assert.equal(JSON.stringify(logs).includes(text), false);
  });
}

const policyResponse = (overrides = {}) => new Response(JSON.stringify({ model:'synthetic-model', max_output_tokens:8192, max_context_tokens:69632, max_input_tokens:65536, ...overrides }));
const answerResponse = () => new Response(JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content:'{"okay":true}' } }] }));
const adaptiveGateway = fetchImpl => new ModelGateway({ baseUrl:'http://model.test/v1', apiKey:'synthetic-key', model:'synthetic-model', protocol:'relationship_agent', discoverTokenLimits:true, diagnosticLogger:null, fetchImpl });
const generate = gateway => gateway.operation({}, operation => gateway.agentComplete('synthetic', '합성 지침', { text:'전체 원문과 후속 정정' }, { type:'object' }, operation, value=>value));

test('web discovers server output capacity afresh instead of inheriting a small server default', async () => {
  const requests=[];let lookups=0;
  const gateway=adaptiveGateway(async (url, options) => {
    if (options.method==='GET') {
      assert.equal(url,'http://model.test/healthz');
      return policyResponse({max_output_tokens:++lookups===1?8192:6000});
    }
    requests.push(JSON.parse(options.body));return answerResponse();
  });
  assert.deepEqual(await generate(gateway),{okay:true});
  assert.deepEqual(await generate(gateway),{okay:true});
  assert.equal(lookups,2);
  assert.deepEqual(requests.map(body=>body.max_tokens),[8192,6000]);
});

test('a server context reservation rejection reduces output only and preserves the full request input', async () => {
  const requests=[];
  const gateway=adaptiveGateway(async (_url, options) => {
    if (options.method==='GET') return policyResponse();
    requests.push(JSON.parse(options.body));
    if(requests.length===1)return new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Prompt (65000) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated'}}),{status:400});
    return answerResponse();
  });
  assert.deepEqual(await generate(gateway),{okay:true});
  assert.equal(requests.length,2);
  assert.equal(requests[1].max_tokens,4632);
  assert.deepEqual({...requests[1],max_tokens:requests[0].max_tokens},requests[0]);
});

for(const message of [
  'Prompt (65537) exceeds the 65536-token input budget; no text was truncated',
  'Prompt (65537) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated',
  'Prompt (69632) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated',
  'Prompt (65000) plus max_tokens (4096) exceeds the 69632-token context budget; no text was truncated',
])test('server input rejection never discards sources: '+message,async()=>{
  let posts=0;
  const gateway=adaptiveGateway(async(_url,options)=>{
    if(options.method==='GET')return policyResponse();
    posts++;return new Response(JSON.stringify({error:{type:'invalid_request_error',message}}),{status:400});
  });
  await assert.rejects(generate(gateway),{code:'MODEL_CONTEXT_TOO_LONG'});
  assert.equal(posts,1);
});

test('servers without advertised capacity receive no web token override in every protocol', async () => {
  for(const protocol of ['relationship_agent','json_prompt','json_schema']) {
    const requests=[];
    const gateway=adaptiveGateway(async(_url,options)=>{
      if(options.method==='GET')return new Response('missing',{status:404});
      requests.push(JSON.parse(options.body));return answerResponse();
    });
    const output=await gateway.operation({},operation=>protocol==='json_prompt'
      ?gateway.completeTrained({},null,false,operation,value=>value)
      :protocol==='json_schema'?gateway.complete({},null,'합성 지침',operation,value=>value)
      :gateway.agentComplete('synthetic','합성 지침',{}, {type:'object'},operation,value=>value));
    assert.deepEqual(output,{okay:true});
    assert.equal(requests.length,1);
    assert.equal(Object.hasOwn(requests[0],'max_tokens'),false);
    assert.doesNotMatch(requests[0].messages[0].content,/\d+토큰/);
  }
});

test('failed capacity discovery does not silently use a custom server small default',async()=>{
  let posts=0;
  const gateway=adaptiveGateway(async(_url,options)=>{
    if(options.method==='GET')return new Response('private upstream error',{status:503});
    posts++;return answerResponse();
  });
  await assert.rejects(generate(gateway),{code:'MODEL_UNAVAILABLE',modelReason:'token_policy_unavailable'});
  assert.equal(posts,0);
});
