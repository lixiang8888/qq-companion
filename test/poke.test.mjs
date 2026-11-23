// 他戳了戳她（QQ 拍一拍）：认事件、给提示、解读反应。
// 根因：事件是 notice，不是 message，以前在第一行就被丢掉了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { composePokeReply, normalizePoke, parsePokeReaction, pokeFromMessage, pokeText } from '../src/poke.js';

const ev = (over = {}) => ({
  post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  user_id: 42, sender_id: 42, target_id: 99, action: '戳了戳', suffix: '', time: 1767229200,
  ...over,
});

test('认私聊戳一戳：对端、动手的、被戳的都带出来', () => {
  const p = normalizePoke(ev());
  assert.equal(p.kind, 'private');
  assert.equal(p.peerId, '42');
  assert.equal(p.senderId, '42');
  assert.equal(p.targetId, '99');
  assert.equal(p.at, 1767229200 * 1000);
});

test('不认别的：消息事件、群戳、缺 id 的都返回 null', () => {
  assert.equal(normalizePoke({ post_type: 'message', user_id: 42 }), null);
  assert.equal(normalizePoke(ev({ group_id: 9 })), null);
  assert.equal(normalizePoke(ev({ notice_type: 'friend_recall' })), null);
  assert.equal(normalizePoke(ev({ sub_type: 'other' })), null);
  assert.equal(normalizePoke(ev({ user_id: '' })), null);
  assert.equal(normalizePoke(null), null);
});

test('他那一下怎么说：默认「戳了戳」，自定义拍一拍也带上尾巴', () => {
  assert.equal(pokeText({ action: '戳了戳' }), '他戳了戳你');
  assert.equal(pokeText({ action: '拍了拍', suffix: '我的小脑袋' }), '他拍了拍你（我的小脑袋）');
  assert.equal(pokeText({ action: '拍了' }), '他拍了你');
  assert.equal(pokeText({}), '他戳了戳你');
});

test('提示：说清不是消息、给她此刻和最后一句、要求短', () => {
  const t = composePokeReply({
    clock: '1月1日 周四 21:00',
    poke: { action: '拍了拍', suffix: '我的脑袋' },
    doing: '在看书',
    lastLine: '我先去忙了',
    feel: '心情平常 · 被晾',
  });
  assert.match(t, /21:00/);
  assert.match(t, /不是一条消息/);
  assert.match(t, /在看书/);
  assert.match(t, /我先去忙了/);
  assert.match(t, /不超过 12 个字/);
  assert.match(t, /\[戳回去\]/);
  assert.match(t, /\[沉默\]/);
  // 脱敏：拍一拍的 action/suffix 是外部来的，不能原样进系统提示
  const dirty = composePokeReply({ clock: '21:00', poke: { action: 'sk-abcdefgh', suffix: '' } });
  assert.ok(!dirty.includes('sk-abcdefgh'));
});

test('解读她的反应：一句话、只标记、沉默、什么都没写', () => {
  assert.deepEqual(parsePokeReaction('干嘛'), { text: '干嘛', pokeBack: false, silent: false });
  assert.deepEqual(parsePokeReaction('[戳回去]'), { text: '', pokeBack: true, silent: false });
  assert.deepEqual(parsePokeReaction('在忙呢 [戳回去]'), { text: '在忙呢', pokeBack: true, silent: false });
  assert.deepEqual(parsePokeReaction('[沉默]'), { text: '', pokeBack: false, silent: true });
  // 什么都没写：至少回戳一下——被戳了没反应才是怪事。
  assert.deepEqual(parsePokeReaction('  '), { text: '', pokeBack: true, silent: false });
  // 代码块洗掉，长度封死
  assert.equal(parsePokeReaction('```\n干嘛\n```').text, '干嘛');
  const long = parsePokeReaction('啊'.repeat(200));
  assert.equal(long.text.length, 80);
});

test('有的客户端把拍一拍发成消息：poke 段 / QQ 兜底文本都认，正常聊天不算', () => {
  const p = pokeFromMessage({
    userId: '42',
    text: '[poke] [戳一戳]请使用最新版手机QQ体验新功能。',
    segments: [{ type: 'poke' }, { type: 'text', data: { text: '[戳一戳]请使用最新版手机QQ体验新功能。' } }],
    at: 1767229200000,
  });
  assert.equal(p.peerId, '42');
  assert.equal(p.senderId, '42');
  assert.equal(p.action, '戳了戳');
  const q = pokeFromMessage({ userId: '42', text: '[shake]', segments: [{ type: 'shake' }], at: 1 });
  assert.equal(q.action, '抖了抖');
  // 只有 QQ 自己的兜底文本，也算（客户端把段吃掉了）
  assert.equal(pokeFromMessage({ userId: '42', text: '[戳一戳]请使用最新版手机QQ体验新功能。', segments: [], at: 1 }).action, '戳了戳');
  // 正常聊天里提到"拍一拍/戳一戳"不算
  assert.equal(pokeFromMessage({ userId: '42', text: '我拍一拍你的脑袋', segments: [], at: 1 }), null);
  assert.equal(pokeFromMessage({ userId: '42', text: '戳一戳是什么', segments: [], at: 1 }), null);
  assert.equal(pokeFromMessage(null), null);
});
