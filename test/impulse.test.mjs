// 情绪上来的念头：什么时候冒、什么时候回头看、两句都留着。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_GAP_MS, MAX_PER_DAY, TTL_MS, SETTLE_MIN_MS,
  applySettle, applyThought, countToday, createImpulses, dueSettle, dueThought,
  parseSettle, parseThought, renderImpulses, settlePrompt, thoughtPrompt,
} from '../src/impulse.js';

const HOUR = 3600e3;

const state = ({ intensity = 0, mood = 0.5, label = '', v = 0.5 } = {}) => ({
  emotion: { intensity, mood, label, v, a: 0.5, d: 0.5 },
  mood: { v: mood },
});

test('情绪上来才冒念头：强度够、心情极端，都算有来处', () => {
  const imp = createImpulses();
  const t = Date.UTC(2026, 10, 24, 10, 0);
  assert.equal(dueThought(state({ intensity: 0.6 }), imp, t), true, '刚被戳到');
  assert.equal(dueThought(state({ mood: 0.2 }), imp, t), true, '心情很低');
  assert.equal(dueThought(state({ mood: 0.8 }), imp, t), true, '心情很好');
  assert.equal(dueThought(state(), imp, t), false, '平平常常不硬想');
});

test('念头之间要隔够久，一天也有上限', () => {
  // 用本地上午起步：一天里的额度按本地午夜分界，跨了午夜就不该算同一天。
  const t0 = Date.UTC(2026, 10, 24, 2, 0);
  let imp = applyThought(createImpulses(), '算了，不想理他', t0, { v: 0.3 });
  assert.equal(dueThought(state({ intensity: 0.9 }), imp, t0 + MIN_GAP_MS - 1), false, '刚冒过就别连着冒');
  assert.equal(dueThought(state({ intensity: 0.9 }), imp, t0 + MIN_GAP_MS), true);
  for (let i = 1; i < MAX_PER_DAY; i += 1) imp = applyThought(imp, `第 ${i} 个`, t0 + i * MIN_GAP_MS, { v: 0.3 });
  assert.equal(countToday(imp, t0 + 6 * HOUR), MAX_PER_DAY);
  assert.equal(dueThought(state({ intensity: 0.9 }), imp, t0 + 6 * HOUR), false, '一天最多四次，多了就是刷念头');
});

test('平复要等够久、也要情绪真的下去', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '他让我难受，我不理他了', t0, { v: 0.3 });
  assert.equal(dueSettle(imp, state({ intensity: 0.8 }), t0 + SETTLE_MIN_MS - 1), null, '劲儿还没过');
  assert.equal(dueSettle(imp, state({ intensity: 0.8 }), t0 + SETTLE_MIN_MS), null, '还上头就不问「现在怎么想」');
  const open = dueSettle(imp, state({ intensity: 0.05 }), t0 + SETTLE_MIN_MS);
  assert.ok(open, '情绪下去了，该回头看一眼');
  assert.equal(open.text, '他让我难受，我不理他了');
});

test('「没变」也要落一行：不然每十分钟问一遍同一句', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '算了', t0, { v: 0.3 });
  const next = applySettle(imp, t0, parseSettle('没变'), t0 + HOUR);
  assert.equal(next.lines[0].settled.text, '', '没变存空串');
  assert.equal(dueSettle(next, state(), t0 + 2 * HOUR), null, '问过了就不再问');
  assert.doesNotMatch(renderImpulses(next, t0 + 2 * HOUR), /没变/, '空的不显示成一句想法');
});

test('前后两种想法都摆出来：这是她自己的矛盾，不是编的', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  let imp = applyThought(createImpulses(), '他让我伤心了，我不理他了', t0, { v: 0.25 });
  assert.match(renderImpulses(imp, t0 + HOUR), /他让我伤心了/);
  imp = applySettle(imp, t0, '其实他也不是故意的', t0 + 2 * HOUR);
  const line = renderImpulses(imp, t0 + 3 * HOUR);
  assert.match(line, /他让我伤心了/, '先前的想法');
  assert.match(line, /其实他也不是故意的/, '后来的想法');
});

test('念头会过期：六小时前的嘀咕不该还被她当成「刚冒出来的」', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '好想他', t0, { v: 0.8 });
  assert.match(renderImpulses(imp, t0 + TTL_MS - 1), /好想他/);
  assert.equal(renderImpulses(imp, t0 + TTL_MS), '');
});

test('提示词：带上真实状态，问的是一句没逻辑的嘀咕', () => {
  const t = Date.UTC(2026, 10, 24, 10, 0);
  const p = thoughtPrompt(state({ intensity: 0.8, mood: 0.2, label: '低落', v: 0.25 }), { now: t });
  assert.match(p, /心情有点低/);
  assert.match(p, /低落/);
  assert.match(p, /不超过 30 字/);
  assert.match(p, /往坏处想/);
  assert.doesNotMatch(p, /随机/, '不许让她随机编');
  assert.match(settlePrompt({ at: t, text: '算了' }, state(), t + HOUR), /回头看/);
});

test('解析：只收一句短话，引号去掉，「没有」= 这次不冒', () => {
  assert.equal(parseThought('「算了，不想理他」'), '算了，不想理他');
  assert.equal(parseThought('没有。'), '');
  assert.equal(parseThought(''), '');
  assert.equal(parseThought('啊'.repeat(50)).length, 30, '太长就截断，别把一段话塞进念头');
  assert.equal(parseSettle('还是那样'), '');
  assert.equal(parseSettle('其实还好'), '其实还好');
});

test('一条念头只平复一次（重复 applySettle 不覆盖）', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  let imp = applyThought(createImpulses(), '算了', t0, { v: 0.3 });
  imp = applySettle(imp, t0, '还好', t0 + HOUR);
  imp = applySettle(imp, t0, '另一句', t0 + 2 * HOUR);
  assert.equal(imp.lines[0].settled.text, '还好');
});
