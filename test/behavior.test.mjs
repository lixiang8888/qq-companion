// 情绪影响节奏：心情好回得快、可多补一句；心情差别刷屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { replyPlan } from '../src/affect/behavior.js';
import { applyDamage, initState, pushEmotion } from '../src/affect/core.js';

const T0 = 0;
const base = initState(T0);

test('心情好：更快、允许更多条', () => {
  const happy = pushEmotion(base, { v: 0.9, a: 0.5, intensity: 0.6 }, T0);
  const ok = replyPlan(happy);
  const low = replyPlan({ ...base, mood: { ...base.mood, v: 0.2 } });
  assert.ok(ok.delayMs < low.delayMs, `${ok.delayMs} 应小于 ${low.delayMs}`);
  assert.ok(ok.maxParts >= low.maxParts);
});

test('被戳到（强度高）：只发一条', () => {
  const poked = pushEmotion(base, { v: 0.1, a: 0.9, intensity: 1.5 }, T0);
  assert.equal(replyPlan(poked).maxParts, 1);
});

test('戒备高：更慢', () => {
  const guarded = applyDamage(base, 0.1, T0).state;
  assert.ok(replyPlan(guarded).delayMs > replyPlan(base).delayMs);
});

test('延迟有上下限，不会把一轮拖到分钟级', () => {
  const worst = replyPlan({ ...base, mood: { ...base.mood, v: 0 }, relation: { ...base.relation, guard: 0.7 } }, { baseDelayMs: 60_000 });
  assert.ok(worst.delayMs <= 15000);
  const best = replyPlan({ ...base, mood: { ...base.mood, v: 1 } }, { baseDelayMs: 1 });
  assert.ok(best.delayMs >= 250);
});

test('条数上限不超过 3：再高兴也不该连发六条', () => {
  const veryHappy = { ...base, mood: { ...base.mood, v: 0.99 } };
  assert.ok(replyPlan(veryHappy).maxParts <= 3);
});
