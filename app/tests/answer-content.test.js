import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntake, currentView, answerIntake, buildContext } from '../src/intake.js';
import { initialQuestionRows, createQuestionSet } from '../src/question-bank.js';
import { sourceDocuments, retrieveSources, retrievedContext } from '../src/relationship-retrieval.js';
import { safetySources, agentContext, canonicalRelationshipSelection } from '../src/relationship-agent.js';
import { evidenceQuotes, safetyEvidenceQuotes } from '../src/model-schema.js';

// These are state-contract tests. Current migrated questions are exercised by
// the API suite; the legacy snapshot must enforce the same input boundaries.
function atQuestion(id, questionSet) {
  let state = createIntake(questionSet);
  for (let steps = 0; steps < 70; steps++) {
    const q = currentView(state).question;
    if (q.id === id && !q.follow_up) return state;
    state = answerIntake(state, {question_id:q.id,follow_up:!!q.follow_up,
      ...(q.type === 'text' ? {text:'관찰한 내용을 합성 문장으로 충분히 설명합니다.'} : {selected:[0]})});
  }
  throw new Error(`Question not reached: ${id}`);
}

const absent = ['\u200b'.repeat(30), '\u2060\u200d\ufe0f\u0000', '\u3164\uffa0\u115f\u1160',
  '\u00ad\u034f\u061c\u202e\u2066\u{e0100}', '(건너뛰었어요)\u200b'];
const present = ['  👨‍👩‍👧 e\u0301  ', '친\u200b구의 말을 듣고 싶어요.', 'क्‍ष', '한글', '모름', '없음'];

test('required single/multi and optional single choices cannot use invisible custom text as an answer', () => {
  for (const id of ['rel','mood','contact']) {
    const state = atQuestion(id), before = structuredClone(state);
    for (const text of absent) {
      assert.throws(() => answerIntake(state,{question_id:id,selected:[],text,custom:text}), {code:'answer_required'});
      assert.deepEqual(state,before);
    }
  }
});

test('optional multi with no selection keeps its explicit none behavior and ignores empty custom content', () => {
  const state = atQuestion('goal');
  for (const custom of absent) {
    const next = answerIntake(state,{question_id:'goal',selected:[],custom});
    const field = buildContext(next).user_goal.desired_outcomes;
    assert.equal(field.text,'해당 없음');
    assert.equal(field.custom,'');
    assert.equal(field.status,'answered');
    assert.deepEqual(sourceDocuments(buildContext(next)).filter(x=>x.question_id==='goal').map(x=>x.text),['해당 없음']);
  }
});

test('a selected multi option survives invisible custom content without creating an invisible source', () => {
  const state = atQuestion('mood');
  for (const custom of absent) {
    const next = answerIntake(state,{question_id:'mood',selected:[0],custom});
    const context = buildContext(next), field = context.patient.fields.mood;
    assert.equal(field.custom,'');assert.equal(field.selected.length,1);
    assert.equal(sourceDocuments(context).some(x=>x.question_id==='mood' && x.text===custom),false);
    assert.equal(safetySources(context).some(x=>x.question_id==='mood' && x.components.some(c=>c.text===custom)),false);
  }
});

test('choice custom text preserves meaningful Unicode and surrounding whitespace', () => {
  for (const id of ['rel','mood','goal','contact']) {
    const state = atQuestion(id);
    for (const text of present) {
      const next = answerIntake(state,{question_id:id,text,custom:text});
      const field = id === 'goal' ? buildContext(next).user_goal.desired_outcomes : buildContext(next).patient.fields[id];
      assert.equal(field.custom,text);assert.equal(field.rawText,text);assert.equal(field.text,text);
    }
  }
});

test('optional option detail retains raw absence for history but never offers it as evidence', () => {
  for (const id of ['support','burden','cgchange_more']) {
    const state = atQuestion(id);
    for (const text of absent) {
      const next = answerIntake(state,{question_id:id,selected:[0],text});
      const context = buildContext(next), field = context.patient.fields[id] || context.supporter.fields[id];
      assert.equal(field.rawText,text);assert.equal(field.text,'네');
      assert.equal(field.skipped,false);assert.equal(field.selected.length,1);
      assert.deepEqual(sourceDocuments(context).filter(x=>x.question_id===id).map(x=>x.text),['네']);
      assert.deepEqual(safetySources(context).find(x=>x.question_id===id).components.map(c=>c.text),['네']);
      const entries = [...agentContext(context).patient,...agentContext(context).supporter];
      assert.deepEqual(entries.find(x=>x.question_id===id).answers.map(answer=>answer.text),['네']);
    }
  }
});

test('a real selected answer with absent detail survives retrieval and complete safety-source validation', () => {
  const migration = readFileSync(new URL('../migrations/004_frontend_questions.sql', import.meta.url), 'utf8');
  const updates = JSON.parse(migration.split('$frontend_defaults$')[1]);
  const questionSet = createQuestionSet(structuredClone(initialQuestionRows).map(row => {
    if (row.id === 'name') { row.definition.required = true; delete row.definition.follow_up; }
    const update = updates.find(update => update.id === row.id);
    if (update) row.definition = structuredClone(update.after);
    if (row.id === 'coping') row.enabled = false;
    return row;
  }));
  assert.equal(questionSet.questions.length,29);
  const state = atQuestion('support',questionSet);
  for (const text of ['(건너뛰었어요)',...absent,...present]) {
    const context = buildContext(answerIntake(state,{question_id:'support',selected:[0],text}));
    const field = context.patient.fields.support;
    assert.equal(field.rawText,text);
    const retrieval = retrieveSources(context,{stage:'analysis'});
    const source = safetySources(retrievedContext(context,retrieval)).find(row=>row.question_id==='support');
    assert.ok(source,'the actual selected answer must be retrieved');
    const label = context.patient.fields.rel.text;
    const result = canonicalRelationshipSelection({
      observations:{patient:[],supporter:[]},
      relationship:{label,supporter_role:label,dynamics:[],strengths:[],boundaries:[]},
      unknowns:[],safety:{urgent:false,evidence_ids:[source.id]},
    },context,retrieval);
    const expected = present.includes(text) ? [...new Set([field.rawText,field.text])] : ['네'];
    assert.deepEqual(source.components.map(component=>component.text),expected);
    assert.deepEqual(safetyEvidenceQuotes(field),expected);
    assert.deepEqual(result.safety.evidence.map(ref=>ref.quote),expected);
    if (!present.includes(text)) assert.deepEqual(evidenceQuotes(field),['네']);
    else assert.ok(result.safety.evidence.some(ref=>ref.quote===text),'meaningful Unicode must remain verbatim');
  }
});
