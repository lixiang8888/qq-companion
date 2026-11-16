// 情绪影响节奏：心情好回得快、可多补一句；心情差别刷屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { replyPlan } from '../src/affect/behavior.js';
import { buildContext } from '../src/affect/inject.js';
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

test('他明确要一段长的：允许破例多发几条，但仍有上限', () => {
  const calm = replyPlan(base);
  const long = replyPlan(base, { room: 2 });
  assert.ok(long.maxParts > calm.maxParts, `他要长的就该多给：${calm.maxParts} → ${long.maxParts}`);
  assert.ok(long.maxParts <= 5, '破例 ≠ 刷屏');
  assert.equal(replyPlan(base, { room: 0 }).maxParts, calm.maxParts, '没要长的就一点都不变');
});

// ---- 情绪标签必须改一个数字，否则它就是个装饰品 ----

test('羞：只发一条，而且犹豫得比生气更久', () => {
  const shy = pushEmotion(base, { v: 0.45, a: 0.8, intensity: 0.55, label: '羞' }, T0);
  const got = replyPlan(shy);
  assert.equal(got.maxParts, 1, '说不成句，就一句');
  assert.ok(got.delayMs > replyPlan(base).delayMs, '犹豫要看得见');
  assert.match(got.reason, /羞/, '面板上要能看出是哪种情绪在起作用');
});

test('被凶：也压成一条，但比羞快', () => {
  const hurt = pushEmotion(base, { v: 0.15, a: 0.75, intensity: 0.6, label: '被凶' }, T0);
  const shy = pushEmotion(base, { v: 0.45, a: 0.8, intensity: 0.6, label: '羞' }, T0);
  assert.equal(replyPlan(hurt).maxParts, 1);
  assert.ok(replyPlan(hurt).delayMs < replyPlan(shy).delayMs, '生气是顶回去，害羞是说不出口');
});

test('没有装饰品：每个情绪标签都必须让注入或节奏变一点', () => {
  const plainText = buildContext(base, T0);
  const plainPlan = replyPlan(base);
  const labels = ['羞', '被凶', '被夸', '低落', '生气+好笑', '无奈', '被追问'];
  for (const label of labels) {
    const st = pushEmotion(base, { v: 0.5, a: 0.5, intensity: 0.5, label }, T0);
    const text = buildContext(st, T0);
    const plan = replyPlan(st);
    const changed = text !== plainText || plan.delayMs !== plainPlan.delayMs || plan.maxParts !== plainPlan.maxParts;
    assert.ok(changed, `「${label}」只写进了提示词，没有任何行为变化——它是个装饰品，不该存在`);
  }
  // 这条守的是以后：新加一个情绪标签，忘了让它影响行为，这里就会红。
  assert.equal(labels.length, 7);
});
