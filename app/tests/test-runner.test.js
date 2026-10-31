import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTestRuns } from '../src/test-runs.js';
import { initialQuestionSet, questionCatalogOf } from '../src/question-bank.js';

const sandbox=vm.createContext({TextEncoder});
vm.runInContext(readFileSync(new URL('../public/js/test-input.js',import.meta.url),'utf8')+'\nglobalThis.input=TestInput;',sandbox);
const parse=data=>JSON.parse(JSON.stringify(sandbox.input.parse(JSON.stringify(data),questionCatalogOf(initialQuestionSet))));
const answers=[{question_id:'name',text:'합성 친구'},{question_id:'want',text:'이야기를 듣고 싶어요.'}];
const generated={patient_state:{summary:'',facts:[],unknowns:[],user_goal:''},name_index:null,
  assessment:{safety:false},guide:{script:'합성 결과'}};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('JSON imports retain raw text, exact option labels, direct inputs and case order',()=>{
  const text=' 원문\n👩‍👩‍👧 ';
  const cases=parse({cases:[{title:'첫 사례',answers:{name:text,rel:'친구',mood:{selected:[0],custom:text},describe:null}},
    {answers:[{question_id:'want',text}]}]});
  assert.equal(cases.length,2);assert.equal(cases[0].title,'첫 사례');
  assert.deepEqual(cases[0].answers,[{question_id:'name',text},{question_id:'rel',selected:[4]},
    {question_id:'mood',selected:[0],custom:text},{question_id:'describe',skipped:true}]);
  assert.equal(cases[1].answers[0].text,text);
  assert.deepEqual(parse({answers:{rel:'합성 관계'}})[0].answers,[{question_id:'rel',custom:'합성 관계'}]);
});

test('invalid imports fail before a request',()=>{
  for(const data of [null,[],{}, {answers:{}}, {cases:[]}, {cases:Array(21).fill({answers:{name:'a'}})},
    {answers:{unknown:'x'}},{answers:[{question_id:'name',text:'a'},{question_id:'name',text:'b'}]},
    {answers:{name:{text:'a',ignored:'b'}}},{answers:{cause:'없는 보기'}}, {answers:{mood:['없는 보기']}},
    {answers:{name:'a'},ignored:true},{cases:[{answers:{name:'a'}}],ignored:true}]) assert.throws(()=>parse(data));
  assert.throws(()=>sandbox.input.parse('{',[]));
  assert.throws(()=>sandbox.input.parse('가'.repeat(100000),[]));
});

test('test generation uses the final gateway with raw sources and has no persistence dependency',async()=>{
  let context;
  const runs=createTestRuns({questionSet:async()=>initialQuestionSet,gateway:{protocol:'relationship_agent',
    async respond(value,memory){context=value;assert.equal(memory,null);return generated;}}});
  const result=await runs.start('owner','run',{answers});
  assert.equal(result.saved,false);assert.equal(result.test,true);
  assert.equal(result.profile.name,'합성 친구');assert.equal(result.guide.script,'합성 결과');
  assert.equal(context.patient.fields.name.rawText,'합성 친구');
  assert.equal(context.patient.fields.concern.status,'not_asked');
  assert.equal(context.supporter.fields.feeling.status,'not_asked');
  assert.throws(()=>runs.progress('owner','run'),{code:'TEST_RUN_NOT_FOUND'});
});

test('progress is owner scoped and cancellation prevents late success',async()=>{
  const entered=deferred(), done=deferred();let signal;
  const runs=createTestRuns({questionSet:async()=>initialQuestionSet,gateway:{async respond(context,memory,options){
    signal=options.signal;options.onCard({type:'upsert',id:'script',value:'합성 부분 출력'});entered.resolve();
    await done.promise;return generated;
  }}});
  const pending=runs.start('one','run',{answers});await entered.promise;
  assert.equal(runs.progress('one','run').cards[0].value,'합성 부분 출력');
  assert.throws(()=>runs.progress('two','run'),{code:'TEST_RUN_NOT_FOUND'});
  assert.throws(()=>runs.cancel('two','run'),{code:'TEST_RUN_NOT_FOUND'});
  await assert.rejects(runs.start('one','other',{answers}),{code:'TEST_RUN_ACTIVE'});
  runs.cancel('one','run');assert.equal(signal.aborted,true);
  assert.throws(()=>runs.progress('one','run'),{code:'TEST_RUN_NOT_FOUND'});
  done.resolve();await assert.rejects(pending,{code:'MODEL_CANCELLED'});
  assert.throws(()=>runs.progress('one','run'),{code:'TEST_RUN_NOT_FOUND'});
});

test('disconnect, shutdown and deletion abort model work; invalid answers never invoke it',async()=>{
  for(const mode of ['disconnect','shutdown','delete-owner']) {
    const entered=deferred(),controller=new AbortController();
    const runs=createTestRuns({questionSet:async()=>initialQuestionSet,gateway:{respond(context,memory,{signal}){
      entered.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }}});
    const pending=runs.start('one','run',{answers},{signal:controller.signal});await entered.promise;
    if(mode==='disconnect')controller.abort();else if(mode==='shutdown')runs.shutdown();else runs.cancelOwner('one');
    await assert.rejects(pending,{code:'MODEL_CANCELLED'});
    assert.throws(()=>runs.progress('one','run'),{code:'TEST_RUN_NOT_FOUND'});
  }
  let calls=0;
  const runs=createTestRuns({questionSet:async()=>initialQuestionSet,gateway:{respond(){calls++;return generated;}}});
  await assert.rejects(runs.start('one','run',{answers:[{question_id:'no_such_question',text:'x'}]}));
  await assert.rejects(runs.start('one','run',{answers,ignored:true}));assert.equal(calls,0);
  await runs.start('one','run',{answers});assert.equal(calls,1);
});

function browserRunner(cases) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false});return nodes.get(id);};
  const context=vm.createContext({$:node,TextEncoder,AbortController,setTimeout,clearTimeout,
    crypto:{randomUUID:()=>String(Math.random())},TestInput:{parse:()=>cases},esc:value=>String(value)});
  const source=readFileSync(new URL('../public/js/test-runner.js',import.meta.url),'utf8');
  vm.runInContext(source.replace('TestRunner.init();','globalThis.runner=TestRunner;'),context);
  const runner=context.runner;
  runner.poll=async()=>{};
  runner.display=index=>{runner.selected=index;runner.updateSelector();};
  return {runner,node};
}

test('browser batch runs sequentially, retains earlier results after a case fails, and re-enables input',async()=>{
  const cases=[{title:'one',answers},{title:'two',answers},{title:'three',answers}];
  const {runner,node}=browserRunner(cases);let calls=0,active=0;
  runner.request=async(path,options)=>{
    assert.equal(active++,0);assert.equal(options.method,'POST');
    await Promise.resolve();active--;
    if(++calls===2)throw new Error('합성 실패');
    return {guide:generated.guide};
  };
  await runner.start();
  assert.equal(calls,3);
  assert.deepEqual(Array.from(runner.cases,item=>item.status),['complete','failed','complete']);
  assert.equal(runner.cases[1].error,'합성 실패');
  assert.equal(node('test-input').disabled,false);assert.equal(node('test-stop').hidden,true);
  assert.equal(node('test-download').disabled,false);assert.equal(node('test-status').textContent,'2개 완료 · 1개 오류.');
});

test('browser stop cancels the current request, starts no remaining cases, and ignores a late result',async()=>{
  const {runner,node}=browserRunner([{title:'one',answers},{title:'two',answers}]);
  const started=deferred(),done=deferred();let posts=0;
  runner.request=async(path,{method})=>{
    if(method==='DELETE')return {};
    posts++;started.resolve();await done.promise;return {guide:generated.guide};
  };
  const running=runner.start();await started.promise;runner.stop();done.resolve();await running;
  assert.equal(posts,1);
  assert.deepEqual(Array.from(runner.cases,item=>item.status),['cancelled','cancelled']);
  assert.equal(runner.cases[0].result,undefined);
  assert.equal(node('test-download').disabled,true);assert.equal(node('test-run').disabled,false);
});
