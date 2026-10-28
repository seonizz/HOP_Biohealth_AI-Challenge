import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/components/ChatScreen.js', import.meta.url), 'utf8');

class EventTarget {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) { for (const callback of this.listeners.get(name) || []) callback(); }
}

class Element extends EventTarget {
  constructor(tagName, className = '') {
    super();
    this.tagName = tagName;
    this.className = className;
    this.children = [];
    this.hidden = false;
    this.scrollTop = 0;
    this.properties = new Map();
    this.style = {
      setProperty: (name, value) => this.properties.set(name, value),
      removeProperty: name => this.properties.delete(name),
    };
    const classes = new Set(className.split(' ').filter(Boolean));
    this.classList = {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    };
  }
  append(child) { this.children.push(child); child.parentElement = this; return child; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector) {
    return selector.split(',').some(part => part.startsWith('.') ? this.classList.contains(part.slice(1)) : part === this.tagName);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

// Only the event and geometry surface used by the controller is mocked. The
// production method runs unchanged, including frame scheduling and observers.
function harness({ width = 375, height = 812, visualViewport = true, rowClass = 'row' } = {}) {
  const window = new EventTarget();
  window.innerHeight = height;
  const viewport = Object.assign(new EventTarget(), { width, height, offsetTop: 0, scale: 1 });
  if (visualViewport) window.visualViewport = viewport;
  const chat = new Element('section');
  const body = chat.append(new Element('div', 'body'));
  const input = body.append(new Element('div', 'input'));
  const row = input.append(new Element('div', rowClass));
  const field = row.append(new Element('textarea'));
  const action = row.append(new Element('button'));
  const outside = new Element('button');
  const document = { activeElement: outside };
  const geometry = { bodyTop: 0, bodyBottom: height, rowTop: 600, rowHeight: 120, fieldHeight: 64 };
  body.getBoundingClientRect = () => ({ top: geometry.bodyTop, bottom: geometry.bodyBottom });
  row.getBoundingClientRect = () => ({ top: geometry.rowTop - body.scrollTop, bottom: geometry.rowTop + geometry.rowHeight - body.scrollTop });
  field.getBoundingClientRect = () => ({ top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().top + geometry.fieldHeight });
  action.getBoundingClientRect = () => ({ top: row.getBoundingClientRect().top + geometry.fieldHeight, bottom: row.getBoundingClientRect().bottom });
  const mutationObservers = [], resizeObservers = [], frames = new Map();
  let nextFrame = 0;
  const observer = registry => class {
    constructor(callback) { this.callback = callback; this.targets = new Map(); registry.push(this); }
    observe(target, options) { this.targets.set(target, options); }
  };
  const context = vm.createContext({
    window, document, $: id => ({ chat, input })[id],
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    MutationObserver: observer(mutationObservers), ResizeObserver: observer(resizeObservers),
  });
  vm.runInContext(`${source}\nglobalThis.screen = ChatScreen;`, context);
  context.screen.mountViewport();
  function flush() {
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback();
  }
  function focus(element = field) { document.activeElement = element; chat.dispatch('focusin'); }
  function changeViewport(values, layoutHeight) {
    Object.assign(viewport, values);
    if (layoutHeight !== undefined) { window.innerHeight = layoutHeight; window.dispatch('resize'); }
    viewport.dispatch('resize');
  }
  function notify(registry, target) {
    const found = registry.filter(observer => observer.targets.has(target));
    assert.ok(found.length, 'the relevant DOM change is observed');
    for (const observer of found) observer.callback([]);
  }
  flush();
  return { window, viewport, chat, body, input, row, field, action, outside, document, geometry, frames,
    mutationObservers, resizeObservers, flush, focus, changeViewport,
    mutate: target => notify(mutationObservers, target), resize: target => notify(resizeObservers, target),
  };
}

function assertRestored(h) {
  assert.equal(h.chat.classList.contains('keyboard-open'), false);
  assert.equal(h.chat.properties.has('--chat-visible-height'), false);
  assert.equal(h.chat.properties.has('--chat-visible-top'), false);
}

function assertControlsVisible(h) {
  const top = Math.max(h.geometry.bodyTop, h.viewport.offsetTop);
  const bottom = Math.min(h.geometry.bodyBottom, h.viewport.offsetTop + h.viewport.height);
  assert.ok(h.field.getBoundingClientRect().top >= top, 'input begins inside the visible area');
  assert.ok(h.action.getBoundingClientRect().bottom <= bottom, 'completion button ends inside the visible area');
}

test('visual viewport shrink and browser pan fit the chat while keeping both input and completion button visible', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420, offsetTop: 55 });
  h.flush();
  assert.equal(h.window.innerHeight, 812, 'layout viewport remains full height');
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assert.equal(h.chat.properties.get('--chat-visible-height'), '420px');
  assert.equal(h.chat.properties.get('--chat-visible-top'), '55px');
  assertControlsVisible(h);

  h.viewport.offsetTop = 90;
  h.viewport.dispatch('scroll');
  h.flush();
  assert.equal(h.chat.properties.get('--chat-visible-top'), '90px');
  assertControlsVisible(h);
});

test('a keyboard that shrinks layout and visual viewports together is detected from the resting height', () => {
  const h = harness({ rowClass: 'inrow' });
  h.focus();
  h.changeViewport({ height: 500 }, 500);
  h.geometry.bodyBottom = 500;
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assert.equal(h.chat.properties.get('--chat-visible-height'), '500px');
  assertControlsVisible(h);
});

test('the whole input row scrolls into view even when the input itself already fits', () => {
  const h = harness();
  h.geometry.rowTop = 350;
  h.geometry.fieldHeight = 40;
  h.focus();
  h.changeViewport({ height: 420 });
  assert.ok(h.field.getBoundingClientRect().bottom < h.viewport.height);
  assert.ok(h.action.getBoundingClientRect().bottom > h.viewport.height);
  h.flush();
  assert.ok(h.body.scrollTop > 0);
  assertControlsVisible(h);
});

test('a row above the visible viewport scrolls back down without hiding its action', () => {
  const h = harness();
  h.geometry.bodyTop = 100;
  h.geometry.rowTop = 180;
  h.body.scrollTop = 130;
  h.focus();
  h.changeViewport({ height: 420, offsetTop: 70 });
  h.flush();
  assert.ok(h.body.scrollTop < 130);
  assertControlsVisible(h);
});

test('keyboard dismissal restores normal layout while the text field stays focused', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  h.changeViewport({ height: 812, offsetTop: 0 });
  h.flush();
  assertRestored(h);
});

test('a normal short mobile viewport stays unchanged and restores after its keyboard closes', () => {
  const h = harness({ width: 375, height: 375 });
  h.focus();
  h.flush();
  assertRestored(h);
  assert.equal(h.body.scrollTop, 0, 'focus alone must not change a short page layout');
  h.changeViewport({ height: 220 });
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assertControlsVisible(h);
  h.changeViewport({ height: 375 });
  h.flush();
  assert.equal(h.document.activeElement, h.field);
  assertRestored(h);
});

test('completion-button focus preserves the visible row and navigating away clears viewport styles', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  h.focus(h.action);
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assertControlsVisible(h);
  h.chat.hidden = true;
  h.mutate(h.chat);
  h.flush();
  assertRestored(h);
});

test('pinch zoom is excluded and removes an existing keyboard layout override', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  h.changeViewport({ height: 300, scale: 1.5 });
  h.flush();
  assertRestored(h);
});

test('default desktop sizing and non-editable mobile focus keep the regular layout', () => {
  const desktop = harness({ width: 1440, height: 900 });
  desktop.focus();
  desktop.changeViewport({ height: 400 });
  desktop.flush();
  assertRestored(desktop);
  assert.equal(desktop.body.scrollTop, 0);

  const mobile = harness();
  mobile.focus(mobile.action);
  mobile.changeViewport({ height: 420 });
  mobile.flush();
  assertRestored(mobile);
});

test('browsers without visualViewport leave native focus behavior untouched', () => {
  const h = harness({ visualViewport: false });
  assertRestored(h);
  assert.equal(h.window.listeners.size, 0);
  assert.equal(h.chat.listeners.size, 0);
  assert.equal(h.mutationObservers.length, 0);
  assert.equal(h.resizeObservers.length, 0);
  assert.equal(h.frames.size, 0);
});

test('question changes and input resizing reveal moved controls and coalesce layout events', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  h.flush();
  h.flush();
  assertControlsVisible(h);
  const previousScroll = h.body.scrollTop;
  h.geometry.rowTop += 180;
  h.mutate(h.body);
  h.resize(h.input);
  h.viewport.dispatch('resize');
  h.window.dispatch('resize');
  assert.equal(h.frames.size, 1, 'one animation frame handles simultaneous layout changes');
  h.flush();
  assert.ok(h.body.scrollTop > previousScroll);
  assertControlsVisible(h);
});

test('header reflow that reduces available body height reveals the complete input row again', () => {
  const h = harness();
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  assertControlsVisible(h);
  const previousScroll = h.body.scrollTop;
  h.geometry.bodyBottom = 350;
  assert.ok(h.action.getBoundingClientRect().bottom > h.geometry.bodyBottom);
  h.resize(h.body);
  h.flush();
  assert.ok(h.body.scrollTop > previousScroll);
  assertControlsVisible(h);
});

test('the opening transition settles a late native focus scroll over subsequent frames', () => {
  const h = harness({ width: 320, height: 568 });
  h.geometry.bodyTop = 55;
  h.geometry.bodyBottom = 230;
  h.geometry.rowTop = 115;
  h.geometry.rowHeight = 145;
  h.geometry.fieldHeight = 92;
  h.focus();
  h.changeViewport({ height: 238 });
  h.flush();
  assertControlsVisible(h);
  // Mobile browser focus scrolling may settle after the viewport resize event.
  h.body.scrollTop = 14.65;
  assert.ok(h.action.getBoundingClientRect().bottom > h.geometry.bodyBottom);
  h.flush();
  h.flush();
  assertControlsVisible(h);
  assert.equal(h.frames.size, 0, 'the settling frame does not create a perpetual frame loop');
});

test('portrait-to-landscape rotation resets the resting height before keyboard open and close', () => {
  const h = harness({ width: 375, height: 812 });
  h.focus();
  h.flush();
  h.changeViewport({ width: 667, height: 375 }, 375);
  h.geometry.bodyBottom = 375;
  h.flush();
  assertRestored(h);
  assert.equal(h.body.scrollTop, 0, 'rotation alone must not be mistaken for an open keyboard');

  h.changeViewport({ height: 205 });
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assert.equal(h.chat.properties.get('--chat-visible-height'), '205px');
  assertControlsVisible(h);

  h.changeViewport({ height: 375 });
  h.flush();
  assert.equal(h.document.activeElement, h.field);
  assertRestored(h);
});

test('rotation while a keyboard remains open uses the new layout-to-visual viewport gap', () => {
  const h = harness({ width: 375, height: 812 });
  h.focus();
  h.changeViewport({ height: 420 });
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);

  h.changeViewport({ width: 667, height: 205 }, 375);
  h.geometry.bodyBottom = 375;
  h.flush();
  assert.equal(h.chat.classList.contains('keyboard-open'), true);
  assert.equal(h.chat.properties.get('--chat-visible-height'), '205px');
  assertControlsVisible(h);

  h.changeViewport({ height: 375 });
  h.flush();
  assertRestored(h);
});
