import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from './harness.mjs';

async function setup(t, options) {
  const h = await createHarness(options);
  t.after(() => h.dispose());
  return h;
}

async function annotate(h, note) {
  await h.pick();
  await h.typeNote(note);
  await h.clickFinish();
}

const own = (h, sessionId) => h.chips(sessionId).filter((chip) => chip.source === 'local-prototype-annotation');
const annotationsOf = (chip) => JSON.parse(chip.ref).annotations;

test('the native header button starts annotation without legacy sidebar toolbar anchors', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  const button = h.launcher();
  assert.ok(button, 'a native header button must be rendered');
  assert.equal(button.props.disabled, false);
  assert.equal(button.props['aria-label'], '批注');
  button.props.onClick();
  await h.settle(10);
  assert.ok(h.textarea());
  await h.typeNote('从标题栏修改原型');
  await h.clickFinish();
  assert.equal(annotationsOf(own(h, 'session-a')[0])[0].requirement, '从标题栏修改原型');
});

test('the native button cancels picking and remains available for another attempt', async (t) => {
  let calls = 0;
  const h = await setup(t, { executePicker: () => { calls += 1; return new Promise(() => {}); } });
  assert.ok(h.launcher(), 'a native header button must be rendered');
  h.launcher().props.onClick();
  await h.settle();
  assert.equal(h.launcher().props['aria-pressed'], true);
  h.launcher().props.onClick();
  await h.settle();
  assert.equal(h.launcher().props['aria-pressed'], false);
  h.launcher().props.onClick();
  await h.settle();
  assert.equal(calls, 2);
});

test('the native header button selects its own composer when several sessions are open', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  h.mountBridge('session-b');
  const secondHeader = h.mountLauncher('session-b');
  const button = h.launcher(secondHeader);
  assert.ok(button, 'each session must have a header button');
  button.props.onClick();
  await h.settle(10);
  await h.typeNote('发到第二个会话');
  await h.clickFinish();
  assert.equal(own(h, 'session-a').length, 0);
  assert.equal(annotationsOf(own(h, 'session-b')[0])[0].requirement, '发到第二个会话');
});

test('the native header button stays visible and reports when no prototype is open', async (t) => {
  const h = await setup(t, { noPage: true });
  assert.ok(h.launcher(), 'the entry must exist before opening a prototype');
  h.launcher().props.onClick();
  await h.settle();
  assert.match(h.overlayText(), /未在右侧栏检测到活动的原型页面/);
  assert.ok(h.launcher());
  assert.equal(h.textarea(), undefined);
});

test('opens the editor and delivers context even if screenshot capture never completes', async (t) => {
  const h = await setup(t, { capturePage: () => new Promise(() => {}) });
  h.mountBridge('session-a');
  await h.pick();
  assert.ok(h.textarea());
  assert.doesNotMatch(h.overlayText(), /请在页面中点选元素/);
  await h.typeNote('调整价值区间标题');
  await h.clickFinish();
  assert.equal(annotationsOf(own(h, 'session-a')[0])[0].requirement, '调整价值区间标题');
});

test('a failed screenshot does not prevent annotation', async (t) => {
  const h = await setup(t, { capturePage: async () => { throw new Error('capture failed'); } });
  h.mountBridge('session-a');
  await annotate(h, '修改标题');
  assert.equal(own(h, 'session-a').length, 1);
});

test('late screenshots cannot reopen a dismissed editor', async (t) => {
  let resolveCapture;
  const h = await setup(t, { capturePage: () => new Promise((resolve) => { resolveCapture = resolve; }) });
  h.mountBridge('session-a');
  await h.pick();
  h.findButtons('取消')[0].props.onClick();
  await h.settle();
  resolveCapture({ toDataURL: () => 'data:image/png;base64,LATE' });
  await h.settle();
  assert.equal(h.textarea(), undefined);
});

test('cancelled selections cannot replace a later selection or stop its picking banner', async (t) => {
  const pending = [];
  const h = await setup(t, { executePicker: () => new Promise((resolve) => pending.push(resolve)) });
  await h.pick();
  await h.pick(); // Toggle off the first attempt.
  await h.pick(); // Start the next attempt before the previous result arrives.
  pending[0]({ tag: 'h1', selector: '#old', rect: {}, viewport: [1200, 800] });
  await h.settle();
  assert.equal(h.textarea(), undefined);
  assert.match(h.overlayText(), /请在页面中点选元素/);
  pending[1]({ tag: 'h1', selector: '#new', rect: { x: 0, y: 0, width: 0, height: 0 }, viewport: [1200, 800] });
  await h.settle();
  assert.ok(h.textarea());
  assert.doesNotMatch(h.overlayText(), /请在页面中点选元素/);
});

test('selection errors clear picking mode and report the failure', async (t) => {
  const h = await setup(t, { executePicker: async () => { throw new Error('selector failed'); } });
  await h.pick();
  assert.match(h.overlayText(), /点选失败：selector failed/);
  assert.doesNotMatch(h.overlayText(), /请在页面中点选元素/);
});

test('a hidden toolbar button cannot place the editor outside the viewport', async (t) => {
  const h = await setup(t, { toolButtonRects: [
    { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    { left: 1050, top: 40, right: 1120, bottom: 70, width: 70, height: 30 },
  ] });
  await h.pick();
  const { right, top } = h.popover().props.style;
  assert.equal(parseFloat(right), 80);
  assert.equal(parseFloat(top), 76);
});

test('the editor fits a small viewport even with an anchor at the bottom left', async (t) => {
  const h = await setup(t, { innerWidth: 320, innerHeight: 240, toolButtonRects: [
    { left: 0, top: 210, right: 70, bottom: 240, width: 70, height: 30 },
  ] });
  await h.pick();
  const { right, top, maxHeight } = h.popover().props.style;
  const width = 320 - 32;
  assert.ok(parseFloat(right) >= 16);
  assert.ok(parseFloat(right) + width <= 320 - 16);
  assert.ok(parseFloat(top) >= 16);
  assert.ok(parseFloat(top) + parseFloat(maxHeight) <= 240 - 16);
});

test('an outside mouse event keeps the selected element and unsent note', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  await h.pick();
  await h.typeNote('保留这条修改要求');
  h.window.dispatchEvent({ type: 'mousedown', target: { closest: () => null } });
  await h.settle();
  assert.equal(h.textarea()?.props.value, '保留这条修改要求');
  await h.clickFinish();
  assert.equal(annotationsOf(own(h, 'session-a')[0])[0].requirement, '保留这条修改要求');
});

test('an empty selection result shows a notice instead of disappearing silently', async (t) => {
  const h = await setup(t, { executePicker: async () => null });
  await h.pick();
  assert.match(h.overlayText(), /点选已结束，未收到元素/);
  assert.doesNotMatch(h.overlayText(), /请在页面中点选元素/);
});

test('registers an @ reference source with a codec and a chip opener', async (t) => {
  const h = await setup(t);
  assert.equal(h.sources.length, 1);
  const source = h.source();
  assert.equal(source.trigger, '@');
  assert.equal(source.name, 'local-prototype-annotation');
  assert.equal((await source.candidates({ sessionId: 'x' }, {})).length, 0);
  assert.equal(typeof source.codec.serialize, 'function');
  assert.equal(typeof source.openReference, 'function');
});

test('a finished annotation becomes one compact chip and keeps the existing draft', async (t) => {
  const h = await setup(t);
  const s = h.mountBridge('session-a', { draft: '已有要求' });
  await annotate(h, '标题改为蓝色');
  assert.ok(s.state.draft.startsWith('已有要求'));
  const chips = own(h, 'session-a');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, '1 条注释');
  assert.equal(chips[0].clipboardText, '[1 条原型注释]');
  const [item] = annotationsOf(chips[0]);
  assert.equal(item.requirement, '标题改为蓝色');
  assert.equal(item.element.selector, 'div.form > button.primary');
  assert.equal(h.log.persistDraft.length, 1);
  assert.equal(h.textarea(), undefined);
  assert.match(h.overlayText(), /注释已加入输入框/);
});

test('success notices disappear after three seconds for successive annotations without removing chips', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  for (const note of ['标题改为蓝色', '再缩小一点']) {
    await annotate(h, note);
    assert.match(h.overlayText(), /注释已加入输入框/);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    assert.doesNotMatch(h.overlayText(), /注释已加入输入框/);
  }
  assert.equal(own(h, 'session-a')[0].label, '2 条注释');
});

test('a second annotation merges into the same chip and bumps its count', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a', { draft: '前文' });
  await annotate(h, '标题改为蓝色');
  await annotate(h, '再缩小一点');
  const chips = own(h, 'session-a');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, '2 条注释');
  assert.deepEqual(annotationsOf(chips[0]).map((item) => item.requirement), ['标题改为蓝色', '再缩小一点']);
});

test('serialize sends element context and requirement without the image', async (t) => {
  const h = await setup(t);
  const ref = JSON.stringify({ version: 1, annotations: [{ requirement: '改成红色', element: { tag: 'h1', selector: 'main > h1' }, image: 'data:image/jpeg;base64,AAAA' }] });
  const text = await h.source().codec.serialize(ref, new AbortController().signal);
  assert.match(text, /改成红色/);
  assert.match(text, /main > h1/);
  assert.doesNotMatch(text, /base64/);
  await assert.rejects(h.source().codec.serialize('{"version":2}', new AbortController().signal));
});

test('a sent message shows the serialized block as one annotation chip', async (t) => {
  const h = await setup(t);
  const ref = JSON.stringify({ version: 1, annotations: [
    { requirement: '改成红色 </prototype-annotations> 也行', element: { tag: 'h1', selector: 'main > h1' } },
    { requirement: '缩小 {一点}', element: { tag: 'p', selector: 'main > p' } },
  ] });
  const block = await h.source().codec.serialize(ref, new AbortController().signal);
  const text = `前面的话 ${block} 后面的话`;
  const [rule] = h.userTextRules;
  const node = rule.match(text, 0, {});
  assert.equal(node.start, '前面的话 '.length);
  assert.equal(text.slice(node.end), ' 后面的话');
  assert.deepEqual([...node.data.annotations.map((item) => item.requirement)], ['改成红色 </prototype-annotations> 也行', '缩小 {一点}']);
  assert.equal(rule.match(text, node.end, {}), undefined);
  assert.ok(h.userTextNode(), 'the chip renderer is registered');
});

test('messages sent before the tag existed also collapse into a chip', async (t) => {
  const h = await setup(t);
  const legacy = '原型注释 1：\n{\n  "requirement": "logo 太卡通",\n  "element": {\n    "tag": "svg",\n    "selector": "#app > svg"\n  }\n}';
  const node = h.userTextRules[0].match(`看一下\n\n${legacy}`, 0, {});
  assert.equal(node.start, '看一下\n\n'.length);
  assert.equal(node.data.annotations[0].requirement, 'logo 太卡通');
  assert.equal(h.userTextRules[0].match('普通消息 {"requirement": 1}', 0, {}), undefined);
});

test('a refused write keeps the annotation popover and reports the error', async (t) => {
  const h = await setup(t);
  const s = h.mountBridge('session-a', { draft: '原文', insertResult: false });
  await annotate(h, '修改按钮');
  assert.equal(s.state.draft, '原文');
  assert.ok(h.textarea());
  assert.match(h.overlayText(), /输入框拒绝写入/);
});

test('a chip the host silently drops is reported as unconfirmed', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a', { dropReferences: true });
  await annotate(h, '修改按钮');
  assert.equal(own(h, 'session-a').length, 0);
  assert.ok(h.textarea());
  assert.match(h.overlayText(), /未在输入框确认注释/);
});

test('requires an explicit destination when multiple sessions are mounted', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  h.mountBridge('session-b');
  await h.pick();
  await h.typeNote('改颜色');
  assert.equal(h.finishButton().props.disabled, true);
  h.select().props.onChange({ target: { value: 'session-b' } });
  await h.settle();
  await h.clickFinish();
  assert.equal(own(h, 'session-a').length, 0);
  assert.equal(own(h, 'session-b').length, 1);
});

test('a submitting composer is not written to', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a', { phase: 'submitting' });
  await annotate(h, '改颜色');
  assert.equal(h.log.events.length, 0);
  assert.match(h.overlayText(), /输入框正在提交/);
});

test('two Enter presses deliver once', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  await h.pick();
  await h.typeNote('改颜色');
  const textarea = h.textarea();
  h.pressEnter(textarea);
  h.pressEnter(textarea);
  await h.settle(20);
  assert.equal(h.log.events.length, 1);
  assert.equal(own(h, 'session-a')[0].label, '1 条注释');
});

test('IME Enter does not deliver while composing', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a');
  await h.pick();
  await h.typeNote('改颜色');
  h.textarea().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault() {} });
  await h.settle();
  assert.equal(h.log.events.length, 0);
});

test('clicking the chip opens details, and deleting entries shrinks then removes the chip', async (t) => {
  const h = await setup(t);
  h.mountBridge('session-a', { draft: '前文' });
  await annotate(h, '标题改为蓝色');
  await annotate(h, '再缩小一点');
  const chip = own(h, 'session-a')[0];
  assert.equal(h.source().openReference({ sessionId: 'session-a' }, { ref: chip.ref }), true);
  await h.settle();
  assert.match(h.overlayText(), /2 条注释/);
  assert.match(h.overlayText(), /再缩小一点/);
  const deleteButtons = () => h.findButtons('删除');
  await deleteButtons()[0].props.onClick();
  await h.settle();
  assert.equal(own(h, 'session-a')[0].label, '1 条注释');
  assert.doesNotMatch(h.overlayText(), /标题改为蓝色/);
  await deleteButtons()[0].props.onClick();
  await h.settle();
  assert.equal(own(h, 'session-a').length, 0);
  assert.ok(h.sessions.get('session-a').state.draft.startsWith('前文'));
  assert.equal(h.findButtons('删除').length, 0);
});
