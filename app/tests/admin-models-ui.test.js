import test from 'node:test';
import assert from 'node:assert/strict';
import {mountModelAdmin} from '../public/js/admin-models.js';

const settings=(selected='local12b',gpuAvailable=true,result=null)=>({profiles:[
  {id:'local12b',label:'12B',available:true},{id:'gpu31b',label:'31B',available:gpuAvailable},
],selected_model_profile:selected,result_model_profile:result});
function harness(handler,{executions=executionSettings(),executionHandler}={}){
  const element=()=>({value:'',children:[],disabled:false,appendChild(child){this.children.push(child);},
    set textContent(value){this.text=value;this.children=[];},get textContent(){return this.text||'';}});
  const nodes=Object.fromEntries(['modelForm','modelProfile','resultModelProfile','saveModel','currentModel','modelStatus','apiForm','apiStatus','saveApi','connectionProfile','connectionState','apiBaseUrl','apiModel','apiKey','executionForm','executionProfile','saveExecution','executionStatus','executionState',
    'questionMode','questionScheduling','questionSource','reviewSource','questionConnectionFields','questionKeyState','questionBaseUrl','questionModel','questionKey',
    'reviewConnectionFields','reviewKeyState','reviewBaseUrl','reviewModel','reviewKey'].map(id=>[id,element()]));
  const document={getElementById:id=>nodes[id],createElement:element};const calls=[];
  const fetchImpl=async(path,options)=>{
    calls.push({path,...options});const result=path.startsWith('/api/admin/model-execution')&&executionHandler?await executionHandler(path,options):
      path==='/api/admin/model-execution'?executions:path==='/api/admin/model-connections'?connectionSettings():await handler(path,options);
    return {ok:result.status===undefined||(result.status>=200&&result.status<300),json:async()=>result.data??result};
  };
  return {nodes,calls,mount:()=>mountModelAdmin({document,fetchImpl}),submit:()=>nodes.modelForm.onsubmit({preventDefault(){}}),submitApi:()=>nodes.apiForm.onsubmit({preventDefault(){}}),submitExecution:()=>nodes.executionForm.onsubmit({preventDefault(){}})};
}

test('admin model settings load, save with CSRF and display the persisted selection',async()=>{
  const page=harness((path,options)=>path==='/api/bootstrap'?{csrf_token:'synthetic-csrf'}:
    options.method==='PUT'?settings(JSON.parse(options.body).model_profile_id):settings());
  await page.mount();
  assert.deepEqual(page.calls.map(call=>call.path),['/api/bootstrap','/api/admin/models','/api/admin/model-connections','/api/admin/model-execution']);
  assert.equal(page.nodes.modelProfile.value,'local12b');
  page.nodes.modelProfile.value='gpu31b';page.nodes.modelProfile.onchange();await page.submit();
  const write=page.calls.at(-1);assert.equal(write.method,'PUT');
  assert.equal(write.headers['X-CSRF-Token'],'synthetic-csrf');
  assert.deepEqual(JSON.parse(write.body),{model_profile_id:'gpu31b',result_model_profile_id:null});
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 31B');
  assert.match(page.nodes.modelStatus.textContent,/저장했어요/);
});

test('admin saves and restores distinct conversation and result profiles, then can switch back to a shared profile',async()=>{
  let stored=settings();
  const page=harness((path,options)=>{
    if(path==='/api/bootstrap')return {csrf_token:'synthetic-csrf'};
    if(options.method==='PUT'){
      const input=JSON.parse(options.body);
      stored=settings(input.model_profile_id,true,input.result_model_profile_id);
    }
    return stored;
  });
  await page.mount();
  assert.equal(page.nodes.resultModelProfile.children[1].disabled,true);
  page.nodes.resultModelProfile.value='gpu31b';page.nodes.resultModelProfile.onchange();
  await page.submit();
  assert.deepEqual(JSON.parse(page.calls.at(-1).body),{model_profile_id:'local12b',result_model_profile_id:'gpu31b'});
  await page.mount();
  assert.equal(page.nodes.resultModelProfile.value,'gpu31b');
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 대화 12B · 분석·카드 31B');
  const before=page.calls.length;
  page.nodes.modelProfile.value='gpu31b';page.nodes.modelProfile.onchange();
  assert.equal(page.nodes.saveModel.disabled,true);await page.submit();
  assert.equal(page.calls.length,before);
  page.nodes.resultModelProfile.value='';page.nodes.resultModelProfile.onchange();
  assert.equal(page.nodes.saveModel.disabled,false);await page.submit();
  assert.deepEqual(JSON.parse(page.calls.at(-1).body),{model_profile_id:'gpu31b',result_model_profile_id:null});
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 31B');
});

test('an unavailable model cannot be saved even by a synthetic select change',async()=>{
  const page=harness(path=>path==='/api/bootstrap'?{csrf_token:'csrf'}:settings('local12b',false));
  await page.mount();assert.equal(page.nodes.modelProfile.children[1].disabled,true);
  assert.equal(page.nodes.resultModelProfile.children[2].disabled,true);
  page.nodes.resultModelProfile.value='gpu31b';page.nodes.resultModelProfile.onchange();
  assert.equal(page.nodes.saveModel.disabled,true);await page.submit();
  page.nodes.resultModelProfile.value='';
  page.nodes.modelProfile.value='gpu31b';page.nodes.modelProfile.onchange();
  assert.equal(page.nodes.saveModel.disabled,true);await page.submit();
  assert.equal(page.calls.length,4);
});

test('admin access failure leaves controls disabled and preserves the server explanation',async()=>{
  const page=harness(path=>path==='/api/bootstrap'?{csrf_token:'csrf'}:{status:403,data:{error:{message:'로컬 관리자만 접근할 수 있어요.'}}});
  await page.mount();assert.equal(page.nodes.saveModel.disabled,true);assert.equal(page.nodes.modelProfile.disabled,true);
  assert.equal(page.nodes.modelStatus.textContent,'로컬 관리자만 접근할 수 있어요.');await page.submit();assert.equal(page.calls.length,2);
});

test('duplicate saves are suppressed and a failed save does not claim a persisted change',async()=>{
  let rejectWrite;const blocked=new Promise((_,reject)=>{rejectWrite=reject;});
  const page=harness((path,options)=>path==='/api/bootstrap'?{csrf_token:'csrf'}:options.method==='PUT'?blocked:settings());
  await page.mount();page.nodes.modelProfile.value='gpu31b';
  const first=page.submit();await page.submit();assert.equal(page.calls.length,5);assert.equal(page.nodes.saveModel.disabled,true);
  rejectWrite(new Error('연결 오류'));await first;
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.match(page.nodes.modelStatus.textContent,/연결을 확인/);
  assert.equal(page.nodes.saveModel.disabled,false);
});


function connectionSettings(gpuSingle=true){return {connections:[
  {id:'local12b',base_url:'http://127.0.0.1:11434/v1',model:'gemma4:12b',api_key_configured:true,single_call_turns:false},
  {id:'gpu31b',base_url:'http://127.0.0.1:18731/v1',model:'verified-31b',api_key_configured:true,single_call_turns:gpuSingle},
]};}
const fillConnection=page=>{page.nodes.connectionProfile.value='gpu31b';page.nodes.connectionProfile.onchange();page.nodes.apiBaseUrl.value='https://example.test/v1';page.nodes.apiModel.value='updated-31b';page.nodes.apiKey.value='synthetic-private-key';};

test('connection editor loads only 12B and 31B metadata without exposing the stored key',async()=>{
  const page=harness(path=>path==='/api/bootstrap'?{csrf_token:'csrf'}:settings());
  await page.mount();assert.equal(page.nodes.connectionProfile.value,'local12b');
  assert.equal(page.nodes.apiBaseUrl.value,'http://127.0.0.1:11434/v1');assert.equal(page.nodes.apiKey.value,'');
  page.nodes.connectionProfile.value='gpu31b';page.nodes.connectionProfile.onchange();
  assert.equal(page.nodes.apiModel.value,'verified-31b');assert.match(page.nodes.connectionState.textContent,/고정됨/);
});

test('connection save uses CSRF, refreshes metadata, clears the key and preserves the default model',async()=>{
  const updated=connectionSettings(false);updated.connections[1].base_url='https://example.test/v1';updated.connections[1].model='updated-31b';
  const page=harness((path,options)=>path==='/api/bootstrap'?{csrf_token:'csrf'}:options.method==='PUT'?updated:settings());
  await page.mount();fillConnection(page);await page.submitApi();
  const call=page.calls.find(item=>item.path.endsWith('/model-connections/gpu31b'));assert.equal(call.method,'PUT');
  assert.equal(call.credentials,'same-origin');assert.equal(call.headers['X-CSRF-Token'],'csrf');
  assert.deepEqual(JSON.parse(call.body),{base_url:'https://example.test/v1',model:'updated-31b',api_key:'synthetic-private-key'});
  assert.equal(page.nodes.apiKey.value,'');assert.equal(page.nodes.modelProfile.value,'local12b');
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.match(page.nodes.connectionState.textContent,/고정되지 않음/);
  assert.deepEqual(page.calls.at(-1).path,'/api/admin/model-execution');assert.equal(page.calls.filter(item=>item.method==='PUT').length,1);
  assert.doesNotMatch(Object.values(page.nodes).map(node=>node.textContent).join(' '),/synthetic-private-key/);
  assert.match(page.nodes.apiStatus.textContent,/연결을 저장했어요/);
});

test('connection save failure preserves the current model and displays only safe server or generic errors',async()=>{
  let networkFailure=false;
  const page=harness((path,options)=>{
    if(path==='/api/bootstrap')return {csrf_token:'csrf'};
    if(options.method!=='PUT')return settings();
    if(networkFailure)throw new Error('synthetic-private-key from transport');
    return {status:422,data:{error:{message:'API 주소를 확인해 주세요.'}}};
  });
  await page.mount();fillConnection(page);await page.submitApi();
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.equal(page.nodes.modelProfile.value,'local12b');
  assert.equal(page.nodes.apiStatus.textContent,'API 주소를 확인해 주세요.');
  networkFailure=true;await page.submitApi();
  assert.match(page.nodes.apiStatus.textContent,/연결을 확인/);assert.doesNotMatch(page.nodes.apiStatus.textContent,/synthetic-private-key/);
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.equal(page.nodes.saveApi.disabled,false);
});

test('blank key preserves the server value and connection save blocks duplicate or model-selection writes',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const page=harness((path,options)=>path==='/api/bootstrap'?{csrf_token:'csrf'}:options.method==='PUT'?pending:settings());
  await page.mount();fillConnection(page);page.nodes.apiKey.value='';const saving=page.submitApi();
  assert.equal(Object.hasOwn(JSON.parse(page.calls.at(-1).body),'api_key'),false);
  await page.submitApi();await page.submit();assert.equal(page.calls.length,5);
  assert.equal(page.nodes.saveModel.disabled,true);assert.equal(page.nodes.saveApi.disabled,true);
  finish(connectionSettings(false));await saving;
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.equal(page.nodes.apiKey.value,'');
});

test('unknown connection IDs cannot dispatch a write and third profiles are rejected',async()=>{
  const page=harness(path=>path==='/api/bootstrap'?{csrf_token:'csrf'}:settings());
  await page.mount();fillConnection(page);page.nodes.connectionProfile.value='api_'+'a'.repeat(32);
  await page.submitApi();assert.equal(page.calls.length,4);
  const third=harness(path=>path==='/api/bootstrap'?{csrf_token:'csrf'}:{profiles:[{id:'api_'+'a'.repeat(32),label:'extra',available:true}],selected_model_profile:'api_'+'a'.repeat(32)});
  await third.mount();assert.equal(third.nodes.saveModel.disabled,true);assert.equal(third.nodes.saveApi.disabled,true);
});


function executionSettings(){return {executions:['local12b','gpu31b'].map(id=>({id,question_mode:'single',scheduling:'individual',
  question_source:'general',review_source:'general',question_connection:null,review_connection:null,configured:true}))};}
const basicHandler=path=>path==='/api/bootstrap'?{csrf_token:'synthetic-csrf'}:settings();
const setRole=(page,role,{base_url='https://same.example/v1',model='same-general-model',api_key=''}={})=>{
  page.nodes[role+'Source'].value='custom';page.nodes[role+'Source'].onchange();
  page.nodes[role+'BaseUrl'].value=base_url;page.nodes[role+'Model'].value=model;page.nodes[role+'Key'].value=api_key;
};

test('execution defaults use one call and individual scheduling with the same general model in both roles',async()=>{
  const page=harness(basicHandler);await page.mount();
  assert.equal(page.nodes.executionProfile.value,'local12b');assert.equal(page.nodes.questionMode.value,'single');
  assert.equal(page.nodes.questionScheduling.value,'individual');
  assert.equal(page.nodes.questionSource.value,'general');assert.equal(page.nodes.reviewSource.value,'general');
  for(const role of ['question','review']){
    assert.equal(page.nodes[role+'ConnectionFields'].hidden,true);assert.equal(page.nodes[role+'Key'].value,'');
    assert.equal(page.nodes[role+'BaseUrl'].disabled,true);
  }
  assert.equal(page.nodes.saveExecution.disabled,false);
});

test('execution save preserves model selection and allows identical custom models for question and review roles',async()=>{
  const stored=executionSettings();let saved;
  const page=harness(basicHandler,{executionHandler:(path,options)=>{
    if(options.method==='PUT'){
      saved=JSON.parse(options.body);
      Object.assign(stored.executions[1],saved,{question_connection:{...saved.question_connection,api_key_configured:true},
        review_connection:{...saved.review_connection,api_key_configured:true}});
    }
    return stored;
  }});
  await page.mount();page.nodes.executionProfile.value='gpu31b';page.nodes.executionProfile.onchange();
  page.nodes.questionMode.value='two';page.nodes.questionScheduling.value='parallel';
  setRole(page,'question',{api_key:'question-private-key'});setRole(page,'review',{api_key:'review-private-key'});
  await page.submitExecution();
  const write=page.calls.find(call=>call.method==='PUT');
  assert.equal(write.path,'/api/admin/model-execution/gpu31b');assert.equal(write.headers['X-CSRF-Token'],'synthetic-csrf');
  assert.equal(write.credentials,'same-origin');
  assert.deepEqual(saved,{question_mode:'two',scheduling:'parallel',question_source:'custom',review_source:'custom',
    question_connection:{base_url:'https://same.example/v1',model:'same-general-model',api_key:'question-private-key'},
    review_connection:{base_url:'https://same.example/v1',model:'same-general-model',api_key:'review-private-key'}});
  assert.equal(page.nodes.modelProfile.value,'local12b');assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');
  assert.equal(page.nodes.questionKey.value,'');assert.equal(page.nodes.reviewKey.value,'');
  assert.doesNotMatch(Object.values(page.nodes).map(node=>node.textContent).join(' '),/question-private-key|review-private-key/);
  assert.equal(page.calls.filter(call=>call.method==='PUT').length,1);
  assert.match(page.nodes.executionStatus.textContent,/최종 카드 흐름과 기본 모델 선택은 유지/);
});

test('changing the execution profile restores each saved role and clears unsaved API keys',async()=>{
  const data=executionSettings();Object.assign(data.executions[1],{question_mode:'individual',scheduling:'parallel',review_source:'custom',
    review_connection:{base_url:'https://review.example/v1',model:'independent-reviewer',api_key_configured:true}});
  const page=harness(basicHandler,{executions:data});await page.mount();
  setRole(page,'question',{api_key:'unsaved-private-key'});
  page.nodes.executionProfile.value='gpu31b';page.nodes.executionProfile.onchange();
  assert.equal(page.nodes.questionKey.value,'');assert.equal(page.nodes.questionMode.value,'individual');
  assert.equal(page.nodes.questionScheduling.value,'parallel');assert.equal(page.nodes.questionSource.value,'general');
  assert.equal(page.nodes.reviewSource.value,'custom');assert.equal(page.nodes.reviewConnectionFields.hidden,false);
  assert.equal(page.nodes.reviewModel.value,'independent-reviewer');assert.equal(page.nodes.reviewKey.value,'');
  assert.match(page.nodes.reviewKeyState.textContent,/설정됨/);
  assert.equal(page.calls.filter(call=>call.method==='PUT').length,0);
});

test('blank role keys are omitted independently and general roles never send stale custom fields',async()=>{
  let input;const page=harness(basicHandler,{executionHandler:(_path,options)=>{
    if(options.method==='PUT')input=JSON.parse(options.body);return executionSettings();
  }});
  await page.mount();setRole(page,'question');setRole(page,'review',{api_key:'unused-review-key'});
  page.nodes.reviewSource.value='general';page.nodes.reviewSource.onchange();await page.submitExecution();
  assert.deepEqual(input,{question_mode:'single',scheduling:'individual',question_source:'custom',review_source:'general',
    question_connection:{base_url:'https://same.example/v1',model:'same-general-model'}});
  assert.equal(page.nodes.reviewKey.value,'');
});

test('execution validation and missing general connection block writes before dispatch',async()=>{
  const data=executionSettings();data.executions[1].configured=false;
  const page=harness(basicHandler,{executions:data});await page.mount();setRole(page,'question',{model:''});
  await page.submitExecution();assert.match(page.nodes.executionStatus.textContent,/질문용 API/);
  assert.equal(page.calls.length,4);
  page.nodes.executionProfile.value='gpu31b';page.nodes.executionProfile.onchange();
  assert.equal(page.nodes.saveExecution.disabled,true);assert.match(page.nodes.executionState.textContent,/먼저.*범용 모델 연결/);
  await page.submitExecution();assert.equal(page.calls.length,4);
  page.nodes.executionProfile.value='invalid';await page.submitExecution();assert.equal(page.calls.length,4);
  page.nodes.executionProfile.value='local12b';page.nodes.executionProfile.onchange();page.nodes.questionMode.value='unlimited';
  await page.submitExecution();assert.equal(page.calls.length,4);assert.match(page.nodes.executionStatus.textContent,/다시 선택/);
});

test('execution requests block duplicate or concurrent form saves and recover from network failure without leaking keys',async()=>{
  let fail;const pending=new Promise((_,reject)=>{fail=reject;});
  const page=harness(basicHandler,{executionHandler:(_path,options)=>options.method==='PUT'?pending:executionSettings()});
  await page.mount();setRole(page,'question',{api_key:'private-execution-key'});
  const saving=page.submitExecution();await page.submitExecution();await page.submit();await page.submitApi();
  assert.equal(page.calls.length,5);assert.equal(page.nodes.saveExecution.disabled,true);
  assert.equal(page.nodes.saveModel.disabled,true);assert.equal(page.nodes.saveApi.disabled,true);
  fail(new Error('private-execution-key upstream error'));await saving;
  assert.match(page.nodes.executionStatus.textContent,/연결을 확인/);assert.doesNotMatch(page.nodes.executionStatus.textContent,/private-execution-key/);
  assert.equal(page.nodes.currentModel.textContent,'현재 설정: 12B');assert.equal(page.nodes.saveExecution.disabled,false);
});

test('malformed execution metadata leaves all forms disabled',async()=>{
  for(const mutate of [data=>data.executions.pop(),data=>data.executions[0].question_mode='unlimited',
    data=>data.executions[0].id='unknown',data=>data.executions[0].review_connection={base_url:'bad'}]){
    const data=executionSettings();mutate(data);const page=harness(basicHandler,{executions:data});await page.mount();
    assert.equal(page.nodes.saveExecution.disabled,true);assert.equal(page.nodes.saveApi.disabled,true);assert.equal(page.nodes.saveModel.disabled,true);
    assert.match(page.nodes.modelStatus.textContent,/질문 실행 설정 응답/);
  }
});
