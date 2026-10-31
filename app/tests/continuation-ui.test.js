import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const source=name=>readFileSync(new URL(`../public/js/${name}`,import.meta.url),'utf8');
const id='11111111-2222-4333-8444-555555555555';
const row=(patch={})=>({id,source_record_id:'9',revision:0,status:'active',messages:[],pending:null,summary:null,cards:[],...patch});
const plain=value=>JSON.parse(JSON.stringify(value));
const guide={top:'통합',care:{feel:'잠시 쉬어도 괜찮아요.',tips:['숨을 고르세요.']},script:'편할 때 이야기해 줄래?',doList:['먼저 듣기'],avoid:['서두르기'],next:'시간을 정해 보세요.'};
const card={id:'card-1',date:'2026-11-01T00:00:00Z',profile:{safety:false},guide,relationship_analysis:{relationship:{label:'친구'}}};
function harness(request=async()=>({continuation:row()}),saved=new Map()){
  const nodes=new Map(),calls=[];
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,hidden:id==='continuation',innerHTML:'',textContent:'',value:'',dataset:{},disabled:false,focus(){this.focused=true;},close(){},querySelectorAll(){return [];},querySelector(){return null;}});
    return nodes.get(id);
  };
  const context=vm.createContext({
    crypto:webcrypto,AbortController,URL,URLSearchParams,Date,Map,
    document:{getElementById:node,body:{classList:{remove(){}}}},window:{},
    navigator:{clipboard:{writeText:async()=>{}}},
    sessionStorage:{get length(){return saved.size;},key:index=>[...saved.keys()][index]||null,getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    API:{request:async(path,options={})=>{calls.push({path,options:plain({...options,signal:undefined})});return request(path,options);}},
    ConversationDrafts:{storageKey:'synthetic-session',save(){}},
    conversationEpoch:4,M:{hear:'hear.png',think:'think.png',empathy:'empathy.png'},
    NavBar:()=>'',CrisisLine:()=>'',StartScreen:{updRecN(){}},
    RecordsScreen:{open:async recordId=>{calls.push({recordId});node('continuation').hidden=true;}},
    AppRouter:{sync(){}},ColumnsScreen:{open(){}},
  });
  vm.runInContext(['core/utils.js','components/GuideCards.js','components/ContinuationScreen.js'].map(source).join('\n')+'\nglobalThis.screen=ContinuationScreen;globalThis.cards=GuideCards;',context);
  context.screen.mount();node('continuation').hidden=false;context.screen.accept(row());context.screen.draw();
  return {context,screen:context.screen,node,calls,saved};
}
const answer='어떻게 말하면 좋을까요?';

test('free question submits without a clarification ID and preserves typing ahead',async()=>{
  let release;
  const h=harness(async(path,options)=>{
    if(path.endsWith('/messages'))return new Promise(resolve=>release=resolve);
    return {continuations:[]};
  });
  h.node('continuationText').value=answer;h.node('continuationText').oninput();
  const pending=h.node('continuationForm').onsubmit({preventDefault(){}});
  assert.equal(h.calls[0].path,`/api/continuations/${id}/messages`);
  assert.equal(h.calls[0].options.body.text,answer);
  assert.equal(h.calls[0].options.body.reply_to,undefined);
  assert.equal(h.calls[0].options.body.revision,0);
  assert.equal(h.node('continuationWaiting').hidden,false);
  h.node('continuationText').value='다음에 물어볼 말';h.node('continuationText').oninput();
  release({continuation:row({revision:2,messages:[{id:'u1',role:'user',text:answer},{id:'a1',role:'assistant',text:'편한 시간을 물어보세요.'}]})});
  await pending;
  assert.equal(h.node('continuationText').value,'다음에 물어볼 말');
  assert.equal(h.node('continuationWaiting').hidden,true);
  assert.equal(h.node('continuationSend').disabled,false);
});

test('optional clarification can be skipped without inventing an answer',async()=>{
  const h=harness(async(path)=>path.endsWith('/messages')?{continuation:row({revision:2})}:{continuations:[]});
  h.screen.accept(row({messages:[{id:'a1',role:'assistant',text:'편한 방법부터 생각해 볼게요.',clarification:'어떤 방법이 편할까요?'}]}));h.screen.draw();
  assert.equal(h.node('continuationSkip').hidden,false);
  await h.node('continuationSkip').onclick();
  const input=h.calls[0].options.body;
  assert.equal(input.skipped,true);assert.equal(input.text,'');assert.equal(input.reply_to,'a1');
});

test('network failure restores input and retries the same request ID at recovered revision',async()=>{
  let attempts=0;
  const h=harness(async(path,options)=>{
    if(path.endsWith('/messages')){
      if(++attempts===1)throw Object.assign(new Error('연결이 끊겼어요.'),{status:0});
      return {continuation:row({revision:2,messages:[{id:'u1',role:'user',text:answer}]})};
    }
    if(path===`/api/continuations/${id}`)return {continuation:row({revision:1,pending:{action:'messages',request_id:h.calls[0].options.body.request_id,input:{text:answer}}})};
    return {continuations:[]};
  });
  h.node('continuationText').value=answer;h.node('continuationText').oninput();await h.screen.send();
  assert.equal(h.node('continuationText').value,answer);
  assert.equal(h.node('continuationRetry').hidden,false);
  await h.node('continuationRetry').onclick();
  const submits=h.calls.filter(call=>call.path.endsWith('/messages'));
  assert.equal(submits.length,2);assert.equal(submits[0].options.body.request_id,submits[1].options.body.request_id);
  assert.equal(submits[1].options.body.revision,1);
  assert.equal(h.node('continuationText').value,'');
});

test('refresh restores pending operation for an explicit retry and never auto-submits a draft',async()=>{
  const h=harness(async path=>path===`/api/continuations/${id}`?{continuation:row({revision:3,pending:{action:'messages',request_id:'pending-request',input:{text:answer}}})}:{continuations:[]});
  await h.screen.open(id);
  assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
  assert.equal(h.screen.retryAction.action,'messages');
  assert.equal(h.screen.retryAction.body.request_id,'pending-request');
  assert.equal(h.node('continuationRetry').hidden,false);
});

test('correction identifies the user message and preserves the exact replacement',async()=>{
  const h=harness(async path=>path.endsWith('/corrections')?{continuation:row({revision:3,messages:[]})}:{continuations:[]});
  h.screen.accept(row({revision:2,messages:[{id:'u1',role:'user',text:'어제 만났어요.'}]}));h.screen.correct('u1');
  assert.equal(h.node('continuationText').value,'어제 만났어요.');
  h.node('continuationText').value='  지난주 만났어요.  ';h.node('continuationText').oninput();await h.screen.send();
  assert.equal(h.calls[0].path,`/api/continuations/${id}/corrections`);
  assert.equal(h.calls[0].options.body.answer_ref,'u1');assert.equal(h.calls[0].options.body.replacement,'  지난주 만났어요.  ');
  assert.equal(h.screen.editing,null);
});

test('new card action uses saved user facts and reuses all original card renderers',async()=>{
  const original=plain(card);
  const h=harness(async path=>path.endsWith('/cards')?{continuation:row({revision:2,messages:[{id:'u1',role:'user',text:'오늘 만났어요.'}],cards:[card]}),card}:{continuations:[]});
  h.screen.accept(row({messages:[{id:'u1',role:'user',text:'오늘 만났어요.'}]}));h.screen.draw();
  assert.equal(h.node('continuationCards').disabled,false);
  await h.node('continuationCards').onclick();
  assert.equal(h.calls[0].path,`/api/continuations/${id}/cards`);
  const html=h.node('continuationCardsList').innerHTML;
  for(const text of ['당신의 마음도 소중해요','이렇게 시작해 보세요','문장 복사','two guide-actions','피하면 좋아요','함께 살펴본 관계'])assert.ok(html.includes(text),text);
  assert.deepEqual(card,original);
  assert.ok(html.includes(h.context.cards.speech(guide,undefined,{copy:true,ids:false})));
  assert.ok(html.includes(h.context.cards.doAvoid(guide)));
});

test('stored card snapshots and summary reopen without a new model request',async()=>{
  const h=harness(async path=>path===`/api/continuations/${id}`?{continuation:row({status:'completed',cards:[card],summary:'잠시 쉬기로 했어요.'})}:{continuations:[]});
  await h.screen.open(id);
  assert.equal(h.node('continuationForm').hidden,true);
  assert.match(h.node('continuationCardsList').innerHTML,/편할 때 이야기해 줄래/);
  assert.match(h.node('continuationSummary').innerHTML,/잠시 쉬기로/);
  assert.equal(h.calls.every(call=>!call.options.method),true);
});

test('late response after navigation cannot display or replace the active session',async()=>{
  let release;
  const h=harness(async()=>new Promise(resolve=>release=resolve));
  h.node('continuationText').value=answer;h.node('continuationText').oninput();const pending=h.screen.send();
  h.screen.leave();h.node('continuation').hidden=true;
  release({continuation:row({revision:2,messages:[{role:'assistant',text:'늦은 답변'}]})});await pending;
  assert.equal(h.screen.row.revision,0);
  assert.doesNotMatch(h.node('continuationLog').innerHTML,/늦은 답변/);
});

test('deletion requires a second click, clears tab draft, and returns to the original record',async()=>{
  const h=harness(async()=>({deleted:true}));h.screen.draft='보내지 않은 내용';h.screen.saveDraft();
  await h.screen.remove();assert.equal(h.calls.length,0);
  await h.screen.remove();assert.equal(h.calls[0].options.method,'DELETE');assert.equal(h.calls[0].path,`/api/continuations/${id}`);
  assert.equal(h.calls[1].recordId,9);assert.equal(h.screen.drafts()[id],undefined);
});

test('user text, assistant text, clarification, and summary are escaped',()=>{
  const h=harness(),unsafe='<img src=x onerror="alert(1)">';
  h.screen.accept(row({messages:[{id:'u1',role:'user',text:unsafe},{id:'a1',role:'assistant',text:unsafe,clarification:unsafe}],summary:unsafe}));h.screen.draw();
  for(const name of ['continuationLog','continuationSummary']){
    const html=h.node(name).innerHTML;assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
  }
});

test('completed safety session keeps input closed and renders existing safety card',()=>{
  const h=harness();h.screen.accept(row({status:'completed',safety_urgent:true}));h.screen.draw();
  assert.equal(h.node('continuationForm').hidden,true);
  assert.ok(h.node('continuationSummary').innerHTML.includes(h.context.cards.safety()));
});

test('drafts restore only in the same session and are removed with their source record',async()=>{
  const saved=new Map(),first=harness(undefined,saved);first.screen.draft='비공개 초안';first.screen.saveDraft();
  const same=harness(undefined,saved);same.screen.accept(row(),true);assert.equal(same.screen.draft,'비공개 초안');
  same.context.ConversationDrafts.storageKey='another-session';same.screen.accept(row(),true);assert.equal(same.screen.draft,'');
  first.screen.accept(row({id:'another-continuation',source_record_id:'10'}));first.screen.draft='다른 기록 초안';first.screen.saveDraft();first.screen.forget(9);
  assert.equal(first.screen.drafts()[id],undefined);assert.equal(first.screen.drafts()['another-continuation'].text,'다른 기록 초안');
});

test('owned results and records offer additional questions, shared read-only records do not',()=>{
  const h=harness();h.context.show=()=>{};
  vm.runInContext(source('components/ResultScreen.js')+source('components/RecordsScreen.js')+'\nglobalThis.result=ResultScreen;globalThis.records=RecordsScreen;',h.context);
  h.context.result.animate=()=>{};
  h.context.result.open({name:'친구'},guide,true,undefined,undefined,9);
  assert.match(h.node('rbody').innerHTML,/id="resultContinue"/);
  const record={id:9,title:'친구',date:card.date,profile:{},guide,log:[]};
  h.context.records.renderDetail(record);assert.match(h.node('rdetail').innerHTML,/id="recordContinue"/);
  h.context.records.renderDetail(record,true);assert.doesNotMatch(h.node('rdetail').innerHTML,/id="recordContinue"/);
});

test('continuation URL uses only the opaque ID and restores the selected session',async()=>{
  const h=harness();let opened;
  h.context.window.location=new URL(`http://synthetic.local/continuations/${id}`);
  h.context.window.addEventListener=()=>{};h.context.window.history={replaceState(){},pushState(){}};
  h.context.cancelConversationRequest=()=>{};h.context.conversationToken=0;h.context.resumingConversationId=null;
  h.context.ColumnsScreen={cur:null};h.context.screen.open=async value=>{opened=value;};
  vm.runInContext(source('core/router.js')+'\nglobalThis.router=AppRouter;',h.context);
  assert.equal(h.context.router.path('continuation'),`/continuations/${id}`);
  assert.deepEqual(plain(h.context.router.parse()),{screen:'continuation',id});
  await h.context.router.restore();assert.equal(opened,id);
});

test('unsent new details cannot silently be omitted from new cards or completion',async()=>{
  const h=harness();h.screen.accept(row({messages:[{id:'u1',role:'user',text:'이전 상황'}]}));
  h.screen.draft='아직 보내지 않은 새 상황';
  await h.screen.perform('cards');assert.equal(h.calls.length,0);assert.match(h.node('continuationNotice').textContent,/먼저 보내면/);
  await h.screen.finish();assert.equal(h.calls.length,0);assert.match(h.node('continuationNotice').textContent,/아직 보내지 않은/);
});

test('pending user input can be corrected rather than requiring the old retry',async()=>{
  const h=harness(async path=>path.endsWith('/corrections')?{continuation:row({revision:3})}:{continuations:[]});
  h.screen.accept(row({revision:1,pending:{action:'messages',request_id:'old-request',input:{text:'이전 설명'}},messages:[{id:'u1',role:'user',text:'이전 설명'}]}));
  h.screen.correct('u1');assert.equal(h.node('continuationSend').disabled,false);
  h.node('continuationText').value='정정한 설명';await h.screen.send();
  assert.equal(h.calls[0].path,`/api/continuations/${id}/corrections`);
});

test('completion during generation cancels that subscription and uses latest saved revision',async()=>{
  let release;
  const h=harness(async path=>{
    if(path.endsWith('/messages'))return new Promise(resolve=>release=resolve);
    if(path.endsWith('/complete'))return {continuation:row({revision:3,status:'completed'})};
    if(path===`/api/continuations/${id}`)return {continuation:row({revision:1,pending:{action:'messages',request_id:'old-request',input:{text:answer}}})};
    return {continuations:[]};
  });
  h.node('continuationText').value=answer;h.node('continuationText').oninput();const sending=h.screen.send();
  await h.screen.finish();
  assert.equal(h.screen.row.status,'completed');
  assert.equal(h.calls.find(call=>call.path.endsWith('/complete')).options.body.revision,1);
  release({continuation:row({revision:2,messages:[{role:'assistant',text:'늦은 답변'}]})});await sending;
  assert.equal(h.screen.row.status,'completed');
});


test('continuation draft namespace survives original-draft initialization and purges old sessions',()=>{
  const h=harness();h.context.ConversationDrafts.storageKey='malssi.conversation-drafts.v1.current';
  assert.equal(h.screen.draftKey(),'malssi.continuation-drafts.v1.current');
  h.saved.set('malssi.continuation-drafts.v1.previous','private');
  h.saved.set(h.screen.draftKey(),'{}');h.saved.set('malssi.conversation-drafts.v1.current','{}');
  h.screen.purgeDrafts();
  assert.equal(h.saved.has('malssi.continuation-drafts.v1.previous'),false);
  assert.equal(h.saved.has(h.screen.draftKey()),true);
  assert.equal(h.saved.has('malssi.conversation-drafts.v1.current'),true);
});
