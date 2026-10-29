window.__ModuleLoader__.load({
  id: '@local/dsh-proto-annotate-spike',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const inputs = new Map();
    const listeners = new Set();
    let version = 0;
    const notify = () => { version += 1; listeners.forEach((fn) => fn()); };
    const CANCEL = 'window.__dshPrototypePickerCancel?.()';
    const SOURCE = 'local-prototype-annotation';
    let openDetails = null;

    function readAnnotations(ref) {
      const data = JSON.parse(ref);
      if (data.version !== 1 || !Array.isArray(data.annotations) || data.annotations.length === 0) throw new Error('批注数据不可用');
      for (const item of data.annotations) {
        if (typeof item.requirement !== 'string' || typeof item.element?.selector !== 'string') throw new Error('批注数据不可用');
      }
      return data.annotations;
    }

    // The model text is wrapped in a tag so the transcript rule can find the exact block;
    // `</` is escaped so a requirement cannot close the tag early.
    const BLOCK_OPEN = '<prototype-annotations';
    const BLOCK_CLOSE = '</prototype-annotations>';
    const BLOCK_ITEM = /原型注释 \d+[：:]\n/uy;

    function modelAnnotations(ref) {
      const annotations = readAnnotations(ref);
      const body = annotations.map((item, index) => {
        const { image, ...context } = item;
        return `原型注释 ${index + 1}：\n${JSON.stringify(context, null, 2).replace(/<\//g, '<\\/')}`;
      }).join('\n\n');
      return `${BLOCK_OPEN} count="${annotations.length}">\n${body}\n${BLOCK_CLOSE}`;
    }

    /** End offset of the JSON object starting at `start`, or -1 when unbalanced. */
    function scanObject(text, start) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const c = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) return i + 1;
        }
      }
      return -1;
    }

    /** Parse consecutive `原型注释 N：{json}` items starting exactly at `start`. */
    function readItems(text, start, limit) {
      const items = [];
      let cursor = start;
      let end = start;
      while (true) {
        BLOCK_ITEM.lastIndex = cursor;
        const head = BLOCK_ITEM.exec(text);
        if (!head) break;
        const open = head.index + head[0].length;
        if (text[open] !== '{') break;
        const close = scanObject(text, open);
        if (close < 0 || close > limit) break;
        let item;
        try { item = JSON.parse(text.slice(open, close)); } catch { break; }
        if (typeof item?.requirement !== 'string') break;
        items.push({ requirement: item.requirement, element: { tag: String(item.element?.tag ?? ''), selector: String(item.element?.selector ?? '') } });
        end = close;
        const gap = /\s*/y;
        gap.lastIndex = close;
        gap.exec(text);
        cursor = gap.lastIndex;
      }
      return items.length ? { items, end } : undefined;
    }

    /** Earliest tagged block, or untagged items sent before the tag existed. */
    function findAnnotationBlock(text, from) {
      let tagged;
      for (let at = text.indexOf(BLOCK_OPEN, from); at >= 0 && !tagged; at = text.indexOf(BLOCK_OPEN, at + 1)) {
        const close = text.indexOf(BLOCK_CLOSE, at);
        if (close < 0) break;
        const bodyStart = text.indexOf('\n', at);
        const parsed = bodyStart >= 0 && bodyStart < close ? readItems(text, bodyStart + 1, close) : undefined;
        if (parsed) tagged = { start: at, end: close + BLOCK_CLOSE.length, items: parsed.items };
      }
      let legacy;
      const heads = /原型注释 \d+[：:]\n\{/gu;
      heads.lastIndex = from;
      for (let m = heads.exec(text); m && !legacy; m = heads.exec(text)) {
        if (tagged && m.index >= tagged.start) break;
        const parsed = readItems(text, m.index, text.length);
        if (parsed) legacy = { start: m.index, end: parsed.end, items: parsed.items };
      }
      return legacy ?? tagged;
    }

    const TRANSCRIPT_RULE = 'prototype-annotations';
    const transcriptRule = {
      id: TRANSCRIPT_RULE,
      order: 20,
      match(text, from) {
        const block = findAnnotationBlock(text, from);
        return block && { id: TRANSCRIPT_RULE, start: block.start, end: block.end, data: { annotations: block.items } };
      },
    };

    let ReferenceChip = null;
    try {
      ReferenceChip = require('@deepseek-ai/dsh-client-ui-primitives').ReferenceChip ?? null;
    } catch {
      // Hosts without the shared primitives module get the plugin's own chip markup below.
    }

    // Occurrence offsets index clipboard text; an atomic chip occupies one detect unit.
    function referenceSpan(state, occurrence) {
      const preceding = state.occurrences.filter((item) => item.offset < occurrence.offset);
      const start = occurrence.offset - preceding.reduce((sum, item) => sum + item.length - 1, 0);
      return { start, end: start + 1, draftRev: state.draftRev };
    }

    function writeAnnotations(ctx, entry, annotations, occurrence) {
      const state = entry.read();
      const scope = ctx.sessions.scope(entry.sessionId);
      if (!scope) throw new Error('目标会话已关闭。批注已保留。');
      const captured = occurrence ? referenceSpan(state, occurrence) : entry.actions.captureInsertion();
      const span = occurrence ? captured : { ...captured, start: captured.end };
      const ref = JSON.stringify({ version: 1, annotations });
      const applied = annotations.length
        ? scope.bail(scope, 'slash/input-insert-reference', {
          reference: { source: SOURCE, ref, label: `${annotations.length} 条注释`, clipboardText: `[${annotations.length} 条原型注释]` }, span,
        })
        : scope.bail(scope, 'slash/input-insert-text', { text: '', span });
      if (applied !== true) throw new Error('输入框拒绝写入，请稍后重试。批注已保留。');
      entry.actions.persistDraft();
      return ref;
    }

    function ownOccurrence(state, ref) {
      const own = state.occurrences.filter((item) => item.source === SOURCE);
      return ref === undefined ? own[own.length - 1] : own.find((item) => item.ref === ref);
    }

    async function confirmOccurrence(entry, ref) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (inputs.get(entry.sessionId) !== entry) throw new Error('目标会话已关闭。批注已保留。');
        if (ownOccurrence(entry.read(), ref)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('未在输入框确认注释。请检查输入框，批注已保留。');
    }

    // The chip ref persists with the draft, so keep the element screenshot small.
    async function shrinkImage(dataUrl) {
      if (!dataUrl) return null;
      try {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const scale = Math.min(1, 480 / img.naturalWidth, 320 / img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.8);
      } catch {
        return null;
      }
    }

    function findWebview() {
      return [...document.querySelectorAll('webview[data-sidebar-browser-frame="webview"], webview')]
        .find((w) => {
          try {
            const r = w.getBoundingClientRect();
            return r.width > 20 && r.height > 20;
          } catch {
            return false;
          }
        });
    }

    function findIframe() {
      return [...document.querySelectorAll('iframe[class*="editorHtml"], iframe[title$=".html"], iframe[src*="/sidebar/html/"], [data-dsh-better-sidebar] iframe, [class*="pane"] iframe, iframe')]
        .find((f) => {
          try {
            const r = f.getBoundingClientRect();
            return r.width > 20 && r.height > 20;
          } catch {
            return false;
          }
        });
    }

    function isIframeSandboxed(ifr) {
      try {
        return !ifr.contentDocument || !ifr.contentDocument.body;
      } catch {
        return true;
      }
    }

    // Serialized into the Desktop guest webview
    function guestPicker() {
      window.__dshPrototypePickerCancel?.();
      return new Promise((resolve) => {
        const host = document.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        const shadow = host.attachShadow({ mode: 'closed' });
        const box = document.createElement('div');
        const tip = document.createElement('div');
        box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #2f6feb;background:#2f6feb20;display:none;pointer-events:none';
        tip.style.cssText = 'position:fixed;background:#fff;color:#111;font:12px/1.5 monospace;padding:6px 8px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.25);white-space:pre;max-width:calc(100vw - 16px);overflow:hidden;display:none;pointer-events:none;z-index:2147483647';
        shadow.append(box, tip);
        (document.body || document.documentElement).append(host);
        let done = false;
        const selectorOf = (el) => {
          const root = el.getRootNode();
          const parts = [];
          let node = el;
          while (node instanceof Element) {
            let part = node.tagName.toLowerCase();
            if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
              parts.unshift('#' + CSS.escape(node.id));
              break;
            }
            part += [...node.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
            const parent = node.parentElement;
            if (parent) {
              const same = [...parent.children].filter((c) => c.tagName === node.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
            }
            parts.unshift(part);
            node = parent;
          }
          const local = parts.join(' > ');
          return root instanceof ShadowRoot ? selectorOf(root.host) + ' >>> ' + local : local;
        };
        const targetOf = (e) => e.composedPath().find((item) => item instanceof Element && item !== host);
        const move = (e) => {
          const el = targetOf(e);
          if (!el) return;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
          tip.textContent = el.tagName.toLowerCase() + '  ' + Math.round(r.width) + '×' + Math.round(r.height) + '\n' + cs.color + ' · ' + cs.fontSize + ' ' + (cs.fontFamily || '').split(',')[0];
          Object.assign(tip.style, { display: 'block', left: Math.min(Math.max(8, r.left), Math.max(8, innerWidth - 300)) + 'px', top: (r.bottom + 60 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - 54)) + 'px' });
        };
        const finish = (value) => {
          if (done) return;
          done = true;
          removeEventListener('pointermove', move, true);
          for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) removeEventListener(type, soft, true);
          removeEventListener('click', click, true);
          removeEventListener('keydown', key, true);
          removeEventListener('pagehide', cancel);
          clearTimeout(timer);
          host.remove();
          delete window.__dshPrototypePickerCancel;
          resolve(value);
        };
        const suppress = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
        const soft = (e) => { e.stopImmediatePropagation(); };
        const cancel = () => finish(null);
        const click = (e) => {
          suppress(e);
          const el = targetOf(e);
          if (!el) return cancel();
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          finish({
            tag: el.tagName.toLowerCase(),
            selector: selectorOf(el),
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
            style: { fontSize: cs.fontSize, color: cs.color, fontFamily: cs.fontFamily, background: cs.backgroundColor },
            page: location.href,
            viewport: [innerWidth, innerHeight],
          });
        };
        const key = (e) => { if (e.key === 'Escape') { suppress(e); cancel(); } };
        const timer = setTimeout(cancel, 120000);
        window.__dshPrototypePickerCancel = cancel;
        addEventListener('pointermove', move, true);
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) addEventListener(type, soft, true);
        addEventListener('click', click, true);
        addEventListener('keydown', key, true);
        addEventListener('pagehide', cancel);
      });
    }

    function runIframePicker(ifr) {
      const win = ifr.contentWindow;
      const doc = ifr.contentDocument;
      if (!win || !doc) return Promise.reject(new Error('无法访问 iframe 内部 DOM（可能处于跨域或沙箱保护中）'));
      win.__dshPrototypePickerCancel?.();

      return new Promise((resolve) => {
        const host = doc.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        const shadow = host.attachShadow({ mode: 'closed' });
        const box = doc.createElement('div');
        const tip = doc.createElement('div');
        box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #2f6feb;background:#2f6feb20;display:none;pointer-events:none';
        tip.style.cssText = 'position:fixed;background:#fff;color:#111;font:12px/1.5 monospace;padding:6px 8px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.25);white-space:pre;max-width:calc(100vw - 16px);overflow:hidden;display:none;pointer-events:none;z-index:2147483647';
        shadow.append(box, tip);
        (doc.body || doc.documentElement).append(host);
        let done = false;

        const selectorOf = (el) => {
          const root = el.getRootNode();
          const parts = [];
          let node = el;
          while (node instanceof Element) {
            let part = node.tagName.toLowerCase();
            if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
              parts.unshift('#' + CSS.escape(node.id));
              break;
            }
            part += [...node.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
            const parent = node.parentElement;
            if (parent) {
              const same = [...parent.children].filter((c) => c.tagName === node.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
            }
            parts.unshift(part);
            node = parent;
          }
          return parts.join(' > ');
        };

        const targetOf = (e) => e.composedPath().find((item) => item instanceof Element && item !== host);
        const move = (e) => {
          const el = targetOf(e);
          if (!el) return;
          const r = el.getBoundingClientRect();
          const cs = win.getComputedStyle(el);
          Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
          tip.textContent = el.tagName.toLowerCase() + '  ' + Math.round(r.width) + '×' + Math.round(r.height) + '\n' + cs.color + ' · ' + cs.fontSize + ' ' + (cs.fontFamily || '').split(',')[0];
          Object.assign(tip.style, { display: 'block', left: Math.min(Math.max(8, r.left), Math.max(8, win.innerWidth - 300)) + 'px', top: (r.bottom + 60 < win.innerHeight ? r.bottom + 6 : Math.max(8, r.top - 54)) + 'px' });
        };

        const finish = (value) => {
          if (done) return;
          done = true;
          win.removeEventListener('pointermove', move, true);
          for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) win.removeEventListener(type, soft, true);
          win.removeEventListener('click', click, true);
          win.removeEventListener('keydown', key, true);
          win.removeEventListener('pagehide', cancel);
          clearTimeout(timer);
          host.remove();
          delete win.__dshPrototypePickerCancel;
          resolve(value);
        };

        const suppress = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
        const soft = (e) => { e.stopImmediatePropagation(); };
        const cancel = () => finish(null);
        const click = (e) => {
          suppress(e);
          const el = targetOf(e);
          if (!el) return cancel();
          const r = el.getBoundingClientRect();
          const cs = win.getComputedStyle(el);
          finish({
            tag: el.tagName.toLowerCase(),
            selector: selectorOf(el),
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
            style: { fontSize: cs.fontSize, color: cs.color, fontFamily: cs.fontFamily, background: cs.backgroundColor },
            page: win.location.href,
            viewport: [win.innerWidth, win.innerHeight],
          });
        };
        const key = (e) => { if (e.key === 'Escape') { suppress(e); cancel(); } };
        const timer = setTimeout(cancel, 120000);
        win.__dshPrototypePickerCancel = cancel;
        win.addEventListener('pointermove', move, true);
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) win.addEventListener(type, soft, true);
        win.addEventListener('click', click, true);
        win.addEventListener('keydown', key, true);
        win.addEventListener('pagehide', cancel);
      });
    }

    function InputBridge(props) {
      const marker = React.useRef(null);
      const state = props.useInput((value) => value);
      const latest = React.useRef(state);
      latest.current = state;
      React.useEffect(() => {
        if (!props.sessionId) return;
        const entry = {
          sessionId: props.sessionId,
          actions: props.inputActions,
          read: () => latest.current,
        };
        inputs.set(props.sessionId, entry);
        notify();
        return () => {
          if (inputs.get(props.sessionId) === entry) inputs.delete(props.sessionId);
          notify();
        };
      }, [props.sessionId, props.inputActions]);
      return h('span', { ref: marker, hidden: true, 'data-prototype-annotation-bridge': props.sessionId });
    }

    const css = `
      .dsh-pa-tool-btn {
        height: 24px !important;
        padding: 0 8px !important;
        font-size: 12px !important;
        font-weight: 500 !important;
        border-radius: 6px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)) !important;
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.9)) !important;
        color: var(--dsw-alias-brand-primary, #2f6feb) !important;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05) !important;
        transition: all 0.15s ease !important;
        white-space: nowrap !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        margin-right: 4px !important;
        box-sizing: border-box !important;
        gap: 4px !important;
      }
      .dsh-pa-tool-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)) !important;
        border-color: var(--dsw-alias-brand-primary, #2f6feb) !important;
      }
      .dsh-pa-tool-btn.dsh-pa-active {
        background: var(--dsw-alias-brand-primary, #2f6feb) !important;
        color: #fff !important;
        border-color: var(--dsw-alias-brand-primary, #2f6feb) !important;
      }
      .dsh-pa-sandbox-btn {
        height: 22px !important;
        padding: 0 8px !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        border-radius: 4px !important;
        display: inline-flex !important;
        align-items: center !important;
        cursor: pointer !important;
        border: 0 !important;
        background: #2f6feb !important;
        color: #fff !important;
        margin-left: auto !important;
        gap: 4px !important;
      }
      .dsh-pa-sandbox-btn:hover {
        filter: brightness(1.1) !important;
      }
      .dsh-pa-picking-banner {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483646;
        background: #2f6feb;
        color: #fff;
        padding: 8px 16px;
        border-radius: 20px;
        font: 13px/1.4 system-ui, sans-serif;
        font-weight: 500;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25);
        display: flex;
        align-items: center;
        gap: 10px;
        pointer-events: auto;
      }
      .dsh-pa-popover {
        position: fixed;
        z-index: 10020;
        width: min(350px, calc(100vw - 32px));
        padding: 12px 14px;
        background: var(--dsw-alias-bg-base, #fff);
        border: 1px solid var(--dsw-alias-border-l2, #e5e5e5);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
        display: flex;
        flex-direction: column;
        gap: 10px;
        font: 12px/1.5 system-ui, sans-serif;
        color: var(--dsw-alias-label-primary, #111);
        max-height: calc(100vh - 120px);
        overflow-y: auto;
      }
      .dsh-pa-popover textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 72px;
        padding: 8px 10px;
        font: 13px/1.4 system-ui, sans-serif;
        color: inherit;
        border: 1px solid var(--dsw-alias-border-l2, #ddd);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, #fafafa);
        resize: vertical;
        outline: none;
      }
      .dsh-pa-popover textarea:focus {
        border-color: var(--dsw-alias-brand-primary, #2f6feb);
        box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-active, #2f6feb30);
      }
      .dsh-pa-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        font-size: 11px;
        font-family: monospace;
        font-weight: 600;
        border-radius: 4px;
        background: var(--dsw-alias-interactive-bg-active, #2f6feb15);
        color: var(--dsw-alias-brand-primary, #2f6feb);
      }
      .dsh-pa-primary-btn {
        padding: 6px 14px;
        font-size: 12px;
        font-weight: 500;
        border-radius: 6px;
        cursor: pointer;
        border: 0;
        background: var(--dsw-alias-brand-primary, #2f6feb);
        color: #fff;
      }
      .dsh-pa-primary-btn:hover {
        filter: brightness(1.08);
      }
      .dsh-pa-sent-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 0 6px;
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2, rgba(37, 99, 235, 0.1));
        color: var(--dsw-alias-label-primary, #1d4ed8);
        cursor: pointer;
      }
      .dsh-pa-secondary-btn {
        padding: 5px 10px;
        font-size: 12px;
        border-radius: 6px;
        cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2, #ddd);
        background: var(--dsw-alias-bg-layer-1, #f5f5f5);
        color: var(--dsw-alias-label-secondary, #666);
      }
      .dsh-pa-secondary-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, #eee);
        color: var(--dsw-alias-label-primary, #111);
      }
    `;

    return {
      inject: ['slots', 'locale', 'sessions', 'inputTriggers', 'uiConversation'],
      apply(ctx) {
        // Sent messages keep the full model text; this rule only changes how the bubble shows it.
        ctx.effect(() => ctx.uiConversation.userText.register(transcriptRule));
        // The chip carries every annotation in its ref; the codec turns it into model text at submit.
        ctx.effect(() => ctx.inputTriggers.registerSource({
          trigger: '@',
          name: SOURCE,
          order: 1000,
          candidates: async () => [],
          onPick: () => undefined,
          openReference: (session, reference) => {
            if (!openDetails) return false;
            openDetails({ sessionId: session.sessionId, ref: reference.ref });
            return true;
          },
          codec: {
            clipboardText: (ref) => `[${readAnnotations(ref).length} 条原型注释]`,
            serialize: async (ref) => modelAnnotations(ref),
          },
        }));
        const dict = {
          zh: {
            launch: '批注',
            picking: '请在页面中点选元素 · Esc 取消',
            note: '希望怎样修改这个元素？(Enter 提交，Shift+Enter 换行)',
            finish: '完成',
            cancel: '取消',
            repick: '重新点选',
            ready: '注释已加入输入框',
            missing: '未在右侧栏检测到活动的原型页面，请确保右侧栏已打开浏览器或 HTML 预览',
            copy: '复制批注',
            select: '目标会话',
          },
          en: {
            launch: 'Annotate',
            picking: 'Click an element in page · Esc to cancel',
            note: 'How should this element change? (Enter to submit, Shift+Enter for newline)',
            finish: 'Done',
            cancel: 'Cancel',
            repick: 'Repick',
            ready: 'Annotation added to the composer',
            missing: 'No active prototype page found in right sidebar',
            copy: 'Copy',
            select: 'Session',
          },
        };
        ctx.effect(() => ctx.locale.register('local-prototype-annotation', 'zh', dict.zh));
        ctx.effect(() => ctx.locale.register('local-prototype-annotation', 'en', dict.en));
        const t = ctx.locale.bind('local-prototype-annotation');

        function AnnotationOverlay() {
          React.useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => version);
          React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));

          const [isPicking, setIsPicking] = React.useState(false);
          const [result, setResult] = React.useState(null);
          const [note, setNote] = React.useState('');
          const [status, setStatus] = React.useState('');
          const [chosen, setChosen] = React.useState('');
          const [isFinishing, setIsFinishing] = React.useState(false);
          const finishing = React.useRef(false);
          const delivery = React.useRef(null);
          const activeTarget = React.useRef(null);
          const textareaRef = React.useRef(null);
          const mounted = React.useRef(true);
          const [details, setDetails] = React.useState(null);

          React.useEffect(() => {
            openDetails = setDetails;
            return () => { if (openDetails === setDetails) openDetails = null; };
          }, []);

          let detailItems = [];
          if (details) {
            try { detailItems = readAnnotations(details.ref); } catch { detailItems = []; }
          }

          const removeAnnotation = (index) => {
            try {
              const entry = inputs.get(details.sessionId);
              if (!entry) throw new Error('目标会话已关闭。');
              const occurrence = ownOccurrence(entry.read(), details.ref);
              if (!occurrence) throw new Error('输入框里已没有这条注释。');
              const remaining = detailItems.filter((_, i) => i !== index);
              const ref = writeAnnotations(ctx, entry, remaining, occurrence);
              setDetails(remaining.length ? { sessionId: details.sessionId, ref } : null);
            } catch (error) {
              setStatus(String(error.message || error));
            }
          };

          const entries = [...inputs.values()];
          const selected = entries.length === 1 ? entries[0] : entries.find((entry) => entry.sessionId === chosen) || null;

          const cancelPick = React.useCallback(() => {
            if (activeTarget.current) {
              if (activeTarget.current.type === 'webview') {
                activeTarget.current.element.executeJavaScript(CANCEL).catch(() => {});
              } else if (activeTarget.current.type === 'iframe') {
                try {
                  activeTarget.current.element.contentWindow?.__dshPrototypePickerCancel?.();
                } catch {}
              }
            }
            activeTarget.current = null;
            if (mounted.current) setIsPicking(false);
          }, []);

          const startPick = React.useCallback(async () => {
            if (finishing.current) return;
            const wv = findWebview();
            const ifr = findIframe();
            if (!wv && !ifr) {
              setStatus(t('missing'));
              return;
            }

            setIsPicking(true);
            setResult(null);
            setStatus('');

            try {
              let element = null;
              let image = null;

              if (wv) {
                activeTarget.current = { type: 'webview', element: wv };
                element = await wv.executeJavaScript('(' + guestPicker.toString() + ')()', true);
                if (!mounted.current) return;
                if (!element) {
                  setIsPicking(false);
                  return;
                }
                try {
                  const r = element.rect;
                  const x = Math.max(0, Math.floor(r.x - 8)), y = Math.max(0, Math.floor(r.y - 8));
                  const width = Math.min(element.viewport[0], Math.ceil(r.x + r.width + 8)) - x;
                  const height = Math.min(element.viewport[1], Math.ceil(r.y + r.height + 8)) - y;
                  if (width > 0 && height > 0) image = (await wv.capturePage({ x, y, width, height })).toDataURL();
                } catch {}
              } else if (ifr) {
                activeTarget.current = { type: 'iframe', element: ifr };
                if (isIframeSandboxed(ifr)) {
                  // Try to find unlock button
                  const unlockBtn = document.querySelector('button[class*="sandboxAction"]')
                    || [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('解锁') || (b.textContent || '').includes('disable (unsafe)'));
                  if (unlockBtn) {
                    unlockBtn.click();
                    setStatus('正在解除沙箱限制以支持点选...');
                    await new Promise((r) => setTimeout(r, 450));
                  }
                }
                let freshIfr = findIframe();
                if (freshIfr && isIframeSandboxed(freshIfr)) {
                  // If sandbox attribute is absent or empty, reload once to ensure document is unsandboxed
                  if (!freshIfr.hasAttribute('sandbox') || !freshIfr.getAttribute('sandbox')) {
                    try {
                      freshIfr.src = freshIfr.src;
                      await new Promise((r) => {
                        freshIfr.onload = r;
                        setTimeout(r, 700);
                      });
                    } catch {}
                  }
                  freshIfr = findIframe();
                }
                if (!freshIfr || isIframeSandboxed(freshIfr)) {
                  throw new Error('当前 HTML 预览处于沙箱中，请先点击页面上方的「临时解锁」，或在浏览器中打开网址');
                }
                element = await runIframePicker(freshIfr);
                if (!mounted.current) return;
                if (!element) {
                  setIsPicking(false);
                  return;
                }
              }

              if (!element || typeof element.selector !== 'string') {
                setIsPicking(false);
                return;
              }

              const btn = document.querySelector('.dsh-pa-tool-btn.dsh-pa-active') || document.querySelector('.dsh-pa-tool-btn');
              const btnRect = btn?.getBoundingClientRect();
              const popoverPos = btnRect ? {
                top: Math.round(btnRect.bottom + 6),
                right: Math.max(12, Math.round(window.innerWidth - btnRect.right)),
              } : { top: 86, right: 24 };

              setResult({ element, image, popoverPos });
            } catch (error) {
              if (mounted.current) setStatus(String(error.message || error));
            } finally {
              activeTarget.current = null;
              if (mounted.current) setIsPicking(false);
            }
          }, [t]);

          // Global shortcut: Option+A (or Alt+A) to toggle picking
          React.useEffect(() => {
            const onKeyDown = (e) => {
              if (e.altKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA') && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                if (isPicking) {
                  cancelPick();
                } else {
                  startPick();
                }
              }
            };
            window.addEventListener('keydown', onKeyDown, true);
            return () => window.removeEventListener('keydown', onKeyDown, true);
          }, [isPicking, cancelPick, startPick]);

          // Keep buttons synced across the top bar of the right sidebar
          React.useEffect(() => {
            function sync() {
              const onButtonClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isPicking) {
                  cancelPick();
                } else {
                  startPick();
                }
              };

              const createBtn = (cls) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `${cls} dsh-pa-tool-btn`;
                btn.title = '批注原型元素 (快捷键 Option+A) · 点击进入点选模式';
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none"><path d="M8 3H3v5M16 3h5v5M3 16v5h5m13-5v5h-5M9 8l9 7-5 1-2 5z"/></svg><span>批注</span>';
                btn.onclick = onButtonClick;
                return btn;
              };

              // Target 1: Right sidebar panel chrome controls (directly left of [⛶] fullscreen button)
              try {
                const targetBtn = document.querySelector('button[data-sidebar-right-mode]')
                  || document.querySelector('button[data-sidebar-right-toggle]');
                if (targetBtn && targetBtn.parentElement) {
                  let btn = targetBtn.parentElement.querySelector('.dsh-pa-tab-btn');
                  if (!btn) {
                    btn = createBtn('dsh-pa-tab-btn');
                    targetBtn.parentElement.insertBefore(btn, targetBtn);
                  }
                  btn.classList.toggle('dsh-pa-active', isPicking);
                  const span = btn.querySelector('span');
                  if (span) span.textContent = isPicking ? '取消点选' : '批注';
                }
              } catch {}

              // Target 2: Sandbox warning status bar (above HTML preview)
              try {
                const sandboxBar = document.querySelector('[class*="sandboxStatus"]');
                if (sandboxBar) {
                  let btn = sandboxBar.querySelector('.dsh-pa-sandbox-btn');
                  if (!btn) {
                    btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'dsh-pa-sandbox-btn dsh-pa-tool-btn';
                    btn.title = '批注当前 HTML 原型元素 (快捷键 Option+A)';
                    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none"><path d="M8 3H3v5M16 3h5v5M3 16v5h5m13-5v5h-5M9 8l9 7-5 1-2 5z"/></svg><span>批注原型</span>';
                    btn.onclick = onButtonClick;
                    sandboxBar.appendChild(btn);
                  }
                  btn.classList.toggle('dsh-pa-active', isPicking);
                  const span = btn.querySelector('span');
                  if (span) span.textContent = isPicking ? '取消点选' : '批注原型';
                }
              } catch {}

              // Target 3: Editor header (HTML preview toolbar)
              try {
                const editorHeader = document.querySelector('[class*="editorHeader"]');
                if (editorHeader) {
                  let btn = editorHeader.querySelector('.dsh-pa-editor-btn');
                  if (!btn) {
                    btn = createBtn('dsh-pa-editor-btn');
                    const modeToggle = editorHeader.querySelector('[class*="editorModeToggle"]');
                    if (modeToggle && modeToggle.nextSibling) {
                      editorHeader.insertBefore(btn, modeToggle.nextSibling);
                    } else {
                      editorHeader.appendChild(btn);
                    }
                  }
                  btn.classList.toggle('dsh-pa-active', isPicking);
                  const span = btn.querySelector('span');
                  if (span) span.textContent = isPicking ? '取消点选' : '批注';
                }
              } catch {}

              // Target 4: Browser body form (Browser tab toolbar, right next to reload button)
              try {
                const browserToolbar = document.querySelector('form:has(input[class*="address"]), form:has(button[aria-label="reload"])')
                  || document.querySelector('input[class*="address"]')?.closest('form')
                  || document.querySelector('webview')?.closest('[class*="root"]')?.querySelector('form')
                  || document.querySelector('[data-sidebar-browser-frame="webview"]')?.closest('[class*="root"]')?.querySelector('form');
                if (browserToolbar) {
                  let btn = browserToolbar.querySelector('.dsh-pa-nav-btn');
                  if (!btn) {
                    btn = createBtn('dsh-pa-nav-btn');
                    const addressBox = browserToolbar.querySelector('[class*="addressBox"]')
                      || browserToolbar.querySelector('input')?.parentElement;
                    if (addressBox) {
                      browserToolbar.insertBefore(btn, addressBox);
                    } else {
                      browserToolbar.appendChild(btn);
                    }
                  }
                  btn.classList.toggle('dsh-pa-active', isPicking);
                  const span = btn.querySelector('span');
                  if (span) span.textContent = isPicking ? '取消点选' : '批注';
                }
              } catch {}
            }

            const interval = setInterval(sync, 350);
            sync();
            return () => {
              clearInterval(interval);
              document.querySelectorAll('.dsh-pa-tool-btn').forEach((b) => b.remove());
            };
          }, [isPicking, cancelPick, startPick]);

          // Auto-focus textarea when popover opens
          React.useEffect(() => {
            if (result) {
              setTimeout(() => textareaRef.current?.focus(), 50);
            }
          }, [result]);

          // Click outside or Escape to close popover
          React.useEffect(() => {
            if (!result) return;
            const onDown = (e) => {
              if (finishing.current || e.target.closest?.('.dsh-pa-popover') || e.target.closest?.('.dsh-pa-tool-btn')) return;
              setResult(null);
            };
            const onKey = (e) => {
              if (e.key === 'Escape' && !finishing.current) setResult(null);
            };
            window.addEventListener('mousedown', onDown, true);
            window.addEventListener('keydown', onKey, true);
            return () => {
              window.removeEventListener('mousedown', onDown, true);
              window.removeEventListener('keydown', onKey, true);
            };
          }, [result]);

          React.useEffect(() => {
            mounted.current = true;
            return () => {
              mounted.current = false;
              cancelPick();
            };
          }, [cancelPick]);

          const handleFinish = async () => {
            if (!result || finishing.current) return;
            if (!selected) {
              setStatus(entries.length ? '请选择目标会话。批注已保留。' : '未找到聊天输入框。批注已保留。');
              return;
            }
            finishing.current = true;
            setIsFinishing(true);
            try {
            if (inputs.get(selected.sessionId) !== selected) throw new Error('目标会话已关闭。批注已保留。');
            const state = selected.read();
            if (state.phase === 'adjudicating' || state.phase === 'submitting') throw new Error('输入框正在提交，请稍后重试。批注已保留。');
            if (typeof selected.actions?.captureInsertion !== 'function' || !ctx.sessions) {
              throw new Error('当前 DSH 未提供所需的输入接口。批注已保留。');
            }
            const previous = delivery.current;
            if (previous?.result === result && previous.sessionId === selected.sessionId && ownOccurrence(state, previous.ref)) {
              delivery.current = null;
              setResult(null);
              setNote('');
              setStatus(t('ready'));
              return;
            }
            const userNote = note.trim();
            const annotation = {
              requirement: userNote || '修改此原型元素',
              element: {
                tag: result.element.tag,
                selector: result.element.selector,
                text: result.element.text,
                rect: result.element.rect,
                style: result.element.style,
                page: result.element.page,
                viewport: result.element.viewport,
              },
              image: await shrinkImage(result.image),
            };
            if (!mounted.current || inputs.get(selected.sessionId) !== selected) throw new Error('目标会话已关闭。批注已保留。');
            // One chip per draft: a new annotation merges into the existing chip and bumps its count.
            const existing = ownOccurrence(selected.read());
            const annotations = existing ? [...readAnnotations(existing.ref), annotation] : [annotation];
            const ref = writeAnnotations(ctx, selected, annotations, existing);
            delivery.current = { result, sessionId: selected.sessionId, ref };
            await confirmOccurrence(selected, ref);
            if (!mounted.current) return;
            delivery.current = null;
            setResult(null);
            setNote('');
            setStatus(t('ready'));
            } catch (error) {
              if (mounted.current) setStatus(String(error.message || error));
            } finally {
              finishing.current = false;
              if (mounted.current) setIsFinishing(false);
            }
          };

          return h(React.Fragment, null,
            h('style', null, css),
            isPicking ? h('div', { className: 'dsh-pa-picking-banner' },
              h('span', null, '🎯 ' + t('picking')),
              h('button', {
                type: 'button',
                className: 'dsh-pa-secondary-btn',
                style: { padding: '2px 8px', fontSize: '11px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: 0 },
                onClick: cancelPick,
              }, t('cancel'))
            ) : null,
            !result && status ? h('div', {
              className: 'dsh-pa-toast',
              style: {
                position: 'fixed',
                top: '48px',
                right: '24px',
                zIndex: 10030,
                background: 'var(--dsw-alias-bg-base, #fff)',
                border: '1px solid var(--dsw-alias-border-l2, #ddd)',
                borderRadius: '8px',
                padding: '8px 12px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: status.includes('未') || status.includes('沙箱') || status.includes('错误') ? '#d32f2f' : '#2f6feb',
              },
            },
              h('span', null, status),
              h('button', {
                type: 'button',
                style: { border: 0, background: 'transparent', cursor: 'pointer', padding: '0 4px', fontSize: '14px', color: 'inherit' },
                onClick: () => setStatus(''),
              }, '×')
            ) : null,
            result ? h('div', {
              className: 'dsh-pa-popover',
              style: { top: result.popoverPos.top + 'px', right: result.popoverPos.right + 'px' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  h('span', { className: 'dsh-pa-tag' }, '<' + result.element.tag + '>'),
                  h('span', { style: { fontWeight: 600, fontSize: '13px' } }, '批注元素')),
                h('button', {
                  type: 'button',
                  className: 'dsh-pa-secondary-btn',
                  style: { padding: '2px 8px', fontSize: '11px' },
                  onClick: () => setResult(null),
                  disabled: isFinishing,
                }, t('cancel'))),
              result.element.text ? h('div', {
                style: {
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-secondary, #666)',
                  background: 'var(--dsw-alias-bg-layer-1, #f5f5f5)',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              }, result.element.text) : null,
              result.image ? h('img', {
                src: result.image,
                alt: result.element.selector,
                style: { maxHeight: '100px', objectFit: 'contain', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, #eee)' },
              }) : null,
              h('textarea', {
                ref: textareaRef,
                value: note,
                disabled: isFinishing,
                onChange: (e) => setNote(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isFinishing) {
                    e.preventDefault();
                    handleFinish();
                  }
                },
                placeholder: t('note'),
                'aria-label': t('note'),
              }),
              entries.length > 1 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' } },
                h('span', null, t('select') + ':'),
                h('select', {
                  value: chosen,
                  disabled: isFinishing,
                  onChange: (e) => setChosen(e.target.value),
                  style: { flex: 1, padding: '2px 4px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-l2, #ddd)' },
                }, h('option', { value: '' }, '请选择目标会话'), entries.map((e) => h('option', { key: e.sessionId, value: e.sessionId }, e.sessionId)))) : null,
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '4px' } },
                h('button', {
                  type: 'button',
                  className: 'dsh-pa-secondary-btn',
                  onClick: () => { setResult(null); startPick(); },
                  disabled: isFinishing,
                }, t('repick')),
                h('button', {
                  type: 'button',
                  className: 'dsh-pa-primary-btn',
                  onClick: handleFinish,
                  disabled: isFinishing || !selected,
                }, isFinishing ? '正在加入输入框…' : t('finish') + ' (Enter)')),
              status ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #666)' } }, status) : null) : null,
            details ? h('div', {
              className: 'dsh-pa-popover',
              style: { bottom: '140px', right: '24px', maxHeight: '60vh', overflowY: 'auto' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                h('span', { style: { fontWeight: 600, fontSize: '13px' } }, `${detailItems.length} 条注释`),
                h('button', { type: 'button', className: 'dsh-pa-secondary-btn', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => setDetails(null) }, '关闭')),
              detailItems.length === 0 ? h('div', { style: { fontSize: '12px', color: '#d32f2f' } }, '注释数据不可用') : null,
              detailItems.map((item, index) => h('div', {
                key: index,
                style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '8px', borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
                  h('span', { className: 'dsh-pa-tag' }, '<' + item.element.tag + '>'),
                  details.readOnly ? null : h('button', { type: 'button', className: 'dsh-pa-secondary-btn', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => removeAnnotation(index) }, '删除')),
                h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap' } }, item.requirement),
                h('code', { style: { fontSize: '10px', wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary, #666)' } }, item.element.selector),
                item.image ? h('img', { src: item.image, alt: item.element.selector, style: { maxHeight: '100px', objectFit: 'contain', alignSelf: 'flex-start', borderRadius: '6px' } }) : null))) : null);
        }

        function SentAnnotations({ node, interactive }) {
          const annotations = node.data.annotations;
          const label = `${annotations.length} 条注释`;
          const title = annotations.map((item, index) => `${index + 1}. ${item.requirement}`).join('\n');
          const open = () => openDetails?.({ ref: JSON.stringify({ version: 1, annotations }), readOnly: true });
          if (ReferenceChip) return h(ReferenceChip, { label, title, ...(interactive ? { onActivate: open } : {}) });
          return h('span', {
            className: 'dsh-pa-sent-chip',
            title,
            role: interactive ? 'button' : undefined,
            onClick: interactive ? open : undefined,
          }, '@', label);
        }

        ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: TRANSCRIPT_RULE, priority: 100 }, SentAnnotations));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'local-prototype-annotation' }, AnnotationOverlay));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'local-prototype-annotation-bridge' }, InputBridge));
      },
    };
  },
});
