import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script=path=>readFileSync(new URL(`../public/js/${path}`,import.meta.url),'utf8');

function harness(){
  const nodes=new Map();
  const document={getElementById(id){
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,scrollTop:0});
    return nodes.get(id);
  }};
  const context=vm.createContext({
    document,window:{},navigator:{clipboard:{writeText:async()=>{}}},
    M:{cheer:'cheer.png',empathy:'empathy.png',think:'think.png'},
    CrisisLine:text=>`<div class="crisis">${text}</div>`,
    StartScreen:{updRecN(){}},ColumnsScreen:{open(){}},
  });
  vm.runInContext(script('core/utils.js')+script('components/GuideCards.js')+script('components/ResultScreen.js')+script('components/RecordsScreen.js')+'\nglobalThis.cards=GuideCards;globalThis.result=ResultScreen;globalThis.records=RecordsScreen;',context);
  context.result.animate=()=>{};
  return {context,document};
}

const guide={top:'통합',care:{feel:'당신의 마음도 소중해요.',tips:['잠시 쉬어요.','혼자 감당하지 않아도 돼요.']},script:'곁에 있을게요.',doList:['먼저 들어 주세요.'],avoid:['서두르지 마세요.'],next:'안부를 물어보세요.'};
const profile={name:'친구',rel:'친구',safety:false};
const entry=(interpretation,certainty='reported')=>({interpretation,certainty,evidence:[{subject:'supporter',question_id:'burden',quote:'지금은 잠시 쉬고 싶어요.'}]});
const analysis={
  patient_summary:'최근 연락이 뜸해졌다고 들려주셨어요.',supporter_summary:'곁에 있고 싶지만 지친 마음도 들려주셨어요.',
  relationship:{label:'서로 소중한 친구',supporter_role:'안부를 묻는 친구',dynamics:[entry('대화할 시간에 차이가 있을 수 있어요.','tentative')],strengths:[entry('안부를 꾸준히 묻고 있어요.')],boundaries:[entry('답장을 기다리는 동안 쉴 시간도 필요해요.')]},
  unknowns:['그분이 편하게 느끼는 연락 방식은 아직 알기 어려워요.'],safety:{urgent:false,evidence:[]},
};

test('relationship analysis and its quoted evidence are collapsed and distinguish facts from tentative interpretations',()=>{
  const {context}=harness();
  const html=context.cards.relationship(analysis);
  assert.match(html,/<details class="card relationship">/);
  assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
  for(const heading of ['함께 살펴본 관계','들려주신 내용을 바탕으로 살펴봤어요.','그분의 상황','당신의 마음','관계 특징','관계의 강점','서로의 한계','아직 알기 어려운 부분','근거로 살펴본 답변','아직 확인이 필요해요.'])assert.ok(html.includes(heading),heading);
  assert.ok(html.includes(analysis.relationship.boundaries[0].evidence[0].quote));
  assert.equal(context.cards.relationship(undefined),'');
  assert.equal(context.cards.relationship(null),'');
});

test('every generated sentence and original quote is escaped before HTML rendering',()=>{
  const {context}=harness();
  const unsafe='<img src=x onerror="alert(1)"> & 이야기';
  const data={...analysis,patient_summary:unsafe,supporter_summary:unsafe,unknowns:[unsafe],relationship:{label:unsafe,supporter_role:unsafe,...Object.fromEntries(['dynamics','strengths','boundaries'].map(key=>[key,[{interpretation:unsafe,certainty:'tentative',evidence:[{subject:'patient',question_id:unsafe,quote:unsafe}]}]]))}};
  const html=context.cards.relationship(data);
  assert.doesNotMatch(html,/<img\b|<script\b|onerror="/);
  assert.equal(html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; 이야기/g)?.length,11);
  assert.ok(html.includes('그분에 대해 들려주신 말'));
});

test('results keep the existing five guide cards and crisis guidance with optional analysis',()=>{
  const {context,document}=harness();
  context.result.open({...profile,safety:true},guide,true,analysis);
  const html=document.getElementById('rbody').innerHTML;
  for(const heading of ['당신의 마음도 소중해요','이렇게 시작해 보세요','이렇게 해 보세요','피하면 좋아요','다음 단계','대화보다 안전이 먼저예요','109','1577-0199','함께 살펴본 관계'])assert.ok(html.includes(heading),heading);
  assert.ok(html.includes('통합 안내'));
  assert.doesNotMatch(html,/통합 경향/);
  context.result.open(profile,guide,true);
  assert.ok(document.getElementById('rbody').innerHTML.includes('이렇게 시작해 보세요'));
  assert.ok(!document.getElementById('rbody').innerHTML.includes('함께 살펴본 관계'));
});

test('saved records display optional analysis and older records remain readable',()=>{
  const {context,document}=harness();
  const record={title:'친구 기록',date:'2026-10-11T00:00:00Z',profile,guide,log:[{who:'me',text:'친구가 걱정돼요.'}],relationship_analysis:analysis};
  context.records.renderDetail(record);
  let html=document.getElementById('rdetail').innerHTML;
  assert.match(html,/<details class="card relationship" style="margin-top:18px;background:var\(--bg\)">/);
  assert.ok(html.includes('대화 기록'));
  delete record.relationship_analysis;context.records.renderDetail(record);
  html=document.getElementById('rdetail').innerHTML;
  assert.ok(!html.includes('함께 살펴본 관계'));
  assert.ok(html.includes('친구가 걱정돼요.'));
});

test('finishing passes saved relationship analysis to the result screen',async()=>{
  const record={profile,guide,relationship_analysis:analysis};let shown;
  const context=vm.createContext({
    API:{request:async()=>({revision:2,record})},
    ChatInput:{clear(){}},ChatScreen:{think(){},thinkStep(){}},
    rememberRec(){},ResultScreen:{open(...args){shown=args;}},
  });
  vm.runInContext(script('core/conversation.js')+'\nS={id:"intake-1",revision:1};',context);
  await context.finish();
  assert.equal(shown[0],profile);assert.equal(shown[1],guide);assert.equal(shown[2],true);assert.equal(shown[3],analysis);
});
