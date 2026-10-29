/**
 * Test harness for the delivery logic of the DSH prototype-annotation client plugin.
 *
 * The harness loads the real `client.js` module inside a Node `vm` context and
 * supplies the only two host boundaries the plugin talks to:
 *   - React (mocked with a minimal hook runtime: no DOM rendering, no reconciler)
 *   - the host input boundary (`useInput` + `inputActions` + the composer file intake)
 *
 * Everything asserted by the tests is plugin logic; no UI is rendered or verified.
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_PATH = path.join(HERE, '..', 'client.js');

const FRAGMENT = Symbol('dsh.test.fragment');

function sameDeps(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

/** Minimal React surface: hooks, element factory, no reconciler and no DOM. */
export function createReactMock(dom) {
  let current = null;
  const pending = new Set();

  const schedule = (instance) => {
    if (instance.unmounted) return;
    pending.add(instance);
    queueMicrotask(flush);
  };

  function flush() {
    const list = [...pending];
    pending.clear();
    for (const instance of list) instance.render(instance.props);
  }

  class Instance {
    constructor(fn, props) {
      this.fn = fn;
      this.props = props;
      this.hooks = [];
      this.hookIndex = 0;
      this.pendingEffects = [];
      this.unmounted = false;
      this.output = null;
    }

    render(props) {
      if (this.unmounted) return null;
      this.props = props;
      this.hookIndex = 0;
      this.pendingEffects = [];
      const previous = current;
      current = this;
      let output;
      try {
        output = this.fn(props);
      } finally {
        current = previous;
      }
      this.output = output;
      this.commitEffects();
      applyRefs(output);
      return output;
    }

    commitEffects() {
      const effects = this.pendingEffects;
      this.pendingEffects = [];
      for (const effect of effects) effect();
    }

    dispose() {
      this.unmounted = true;
      pending.delete(this);
      for (const slot of this.hooks) {
        if (!slot) continue;
        if (slot.kind === 'effect' && typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch {
            // A failing cleanup must not abort the remaining cleanups.
          }
        }
        if (slot.kind === 'store' && typeof slot.unsubscribe === 'function') {
          slot.unsubscribe();
        }
      }
    }
  }

  function useRef(initial) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) instance.hooks[index] = { kind: 'ref', current: initial };
    return instance.hooks[index];
  }

  function useState(initial) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) {
      const slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      slot.set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        schedule(instance);
      };
      instance.hooks[index] = slot;
    }
    const slot = instance.hooks[index];
    return [slot.value, slot.set];
  }

  function useEffect(effect, deps) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) {
      instance.hooks[index] = { kind: 'effect', deps: undefined, cleanup: undefined, initialized: false };
    }
    const slot = instance.hooks[index];
    const changed = !slot.initialized || !sameDeps(slot.deps, deps);
    if (!changed) return;
    if (typeof slot.cleanup === 'function') {
      try {
        slot.cleanup();
      } catch {
        // A failing cleanup must not abort the new effect.
      }
    }
    slot.cleanup = undefined;
    slot.deps = deps;
    slot.initialized = true;
    instance.pendingEffects.push(() => {
      slot.cleanup = effect();
    });
  }

  function useCallback(fn, deps) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) {
      instance.hooks[index] = { kind: 'callback', value: fn, deps: undefined, initialized: false };
    }
    const slot = instance.hooks[index];
    if (!slot.initialized || !sameDeps(slot.deps, deps)) {
      slot.value = fn;
      slot.deps = deps;
      slot.initialized = true;
    }
    return slot.value;
  }

  function useMemo(factory, deps) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) {
      instance.hooks[index] = { kind: 'memo', value: undefined, deps: undefined, initialized: false };
    }
    const slot = instance.hooks[index];
    if (!slot.initialized || !sameDeps(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
      slot.initialized = true;
    }
    return slot.value;
  }

  function useSyncExternalStore(subscribe, getSnapshot) {
    const instance = current;
    const index = instance.hookIndex += 1;
    if (!instance.hooks[index]) {
      instance.hooks[index] = { kind: 'store', unsubscribe: undefined, initialized: false };
    }
    const slot = instance.hooks[index];
    if (!slot.initialized) {
      slot.initialized = true;
      instance.pendingEffects.push(() => {
        slot.unsubscribe = subscribe(() => schedule(instance));
      });
    }
    return getSnapshot();
  }

  function createElement(type, props, ...children) {
    const next = { ...(props || {}) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    const node = { type, props: next, key: next.key ?? null, focus() {} };
    node.closest = (selector) => dom.closest(node, selector);
    return node;
  }

  function applyRefs(node) {
    if (!node || typeof node !== 'object') return;
    const ref = node.props?.ref;
    if (ref && typeof ref === 'object') ref.current = node;
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(applyRefs);
    else if (children && typeof children === 'object') applyRefs(children);
  }

  const React = {
    Fragment: FRAGMENT,
    createElement,
    useRef,
    useState,
    useEffect,
    useCallback,
    useMemo,
    useSyncExternalStore,
  };

  return {
    React,
    mount(fn, props = {}) {
      const instance = new Instance(fn, props);
      instance.render(props);
      return instance;
    },
    dispose(instance) {
      instance.dispose();
    },
    flush,
  };
}

/** Depth-first search over a rendered element tree. */
export function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, found)); return found; }
  if (predicate(node)) found.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) children.forEach((child) => findAll(child, predicate, found));
  else if (children && typeof children === 'object') findAll(children, predicate, found);
  return found;
}

/** Concatenated text of an element subtree. */
export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  const children = node.props?.children;
  if (children === undefined) return '';
  if (Array.isArray(children)) return children.map(textOf).join('');
  return textOf(children);
}

/**
 * Loads the real client module into a vm context and wires the mocked host
 * boundaries. Returns handles for the slot components, the per-session composer
 * chip state, and the registered input-trigger source.
 */
export async function createHarness(options = {}) {
  const dom = {
    sessions: new Map(),
    closest(node, selector) {
      if (selector !== '[data-composer-card]') return null;
      const sessionId = node?.props?.['data-prototype-annotation-bridge'];
      if (sessionId === undefined) return null;
      return dom.sessions.get(sessionId)?.card ?? null;
    },
  };

  const react = createReactMock(dom);
  const React = react.React;

  const webview = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    executeJavaScript: async () => options.pickedElement ?? {
      tag: 'button',
      selector: 'div.form > button.primary',
      text: '保存',
      rect: { x: 20, y: 30, width: 120, height: 32 },
      style: { fontSize: '13px', color: 'rgb(47,111,235)', fontFamily: 'sans-serif', background: 'rgb(255,255,255)' },
      page: 'http://localhost:4173/preview.html',
      viewport: [1200, 800],
    },
    capturePage: async () => ({
      toDataURL: () => options.imageDataUrl
        ?? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }),
  };

  const documentStub = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (typeof selector === 'string' && selector.includes('webview')) return [webview];
      return [];
    },
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
    }),
    body: { append() {} },
    documentElement: { append() {} },
  };

  const windowListeners = new Map();
  const windowStub = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      windowListeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of [...(windowListeners.get(event.type) || [])]) handler(event);
      return true;
    },
  };

  const sandbox = {
    document: documentStub,
    innerWidth: windowStub.innerWidth,
    innerHeight: windowStub.innerHeight,
    addEventListener: windowStub.addEventListener.bind(windowStub),
    removeEventListener: windowStub.removeEventListener.bind(windowStub),
    console,
    setTimeout,
    clearTimeout,
    setInterval(...args) {
      const handle = setInterval(...args);
      handle.unref?.();
      return handle;
    },
    clearInterval,
    queueMicrotask,
    File,
    Blob,
    Event,
    URL,
    fetch,
    Promise,
  };
  const context = createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  let loaded = null;
  sandbox.__ModuleLoader__ = { load: (module) => { loaded = module; } };

  runInContext(readFileSync(CLIENT_PATH, 'utf8'), context, { filename: CLIENT_PATH });

  if (!loaded) throw new Error('client.js did not call window.__ModuleLoader__.load()');
  const requireMock = (id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require(${id}) in client.js`);
  };
  const plugin = loaded.factory(requireMock);

  const dictionaries = new Map();
  const sources = [];
  const userTextRules = [];
  const ctx = {
    uiConversation: {
      userText: {
        register(rule) {
          userTextRules.push(rule);
          return () => userTextRules.splice(userTextRules.indexOf(rule), 1);
        },
      },
    },
    inputTriggers: {
      registerSource(source) {
        if (sources.some((item) => item.trigger === source.trigger && item.name === source.name)) {
          throw new Error(`slash source "${source.trigger}${source.name}" is already registered`);
        }
        sources.push(source);
        return () => sources.splice(sources.indexOf(source), 1);
      },
    },
    sessions: {
      scope(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return undefined;
        return { bail: (_scope, event, payload) => session.handle(event, payload) };
      },
    },
    effect(effect) {
      const dispose = effect();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register(namespace, language, dictionary) {
        dictionaries.set(`${namespace}:${language}`, dictionary);
        return () => dictionaries.delete(`${namespace}:${language}`);
      },
      bind(namespace) {
        return (key) => dictionaries.get(`${namespace}:zh`)?.[key] ?? key;
      },
      subscribe() {
        return () => {};
      },
      getSnapshot() {
        return { language: 'zh' };
      },
    },
    slots: {
      inject(name, register) {
        register();
        return () => {};
      },
      register(descriptor, component) {
        slots.set(descriptor.name, component);
        return () => slots.delete(descriptor.name);
      },
    },
  };
  const slots = new Map();

  plugin.apply(ctx);

  const overlayComponent = slots.get('shell.overlay');
  const bridgeComponent = slots.get('conversation.input.left');
  if (!overlayComponent) throw new Error('client.js did not register the shell.overlay slot');
  if (!bridgeComponent) throw new Error('client.js did not register the conversation.input.left slot');

  const log = { captureInsertion: 0, persistDraft: [], events: [], useInput: [] };

  // Detect units: a char string per text character, an object per reference chip.
  function createSessionState() {
    const state = {
      units: [],
      attachmentIds: [],
      draftRev: 0,
      phase: 'plain',
      queue: null,
      insertResult: true,
      // A host that accepts the event but drops the chip.
      dropReferences: false,
    };
    Object.defineProperty(state, 'draft', {
      enumerable: true,
      get: () => state.units.map((unit) => (typeof unit === 'string' ? unit : unit.clipboardText)).join(''),
      set: (text) => { state.units = [...text]; },
    });
    Object.defineProperty(state, 'occurrences', {
      enumerable: true,
      get: () => {
        const found = [];
        let offset = 0;
        for (const unit of state.units) {
          if (typeof unit === 'string') { offset += unit.length; continue; }
          found.push({ ...unit, offset, length: unit.clipboardText.length });
          offset += unit.clipboardText.length;
        }
        return found;
      },
    });
    return state;
  }

  function createHandler(state) {
    return (event, payload) => {
      log.events.push({ event, payload });
      if (state.insertResult === false) return undefined;
      if (state.phase !== 'plain' && state.phase !== 'claimed') return undefined;
      const { span } = payload;
      if (span.draftRev !== state.draftRev) return undefined;
      let replacement;
      if (event === 'slash/input-insert-reference') {
        if (state.dropReferences) return true;
        replacement = [{ ...payload.reference }];
        if (state.units[span.end] !== ' ') replacement.push(' ');
      } else if (event === 'slash/input-insert-text') {
        replacement = [...payload.text];
      } else {
        return undefined;
      }
      state.units.splice(span.start, span.end - span.start, ...replacement);
      state.draftRev += 1;
      return true;
    };
  }

  function createActions(state) {
    return {
      captureInsertion: () => {
        log.captureInsertion += 1;
        return { start: state.units.length, end: state.units.length, draftRev: state.draftRev };
      },
      insertText: () => false,
      setDraft: (text) => { state.draft = text; },
      persistDraft: () => { log.persistDraft.push(state.draft); },
      addAttachments: () => true,
      removeAttachment: () => true,
      pruneAttachments: () => {},
      submit: () => {},
    };
  }

  const sessions = new Map();

  function ensureSession(sessionId) {
    if (!sessions.has(sessionId)) {
      const state = createSessionState();
      sessions.set(sessionId, {
        sessionId,
        state,
        actions: createActions(state),
        handle: createHandler(state),
        useInput: (selector) => {
          log.useInput.push(selector);
          return selector(state);
        },
      });
    }
    return sessions.get(sessionId);
  }

  const bridges = new Map();

  function mountBridge(sessionId, overrides = {}) {
    const session = ensureSession(sessionId);
    if (overrides.insertResult !== undefined) session.state.insertResult = overrides.insertResult;
    if (overrides.dropReferences !== undefined) session.state.dropReferences = overrides.dropReferences;
    if (overrides.draft !== undefined) session.state.draft = overrides.draft;
    if (overrides.phase !== undefined) session.state.phase = overrides.phase;
    if (overrides.actions !== undefined) session.actions = overrides.actions;
    const instance = react.mount(bridgeComponent, {
      sessionId,
      useInput: session.useInput,
      inputActions: session.actions,
    });
    bridges.set(sessionId, instance);
    return session;
  }

  const overlayInstance = react.mount(overlayComponent, {});

  const settle = async (turns = 6) => {
    for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const waitFor = async (predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  const harness = {
    React,
    sessions,
    sources,
    source: () => sources[0],
    userTextRules,
    userTextNode: () => slots.get('conversation.user.text.node'),
    chips: (sessionId) => sessions.get(sessionId).state.occurrences,
    log,
    window: windowStub,
    overlayInstance,
    mountBridge,
    ensureSession,
    settle,
    tree: () => overlayInstance.output,
    overlayText: () => textOf(overlayInstance.output),
    finishButton: () => findAll(overlayInstance.output, (node) => node.type === 'button' && node.props?.className === 'dsh-pa-primary-btn')[0],
    textarea: () => findAll(overlayInstance.output, (node) => node.type === 'textarea')[0],
    findButtons: (label) => findAll(overlayInstance.output, (node) => node.type === 'button' && textOf(node) === label),
    select: () => findAll(overlayInstance.output, (node) => node.type === 'select')[0],
    async pick() {
      windowStub.dispatchEvent({
        type: 'keydown',
        altKey: true,
        key: 'a',
        code: 'KeyA',
        preventDefault() {},
        stopPropagation() {},
      });
      await settle(10);
    },
    async typeNote(value) {
      const textarea = harness.textarea();
      if (!textarea) throw new Error('the annotation popover has no textarea');
      textarea.props.onChange({ target: { value } });
      await settle();
    },
    /** Fires the textarea Enter handler without awaiting the delivery promise. */
    pressEnter(target) {
      const textarea = target ?? harness.textarea();
      if (!textarea) throw new Error('the annotation popover has no textarea');
      const event = {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      };
      textarea.props.onKeyDown(event);
    },
    async pressEnterAndSettle(target) {
      harness.pressEnter(target);
      await settle();
    },
    async clickFinish() {
      const button = harness.finishButton();
      if (!button) throw new Error('the annotation popover has no finish button');
      await button.props.onClick();
      await settle();
    },
    dispose() {
      for (const instance of bridges.values()) react.dispose(instance);
      react.dispose(overlayInstance);
    },
  };

  return harness;
}
