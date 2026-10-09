import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { questionCatalog } from '../src/catalog.js';

const script = path => readFileSync(new URL(`../public/js/${path}`, import.meta.url), 'utf8');

// Small DOM surface for exercising the real event handlers without a browser dependency.
class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ''; this.value = ''; this._text = ''; this.style = {};
    this.classList = {
      add: name => { if(!this.className.split(/\s+/).includes(name))this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  get lastChild() { return this.children.at(-1) ?? null; }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  click() { return this.onclick?.({ target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'disabled') this.disabled = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(html) {
    this.children = []; this._text = ''; const stack = [this];
    for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
      const match = token.match(/^<([\w-]+)([^>]*)>/);
      if (!match) continue;
      const child = new Element(match[1]);
      for (const attr of match[2].matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
      stack.at(-1).appendChild(child);
      if (!['img', 'input', 'br', 'hr'].includes(child.tagName)) stack.push(child);
    }
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
      return name != null && this.getAttribute(name) != null && (value == null || this.getAttribute(name) === value);
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(','); const found = [];
    const visit = node => { for (const child of node.children) { if (selectors.some(part => child.matches(part))) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function documentWith(ids) {
  const roots = ids.map(id => { const element = new Element('div'); element.setAttribute('id', id); return element; });
  return {
    createElement: tag => new Element(tag),
    querySelectorAll: selector => roots.flatMap(root => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]),
    getElementById(id) {
      const find = element => element.id === id ? element : element.children.map(find).find(Boolean);
      return roots.map(find).find(Boolean) ?? null;
    },
  };
}

function deferred() {
  let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}

function conversationHarness(request, { realUI = false } = {}) {
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'chatTitle', 'log', 'prog', 'sec', 'input', 'thinking', 'thRetry', 'leaveDlg', 'leaveGo', 'leaveStay', 'restart1']);
  document.getElementById('thinking').innerHTML='<ol><li></li><li></li><li></li></ol><div class="th-err" hidden><p></p></div>';
  const listeners={};
  const context = vm.createContext({
    document, window:{ scrollTo() {}, addEventListener(event,listener){listeners[event]=listener;} }, StartScreen: { updRecN() {} }, setTimeout, clearTimeout,
    MutationObserver:class { observe() {} }, ResizeObserver:class { observe() {} },
    M: { hello:'hello.png', ponder:'ponder.png', hear:'hear.png' },
    ...(!realUI ? { ChatInput: { clear() {}, render() {}, error(message) { throw new Error(message); } } } : {}),
    API: { request },
  });
  vm.runInContext(script('core/utils.js') + (realUI ? script('core/questions.js') + script('components/ChatInput.js') : '') + script('components/ChatScreen.js') + script('core/conversation.js') + '\nglobalThis.ui = ChatScreen; globalThis.flow = { begin, leaveConversation, renderConversation, show, finish, answer, goBack };', context);
  if (!realUI) context.ui.typing = (_, work) => Promise.resolve(typeof work === 'function' ? work() : work);
  return { document, context, listeners };
}

const conversationView = chatTitle => ({
  id: 'intake-1', revision: 1, chat_title: chatTitle, name: '시연 친구', log: [], progress: 4,
  section: '바람', status: 'active', question: { id: 'want', type:'text', required:true }, canGoBack: false,
});

test('server chat title is rendered literally and absent titles clear the previous name', () => {
  const { document, context } = conversationHarness(() => Promise.resolve());
  const label = '<img src=x onerror="alert(1)"> & 친구';
  context.flow.renderConversation(conversationView(label), 0);
  const pill = document.getElementById('chatTitle');
  assert.equal(pill.textContent, label);
  assert.equal(pill.children.length, 0);
  assert.equal(pill.hidden, false);
  assert.equal(document.title, `${label} · 말씨`);
  context.flow.renderConversation(conversationView(undefined), 0);
  assert.equal(pill.textContent, '');
  assert.equal(pill.hidden, true);
  assert.equal(document.title, '말씨');
});

test('new conversations, leaving, and every other screen reset the chat title', async () => {
  const response = deferred();
  const { document, context } = conversationHarness(() => response.promise);
  context.ui.title('이전 친구');
  const beginning = context.flow.begin();
  assert.equal(document.getElementById('chatTitle').hidden, true);
  assert.equal(document.title, '말씨');
  response.resolve(conversationView('시연 친구'));
  await beginning;
  assert.equal(document.getElementById('chatTitle').textContent, '시연 친구');
  context.flow.leaveConversation();
  assert.equal(document.getElementById('chatTitle').textContent, '');
  assert.equal(document.title, '말씨');
  for (const screen of ['start', 'result', 'records', 'about', 'columns']) {
    context.ui.title('다른 친구');
    context.flow.show(screen);
    assert.equal(document.getElementById('chatTitle').hidden, true, screen);
    assert.equal(document.title, '말씨', screen);
  }
});

test('a response arriving after leaving cannot restore the chat title', async () => {
  const response = deferred();
  const { document, context } = conversationHarness(() => response.promise);
  const beginning = context.flow.begin();
  context.flow.leaveConversation();
  response.resolve(conversationView('늦게 도착한 친구'));
  await beginning;
  assert.equal(document.getElementById('chatTitle').textContent, '');
  assert.equal(document.getElementById('chatTitle').hidden, true);
  assert.equal(document.title, '말씨');
});

test('yes detail inputs preserve parenthesized observations for all three questions', async () => {
  const document = documentWith(['input']);
  const context = vm.createContext({ document, questions:structuredClone(questionCatalog) });
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui = ChatInput;', context);
  for (const id of ['support', 'burden', 'cgchange_more']) {
    let submitted;
    context.ui.render(context.questions.find(question => question.id === id), (...args) => { submitted = args; });
    const yes = document.getElementById('input').querySelectorAll('button').find(button => button.textContent === '네');
    assert.ok(yes, `${id} has a yes option`);
    yes.click();
    const detail = '(예전에는) 친구들과 산책했어요.';
    document.getElementById('ta').value = detail;
    await document.getElementById('send').click();
    assert.equal(submitted[0], `네, ${detail}`, `${id} preserves the complete detail`);
    assert.equal(document.getElementById('ta').value, '', `${id} clears its submitted detail`);
    assert.deepEqual(Array.from(submitted[1]), [0]);
  }
});

test('blank yes detail retains the existing sentinel behavior', async () => {
  const document = documentWith(['input']);
  const context = vm.createContext({ document, question:structuredClone(questionCatalog.find(question => question.id === 'support')) });
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui = ChatInput;', context);
  let submitted;
  context.ui.render(context.question, text => { submitted = text; });
  document.getElementById('input').querySelectorAll('button').find(button => button.textContent === '네').click();
  await document.getElementById('send').click();
  assert.equal(submitted, '네');
});

test('a record refresh started during deletion cannot restore the deleted record', async () => {
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'rlist', 'rdetail']);
  const removal = deferred(), refresh = deferred(), calls = [];
  const records = [1, 2].map(id => ({ id, title: `기록 ${id}`, date: '2026-10-09T00:00:00Z', profile: { rel: '친구', safety: false }, guide: { top: '통합', script: '곁에 있을게요.', next: '연락해 주세요.' }, log: [] }));
  const context = vm.createContext({
    document, M: { basic: 'basic.png', hear: 'hear.png' },
    GuideCards: { doAvoid: () => '' }, StartScreen: { updRecN() {} },
    API: { request(path, options) { calls.push([path, options?.method || 'GET']); return options?.method === 'DELETE' ? removal.promise : refresh.promise; } },
  });
  vm.runInContext(script('core/utils.js') + script('core/store.js') + script('components/RecordsScreen.js') + '\nglobalThis.screen = RecordsScreen; globalThis.cache = { get: loadRecs, set: setRecs };', context);
  context.cache.set(records); context.screen.draw();
  document.getElementById('rlist').querySelector('[data-del="1"]').click();
  const deleting = document.getElementById('rlist').querySelector('[data-del="1"]').click();
  const opening = context.screen.open();
  assert.deepEqual(calls, [['/api/records/1', 'DELETE'], ['/api/records', 'GET']]);
  removal.resolve({ deleted: true }); await deleting;
  assert.deepEqual(Array.from(context.cache.get(), record => record.id), [2]);
  refresh.resolve({ records }); await opening;
  assert.deepEqual(Array.from(context.cache.get(), record => record.id), [2]);
  assert.equal(document.getElementById('rlist').querySelector('[data-del="1"]'), null);
  assert.ok(document.getElementById('rlist').querySelector('[data-del="2"]'));
});

test('leaving a started conversation needs the dialog and ignores an in-flight response after confirmation', async () => {
  const response = deferred();
  const { document, context } = conversationHarness(() => response.promise);
  const view = conversationView('친구'); view.log = [{ who:'me', text:'친구에 대해 이야기할게요.' }];
  context.flow.renderConversation(view, 0);
  context.flow.show('chat');
  context.flow.leaveConversation();
  assert.equal(document.getElementById('leaveDlg').open, true);
  assert.equal(document.getElementById('chat').hidden, false);
  document.getElementById('leaveGo').click();
  assert.equal(document.getElementById('leaveDlg').open, false);
  assert.equal(document.getElementById('start').hidden, false);
  context.flow.renderConversation(conversationView('늦은 답변'), 0);
  assert.equal(document.title, '말씨');
});

test('final loading shows an error and retries the saved revision before displaying server records', async () => {
  const first = deferred(), second = deferred(), calls = [], shown = [];
  const { document, context } = conversationHarness((path, options) => { calls.push([path, options.body.revision]); return calls.length === 1 ? first.promise : second.promise; });
  context.ResultScreen = { open(...args) { shown.push(args); } };
  context.rememberRec = record => { context.saved = record; };
  const active = conversationView('친구'); context.flow.renderConversation(active, 0);
  const finishing = context.flow.finish();
  assert.equal(document.getElementById('thinking').hidden, false);
  assert.equal(document.getElementById('thinking').querySelector('li').className, 'now');
  first.reject(Object.assign(new Error('모델 연결 실패'), { status:502 }));
  await finishing;
  assert.equal(document.getElementById('thinking').querySelector('.th-err').hidden, false);
  assert.equal(shown.length, 0);
  assert.equal(document.getElementById('thinking').querySelector('.th-err').querySelector('p').textContent, '모델 연결 실패');
  const retry = document.getElementById('thRetry').click();
  const record = { id:1, profile:{ name:'친구' }, guide:{ script:'곁에 있을게요.' } };
  second.resolve({ revision:2, record }); await retry;
  assert.deepEqual(calls, [['/api/intakes/intake-1/result',1],['/api/intakes/intake-1/result',1]]);
  assert.equal(document.getElementById('thinking').hidden, true);
  assert.equal(context.saved, record);
  assert.equal(shown[0][2], true);
});

test('detail back returns to yes/no choices before using the server previous-question action', () => {
  const document = documentWith(['input']); let backs = 0, submits = 0;
  const context = vm.createContext({ document, question:structuredClone(questionCatalog.find(q => q.id === 'support')) });
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui = ChatInput;', context);
  context.ui.render(context.question, () => submits++, () => backs++);
  document.getElementById('input').querySelectorAll('button').find(b => b.textContent === '네').click();
  assert.ok(document.getElementById('ta'));
  document.getElementById('input').querySelector('.back').click();
  assert.equal(document.getElementById('ta'), null);
  assert.equal(backs, 0); assert.equal(submits, 0);
  document.getElementById('input').querySelector('.back').click();
  assert.equal(backs, 1);
});

test('DB multi choice without own text keeps its done action and only submits selected options', async () => {
  const document = documentWith(['input']); const context = vm.createContext({ document });
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui = ChatInput;', context);
  let submitted;
  context.ui.render({ type:'multi', noOwn:true, opts:['첫 보기','둘째 보기'] }, (...args) => { submitted = args; });
  assert.equal(document.getElementById('own'), null);
  const box = document.getElementById('input');
  await box.querySelector('.done').click(); assert.equal(submitted, undefined);
  box.querySelectorAll('.chip')[1].click(); await box.querySelector('.done').click();
  assert.equal(submitted[0], '둘째 보기'); assert.deepEqual(Array.from(submitted[1]), [1]); assert.equal(submitted[2], '');
});

test('closing or refreshing an active conversation warns and completed screens do not', () => {
  const { document, context, listeners } = conversationHarness(() => Promise.resolve(), { realUI:true });
  context.ui.mount();
  context.flow.renderConversation(conversationView('친구'), 0);context.flow.show('chat');
  let warnings=0;
  const event=()=>({preventDefault(){warnings++;},returnValue:undefined});
  listeners.beforeunload(event());assert.equal(warnings,0);
  document.getElementById('ta').value='작성 중인 답변';
  const draft=event();listeners.beforeunload(draft);assert.equal(warnings,1);assert.equal(draft.returnValue,'');
  context.ui.sync([{who:'me',text:'전송한 답변'}]);document.getElementById('ta').value='';
  listeners.beforeunload(event());assert.equal(warnings,2);
  context.flow.show('result');listeners.beforeunload(event());assert.equal(warnings,2);
});

for(const detail of ['(예전에는) 친구들과 산책했어요.','']) {
  test(`optional yes detail ${detail?'submits its full text':'can be skipped'} and remains a base answer`,async()=>{
    const response=deferred(),calls=[];
    const { document,context }=conversationHarness((path,options)=>{calls.push(options.body);return response.promise;},{realUI:true});
    const q={id:'support',type:'one',face:'hear',noOwn:true,noSkip:true,opts:[['네',{input:true,ask:'어떤 사람이나 관계, 활동인가요?',ph:'예: 친구들과 산책해요'}],'아니요']};
    const base={who:'ai',text:'버팀목이 있나요?',face:'hear',fu:false},ask={who:'ai',text:q.opts[0][1].ask,face:'hear',fu:true};
    const view={...conversationView('친구'),question:q,log:[base],canGoBack:true};context.flow.renderConversation(view,0);
    const log=document.getElementById('log'),box=document.getElementById('input');
    box.querySelectorAll('.chip')[0].click();assert.equal(log.querySelectorAll('.fu-tag').length,1);
    await box.querySelector('.back').click();assert.equal(log.querySelector('.fu-tag'),null);assert.equal(calls.length,0);
    box.querySelectorAll('.chip')[0].click();document.getElementById('ta').value=detail;
    const action=detail?document.getElementById('send'):box.querySelector('.skip');
    assert.deepEqual(box.querySelector('.acts').children.map(child=>child.textContent),['건너뛰기','보내기']);
    const pending=action.click();assert.equal(calls.length,1);assert.equal(calls[0].follow_up,false);assert.equal(calls[0].skipped,false);
    assert.deepEqual(Array.from(calls[0].selected),[0]);assert.equal(calls[0].text,detail?`네, ${detail}`:'네');
    assert.equal(document.getElementById('ta').value,'');assert.ok(log.querySelector('.dots'));assert.equal(log.querySelectorAll('.fu-tag').length,1);
    response.resolve({...view,revision:3,log:[base,ask,{who:'me',text:calls[0].text,fu:false},nextPrompt],question:{id:'values',type:'text'}});
    await pending;await settleUI();assert.equal(log.querySelectorAll('.fu-tag').length,1);assert.equal(log.querySelectorAll('.me').length,1);assert.equal(log.querySelector('.dots'),null);
  });
}

for(const mode of ['retry','change-to-no','edit-detail']) {
  test(`pending optional detail ${mode} reconciles the saved prompt without duplication`,async()=>{
    const response=deferred(),calls=[];
    const { document,context }=conversationHarness((path,options)=>{calls.push(options.body);return response.promise;},{realUI:true});
    const q={id:'support',type:'one',face:'hear',noOwn:true,noSkip:true,opts:[['네',{input:true,ask:'어떤 활동인가요?'}],'아니요']};
    const base={who:'ai',text:'버팀목이 있나요?',face:'hear',fu:false};
    const ask={who:'ai',text:q.opts[0][1].ask,fu:true,face:'hear'};
    const saved={question_id:'support',selected:[0],text:'네, 친구와 산책해요.',custom:'',skipped:false,follow_up:false};
    const view={...conversationView('친구'),question:q,model_pending:true,pending_answer:saved,revision:2,log:[base,ask,{who:'me',text:saved.text,fu:false}]};
    context.flow.renderConversation(view,0);
    const log=document.getElementById('log'),box=document.getElementById('input');
    let pending;
    if(mode==='retry')pending=box.querySelector('.api-error').querySelector('button').click();
    else if(mode==='change-to-no')pending=box.querySelectorAll('.chip')[1].click();
    else {
      box.querySelectorAll('.chip')[0].click();assert.equal(log.querySelectorAll('.fu-tag').length,1);assert.equal(log.querySelectorAll('.me').length,0);
      await box.querySelector('.back').click();assert.equal(log.querySelectorAll('.fu-tag').length,1);assert.equal(log.querySelectorAll('.me').length,1);
      box.querySelectorAll('.chip')[0].click();document.getElementById('ta').value='가족과 함께 식사해요.';pending=document.getElementById('send').click();
    }
    assert.equal(calls.length,1);assert.equal(calls[0].revision,2);
    assert.equal(log.querySelectorAll('.fu-tag').length,mode==='change-to-no'?0:1);
    assert.equal(log.querySelectorAll('.me').length,1);assert.ok(log.querySelector('.dots'));
    const messages=[base,...(mode==='change-to-no'?[]:[ask]),{who:'me',text:calls[0].text,fu:false},nextPrompt];
    response.resolve({...view,model_pending:false,pending_answer:undefined,revision:4,log:messages,question:{id:'values',type:'text'}});
    await pending;await settleUI();assert.equal(log.querySelectorAll('.fu-tag').length,mode==='change-to-no'?0:1);assert.equal(log.querySelectorAll('.me').length,1);
  });
}

const settleUI = () => new Promise(resolve => setImmediate(resolve));
const prompt = { who:'ai', text:'어떤 이야기를 나누고 싶으세요?', face:'ponder', fu:false };
const nextPrompt = { who:'ai', text:'그분과 어떤 관계인가요?', face:'hear', fu:false };

for (const kind of ['text', 'one', 'one-own', 'multi', 'multi-own', 'follow-up', 'skip']) {
  test(`${kind} answers appear immediately and await the model before showing the next question`, async () => {
    const response = deferred(), calls = [];
    const { document, context } = conversationHarness((path, options) => {
      // The user bubble must already be visible when the HTTP request starts.
      assert.equal(document.getElementById('log').querySelectorAll('.me').length, 1);
      calls.push([path, options.body]); return response.promise;
    }, { realUI:true });
    const view = conversationView('친구'); view.log = [prompt];
    if (kind === 'one') view.question = { id:'want', type:'one', opts:[['대화를 시작하고 싶어요',{input:false,ask:'표시하지 않는 세부 질문'}]], noOwn:true, required:true };
    if (kind === 'one-own') view.question = { id:'want', type:'one', opts:['대화를 시작하고 싶어요'], required:true };
    if (kind === 'multi') view.question = { id:'want', type:'multi', opts:['대화를 시작하고 싶어요'], noOwn:true, required:true };
    if (kind === 'multi-own') view.question = { id:'want', type:'multi', opts:['대화를 시작하고 싶어요'], required:true };
    if (kind === 'follow-up') view.question.follow_up = true;
    if (kind === 'skip') view.question.required = false;
    context.flow.renderConversation(view, 0); context.flow.show('chat');
    const input = document.getElementById('input'), log = document.getElementById('log');
    let send;
    if (['text', 'follow-up'].includes(kind)) {
      document.getElementById('ta').value = '<친구>에게 먼저 말을 걸고 싶어요.';
      send = document.getElementById('send');
    } else if (kind.endsWith('-own')) {
      document.getElementById('own').value = '함께 천천히 이야기하고 싶어요.';
      send = kind === 'one-own' ? document.getElementById('ownSend') : input.querySelector('.done');
    } else if (kind === 'skip') send = input.querySelector('.skip');
    else {
      send = input.querySelector('.chip');
      if (kind === 'multi') { send.click(); send = input.querySelector('.done'); }
    }
    send.click(); send.click();
    assert.equal(calls.length, 1, 'duplicate sends are blocked while waiting');
    const bubble = log.querySelector('.me');
    if(kind==='one')assert.equal(log.querySelector('.fu-tag'),null,'disabled detail inputs do not display an ask');
    assert.equal(bubble.textContent, calls[0][1].text);
    assert.ok(input.querySelectorAll('input,textarea').every(element=>element.value===''), 'submitted text clears before the model response');
    assert.equal(bubble.children.length, 0, 'user text is never interpreted as HTML');
    assert.ok(log.querySelector('.dots'));
    assert.equal(log.querySelector('[role="status"]').getAttribute('aria-label'), '답변을 기다리고 있어요');
    assert.equal(log.textContent.includes(nextPrompt.text), false);
    assert.equal(input.dataset.busy, 'true');
    assert.ok(input.querySelectorAll('button,input,textarea').every(element => element.disabled));
    response.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:calls[0][1].text, fu:kind === 'follow-up' }, nextPrompt], question:{ id:'rel', type:'one', opts:['친구'], required:true } });
    await settleUI();
    assert.equal(log.querySelector('.dots'), null);
    assert.equal(log.querySelectorAll('.me').length, 1);
    assert.equal(log.querySelector('.me'), bubble, 'the confirmed bubble is retained');
    assert.equal(log.textContent.includes(nextPrompt.text), true);
    assert.equal(input.dataset.busy, '');
    assert.ok(input.querySelectorAll('button,input,textarea').every(element => !element.disabled));
  });
}

test('failed answers stay visible and retry with the same revision without duplicate bubbles', async () => {
  const first = deferred(), second = deferred(), calls = [];
  const { document, context } = conversationHarness((path, options) => {
    calls.push([path, structuredClone(options.body)]); return calls.length === 1 ? first.promise : second.promise;
  }, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '먼저 안부를 묻고 싶어요.'; document.getElementById('send').click();
  first.reject(Object.assign(new Error('연결을 확인해 주세요.'), { status:0 })); await settleUI();
  const log = document.getElementById('log'), input = document.getElementById('input');
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.querySelector('.dots'), null);
  assert.equal(log.textContent.includes(nextPrompt.text), false);
  assert.equal(document.getElementById('ta').value, '', 'retry keeps the submitted answer outside the draft');
  assert.equal(input.dataset.busy, '');
  const retry = input.querySelector('.api-error').querySelector('button').click();
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.ok(log.querySelector('.dots'));
  second.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:calls[0][1].text, fu:false }, nextPrompt] }); await retry;
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.querySelector('.dots'), null);
});

test('editing a failed answer replaces its pending bubble and uses the server-confirmed text', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const { document, context } = conversationHarness(() => ++calls === 1 ? first.promise : second.promise, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '첫 입력'; document.getElementById('send').click();
  first.reject(new Error('연결 실패')); await settleUI();
  document.getElementById('ta').value = '수정한 입력'; document.getElementById('send').click();
  const log = document.getElementById('log');
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.querySelector('.me').textContent, '수정한 입력');
  second.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:'서버에서 확인한 입력', fu:false }, nextPrompt] }); await settleUI();
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.querySelector('.me').textContent, '서버에서 확인한 입력');
  assert.equal(log.querySelector('.dots'), null);
});

test('a lost answer response is reconciled from server records after a revision conflict', async () => {
  const answerResponse = deferred(), readResponse = deferred(), calls = [];
  const { document, context } = conversationHarness((path, options) => {
    calls.push([path, options?.method || 'GET']); return options ? answerResponse.promise : readResponse.promise;
  }, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '곁에 있고 싶어요.'; document.getElementById('send').click();
  answerResponse.reject(Object.assign(new Error('현재 기록을 확인해 주세요.'), { status:409 })); await settleUI();
  assert.equal(document.getElementById('log').querySelectorAll('.me').length, 1);
  assert.ok(document.getElementById('log').querySelector('.dots'), 'waiting remains visible during the recovery GET');
  readResponse.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:'곁에 있고 싶어요.', fu:false }, nextPrompt] }); await settleUI();
  assert.deepEqual(calls, [['/api/intakes/intake-1/answers','POST'], ['/api/intakes/intake-1','GET']]);
  assert.equal(document.getElementById('log').querySelectorAll('.me').length, 1);
  assert.equal(document.getElementById('input').querySelector('.api-error'), null);
});

test('a saved answer continues without displaying the internal model-state warning', async () => {
  const response = deferred();
  const { document, context } = conversationHarness(() => response.promise, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '먼저 안부를 물을게요.'; document.getElementById('send').click();
  const warning = '답변은 저장했어요. 모델 상태 정리는 다음 답변에서 다시 시도해요.';
  response.resolve({ ...view, revision:2, model_warning:warning, log:[prompt, { who:'me', text:'먼저 안부를 물을게요.', fu:false }, nextPrompt] }); await settleUI();
  assert.equal(document.getElementById('input').querySelector('.api-error'), null);
  assert.equal(document.getElementById('log').textContent.includes(warning), false);
  assert.equal(document.getElementById('log').querySelector('.me').textContent, '먼저 안부를 물을게요.');
  assert.equal(document.getElementById('log').textContent.includes(nextPrompt.text), true);
  assert.equal(document.getElementById('input').dataset.busy, '');
});

test('leaving while the first answer is pending confirms exit and old replies do not change a new conversation', async () => {
  const answerResponse = deferred(), beginningResponse = deferred();
  const { document, context } = conversationHarness(path => path === '/api/intakes' ? beginningResponse.promise : answerResponse.promise, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0); context.flow.show('chat');
  document.getElementById('ta').value = '기다리는 입력'; document.getElementById('send').click();
  document.getElementById('ta').value = ''; // Pending bubble alone must still trigger confirmation.
  context.flow.leaveConversation(); assert.equal(document.getElementById('leaveDlg').open, true);
  document.getElementById('leaveGo').click();
  const beginning = context.flow.begin();
  answerResponse.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:'기다리는 입력', fu:false }, nextPrompt] }); await settleUI();
  const log = document.getElementById('log');
  assert.equal(log.querySelectorAll('.me').length, 0);
  assert.ok(log.querySelector('.dots'), 'the new request keeps its own waiting indicator');
  assert.equal(document.getElementById('chatTitle').textContent, '');
  beginningResponse.resolve({ ...conversationView('새 친구'), id:'intake-2', log:[prompt] }); await beginning;
  assert.equal(document.getElementById('chatTitle').textContent, '새 친구');
  assert.equal(log.querySelector('.dots'), null);
  assert.equal(log.querySelectorAll('.me').length, 0);
});

test('user bubble and waiting indicator get a paint before the HTTP request starts', async () => {
  const response = deferred(), frames = []; let calls = 0;
  const { document, context } = conversationHarness(() => { calls++; return response.promise; }, { realUI:true });
  context.requestAnimationFrame = callback => frames.push(callback);
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '먼저 인사하고 싶어요.'; document.getElementById('send').click();
  const log = document.getElementById('log');
  assert.equal(log.querySelector('.me').textContent, '먼저 인사하고 싶어요.');
  assert.ok(log.querySelector('.dots')); assert.equal(calls, 0);
  frames.shift()(); await settleUI(); assert.equal(calls, 0);
  frames.shift()(); await settleUI(); assert.equal(calls, 1);
  response.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:'먼저 인사하고 싶어요.', fu:false }, nextPrompt] }); await settleUI();
  assert.equal(log.querySelector('.dots'), null);
  assert.equal(log.querySelectorAll('.me').length, 1);
});

test('leaving before the first paint cancels a request that has not started', async () => {
  const frames = []; let calls = 0;
  const { document, context } = conversationHarness(() => { calls++; return Promise.resolve(); }, { realUI:true });
  context.requestAnimationFrame = callback => frames.push(callback);
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0); context.flow.show('chat');
  document.getElementById('ta').value = '보내기 전 입력'; document.getElementById('send').click();
  context.flow.leaveConversation(); document.getElementById('leaveGo').click();
  frames.shift()(); frames.shift()(); await settleUI();
  assert.equal(calls, 0);
  assert.equal(document.getElementById('log').querySelector('.dots'), null);
  assert.equal(document.getElementById('start').hidden, false);
});

test('a hidden tab still sends its answer without waiting for a suspended paint', async () => {
  const response = deferred(); let calls = 0;
  const { document, context } = conversationHarness(() => { calls++; return response.promise; }, { realUI:true });
  document.visibilityState = 'hidden';
  context.requestAnimationFrame = () => assert.fail('hidden tabs must not depend on paint scheduling');
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '화면을 떠나도 저장할 입력'; document.getElementById('send').click();
  assert.equal(calls, 1); assert.ok(document.getElementById('log').querySelector('.dots'));
  response.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:'화면을 떠나도 저장할 입력', fu:false }, nextPrompt] }); await settleUI();
  assert.equal(document.getElementById('log').querySelectorAll('.me').length, 1);
});

for (const code of ['MODEL_UNAVAILABLE', 'MODEL_INVALID_RESPONSE', 'MODEL_TIMEOUT', 'MODEL_AUTH_FAILED', 'MODEL_CONTEXT_TOO_LONG']) {
  test(`${code} keeps the current question and user bubble with a retry action`, async () => {
    const response = deferred(), read = deferred(), calls = [];
    const { document, context } = conversationHarness((path, options) => { calls.push([path, options]); return options ? response.promise : read.promise; }, { realUI:true });
    const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
    document.getElementById('ta').value = '저장하고 기다릴 답변'; document.getElementById('send').click();
    response.reject(Object.assign(new Error('내부 모델 오류 설명'), { status:code === 'MODEL_UNAVAILABLE' ? 503 : 502, code })); await settleUI();
    const log = document.getElementById('log'), input = document.getElementById('input');
    assert.ok(log.querySelector('.dots'), 'recovery GET also keeps the waiting indicator');
    assert.equal(input.dataset.busy, 'true');
    read.resolve({ ...view, revision:2, model_pending:true, pending_answer:calls[0][1].body, log:[prompt,{who:'me',text:'저장하고 기다릴 답변',fu:false}] }); await settleUI();
    assert.equal(log.querySelector('.me').textContent, '저장하고 기다릴 답변');
    assert.equal(log.querySelectorAll('.me').length, 1);
    assert.equal(log.textContent.includes(nextPrompt.text), false);
    assert.equal(log.querySelector('.dots'), null);
    assert.equal(document.getElementById('ta').value, '', 'the submitted draft remains empty after model failure');
    const errorText = input.querySelector('.api-error').querySelector('p').textContent;
    const expected = {
      MODEL_UNAVAILABLE:/답변 서버에 잠시 연결하지 못/,
      MODEL_INVALID_RESPONSE:/답변을 다시 확인했지만/,
      MODEL_TIMEOUT:/답변 준비 시간을 초과/,
      MODEL_AUTH_FAILED:/연결 설정을 확인/,
      MODEL_CONTEXT_TOO_LONG:/한 번에 처리할 내용이 많/,
    };
    assert.match(errorText, expected[code]);
    assert.equal(errorText.includes('내부 모델 오류 설명'), false);
    assert.equal(input.querySelector('.api-error').querySelector('button').textContent, '다시 시도');
  });
}

test('editing after a model failure uses the recovered pending revision and rejects old input reuse', async () => {
  const first = deferred(), read = deferred(), second = deferred(), calls = [];
  const { document, context } = conversationHarness((path, options) => {
    calls.push([path, options]);
    return !options ? read.promise : calls.length === 1 ? first.promise : second.promise;
  }, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '첫 입력'; document.getElementById('send').click();
  first.reject(Object.assign(new Error('모델 실패'), { status:503, code:'MODEL_UNAVAILABLE' })); await settleUI();
  read.resolve({ ...view, revision:2, model_pending:true, pending_answer:calls[0][1].body, log:[prompt,{who:'me',text:'첫 입력',fu:false}] }); await settleUI();
  document.getElementById('ta').value = '수정한 입력'; document.getElementById('send').click();
  assert.equal(calls[2][1].body.revision, 2);
  const log = document.getElementById('log');
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.querySelector('.me').textContent, '수정한 입력');
  assert.ok(log.querySelector('.dots'));
  second.resolve({ ...view, revision:4, log:[prompt,{who:'me',text:'수정한 입력',fu:false},nextPrompt] }); await settleUI();
  assert.equal(log.querySelectorAll('.me').length, 1);
  assert.equal(log.textContent.includes(nextPrompt.text), true);
});

test('a pending conflict after a lost response retains the submitted correction for retry outside the empty draft', async () => {
  const first = deferred(), conflict = deferred(), read = deferred(), retry = deferred(), calls = [];
  const { document, context } = conversationHarness((path, options) => {
    calls.push([path, options]); return [first,conflict,read,retry][calls.length-1].promise;
  }, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '응답을 놓친 입력'; document.getElementById('send').click();
  first.reject(Object.assign(new Error('연결 실패'),{status:0})); await settleUI();
  document.getElementById('ta').value = '보존할 수정 입력'; document.getElementById('send').click();
  conflict.reject(Object.assign(new Error('현재 질문을 다시 확인해 주세요.'),{status:409})); await settleUI();
  read.resolve({ ...view, revision:2, model_pending:true, pending_answer:calls[0][1].body, log:[prompt,{who:'me',text:'응답을 놓친 입력',fu:false}] }); await settleUI();
  assert.equal(document.getElementById('ta').value, '');
  const input=document.getElementById('input'), log=document.getElementById('log');
  input.querySelector('.api-error').querySelector('button').click();
  assert.equal(calls[3][1].body.revision, 2);
  assert.equal(calls[3][1].body.text, '보존할 수정 입력');
  assert.equal(log.querySelectorAll('.me').length,1);
  assert.equal(log.querySelector('.me').textContent,'보존할 수정 입력');
  retry.resolve({ ...view, revision:4, log:[prompt,{who:'me',text:'보존할 수정 입력',fu:false},nextPrompt] }); await settleUI();
  assert.equal(log.textContent.includes(nextPrompt.text),true);
});

for (const edit of [false, true]) {
  test(`server model-pending answer ${edit ? 'edits' : 'retries'} without a duplicate and waits for success`, async () => {
    const response = deferred(), calls = [];
    const { document, context } = conversationHarness((path, options) => { calls.push([path, options.body]); return response.promise; }, { realUI:true });
    const view = conversationView('친구');
    view.revision = 2; view.model_pending = true;
    view.pending_answer = { revision:1, question_id:'want', text:'먼저 안부를 물을게요.', selected:[], custom:'', skipped:false, follow_up:false };
    view.log = [prompt, { who:'me', text:view.pending_answer.text, fu:false }];
    context.flow.renderConversation(view, 0);
    const input = document.getElementById('input'), log = document.getElementById('log');
    assert.ok(input.querySelector('.api-error'));
    if (edit) { document.getElementById('ta').value = '수정해서 기다리는 입력'; document.getElementById('send').click(); }
    else input.querySelector('.api-error').querySelector('button').click();
    assert.equal(calls.length, 1); assert.equal(calls[0][1].revision, 2);
    assert.equal(log.querySelectorAll('.me').length, 1);
    assert.equal(log.querySelector('.me').textContent, edit ? '수정해서 기다리는 입력' : view.pending_answer.text);
    assert.ok(log.querySelector('.dots'));
    assert.equal(log.textContent.includes(nextPrompt.text), false);
    response.resolve({ ...conversationView('친구'), revision:4, log:[prompt, { who:'me', text:calls[0][1].text, fu:false }, nextPrompt] }); await settleUI();
    assert.equal(log.querySelector('.dots'), null);
    assert.equal(log.querySelectorAll('.me').length, 1);
    assert.equal(log.textContent.includes(nextPrompt.text), true);
    assert.equal(input.querySelector('.api-error'), null);
  });
}
