import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the real guestPicker source from client.js against a fake DOM. The
// source is sliced between the two function declarations so the test never
// copies the implementation and never asserts on source text.
const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function extractGuestPicker(source) {
  const start = source.indexOf('function guestPicker');
  const end = source.indexOf('function runIframePicker');
  assert.ok(start >= 0, 'client.js must define function guestPicker');
  assert.ok(end > start, 'function runIframePicker must follow guestPicker');
  return source.slice(start, end).trim();
}

const GUEST_PICKER_SOURCE = extractGuestPicker(CLIENT_SOURCE);

class FakeCSS {
  static escape(value) {
    return String(value);
  }
}

// Each call builds an independent DOM realm: fresh Element / ShadowRoot /
// Document constructors, so `node instanceof otherRealm.Element` is always
// false. This lets a test host the iframe guest window in its own realm,
// separate from the parent window globals.
function createRealm() {
  class Element {
    constructor(tagName, options = {}) {
      this.tagName = String(tagName).toUpperCase();
      this.id = options.id || '';
      this.classList = [...(options.classList || [])];
      this.children = [];
      this.parentElement = null;
      this.ownerDocument = options.ownerDocument || null;
      this._rootNode = options.rootNode || null;
      this.textContent = options.textContent ?? options.text ?? '';
      this.innerText = options.innerText ?? options.text ?? '';
      this.style = {};
      this._rect = options.rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      this._computed = options.computed || {
        color: 'rgb(0, 0, 0)',
        fontSize: '12px',
        fontFamily: 'monospace',
        backgroundColor: 'rgb(255, 255, 255)',
      };
      this._shadow = null;
      this._removed = false;
      this._throwComputedStyle = false;
    }

    getBoundingClientRect() {
      return this._rect;
    }

    getRootNode() {
      return this._rootNode || this.ownerDocument;
    }

    querySelectorAll() {
      return [];
    }

    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = this;
        this.children.push(node);
      }
    }

    remove() {
      this._removed = true;
      if (this.parentElement) {
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) this.parentElement.children.splice(index, 1);
        this.parentElement = null;
      }
    }

    attachShadow() {
      this._shadow = new ShadowRoot(this);
      return this._shadow;
    }
  }

  class ShadowRoot {
    constructor(host) {
      this.host = host;
      this.mode = 'closed';
      this.children = [];
    }

    append(...nodes) {
      this.children.push(...nodes);
    }

    querySelectorAll() {
      return [];
    }
  }

  class Document {
    constructor() {
      this.created = [];
      this.body = this.make('body');
      this.documentElement = this.body;
    }

    make(tagName, options = {}) {
      const element = new Element(tagName, options);
      element.ownerDocument = this;
      if (!element._rootNode) element._rootNode = this;
      this.created.push(element);
      return element;
    }

    createElement(tagName) {
      return this.make(tagName);
    }

    querySelectorAll() {
      return [];
    }
  }

  const document = new Document();
  return { Element, ShadowRoot, Document, document, make: (tagName, options) => document.make(tagName, options) };
}

class ListenerHub {
  constructor() {
    this.listeners = new Map();
    this.errors = [];
  }

  static key(type, capture) {
    return type + '|' + (capture ? '1' : '0');
  }

  addEventListener(type, listener, capture) {
    const key = ListenerHub.key(type, capture);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
  }

  removeEventListener(type, listener, capture) {
    this.listeners.get(ListenerHub.key(type, capture))?.delete(listener);
  }

  // Mirrors a browser: a listener that throws is reported, not rethrown to the
  // dispatcher, so a picker that never settles stays pending instead of crashing.
  dispatch(type, event, capture = true) {
    const set = this.listeners.get(ListenerHub.key(type, capture));
    if (!set) return 0;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        this.errors.push(error);
      }
    }
    return set.size;
  }

  count() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function createThrowingDocument() {
  const boom = () => {
    throw new Error('parent global document must not be used');
  };
  return {
    get body() {
      return boom();
    },
    get documentElement() {
      return boom();
    },
    createElement: boom,
    querySelectorAll: boom,
  };
}

function createPickerEnv(options = {}) {
  const guest = createRealm();
  const parent = createRealm();
  const hub = new ListenerHub();
  const timers = new Map();
  let nextTimerId = 0;
  const fakeSetTimeout = (fn, ms) => {
    const id = ++nextTimerId;
    timers.set(id, { fn, ms });
    return id;
  };
  const fakeClearTimeout = (id) => {
    timers.delete(id);
  };
  const location = { href: options.href || 'https://example.test/proto.html' };
  const getComputedStyle = (element) => {
    if (element && element._throwComputedStyle) throw new Error('getComputedStyle exploded');
    return element._computed;
  };
  const win = {
    document: guest.document,
    Element: guest.Element,
    CSS: FakeCSS,
    ShadowRoot: guest.ShadowRoot,
    innerWidth: options.innerWidth ?? 1024,
    innerHeight: options.innerHeight ?? 768,
    location,
    addEventListener: hub.addEventListener.bind(hub),
    removeEventListener: hub.removeEventListener.bind(hub),
    getComputedStyle,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };
  const parentDocument = options.isolateParentDocument ? createThrowingDocument() : parent.document;
  const context = vm.createContext({
    window: win,
    document: parentDocument,
    // Parent globals use a different realm than the guest window on purpose:
    // code that reaches for these instead of win.* must fail the selection.
    Element: parent.Element,
    CSS: FakeCSS,
    ShadowRoot: parent.ShadowRoot,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    location,
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    getComputedStyle,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  const guestPicker = vm.runInContext('(' + GUEST_PICKER_SOURCE + ')', context);
  return {
    guestPicker,
    document: guest.document,
    guest,
    parent,
    parentDocument,
    hub,
    timers,
    win,
    location,
    make: guest.make,
    dispatch: (type, event, capture = true) => hub.dispatch(type, event, capture),
  };
}

function pickerEvent(path, extra = {}) {
  const calls = { preventDefault: 0, stopImmediatePropagation: 0, stopPropagation: 0 };
  return {
    composedPath: () => path,
    preventDefault() {
      calls.preventDefault += 1;
    },
    stopImmediatePropagation() {
      calls.stopImmediatePropagation += 1;
    },
    stopPropagation() {
      calls.stopPropagation += 1;
    },
    key: extra.key,
    calls,
  };
}

// Resolves the outcome without ever awaiting a pending promise forever.
function settle(promise, ms = 300) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ status: 'timeout' });
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: 'fulfilled', value });
      },
      (reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: 'rejected', reason });
      },
    );
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function formButton(env, overrides = {}) {
  const form = env.make('div', { classList: ['form'] });
  const button = env.make('button', {
    classList: ['primary'],
    innerText: '  Hello   World  ',
    textContent: 'Hello   World',
    rect: { left: 12, top: 34, width: 120, height: 44, right: 132, bottom: 78 },
    computed: {
      color: 'rgb(10, 20, 30)',
      fontSize: '16px',
      fontFamily: 'Inter, sans-serif',
      backgroundColor: 'rgb(255, 255, 255)',
    },
    ...overrides,
  });
  button.parentElement = form;
  form.children.push(button);
  return { form, button };
}

test('navigation reports why selection ended and releases guest resources', async () => {
  const env = createPickerEnv();
  const promise = env.guestPicker(env.win);
  const outcomePromise = settle(promise);
  env.dispatch('pagehide', {}, false);
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.reason.message, /页面已跳转或刷新/);
  assert.equal(env.hub.count(), 0);
  assert.equal(env.timers.size, 0);
});

test('timeout reports why selection ended and releases guest resources', async () => {
  const env = createPickerEnv();
  const promise = env.guestPicker(env.win);
  const outcomePromise = settle(promise);
  [...env.timers.values()].find((timer) => timer.ms === 120000).fn();
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.reason.message, /点选已超时/);
  assert.equal(env.hub.count(), 0);
  assert.equal(env.timers.size, 0);
});

test('a click without an element reports the failure', async () => {
  const env = createPickerEnv();
  const promise = env.guestPicker(env.win);
  const outcomePromise = settle(promise);
  env.dispatch('click', pickerEvent([]));
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.reason.message, /未识别到可批注的元素/);
});

test('click resolves the picked element with its DOM details', async () => {
  const env = createPickerEnv();
  const { button } = formButton(env);
  const promise = env.guestPicker(env.win);

  assert.ok(env.hub.count() > 0, 'guestPicker registers listeners synchronously');

  const click = pickerEvent([button]);
  env.dispatch('click', click);
  const outcome = await settle(promise);

  assert.equal(outcome.status, 'fulfilled');
  assert.deepEqual(plain(outcome.value), {
    tag: 'button',
    selector: 'div.form > button.primary',
    text: 'Hello World',
    rect: { x: 12, y: 34, width: 120, height: 44 },
    style: {
      fontSize: '16px',
      color: 'rgb(10, 20, 30)',
      fontFamily: 'Inter, sans-serif',
      background: 'rgb(255, 255, 255)',
    },
    page: 'https://example.test/proto.html',
    viewport: [1024, 768],
  });
  assert.equal(click.calls.preventDefault, 1);
  assert.equal(click.calls.stopImmediatePropagation, 1);
});

test('picker suppresses pointer and click events and removes every listener after resolving', async () => {
  const env = createPickerEnv();
  const { button } = formButton(env);
  const promise = env.guestPicker(env.win);

  const pointerDown = pickerEvent([button]);
  env.dispatch('pointerdown', pointerDown);
  const mouseDown = pickerEvent([button]);
  env.dispatch('mousedown', mouseDown);
  const click = pickerEvent([button]);
  env.dispatch('click', click);

  const outcome = await settle(promise);
  assert.equal(outcome.status, 'fulfilled');

  // Soft listeners swallow propagation but leave the browser default intact.
  assert.equal(pointerDown.calls.stopImmediatePropagation, 1);
  assert.equal(pointerDown.calls.preventDefault, 0);
  assert.equal(mouseDown.calls.stopImmediatePropagation, 1);
  // The decisive click is fully suppressed.
  assert.equal(click.calls.preventDefault, 1);
  assert.equal(click.calls.stopImmediatePropagation, 1);

  assert.equal(env.hub.count(), 0, 'no listeners leak after finishing');
  assert.equal(env.timers.size, 0, 'the picker timeout is cleared');
  assert.equal(env.win.__dshPrototypePickerCancel, undefined, 'the cancel hook is removed');
  const host = env.document.created.find((element) => element._shadow);
  assert.ok(host, 'the picker adds a shadow host');
  assert.equal(host._removed, true, 'the picker host is removed from the document');
});

test('a getComputedStyle failure rejects the picker and cleans up instead of hanging', async () => {
  const env = createPickerEnv();
  const { button } = formButton(env);
  button._throwComputedStyle = true;
  const promise = env.guestPicker(env.win);

  env.dispatch('click', pickerEvent([button]));
  const outcome = await settle(promise);

  assert.equal(
    outcome.status,
    'rejected',
    'selection errors must reject the promise rather than hang until the 120s timeout',
  );
  assert.match(String(outcome.reason && outcome.reason.message), /getComputedStyle exploded/);
  assert.equal(env.hub.count(), 0, 'no listeners leak after a failed selection');
  assert.equal(env.timers.size, 0, 'the picker timeout is cleared after a failed selection');
  assert.equal(env.win.__dshPrototypePickerCancel, undefined, 'the cancel hook is removed');
  const host = env.document.created.find((element) => element._shadow);
  assert.equal(host._removed, true, 'the picker host is removed from the document');
});

test('composedPath selects a target inside Shadow DOM and prefixes the host selector', async () => {
  const env = createPickerEnv();
  const shadowHost = env.make('section', { classList: ['card'] });
  const shadow = new env.guest.ShadowRoot(shadowHost);
  const wrapper = env.make('div', { classList: ['row'] });
  const inner = env.make('span', {
    classList: ['label'],
    textContent: 'Inside',
    innerText: 'Inside',
    rootNode: shadow,
    rect: { left: 5, top: 6, width: 30, height: 20, right: 35, bottom: 26 },
  });
  inner.parentElement = wrapper;
  wrapper.children.push(inner);

  const promise = env.guestPicker(env.win);
  env.dispatch('click', pickerEvent([inner, shadow, shadowHost]));
  const outcome = await settle(promise);

  assert.equal(outcome.status, 'fulfilled');
  const value = plain(outcome.value);
  assert.equal(value.tag, 'span');
  assert.equal(value.selector, 'section.card >>> div.row > span.label');
});

// The guest runs inside the iframe window, a different realm from the parent
// globals. Selection must resolve through win.Element/win.document; code that
// strips the argument and uses the parent `Element`/`document` cannot match the
// iframe nodes and fails here.
test('cross-realm: selection uses the supplied iframe window, not parent globals', async () => {
  const env = createPickerEnv({ isolateParentDocument: true });
  assert.notEqual(env.guest.Element, env.parent.Element, 'guest and parent use distinct Element constructors');
  assert.notEqual(env.guest.ShadowRoot, env.parent.ShadowRoot, 'guest and parent use distinct ShadowRoot constructors');
  assert.throws(() => env.parentDocument.createElement('div'), /parent global document must not be used/);

  const { button } = formButton(env);
  assert.equal(button instanceof env.guest.Element, true);
  assert.equal(button instanceof env.parent.Element, false, 'the iframe node is foreign to the parent realm');

  const promise = env.guestPicker(env.win);
  env.dispatch('click', pickerEvent([button]));
  const outcome = await settle(promise);

  assert.equal(outcome.status, 'fulfilled', 'guestPicker must select through the supplied iframe window');
  const value = plain(outcome.value);
  assert.equal(value.tag, 'button');
  assert.equal(value.selector, 'div.form > button.primary');
});
