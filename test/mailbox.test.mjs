// 连发合并：连续几条消息攒成一轮，安静窗口从最后一条算起。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailbox, mergeTexts } from '../src/mailbox.js';

const msg = (text, chatId = 'private:42') => ({ chatId, userId: '42', text });

/** 手动调度器：不真等 3 秒，测试里自己决定什么时候"窗口到点"。 */
function fakeScheduler() {
  const timers = [];
  return {
    later: (fn) => { timers.push(fn); return timers.length - 1; },
    clear: (h) => { if (typeof h === 'number') timers[h] = null; },
    fire() {
      const i = timers.findLastIndex((f) => typeof f === 'function');
      assert.ok(i >= 0, '没有待触发的窗口');
      const fn = timers[i];
      timers[i] = null;
      fn();
    },
    get pending() { return timers.filter((f) => typeof f === 'function').length; },
  };
}

test('三条连发：只触发一次，三条都在，顺序不变', async () => {
  const s = fakeScheduler();
  const got = [];
  const box = createMailbox({ windowMs: 3000, later: s.later, clear: s.clear, onFlush: (b) => { got.push(b); return 'ok'; } });

  box.push(msg('在吗'));
  box.push(msg('睡了吗'));
  box.push(msg('我跟你说个事'));
  assert.equal(got.length, 0, '窗口还没到，不该发');
  assert.equal(box.pending, 3);

  s.fire();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].texts, ['在吗', '睡了吗', '我跟你说个事']);
  assert.equal(box.pending, 0);
});

test('每条新消息都把窗口重置：间隔短就一直等', () => {
  const s = fakeScheduler();
  const got = [];
  const box = createMailbox({ windowMs: 3000, later: s.later, clear: s.clear, onFlush: (b) => { got.push(b); } });
  box.push(msg('一'));
  box.push(msg('二'));
  assert.equal(s.pending, 1, '旧窗口应该被清掉，只剩最后一个');
  s.fire();
  assert.equal(got.length, 1);
});

test('隔了一次窗口再说话：是两轮', () => {
  const s = fakeScheduler();
  const got = [];
  const box = createMailbox({ windowMs: 3000, later: s.later, clear: s.clear, onFlush: (b) => { got.push(b); } });
  box.push(msg('一'));
  s.fire();
  box.push(msg('二'));
  s.fire();
  assert.deepEqual(got.map((b) => b.texts), [['一'], ['二']]);
});

test('windowMs=0：立刻发，不攒', () => {
  const got = [];
  const box = createMailbox({ windowMs: 0, onFlush: (b) => { got.push(b); } });
  box.push(msg('一'));
  box.push(msg('二'));
  assert.deepEqual(got.map((b) => b.texts), [['一'], ['二']]);
});

test('换了个聊天对象：旧的先发出去，不能把两段对话混成一轮', () => {
  const s = fakeScheduler();
  const got = [];
  const box = createMailbox({ windowMs: 3000, later: s.later, clear: s.clear, onFlush: (b) => { got.push(b); } });
  box.push(msg('一', 'private:42'));
  box.push(msg('二', 'private:99'));
  assert.deepEqual(got.map((b) => [b.chatId, b.texts]), [['private:42', ['一']]]);
  s.fire();
  assert.deepEqual(got.map((b) => [b.chatId, b.texts]), [['private:42', ['一']], ['private:99', ['二']]]);
});

test('push 的 promise 在一轮跑完时拿到结果', async () => {
  const s = fakeScheduler();
  const box = createMailbox({ windowMs: 3000, later: s.later, clear: s.clear, onFlush: async () => '结果' });
  const p1 = box.push(msg('一'));
  const p2 = box.push(msg('二'));
  s.fire();
  assert.equal(await p1, '结果');
  assert.equal(await p2, '结果');
});

test('合并后的文本：正常拼接；太长就留最近的部分并说清楚', () => {
  assert.equal(mergeTexts(['在吗', '睡了吗']), '在吗\n睡了吗');
  const long = mergeTexts(['啊'.repeat(3000), '嗯'.repeat(3000)]);
  assert.ok(long.length <= 4000 + 20, `别无限长：${long.length}`);
  assert.ok(long.endsWith('嗯'.repeat(10)), '要留住他最后说的话');
  assert.match(long, /前面太长/);
});
