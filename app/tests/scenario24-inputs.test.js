import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SCENARIO24_FIELDS,buildScenario24Plan,buildScenario24Plans,scenario24Answer,validateScenario24Coverage,loadScenario24Inputs} from '../scripts/scenario24-inputs.mjs';
import {createQuestionSet} from '../src/question-bank.js';
import {createIntake,answerIntake,prepareModelAnswer,buildContext} from '../src/intake.js';

// Small invented values only. No source-bundle answers or model outputs live here.
function fixture() {
  const options = {relationship:['친구','직접 입력'],contact:['한 달에 몇 번','직접 입력'],symptoms:['관찰 A','관찰 B'],
    onset:['2주 미만','잘 모르겠어요'],recent_frequency:['며칠 정도'],events:['이사·환경 변화','기타(직접 입력)'],
    help_received:['가족·친구의 도움','기타(직접 입력)'],help_barriers:['없어요','기타(직접 입력)'],
    supporter_frequency:['가끔'],supporter_changes:['잠을 잘 못 자요','특별한 변화는 없어요','기타(직접 입력)'],
    supporter_supports:['친구','기타(직접 입력)'],message_goals:['걱정된다는 마음을 전하고 싶어요','기타(직접 입력)']};
  const row = Object.fromEntries(SCENARIO24_FIELDS.map(field=>[field,'synthetic '+field+' detail']));
  Object.assign(row,{schema_version:'synthetic-fixture-v1',synthetic:true,usage:'offline test',id:3,title:'synthetic case',
    focus:'input preservation',relationship:'친구',contact:'한 달에 몇 번',symptoms:[2,1],onset:'2주 미만',
    recent_frequency:'며칠 정도',has_event:true,events:['이사·환경 변화'],help_received:['가족·친구의 도움'],
    help_barriers:['없어요'],supporter_frequency:'가끔',supporter_changes:['잠을 잘 못 자요'],
    supporter_supports:['친구'],message_goals:['걱정된다는 마음을 전하고 싶어요'],extras:{}});
  return {row,options};
}
const rejects = (fn,suffix) => assert.throws(fn,{code:'SCENARIO24_'+suffix});

test('actual option order resolves by exact label, source symptom numbers are one based',()=>{
  const {row,options}=fixture(),plan=buildScenario24Plan(row,options);
  const result=scenario24Answer(plan,{id:'mood',type:'multi',opts:['unselected','관찰 B','관찰 A']},7);
  assert.deepEqual(result.input,{revision:7,question_id:'mood',text:'관찰 A, 관찰 B',selected:[2,1],custom:'',skipped:false,follow_up:false});
  rejects(()=>scenario24Answer(plan,{id:'mood',type:'multi',opts:['관찰 A']},7),'SELECTED_OPTION_MISSING');
  rejects(()=>scenario24Answer(plan,{id:'mood',type:'multi',opts:['관찰 A','관찰 B','관찰 A']},7),'AMBIGUOUS_ACTUAL_OPTIONS');
});

test('custom controls never become selected API options; merged coping and help extra remain verbatim',()=>{
  const {row,options}=fixture();row.relationship='직접 입력';row.extras.relationship='synthetic custom relation';
  row.help_received.push('기타(직접 입력)');row.extras.help_received='synthetic prior help\nsecond literal line';
  const plan=buildScenario24Plan(row,options);
  assert.deepEqual(scenario24Answer(plan,{id:'rel',type:'one',opts:['친구']},2).input.selected,[]);
  assert.equal(scenario24Answer(plan,{id:'rel',type:'one',opts:['친구']},2).input.custom,row.extras.relationship);
  const actual=scenario24Answer(plan,{id:'help',type:'multi',opts:['unused','가족·친구의 도움']},10);
  assert.deepEqual(actual.input.selected,[1]);
  assert.equal(actual.input.custom,row.coping+'\n'+row.extras.help_received);
  assert.deepEqual(actual.provenance.fields,['coping','help_received','extras.help_received']);
  assert.equal(actual.input.text,'가족·친구의 도움, '+row.coping+'\n'+row.extras.help_received);
  rejects(()=>scenario24Answer(plan,{id:'help',type:'multi',opts:['가족·친구의 도움'],noOwn:true},10),'CUSTOM_NOT_ALLOWED');
});

test('yes detail needs the service detail channel so stored content cannot silently disappear',()=>{
  const {row,options}=fixture(),plan=buildScenario24Plan(row,options);
  assert.equal(scenario24Answer(plan,{id:'support',type:'one',opts:['아니요',['네',{input:true}]]},4).input.text,'네, '+row.supports);
  rejects(()=>scenario24Answer(plan,{id:'support',type:'one',opts:['아니요','네']},4),'DETAIL_CHANNEL_CHANGED');
});

test('absent source extra is an explicit optional skip, never generated text',()=>{
  const {row,options}=fixture(),plan=buildScenario24Plan(row,options);
  const answer=scenario24Answer(plan,{id:'extra',type:'text'},6);
  assert.deepEqual(answer.input,{revision:6,question_id:'extra',text:'',selected:[],custom:'',skipped:true,follow_up:false});
  assert.equal(answer.provenance.missing_source,true);
  for(const guard of ['required','noSkip'])rejects(()=>scenario24Answer(plan,{id:'extra',type:'text',[guard]:true},6),'MISSING_REQUIRED_SOURCE');
});

test('explicit negatives remain negatives, while conditional absence is not invented as an answer',()=>{
  const {row,options}=fixture();Object.assign(row,{has_event:false,events:[],supports:null,burdens:null,
    supporter_changes:['특별한 변화는 없어요'],supporter_extra:null});
  const plan=buildScenario24Plan(row,options);
  for(const id of ['cause','support','burden'])assert.equal(scenario24Answer(plan,{id,type:'one',opts:['네','아니요']},0).input.text,'아니요');
  rejects(()=>scenario24Answer(plan,{id:'events',type:'multi',opts:['이사·환경 변화']},0),'UNEXPECTED_CONDITIONAL_QUESTION');
  rejects(()=>scenario24Answer(plan,{id:'cgchange_more',type:'text'},0),'UNEXPECTED_CONDITIONAL_QUESTION');
  const coverage=validateScenario24Coverage(plan,[]);
  assert.equal(coverage.source_coverage.find(item=>item.field==='events').status,'not_asked_by_source_condition');
  assert.equal(coverage.source_coverage.find(item=>item.field==='supports').status,'not_submitted');
  assert.equal(coverage.original_field_count,29);
});

test('unknown, legacy separate coping, changed type and follow-up questions fail closed',()=>{
  const {row,options}=fixture(),plan=buildScenario24Plan(row,options);
  for(const id of ['free_question','gap_obs','coping','constructor'])rejects(()=>scenario24Answer(plan,{id,type:'text'},0),'UNMAPPED_QUESTION');
  rejects(()=>scenario24Answer(plan,{id:'name',type:'one',opts:['option']},0),'QUESTION_TYPE_CHANGED');
  rejects(()=>scenario24Answer(plan,{id:'name',type:'text',follow_up:true},0),'UNPLANNED_FOLLOWUP');
});

test('missing fields, repeated selections, invalid symptom IDs and unpaired extras are rejected',()=>{
  const mutations=[['ROW_FIELDS',row=>delete row.coping],['SOURCE_SELECTION',row=>row.help_received.push(row.help_received[0])],
    ['SYMPTOM_IDS',row=>row.symptoms=[0]],['SYMPTOM_IDS',row=>row.symptoms=[1,1]],
    ['CUSTOM_CONTROL',row=>row.extras.help_received='unexpected detail'],['EVENT_CONDITION',row=>row.has_event=false],
    ['CASE_ID',row=>row.id=2],['CHANGE_CONDITION',row=>row.supporter_changes.push('특별한 변화는 없어요')]];
  for(const [suffix,mutate] of mutations){const {row,options}=fixture();mutate(row);rejects(()=>buildScenario24Plan(row,options),suffix);}
});

test('24-case identity/order is strict and plans cannot change after source mapping',()=>{
  const {row,options}=fixture(),rows=Array.from({length:24},(_,index)=>({...structuredClone(row),id:index+3}));
  assert.equal(buildScenario24Plans(rows,options).length,24);
  rejects(()=>buildScenario24Plans(rows.slice(1),options),'CASE_COUNT');
  rows[23].id=3;rejects(()=>buildScenario24Plans(rows,options),'CASE_IDS_OR_ORDER');
  const plan=structuredClone(buildScenario24Plan(row,options));plan.answers.want.text+='changed';
  rejects(()=>scenario24Answer(plan,{id:'want',type:'text'},0),'PLAN_CHANGED');
});

test('coverage retains failed and missing questions and detects changed or duplicate submissions',()=>{
  const {row,options}=fixture(),plan=buildScenario24Plan(row,options),turns=[];
  for(const [id,spec] of Object.entries(plan.answers)){
    const question={id,type:spec.type,...(spec.type==='text'?{}:{opts:spec.labels.map(label=>spec.kind==='detail'?[label,{input:true}]:label)})};
    const built=scenario24Answer(plan,question,turns.length);turns.push({question,...built,status:200});
  }
  const complete=validateScenario24Coverage(plan,turns,{requireComplete:true});
  assert.equal(complete.complete,true);assert.equal(complete.source_coverage.filter(item=>item.status==='submitted').length,29);
  assert.equal(complete.extra_question.status,'explicitly_skipped');
  const failed=structuredClone(turns);failed.at(-1).status=502;
  assert.equal(validateScenario24Coverage(plan,failed).complete,false);
  rejects(()=>validateScenario24Coverage(plan,failed,{requireComplete:true}),'INCOMPLETE_COVERAGE');
  rejects(()=>validateScenario24Coverage(plan,[turns[0],turns[0]]),'DUPLICATE_OR_MISSING_TURN');
  const changed=structuredClone(turns);changed[0].input.text+='rewritten';
  rejects(()=>validateScenario24Coverage(plan,changed),'INPUT_OR_PROVENANCE_CHANGED');
});

test('exclusive unknown help selection and verbatim coping coexist in actual server normalization',()=>{
  const {row,options}=fixture();options.help_received.push('잘 모르겠어요');row.help_received=['잘 모르겠어요'];
  const plan=buildScenario24Plan(row,options),question={id:'help',type:'multi',q:'합성 도움 질문',opts:[['잘 모르겠어요',{none:1}],'가족·친구의 도움']};
  const {input}=scenario24Answer(plan,question,0),{id,...definition}=question;
  const state=createIntake(createQuestionSet([{id,definition,kind:'base',enabled:true,sort_order:100,subject:'patient'}]));
  const field=buildContext(answerIntake(state,input)).patient.fields.help;
  assert.equal(field.custom,row.coping);assert.equal(field.rawText,'잘 모르겠어요, '+row.coping);
  assert.equal(field.selection_status,'unknown');assert.equal(field.status,'answered');
  assert.deepEqual(prepareModelAnswer(state,input,0).modelPending.input,input);
});

test('local bundle loader checks exact case IDs, individual/combined files and source hashes',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'scenario24-fixture-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'구조화_데이터'));await mkdir(join(directory,'개별_답변'));
  const {row,options}=fixture(),rows=Array.from({length:24},(_,index)=>({...structuredClone(row),id:index+3}));
  const texts=rows.map(value=>'Synthetic fixture '+value.id+'\n');
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const sources={'구조화_데이터/답변_예시_24개.jsonl':rows.map(value=>JSON.stringify(value)).join('\n')+'\n',
    '구조화_데이터/선택지_사전.json':JSON.stringify(options),'전체_답변_예시_24개.txt':texts.join('\n\n'+'='.repeat(70)+'\n\n')};
  for(const [name,value] of Object.entries(sources))await writeFile(join(directory,name),value);
  const files=[];for(let index=0;index<24;index++){const file='개별_답변/'+rows[index].id+'.txt';await writeFile(join(directory,file),texts[index]);files.push({id:rows[index].id,file,sha256:sha(texts[index])});}
  await writeFile(join(directory,'구조화_데이터/검증결과.json'),JSON.stringify({status:'passed',files}));
  await writeFile(join(directory,'구조화_데이터/재검증결과.json'),JSON.stringify({status:'passed',case_count:24,answers_compared:696,
    input_sha256:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,sha(value)]))}));
  const result=await loadScenario24Inputs({directory});assert.equal(result.cases.length,24);assert.equal(result.validation.original_answer_count,696);
  await writeFile(join(directory,'구조화_데이터/답변_예시_24개.jsonl'),sources['구조화_데이터/답변_예시_24개.jsonl']+' ');
  await assert.rejects(loadScenario24Inputs({directory}),{code:'SCENARIO24_SOURCE_HASH_MISMATCH'});
});
