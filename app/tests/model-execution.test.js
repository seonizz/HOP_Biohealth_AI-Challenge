import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {DEFAULT_MODEL_EXECUTION,validateModelExecution} from '../src/model-execution.js';
import {createModelProfiles} from '../src/model-profiles.js';
import {prepareModelExecution,prepareModelConnection,connectionGateway,withModelConnections,missingExecutionDefaults,missingModelBaselines} from '../src/model-connections.js';

const general=()=>new ModelGateway({baseUrl:'https://general.example/v1',model:'generic-12b',apiKey:'GENERAL_PRIVATE_KEY',
  protocol:'relationship_agent',stateMode:'combined',bundleFinalReviews:true,reuseFinalDraft:true,detailedCardAnalysis:true,
  retryFailures:true,diagnosticLogger:null});
const custom=model=>({base_url:'https://roles.example/v1',model,api_key:model+'_PRIVATE_KEY'});
const settings=patch=>({...DEFAULT_MODEL_EXECUTION,...patch});
const prepare=(input=settings(),gateway=general())=>prepareModelExecution('local12b',input,gateway);

test('new question default is one call on the general model and final gateway options stay unchanged',()=>{
  const original=general(),result=prepare(settings(),original),question=result.gateway.questionGateway;
  assert.equal(original.questionGateway,undefined);
  assert.equal(question.model,original.model);assert.equal(question.singleCallQuestionOnly,true);
  assert.equal(question.questionCallLimit,1);assert.equal(question.questionExecution,'individual');
  assert.equal(question.reviewGateway,null);assert.equal(question.retryFailures,false);
  assert.equal(result.gateway.singleCallTurns,original.singleCallTurns);
  for(const key of ['bundleFinalReviews','reuseFinalDraft','detailedCardAnalysis','stateMode','model','apiKey'])
    assert.equal(result.gateway[key],original[key],key);
  assert.equal(result.gateway.reviewGateway,original.reviewGateway);
});

test('two-call and individual modes independently select scheduling and reviewer target',()=>{
  for(const mode of ['two','individual'])for(const scheduling of ['individual','parallel']){
    const {gateway}=prepare(settings({question_mode:mode,scheduling,question_source:'custom',review_source:'custom',
      question_connection:custom('question'),review_connection:custom('review')}));
    assert.equal(gateway.model,'generic-12b');assert.equal(gateway.questionGateway.model,'question');
    assert.equal(gateway.questionGateway.reviewGateway.model,'review');
    assert.equal(gateway.questionGateway.questionExecution,scheduling);
    assert.equal(gateway.questionGateway.questionCallLimit,mode==='two'?2:0);
    assert.equal(gateway.questionGateway.bundleCombinedTurnReviews,mode==='two');
    assert.equal(gateway.questionGateway.stateMode,mode==='two'?'combined':'combined_blocks');
    assert.equal(gateway.questionGateway.reviewGateway.singleCallTurns,false);
  }
});

test('same model in both roles is supported without confusing role credentials',()=>{
  const first=prepare(settings({question_mode:'two',question_source:'custom',review_source:'custom',
    question_connection:custom('same'),review_connection:{...custom('same'),api_key:'REVIEW_PRIVATE_KEY'}}));
  const second=prepare(settings({question_mode:'two',question_source:'custom',review_source:'custom',
    question_connection:{...custom('same'),api_key:''},review_connection:{...custom('same'),api_key:''}}),first.gateway);
  assert.equal(second.gateway.questionGateway.model,second.gateway.questionGateway.reviewGateway.model);
  assert.equal(second.gateway.questionGateway.apiKey,'same_PRIVATE_KEY');
  assert.equal(second.gateway.questionGateway.reviewGateway.apiKey,'REVIEW_PRIVATE_KEY');
  for (const role of ['question','review']) {
    const moved={...custom('same'),base_url:'https://new-role.example/v1',api_key:''};
    assert.throws(()=>prepare(settings({[role+'_connection']:moved}),first.gateway),{code:'INVALID_MODEL_CONNECTION'});
  }
  assert.throws(()=>prepare(settings({question_source:'custom',question_connection:{...custom('new'),api_key:''}})),{code:'INVALID_MODEL_CONNECTION'});
});

test('inactive custom roles are preserved without being contacted or exposed as the active model',()=>{
  const first=prepare(settings({question_source:'custom',review_source:'custom',question_connection:custom('question'),review_connection:custom('review')}));
  const second=prepare(settings(),first.gateway);
  assert.equal(second.gateway.questionGateway.model,'generic-12b');assert.equal(second.gateway.questionGateway.reviewGateway,null);
  const restored=prepare(settings({question_source:'custom',review_source:'custom',question_mode:'two'}),second.gateway);
  assert.equal(restored.gateway.questionGateway.model,'question');assert.equal(restored.gateway.questionGateway.reviewGateway.model,'review');
});

test('settings survive snapshot restoration and general edits without redirecting custom roles or old versions',()=>{
  const first=prepare(settings({question_mode:'two',question_source:'custom',review_source:'custom',question_connection:custom('question'),review_connection:custom('review')}));
  const frozen=structuredClone(first.config),restored=connectionGateway(frozen);
  const changed=prepareModelConnection('local12b',{base_url:'https://new-general.example/v1',model:'new-general',api_key:'NEW_PRIVATE_KEY'},restored);
  assert.equal(changed.gateway.model,'new-general');assert.equal(changed.gateway.questionGateway.model,'question');
  assert.equal(changed.gateway.questionGateway.reviewGateway.model,'review');
  assert.deepEqual(first.config,frozen);assert.equal(restored.model,'generic-12b');
  assert.equal(restored.questionGateway.questionCallLimit,2);
});

test('default initialization creates a separate new-conversation version and preserves legacy routing',()=>{
  const original=general(),base=createModelProfiles({local12b:original,gpu31b:null});
  const baseline={...missingModelBaselines(base)[0],id:'local12b_'+'0'.repeat(32)};
  const profiles=withModelConnections(base,[baseline]);
  const defaults=missingExecutionDefaults(profiles,[baseline]);assert.equal(defaults.length,1);
  assert.equal(defaults[0].config.role,'execution_default');
  const row={...defaults[0],id:'local12b_'+'2'.repeat(32)};profiles.add(row);
  assert.equal(profiles.bind('local12b'),row.id);assert.equal(profiles.resolve('local12b').questionGateway,undefined);
  assert.equal(profiles.current('local12b').questionGateway.singleCallTurns,true);
  assert.deepEqual(missingExecutionDefaults(profiles,[baseline,row]),[]);
  assert.equal(profiles.executions()[1].configured,false);
  assert.doesNotMatch(JSON.stringify(profiles.executions()),/PRIVATE_KEY/);
});

test('general edits follow the newly saved general target for shared roles only',()=>{
  const current=prepare().gateway;
  const changed=prepareModelConnection('gpu31b',{base_url:'https://changed.example/v1',model:'changed',api_key:'CHANGED_PRIVATE_KEY'},current);
  assert.equal(changed.gateway.questionGateway.model,'changed');assert.equal(changed.gateway.questionGateway.singleCallTurns,true);
  assert.equal(current.questionGateway.model,'generic-12b');
});

test('invalid choices and missing custom connections are rejected before a snapshot is created',()=>{
  for(const patch of [{question_mode:'three'},{scheduling:'auto'},{question_source:'gpu31b'},{review_source:'unknown'}])
    assert.throws(()=>prepare(settings(patch)),{code:'INVALID_MODEL_EXECUTION'});
  for(const patch of [{question_source:'custom'},{review_source:'custom'},{extra:'PRIVATE_KEY'}])
    assert.throws(()=>prepare(settings(patch)),error=>error.status===422);
  assert.throws(()=>validateModelExecution({question_mode:'single'}),{code:'INVALID_MODEL_EXECUTION'});
  assert.throws(()=>prepareModelExecution('unknown',settings(),general()),{code:'MODEL_PROFILE_UNAVAILABLE'});
  assert.throws(()=>prepareModelExecution('local12b',settings(),null),{code:'MODEL_PROFILE_UNAVAILABLE'});
});

test('block-specific optimization flags cannot invalidate a new one-call question policy',()=>{
  const original=general();Object.assign(original,{stateMode:'combined_blocks',reuseReviewedName:true,reuseReviewedSafety:true,bundleTurnReviews:true});
  assert.equal(original.configured,true);
  const restored=prepare(settings(),original).gateway;
  assert.equal(restored.questionGateway.configured,true);
  assert.equal(restored.questionGateway.reuseReviewedName,false);
  assert.equal(restored.stateMode,'combined_blocks');assert.equal(restored.reuseReviewedName,true);
});
