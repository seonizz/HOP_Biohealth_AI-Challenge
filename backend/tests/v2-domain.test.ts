import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { catalog,questions,alias,render,validateAnswer,eligibility,nextQuestion,readiness,coverage,questionSnapshot,assertCatalogPublishable } from '../src/v2/questions.ts';
import { ContentCipher,inputHash,evidence } from '../src/v2/crypto.ts';
import { assessSafety } from '../src/v2/safety.ts';
import { RunBudget,fitContext,validateExtraction,validateGuidance,LocalAgentModel } from '../src/v2/model.ts';

test('Q-01: the immutable catalog has exactly 24 stable IDs and draft publication is blocked',()=>{
 assert.deepEqual(questions.map(q=>q.id).sort(),['N00',...Array.from({length:17},(_,i)=>'T'+String(i+1).padStart(2,'0')),'C01','C01A','C02','C03','C04','C05'].sort());
 assert.equal(new Set(questions.map(q=>q.id)).size,24);assert.throws(()=>assertCatalogPublishable());
 assert.throws(()=>assertCatalogPublishable({...catalog,publication_status:'published',rights_status:'approved',clinical_review_status:'approved',review_refs:[]}));
});
for(const [name,particle,expected] of [['엄마','은는','엄마는'],['형','이가','형이'],['친구 지수','와과','친구 지수와'],['아들','으로로','아들로'],['형','으로로','형으로'],['엄마'.normalize('NFD'),'을를','엄마를'],['엄마💚','은는','엄마💚는'],['Alex','은는','중립 문장'],['민수2','은는','중립 문장'],['ㄱ','은는','중립 문장']])test('Q-02 particles '+name+' '+particle,()=>assert.equal(render('{subject:'+particle+'}','중립 문장',alias(name)),expected));
test('Q-02 alias cannot inject HTML, a template, controls or excessive code points',()=>{for(const name of ['<script>','{subject:은는}','엄마\n아들','가'.repeat(31)])assert.throws(()=>alias(name));assert.equal(alias('😀'.repeat(30)), '😀'.repeat(30));});
test('Q-03 relationship describes subject-to-supporter and permits unknown frequency',()=>{
 const value=validateAnswer('T01','answered',{relation:{status:'answered',option_id:'parent'},contact_frequency:{status:'unknown'}});
 assert.equal(value.relation.option_id,'parent');assert.equal(value.contact_frequency.status,'unknown');
 assert.throws(()=>validateAnswer('T01','answered',{relation:{status:'unknown'},contact_frequency:{status:'skipped'}}));
});
test('Q-04 none is exclusive and choices are bounded, deduplicated, version-specific',()=>{
 for(const options of [['none','friends'],['friends','friends'],['invented']])assert.throws(()=>validateAnswer('T07','answered',{option_ids:options}));
 assert.throws(()=>validateAnswer('T15','answered',{option_ids:['listening','communication']}));
 assert.throws(()=>validateAnswer('T02','answered',{option_ids:['other']}));
 assert.deepEqual(validateAnswer('T02','answered',{text:'선택지에 매핑하지 않는 원문'}),{text:'선택지에 매핑하지 않는 원문'});
 assert.throws(()=>validateAnswer('T02','answered',{option_ids:['alcohol'],text:'충돌'}));
});
test('Q-05 dispositions are distinct and cannot carry answer values',()=>{
 for(const disposition of ['unknown','skipped']){assert.equal(validateAnswer('T02',disposition,null),null);assert.throws(()=>validateAnswer('T02',disposition,{text:'내용'}));}
 assert.throws(()=>validateAnswer('T02','not_applicable',null));
 const answers:any={T01:{disposition:'unknown'},T02:{disposition:'skipped'}};
 assert.equal(readiness(answers,'understand').understand,false);assert.equal(coverage(answers).unknown,1);assert.equal(coverage(answers).skipped,1);
});
test('Q-06 parent correction removes derived inapplicability; unknown only defers',()=>{
 const answers:any={T09:{id:'source',disposition:'answered',value:{option_ids:['none']}}};
 assert.equal(eligibility('T10',answers),'not_applicable');assert.equal(validateAnswer('T10','not_applicable',null,answers),null);
 answers.T09.value={option_ids:['language']};assert.equal(eligibility('T10',answers),'eligible');
 answers.T09.disposition='unknown';assert.equal(eligibility('T11',answers),'deferred');
});
test('Q-07 no previous help never hides access barriers',()=>assert.equal(eligibility('T14',{T13:{id:'1',question_id:'T13',disposition:'answered',value:{option_ids:['none']}}}),'eligible'));
test('Q-08 caregiver emotion has an independent variant; frequency needs an event',()=>{
 assert.equal(eligibility('C01A',{}),'deferred');assert.equal(questionSnapshot('C02','엄마',{}).variant,'general_recent');assert.equal(questionSnapshot('T17','엄마',{}).variant,'future_help');
});
test('Q-09 explicit eligible question takes priority; skipped questions do not repeat automatically',()=>{
 const answers:any={N00:{disposition:'skipped'},T01:{disposition:'unknown'},T02:{disposition:'skipped'}};
 assert.equal(nextQuestion(answers,'understand','C02'),'C02');assert.notEqual(nextQuestion(answers,'understand'),'T02');assert.throws(()=>nextQuestion({},'understand','C01A'));
});
test('C04 accepts distinct coping methods and rejects invented effects and incomplete other',()=>{
 assert.deepEqual(validateAnswer('C04','answered',{entries:[{method_option_id:'rest',effect_option_id:'unknown'}]}).entries[0],{method_option_id:'rest',effect_option_id:'unknown'});
 for(const entry of [{method_option_id:'other',effect_option_id:'helpful'},{method_option_id:'rest',effect_option_id:'cured'}])assert.throws(()=>validateAnswer('C04','answered',{entries:[entry]}));
});
test('canonical request hashing preserves meaningful whitespace, normalizes Unicode and unordered choices',()=>{
 assert.equal(inputHash({value:{option_ids:['b','a']},text:'가'.normalize('NFD')}),inputHash({text:'가',value:{option_ids:['a','b']}}));
 assert.notEqual(inputHash({text:'가 나'}),inputHash({text:'가  나'}));assert.notEqual(inputHash({action:'answer'}),inputHash({action:'message'}));
});
test('authenticated encryption binds owner and resource and rejects ciphertext tampering',()=>{
 const cipher=new ContentCipher(randomBytes(32).toString('base64')),payload=cipher.seal({text:'private marker'},'owner:a');
 assert.ok(!JSON.stringify(payload).includes('private marker'));assert.equal(cipher.open(payload,'owner:a').text,'private marker');assert.throws(()=>cipher.open(payload,'owner:b'));
 assert.throws(()=>cipher.open({...payload,tag:randomBytes(16).toString('base64')},'owner:a'));
});
for(const [text,route,time] of [
 ['제가 지금 죽고 싶어요','urgent','current'],['엄마가 지금 자해하고 있어요','urgent','current'],['아들이 지금 숨을 못 쉬어요','urgent','current'],['죽을 생각은 없어요','clarify','negated'],['예전에 죽고 싶었어요','clarify','past'],['영화에서 자살하는 장면을 봤어요','clarify','hypothetical'],['죽고 싶다고 말했어요','clarify','unknown'],['예전에는 죽고 싶었어요. 지금 자해하고 있어요','urgent','current'],['그런 생각은 없어요. 그런데 지금 약을 한꺼번에 먹었어요','urgent','current'],['제가 요즘 불안해요','no_signal','unknown']])test('S-01/S-02 routing '+text,()=>{const result=assessSafety(text);assert.equal(result.route,route);assert.equal(result.temporality,time);});
test('M-03/M-04 extraction cannot convert supporter emotions or reported speech into subject facts',()=>{
 const context={current_message:'제가 불안해요'},candidate={question_id:'C02',entity:'supporter',value:'불안을 보고함',source_type:'self_report',quote:'제가 불안해요',start_cp:0,end_cp:7};
 assert.equal(validateExtraction({assertion_candidates:[candidate],topic_candidates:[],safety_observations:[],contradictions:[]},context).assertion_candidates.length,1);
 assert.throws(()=>validateExtraction({assertion_candidates:[{...candidate,question_id:'T02',entity:'subject'}],topic_candidates:[],safety_observations:[],contradictions:[]},context));
 const quote='엄마가 걱정이 많다고 말했어요';assert.throws(()=>validateExtraction({assertion_candidates:[{...candidate,question_id:'T02',entity:'subject',source_type:'observation',quote,start_cp:0,end_cp:[...quote].length}],topic_candidates:[],safety_observations:[],contradictions:[]},{current_message:quote}));
});
test('M-12 evidence offsets count code points, including emoji',()=>{evidence('😀걱정해요','걱정해요',1,5);assert.throws(()=>evidence('😀걱정해요','걱정해요',2,6));});
test('M-12 context overflow drops optional material but never truncates current safety input',async()=>{
 const model:any={countTokens:async(s:string)=>[...s].length};
 const fitted=await fitContext(model,{current_message:'지금 위험합니다',recent_messages:[{id:'old',content:'가'.repeat(20000)}]},16000,new AbortController().signal);
 assert.deepEqual(fitted.excluded,['old']);assert.equal(fitted.context.current_message,'지금 위험합니다');
 await assert.rejects(fitContext(model,{current_message:'가'.repeat(20000)},16000,new AbortController().signal));
});
test('A-06 bounded execution rejects a sixth call and expired deadlines',async()=>{
 const budget=new RunBudget(Date.now()+60000,new AbortController().signal),model:any={call:async()=>({})};
 for(let i=0;i<5;i++)await budget.call(model,'guide',{current_message:''});
 await assert.rejects(budget.call(model,'guide',{current_message:''}));assert.throws(()=>new RunBudget(Date.now()-1,new AbortController().signal).check());
});
test('model adapter rejects external hosts and embedded credentials',()=>{for(const url of ['https://example.com/v1','http://name:password@127.0.0.1:8001/v1'])assert.throws(()=>new LocalAgentModel(url,'test'));});
