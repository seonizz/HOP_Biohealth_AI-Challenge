import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const source=path=>readFileSync(new URL(`../public/js/${path}`,import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const intakeId='11111111-2222-3333-4444-555555555555';
const view=(overrides={})=>({id:intakeId,revision:1,status:'active',log:[],question:{id:'concern',type:'text'},...overrides});
const storage=()=>{
  const data=new Map();
  return {get length(){return data.size;},key:index=>[...data.keys()][index]??null,
    getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
};

// This DOM executes the actual input callbacks; it never opens a browser.
class Element{
  constructor(tag,document){this.tagName=tag;this.document=document;this.children=[];this.attributes={};this.dataset={};this.className='';this.value='';this.style={};this.hidden=false;
    this.classList={contains:name=>this.className.split(/\s+/).includes(name),add:name=>{this.className+=` ${name}`;},remove:name=>{this.className=this.className.split(/\s+/).filter(value=>value!==name).join(' ');}};}
  appendChild(child){child.parent=this;this.children.push(child);return child;}
  prepend(child){child.parent=this;this.children.unshift(child);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  focus(){}
  close(){this.open=false;}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);if(name==='class')this.className=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  matches(selector){if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));return this.tagName===selector;}
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
  querySelectorAll(selector){const selectors=selector.split(','),found=[];const visit=node=>{for(const child of node.children){if(selectors.some(part=>child.matches(part)))found.push(child);visit(child);}};visit(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  click(){if(this.disabled)return;const event={target:this,type:'click'};const result=this.onclick?.(event);this.document.dispatch('click',event);return result;}
  set textContent(value){this.children=[];this.text=String(value);}
  get textContent(){return (this.text||'')+this.children.map(child=>child.textContent).join('');}
  set innerHTML(html){
    this.children=[];const stack=[this];
    for(const token of String(html).match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){stack.pop();continue;}
      const match=token.match(/^<([\w-]+)([^>]*)>/);if(!match)continue;
      const child=new Element(match[1],this.document);
      for(const attr of match[2].matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g))child.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??'');
      stack.at(-1).appendChild(child);if(!['input','img','br','hr'].includes(child.tagName))stack.push(child);
    }
  }
}
function fakeDocument(){
  const listeners=new Map(),roots=[];
  const document={hidden:false,addEventListener(type,listener){const list=listeners.get(type)||[];list.push(listener);listeners.set(type,list);},
    dispatch(type,event){for(const listener of listeners.get(type)||[])listener({...event,type});},
    listenerCount:type=>(listeners.get(type)||[]).length,createElement:tag=>new Element(tag,document),
    getElementById:id=>roots.flatMap(root=>[root,...root.querySelectorAll(`#${id}`)]).find(node=>node.id===id)||null,
    querySelectorAll:selector=>roots.flatMap(root=>[...(root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)])};
  document.body=new Element('body',document);
  for(const id of ['input','start','chat','result','records','about','columns','leaveDlg']){const node=new Element('div',document);node.id=id;roots.push(node);}
  return document;
}
async function draftHarness({saved=storage(),csrf='same-session',crypto=webcrypto,denied=false}={}){
  const document=fakeDocument(),listeners=new Map(),calls=[],screen={messages:[],sync(messages){this.messages=messages;},think(){},progress(){},title(){},section(){},typing:(_face,work)=>Promise.resolve(work())};
  const window={addEventListener(type,listener){listeners.set(type,listener);},scrollTo(){}};
  Object.defineProperty(window,'sessionStorage',{get(){if(denied)throw new Error('storage disabled');return saved;}});
  const context=vm.createContext({document,window,Element,crypto,TextEncoder,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,
    ChatScreen:screen,StartScreen:{updRecN(){}},API:{request:async()=>{throw new Error('unexpected API request');}},
    pendingConversationLog:()=>[],ConversationDrafts:undefined});
  vm.runInContext(source('core/utils.js')+source('core/questions.js')+source('components/ChatInput.js')+source('core/drafts.js')+
    '\nglobalThis.drafts=ConversationDrafts;globalThis.input=ChatInput;',context);
  await context.drafts.init(csrf);
  const render=next=>{context.input.render(next.question,(...args)=>calls.push(args));return context.drafts.restore(next);};
  const edit=(id,text)=>{const target=document.getElementById(id);target.value=text;document.dispatch('input',{target});};
  return {context,document,window,listeners,saved,calls,drafts:context.drafts,input:context.input,render,edit};
}

test('an unsent text answer survives a refresh in the same tab and session',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','아직 전송하지 않은 이야기');
  const refreshed=await draftHarness({saved:first.saved});
  assert.equal(refreshed.render(view()),true);assert.equal(refreshed.document.getElementById('ta').value,'아직 전송하지 않은 이야기');assert.equal(refreshed.calls.length,0);
});

test('drafts never cross intake, revision, question, or follow-up boundaries',async()=>{
  const fixture=await draftHarness();fixture.render(view());fixture.edit('ta','원래 질문의 초안');
  for(const changed of [view({id:'different'}),view({revision:2}),view({question:{id:'other',type:'text'}}),view({question:{id:'concern',type:'text',follow_up:true}})]){
    assert.equal(fixture.render(changed),false);assert.equal(fixture.document.getElementById('ta').value,'');
  }
});

test('multi-choice selections and custom input restore through real selection handlers',async()=>{
  const current=view({question:{id:'mood',type:'multi',opts:['불안','슬픔',['없음',{none:true}]]}});
  const first=await draftHarness();first.render(current);first.document.getElementById('input').querySelectorAll('.chip')[1].click();first.edit('own','잠들기 어려워요');
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(current),true);
  assert.deepEqual(plain(refreshed.input.captureDraft()),{text:'',own:'잠들기 어려워요',selected:[1],detailOption:null});
  refreshed.document.getElementById('input').querySelectorAll('.chip')[2].click();assert.deepEqual(plain(refreshed.input.captureDraft().selected),[2]);assert.equal(refreshed.calls.length,0);
});

test('one-choice detail input restores the selected branch without submitting',async()=>{
  const current=view({question:{id:'help',type:'one',opts:[['네',{input:true,ask:'어떤 도움이 필요할까요?'}],'아니요']}});
  const first=await draftHarness();first.render(current);first.document.getElementById('input').querySelectorAll('.chip')[0].click();first.edit('ta','사람을 만날 때 힘들어요');
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(current),true);
  assert.equal(refreshed.input.captureDraft().detailOption,0);assert.equal(refreshed.document.getElementById('ta').value,'사람을 만날 때 힘들어요');assert.equal(refreshed.calls.length,0);
  refreshed.document.getElementById('input').querySelector('.back').click();assert.equal(refreshed.document.getElementById('ta'),null);
  refreshed.document.getElementById('input').querySelectorAll('.chip')[0].click();assert.equal(refreshed.input.captureDraft().detailOption,0);
});

test('one-choice submitted selection is restored visually without clicking or submitting',async()=>{
  const fixture=await draftHarness();fixture.render(view({question:{id:'choice',type:'one',opts:['첫째','둘째']}}));
  fixture.input.restoreDraft({selected:[1],text:'',own:'',detailOption:null});
  assert.deepEqual(plain(fixture.input.captureDraft().selected),[1]);assert.equal(fixture.calls.length,0);
});

test('clearing a pending answer intentionally stays blank after refresh',async()=>{
  const pending=view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'이전 답변',follow_up:false}});
  const first=await draftHarness();first.render(pending);first.input.restoreDraft({text:'이전 답변'});first.edit('ta','');
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(pending),true);assert.equal(refreshed.document.getElementById('ta').value,'');
});

test('a loading or newly rendered input cannot overwrite an earlier question draft',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','로딩 전에 작성');first.input.clear();first.drafts.save();
  first.input.render({id:'other',type:'text'},()=>{});first.drafts.save();
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(view()),true);assert.equal(refreshed.document.getElementById('ta').value,'로딩 전에 작성');
});

test('pending recovery rebinds the current edited draft to its new revision',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','실패 뒤 수정한 내용');
  const pending=view({revision:2,model_pending:true});assert.equal(first.drafts.rebind(pending),true);
  assert.equal(first.drafts.entries[first.drafts.identity(view())],undefined);
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(pending),true);assert.equal(refreshed.document.getElementById('ta').value,'실패 뒤 수정한 내용');
});

test('pending rebind refuses other questions, follow-ups, intakes, and cleared input contexts',async()=>{
  const fixture=await draftHarness();fixture.render(view());fixture.edit('ta','이어질 초안');
  for(const other of [view({revision:2}),view({revision:2,model_pending:true,id:'other'}),view({revision:2,model_pending:true,question:{id:'other',type:'text'}}),view({revision:2,model_pending:true,question:{id:'concern',type:'text',follow_up:true}})])assert.equal(fixture.drafts.rebind(other),false);
  fixture.input.clear();assert.equal(fixture.drafts.rebind(view({revision:2,model_pending:true})),false);
});

test('refresh migrates edits only from the server-confirmed pending source revision',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','연결이 끊어진 동안 수정');
  const pending=view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',follow_up:false}});
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(pending),true);assert.equal(refreshed.document.getElementById('ta').value,'연결이 끊어진 동안 수정');
  assert.equal(refreshed.drafts.entries[refreshed.drafts.identity(view())],undefined);
});

test('pending source migration refuses mismatched question, follow-up, or revision',async()=>{
  for(const body of [{revision:1,question_id:'other'},{revision:1,question_id:'concern',follow_up:true},{revision:0,question_id:'concern'},{revision:3,question_id:'concern'}]){
    const first=await draftHarness();first.render(view());first.edit('ta','이전 초안');
    const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(view({revision:2,model_pending:true,pending_answer:body})),false);
  }
});

test('confirmed submission clearing prevents a removed draft from reappearing',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','전송한 내용');first.drafts.clear(view());first.drafts.save();
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(view()),false);
});

test('deleting one intake preserves another, and deleting all purges every draft',async()=>{
  const fixture=await draftHarness();fixture.render(view());fixture.edit('ta','첫 대화');fixture.render(view({id:'second'}));fixture.edit('ta','다른 대화');
  fixture.drafts.removeIntake(intakeId);assert.equal(fixture.render(view()),false);assert.equal(fixture.render(view({id:'second'})),true);
  fixture.drafts.clearAll();fixture.drafts.save();const refreshed=await draftHarness({saved:fixture.saved});assert.equal(refreshed.render(view({id:'second'})),false);
});

test('draft storage is per tab and purged when the authenticated session changes',async()=>{
  const first=await draftHarness({csrf:'secret-one'});first.render(view());first.edit('ta','다른 세션에 보이면 안 되는 내용');
  assert.doesNotMatch(first.saved.key(0),/secret-one/);
  const otherTab=await draftHarness();assert.equal(otherTab.render(view()),false);
  const changed=await draftHarness({saved:first.saved,csrf:'secret-two'});assert.equal(changed.render(view()),false);assert.equal(first.saved.length,1);
});

test('unavailable crypto or denied storage leaves ordinary input usable',async()=>{
  for(const options of [{crypto:{}},{denied:true}]){
    const fixture=await draftHarness(options);assert.equal(fixture.render(view()),false);fixture.edit('ta','입력은 계속 가능');fixture.drafts.save();assert.equal(fixture.document.getElementById('ta').value,'입력은 계속 가능');assert.equal(fixture.drafts.storageKey,null);
  }
});

test('expired drafts are discarded, saved text is bounded, and listeners bind once',async()=>{
  const fixture=await draftHarness();fixture.render(view());fixture.edit('ta','가'.repeat(21000));assert.equal(Object.values(fixture.drafts.entries)[0].draft.text.length,20000);
  Object.values(fixture.drafts.entries)[0].at=Date.now()-fixture.drafts.ttl-1;fixture.drafts.persist();assert.equal(Object.keys(fixture.drafts.entries).length,0);
  await fixture.drafts.init('same-session');assert.equal(fixture.document.listenerCount('input'),1);assert.equal(fixture.document.listenerCount('click'),1);
});

test('draft storage retains at most 32 recent questions',async()=>{
  const fixture=await draftHarness();
  for(let index=0;index<40;index++){fixture.render(view({revision:index}));fixture.edit('ta',`질문 ${index}`);}
  assert.equal(Object.keys(fixture.drafts.entries).length,32);
});

function attachConversation(fixture,request){
  fixture.context.API.request=request;
  vm.runInContext(source('core/conversation.js')+'\nglobalThis.flow={renderConversation,recoverConversation,pendingAnswerDraft,getState:()=>S};',fixture.context);
  return fixture.context.flow;
}

test('pending refresh restores the server answer and automatically resumes its saved request',async()=>{
  const fixture=await draftHarness(),calls=[];
  const flow=attachConversation(fixture,(path,options)=>{calls.push({path,options});return new Promise(()=>{});});
  const pending=view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'서버에 저장된 말',selected:[],custom:'',follow_up:false}});
  flow.renderConversation(pending,0);
  assert.equal(fixture.document.getElementById('ta').value,'서버에 저장된 말');
  assert.equal(calls.length,1);assert.equal(calls[0].path,`/api/intakes/${intakeId}/answers`);assert.equal(calls[0].options.body.revision,2);assert.equal(calls[0].options.body.text,'서버에 저장된 말');
});

test('pending refresh preserves a modified draft and never automatically submits the older answer',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','새로 수정한 말');
  const refreshed=await draftHarness({saved:first.saved}),calls=[];
  const flow=attachConversation(refreshed,(...args)=>{calls.push(args);return new Promise(()=>{});});
  flow.renderConversation(view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'이전에 전송한 말',selected:[],custom:'',follow_up:false}}),0);
  assert.equal(refreshed.document.getElementById('ta').value,'새로 수정한 말');assert.equal(calls.length,0);
  assert.match(refreshed.document.getElementById('input').querySelector('.api-error').textContent,/작성 중인 내용/);
});

test('an unchanged local pending draft automatically resumes without requiring a user retry',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','이전에 전송한 말');
  const refreshed=await draftHarness({saved:first.saved}),calls=[];
  const flow=attachConversation(refreshed,(...args)=>{calls.push(args);return new Promise(()=>{});});
  flow.renderConversation(view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'이전에 전송한 말',selected:[],custom:'',follow_up:false}}),0);
  assert.equal(calls.length,1);assert.equal(calls[0][1].body.text,'이전에 전송한 말');
});

test('network-error recovery associates further edits with the fetched pending revision',async()=>{
  const first=await draftHarness(),pending=view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'저장된 말',follow_up:false}});
  const flow=attachConversation(first,async path=>{assert.equal(path,`/api/intakes/${intakeId}`);return pending;});
  flow.renderConversation(view(),0);first.edit('ta','응답 실패 직후 고친 말');
  await flow.recoverConversation({status:0,message:'network disconnected'},0,()=>{});
  assert.equal(flow.getState().revision,2);first.edit('ta','복구 이후에도 수정한 말');
  const refreshed=await draftHarness({saved:first.saved});assert.equal(refreshed.render(pending),true);assert.equal(refreshed.document.getElementById('ta').value,'복구 이후에도 수정한 말');
});

function routerHarness(path='/'){
  const document=fakeDocument(),calls=[],listeners=new Map(),location={};
  const navigate=path=>{const url=new URL(path,'http://127.0.0.1:9000');Object.assign(location,{href:url.href,pathname:url.pathname,search:url.search});};navigate(path);
  const show=screen=>{for(const id of ['start','chat','result','records','about','columns'])document.getElementById(id).hidden=id!==screen;};show('start');
  const window={location,addEventListener:(type,listener)=>listeners.set(type,listener),history:{pushState:(_state,_title,path)=>{calls.push(['push',path]);navigate(path);},replaceState:(_state,_title,path)=>{calls.push(['replace',path]);navigate(path);}}};
  const context=vm.createContext({window,document,URL,URLSearchParams,S:null,resumingConversationId:null,curRec:null,conversationToken:0,
    SCREEN_IDS:['start','chat','result','records','about','columns'],COLUMNS:[{art:'first-article'}],$:id=>document.getElementById(id),
    ConversationDrafts:{save:()=>calls.push(['save'])},cancelConversationRequest:()=>calls.push(['cancel']),show,loadRecs:()=>[{id:7}],
    ColumnsScreen:{cur:null,filter:'전체',only:'',close(){this.cur=null;calls.push(['close']);},open(category){this.filter=category||'전체';show('columns');},draw(){},read(index){this.cur=index;}},
    AboutScreen:{open:()=>show('about')},RecordsScreen:{open:async id=>{context.curRec=id;show('records');}},
    resumeConversation:async id=>{calls.push(['resume',id]);context.S=view({id});show('chat');}});
  vm.runInContext(source('core/router.js')+'\nglobalThis.router=AppRouter;',context);context.router.init();
  return {context,router:context.router,calls,listeners,location,document,navigate};
}

test('conversation URLs contain only route and intake ID, never name or draft content',()=>{
  const fixture=routerHarness();fixture.context.S=view({name:'개인 이름',question:{id:'concern',type:'text'},draft:'비밀 초안'});
  assert.equal(fixture.router.path('chat'),`/chat/${intakeId}`);assert.equal(fixture.router.path('result'),`/result/${intakeId}`);
  fixture.router.sync('chat');assert.equal(fixture.location.pathname,`/chat/${intakeId}`);assert.doesNotMatch(fixture.location.href,/개인|이름|비밀|concern/);
});

test('refresh restoration resumes the exact intake encoded in its chat URL',async()=>{
  const fixture=routerHarness(`/chat/${intakeId}`);await fixture.router.restore();
  assert.ok(fixture.calls.some(call=>call[0]==='resume'&&call[1]===intakeId));assert.equal(fixture.document.getElementById('chat').hidden,false);
  assert.equal(fixture.calls[0][0],'save');assert.equal(fixture.location.pathname,`/chat/${intakeId}`);
});

test('result refresh resumes saved intake state and allows its actual status to choose the screen',async()=>{
  const fixture=routerHarness(`/result/${intakeId}`);
  fixture.context.resumeConversation=async id=>{fixture.context.S=view({id,status:'ready'});fixture.document.getElementById('start').hidden=true;fixture.document.getElementById('result').hidden=false;};
  await fixture.router.restore();assert.equal(fixture.location.pathname,`/result/${intakeId}`);
});

test('records, article selection, and article filters restore from their URLs',async()=>{
  const records=routerHarness('/records/7');await records.router.restore();assert.equal(records.context.curRec,7);assert.equal(records.location.pathname,'/records/7');
  const article=routerHarness('/columns/first-article?category=%EB%A7%88%EC%9D%8C&view=saved');await article.router.restore();
  assert.equal(article.context.ColumnsScreen.cur,0);assert.equal(article.context.ColumnsScreen.filter,'마음');assert.equal(article.context.ColumnsScreen.only,'saved');
});

test('invalid or malformed conversation URLs safely return to the start screen',async()=>{
  for(const path of ['/chat/not-an-id','/chat/%E0%A4%A','/result/'+intakeId+'/extra']){
    const fixture=routerHarness(path);await fixture.router.restore();assert.equal(fixture.location.pathname,'/');assert.equal(fixture.calls.some(call=>call[0]==='resume'),false);
  }
});

test('route restoration closes overlays before displaying the next screen',async()=>{
  const fixture=routerHarness('/about');fixture.context.ColumnsScreen.cur=0;fixture.document.getElementById('leaveDlg').open=true;
  await fixture.router.restore();assert.equal(fixture.context.ColumnsScreen.cur,null);assert.equal(fixture.document.getElementById('leaveDlg').open,false);assert.equal(fixture.document.getElementById('about').hidden,false);
});

test('a separate typing-ahead draft survives refresh and pending revision recovery',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','전송할 답변');
  first.input.waitForQuestion();first.edit('next-answer','다음 질문용 초안');
  const refreshed=await draftHarness({saved:first.saved});
  const pending=view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'전송할 답변',follow_up:false}});
  assert.equal(refreshed.render(pending),true);
  assert.equal(refreshed.document.getElementById('ta').value,'전송할 답변');
  assert.equal(refreshed.document.getElementById('next-answer').value,'다음 질문용 초안');
  assert.equal(refreshed.calls.length,0);
  refreshed.render(view({id:'another'}));assert.equal(refreshed.document.getElementById('next-answer'),null);
});

test('detail-input refresh retains the independently typed next answer',async()=>{
  const current=view({question:{id:'detail',type:'one',noOwn:true,opts:[['다른 이유',{input:true,ask:'자세히 알려 주세요'}]]}});
  const first=await draftHarness();first.render(current);first.input.openDraftDetail(0);
  first.edit('ta','상세 답변');first.input.waitForQuestion();first.edit('next-answer','다음 답변');
  const refreshed=await draftHarness({saved:first.saved});refreshed.render(current);
  assert.equal(refreshed.document.getElementById('ta').value,'상세 답변');
  assert.equal(refreshed.document.getElementById('next-answer').value,'다음 답변');
});

test('text typed while resuming a pending answer overrides an older typing-ahead draft',async()=>{
  const first=await draftHarness();first.render(view());first.edit('ta','저장한 답변');
  first.input.waitForQuestion();first.edit('next-answer','이전 초안');
  const refreshed=await draftHarness({saved:first.saved}),calls=[];
  const flow=attachConversation(refreshed,(path,options)=>{calls.push(options.body);return new Promise(()=>{});});
  flow.renderConversation(view({revision:2,model_pending:true,pending_answer:{revision:1,question_id:'concern',text:'저장한 답변',selected:[],custom:'',follow_up:false}}),0,'불러오는 중 새 초안');
  assert.equal(calls.length,1);assert.equal(calls[0].text,'저장한 답변');
  assert.equal(refreshed.document.getElementById('next-answer').value,'불러오는 중 새 초안');
  assert.equal(refreshed.input.captureDraft().nextText,'불러오는 중 새 초안');
});

test('choice-only drafts transfer into optional details and explicit carry updates an existing textarea',async()=>{
  const fixture=await draftHarness();fixture.render(view({question:{id:'detail',type:'one',noOwn:true,opts:[['직접 설명',{input:true}]]}}));
  fixture.input.acceptTypeAhead('이전 초안');fixture.input.acceptTypeAhead('새 초안');
  assert.equal(fixture.document.getElementById('next-answer').value,'새 초안');
  fixture.input.openDraftDetail(0);assert.equal(fixture.document.getElementById('ta').value,'새 초안');
});
