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
