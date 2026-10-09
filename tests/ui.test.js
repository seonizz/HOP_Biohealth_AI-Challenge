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

function conversationHarness(request) {
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'chatTitle', 'log', 'prog', 'sec', 'input', 'thinking', 'thRetry', 'leaveDlg', 'leaveGo']);
  document.getElementById('thinking').innerHTML='<ol><li></li><li></li><li></li></ol><div class="th-err" hidden></div>';
  const context = vm.createContext({
    document, window:{ scrollTo() {} }, StartScreen: { updRecN() {} },
    ChatInput: { clear() {}, render() {}, error(message) { throw new Error(message); } },
    API: { request },
  });
  vm.runInContext(script('core/utils.js') + script('components/ChatScreen.js') + script('core/conversation.js') + '\nglobalThis.ui = ChatScreen; globalThis.flow = { begin, leaveConversation, renderConversation, show, finish };', context);
  context.ui.typing = (_, work) => Promise.resolve(work);
  return { document, context };
}

const conversationView = chatTitle => ({
  id: 'intake-1', revision: 1, chat_title: chatTitle, name: '시연 친구', log: [], progress: 4,
  section: '바람', status: 'active', question: { id: 'want' }, canGoBack: false,
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
