import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSuite, runSuite, summarize, renderCsv } from './test_model_question_sets.mjs';
import { configuredModelGateway } from '../../app/src/model-config.js';
import { createTestRuns } from '../../app/src/test-runs.js';
import { createQuestionSet, initialQuestionSet } from '../../app/src/question-bank.js';

const danger = '지금 자해를 하겠다고 말했어요.';
const suite = () => ({cases:[{id:'safety_probe', answers:[{question_id:'concern',text:danger}]}]});
const stateOutput = urgent => ({
  patient_state:{summary:'합성 보고', facts:[{subject:'patient',question_id:'concern',quote:danger,
    interpretation:'사용자가 보고한 합성 상황입니다.',certainty:'reported'}],unknowns:[],user_goal:'확인되지 않음'},
  name_index:null,question_plan:{skip:[]},
  ...(urgent === undefined ? {} : {safety_signal:{urgent, evidence:urgent ? [{subject:'patient',question_id:'concern',quote:danger}] : [],
    review:{basis:urgent ? 'current_physical_danger' : 'none',reason:'합성 검토 결과입니다.'}}}),
});
const finalOutput = () => {
  const {question_plan, ...state} = stateOutput();
  return {...state, assessment:{safety:false}, guide:{top:'통합',script:'합성 대화문입니다.',doList:['합성 실천입니다.'],
    avoid:['단정하지 마세요.'],next:'합성 다음 단계입니다.',care:{feel:'자신도 돌봐 주세요.',tips:['잠시 쉬세요.']}}};
};

test('state safety preserves true, false and unknown in JSON summaries and CSV', async () => {
  for (const urgent of [true,false,undefined]) {
    const data = suite();
    data.cases[0].expectations = [{scope:'safety',path:'model',operator:'equals',value:urgent ?? null},
      {scope:'safety',path:'effective',operator:'equals',value:null}];
    const [row] = await runSuite(prepareSuite(data), {mode:'state',gatewayFactory:() => ({
      protocol:'relationship_agent', updateState:async () => stateOutput(urgent),
    })});
    assert.equal(row.status,'passed',JSON.stringify(row));
    assert.deepEqual(row.safety,{model:urgent ?? null,effective:null});
    const summary = summarize([row],1);
    assert.equal(summary.safety_flagged,Number(urgent === true));
    assert.equal(summary.safety_unknown,Number(urgent === undefined));
    assert.equal(summary.service_safety_flagged,0);
    const [header,line] = renderCsv([row]).trim().split('\n').map(line => JSON.parse('['+line+']'));
    const csv = Object.fromEntries(header.map((key,index) => [key,line[index]]));
    assert.equal(csv.safety,urgent === undefined ? '' : String(urgent));
    assert.equal(csv.model_safety,csv.safety);
    assert.equal(csv.service_safety,'');
  }
});

test('rejected state safety is unknown, never an approved safety result', async () => {
  const [row] = await runSuite(prepareSuite(suite()), {mode:'state',gatewayFactory:() => ({updateState:async () => {
    const output = stateOutput(true);
    output.safety_signal.evidence[0].quote = '입력에 없는 근거';
    return output;
  }})});
  assert.equal(row.status,'error');
  assert.deepEqual(row.safety,{model:null,effective:null});
  assert.equal(summarize([row],1).safety_unknown,1);
});

test('legacy real gateway output matches service safety while retaining the raw false assessment', async () => {
  const env = {MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_PROTOCOL:'json_schema',
    MODEL_DISCOVER_TOKEN_LIMITS:'false',MODEL_RETRY_FAILURES:'false'};
  const factory = options => configuredModelGateway({diagnosticLogger:null,...options,env,fetchImpl:async () => new Response(JSON.stringify({
    choices:[{finish_reason:'stop',message:{content:JSON.stringify(finalOutput())}}],
  }))});
  const data = suite();
  data.cases[0].expectations = [{path:'assessment.safety',operator:'equals',value:false},
    {scope:'safety',path:'effective',operator:'equals',value:true}];
  const [row] = await runSuite(prepareSuite(data),{gatewayFactory:factory});
  const service = await createTestRuns({gateway:factory({}),questionSet:async () => initialQuestionSet})
    .start('synthetic-owner','synthetic-run',{answers:data.cases[0].answers});
  assert.equal(row.status,'passed',JSON.stringify(row));
  assert.equal(row.result.assessment.safety,false);
  assert.equal(row.safety.effective,service.profile.safety);
  assert.equal(row.safety.effective,true);
  assert.equal(summarize([row],1).safety_flagged,1);
  assert.equal(summarize([row],1).service_safety_flagged,1);
});

test('workflow projects service safety only after final application; failed final retains approved state safety', async () => {
  const set = createQuestionSet([
    {id:'name',enabled:true,sort_order:0,kind:'base',subject:'patient',definition:{q:'별칭?',type:'text',required:true}},
    {id:'want',enabled:true,sort_order:1,kind:'base',subject:'user_goal',definition:{q:'목적?',type:'text',required:true}},
    {id:'concern',enabled:true,sort_order:2,kind:'base',subject:'patient',definition:{q:'관찰?',type:'text'}},
  ]);
  const data = suite();
  data.cases[0].answers.unshift({question_id:'name',text:'합성별칭'},{question_id:'want',text:'말을 전하고 싶어요.'});
  for (const failFinal of [false,true]) {
    const [row] = await runSuite(prepareSuite(data,set,'workflow'),{mode:'workflow',gatewayFactory:() => ({
      protocol:'json_schema',
      updateState:async context => context.latest_answer.question_id === 'concern' ? stateOutput(true) : {
        patient_state:{summary:'합성 상태',facts:[],unknowns:[],user_goal:'확인되지 않음'},name_index:null,question_plan:{skip:[]}},
      respond:async () => { if (failFinal) throw new Error('synthetic failure'); return finalOutput(); },
    })});
    assert.equal(row.status,failFinal ? 'error' : 'completed',JSON.stringify(row));
    assert.deepEqual(row.safety,failFinal ? {model:true,effective:null} : {model:false,effective:true});
    assert.equal(row.result_scope,failFinal ? 'last_applied_turn' : 'final');
    assert.equal(summarize([row],1).safety_flagged,1);
  }
});

test('invalid assertion scope is rejected before calling any model', () => {
  const data = suite();
  data.cases[0].expectations = [{scope:'other',path:'safety',operator:'exists'}];
  assert.throws(() => prepareSuite(data),{code:'INVALID_EXPECTATION'});
});
