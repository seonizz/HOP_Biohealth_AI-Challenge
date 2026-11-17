import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=path=>readFileSync(new URL(`../public/js/${path}`,import.meta.url),'utf8');
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.hidden=false;this.listeners={};this._text='';}
  appendChild(child){child.remove();this.children.push(child);child.parent=this;return child;}
  before(child){child.remove();this.parent.children.splice(this.parent.children.indexOf(this),0,child);child.parent=this.parent;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  setAttribute(name,value){this[name]=value;if(name==='class')this.className=value;}
  addEventListener(name,listener){this.listeners[name]=listener;}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(html){
    this.children=[];this._text='';const stack=[this];
    for(const token of String(html).match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){stack.pop();continue;}
      if(!token.startsWith('<')){stack.at(-1)._text+=token;continue;}
      const match=token.match(/^<([\w-]+)([^>]*)>/);if(!match)continue;
      const child=new Element(match[1]);
      for(const attr of match[2].matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g))child.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??'');
      stack.at(-1).appendChild(child);if(!['img','input','br','hr'].includes(child.tagName))stack.push(child);
    }
  }
  find(className){return this.className===className?this:this.children.map(child=>child.find(className)).find(Boolean);}
  all(tag){return [...(this.tagName===tag?[this]:[]),...this.children.flatMap(child=>child.all(tag))];}
  querySelector(selector){return this.children.map(child=>selector.startsWith('.')&&child.className?.split(/\s+/).includes(selector.slice(1))?child:child.querySelector(selector)).find(Boolean)||null;}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const view=(revision=2)=>({id:'synthetic-intake',revision,status:'ready',referral_available:true,model_pending:false,log:[{who:'me',text:'이름'},{who:'me',text:'관찰'}]});
const response=(overrides={})=>({revision:2,status:'needs_review',assessment:{urgency:'immediate'},safety_alert:null,preserved_safety_alert:null,
  presentation:{display_name:'불씨',asset_path:null},guidance:{message:'  개발자가 정한 문장\n그대로 <말해요> & 안내  ',urgency:'immediate',urgent:true,institutions:[{name:'등록 기관',actions:[{kind:'phone',href:'tel:0000000000'}]}]},...overrides});
function harness(request=async()=>response(),screen='result'){
  const nodes=Object.fromEntries(['app','chat','input','result','rbody'].map(id=>[id,new Element('div')]));
  nodes.app.appendChild(nodes.chat);nodes.app.appendChild(nodes.result);nodes.chat.appendChild(nodes.input);nodes.result.appendChild(nodes.rbody);nodes.result.hidden=true;
  const document={createElement:tag=>new Element(tag),getElementById:id=>{
    const find=node=>node.id===id?node:node.children.map(find).find(Boolean);
    return nodes[id]||Object.values(nodes).map(find).find(Boolean);
  }};const calls=[];
  const context=vm.createContext({document,URL,encodeURIComponent,API:{request:(...args)=>{calls.push(args);return request(...args);}},S:view()});
  vm.runInContext('const $=id=>document.getElementById(id);\n'+script('components/ReferralGuide.js')+'\nglobalThis.guide=ReferralGuide;',context);
  const guide=context.guide;guide.mount();guide.navigate(screen);nodes.chat.hidden=screen!=='chat';nodes.result.hidden=screen!=='result';
  return{context,guide,nodes,calls};
}

test('confirmed current revision automatically renders exact preset with explicit links and text-only character',async()=>{
  const {guide,calls}=harness();await guide.observe(view());
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/intakes/synthetic-intake/guidance');assert.equal(calls[0][1].body.revision,2);
  assert.equal(guide.root.find('referral-message').textContent,response().guidance.message);
  assert.equal(guide.root.find('referral-name').textContent,'불씨');assert.equal(guide.root.all('img').length,0);
  assert.equal(guide.root.all('a')[0].href,'tel:0000000000');assert.equal(guide.root.all('a')[0].onclick,undefined);
});

test('unvalidated pending, name-only, or unavailable observations do not invoke model or show warning',async()=>{
  const {guide,calls}=harness();
  for(const state of [{...view(),model_pending:true,referral_available:false},{...view(),referral_available:false},{id:'synthetic-intake',revision:0}])await guide.observe(state);
  assert.equal(calls.length,0);assert.equal(guide.root.hidden,true);
});

test('same revision is deduplicated while pending and after completion',async()=>{
  const result=deferred();const {guide,calls}=harness(()=>result.promise);
  const pending=guide.observe(view()),repeated=guide.observe(view());assert.equal(calls.length,1);
  result.resolve(response());await Promise.all([pending,repeated]);await guide.observe(view());assert.equal(calls.length,1);
});

test('older answer cannot overwrite a new confirmed revision',async()=>{
  const old=deferred();const {context,guide}=harness((path,options)=>options.body.revision===2?old.promise:Promise.resolve(response({revision:3,guidance:{...response().guidance,message:'새 문구'}})));
  const pending=guide.observe(view());context.S=view(3);await guide.observe(context.S);old.resolve(response());await pending;
  assert.equal(guide.root.find('referral-message').textContent,'새 문구');
});

test('late response cannot restore after draft edit, back/delete invalidation, navigation or new intake',async()=>{
  for(const action of ['draft','invalidate','navigate','chat','new']){
    const result=deferred();const {guide,nodes,context}=harness(()=>result.promise);const pending=guide.observe(view());
    if(action==='draft')nodes.input.listeners.input();
    if(action==='invalidate')guide.invalidate();
    if(action==='navigate')guide.navigate('records');
    if(action==='chat')guide.navigate('chat');
    if(action==='new'){context.S={...view(),id:'new-intake'};guide.invalidate();}
    result.resolve(response());await pending;assert.equal(guide.root.hidden,true,action);
  }
});

test('leaving results hides delayed model failures instead of showing a chat retry card',async()=>{
  for(const screen of ['chat','records','start']){
    const result=deferred();const {guide}=harness(()=>result.promise);
    const pending=guide.observe(view());guide.navigate(screen);result.reject(new Error('late failure'));await pending;
    assert.equal(guide.root.hidden,true,screen);assert.equal(guide.root.textContent,'',screen);
  }
});

test('mutating shared state at finish cannot accept the old revision response',async()=>{
  const result=deferred();const {guide,context}=harness(()=>result.promise);const pending=guide.observe(context.S);
  context.S.revision=3;guide.navigate('result');result.resolve(response());await pending;assert.equal(guide.root.hidden,true);
});

test('latest result revision is assessed and remains in the actual result screen',async()=>{
  const {guide,context,nodes,calls}=harness(async(path,options)=>response({revision:options.body.revision}));await guide.observe(context.S);
  context.S.revision=3;guide.navigate('result');await guide.observe(context.S);
  assert.equal(calls.length,2);assert.equal(calls[1][1].body.revision,3);assert.equal(guide.root.parent,nodes.result);assert.equal(guide.root.hidden,false);
});

test('active conversation never requests or displays Bulssi, even with saved safety evidence',async()=>{
  const {guide,calls}=harness(async()=>response(),'chat');
  for(const state of [view(),{...view(),status:'active'},{...view(),model_pending:true}])await guide.observe(state);
  guide.draw(response(),()=>{});assert.equal(guide.root.hidden,true);
  guide.drawUnavailable(()=>{});assert.equal(guide.root.hidden,true);
  assert.equal(calls.length,0);assert.equal(guide.root.textContent,'');
});

test('planned or undetermined urgency alone does not create a final counseling card',async()=>{
  for(const urgency of ['planned','undetermined']){
    const {guide}=harness(async()=>response({assessment:{urgency},guidance:{...response().guidance,urgency,urgent:false}}));
    await guide.observe(view());assert.equal(guide.root.hidden,true,urgency);
    guide.draw(response({assessment:{urgency},guidance:{...response().guidance,urgency,urgent:false,concerns:[{subject:'patient',reason:'근거 없음',quotes:[]}]} }),()=>{});
    assert.equal(guide.root.hidden,true,`${urgency}: no original quotation`);
  }
});

test('model-selected concerns can offer counseling without assigning a determined urgency',async()=>{
  const data=response({assessment:{urgency:'undetermined'},guidance:{...response().guidance,urgency:'undetermined',urgent:false,
    concerns:[{subject:'supporter',code:'mental_health_concern',reason:'전해 주신 마음의 어려움을 함께 살펴볼 수 있어요.',quotes:[{question_id:'describe',text:'합성 상담 우려'}]}]}});
  const {guide}=harness(async()=>data);await guide.observe(view());
  assert.equal(guide.root.hidden,false);assert.equal(guide.root.all('blockquote').length,1);
});

test('final card appears only after chat and adds exact originals and reasons inside result cards',async()=>{
  const quote='  합성 원문 <script>실행하지 않음</script>\n뒤의 부정·조건도 그대로 보존해요.  ';
  const reason='전해 주신 어려움을 전문가와 함께 살펴보면 도움이 될 수 있어요.';
  const data=response({assessment:{urgency:'planned'},guidance:{...response().guidance,urgency:'planned',urgent:false,
    concerns:[{subject:'patient',code:'mental_health_concern',reason,quotes:[{question_id:'describe',text:quote}]}]}});
  const {guide,nodes,calls}=harness(async()=>data,'chat');await guide.observe(view());
  assert.equal(calls.length,0);assert.equal(guide.root.hidden,true);
  const cards=new Element('div');cards.className='cards';nodes.rbody.appendChild(cards);
  const actions=new Element('div');actions.className='actions';cards.appendChild(actions);
  guide.navigate('result');await guide.observe(view());
  assert.equal(calls.length,1);assert.equal(guide.root.parent,cards);
  assert.equal(cards.children.indexOf(guide.root),cards.children.indexOf(actions)-1);
  assert.equal(guide.root.all('blockquote')[0].textContent,quote);
  assert.equal(guide.root.find('referral-reason').textContent,reason);
  assert.match(guide.root.textContent,/전문가.*상담/);assert.equal(guide.root.all('script').length,0);
  guide.navigate('chat');assert.equal(guide.root.all('blockquote').length,0);
  assert.equal(guide.root.hidden,true);assert.notEqual(guide.root.parent,nodes.chat);
});

test('a refreshed ready intake restores the same original quote only on its result screen',async()=>{
  const quote='  저장된 합성 원문과 줄바꿈\n그대로 남아요.  ';
  const data=response({assessment:{urgency:'planned'},guidance:{...response().guidance,urgency:'planned',urgent:false,
    concerns:[{subject:'patient',reason:'지속된 어려움을 전문가와 함께 살펴볼 수 있어요.',quotes:[{question_id:'describe',text:quote}]}]}});
  const initial=harness(async()=>data);await initial.guide.observe(view());
  const refreshed=harness(async()=>data,'chat');await refreshed.guide.observe(view());assert.equal(refreshed.calls.length,0);
  refreshed.guide.navigate('result');await refreshed.guide.observe(view());
  assert.equal(refreshed.guide.root.all('blockquote')[0].textContent,quote);
  assert.equal(refreshed.guide.root.textContent,initial.guide.root.textContent);
});

test('final card cannot retain quotations after editing or navigating away',async()=>{
  const data=response({guidance:{...response().guidance,concerns:[{subject:'patient',reason:'합성 우려',quotes:[{text:'합성 원문'}]}]}});
  const {guide,nodes}=harness(async()=>data);await guide.observe(view());guide.navigate('result');
  assert.equal(guide.root.all('blockquote').length,1);
  nodes.input.listeners.input();guide.navigate('result');
  assert.equal(guide.root.hidden,true);assert.equal(guide.root.all('blockquote').length,0);
  await guide.observe(view());guide.navigate('records');guide.navigate('result');
  assert.equal(guide.root.hidden,true);assert.equal(guide.root.textContent,'');
});

test('supporter and preserved unclear emergency remain separately attributed',async()=>{
  const {guide}=harness(async()=>response({assessment:{urgency:'undetermined'},safety_alert:{urgency:'soon',subjects:['supporter']},preserved_safety_alert:{urgency:'immediate',subjects:['unclear']}}));
  await guide.observe(view());const text=guide.root.textContent;
  assert.match(text,/이야기를 전하는 당신도 도움을 받을 수 있어요/);assert.match(text,/위험한 상황에 놓인 사람의 안전을 먼저 살펴 주세요/);
  assert.doesNotMatch(text,/당신의 안전을 먼저|그분의 안전을 먼저|즉시 도움|빠른 상담 안내/);
});

test('unavailable final guidance shows a retry without exposing internal errors',async()=>{
  let attempts=0;const {guide}=harness(async()=>{attempts++;if(attempts===1)throw new Error('private diagnostic');return response();});
  await guide.observe(view());assert.equal(guide.root.hidden,false);assert.match(guide.root.textContent,/도움 안내를 지금 확인하지 못했어요/);assert.doesNotMatch(guide.root.textContent,/private diagnostic|안전하다는|위험도/);
  await guide.root.find('ghost referral-retry').onclick();assert.equal(attempts,2);assert.equal(guide.root.find('referral-message').textContent,response().guidance.message);
});

test('model unavailable keeps known warning and distinguishes it from fresh classification',async()=>{
  const {guide}=harness(async()=>response({status:'model_unavailable'}));await guide.observe(view());
  assert.equal(guide.root.find('referral-message').textContent,response().guidance.message);assert.match(guide.root.textContent,/이미 확인된 긴급 안내/);
});

test('deleted, changed, and mismatching responses never show stale guidance',async()=>{
  for(const error of [{status:404},{status:409,code:'REVISION_CONFLICT'},{status:409,code:'REFERRAL_INPUT_PENDING'}]){const {guide}=harness(async()=>{throw error;});await guide.observe(view());assert.equal(guide.root.hidden,true);}
  const {guide}=harness(async()=>response({revision:1}));await guide.observe(view());assert.equal(guide.root.hidden,true);
});

test('unsafe URLs and character assets are excluded; text is not HTML and booking opens only explicitly',async()=>{
  const data=response({assessment:{urgency:'soon'},presentation:{display_name:'<script>bad</script>',asset_path:'https://bad.test/img.svg'},guidance:{...response().guidance,urgency:'soon',urgent:false,institutions:[{name:'<img onerror=x>',actions:[{kind:'phone',href:'javascript:alert(1)'},{kind:'booking',href:'https://user:password@example.test/'},{kind:'booking',href:'https://example.test/book'},{kind:'booking',href:'data:text/html,bad'}]}]}});
  const {guide}=harness(async()=>data);await guide.observe(view());
  assert.equal(guide.root.all('img').length,0);assert.equal(guide.root.all('script').length,0);assert.equal(guide.root.all('a').length,1);
  const link=guide.root.all('a')[0];assert.equal(link.href,'https://example.test/book');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.referrerPolicy,'no-referrer');assert.equal(guide.root.find('referral-name').textContent,'<script>bad</script>');
});

test('immediate warning omits booking action even if supplied in a malformed response',async()=>{
  const data=response();data.guidance.institutions[0].actions.push({kind:'booking',href:'https://example.test/book'});
  const {guide}=harness(async()=>data);await guide.observe(view());assert.equal(guide.root.all('a').length,1);assert.match(guide.root.all('a')[0].href,/^tel:/);
});

test('active conversation rendering never requests Bulssi and keeps input usable',()=>{
  const observed=[],rendered=[];
  const context=vm.createContext({ReferralGuide:{observe(state){observed.push(state);return new Promise(()=>{});}},ChatScreen:{think(){},sync(){},progress(){},title(){},section(){}},ChatInput:{clear(){},render(question){rendered.push(question);}}});
  vm.runInContext(script('core/conversation.js'),context);
  const state={...view(),status:'active',question:{id:'next'}};context.renderConversation(state,0);
  assert.equal(observed.length,0);assert.equal(rendered[0],state.question);
});

function readyConversationHarness(extra={}){
  const guidance=deferred(),result=deferred(),retryResult=deferred(),calls=[],timers=[],thinking=[],observed=[],opened=[],errors=[],screens={chat:{hidden:false},result:{hidden:true}};
  const context=vm.createContext({
    ReferralGuide:{observe(state){observed.push({...state});return observed.length===1?guidance.promise:Promise.resolve();},invalidate(){}},
    API:{request:(...args)=>{calls.push(args);return calls.length===1?result.promise:retryResult.promise;}},
    ChatScreen:{think:state=>thinking.push(state),sync(){},progress(){},title(){},section(){},clear(){},leave:go=>go()},
    ChatInput:{clear(){},render(){assert.fail('ready conversations must not render another question');}},
    rememberRec(){},ResultScreen:{prepare(){screens.chat.hidden=true;screens.result.hidden=false;},open(...args){opened.push(args);},pendingError(message,retry){errors.push({message,retry});}},show(screen){for(const [id,node]of Object.entries(screens))node.hidden=id!==screen;},window:{scrollTo(){}},$:id=>screens[id],
    setTimeout(run,delay){timers.push({run,delay});return timers.length;},clearTimeout(){},
  });
  vm.runInContext(script('core/conversation.js'),context);
  const finish=context.finish;context.finish=(...args)=>context.finishing=finish(...args);
  context.renderConversation({...view(3),status:'ready',...extra},0);
  return {context,guidance,result,retryResult,calls,timers,thinking,observed,opened,errors};
}

test('ready conversation opens results and waits for final guidance before normal generation',async()=>{
  const {context,guidance,result,calls,timers,thinking,observed}=readyConversationHarness();
  assert.equal(thinking.at(-1),true);assert.equal(calls.length,0);assert.equal(timers.length,0);
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/intakes/synthetic-intake/result');assert.equal(calls[0][1].body.revision,3);
  assert.equal(timers.length,1);assert.equal(timers[0].delay,250);
  result.resolve({revision:4,record:{profile:{},guide:{}}});await context.finishing;
  assert.deepEqual(observed.map(state=>state.revision),[3,4]);assert.equal(thinking.at(-1),false);
});

test('leaving or invalidating a ready conversation while guidance is pending prevents result dispatch',async()=>{
  for(const action of ['leave','forget']){
    const {context,guidance,calls,timers}=readyConversationHarness();
    if(action==='leave')context.leaveConversation();
    else context.forgetConversation('synthetic-intake');
    guidance.resolve();await context.finishing;
    assert.equal(calls.length,0,action);assert.equal(timers.length,0,action);
  }
});

test('failed initial guidance does not block ready conversation result generation',async()=>{
  const {context,guidance,result,calls,timers}=readyConversationHarness();
  guidance.reject(new Error('guidance unavailable'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(timers.length,1);
  result.resolve({revision:4,record:{profile:{},guide:{}}});await context.finishing;
});

test('explicit nonurgent v3 results start immediately and appear before deferred guidance finishes',async()=>{
  const {context,guidance,result,calls,timers,observed,opened}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false});
  assert.equal(calls.length,1);assert.ok(calls[0][0].endsWith('/result'));assert.equal(timers[0].delay,250);assert.equal(observed.length,0);
  context.finish();assert.equal(calls.length,1,'a duplicate finish cannot dispatch another result');
  result.resolve({revision:4,record:{profile:{},guide:{}}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened.length,1);assert.equal(observed.length,1);assert.equal(observed[0].revision,4);
  context.finish();assert.equal(calls.length,1,'guidance after saving remains part of the serialized finish');
  guidance.resolve();await context.finishing;
});

for(const safety of [true,null,undefined,'false',0])test('v3 guidance stays first unless safety is explicitly false: '+safety,async()=>{
  const {context,guidance,result,calls,observed}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:safety});
  assert.equal(calls.length,0);assert.equal(observed.length,1);
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  result.resolve({revision:4,record:{profile:{},guide:{}}});await context.finishing;
});

test('nonurgent final failure still runs guidance and queues one retry until it settles',async()=>{
  const {context,guidance,result,retryResult,calls,observed,errors}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false});
  result.reject(Object.assign(new Error('generation failed'),{status:502}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(errors.length,1);assert.equal(observed.length,1);assert.equal(observed[0].revision,3);
  const first=errors[0].retry(),second=errors[0].retry();assert.equal(first,second);assert.equal(calls.length,1);
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
  retryResult.resolve({revision:4,record:{profile:{},guide:{}}});await first;
  assert.deepEqual(observed.map(state=>state.revision),[3,4]);
});

test('leaving while deferred guidance is pending cancels a queued result retry',async()=>{
  const {context,guidance,result,calls,errors}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false});
  result.reject(Object.assign(new Error('generation failed'),{status:502}));await new Promise(resolve=>setImmediate(resolve));
  const retry=errors[0].retry();context.leaveConversation();guidance.resolve();await retry;
  assert.equal(calls.length,1);
});

test('leaving a result-first request prevents any late guidance or result display',async()=>{
  const {context,result,calls,observed,opened}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false});
  context.leaveConversation();result.resolve({revision:4,record:{profile:{},guide:{}}});await context.finishing;
  assert.equal(calls.length,1);assert.equal(observed.length,0);assert.equal(opened.length,0);
});

for(const status of [0,409])test('recovered ready revision queues one automatic result retry without waiting on itself: '+status,{timeout:1000},async()=>{
  const state={bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false};
  const {context,guidance,result,retryResult,calls,observed,opened,errors}=readyConversationHarness(state);
  const restored=deferred();
  context.ChatScreen.typing=(_face,work)=>work();
  context.API.request=(...args)=>{calls.push(args);return args[0].endsWith('/result')?retryResult.promise:restored.promise;};
  result.reject(Object.assign(new Error('result response unavailable'),{status}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2);assert.equal(calls[1][0],'/api/intakes/synthetic-intake');
  restored.resolve({...view(4),...state});await new Promise(resolve=>setImmediate(resolve));
  const automaticRetry=context.finishing;
  assert.equal(errors.length,0);assert.equal(calls.length,2,'restored result waits for deferred guidance');
  assert.deepEqual(observed.map(item=>item.revision),[4]);
  context.finish();assert.equal(calls.length,2,'duplicate resume cannot start another result');
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,3);assert.equal(calls[2][1].body.revision,4);
  retryResult.resolve({revision:5,record:{profile:{},guide:{}}});await automaticRetry;
  assert.equal(opened.length,1);assert.deepEqual(observed.map(item=>item.revision),[4,5]);
});

test('urgent ready revision recovery keeps guidance before the automatic retry',{timeout:1000},async()=>{
  const state={bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:true};
  const {context,guidance,result,retryResult,calls,observed,opened}=readyConversationHarness(state);
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));
  const restored=deferred(),retryGuidance=deferred();
  context.ChatScreen.typing=(_face,work)=>work();
  context.API.request=(...args)=>{calls.push(args);return args[0].endsWith('/result')?retryResult.promise:restored.promise;};
  context.ReferralGuide.observe=state=>{observed.push({...state});return state.revision===4?retryGuidance.promise:Promise.resolve();};
  result.reject(Object.assign(new Error('revision changed'),{status:409}));await new Promise(resolve=>setImmediate(resolve));
  restored.resolve({...view(4),...state});await new Promise(resolve=>setImmediate(resolve));
  const automaticRetry=context.finishing;
  assert.equal(calls.length,2);assert.deepEqual(observed.map(item=>item.revision),[3,4]);
  retryGuidance.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,3);assert.equal(calls[2][1].body.revision,4);
  retryResult.resolve({revision:5,record:{profile:{},guide:{}}});await automaticRetry;
  assert.equal(opened.length,1);assert.deepEqual(observed.map(item=>item.revision),[3,4,5]);
});

for(const leaveAt of ['recovery-read','deferred-guidance'])test('leaving during ready revision recovery prevents its automatic retry: '+leaveAt,{timeout:1000},async()=>{
  const state={bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false};
  const {context,guidance,result,calls,observed,opened}=readyConversationHarness(state);
  const restored=deferred();
  context.ChatScreen.typing=(_face,work)=>work();
  context.API.request=(...args)=>{calls.push(args);assert.ok(!args[0].endsWith('/result'),'stale recovery must not dispatch a result');return restored.promise;};
  result.reject(Object.assign(new Error('revision changed'),{status:409}));await new Promise(resolve=>setImmediate(resolve));
  if(leaveAt==='recovery-read')context.leaveConversation();
  restored.resolve({...view(4),...state});await new Promise(resolve=>setImmediate(resolve));
  const finishing=context.finishing;
  if(leaveAt==='deferred-guidance')context.leaveConversation();
  guidance.resolve();await finishing;
  assert.equal(calls.length,2);assert.equal(opened.length,0);
  assert.equal(observed.length,leaveAt==='deferred-guidance'?1:0);
});

function pendingResultHarness(extra={}){
  const initial=deferred(),results=[deferred(),deferred()],requests=[],quote='  합성 원문 <그대로>\n전문가와 이야기하고 싶어요.  ';
  let firstGuidance=true;
  const data=response({assessment:{urgency:'planned'},guidance:{...response().guidance,urgency:'planned',urgent:false,
    concerns:[{subject:'patient',code:'mental_health_concern',reason:'전해 주신 어려움을 함께 살펴보면 도움이 될 수 있어요.',quotes:[{question_id:'describe',text:quote}]}]}});
  const {context,guide,nodes,calls}=harness((path,options)=>{
    if(path.endsWith('/guidance')){
      if(firstGuidance){firstGuidance=false;return initial.promise;}
      return Promise.resolve({...data,revision:options.body.revision});
    }
    requests.push(path);return results[requests.length-1].promise;
  },'chat');
  Object.assign(context,{
    M:{cheer:'cheer.png'},esc:text=>String(text).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char])),CrisisLine:()=>'',
    ChatScreen:{think(){},sync(){},progress(){},title(){},section(){},clear(){},progressMarkup:()=>'',thinkProgress(){}},
    ChatInput:{clear(){},render(){assert.fail('ready intake rendered an input');}},
    show:screen=>{guide.navigate(screen);nodes.chat.hidden=screen!=='chat';nodes.result.hidden=screen!=='result';},
    rememberRec(){},setTimeout:()=>1,clearTimeout(){},
  });
  vm.runInContext(script('components/GuideCards.js')+script('components/ResultScreen.js')+script('core/conversation.js')+'\nglobalThis.resultScreen=ResultScreen;',context);
  context.resultScreen.animate=()=>{};
  const finish=context.finish;context.finish=(...args)=>context.finishing=finish(...args);
  context.renderConversation({...view(),status:'ready',...extra},0);
  return {context,guide,nodes,calls,initial,results,requests,data,quote};
}

test('ready result displays the real quoted guidance before the normal final model response',async()=>{
  const {context,guide,nodes,initial,results,requests,data,quote}=pendingResultHarness();
  assert.equal(nodes.result.hidden,false);assert.equal(nodes.chat.hidden,true);assert.equal(requests.length,0);assert.equal(guide.root.hidden,true);
  initial.resolve(data);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.result.hidden,false);assert.equal(nodes.chat.hidden,true);
  const cards=nodes.rbody.querySelector('.cards');assert.equal(guide.root.parent,cards);
  assert.equal(guide.root.hidden,false);assert.equal(guide.root.all('blockquote')[0].textContent,quote);
  assert.ok(cards.querySelector('.result-pending'));
  assert.equal(requests.length,1);assert.ok(requests[0].endsWith('/result'));
  context.show('records');results[0].resolve({revision:3,record:{profile:{},guide:{}}});await context.finishing;
});

test('normal final failure preserves the quoted card and exposes a working retry on the result screen',async()=>{
  const {context,guide,nodes,initial,results,requests,data,quote}=pendingResultHarness();
  initial.resolve(data);await new Promise(resolve=>setImmediate(resolve));
  results[0].reject(Object.assign(new Error('private model output'),{code:'MODEL_INVALID_RESPONSE'}));await context.finishing;
  assert.equal(nodes.result.hidden,false);assert.equal(guide.root.hidden,false);
  assert.equal(guide.root.all('blockquote')[0].textContent,quote);
  const card=nodes.rbody.querySelector('.result-pending');assert.equal(card.role,'alert');
  assert.match(card.textContent,/말하는 방법을 준비하지 못했어요/);assert.doesNotMatch(card.textContent,/private model output/);
  const retry=card.all('button')[0];assert.equal(retry.textContent,'다시 시도');
  retry.onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,2);assert.equal(guide.root.parent,nodes.rbody.querySelector('.cards'));
  assert.equal(guide.root.all('blockquote')[0].textContent,quote);
  context.show('records');results[1].reject(new Error('late retry failure'));await context.finishing;
});

test('guidance retry clicks wait for an active result and coalesce after failure',{timeout:1000},async()=>{
  const {context,guide,calls,initial,results,requests}=pendingResultHarness();
  initial.reject(new Error('guidance unavailable'));await new Promise(resolve=>setImmediate(resolve));
  const button=guide.root.find('ghost referral-retry');
  const first=button.onclick(),second=button.onclick();
  assert.equal(calls.filter(([path])=>path.endsWith('/guidance')).length,1);assert.equal(requests.length,1);
  results[0].reject(Object.assign(new Error('result unavailable'),{code:'MODEL_INVALID_RESPONSE'}));
  await Promise.all([context.finishing,first,second]);
  assert.equal(calls.filter(([path])=>path.endsWith('/guidance')).length,2);
  assert.ok(guide.root.all('blockquote').length);
});

for(const ending of ['saved-revision','navigation'])test('queued guidance retry is discarded after '+ending,{timeout:1000},async()=>{
  const {context,guide,calls,initial,results}=pendingResultHarness();
  initial.reject(new Error('guidance unavailable'));await new Promise(resolve=>setImmediate(resolve));
  const retry=guide.root.find('ghost referral-retry').onclick();
  if(ending==='navigation'){
    context.show('records');results[0].reject(new Error('late failure'));
  }else{
    results[0].resolve({revision:3,record:{profile:{},guide:{top:'마음',care:{feel:'함께 이야기해요',tips:[]},script:'완성한 대화 문장',doList:[],avoid:[],next:'다음 행동'}}});
  }
  await Promise.all([context.finishing,retry]);
  assert.deepEqual(calls.filter(([path])=>path.endsWith('/guidance')).map(([,options])=>options.body.revision),ending==='navigation'?[2]:[2,3]);
  if(ending==='navigation')assert.equal(guide.root.hidden,true);
});

test('result-first retry waits for a guidance retry already in flight',{timeout:1000},async()=>{
  const {context,guide,nodes,calls,initial,results,requests,data}=pendingResultHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false});
  results[0].reject(Object.assign(new Error('result unavailable'),{code:'MODEL_INVALID_RESPONSE'}));await new Promise(resolve=>setImmediate(resolve));
  initial.reject(new Error('guidance unavailable'));await context.finishing;
  const resultButton=nodes.rbody.querySelector('.result-pending').all('button')[0];
  const retryGuidance=deferred(),request=context.API.request;
  context.API.request=(...args)=>{if(args[0].endsWith('/guidance')){calls.push(args);return retryGuidance.promise;}return request(...args);};
  const guidance=guide.root.find('ghost referral-retry').onclick();
  const retry=resultButton.onclick();
  assert.equal(requests.length,1,'the result must wait for the already dispatched guidance');
  retryGuidance.resolve(data);await guidance;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2);
  results[1].reject(Object.assign(new Error('result still unavailable'),{code:'MODEL_INVALID_RESPONSE'}));await retry;
  assert.equal(calls.filter(([path])=>path.endsWith('/guidance')).length,2);
});

test('successful normal generation replaces pending content and assesses the saved result revision',async()=>{
  const {context,guide,nodes,calls,initial,results,data,quote}=pendingResultHarness();
  initial.resolve(data);await new Promise(resolve=>setImmediate(resolve));
  const normalGuide={top:'마음',care:{feel:'함께 이야기해요',tips:[]},script:'완성한 대화 문장',doList:[],avoid:[],next:'다음 행동'};
  results[0].resolve({revision:3,record:{profile:{name:'합성 인물'},guide:normalGuide}});await context.finishing;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.result.hidden,false);assert.equal(nodes.rbody.querySelector('.result-pending'),null);
  assert.match(nodes.rbody.textContent,/완성한 대화 문장/);
  assert.equal(guide.root.parent,nodes.rbody.querySelector('.cards'));assert.equal(guide.root.all('blockquote')[0].textContent,quote);
  assert.deepEqual(calls.filter(([path])=>path.endsWith('/guidance')).map(([,options])=>options.body.revision),[2,3]);
});

test('navigation while final guidance or normal generation is pending cannot restore the result screen',async()=>{
  const early=pendingResultHarness();early.context.show('records');early.initial.resolve(early.data);await early.context.finishing;
  assert.equal(early.requests.length,0);assert.equal(early.nodes.result.hidden,true);assert.equal(early.guide.root.hidden,true);
  for(const ending of ['success','failure']){
    const {context,guide,nodes,initial,results,data}=pendingResultHarness();
    initial.resolve(data);await new Promise(resolve=>setImmediate(resolve));context.show('records');
    if(ending==='success')results[0].resolve({revision:3,record:{profile:{},guide:{}}});
    else results[0].reject(new Error('late failure'));
    await context.finishing;assert.equal(nodes.result.hidden,true,ending);assert.equal(guide.root.hidden,true,ending);
    assert.equal(guide.root.all('blockquote').length,0,ending);
  }
});

test('deletion during pending normal generation clears quotes and prevents late result restoration',async()=>{
  const {context,guide,nodes,initial,results,data}=pendingResultHarness();
  initial.resolve(data);await new Promise(resolve=>setImmediate(resolve));
  context.forgetConversation('synthetic-intake');context.show('start');
  results[0].resolve({revision:3,record:{profile:{},guide:{}}});await context.finishing;
  assert.equal(nodes.result.hidden,true);assert.equal(guide.root.hidden,true);assert.equal(guide.root.all('blockquote').length,0);
});

test('finish hook schedules guidance for final saved revision while preserving the normal result flow',async()=>{
  const observed=[],record={profile:{},guide:{}};let opened=false;
  const context=vm.createContext({ReferralGuide:{observe(state){observed.push({...state});}},API:{request:async()=>({revision:4,record})},ChatScreen:{think(){}},ChatInput:{clear(){}},rememberRec(){},ResultScreen:{open(){opened=true;}},setTimeout(){return 1;},clearTimeout(){}});
  vm.runInContext(script('core/conversation.js')+'\nS={id:"synthetic-intake",revision:3,referral_available:true};',context);
  await context.finish();assert.equal(opened,true);assert.equal(observed.length,1);assert.equal(observed[0].revision,4);
});

test('show hook invalidates on navigation and forget hook clears alerts for deleted current intake only',()=>{
  const calls=[];const screens=Object.fromEntries(['start','chat','result','records','about','columns'].map(id=>[id,{hidden:false}]));
  const context=vm.createContext({ReferralGuide:{navigate:id=>calls.push(id),invalidate:()=>calls.push('invalidate')},document:{getElementById:id=>screens[id]},window:{},StartScreen:{updRecN(){}},ChatScreen:{title(){},clear(){}},ChatInput:{clear(){}}});
  vm.runInContext(script('core/utils.js')+script('core/conversation.js')+'\nS={id:"synthetic-intake"};',context);
  context.show('records');context.forgetConversation('another-intake');assert.deepEqual(calls,['records']);
  context.forgetConversation('synthetic-intake');assert.deepEqual(calls,['records','invalidate']);
});


test('current revision safety evidence failures and unknown conflicts show retry instead of silently hiding',async()=>{
  for(const code of ['REFERRAL_SAFETY_STALE','UNRECOGNIZED_CONFLICT',undefined]){
    const {guide}=harness(async()=>{throw{status:409,code};});await guide.observe(view());
    assert.equal(guide.root.hidden,false);assert.match(guide.root.textContent,/도움 안내를 지금 확인하지 못했어요/);assert.ok(guide.root.find('ghost referral-retry'));
  }
});

test('nonurgent concern is a quiet preset suggestion with contacts collapsed until requested',async()=>{
  const data=response({assessment:{urgency:'soon'},guidance:{...response().guidance,urgency:'soon',urgent:false}});
  const {guide}=harness(async()=>data);await guide.observe(view());
  assert.equal(guide.root.find('referral-message').textContent,data.guidance.message);
  assert.equal(guide.root.find('referral-title'),undefined);assert.equal(guide.root.find('referral-subject'),undefined);
  const details=guide.root.all('details');assert.equal(details.length,1);assert.ok(!details[0].open);
  assert.equal(details[0].all('summary')[0].textContent,'도움받을 곳 살펴보기');
  assert.equal(details[0].all('a').length,1);assert.ok(details[0].find('referral-privacy'));
  assert.doesNotMatch(guide.root.textContent,/위험도|즉시 도움|빠른 상담 안내/);
});

test('current immediate danger keeps its full preset and phone action visible without disclosure',async()=>{
  const {guide}=harness();await guide.observe(view());
  assert.equal(guide.root.all('details').length,0);assert.equal(guide.root.all('a').length,1);
  assert.equal(guide.root.find('referral-message').textContent,response().guidance.message);
  assert.equal(guide.root.find('referral-title').textContent,'지금 안전을 먼저 살펴 주세요');
  assert.equal(guide.root.find('referral-subject'),undefined);
});

test('warning remains visible and explains missing institution contacts',async()=>{
  const data=response();data.guidance.institutions=[];
  const {guide}=harness(async()=>data);await guide.observe(view());
  assert.equal(guide.root.hidden,false);assert.equal(guide.root.find('referral-message').textContent,data.guidance.message);
  assert.match(guide.root.textContent,/연결할 기관 정보를 확인하지 못했어요/);assert.equal(guide.root.all('a').length,0);
});


test('saved pending answer never requests Bulssi before the conversation is complete',async()=>{
  const {context,guide,calls}=harness();context.S={...view(),model_pending:true};
  await guide.observe(context.S);assert.equal(calls.length,0);assert.equal(guide.root.hidden,true);
});

test('late saved-pending warning cannot reappear after deletion',async()=>{
  const pending=deferred();const {context,guide}=harness(()=>pending.promise);context.S={...view(),model_pending:true};
  const work=guide.observe(context.S);guide.invalidate();context.S=null;pending.resolve(response());await work;assert.equal(guide.root.hidden,true);
});

test('Q&A failure recovery retains retry input without requesting Bulssi',async()=>{
  const observed=[],errors=[],state={...view(3),model_pending:true,question:{id:'observation'}};
  const context=vm.createContext({ReferralGuide:{observe(view){observed.push(view);return new Promise(()=>{});}},API:{request:async()=>state},ChatScreen:{typing:async(face,work)=>work(),sync(){}},ChatInput:{error:(...args)=>errors.push(args)}});
  vm.runInContext(script('core/conversation.js')+'\nS={id:"synthetic-intake",revision:2,question:{id:"observation"}};',context);
  const retry=()=>{};await context.recoverConversation({code:'MODEL_INVALID_RESPONSE'},0,retry);
  assert.equal(observed.length,0);assert.equal(errors.length,1);assert.equal(errors[0][1],retry);
});

function resumeHarness(request){
  const nodes=Object.fromEntries(['chat','rbody'].map(id=>[id,{hidden:true,innerHTML:''}])),observed=[],errors=[],calls=[],rendered=[],restored=[],resumed=[];
  const context=vm.createContext({
    $:id=>nodes[id],encodeURIComponent,
    API:{data:{},request:async(...args)=>{calls.push(args);return request(...args);}},
    ReferralGuide:{invalidate(){},observe:state=>observed.push(state)},
    RecordsScreen:{_openSequence:0},StartScreen:{updRecN(){}},
    ChatScreen:{clear(){},progress(){},title(){},section(){},think(){},sync(){},typing:async(face,work)=>work()},
    ChatInput:{clear(){},render:question=>rendered.push(question),error:(...args)=>errors.push(args),restoreDraft:draft=>restored.push(draft),captureDraft:()=>restored.at(-1),run:operation=>resumed.push(operation)},
    show:screen=>{nodes.chat.hidden=screen!=='chat';},
  });
  vm.runInContext(script('core/store.js')+script('core/conversation.js'),context);
  return {context,nodes,observed,errors,calls,rendered,restored,resumed};
}

test('resume reads the existing intake and resumes pending answers without requesting Bulssi',async()=>{
  const state={...view(),status:'active',model_pending:true,pending_answer:{text:'저장된 합성 답변'},question:{id:'observation',type:'text'}};
  const {context,observed,calls,errors,rendered,restored,resumed}=resumeHarness(async()=>state);
  await context.resumeConversation(state.id);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/intakes/synthetic-intake');assert.equal(calls[0][1],undefined);
  assert.equal(observed.length,0);assert.equal(rendered[0],state.question);assert.equal(errors.length,0);
  assert.equal(restored[0].text,state.pending_answer.text);assert.equal(resumed.length,1);assert.equal(typeof resumed[0],'function');
});

test('successful deletion while resume GET is pending invalidates that read and prevents guidance restoration',async()=>{
  const read=deferred();const state={...view(),status:'active',question:{id:'observation'}};
  const {context,observed,rendered}=resumeHarness(async(path,options)=>options?.method==='DELETE'?{deleted:true,record_ids:[]}:read.promise);
  const resuming=context.resumeConversation(state.id);await context.deleteIntake(state.id);read.resolve(state);await resuming;
  assert.equal(observed.length,0);assert.equal(rendered.length,0);
});

test('an unrelated deletion does not cancel resume of another saved intake',async()=>{
  const read=deferred();const state={...view(),status:'active',question:{id:'observation'}};
  const {context,observed,rendered}=resumeHarness(async(path,options)=>options?.method==='DELETE'?{deleted:true,record_ids:[]}:read.promise);
  const resuming=context.resumeConversation(state.id);await context.deleteIntake('different-intake');read.resolve(state);await resuming;
  assert.equal(observed.length,0);assert.equal(rendered[0],state.question);
});

test('navigation and a newer resume both reject older in-flight resume results',async()=>{
  const state={...view(),status:'active',question:{id:'observation'}};
  const read=deferred();const one=resumeHarness(async()=>read.promise);
  const pending=one.context.resumeConversation(state.id);one.context.show('records');read.resolve(state);await pending;assert.equal(one.observed.length,0);
  const older=deferred();const newer={...state,id:'newer-intake'};const two=resumeHarness(async path=>path.endsWith('newer-intake')?newer:older.promise);
  const stale=two.context.resumeConversation(state.id);await two.context.resumeConversation(newer.id);older.resolve(state);await stale;
  assert.equal(two.observed.length,0);assert.equal(two.rendered.length,1);assert.equal(vm.runInContext('S.id',two.context),newer.id);
});

test('resume is blocked during deletion and inaccessible intakes show no restoration or retry loop',async()=>{
  const blocked=resumeHarness(async()=>{throw new Error('should not fetch');});blocked.context.RecordsScreen._deleting='all';await blocked.context.resumeConversation('synthetic-intake');assert.equal(blocked.calls.length,0);
  const missing=resumeHarness(async()=>{throw{status:404,message:'대화를 찾을 수 없어요.'};});await missing.context.resumeConversation('synthetic-intake');
  assert.equal(missing.observed.length,0);assert.equal(missing.errors.length,1);assert.equal(missing.errors[0][1],null);
});

test('provisional urgent safety is not treated as a completed nonurgent result',async()=>{
  const {context,guidance,result,calls,observed}=readyConversationHarness({bundle_id:'malssi-intake-3.0.0-rc1',safety_urgent:false,safety_review_pending:true});
  assert.equal(calls.length,0);assert.equal(observed.length,1);
  guidance.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  result.resolve({revision:4,record:{profile:{},guide:{}}});await context.finishing;
});
