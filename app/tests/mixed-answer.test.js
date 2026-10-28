import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { createIntake, currentView, answerIntake, buildContext, backIntake } from '../src/intake.js';
import { contextGoal, validatePatientState } from '../src/agent-state.js';
import { normalizeAnswerContext, normalizeAnswerField } from '../src/answer-sources.js';
import { sourceDocuments, retrieveSources, retrievedContext } from '../src/relationship-retrieval.js';
import { safetySources, agentContext, validateEvidence, canonicalRelationshipSelection } from '../src/relationship-agent.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const unknownLabel='잘 모르겠어요';
const reports=[
  '약 이름은 모르지만 어제 친구와 산책했다고 직접 들었어요.',
  '받아 본 치료는 모르지만 지금 자신을 해치겠다고 직접 말했어요.',
  '예전에 자해를 이야기했지만 지금은 그런 생각이 없다고 했어요.',
];
const absent=['',' \t\n ','\u200b\u2060\u200d\ufe0f\0','(건너뛰었어요)\u200b'];
const unknownIndex=question=>question.opts.findIndex(option=>(Array.isArray(option)?option[0]:option)===unknownLabel);
const reply=(state,input)=>{
  const q=currentView(state).question;
  return answerIntake(state,{question_id:q.id,follow_up:Boolean(q.follow_up),...input});
};
const defaultAnswer=q=>q.type==='text'
  ? (q.required||q.noSkip||q.follow_up ? {text:q.id==='name'?'합성 친구':'상대의 이야기를 차분하게 듣고 싶어요.'} : {skipped:true})
  : ['cause','support','burden','cgchange_more'].includes(q.id) ? {selected:[1]}
    : q.required||q.noSkip ? {selected:[0]} : {skipped:true};
function atHelp() {
  let state=createIntake();
  for(let step=0;step<60;step++) {
    const q=currentView(state).question;
    if(q?.id==='help'&&!q.follow_up)return state;
    assert.ok(q,'help must be reachable');
    state=reply(state,defaultAnswer(q));
  }
  throw new Error('help was not reached');
}

function assertEvidence(context,custom,selectedUnknown) {
  const field=context.patient.fields.help;
  assert.equal(field.custom,custom);
  assert.equal(field.selection_status,selectedUnknown?'unknown':undefined);
  const documents=sourceDocuments(context).filter(row=>row.question_id==='help');
  const retrieval=retrieveSources(context,{stage:'analysis'});
  const retrieved=retrieval.documents.filter(row=>row.question_id==='help');
  const source=safetySources(retrievedContext(context,retrieval)).find(row=>row.question_id==='help');
  const agent=agentContext(context).patient.find(row=>row.question_id==='help');
  const reference={subject:'patient',question_id:'help',quote:custom||unknownLabel};
  if(!custom) {
    assert.equal(field.status,'unknown');
    assert.deepEqual(documents,[]);assert.deepEqual(retrieved,[]);assert.equal(source,undefined);
    assert.equal(agent.safety_source_id,null);
    assert.throws(()=>validateEvidence(reference,context),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_evidence'});
    assert.throws(()=>validatePatientState({summary:'합성 확인',facts:[{...reference,interpretation:'확인된 도움',certainty:'reported'}],
      unknowns:[],user_goal:contextGoal(context)},context),{code:'MODEL_INVALID_RESPONSE'});
    return;
  }
  assert.equal(field.status,'answered');
  assert.ok(documents.some(row=>row.text===custom));
  assert.ok(retrieved.some(row=>row.text===custom));
  assert.ok(source.components.some(row=>row.text===custom));
  assert.equal(agent.selection_status,selectedUnknown?'unknown':undefined);
  assert.equal(agent.safety_source_id,source.id);
  assert.ok(agent.answers.some(row=>row.text===custom));
  assert.deepEqual(validateEvidence(reference,context),reference);
  assert.doesNotThrow(()=>validatePatientState({summary:'합성 확인',facts:[{...reference,interpretation:'직접 전한 내용',certainty:'reported'}],
    unknowns:['도움을 받은 방법 전체는 확인되지 않았어요.'],user_goal:contextGoal(context)},context));
  const relation=context.patient.fields.rel;
  const label=relation?.status==='answered'?relation.text:'확인되지 않음';
  const analysis=canonicalRelationshipSelection({
    observations:{patient:[reference],supporter:[]},
    relationship:{label,supporter_role:label,dynamics:[],strengths:[],boundaries:[]},
    unknowns:[],safety:{urgent:false,evidence_ids:[source.id]},
  },context,retrieval);
  assert.deepEqual(analysis.safety.evidence.map(ref=>ref.quote),[...new Set(source.components.map(row=>row.text))]);
  assert.equal(analysis.safety.urgent,false,'source availability must not decide urgency');
  assert.ok(analysis.patient_summary.includes(custom));
  if(selectedUnknown) {
    assert.deepEqual(field.selected.map(option=>option.label),[unknownLabel]);
    assert.ok(analysis.safety.evidence.some(ref=>ref.quote===`${unknownLabel}, ${custom}`),
      'full uncertainty, attribution, denial and direct input must travel together');
  }
}

test('unknown choices and direct input have separate evidence states, including corrections and invisible input',()=>{
  const original=atHelp(), index=unknownIndex(currentView(original).question);
  assert.ok(index>=0);
  for(const custom of reports) for(const selectedUnknown of [false,true]) {
    const state=reply(original,{selected:selectedUnknown?[index]:[],custom});
    assertEvidence(buildContext(state),custom,selectedUnknown);
    const corrected=reply(backIntake(state),{selected:[index]});
    assertEvidence(buildContext(corrected),'',true);
    assert.equal(JSON.stringify(sourceDocuments(buildContext(corrected))).includes(custom),false);
  }
  for(const custom of absent) assertEvidence(buildContext(reply(original,{selected:[index],custom})),'',true);
});

test('legacy read normalization repairs only explicit mixed unknown snapshots without changing stored originals',()=>{
  const original=atHelp(),custom=reports[0],index=unknownIndex(currentView(original).question);
  const stored=buildContext(reply(original,{selected:[index],custom}));
  stored.patient.fields.help.status='unknown';delete stored.patient.fields.help.selection_status;
  const before=structuredClone(stored),normalized=normalizeAnswerContext(stored);
  assertEvidence(normalized,custom,true);
  assert.deepEqual(stored,before);
  assert.deepEqual(normalizeAnswerContext(normalized),normalized);
  for(const invalidCustom of [...absent,undefined,null,7]) {
    assert.equal(normalizeAnswerField({...before.patient.fields.help,custom:invalidCustom}).status,'unknown');
  }
  assert.equal(normalizeAnswerField({...before.patient.fields.help,selected:[]}).status,'unknown');
  assert.equal(normalizeAnswerField({...before.patient.fields.help,selected:[{label:'다른 보기'}]}).status,'unknown');
  for(const status of ['skipped','refused','auto_skipped','not_asked']) {
    const field={...before.patient.fields.help,status};
    assert.equal(normalizeAnswerField(field),field);
  }
  assert.equal(normalizeAnswerField({...before.patient.fields.help,skipped:true}).status,'unknown');
});

// Minimal DOM surface for the real multi-choice event handlers. No browser
// rendering or visual E2E is claimed by this fixture.
function uiAnswer(question,{selected=[],custom=''}) {
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.value='';this.className='';
      this.classList={add:name=>{this.className+=' '+name;}};}
    appendChild(child){this.children.push(child);return child;}
    prepend(child){this.children.unshift(child);}
    setAttribute(name,value){this.attributes[name]=value;}
    getAttribute(name){return this.attributes[name];}
    set innerHTML(html){this.children=[];for(const match of html.matchAll(/<(input|textarea)[^>]*id="([^"]+)"[^>]*>/g)){
      const input=new Element(match[1]);input.id=match[2];this.children.push(input);}}
    querySelectorAll(selector){const matches=node=>selector.split(',').some(part=>part.startsWith('.')
      ?node.className.split(/\s+/).includes(part.slice(1)):node.tagName===part);
      return this.children.flatMap(node=>[...(matches(node)?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    click(){return this.onclick?.();}
    focus(){}
  }
  const root=new Element('div');root.id='input';
  const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean);
  const document={createElement:tag=>new Element(tag),getElementById:id=>find(root,id)};
  const sandbox=vm.createContext({document});
  const source=['core/utils.js','core/questions.js','components/ChatInput.js']
    .map(path=>readFileSync(new URL('../public/js/'+path,import.meta.url),'utf8')).join('\n');
  vm.runInContext(source+'\nglobalThis.ui=ChatInput;',sandbox);
  let submitted;
  sandbox.ui.render(question,(text,indices,own)=>{submitted={text,selected:Array.from(indices),custom:own};});
  for(const index of selected)root.querySelectorAll('.chip')[index].click();
  document.getElementById('own').value=custom;
  root.querySelector('.done').click();
  assert.ok(submitted,'real UI handler must submit the answer');
  // Keep the draft until the server confirms the answer and renders the next question.
  assert.equal(document.getElementById('own').value,custom);
  return submitted;
}

test('real multi-choice UI retains an unknown selection and meaningful direct input together',()=>{
  const question=currentView(atHelp()).question,index=unknownIndex(question);
  const answer=uiAnswer(question,{selected:[0,index],custom:reports[0]});
  assert.deepEqual(answer,{text:`${unknownLabel}, ${reports[0]}`,selected:[index],custom:reports[0]});
  for(const custom of absent)assert.equal(uiAnswer(question,{selected:[index],custom}).custom,'');
});

async function fixture(t) {
  const schema='mixed_answer_'+randomBytes(8).toString('hex');
  const admin=new pg.Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>app.server.close(resolve));await app.store.close().catch(()=>{});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  });
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(base+'/api/bootstrap');assert.equal(response.status,200);
  const bootstrap=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const owner=(await app.store.browser(cookie.slice(cookie.indexOf('=')+1))).id;
  const request=async(path,method='GET',input)=>{
    const response=await fetch(base+path,{method,headers:{cookie,'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'},
      ...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const help=async()=>{
    let response=await request('/api/intakes','POST',{conversation_epoch:bootstrap.conversation_epoch});
    assert.equal(response.status,201);let view=response.data;
    for(let step=0;step<60;step++) {
      if(view.question?.id==='help'&&!view.question.follow_up)return view;
      assert.equal(view.status,'active');const q=view.question;
      response=await request(`/api/intakes/${view.id}/answers`,'POST',{
        revision:view.revision,question_id:q.id,follow_up:Boolean(q.follow_up),...defaultAnswer(q)});
      assert.equal(response.status,200,JSON.stringify(response.data));view=response.data;
    }
    throw new Error('HTTP help was not reached');
  };
  return {...app,request,help,owner};
}

test('current UI → API → encrypted re-read keeps custom-only, mixed, risk and unknown-only evidence consistent',
  {skip:!databaseUrl},async t=>{
    const f=await fixture(t);
    for(const custom of [...reports,''])for(const selectedUnknown of custom?[false,true]:[true]) {
      const view=await f.help(),index=unknownIndex(view.question);assert.ok(index>=0);
      const input=uiAnswer(view.question,{selected:selectedUnknown?[index]:[],custom});
      const response=await f.request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,question_id:'help',...input});
      assert.equal(response.status,200,JSON.stringify(response.data));
      const reloaded=await f.request(`/api/intakes/${view.id}`);assert.equal(reloaded.status,200);
      assert.deepEqual(reloaded.data,response.data);
      const persisted=await f.store.intake(f.owner,view.id);
      assert.equal(persisted.state.ans.help.custom,custom);
      assert.equal(persisted.state.ans.help.rawText,input.text);
      const stored=await f.request(`/api/intakes/${view.id}/context`);assert.equal(stored.status,200);
      assertEvidence(stored.data.context,custom,selectedUnknown);
      if(selectedUnknown&&custom) {
        // Recreate the old encrypted status, then prove GET normalizes without
        // silently writing over the historical snapshot or its revision.
        const legacy=structuredClone(stored.data.context);
        legacy.patient.fields.help.status='unknown';delete legacy.patient.fields.help.selection_status;
        const revision=stored.data.revision;
        await f.store.pool.query('UPDATE patient_states SET content=$1 WHERE intake_id=$2 AND owner=$3',[
          f.store.seal(legacy,`${f.owner}:patient:${view.id}:${revision}`),view.id,f.owner]);
        const repaired=await f.request(`/api/intakes/${view.id}/context`);
        assert.equal(repaired.status,200);assert.equal(repaired.data.revision,revision);
        assertEvidence(repaired.data.context,custom,true);
        const row=(await f.store.pool.query('SELECT content FROM patient_states WHERE intake_id=$1',[view.id])).rows[0];
        assert.equal(f.store.open(row.content,`${f.owner}:patient:${view.id}:${revision}`).patient.fields.help.status,'unknown');
        if(custom===reports[0]) {
          const record={id:await f.store.nextRecordId(),date:new Date().toISOString(),context:legacy};
          await f.store.saveRecord(f.owner,record,view.id);
          assertEvidence((await f.store.record(f.owner,record.id)).context,custom,true);
          assertEvidence((await f.store.saveRecord(f.owner,record,view.id)).context,custom,true);
          const history=await f.request('/api/records');assert.equal(history.status,200);
          assertEvidence(history.data.records.find(row=>row.id===record.id).context,custom,true);
          const saved=(await f.store.pool.query('SELECT content FROM records WHERE id=$1',[record.id])).rows[0];
          assert.equal(f.store.open(saved.content,`${f.owner}:record:${record.id}`).context.patient.fields.help.status,'unknown');
        }
      }
    }
  });
