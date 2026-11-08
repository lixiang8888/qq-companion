// 消息映射与拆条：协议细节在这里钉死，真机出问题时先怀疑传输层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardIdOf, normalizeMessage, renderForward, splitReply } from '../src/message.js';

const base = { post_type: 'message', self_id: 100, time: 1700000000 };

test('私聊：文本 + 图片 → 统一形状', () => {
  const m = normalizeMessage({
    ...base,
    message_type: 'private',
    user_id: 42,
    message_id: 7,
    sender: { nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗 ' } }, { type: 'image', data: { file: 'a.jpg' } }],
  });
  assert.equal(m.chatId, 'private:42');
  assert.equal(m.kind, 'private');
  assert.equal(m.text, '在吗 [图片]');
  assert.equal(m.messageId, '7');
  assert.equal(m.at, 1700000000000);
});

test('群聊：带群号；缺群号则丢弃', () => {
  const ok = normalizeMessage({ ...base, message_type: 'group', group_id: 9, user_id: 1, message: [{ type: 'text', data: { text: 'hi' } }] });
  assert.equal(ok.chatId, 'group:9');
  assert.equal(normalizeMessage({ ...base, message_type: 'group', user_id: 1 }), null);
});

test('@ 段与未知段不让文本崩', () => {
  const m = normalizeMessage({
    ...base, message_type: 'group', group_id: 9, user_id: 1,
    message: [{ type: 'at', data: { name: '大肥鱼' } }, { type: 'text', data: { text: '你看' } }, { type: 'mystery' }],
  });
  assert.match(m.text, /@大肥鱼/);
  assert.match(m.text, /\[mystery\]/);
});

test('非消息事件返回 null', () => {
  assert.equal(normalizeMessage({ post_type: 'notice' }), null);
  assert.equal(normalizeMessage(null), null);
});

test('拆条：长段落按句末标点拆，不甩小作文', () => {
  const long = '今天真的发生了很多事。早上差点迟到，地铁还坏了一站。中午吃饭排了二十分钟队。下午开会开到五点。晚上回来路上买了两个包子。';
  const parts = splitReply(long, { max: 6, maxChars: 30 });
  assert.ok(parts.length > 1, '应该拆成多条');
  assert.ok(parts.every((p) => p.length <= 40), `有超长条：${parts.map((p) => p.length)}`);
  assert.ok(parts.every((p) => /[。！？]?$/.test(p)));
});

test('拆条：没有标点的超长句也会被切成可发的长度', () => {
  const parts = splitReply('啊'.repeat(700), { max: 4, maxChars: 200 });
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 200));
});

test('拆条：按换行、去空行、最多 4 条', () => {
  assert.deepEqual(splitReply('一\n\n二\n三'), ['一', '二', '三']);
  assert.deepEqual(splitReply('1\n2\n3\n4\n5\n6'), ['1', '2', '3', '4']);
  assert.deepEqual(splitReply('  '), []);
  assert.deepEqual(splitReply('一句话\n'), ['一句话']);
});

test('颜文字不能被拦腰切断：括号里的标点不算句末', () => {
  const long = '好累啊'.repeat(80) + '(´；ω；｀)' + '真的'.repeat(80);
  const parts = splitReply(long, { max: 4, maxChars: 300 });
  assert.ok(parts.some((p) => p.includes('(´；ω；｀)')), JSON.stringify(parts));
});

test('括号里的句号不切，括号外的切', () => {
  // 括号里的那个「。」如果被当成句末，这里会多切出一条来。
  assert.deepEqual(splitReply('他说（好的。）。然后走了。', { maxChars: 8 }), ['他说（好的。）。', '然后走了。']);
});

test('嵌套括号里的句号也不切', () => {
  const long = '啊'.repeat(60) + '（外面（里面。还有）还是）。' + '嗯'.repeat(60);
  const parts = splitReply(long, { maxChars: 70 });
  assert.ok(parts.some((p) => p.includes('（外面（里面。还有）还是）。')), JSON.stringify(parts));
});

test('括号没闭合也不能卡住：照样切成可发的长度', () => {
  const parts = splitReply('啊'.repeat(400) + '（没闭合' + '。' + '后面还有', { max: 4, maxChars: 300 });
  assert.ok(parts.length > 0);
  assert.ok(parts.every((p) => p.length <= 300), `有超长条：${parts.map((p) => p.length)}`);
});

test('嵌套括号也不切', () => {
  assert.deepEqual(splitReply('（外面（里面。还有）还是）。', { maxChars: 200 }), ['（外面（里面。还有）还是）。']);
});

// 合并转发：段里只有一个 id，内容在 get_forward_msg。以前只留「[转发]」两个字，
// 她只能说「转发过来是空的」。
test('认出合并转发的 id', () => {
  assert.equal(forwardIdOf([{ type: 'text', data: { text: '看' } }, { type: 'forward', data: { id: 'abc/==' } }]), 'abc/==');
  assert.equal(forwardIdOf([{ type: 'text', data: { text: '看' } }]), '');
  assert.equal(forwardIdOf([{ type: 'forward', data: {} }]), '');
});

test('把转发里的几条消息压成「谁：说了什么」', () => {
  const nodes = [
    { sender: { nickname: '璃湘' }, message: [{ type: 'text', data: { text: '我为什么要去健身' } }] },
    { sender: { card: '肥鱼' }, message: [{ type: 'text', data: { text: '你想想呗' } }] },
    { sender: { nickname: '璃湘' }, message: [{ type: 'image', data: { file: 'x.jpg' } }] },
  ];
  const out = renderForward(nodes);
  assert.match(out, /璃湘：我为什么要去健身/);
  assert.match(out, /肥鱼：你想想呗/, '有群名片的用群名片');
  assert.match(out, /璃湘：\[图片\]/);
  assert.equal(renderForward([]), '');
  assert.equal(renderForward(null), '');
});

test('转发太长会截断，不把整段聊天记录塞进来', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '第' + i + '句' } }] }));
  const out = renderForward(nodes, { maxNodes: 3, maxChars: 12 });
  assert.equal(out.split('\n').length, 3, '最多三条');
  assert.match(out, /…（后面还有）$/);
});
