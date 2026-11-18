import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { questionCatalog } from '../src/catalog.js';
import { generationProgress } from '../src/generation-progress.js';

const script = path => readFileSync(new URL(`../public/js/${path}`, import.meta.url), 'utf8');

// Small DOM surface for exercising the real event handlers without a browser dependency.
class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ''; this.value = ''; this._text = ''; this.style = {setProperty(name,value){this[name]=String(value);}};
    this.classList = {
      add: name => { if(!this.className.split(/\s+/).includes(name))this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get parentElement() { return this.parent ?? null; }
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
  removeAttribute(name) { delete this.attributes[name]; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get innerHTML() {
    // Browser += reads the existing markup before replacing it. Keep the real
    // component's earlier cards/buttons when a later section is appended.
    const markup = element => {
      const attributes = Object.entries(element.attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
      const opening = `<${element.tagName}${attributes}>`;
      return ['img', 'input', 'br', 'hr'].includes(element.tagName) ? opening : opening + element.innerHTML + `</${element.tagName}>`;
    };
    return this._text + this.children.map(markup).join('');
  }
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
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'rlist', 'rdetail', 'rbody', 'chatTitle', 'log', 'prog', 'sec', 'input', 'thinking', 'thRetry', 'leaveDlg', 'leaveGo', 'leaveStay', 'leaveDelete', 'leaveDeleteNotice', 'restart1']);
  new Element('div').appendChild(document.getElementById('prog'));
  document.getElementById('thinking').innerHTML='<div class="waiting-dots" role="status" aria-label="안내를 준비하고 있어요" aria-busy="true"><span class="dots"><span></span><span></span><span></span></span></div><div class="th-err" hidden><p></p></div>';
  const listeners={};
  const context = vm.createContext({
    document, window:{ scrollTo() {}, addEventListener(event,listener){listeners[event]=listener;} }, StartScreen: { updRecN() {} }, setTimeout, clearTimeout, AbortController,
    MutationObserver:class { observe() {} }, ResizeObserver:class { observe() {} },
    M: { hello:'hello.png', ponder:'ponder.png', hear:'hear.png' },
    ...(!realUI ? { ChatInput: { clear() {}, render() {}, error(message) { throw new Error(message); } } } : {}),
    API: { request },
  });
  vm.runInContext(script('core/utils.js') + script('core/store.js') + (realUI ? script('core/questions.js') + script('components/ChatInput.js') : '') + script('components/ChatScreen.js') + script('core/conversation.js') + '\nglobalThis.ui = ChatScreen; globalThis.inputUI = ChatInput; globalThis.flow = { begin, leaveConversation, renderConversation, show, finish, answer, goBack, deleteCurrentConversation, deleteConversations, setHistory, loadRecs, loadIncomplete, getState:()=>S };', context);
  if (!realUI) context.ui.typing = (_, work) => Promise.resolve(typeof work === 'function' ? work() : work);
  return { document, context, listeners };
}

const conversationView = chatTitle => ({
  id: 'intake-1', revision: 1, chat_title: chatTitle, name: '시연 친구', log: [], progress: 4,
  section: '바람', status: 'active', question: { id: 'want', type:'text', required:true }, canGoBack: false,
});

function restoreUnsentDraft(context,draft){
  context.ConversationDrafts={save(){},clear(){},rebind(){},restore(view){
    if(!view.model_pending)return false;
    context.inputUI.restoreDraft(draft);return true;
  }};
}

test('service introduction keeps research and implementation details in documentation', () => {
  const context = vm.createContext({ NavBar:() => '' });
  vm.runInContext(script('components/AboutScreen.js') + '\nglobalThis.screen = AboutScreen;', context);
  const html = context.screen.render();
  assert.doesNotMatch(html, /12B|31B|NLL|Macro F1|1,661|1,462|40,415|800행|CFI|FMI|SSCS|부분학습|검증 117/);
  assert.match(html, /질문으로 상황 이해하기/);
  assert.match(html, /모른다고 답해도 괜찮아요/);
  assert.match(html, /진단을 위한 검사가 아니/);
  assert.match(html, /보관과 삭제 안내/);
});

test('start screen sets waiting expectations and opens retention and access-loss deletion guidance', () => {
  const document = documentWith(['page']);
  let begun = false, opened = false, scrolled = false;
  const context = vm.createContext({ document, NavBar:() => '', loadRecs:() => [], begin:() => { begun = true; } });
  vm.runInContext(script('core/utils.js') + script('components/StartScreen.js') + script('components/AboutScreen.js') + '\nglobalThis.start = StartScreen;globalThis.about = AboutScreen;', context);
  const html = context.start.render();
  assert.doesNotMatch(html, /10\s*[~–-]\s*15|12B|31B/);
  assert.match(html, /전체 소요 시간은 답변과 서버 상황에 따라 달라/);
  document.getElementById('page').innerHTML = html + context.about.render();
  const policy = document.getElementById('data-policy');
  policy.scrollIntoView = () => { scrolled = true; };
  context.about.open = () => { opened = true; };
  context.start.mount();
  document.getElementById('dataPolicy').click();
  assert.equal(opened, true); assert.equal(policy.open, true); assert.equal(scrolled, true);
  for (const limitation of ['AI 모델로 전송', '마지막 이용 후 30일', '서버 운영 중 1시간 안에 자동 삭제', '진행 중이거나 중단한 대화', '삭제 키를 만들어 따로 보관']) assert.ok(policy.textContent.includes(limitation), limitation);
  assert.equal(begun, false);
  document.getElementById('go').click(); assert.equal(begun, true);
});

test('record storage notice distinguishes access expiry from server deletion', () => {
  const context = vm.createContext({ NavBar:() => '' });
  vm.runInContext(script('components/RecordsScreen.js') + '\nglobalThis.screen = RecordsScreen;', context);
  const html = context.screen.render();
  assert.match(html, /완료 기록을 삭제하면 관련 대화도 함께 삭제/);
  assert.match(html, /마지막 이용 후 30일/);
  assert.match(html, /서버 운영 중 1시간 안에 자동 삭제/);
  assert.match(html, /삭제 키를 따로 보관하면/);
  assert.match(html, /이 키로 내용을 열 수는 없/);
  assert.doesNotMatch(html, /상태 이력/);
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

for (const action of ['empty-send', 'whitespace-send', 'marker-send', 'empty-enter', 'skip']) {
  test(`optional text ${action} sends an explicit skip through the conversation handler`, async () => {
    const calls = [], response = deferred();
    const { document, context } = conversationHarness((path, options) => {
      calls.push(options.body); return response.promise;
    }, { realUI:true });
    const view = { ...conversationView('친구'), question:{ id:'describe', type:'text' } };
    context.flow.renderConversation(view, 0);
    const textarea = document.getElementById('ta');
    textarea.value = action === 'whitespace-send' ? ' \t\n\u3000 ' : action === 'marker-send' ? ' (건너뛰었어요) ' : '';
    if (action === 'empty-enter') {
      let prevented = false;
      textarea.onkeydown({ key:'Enter', preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } else {
      (action === 'skip' ? document.getElementById('input').querySelector('.skip') : document.getElementById('send')).click();
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].question_id, 'describe');
    assert.equal(calls[0].skipped, true);
    assert.equal(calls[0].text, '(건너뛰었어요)');
    assert.deepEqual(Array.from(calls[0].selected), []);
    assert.equal(calls[0].custom, '');
    assert.equal(document.getElementById('log').querySelectorAll('.me').length, 1);
    response.resolve({ ...view, revision:2, question:{ id:'concern', type:'text' } });
    await settleUI();
  });
}

test('required and no-skip text reject blank Send and Enter without losing the input', async () => {
  const calls = [];
  const { document, context } = conversationHarness((path, options) => { calls.push(options.body); }, { realUI:true });
  for (const rules of [{ required:true }, { noSkip:true }, { required:true, follow_up:true }]) {
    for (const value of ['', ' \t\n\u3000 ', '(건너뛰었어요)', '\u200B', '\u2060', '\u200D', '\uFE0F', '\0', '(건너뛰었어요)\u200B']) {
      context.flow.renderConversation({ ...conversationView('친구'), question:{ id:'want', type:'text', ...rules } }, 0);
      const textarea = document.getElementById('ta'); textarea.value = value;
      await document.getElementById('send').click();
      textarea.onkeydown({ key:'Enter', preventDefault() {} });
      assert.equal(calls.length, 0);
      assert.equal(textarea.value, value);
      assert.equal(textarea.focused, true);
      assert.equal(document.getElementById('input').querySelectorAll('.need').length, 1);
      assert.equal(document.getElementById('input').querySelector('.skip'), null);
    }
  }
});

test('optional invisible-only Send skips while visible Unicode text is submitted intact', async () => {
  const document = documentWith(['input']), context = vm.createContext({document});
  vm.runInContext(script('core/utils.js') + script('components/ChatInput.js') + '\nglobalThis.ui=ChatInput;', context);
  const empty = ['\u200B', '\u2060', '\u200D', '\uFE0F', '\0', '(건너뛰었어요)\u200B'];
  const visible = ['모름', '👨‍👩‍👧‍👦', 'e\u0301', '한글', ' \u200B한글\u2060 '];
  for (const value of [...empty, ...visible]) {
    let submitted;
    context.ui.render({id:'describe',type:'text'}, (...args) => {submitted=args;});
    document.getElementById('ta').value = value;
    await document.getElementById('send').click();
    assert.equal(submitted[0], empty.includes(value) ? '(건너뛰었어요)' : value);
    assert.equal(Boolean(submitted[3]), empty.includes(value));
    assert.deepEqual(Array.from(submitted[1]), []);
  }
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
    assert.equal(document.getElementById('ta').value, detail, `${id} retains its detail until the next question renders`);
    assert.deepEqual(Array.from(submitted[1]), [0]);
  }
});

test('blank yes detail retains the existing sentinel behavior', async () => {
  const document = documentWith(['input']);
  const context = vm.createContext({ document, question:structuredClone(questionCatalog.find(question => question.id === 'support')) });
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui = ChatInput;', context);
  for (const value of ['', '\u200B', '\u2060', '\u200D', '\uFE0F', '\0', '(건너뛰었어요)\u200B']) {
    let submitted;
    context.ui.render(context.question, text => { submitted = text; });
    document.getElementById('input').querySelectorAll('button').find(button => button.textContent === '네').click();
    document.getElementById('ta').value=value;
    await document.getElementById('send').click();
    assert.equal(submitted, '네');
  }
});

test('a record refresh started during deletion cannot restore the deleted record', async () => {
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'rlist', 'rdetail']);
  const removal = deferred(), refresh = deferred(), calls = [];
  const records = [1, 2].map(id => ({ id, title: `기록 ${id}`, date: '2026-10-09T00:00:00Z', profile: { rel: '친구', safety: false }, guide: { top: '통합', script: '곁에 있을게요.', next: '연락해 주세요.' }, log: [] }));
  const context = vm.createContext({
    document, M: { basic: 'basic.png', hear: 'hear.png' },
    GuideCards: { doAvoid: () => '', speech: g => g.script, next: g => g.next, bindCopy() {} }, StartScreen: { updRecN() {} },
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
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
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

test('choice custom input blocks invisible required answers and preserves visible Unicode', async () => {
  const document = documentWith(['input']), context = vm.createContext({document});
  vm.runInContext(script('core/utils.js') + script('core/questions.js') + script('components/ChatInput.js') + '\nglobalThis.ui=ChatInput;', context);
  for (const type of ['one','multi']) for (const rules of [{required:true},{noSkip:true}]) {
    for (const value of ['\u200B', '\u2060', '\u200D', '\uFE0F', '\0', '(건너뛰었어요)\u200B', '👨‍👩‍👧‍👦', 'e\u0301', ' \u200B한글\u2060 ']) {
      let submitted;
      context.ui.render({type,opts:['친구'],...rules}, (...args) => {submitted=args;});
      const own=document.getElementById('own');own.value=value;
      await (type==='one'?document.getElementById('ownSend'):document.getElementById('input').querySelector('.done')).click();
      if (['👨‍👩‍👧‍👦','e\u0301',' \u200B한글\u2060 '].includes(value)) {
        assert.equal(submitted[0],value);
        assert.equal(submitted[2],value);
      } else {
        assert.equal(submitted,undefined);
        assert.equal(own.value,value);
      }
    }
  }
});

test('refresh warns only about unsent input when tab draft storage is unavailable', () => {
  const { document, context, listeners } = conversationHarness(() => Promise.resolve(), { realUI:true });
  context.ui.mount();
  context.flow.renderConversation(conversationView('친구'), 0);context.flow.show('chat');
  let warnings=0;
  const event=()=>({preventDefault(){warnings++;},returnValue:undefined});
  listeners.beforeunload(event());assert.equal(warnings,0);
  document.getElementById('ta').value='작성 중인 답변';
  const draft=event();listeners.beforeunload(draft);assert.equal(warnings,1);assert.equal(draft.returnValue,'');
  context.ui.sync([{who:'me',text:'전송한 답변'}]);document.getElementById('ta').value='';
  listeners.beforeunload(event());assert.equal(warnings,1);
  document.getElementById('ta').value='탭에 저장할 초안';
  context.ConversationDrafts={storageKey:'tab-only',save(){}};
  listeners.beforeunload(event());assert.equal(warnings,1);
  context.flow.show('result');listeners.beforeunload(event());assert.equal(warnings,1);
});

for(const mode of ['text','skip','empty-send']) {
  test(`optional yes detail ${mode} remains a base answer`,async()=>{
    const detail=mode==='text'?'(예전에는) 친구들과 산책했어요.':'';
    const response=deferred(),calls=[];
    const { document,context }=conversationHarness((path,options)=>{calls.push(options.body);return response.promise;},{realUI:true});
    const q={id:'support',type:'one',face:'hear',noOwn:true,noSkip:true,opts:[['네',{input:true,ask:'어떤 사람이나 관계, 활동인가요?',ph:'예: 친구들과 산책해요'}],'아니요']};
    const base={who:'ai',text:'버팀목이 있나요?',face:'hear',fu:false},ask={who:'ai',text:q.opts[0][1].ask,face:'hear',fu:true};
    const view={...conversationView('친구'),question:q,log:[base],canGoBack:true};context.flow.renderConversation(view,0);
    const log=document.getElementById('log'),box=document.getElementById('input');
    box.querySelectorAll('.chip')[0].click();assert.equal(log.querySelectorAll('.fu-tag').length,1);
    await box.querySelector('.back').click();assert.equal(log.querySelector('.fu-tag'),null);assert.equal(calls.length,0);
    box.querySelectorAll('.chip')[0].click();document.getElementById('ta').value=detail;
    const action=mode==='skip'?box.querySelector('.skip'):document.getElementById('send');
    assert.deepEqual(box.querySelector('.acts').children.map(child=>child.textContent),['건너뛰기','보내기']);
    const pending=action.click();assert.equal(calls.length,1);assert.equal(calls[0].follow_up,false);assert.equal(calls[0].skipped,false);
    assert.deepEqual(Array.from(calls[0].selected),[0]);assert.equal(calls[0].text,detail?`네, ${detail}`:'네');
    assert.equal(document.getElementById('ta').value,detail);assert.ok(log.querySelector('.dots'));assert.equal(log.querySelectorAll('.fu-tag').length,1);
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
    restoreUnsentDraft(context,{text:'',own:'',selected:[],detailOption:null});
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
    const submittedInputs=input.querySelectorAll('input,textarea').map(element=>element.value);
    send.click(); send.click();
    assert.equal(calls.length, 1, 'duplicate sends are blocked while waiting');
    const bubble = log.querySelector('.me');
    if(kind==='one')assert.equal(log.querySelector('.fu-tag'),null,'disabled detail inputs do not display an ask');
    assert.equal(bubble.textContent, calls[0][1].text);
    assert.deepEqual(input.querySelectorAll('input,textarea').filter(element=>element.id!=='next-answer').map(element=>element.value),submittedInputs,'submitted text stays available while waiting');
    assert.equal(bubble.children.length, 0, 'user text is never interpreted as HTML');
    assert.ok(log.querySelector('.dots'));
    assert.equal(log.querySelector('[role="status"]').getAttribute('aria-label'), 'AI 응답을 기다리고 있어요');
    assert.equal(log.querySelector('[role="status"]').textContent, '');
    assert.equal(log.textContent.includes(nextPrompt.text), false);
    assert.equal(input.dataset.busy, 'true');
    assert.ok(input.querySelectorAll('button,input,textarea').filter(element=>element.id!=='next-answer').every(element => element.disabled));
    assert.equal(document.getElementById('next-answer').disabled,false);
    response.resolve({ ...view, revision:3, log:[prompt, { who:'me', text:calls[0][1].text, fu:kind === 'follow-up' }, nextPrompt], question:{ id:'rel', type:'one', opts:['친구'], required:true } });
    await settleUI();
    assert.equal(log.querySelector('.dots'), null);
    assert.equal(log.querySelector('[role="status"]'), null);
    assert.equal(log.querySelectorAll('.me').length, 1);
    assert.equal(log.querySelector('.me'), bubble, 'the confirmed bubble is retained');
    assert.equal(log.textContent.includes(nextPrompt.text), true);
    assert.equal(input.dataset.busy, '');
    assert.ok(input.querySelectorAll('input,textarea').every(element=>element.value===''),'the next question starts with fresh inputs');
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
  assert.equal(document.getElementById('ta').value, '먼저 안부를 묻고 싶어요.', 'a failed request retains the editable draft');
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
    assert.equal(document.getElementById('ta').value, '저장하고 기다릴 답변', 'the editable draft is retained after model failure');
    const errorText = input.querySelector('.api-error').querySelector('p').textContent;
    const expected = {
      MODEL_UNAVAILABLE:/답변 서버에 잠시 연결하지 못/,
      MODEL_INVALID_RESPONSE:/답변을 다시 확인했지만/,
      MODEL_TIMEOUT:/답변을 다시 준비하고 있어요/,
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

test('a pending conflict after a lost response retains the editable correction and retries that correction', async () => {
  const first = deferred(), firstRead = deferred(), conflict = deferred(), read = deferred(), retry = deferred(), calls = [];
  const { document, context } = conversationHarness((path, options) => {
    calls.push([path, options]); return [first,firstRead,conflict,read,retry][calls.length-1].promise;
  }, { realUI:true });
  const view = conversationView('친구'); view.log = [prompt]; context.flow.renderConversation(view, 0);
  document.getElementById('ta').value = '응답을 놓친 입력'; document.getElementById('send').click();
  first.reject(Object.assign(new Error('연결 실패'),{status:0})); await settleUI();
  firstRead.resolve({...view,revision:2,model_pending:true,pending_answer:calls[0][1].body,log:[prompt,{who:'me',text:'응답을 놓친 입력',fu:false}]});await settleUI();
  document.getElementById('ta').value = '보존할 수정 입력'; document.getElementById('send').click();
  conflict.reject(Object.assign(new Error('현재 질문을 다시 확인해 주세요.'),{status:409})); await settleUI();
  read.resolve({ ...view, revision:3, model_pending:true, pending_answer:calls[0][1].body, log:[prompt,{who:'me',text:'응답을 놓친 입력',fu:false}] }); await settleUI();
  assert.equal(document.getElementById('ta').value, '보존할 수정 입력');
  const input=document.getElementById('input'), log=document.getElementById('log');
  input.querySelector('.api-error').querySelector('button').click();
  assert.equal(calls[4][1].body.revision, 3);
  assert.equal(calls[4][1].body.text, '보존할 수정 입력');
  assert.equal(log.querySelectorAll('.me').length,1);
  assert.equal(log.querySelector('.me').textContent,'보존할 수정 입력');
  retry.resolve({ ...view, revision:4, log:[prompt,{who:'me',text:'보존할 수정 입력',fu:false},nextPrompt] }); await settleUI();
  assert.equal(log.textContent.includes(nextPrompt.text),true);
});

for (const edit of [false, true]) {
  test(`a restored unsent draft can ${edit ? 'replace' : 'retry'} a saved pending answer without duplication`, async () => {
    const response = deferred(), calls = [];
    const { document, context } = conversationHarness((path, options) => { calls.push([path, options.body]); return response.promise; }, { realUI:true });
    const view = conversationView('친구');
    view.revision = 2; view.model_pending = true;
    view.pending_answer = { revision:1, question_id:'want', text:'먼저 안부를 물을게요.', selected:[], custom:'', skipped:false, follow_up:false };
    view.log = [prompt, { who:'me', text:view.pending_answer.text, fu:false }];
    restoreUnsentDraft(context,{text:'아직 보내지 않은 수정 초안',own:'',selected:[],detailOption:null});
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

test('a saved pending answer automatically resumes when no differing unsent draft exists',async()=>{
  const response=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push([path,options.body]);return response.promise;},{realUI:true});
  const saved={revision:1,question_id:'want',text:'저장된 답변을 이어가요.',selected:[],custom:'',skipped:false,follow_up:false};
  const view={...conversationView('친구'),revision:2,model_pending:true,pending_answer:saved,log:[prompt,{who:'me',text:saved.text,fu:false}]};
  context.flow.renderConversation(view,0);
  const input=document.getElementById('input'),log=document.getElementById('log');
  assert.equal(calls.length,1);assert.equal(calls[0][1].revision,2);
  assert.equal(document.getElementById('ta').value,saved.text);
  assert.equal(input.querySelector('.api-error'),null);assert.equal(input.dataset.busy,'true');
  assert.equal(log.querySelectorAll('.me').length,1);
  response.resolve({...conversationView('친구'),revision:4,log:[prompt,{who:'me',text:saved.text,fu:false},nextPrompt]});await settleUI();
  assert.equal(document.getElementById('ta').value,'');assert.equal(input.dataset.busy,'');
  assert.equal(log.querySelectorAll('.me').length,1);assert.equal(log.querySelector('.dots'),null);
});

function historyHarness(request) {
  const document = documentWith(['start','chat','result','records','about','columns','rlist','rdetail']);
  const context = vm.createContext({document,M:{basic:'basic.png',hear:'hear.png'},GuideCards:{doAvoid:()=>'',speech:g=>g.script,next:g=>g.next,bindCopy(){}},StartScreen:{updRecN(){}},API:{request}});
  vm.runInContext(script('core/utils.js')+script('core/store.js')+script('components/RecordsScreen.js')+'\nglobalThis.screen=RecordsScreen;globalThis.cache={set:setHistory,records:loadRecs,incomplete:loadIncomplete};',context);
  return {document,context};
}
const historyRecord = {id:1,title:'완료 대화',date:'2026-10-15T00:00:00Z',profile:{rel:'친구',safety:false},guide:{top:'통합',script:'기록 문장',next:'다음 행동'},log:[]};
const incompleteSummary = {id:'intake-1',title:'미완료 대화',updated_at:'2026-10-15T00:00:00Z'};

test('a history response from before a new conversation cannot erase its saved result',async()=>{
  const refresh=deferred();
  const {context}=conversationHarness(path=>path==='/api/records'?refresh.promise:
    Promise.resolve(path==='/api/intakes'?conversationView('새 대화'):{revision:2,record:historyRecord}));
  context.ResultScreen={open(){}};
  vm.runInContext(script('components/RecordsScreen.js')+'\nglobalThis.historyScreen=RecordsScreen;',context);
  const opening=context.historyScreen.open();
  await context.flow.begin();await context.flow.finish();
  assert.deepEqual(Array.from(context.flow.loadRecs(),record=>record.id),[historyRecord.id]);
  refresh.resolve({records:[],incomplete_intakes:[],conversation_epoch:0});await opening;
  assert.deepEqual(Array.from(context.flow.loadRecs(),record=>record.id),[historyRecord.id]);
});

test('leaving records ignores the pending history response even without starting another conversation',async()=>{
  const refresh=deferred(),{context}=historyHarness(()=>refresh.promise);
  context.cache.set({records:[historyRecord],incomplete_intakes:[]});
  const opening=context.screen.open();vm.runInContext('show("about")',context);
  refresh.resolve({records:[],incomplete_intakes:[],conversation_epoch:0});await opening;
  assert.deepEqual(Array.from(context.cache.records(),record=>record.id),[historyRecord.id]);
});

function deletionKeyHarness(request) {
  const document = documentWith(['page']);
  const context = vm.createContext({document,NavBar:()=>'',M:{basic:'basic.png',hear:'hear.png'},GuideCards:{doAvoid:()=>'',speech:g=>g.script,next:g=>g.next,bindCopy(){}},StartScreen:{updRecN(){}},API:{request}});
  vm.runInContext(script('core/utils.js')+script('core/store.js')+script('components/RecordsScreen.js')+'\nglobalThis.screen=RecordsScreen;globalThis.cache={set:setHistory,records:loadRecs,incomplete:loadIncomplete};',context);
  document.getElementById('page').innerHTML=context.screen.render();context.screen.mount();
  context.API.csrf='current-session';
  context.API.bootstrap=async()=>({});
  context.cache.set({records:[historyRecord],incomplete_intakes:[incompleteSummary],conversation_epoch:0});context.screen.draw();
  return {document,context};
}

test('deletion key issuance confirms replacement and shows the returned key only in the current page', async () => {
  const issued='k'.repeat(43),calls=[];
  const {document}=deletionKeyHarness((path,options)=>{calls.push([path,options]);return Promise.resolve({deletion_key:issued});});
  await document.getElementById('createDeletionKey').click();
  assert.equal(calls.length,0);assert.match(document.getElementById('deletionKeyNotice').textContent,/이전 키는 사용할 수 없/);
  await document.getElementById('createDeletionKey').click();
  assert.equal(calls[0][0],'/api/deletion-key');assert.equal(calls[0][1].method,'POST');
  assert.equal(document.getElementById('deletionKeyOutput').value,issued);
  assert.equal(document.getElementById('deletionKeyOutput').hidden,false);
  assert.match(document.getElementById('deletionKeyNotice').textContent,/따로 복사해 보관/);
  assert.equal(document.getElementById('deletionKeyInput').value,'');
});

test('an uncertain key replacement hides the previous key instead of presenting it as usable', async () => {
  let calls=0;
  const {document}=deletionKeyHarness(()=>++calls===1?Promise.resolve({deletion_key:'x'.repeat(43)}):Promise.reject(new Error('연결 실패')));
  const button=document.getElementById('createDeletionKey');
  await button.click();await button.click();
  assert.equal(document.getElementById('deletionKeyOutput').hidden,false);
  await button.click();await button.click();
  assert.equal(document.getElementById('deletionKeyOutput').hidden,true);
  assert.equal(document.getElementById('deletionKeyOutput').value,'');
  assert.match(document.getElementById('deletionKeyNotice').textContent,/이전 키도 교체됐을 수/);
});

for (const current of [false,true]) test(`key deletion confirms ownership scope and ${current?'clears':'preserves'} the current history`, async () => {
  const removal=deferred(),calls=[],key='a'.repeat(43);
  const {document,context}=deletionKeyHarness((path,options)=>{calls.push([path,options]);return removal.promise;});
  document.getElementById('deletionKeyInput').value=key;
  await document.getElementById('deleteWithKey').click();
  assert.equal(calls.length,0);assert.match(document.getElementById('deleteWithKeyNotice').textContent,/지금 열린 기록과 다를 수/);
  const deleting=document.getElementById('deleteWithKey').click();
  assert.equal(calls[0][0],'/api/conversations/delete-with-key');assert.equal(calls[0][1].body.deletion_key,key);
  assert.equal(document.getElementById('deletionKeyInput').disabled,true);
  assert.equal(context.cache.records().length,1);
  removal.resolve({deleted:true,current_session:current,...(current?{conversation_epoch:1}:{})});await deleting;
  assert.equal(context.cache.records().length,current?0:1);
  assert.equal(context.cache.incomplete().length,current?0:1);
  assert.equal(document.getElementById('deletionKeyInput').value,'');
  assert.match(document.getElementById('deleteWithKeyNotice').textContent,/대화를 삭제했어요/);
});

test('failed key deletion preserves the entered key and records, and editing a key requires new confirmation', async () => {
  const removal=deferred(),calls=[];
  const {document,context}=deletionKeyHarness((path,options)=>{calls.push([path,options]);return removal.promise;});
  const input=document.getElementById('deletionKeyInput'),button=document.getElementById('deleteWithKey');
  input.value='short';await button.click();assert.equal(calls.length,0);
  input.value='b'.repeat(43);await button.click();
  input.value='c'.repeat(43);input.oninput();await button.click();assert.equal(calls.length,0);
  const deleting=button.click();removal.reject(new Error('삭제 키를 확인해 주세요.'));await deleting;
  assert.equal(context.cache.records()[0],historyRecord);assert.equal(input.value,'c'.repeat(43));
  assert.equal(input.disabled,false);assert.match(document.getElementById('deleteWithKeyNotice').textContent,/삭제 키를 확인/);
});

test('key deletion after cookie loss without reload reconciles stale history and forgets the old conversation', async () => {
  const {document,context}=deletionKeyHarness(()=>Promise.resolve({deleted:true,current_session:false}));
  vm.runInContext(script('components/ColumnsScreen.js')+'\nglobalThis.columns=ColumnsScreen;',context);
  context.API.data={column_state:{read:['quiet'],saved:['quiet']}};
  context.columns.load();let columnDraws=0;context.columns.draw=()=>columnDraws++;
  let forgotten=0;
  context.forgetConversation=()=>forgotten++;
  context.API.bootstrap=async()=>{
    context.API.csrf='replacement-session';
    context.API.data={column_state:{read:[],saved:[]}};
    context.cache.set({records:[],incomplete_intakes:[],conversation_epoch:0});
  };
  document.getElementById('deletionKeyInput').value='d'.repeat(43);
  await document.getElementById('deleteWithKey').click();
  await document.getElementById('deleteWithKey').click();
  assert.equal(forgotten,1);
  assert.equal(context.cache.records().length,0);
  assert.equal(context.cache.incomplete().length,0);
  assert.deepEqual(Array.from(context.columns.st.read),[]);assert.deepEqual(Array.from(context.columns.st.saved),[]);
  assert.equal(columnDraws,1);
  assert.doesNotMatch(document.getElementById('rdetail').textContent,/기록 문장/);
  assert.match(document.getElementById('deleteWithKeyNotice').textContent,/대화를 삭제했어요/);
});

test('column session reload discards old responses and queued writes while allowing new updates',async t=>{
  const old=deferred(),current=deferred(),calls=[],toasts=[];
  t.after(()=>{old.resolve({state:{read:[],saved:[]}});current.resolve({state:{read:[],saved:[]}});});
  const context=vm.createContext({API:{data:{column_state:{read:[],saved:[]}},request:async(path,options)=>{
    calls.push([path,options.body]);return calls.length===1?old.promise:current.promise;
  }}});
  vm.runInContext(script('components/ColumnsScreen.js')+'\nglobalThis.columns=ColumnsScreen;',context);
  const columns=context.columns;columns.draw=()=>{};columns.toast=message=>toasts.push(message);columns.load();
  const first=columns.markRead({art:'quiet'}),queued=columns.toggleSave({art:'quiet'});await Promise.resolve();
  assert.equal(calls.length,1);
  context.API.data={column_state:{read:[],saved:[]}};columns.load();
  const replacement=columns.markRead({art:'quiet'});await Promise.resolve();assert.equal(calls.length,2);
  old.resolve({state:{read:['quiet'],saved:['quiet']}});await first;await Promise.resolve();
  assert.deepEqual(Array.from(columns.st.read),[]);assert.deepEqual(Array.from(columns.st.saved),[]);
  assert.equal(calls.length,2);assert.equal(columns.pending.has('quiet:read'),true);assert.deepEqual(toasts,[]);
  current.resolve({state:{read:['quiet'],saved:[]}});await replacement;await queued;
  assert.deepEqual(Array.from(columns.st.read),['quiet']);assert.deepEqual(Array.from(columns.st.saved),[]);
  assert.equal(columns.pending.size,0);assert.equal(toasts.length,1);
});

test('a successful key deletion with failed session refresh reports the partial outcome and allows retry', async () => {
  const {document,context}=deletionKeyHarness(()=>Promise.resolve({deleted:true,current_session:false}));
  context.API.bootstrap=async()=>{throw new Error('synthetic refresh failure');};
  document.getElementById('deletionKeyInput').value='e'.repeat(43);
  await document.getElementById('deleteWithKey').click();
  await document.getElementById('deleteWithKey').click();
  assert.match(document.getElementById('deleteWithKeyNotice').textContent,/삭제했지만 화면을 새로 불러오지 못/);
  assert.equal(document.getElementById('deletionKeyInput').value,'e'.repeat(43));
  assert.equal(document.getElementById('deleteWithKey').disabled,false);
});

test('incomplete-only history offers individually confirmed and whole-history deletion', async () => {
  const calls=[],removal=deferred();
  const {document,context}=historyHarness((path,options)=>{calls.push([path,options.method]);return removal.promise;});
  context.cache.set({records:[],incomplete_intakes:[incompleteSummary],conversation_epoch:0});context.screen.draw();
  assert.equal(document.getElementById('deleteAll').disabled,undefined);
  assert.match(document.getElementById('rlist').textContent,/미완료 대화/);
  assert.match(document.getElementById('rdetail').textContent,/완료된 기록은 아직 없어요/);
  document.getElementById('rlist').querySelector('[data-intake-del="intake-1"]').click();
  assert.equal(calls.length,0);
  const deleting=document.getElementById('rlist').querySelector('[data-intake-del="intake-1"]').click();
  assert.deepEqual(calls,[['/api/intakes/intake-1','DELETE']]);
  assert.equal(context.cache.incomplete().length,1);
  removal.resolve({deleted:true,record_ids:[]});await deleting;
  assert.equal(context.cache.incomplete().length,0);
  assert.equal(document.getElementById('deleteAll').disabled,true);
});

test('whole-history deletion confirms scope and blocks stale mixed-list refreshes', async () => {
  const calls=[],removal=deferred(),refresh=deferred();
  const {document,context}=historyHarness((path,options)=>{calls.push(path);return options?.method==='DELETE'?removal.promise:refresh.promise;});
  const history={records:[historyRecord],incomplete_intakes:[incompleteSummary],conversation_epoch:0};
  context.cache.set(history);context.screen.draw();
  document.getElementById('deleteAll').click();
  assert.equal(calls.length,0);assert.match(document.getElementById('rlist').textContent,/완료·미완료 대화와 결과를 모두 삭제/);
  const deleting=document.getElementById('deleteAll').click();
  const opening=context.screen.open();
  assert.deepEqual(calls,['/api/conversations','/api/records']);
  removal.resolve({deleted:true,conversation_epoch:1});await deleting;
  refresh.resolve(history);await opening;
  assert.equal(context.cache.records().length,0);assert.equal(context.cache.incomplete().length,0);
  assert.doesNotMatch(document.getElementById('rdetail').textContent,/기록 문장/);
});

test('failed whole-history deletion retains completed and incomplete rows and selected detail', async () => {
  const removal=deferred();
  const {document,context}=historyHarness(()=>removal.promise);
  context.cache.set({records:[historyRecord],incomplete_intakes:[incompleteSummary],conversation_epoch:0});context.screen.draw();
  const detail=document.getElementById('rdetail').textContent;
  document.getElementById('deleteAll').click();const deleting=document.getElementById('deleteAll').click();
  removal.reject(new Error('삭제 요청 실패'));await deleting;
  assert.equal(context.cache.records()[0],historyRecord);assert.equal(context.cache.incomplete()[0],incompleteSummary);
  assert.equal(document.getElementById('rdetail').textContent,detail);
  assert.match(document.getElementById('rlist').textContent,/삭제 요청 실패/);
  assert.equal(document.getElementById('deleteAll').disabled,undefined);
});

test('chat deletion requires a second confirmation and failures preserve the current input and conversation', async () => {
  const removal=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push([path,options.method]);return removal.promise;},{realUI:true});
  const view=conversationView('친구');view.log=[{who:'me',text:'기존 대화'}];
  context.flow.renderConversation(view,0);context.flow.show('chat');document.getElementById('ta').value='아직 보내지 않은 말';
  context.flow.leaveConversation();document.getElementById('leaveDelete').click();
  assert.equal(calls.length,0);assert.match(document.getElementById('leaveDeleteNotice').textContent,/되돌릴 수 없어요/);
  const deleting=document.getElementById('leaveDelete').click();
  assert.equal(document.getElementById('leaveStay').disabled,true);
  removal.reject(new Error('잠시 연결되지 않았어요'));await deleting;
  assert.equal(context.flow.getState(),view);assert.equal(document.getElementById('ta').value,'아직 보내지 않은 말');
  assert.equal(document.getElementById('chat').hidden,false);assert.equal(document.getElementById('leaveDlg').open,true);
  assert.match(document.getElementById('leaveDeleteNotice').textContent,/잠시 연결되지 않았어요/);
  assert.equal(document.getElementById('leaveStay').disabled,false);
});

for(const action of ['answer','result']){
  test(`successful chat deletion ignores a late ${action} response and clears local conversation content`,async()=>{
    const pending=deferred(),removal=deferred(),shown=[];
    const {document,context}=conversationHarness((path,options)=>options.method==='DELETE'?removal.promise:pending.promise,{realUI:true});
    context.ResultScreen={open:(...args)=>shown.push(args)};
    const view=conversationView('친구');view.log=[{who:'me',text:'기존 대화'}];context.flow.renderConversation(view,0);context.flow.show('chat');
    const working=action==='answer'?context.flow.answer('보낸 말',[]):context.flow.finish();
    context.flow.leaveConversation();document.getElementById('leaveDelete').click();const deleting=document.getElementById('leaveDelete').click();
    removal.resolve({deleted:true,record_ids:['1']});await deleting;
    pending.resolve(action==='answer'?{...conversationView('늦은 이름'),revision:2}:{revision:2,record:historyRecord});await working;
    assert.equal(context.flow.getState(),null);assert.equal(context.flow.loadRecs().length,0);assert.equal(shown.length,0);
    assert.equal(document.getElementById('start').hidden,false);assert.equal(document.getElementById('log').textContent,'');
    assert.equal(document.getElementById('leaveDlg').open,false);
  });
}

test('whole-history deletion invalidates a pending creation but permits an intentional new conversation with the new epoch',async()=>{
  const initial=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{
    calls.push([path,options.body]);
    if(path==='/api/conversations')return Promise.resolve({deleted:true,conversation_epoch:1});
    return calls.length===1?initial.promise:Promise.resolve({...conversationView('새 대화'),id:'new-intake'});
  });
  const beginning=context.flow.begin();await context.flow.deleteConversations();
  initial.resolve(conversationView('삭제 전 대화'));await beginning;
  assert.equal(context.flow.getState(),null);assert.equal(document.getElementById('chatTitle').textContent,'');
  await context.flow.begin();
  assert.equal(context.flow.getState().id,'new-intake');
  assert.deepEqual(calls.filter(([path])=>path==='/api/intakes').map(([,body])=>body.conversation_epoch),[0,1]);
});

test('a stale creation epoch refreshes history and waits for an intentional retry',async()=>{
  const calls=[];
  const {document,context}=conversationHarness((path,options)=>{
    calls.push([path,options?.body]);
    if(path==='/api/records')return Promise.resolve({records:[],incomplete_intakes:[],conversation_epoch:2});
    if(options.body.conversation_epoch===0)return Promise.reject(Object.assign(new Error('대화 목록이 변경됐어요.'),{code:'CONVERSATIONS_CHANGED'}));
    return Promise.resolve(conversationView('새 대화'));
  },{realUI:true});
  await context.flow.begin();
  assert.equal(calls.length,2);assert.equal(context.flow.getState(),null);
  await document.getElementById('input').querySelector('.api-error').querySelector('button').click();
  assert.equal(calls.at(-1)[1].conversation_epoch,2);assert.equal(context.flow.getState().chat_title,'새 대화');
});

test('deleting from chat invalidates a history request started before navigating away',async()=>{
  const refresh=deferred();
  const {context}=conversationHarness((path)=>path==='/api/records'?refresh.promise:Promise.resolve({deleted:true,record_ids:[]}));
  vm.runInContext(script('components/RecordsScreen.js')+'\nglobalThis.historyScreen=RecordsScreen;',context);
  const history={records:[],incomplete_intakes:[incompleteSummary],conversation_epoch:0};
  context.flow.setHistory(history);
  const opening=context.historyScreen.open();
  context.flow.renderConversation(conversationView('친구'),0);context.flow.show('chat');
  await context.flow.deleteCurrentConversation();
  refresh.resolve(history);await opening;
  assert.equal(context.flow.loadIncomplete().length,0);assert.equal(context.flow.getState(),null);
});

test('a late chat deletion redraws the current records screen without restoring its stale history response',async()=>{
  const removal=deferred(),refresh=deferred();
  const {context,document}=conversationHarness((path,options)=>options?.method==='DELETE'?removal.promise:refresh.promise);
  vm.runInContext(script('components/RecordsScreen.js')+'\nglobalThis.historyScreen=RecordsScreen;',context);
  const other={...incompleteSummary,id:'intake-2',title:'남겨 둘 대화'};
  const history={records:[],incomplete_intakes:[incompleteSummary,other],conversation_epoch:0};
  context.flow.setHistory(history);context.flow.renderConversation(conversationView('친구'),0);context.flow.show('chat');
  const deleting=context.flow.deleteCurrentConversation(),opening=context.historyScreen.open();
  removal.resolve({deleted:true,record_ids:[]});await deleting;
  refresh.resolve(history);await opening;
  assert.equal(document.getElementById('records').hidden,false);
  assert.deepEqual(Array.from(context.flow.loadIncomplete(),row=>row.id),['intake-2']);
  assert.deepEqual(document.getElementById('rlist').querySelectorAll('[data-intake-resume]').map(button=>button.dataset.intakeResume),['intake-2']);
});

for(const outcome of ['success','failure'])test(`a late chat deletion ${outcome} preserves a newer conversation's exit dialog`,async()=>{
  const removal=deferred(),{context,document}=conversationHarness(()=>removal.promise);
  context.flow.renderConversation({...conversationView('첫 대화'),log:[{who:'me',text:'첫 합성 답변'}]},0);context.flow.show('chat');
  context.flow.leaveConversation();document.getElementById('leaveDelete').click();
  const deleting=document.getElementById('leaveDelete').click();
  context.flow.renderConversation({...conversationView('다른 대화'),id:'intake-2',log:[{who:'me',text:'다른 합성 답변'}]},0);
  context.flow.leaveConversation();
  if(outcome==='success')removal.resolve({deleted:true,record_ids:[]});else removal.reject(new Error('첫 대화의 삭제 실패'));
  await deleting;
  assert.equal(context.flow.getState().id,'intake-2');assert.equal(document.getElementById('chat').hidden,false);
  assert.equal(document.getElementById('leaveDlg').open,true);assert.equal(document.getElementById('leaveDeleteNotice').hidden,true);
  assert.equal(document.getElementById('leaveDelete').disabled,false);assert.equal(document.getElementById('leaveStay').disabled,false);
  document.getElementById('leaveDelete').click();assert.equal(document.getElementById('leaveDelete').textContent,'삭제하고 나가기 확인');
});

test('a result received while deletion waits is removed with its completed cache entry',async()=>{
  const result=deferred(),removal=deferred();
  const {context}=conversationHarness((path,options)=>options.method==='DELETE'?removal.promise:result.promise);
  context.ResultScreen={open(){}};
  context.flow.setHistory({records:[],incomplete_intakes:[incompleteSummary],conversation_epoch:0});
  context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish(),deleting=context.flow.deleteCurrentConversation();
  result.resolve({revision:2,record:historyRecord});await finishing;
  assert.equal(context.flow.loadRecs().length,1);assert.equal(context.flow.loadIncomplete().length,0);
  removal.resolve({deleted:true,record_ids:['1']});await deleting;
  assert.equal(context.flow.loadRecs().length,0);assert.equal(context.flow.getState(),null);
});

for(const outcome of ['success','rejected','not-deleted']){
  test(`whole-history deletion blocks new starts until a ${outcome} response and then restores them`,async()=>{
    const removal=deferred(),calls=[];
    const {document,context}=conversationHarness((path,options)=>{
      calls.push([path,options?.body]);
      return path==='/api/conversations'?removal.promise:Promise.resolve({...conversationView('새 대화'),id:'new-intake'});
    },{realUI:true});
    document.getElementById('rlist').innerHTML='<button data-go>시작</button><button id="go">시작</button><button id="crTalk">시작</button>';
    const starts=document.querySelectorAll('[data-go],#go,#crTalk');
    starts.forEach(button=>button.disabled=false);
    context.flow.setHistory({records:[historyRecord],incomplete_intakes:[incompleteSummary],conversation_epoch:2});
    const view=conversationView('이전 대화');context.flow.renderConversation(view,0);context.flow.show('chat');
    document.getElementById('ta').value='아직 전송하지 않은 말';
    const deleting=context.flow.deleteConversations();
    const completion=outcome==='success'?deleting:assert.rejects(deleting,/삭제/);
    assert.ok(starts.every(button=>button.disabled));
    await context.flow.begin();
    assert.equal(calls.length,1,'No creation request may race a pending whole-history deletion');
    assert.equal(context.flow.getState(),view);
    assert.equal(document.getElementById('ta').value,'아직 전송하지 않은 말');
    if(outcome==='rejected')removal.reject(new Error('삭제 요청 실패'));
    else removal.resolve({deleted:outcome==='success',conversation_epoch:3});
    await completion;
    assert.ok(starts.every(button=>button.disabled===false));
    if(outcome!=='success'){
      assert.equal(context.flow.getState(),view);assert.equal(context.flow.loadRecs()[0],historyRecord);
      assert.equal(document.getElementById('ta').value,'아직 전송하지 않은 말');
    }
    await context.flow.begin();
    assert.equal(calls.at(-1)[1].conversation_epoch,outcome==='success'?3:2);
    assert.equal(context.flow.getState().id,'new-intake');
  });
}

test('generation waiting uses animated dots without stage labels, counts or bars',()=>{
  const {document,context}=conversationHarness(async()=>{});
  context.ui.think(true);
  const root=document.getElementById('thinking'),waiting=root.querySelector('.waiting-dots');
  assert.equal(waiting.querySelector('.dots').children.length,3);
  assert.doesNotMatch(context.ui.progressMarkup(),/th-progress|th-count|th-steps|단계 완료/);
  for(const status of ['running','saving','complete','failed']){
    context.ui.thinkProgress({status,current:'문안 검토',attempt:2});
    assert.equal(waiting.getAttribute('aria-busy'),String(!['complete','failed'].includes(status)));
    assert.equal(waiting.textContent,'');
  }
});

test('conversation header fills by saved question steps and reserves the final step for completion',()=>{
  const {document,context}=conversationHarness(async()=>{});
  const view={...conversationView('친구'),questionIndex:3,totalQuestions:10};
  context.flow.renderConversation(view,0);
  const bar=document.getElementById('prog').parentElement;
  assert.equal(document.getElementById('prog').style.width,'30%');
  context.TopBar=content=>content;
  assert.doesNotMatch(context.ui.render(),/chatProgressCount|단계 완료/);
  assert.equal(bar.getAttribute('aria-valuetext'),'바람');
  context.ui.progress(100,{index:10,total:10,label:'마무리',complete:false});
  assert.equal(document.getElementById('prog').style.width,'90%');
  context.ui.progress(100,{index:10,total:10,label:'마무리',complete:true});
  assert.equal(document.getElementById('prog').style.width,'100%');
  assert.equal(bar.getAttribute('aria-valuetext'),'대화를 마쳤어요');
});

test('the pending result shows each card’s current work and changes to saving',()=>{
  const {document,context}=conversationHarness(async()=>{});
  vm.runInContext(script('components/ResultScreen.js')+'\nglobalThis.resultScreen=ResultScreen;',context);
  context.resultScreen.prepare({name:'친구'});
  const card=document.getElementById('rbody').querySelector('.result-pending');
  assert.equal(document.getElementById('result').hidden,false);
  assert.equal(card.querySelector('.dots'),null);
  assert.equal(card.querySelectorAll('[data-stage-card]').length,6);
  const stage=id=>card.querySelector(`[data-stage-card="${id}"]`).querySelector('.result-stage-status');
  assert.equal(stage('script').textContent,'차례를 기다리고 있어요');
  context.resultScreen.progress({status:'running',card_stages:{script:'첫마디를 만들고 있어요',care:'답변과 대조하고 있어요'}});
  assert.equal(stage('script').textContent,'첫마디를 만들고 있어요');
  assert.equal(stage('care').textContent,'답변과 대조하고 있어요');
  assert.equal(stage('avoid').textContent,'차례를 기다리고 있어요');
  assert.ok(stage('script').classList.contains('is-active'));
  context.resultScreen.previewCards.set('care',{});
  context.resultScreen.progress({status:'running',card_stages:{script:'문장을 다듬고 있어요'}});
  assert.equal(card.querySelector('[data-stage-card="care"]').hidden,true);
  assert.equal(stage('script').textContent,'문장을 다듬고 있어요');
  context.resultScreen.progress({status:'running',card_stages:{care:'전체 안내를 최종 확인하고 있어요',script:'문장을 다듬고 있어요'}});
  assert.equal(card.querySelector('[data-stage-card="care"]').hidden,true,'a displayed card does not return to the progress list during a later review');
  for(const id of ['relationship','script','doList','avoid','next'])context.resultScreen.previewCards.set(id,{});
  context.resultScreen.progress({status:'running',step_index:3,card_stages:{care:'전체 안내를 최종 확인하고 있어요'}});
  assert.equal(card.querySelector('.result-stages').hidden,true);
  assert.match(card.querySelector('h3').textContent,/마지막으로 확인하고 있어요/);
  context.resultScreen.previewCards.clear();context.resultScreen.previewCards.set('care',{});
  context.resultScreen.progress({status:'running',card_stages:{script:'문장을 다듬고 있어요'}});
  assert.equal(card.querySelector('.result-stages').hidden,false);
  context.resultScreen.progress({status:'saving'});
  assert.equal(card.querySelector('.result-stages').hidden,true);
  assert.match(card.querySelector('h3').textContent,/기록에 저장하고 있어요/);
  context.resultScreen.progress({status:'failed'});
  context.resultScreen.previewCards.clear();
  context.resultScreen.pendingError('잠시 후 다시 시도해 주세요.',()=>{});
  assert.equal(card.hidden,false);
  assert.equal(card.getAttribute('role'),'alert');
  assert.equal(card.querySelector('[role="progressbar"]'),null);
});

function controlProgressTimers(context){
  let nextId=0;const timers=new Map();
  context.setTimeout=(run,delay)=>{const id=++nextId;timers.set(id,{run,delay});return id;};
  context.clearTimeout=id=>timers.delete(id);
  return {timers,run(delay){const [id,timer]=[...timers].find(([,timer])=>delay===undefined||timer.delay===delay)||[];assert.ok(timer,'expected a scheduled timer');timers.delete(id);return timer.run();}};
}

test('result polling forwards real server step metadata into the visible pending card',async()=>{
  const result=deferred(),progress=generationProgress();
  progress.cardProcess({stage:'guide_write',status:'started',token:Symbol()});
  const {document,context}=conversationHarness(path=>path.endsWith('/progress')?Promise.resolve({revision:1,progress:progress.state}):result.promise);
  vm.runInContext(script('components/ResultScreen.js')+'\nglobalThis.resultScreen=ResultScreen;',context);
  const clock=controlProgressTimers(context);
  context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish();
  assert.equal(document.getElementById('result').hidden,false);
  await clock.run();
  const card=document.getElementById('rbody').querySelector('.result-pending');
  assert.match(card.querySelector('[data-stage-card="script"]').textContent,/카드 초안을 작성하고 있어요/);
  assert.match(card.querySelector('[data-stage-card="relationship"]').textContent,/차례를 기다리고 있어요/);
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
  context.flow.show('records');result.resolve({revision:2,record:historyRecord});await finishing;
  assert.equal(clock.timers.size,0);
});

test('generation polling ignores other revisions, recovers after network errors and stops after the result',async()=>{
  const result=deferred(),calls=[];let pollCount=0;
  const {document,context}=conversationHarness(path=>{
    calls.push(path);
    if(path.endsWith('/result'))return result.promise;
    if(++pollCount===1)return Promise.reject(new Error('temporary network failure'));
    const progress=generationProgress();progress.event({stage:'communication_plan',status:'started'});
    return Promise.resolve({revision:pollCount===2?99:1,progress:progress.state});
  });
  const clock=controlProgressTimers(context);context.ResultScreen={open(){}};
  context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish();
  await clock.run();
  assert.equal(document.getElementById('thinking').querySelector('.th-err').hidden,true);
  await clock.run();
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
  await clock.run();
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
  result.resolve({revision:2,record:historyRecord});await finishing;
  assert.equal(document.getElementById('thinking').hidden,true);assert.equal(clock.timers.size,0);
  assert.equal(calls.filter(path=>path.endsWith('/progress')).length,3);
  assert.equal(context.flow.loadRecs()[0],historyRecord);
});

test('a hung progress GET times out, aborts and reconnects without waiting for its stale response',async()=>{
  const result=deferred(),hung=deferred(),signals=[];let polls=0;
  const {document,context}=conversationHarness((path,options)=>{
    if(path.endsWith('/result'))return result.promise;
    signals.push(options.signal);return ++polls===1?hung.promise:Promise.resolve({revision:1,progress:{status:'running'}});
  });
  const clock=controlProgressTimers(context);context.ResultScreen={open(){}};
  context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish(),polling=clock.run(250);
  assert.equal(signals[0].aborted,false);await clock.run(8000);await polling;
  assert.equal(signals[0].aborted,true);assert.equal(clock.timers.size,1);
  await clock.run(500);assert.equal(polls,2);
  hung.resolve({revision:1,progress:{status:'complete'}});await settleUI();
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
  result.resolve({revision:2,record:historyRecord});await finishing;assert.equal(clock.timers.size,0);
});

test('progress requests back off for the shared-IP rate limit',async()=>{
  const result=deferred();
  const {context}=conversationHarness(path=>path.endsWith('/result')?result.promise:Promise.reject(Object.assign(new Error('rate limited'),{status:429})));
  const clock=controlProgressTimers(context);context.ResultScreen={open(){}};context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish();await clock.run(250);
  assert.deepEqual([...clock.timers.values()].map(timer=>timer.delay),[60000]);
  result.resolve({revision:2,record:historyRecord});await finishing;assert.equal(clock.timers.size,0);
});

for(const ending of ['complete','leave','delete'])test(`a pending progress GET is aborted immediately on ${ending}`,async()=>{
  const result=deferred(),hung=deferred();let progressSignal;
  const {context}=conversationHarness((path,options)=>{
    if(options?.method==='DELETE')return Promise.resolve({deleted:true,record_ids:[]});
    if(path.endsWith('/progress')){progressSignal=options.signal;return hung.promise;}
    return result.promise;
  });
  const clock=controlProgressTimers(context);context.ResultScreen={open(){}};
  context.flow.renderConversation(conversationView('친구'),0);context.flow.show('chat');
  const finishing=context.flow.finish(),polling=clock.run(250);
  if(ending==='leave')context.flow.leaveConversation();
  else if(ending==='delete')await context.flow.deleteCurrentConversation();
  else result.resolve({revision:2,record:historyRecord});
  await settleUI();assert.equal(progressSignal.aborted,true);await polling;
  assert.equal(clock.timers.size,0);
  if(ending!=='complete')result.resolve({revision:2,record:historyRecord});
  await finishing;
});

for(const ending of ['complete','failure','leave','delete']){
  test(`a progress response after ${ending} cannot update the guide loading state`,async()=>{
    const result=deferred(),progress=deferred();
    const {document,context}=conversationHarness((path,options)=>{
      if(options?.method==='DELETE')return Promise.resolve({deleted:true,record_ids:[]});
      return path.endsWith('/progress')?progress.promise:result.promise;
    });
    const clock=controlProgressTimers(context);context.ResultScreen={open(){}};
    context.flow.renderConversation(conversationView('친구'),0);context.flow.show('chat');
    const finishing=context.flow.finish(),polling=clock.run();
    if(ending==='delete')await context.flow.deleteCurrentConversation();
    else if(ending==='leave')context.flow.leaveConversation();
    if(ending==='failure')result.reject(Object.assign(new Error('안내 준비 실패'),{status:502}));
    else result.resolve({revision:2,record:historyRecord});
    await finishing;
    progress.resolve({revision:1,progress:{status:'running',completed:[{label:'늦게 도착한 단계'}],current:'늦게 도착한 진행',attempt:1}});
    await polling;
  assert.equal(document.getElementById('thinking').querySelector('.waiting-dots').getAttribute('aria-busy'),'true');
    assert.doesNotMatch(document.getElementById('thinking').textContent,/늦게 도착한/);
    assert.equal(clock.timers.size,0);
    if(ending==='failure'){
      assert.equal(document.getElementById('thinking').querySelector('.th-err').hidden,false);
      assert.equal(document.getElementById('thinking').querySelectorAll('.now').length,0);
    }
    if(ending==='delete')assert.equal(context.flow.getState(),null);
  });
}

for(const type of ['text','one','multi'])test(`typing ahead transfers into the next ${type} question without submitting early`,async()=>{
  const response=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push(options.body);return response.promise;},{realUI:true});
  const view=conversationView('친구');context.flow.renderConversation(view,0);
  document.getElementById('ta').value='첫 답변';document.getElementById('send').click();
  const ahead=document.getElementById('next-answer');assert.equal(ahead.disabled,false);
  ahead.value='다음 답변 초안';document.getElementById('send').click();
  assert.equal(calls.length,1);assert.equal(calls[0].text,'첫 답변');
  response.resolve({...view,revision:2,question:{id:'next',type,opts:['선택'],required:true}});await settleUI();
  assert.equal(document.getElementById(type==='text'?'ta':'own').value,'다음 답변 초안');
  assert.equal(calls.length,1);assert.equal(document.getElementById('input').dataset.busy,'');
});

test('returning to a previous question keeps typing available without exposing or submitting it early',async()=>{
  const response=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push([path,options.body]);return response.promise;},{realUI:true});
  const view={...conversationView('친구'),log:[prompt],canGoBack:true};context.flow.renderConversation(view,0);
  document.getElementById('ta').value='현재 질문의 보내지 않은 답변';
  const back=document.getElementById('input').querySelector('.back');back.click();back.click();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/intakes/intake-1/back');
  assert.deepEqual(structuredClone(calls[0][1]),{revision:1});
  const ahead=document.getElementById('next-answer');assert.equal(ahead.disabled,false);assert.equal(ahead.focused,true);
  ahead.value='이전 답변에 보탤 초안';
  assert.ok(document.getElementById('log').querySelector('.dots'));
  assert.equal(document.getElementById('log').querySelector('.me'),null);
  assert.equal(document.getElementById('log').textContent.includes(nextPrompt.text),false);
  response.resolve({...view,revision:2,log:[nextPrompt],question:{id:'previous',type:'text',required:true}});await settleUI();
  assert.equal(document.getElementById('ta').value,'이전 답변에 보탤 초안');
  assert.equal(calls.length,1);assert.equal(document.getElementById('input').dataset.busy,'');
});

test('failed previous-question navigation restores the original editor and retains its separate typing-ahead draft',async()=>{
  const first=deferred(),second=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push([path,options.body]);return calls.length===1?first.promise:second.promise;},{realUI:true});
  const view={...conversationView('친구'),canGoBack:true};context.flow.renderConversation(view,0);
  document.getElementById('ta').value='현재 질문의 초안';document.getElementById('input').querySelector('.back').click();
  document.getElementById('next-answer').value='앞 질문에 쓸 내용';
  first.reject(new Error('잠시 실패'));await settleUI();
  assert.equal(document.getElementById('ta').value,'현재 질문의 초안');
  assert.equal(document.getElementById('ta').parentElement.hidden,false);
  assert.equal(document.getElementById('next-answer').value,'앞 질문에 쓸 내용');
  assert.equal(document.getElementById('input').dataset.busy,'');
  document.getElementById('input').querySelector('.api-error').querySelector('button').click();
  assert.deepEqual(calls[1],calls[0]);
  second.resolve({...view,revision:2,question:{id:'previous',type:'one',opts:['예','아니요'],noOwn:true}});await settleUI();
  assert.equal(document.getElementById('next-answer').value,'앞 질문에 쓸 내용');
  assert.equal(document.getElementById('input').querySelector('.chip').getAttribute('aria-pressed'),'false');
  assert.equal(calls.length,2);
});

test('typing ahead survives a failed request and retry without replacing the submitted answer',async()=>{
  const first=deferred(),second=deferred(),calls=[];
  const {document,context}=conversationHarness((path,options)=>{calls.push(options.body);return calls.length===1?first.promise:second.promise;},{realUI:true});
  const view=conversationView('친구');context.flow.renderConversation(view,0);
  document.getElementById('ta').value='전송한 답변';document.getElementById('send').click();
  document.getElementById('next-answer').value='미리 쓴 답변';
  first.reject(new Error('잠시 실패'));await settleUI();
  assert.equal(document.getElementById('ta').value,'전송한 답변');
  assert.equal(document.getElementById('next-answer').value,'미리 쓴 답변');
  document.getElementById('input').querySelector('.api-error').querySelector('button').click();
  assert.deepEqual(calls[1],calls[0]);
  second.resolve({...view,revision:2,question:{id:'next',type:'text'}});await settleUI();
  assert.equal(document.getElementById('ta').value,'미리 쓴 답변');
});

test('typing ahead remains available across choice-only questions and clears for another conversation',async()=>{
  const response=deferred();
  const {document,context}=conversationHarness(()=>response.promise,{realUI:true});
  const view=conversationView('친구');context.flow.renderConversation(view,0);
  document.getElementById('ta').value='전송';document.getElementById('send').click();
  document.getElementById('next-answer').value='보관할 초안';
  response.resolve({...view,revision:2,question:{id:'next',type:'one',opts:['예','아니요'],noOwn:true}});await settleUI();
  assert.equal(document.getElementById('next-answer').value,'보관할 초안');
  context.flow.renderConversation({...view,id:'another'},0);
  assert.equal(document.getElementById('next-answer'),null);assert.equal(document.getElementById('ta').value,'');
});

function progressiveResultHarness(request=async()=>{},{animate=false}={}){
  const fixture=conversationHarness(request),{context}=fixture;
  context.CrisisLine=()=>'';
  vm.runInContext(script('components/GuideCards.js')+script('components/ResultScreen.js')+'\nglobalThis.resultScreen=ResultScreen;',context);
  if(!animate)context.resultScreen.animate=()=>{};
  return fixture;
}

test('approved result cards appear in completion order while the remaining cards show progress',()=>{
  const {document,context}=progressiveResultHarness(),screen=context.resultScreen;
  screen.prepare(conversationView('친구'));
  const next={id:'next',value:'다음 행동'},care={id:'care',value:{feel:'돌봄 안내',tips:['휴식']}};
  screen.partial([next]);
  const stream=document.getElementById('rbody').querySelector('.result-stream'),first=stream.children[0];
  assert.deepEqual(stream.children.map(node=>node.dataset.card),['next']);
  screen.partial([next,care]);
  assert.deepEqual(stream.children.map(node=>node.dataset.card),['next','care']);
  assert.equal(stream.children[0],first,'polling preserves existing cards');
  screen.partial([care,next]);
  assert.deepEqual(stream.children.map(node=>node.dataset.card),['care','next']);
  assert.equal(stream.children[1],first,'remove and reapproval between polls preserves the DOM while reordering');
  screen.progress({status:'running',card_stages:{script:'첫마디를 만들고 있어요'}});
  const pending=document.getElementById('rbody').querySelector('.result-pending');
  assert.equal(pending.querySelector('[data-stage-card="care"]').hidden,true);
  assert.equal(pending.querySelector('[data-stage-card="next"]').hidden,true);
  assert.match(pending.querySelector('[data-stage-card="script"]').textContent,/첫마디를 만들고 있어요/);
  assert.doesNotMatch(document.getElementById('rbody').textContent,/기록으로 저장/);
  screen.partial([care]);assert.deepEqual(stream.children.map(node=>node.dataset.card),['care']);
  screen.partial([]);assert.equal(stream.children.length,0);
});

for(const firstId of ['doList','avoid'])test(`partial actions pair without recreating cards when ${firstId} finishes first`,()=>{
  const {document,context}=progressiveResultHarness(),screen=context.resultScreen;
  screen.prepare(conversationView('친구'));
  const first={id:firstId,value:['먼저 완료된 행동']},second={id:firstId==='doList'?'avoid':'doList',value:['나중에 완료된 행동']},next={id:'next',value:'다음 안내'};
  screen.partial([first]);
  const stream=document.getElementById('rbody').querySelector('.result-stream'),firstNode=stream.children[0],firstCard=firstNode.children[0];
  assert.equal(firstNode.dataset.card,firstId);assert.equal(stream.querySelector('.two'),null,'one finished card is immediately visible');
  screen.partial([first,next,second]);
  const pair=stream.querySelector('.two'),nextNode=stream.children[1];
  assert.equal(pair,stream.children[0]);assert.equal(pair.classList.contains('guide-actions'),true);
  assert.deepEqual(pair.children.map(node=>node.dataset.card),['doList','avoid']);
  assert.equal(pair.children.find(node=>node.dataset.card===firstId),firstNode);assert.equal(firstNode.children[0],firstCard);
  screen.partial([next,second,first]);
  assert.equal(stream.children[0],nextNode);assert.equal(stream.children[1],pair,'the pair follows the earliest remaining action position');
  assert.equal(firstNode.children[0],firstCard,'repeated polls do not recreate inner card content');
  screen.partial([next,first]);
  assert.equal(stream.querySelector('.two'),null);assert.equal(stream.children[1],firstNode);assert.equal(firstNode.children[0],firstCard);
  assert.doesNotMatch(stream.textContent,/나중에 완료된 행동/,'a revoked card disappears from the pair');
  screen.partial([next,first,second]);
  assert.deepEqual(stream.querySelector('.two').children.map(node=>node.dataset.card),['doList','avoid']);
  assert.equal(firstNode.children[0],firstCard);
  screen.pendingError('다시 준비해 주세요',()=>{});assert.equal(stream.children.length,0,'failure clears paired cards and their wrapper');
});

test('partial speech keeps the full reference layout and copy control across polls',async()=>{
  const {document,context}=progressiveResultHarness(),screen=context.resultScreen;let copied;
  context.navigator={clipboard:{writeText:async text=>{copied=text;}}};
  screen.prepare(conversationView('친구'));
  const detail=Object.fromEntries(['opening','listening','offer'].map(key=>[key,{excerpt:'분리된 단계',why:'별도 이유',evidence:[{quote:'별도 근거'}]}]));
  const card={id:'script',value:'전체 발화\n\n마지막 문장',detail};
  screen.partial([card]);
  const stream=document.getElementById('rbody').querySelector('.result-stream'),node=stream.children[0],button=node.querySelector('.copy');
  assert.equal(node.querySelector('.speech-text').textContent,card.value);assert.equal(node.querySelectorAll('details').length,0);
  assert.doesNotMatch(node.textContent,/분리된 단계|별도 이유|별도 근거/);assert.equal(document.getElementById('cp'),null);
  await button.click();assert.equal(copied,card.value);
  screen.partial([card]);assert.equal(node.querySelector('.copy'),button);assert.equal(button.textContent,'복사했어요');
  const updated={...card,value:'검토된 전체 발화\n새 마지막 문장'};
  screen.partial([updated]);assert.equal(stream.children[0],node);
  await node.querySelector('.copy').click();assert.equal(copied,updated.value);assert.equal(node.querySelector('.speech-text').textContent,updated.value);
});

test('partial next preserves its node while approved care tips arrive, change or are revoked',()=>{
  const {document,context}=progressiveResultHarness(),screen=context.resultScreen;
  screen.prepare(conversationView('친구'));
  const next={id:'next',value:'다음 행동'},care={id:'care',value:{feel:'공감',tips:['첫 도움말','나머지 도움말','마지막 도움말']}};
  screen.partial([next]);
  const stream=document.getElementById('rbody').querySelector('.result-stream'),node=stream.children[0];
  assert.doesNotMatch(node.textContent,/당신을 위해서도/);
  screen.partial([next,care]);
  assert.equal(stream.children[0],node);assert.match(node.textContent,/당신을 위해서도: 나머지 도움말 마지막 도움말/);
  assert.doesNotMatch(node.textContent,/첫 도움말/);
  assert.match(stream.children[1].textContent,/첫 도움말/);assert.doesNotMatch(stream.children[1].textContent,/나머지 도움말|마지막 도움말/);
  const updated={...care,value:{...care.value,tips:['수정된 첫 도움말','수정된 나머지 도움말']}};
  screen.partial([next,updated]);
  assert.equal(stream.children[0],node);assert.match(node.textContent,/당신을 위해서도: 수정된 나머지 도움말/);assert.doesNotMatch(node.textContent,/마지막 도움말/);
  screen.partial([next]);
  assert.equal(stream.children[0],node);assert.doesNotMatch(node.textContent,/당신을 위해서도|도움말/);
  screen.partial([care,next]);
  assert.equal(stream.children[1],node);assert.match(node.textContent,/나머지 도움말 마지막 도움말/);
  screen.pendingError('다시 준비해 주세요',()=>{});assert.equal(stream.children.length,0);
});

test('reviewed card replacements escape model text and failures clear partial content',()=>{
  const {document,context}=progressiveResultHarness(),screen=context.resultScreen;
  screen.prepare(conversationView('친구'));
  screen.partial([{id:'next',value:'첫 안내'}]);
  const stream=document.getElementById('rbody').querySelector('.result-stream'),node=stream.children[0];
  screen.partial([{id:'next',value:'<script>공격</script> 검토된 수정'}]);
  assert.equal(stream.children[0],node);assert.equal(node.querySelector('script'),null);
  screen.pendingError('다시 준비해 주세요',()=>{});
  assert.equal(stream.children.length,0);assert.doesNotMatch(document.getElementById('rbody').textContent,/기록으로 저장/);
});

test('polled cards precede the final result, and only the confirmed saved record replaces them',async()=>{
  const result=deferred();
  const next={id:'next',value:'먼저 준비된 안내'};
  const {document,context}=progressiveResultHarness(path=>path.endsWith('/progress')?Promise.resolve({revision:1,progress:{status:'running'},cards:[next]}):result.promise);
  const clock=controlProgressTimers(context);
  context.flow.renderConversation(conversationView('친구'),0);
  const finishing=context.flow.finish();await clock.run();
  assert.match(document.getElementById('rbody').textContent,/먼저 준비된 안내/);
  assert.equal(context.flow.loadRecs().length,0);
  const record={...historyRecord,guide:{...historyRecord.guide,next:'최종 검토된 안내',care:{feel:'공감',tips:['휴식']},doList:['경청'],avoid:['재촉']}};
  result.resolve({revision:2,record});await finishing;
  assert.match(document.getElementById('rbody').textContent,/최종 검토된 안내/);
  assert.match(document.getElementById('rbody').textContent,/기록으로 저장했어요/);
  assert.equal(document.getElementById('rbody').querySelector('.result-stream'),null);
  assert.equal(context.flow.loadRecs()[0],record);assert.equal(clock.timers.size,0);
});

test('unchanged reviewed previews remain visible when saved results replace the pending screen',()=>{
  const {document,context}=progressiveResultHarness(undefined,{animate:true}),screen=context.resultScreen,revealed=[];
  context.reveal=(nodes)=>revealed.push([...nodes]);
  const guide={top:'통합',script:'이미 검토된 대화 문장',care:{feel:'공감',tips:['휴식']},doList:['경청'],avoid:['재촉'],next:'다음 안내'};
  screen.prepare(conversationView('친구'));
  screen.partial(['script','doList','avoid'].map(id=>({id,value:guide[id]})));
  screen.open({name:'친구'},guide,true);
  const body=document.getElementById('rbody'),appearing=revealed[1];
  for(const selector of ['.script','.do','.avoid']){
    assert.equal(appearing.includes(body.querySelector(selector)),false);
    assert.equal(body.querySelector(selector).classList.contains('pop'),false);
  }
  assert.ok(appearing.includes(body.querySelector('.care')));assert.ok(body.querySelector('.two'));
  assert.match(body.textContent,/기록으로 저장했어요/);assert.ok(body.querySelector('.copy'));
  revealed.length=0;screen.open({name:'친구'},guide,true);
  assert.ok(revealed[1].includes(body.querySelector('.script')),'a newly opened result retains the original animation');
});

test('a changed final card is not mistaken for an already-visible reviewed preview',()=>{
  const {document,context}=progressiveResultHarness(undefined,{animate:true}),screen=context.resultScreen,revealed=[];
  context.reveal=nodes=>revealed.push([...nodes]);screen.prepare(conversationView('친구'));
  screen.partial([{id:'script',value:'이전 검토 문장'}]);
  screen.open({name:'친구'},{top:'통합',script:'새로 검토된 문장',care:{feel:'공감',tips:[]},doList:[],avoid:[],next:'다음'},true);
  assert.ok(revealed[1].includes(document.getElementById('rbody').querySelector('.script')));
});

test('opening a record with a key renders it without importing ownership or key-management controls', async () => {
  const document=documentWith(['records','rdetail','recordAccessKeyInput','recordAccessKeyNotice','openRecordWithKey']);
  const record={id:21,title:'보관한 기록',date:'2026-10-29T00:00:00Z',profile:{},guide:{top:'통합',script:'안녕',next:'다음'},log:[]};
  const calls=[];
  const context=vm.createContext({document,M:{},GuideCards:{doAvoid:()=>'',speech:g=>g.script,next:g=>g.next,bindCopy(){}},API:{async request(path,options){calls.push({path,options});return {record};}}});
  vm.runInContext(script('core/utils.js')+script('components/RecordsScreen.js')+'\nglobalThis.screen=RecordsScreen;',context);
  document.getElementById('recordAccessKeyInput').value='a'.repeat(43);
  await context.screen.openWithKey();
  assert.equal(calls[0].path,'/api/records/open-with-key');
  assert.equal(calls[0].options.body.access_key,'a'.repeat(43));
  assert.equal(document.getElementById('recordAccessKeyInput').value,'');
  assert.match(document.getElementById('rdetail').textContent,/보관한 기록/);
  assert.equal(document.getElementById('createRecordKey'),null);
  assert.equal(document.getElementById('revokeRecordKey'),null);
});

test('additional-question entry survives appended key controls without replacing original record cards',()=>{
  const document=documentWith(['rdetail']),opened=[];
  const record={id:22,title:'원래 기록',date:'2026-11-01T00:00:00Z',profile:{},guide:{top:'통합',script:'원래 대화문',next:'원래 다음 단계'},log:[]};
  const context=vm.createContext({document,M:{},GuideCards:{doAvoid:()=>'',speech:g=>`<div class="card script">${g.script}</div>`,next:g=>`<div class="card next">${g.next}</div>`,bindCopy(){}},ContinuationScreen:{start:id=>opened.push(id)}});
  vm.runInContext(script('core/utils.js')+script('components/RecordsScreen.js')+'\nglobalThis.screen=RecordsScreen;',context);
  context.screen.renderDetail(record);
  assert.equal(document.getElementById('rdetail').querySelector('.script').textContent,'원래 대화문');
  assert.equal(document.getElementById('rdetail').querySelector('.next').textContent,'원래 다음 단계');
  assert.ok(document.getElementById('createRecordKey'));
  document.getElementById('recordContinue').click();assert.deepEqual(opened,[22]);
  context.screen.renderDetail(record,true);
  assert.equal(document.getElementById('recordContinue'),null);
  assert.equal(document.getElementById('rdetail').querySelector('.script').textContent,'원래 대화문');
});

test('v3 single choice waits for Send and submits the selected purpose together with typed details', async () => {
  const document = documentWith(['input']);
  const context = vm.createContext({document,submitted:[],setTimeout,clearTimeout});
  vm.runInContext(script('core/utils.js')+script('core/questions.js')+script('components/ChatInput.js')+';globalThis.inputUI=ChatInput;',context);
  context.inputUI.render({id:'q3_01',type:'one',opts:[['목적',{value:'T1'}]],allowCustomWithSelection:true,response_controls:true},(...args)=>context.submitted.push(args));
  await document.querySelectorAll('.chip')[0].click();
  assert.equal(context.submitted.length,0);
  document.getElementById('own').value='추가로 원하는 내용';
  await document.getElementById('ownSend').click();
  assert.equal(context.submitted[0][0],'목적, 추가로 원하는 내용');
  assert.deepEqual(Array.from(context.submitted[0][1]),[0]);
  assert.equal(context.submitted[0][2],'추가로 원하는 내용');
});

test('v3 single choice can be cleared before Send without losing custom input',async()=>{
  const document=documentWith(['input']),submitted=[],context=vm.createContext({document,setTimeout,clearTimeout});
  vm.runInContext(script('core/utils.js')+script('core/questions.js')+script('components/ChatInput.js')+';globalThis.inputUI=ChatInput;',context);
  context.inputUI.render({id:'q3_05',type:'one',opts:['아직 아무것도 하지 않았어요'],allowCustomWithSelection:true},(...args)=>submitted.push(args));
  const chip=document.querySelectorAll('.chip')[0];
  await chip.click();document.getElementById('own').value='제가 먼저 말을 걸었어요.';await chip.click();
  assert.equal(chip.getAttribute('aria-pressed'),'false');
  assert.equal(document.getElementById('own').value,'제가 먼저 말을 걸었어요.');
  assert.equal(submitted.length,0);
  await document.getElementById('ownSend').click();
  assert.equal(submitted[0][0],'제가 먼저 말을 걸었어요.');assert.deepEqual(Array.from(submitted[0][1]),[]);
});

test('v3 choosing another single option replaces the selection and retains custom input',async()=>{
  const document=documentWith(['input']),submitted=[],context=vm.createContext({document,setTimeout,clearTimeout});
  vm.runInContext(script('core/utils.js')+script('core/questions.js')+script('components/ChatInput.js')+';globalThis.inputUI=ChatInput;',context);
  context.inputUI.render({id:'q3_01',type:'one',opts:['첫 목적','바꾼 목적'],allowCustomWithSelection:true},(...args)=>submitted.push(args));
  const chips=document.querySelectorAll('.chip');await chips[0].click();document.getElementById('own').value='세부 내용';await chips[1].click();
  assert.deepEqual(chips.map(chip=>chip.getAttribute('aria-pressed')),['false','true']);assert.equal(submitted.length,0);
  await document.getElementById('ownSend').click();
  assert.equal(submitted[0][0],'바꾼 목적, 세부 내용');assert.deepEqual(Array.from(submitted[0][1]),[1]);
});

test('legacy single choice still submits immediately even when the selected option is clicked again',async()=>{
  const document=documentWith(['input']),submitted=[],context=vm.createContext({document,setTimeout,clearTimeout});
  vm.runInContext(script('core/utils.js')+script('core/questions.js')+script('components/ChatInput.js')+';globalThis.inputUI=ChatInput;',context);
  context.inputUI.render({id:'legacy',type:'one',opts:['보기']},(...args)=>submitted.push(args));
  const chip=document.querySelectorAll('.chip')[0];await chip.click();await chip.click();
  assert.equal(submitted.length,2);assert.equal(chip.getAttribute('aria-pressed'),'true');
  assert.deepEqual(Array.from(submitted[1][1]),[0]);
});

test('v3 explicit response controls preserve typed safety content and send a separate intent', async () => {
  for (const [label,event] of [['잘 모르겠어요','unknown'],['답하고 싶지 않아요','refused'],['질문 설명','not_understood'],['여기까지 할게요','stop']]) {
    const document = documentWith(['input']);
    const context = vm.createContext({document,submitted:[],setTimeout,clearTimeout});
    vm.runInContext(script('core/utils.js')+script('core/questions.js')+script('components/ChatInput.js')+';globalThis.inputUI=ChatInput;',context);
    context.inputUI.render({id:'q3_03',type:'text',response_controls:true},(...args)=>context.submitted.push(args));
    document.getElementById('ta').value='남기려는 원문';
    await document.querySelectorAll('button').find(button=>button.textContent===label).click();
    assert.equal(context.submitted[0][0],'남기려는 원문');
    assert.equal(context.submitted[0][4],event);
  }
});

test('v3 pending stop restores retry-only UI and never reopens ordinary answer controls', async () => {
  const view={...conversationView(''),bundle_id:'malssi-intake-3.0.0-rc1',user_stopped:true,input_locked:true,model_pending:true,
    question:{id:'q3_03',type:'text',response_controls:true},pending_answer:{question_id:'q3_03',response_event:'stop',text:'마지막 원문',revision:0}};
  const {document,context}=conversationHarness(async()=>view,{realUI:true});
  context.ui.typing=(_,work)=>Promise.resolve(typeof work==='function'?work():work);
  await context.flow.begin();
  assert.equal(document.getElementById('ta'),null);
  assert.equal(document.getElementById('own'),null);
  const buttons=document.getElementById('input').querySelectorAll('button');
  assert.equal(buttons.length,1);
  assert.equal(buttons[0].textContent,'다시 시도');
  assert.equal(context.flow.getState().user_stopped,true);
});

test('v3 explicit stop acknowledgement does not request an ordinary result', async () => {
  const requests=[];
  const view={...conversationView(''),bundle_id:'malssi-intake-3.0.0-rc1',user_stopped:true,status:'ready',question:null};
  const {document,context}=conversationHarness(async(path)=>{requests.push(path);return view;},{realUI:true});
  context.ui.typing=(_,work)=>Promise.resolve(typeof work==='function'?work():work);
  await context.flow.begin();
  assert.ok(document.getElementById('input').textContent.includes('대화를 여기서 마쳤어요'));
  assert.equal(requests.some(path=>path.endsWith('/result')),false);
  assert.equal(document.getElementById('ta'),null);
});

test('public start screen never offers model settings, even with stale bootstrap data',()=>{
  const document=documentWith(['page']);let calls=0,args;
  const context=vm.createContext({document,NavBar:()=>'',loadRecs:()=>[],begin:(...value)=>{calls++;args=value;},
    API:{data:{model_profiles:[{id:'local12b',label:'12B',available:true},{id:'gpu31b',label:'31B',available:true}],default_model_profile:'gpu31b'}}});
  vm.runInContext(script('core/utils.js')+script('components/StartScreen.js')+'\nglobalThis.start=StartScreen;',context);
  document.getElementById('page').innerHTML=context.start.render();context.start.mount();
  assert.equal(document.getElementById('modelProfile'),null);
  document.getElementById('go').click();assert.equal(calls,1);assert.equal(args.length,0);
});

test('new conversation and retry never override the administrator model selection',async()=>{
  const sent=[];let retry,attempt=0;
  const {context}=conversationHarness(async(path,options)=>{
    if(path==='/api/intakes'){sent.push(options.body);if(++attempt===1)throw new Error('synthetic network failure');return conversationView('selected');}
    throw new Error(path);
  });
  context.StartScreen.selection=()=> 'gpu31b';context.ChatInput.error=(_message,handler)=>{retry=handler;};
  await context.flow.begin({modelProfileId:'gpu31b'});await retry();
  assert.equal(sent.length,2);
  for(const value of sent)assert.deepEqual(Object.keys(value),['conversation_epoch']);
});

test('stopped provisional danger proceeds to final safety verification without reopening questions',async()=>{
  const view={...conversationView(''),bundle_id:'malssi-intake-3.0.0-rc1',user_stopped:true,status:'ready',question:null,safety_urgent:false,safety_review_pending:true};
  const {context}=conversationHarness(async()=>view,{realUI:true});
  context.ui.typing=(_,work)=>Promise.resolve(typeof work==='function'?work():work);
  vm.runInContext('finish=()=>{globalThis.finalSafetyRequested=true;};',context);
  await context.flow.begin();assert.equal(context.finalSafetyRequested,true);
});
