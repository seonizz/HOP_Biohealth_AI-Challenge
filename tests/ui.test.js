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
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  click() { return this.onclick?.({ target: this }); }
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
    getElementById(id) {
      const find = element => element.id === id ? element : element.children.map(find).find(Boolean);
      return roots.map(find).find(Boolean) ?? null;
    },
  };
}

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

function conversationHarness(request) {
  const document = documentWith(['start', 'chat', 'result', 'records', 'about', 'columns', 'chatTitle', 'log', 'prog', 'sec']);
  const context = vm.createContext({
    document, StartScreen: { updRecN() {} },
    ChatInput: { clear() {}, render() {}, error(message) { throw new Error(message); } },
    API: { request },
  });
  vm.runInContext(script('core/utils.js') + script('components/ChatScreen.js') + script('core/conversation.js') + '\nglobalThis.ui = ChatScreen; globalThis.flow = { begin, leaveConversation, renderConversation, show };', context);
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
