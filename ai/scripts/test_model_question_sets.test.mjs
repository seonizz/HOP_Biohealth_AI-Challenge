import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { prepareSuite, checkExpectations, runSuite, summarize, writeReports, main } from './test_model_question_sets.mjs';
import { configuredModelGateway } from '../../app/src/model-config.js';
import { createQuestionSet, initialQuestionRows } from '../../app/src/question-bank.js';

const input = () => ({cases:[{id:'synthetic', answers:[{question_id:'concern', text:'합성 관찰 내용입니다.'}]}]});
const answer = () => ({guide:{top:'통합', script:'이야기를 듣고 싶어요.', doList:['시간을 물어보세요.'],
  avoid:['단정하지 마세요.'], next:'대화를 제안해 보세요.', care:{feel:'마음도 돌봐 주세요.', tips:['잠시 쉬어 보세요.']}},
  patient_state:{summary:'확인된 내용이 제한적입니다.', facts:[{subject:'patient', question_id:'concern',
    quote:'합성 관찰 내용입니다.', interpretation:'사용자가 제공한 합성 관찰입니다.', certainty:'reported'}], unknowns:['추가 상황'], user_goal:'확인되지 않음'},
  assessment:{safety:false}, name_index:null});
const trace = (usage = {prompt_tokens:12, completion_tokens:7}) => ({event:'model_attempt', generation_id:'g',
  generation:'final', attempt:1, request_id:null, duration_ms:2, reason:'success', status:200,
  finish_reason:'stop', usage, attempt_id:'a'});

test('whole-batch validation preserves omitted answers and rejects bad cases before execution', () => {
  const original = input(), cases = prepareSuite(original);
  assert.equal(cases[0].context.patient.fields.concern.rawText, '합성 관찰 내용입니다.');
  assert.equal(cases[0].context.patient.fields.rel.status, 'not_asked');
  assert.equal(cases[0].context.answered_count, 1);
  assert.deepEqual(original, input());
  for (const value of [{cases:[]}, {cases:[original.cases[0], original.cases[0]]},
    {cases:[{...original.cases[0], id:123}]}, {cases:[{...original.cases[0], expectations:null}]},
    {cases:[{...original.cases[0], id:'=FORMULA'}]},
    {cases:[original.cases[0], {id:'invalid', answers:[{question_id:'missing',text:'x'}]}]},
    {cases:[{...original.cases[0], expectations:[{path:'constructor.name', operator:'exists'}]}]},
    {cases:[{...original.cases[0], expectations:[{path:'guide.script', operator:'contains', value:''}]}]},
    {cases:[{...original.cases[0], expectations:[{path:'guide', operator:'equals'}]}]},
    {cases:[{...original.cases[0], ignored:true}]}]) assert.throws(() => prepareSuite(value));
});

test('custom question definitions feed the same app context', () => {
  const rows = structuredClone(initialQuestionRows);
  rows.find(row => row.id === 'concern').definition.q = '합성 질문 변경';
  const [item] = prepareSuite(input(), createQuestionSet(rows));
  assert.equal(item.context.patient.fields.concern.question, '합성 질문 변경');
});

test('assertions distinguish missing, false, wrong type and matching values', () => {
  const checks = checkExpectations({assessment:{safety:false}, guide:{script:'합성 문장'}, list:['a']}, [
    {path:'assessment.safety', operator:'equals', value:false},
    {path:'guide.script', operator:'contains', value:'합성'},
    {path:'guide.script', operator:'not_contains', value:'진단'},
    {path:'missing', operator:'not_contains', value:'진단'},
    {path:'assessment.safety', operator:'contains', value:'false'},
    {path:'list.0', operator:'equals', value:'a'},
    {path:'assessment.safety', operator:'exists'},
  ]);
  assert.deepEqual(checks.map(row => row.passed), [true,true,true,false,false,true,true]);
});

test('repetitions isolate gateways/context, retain diagnostics and distinguish no assertions', async () => {
  let created = 0, saved = 0;
  const cases = prepareSuite(input());
  const results = await runSuite(cases, {repeat:2, gatewayFactory:({diagnosticLogger, retryFailures}) => {
    created++; assert.equal(retryFailures, undefined); // The app owns retry policy.
    return {model:'synthetic', protocol:'relationship_agent', async respond(context, memory) {
      assert.equal(memory, null); assert.equal(context.answered_count, 1); context.answered_count = 99;
      diagnosticLogger(trace()); diagnosticLogger({event:'model_operation_retry'});
      return answer();
    }};
  }, onResult:(_row, rows) => { saved++; assert.equal(rows.length, saved); }});
  assert.equal(created, 2); assert.equal(saved, 2);
  assert.equal(cases[0].context.answered_count, 1);
  assert.ok(results.every(row => row.status === 'completed' && row.metrics.attempts === 1));
  assert.equal(results[0].metrics.excluded_diagnostic_events, 1);
  assert.equal(results[0].trace.length, 2);
  assert.equal(summarize(results, 2).expectation_pass_rate, null);
  assert.equal(summarize(results, 2).prompt_tokens, 24);
});

test('errors and failed checks do not stop later cases; missing token usage remains unknown', async () => {
  const suite = input(); suite.cases[0].expectations = [{path:'assessment.safety', operator:'equals', value:true}];
  let calls = 0;
  const rows = await runSuite(prepareSuite(suite), {repeat:3, gatewayFactory:({diagnosticLogger}) => ({
    async respond() {
      if (++calls === 1) throw new Error('private URL or credential must not enter report');
      diagnosticLogger(trace(null)); return answer();
    },
  })});
  assert.deepEqual(rows.map(row => row.status), ['error','failed','failed']);
  assert.equal(rows[0].error_code, 'MODEL_TEST_ERROR');
  assert.equal(JSON.stringify(rows).includes('credential'), false);
  assert.equal(summarize(rows, 3).prompt_tokens, null);
  assert.equal(summarize(rows, 3).expectation_pass_rate_denominator, 2);
});

test('new diagnostic events and longer retry sequences cannot break dynamic HTTP counts or output checks', async () => {
  const suite=input(); suite.cases[0].expectations=[{path:'assessment.safety',operator:'equals',value:false}];
  const [row]=await runSuite(prepareSuite(suite),{gatewayFactory:({diagnosticLogger})=>({
    fetchImpl:async()=>new Response('{}'),
    async respond() {
      for(let attempt=1;attempt<=5;attempt++) {
        await this.fetchImpl('http://synthetic.invalid/v1/chat/completions',{method:'POST'});
        diagnosticLogger({...trace(),attempt,attempt_id:'a'+attempt,reason:attempt===5?'success':'future_repair_reason'});
      }
      diagnosticLogger({event:'future_scheduler_event'});
      return answer();
    },
  })});
  assert.equal(row.status,'passed'); assert.equal(row.http.summary.total,5);
  assert.equal(row.metrics.attempt_count_verified,false); assert.equal(row.metrics.attempts,null);
  assert.equal(row.trace.length,6);
});

test('deadline aborts a case and state mode uses updateState', async () => {
  const rows = await runSuite(prepareSuite(input()), {mode:'state', timeoutMs:10, gatewayFactory:() => ({
    updateState:(_context, _memory, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    }),
    respond:() => assert.fail('wrong mode'),
  })});
  assert.equal(rows[0].error_code, 'CASE_TIMEOUT');
});

test('cancellation saves the current case and never starts remaining repetitions', async () => {
  const controller = new AbortController(); let calls = 0;
  const rows = await runSuite(prepareSuite(input()), {repeat:3, signal:controller.signal, gatewayFactory:() => ({
    async respond() { calls++; controller.abort(); return answer(); },
  })});
  assert.equal(calls, 1); assert.equal(rows[0].error_code, 'CANCELLED');
  assert.notEqual(rows[0].app_state_applied,true);
});

test('real app gateway serializes input and validates response with a fake HTTP transport', async () => {
  const env = {MODEL_BASE_URL:'http://127.0.0.1:11434/v1', MODEL_PROTOCOL:'json_schema',
    MODEL_DISCOVER_TOKEN_LIMITS:'false', MODEL_API_KEY:'synthetic-test-only'};
  let calls = 0;
  const rows = await runSuite(prepareSuite(input()), {env, gatewayFactory:options => configuredModelGateway({...options,
    fetchImpl:async (url, request) => {
      calls++; assert.match(url, /\/v1\/chat\/completions$/);
      const body = JSON.parse(request.body);
      assert.equal(body.messages.some(message => message.content.includes('합성 관찰 내용입니다.')), true);
      assert.equal(body.response_format.type, 'json_schema');
      return new Response(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify(answer())}}],
        usage:{prompt_tokens:12, completion_tokens:7}}), {status:200});
    },
  })});
  assert.equal(rows[0].status, 'completed', JSON.stringify(rows[0]));
  assert.equal(calls, 1);
  assert.equal(rows[0].result.assessment.safety, false);
  assert.equal(rows[0].metrics.prompt_tokens, 12);
  assert.equal(JSON.stringify(rows).includes('synthetic-test-only'), false);
});

test('JSON, CSV and Markdown reports preserve error and pass counts with private permissions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hop-model-tests-'));
  try {
    const suite = input(); suite.cases[0].expectations = [{path:'assessment.safety', operator:'equals', value:false}];
    const rows = await runSuite(prepareSuite(suite), {gatewayFactory:() => ({respond:async () => answer()})});
    const report = writeReports(directory, {test:true}, rows, 1, 'finished');
    assert.equal(report.summary.passed, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, 'report.json'))).results[0].result.guide.script, answer().guide.script);
    assert.match(readFileSync(join(directory, 'results.csv'), 'utf8'), /"synthetic","1","passed"/);
    assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /기대값 통과: 1/);
    assert.equal(statSync(join(directory, 'report.json')).mode & 0o777, 0o600);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});

test('a failed report refresh preserves the last valid canonical JSON and removes temporary files', () => {
  const directory=mkdtempSync(join(tmpdir(),'hop-report-atomic-'));
  try {
    writeReports(directory,{test:true},[],1,'running');
    const original=readFileSync(join(directory,'report.json'),'utf8');
    rmSync(join(directory,'results.csv'));mkdirSync(join(directory,'results.csv'));
    assert.throws(()=>writeReports(directory,{test:true},[],1,'finished'));
    assert.equal(readFileSync(join(directory,'report.json'),'utf8'),original);
    assert.equal(JSON.parse(original).status,'running');
    assert.ok(readdirSync(directory).every(name=>!name.endsWith('.tmp')));
    rmSync(join(directory,'results.csv'),{recursive:true});
    writeReports(directory,{test:true},[],1,'finished');
    assert.equal(JSON.parse(readFileSync(join(directory,'report.json'))).status,'finished');
    assert.equal(statSync(join(directory,'report.json')).mode&0o777,0o600);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('CLI rejects ambiguous commands and invalid numeric options', async () => {
  await assert.rejects(main(['--input','unused','--init']), {code:'CHOOSE_INPUT_INIT_OR_LIST_QUESTIONS'});
  for (const args of [['--repeat','0'], ['--repeat','1.5'], ['--timeout-ms','NaN'], ['--mode','other']]) {
    await assert.rejects(main(['--input','unused', ...args]), {code:'INVALID_RUN_OPTIONS'});
  }
});

test('CLI rejects FIFOs in both input paths and oversized regular files before any model work', () => {
  const directory=mkdtempSync(join(tmpdir(),'hop-cli-input-bound-'));
  const script=fileURLToPath(new URL('./test_model_question_sets.mjs',import.meta.url));
  try {
    const fifo=join(directory,'input.fifo'), oversized=join(directory,'oversized.json');
    execFileSync('mkfifo',[fifo]);
    writeFileSync(oversized,' '.repeat(5242881));
    for (const [args,code] of [
      [['--input',fifo,'--dry-run','--timeout-ms','1'],'INPUT_NOT_REGULAR_FILE'],
      [['--questions',fifo,'--list-questions'],'INPUT_NOT_REGULAR_FILE'],
      [['--input',oversized,'--dry-run'],'INPUT_TOO_LARGE'],
    ]) {
      assert.throws(()=>execFileSync(process.execPath,[script,...args],{encoding:'utf8',timeout:3000,stdio:'pipe'}),error=>{
        assert.equal(error.status,2);assert.equal(error.stdout,'');
        assert.equal(JSON.parse(error.stderr).code,code);return true;
      });
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('agent CLI describes its schema, validates offline and emits parseable JSONL and exit codes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hop-model-cli-'));
  const script = fileURLToPath(new URL('./test_model_question_sets.mjs', import.meta.url));
  let workflowTransport=false;
  const received=[];
  const server = createServer(async (request, response) => {
    let body='';for await(const chunk of request) body+=chunk;
    let generated=answer();
    if(workflowTransport) {
      const payload=JSON.parse(body), wire=JSON.parse(payload.messages.at(-1).content), context=wire.current_context;
      const final=payload.response_format.json_schema.name==='malssi_guide';
      received.push({final,context,prior_memory:wire.prior_memory});
      const name=context.patient.fields.name;
      const state={patient_state:{summary:'사용자가 제공한 합성 별칭과 목적입니다.',
        facts:[{subject:'patient',question_id:'name',quote:name.rawText,interpretation:'사용자가 입력한 별칭입니다.',certainty:'reported'}],
        unknowns:[],user_goal:context.user_goal.message?.status==='answered'?context.user_goal.message.text:'확인되지 않음'},
        name_index:{alias:name.rawText,source_question_id:'name',quote:name.rawText}};
      generated=final?{...answer(),...state}:{...state,question_plan:{skip:[]}};
    }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify(generated)}}],
      usage:{prompt_tokens:12, completion_tokens:7}}));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const run = (args, settings = {}) => new Promise(resolve => execFile(process.execPath, [script, ...args], {
    encoding:'utf8', timeout:10000,
    env:{PATH:process.env.PATH, MODEL_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`, MODEL_PROTOCOL:'json_schema',
      MODEL_DISCOVER_TOKEN_LIMITS:'false', MODEL_API_KEY:'synthetic-cli-only', ...settings},
  }, (error, stdout, stderr) => resolve({status:error?.code ?? 0, stdout, stderr})));
  const outputs = [];
  try {
    const description = await run(['--describe']);
    assert.equal(description.status, 0, description.stderr);
    assert.equal(JSON.parse(description.stdout).input_schema.required[0], 'cases');
    assert.ok(JSON.parse(description.stdout).commands.validate.includes('workflow'));
    const questions = JSON.parse((await run(['--list-questions'])).stdout);
    assert.ok(questions.questions.some(q => q.id === 'concern'));
    const template = await run(['--init']);
    assert.equal(template.status, 0);
    const templatePath = JSON.parse(template.stdout).input; outputs.push(templatePath);
    assert.equal((await run(['--input', templatePath, '--dry-run'])).status, 0);
    const inputPath = join(directory, 'input.json');
    writeFileSync(inputPath, JSON.stringify(input()));
    const dry = await run(['--input', inputPath, '--dry-run']);
    assert.equal(dry.status, 0); assert.equal(JSON.parse(dry.stdout).model_called, false);
    const pending = await run(['--input', inputPath, '--mode', 'workflow']);
    const pendingFinal = JSON.parse(pending.stdout.trim().split('\n').at(-1)); outputs.push(pendingFinal.output);
    assert.equal(pending.status,3,pending.stderr);
    assert.equal(pendingFinal.summary.awaiting_input,1);
    const pendingReport = JSON.parse(readFileSync(pendingFinal.artifacts.report));
    assert.equal(pendingReport.results[0].workflow.next_question.id,'name');
    assert.equal(pendingReport.results[0].http.summary.total,0);
    const changed = await run(['--input',inputPath,'--mode','workflow'],{MODEL_SKIP_FINAL_EXTRAS:'true',MODEL_TIMEOUT_MS:'10000'});
    assert.equal(changed.status,3,changed.stderr);
    const changedFinal=JSON.parse(changed.stdout.trim().split('\n').at(-1));outputs.push(changedFinal.output);
    const changedReport=JSON.parse(readFileSync(changedFinal.artifacts.report));
    assert.equal(changedReport.identity.writer.skip_final_extras,true);
    assert.equal(changedReport.identity.writer.timeout_ms,10000);
    assert.notEqual(changedReport.identity.writer.effective_config_sha256,pendingReport.identity.writer.effective_config_sha256);
    assert.ok(changedReport.identity.runner_modules['model_test_io.mjs']);
    assert.ok(changedReport.identity.runner_modules['model_test_identity.mjs']);
    assert.equal(JSON.stringify(changedReport).includes('synthetic-cli-only'),false);
    for (const safety of [false, true]) {
      const suite = input(); suite.cases[0].expectations = [{path:'assessment.safety',operator:'equals',value:safety}];
      writeFileSync(inputPath, JSON.stringify(suite));
      const result = await run(['--input', inputPath]);
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const final = events.at(-1); outputs.push(final.output);
      assert.equal(result.status, safety ? 1 : 0, result.stderr || result.stdout);
      assert.equal(final.status, 'finished');
      assert.equal(final.summary.failed, safety ? 1 : 0);
      assert.equal(JSON.parse(readFileSync(final.artifacts.report)).results[0].result.assessment.safety, false);
      assert.equal(statSync(final.output).mode & 0o777, 0o700);
    }
    const bankPath=join(directory,'questions.json');
    writeFileSync(bankPath,JSON.stringify([
      {id:'name',enabled:true,sort_order:0,kind:'base',subject:'patient',definition:{q:'이름?',type:'text',required:true}},
      {id:'want',enabled:true,sort_order:1,kind:'base',subject:'user_goal',definition:{q:'목적?',type:'text',required:true}},
    ]));
    writeFileSync(inputPath,JSON.stringify({cases:[{id:'full_workflow',answers:[
      {question_id:'name',text:'합성별칭'},{question_id:'want',text:'이야기를 듣고 싶어요.'}],
      expectations:[{path:'guide.script',operator:'exists'}]}]}));
    workflowTransport=true;
    const workflowResult=await run(['--input',inputPath,'--questions',bankPath,'--mode','workflow']);
    const workflowFinal=JSON.parse(workflowResult.stdout.trim().split('\n').at(-1));outputs.push(workflowFinal.output);
    assert.equal(workflowResult.status,0,workflowResult.stderr||workflowResult.stdout);
    const workflowRow=JSON.parse(readFileSync(workflowFinal.artifacts.report)).results[0];
    assert.equal(workflowRow.status,'passed');assert.equal(workflowRow.workflow.completed,true);
    assert.equal(workflowRow.answered_count,2);assert.equal(workflowRow.result_scope,'final');
    assert.deepEqual(received.map(call=>call.final),[false,false,true]);
    assert.equal(received[0].prior_memory,null);
    assert.ok(received[1].prior_memory.facts.some(fact=>fact.question_id==='name'));
    assert.equal(received[2].prior_memory.user_goal,'이야기를 듣고 싶어요.');
    assert.equal(workflowRow.http.summary.total,received.length);
    assert.equal(workflowRow.workflow.final_state_applied,true);
    writeFileSync(inputPath, '{');
    const invalid = await run(['--input', inputPath, '--dry-run']);
    assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_JSON');
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const output of outputs) rmSync(output, {recursive:true, force:true});
    rmSync(directory, {recursive:true, force:true});
  }
});
