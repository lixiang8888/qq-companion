// 四层状态的离线判据（手册 §9.4/§9.5/§10.2 里能离线跑的部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE, DAY_MS, EMOTION_HALF_MS, GUARD_MAX, TRAIT_BASE,
  applyDamage, applyDrift, applyWarmth, canDrift, dayKeyOf, initState, monthOf, moodBucket, pushEmotion, settle, stateHash,
} from '../src/affect/core.js';
import { buildContext, moodLabel, stateLine } from '../src/affect/inject.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const T0 = Date.UTC(2026, 0, 1);

test('情绪：一个半衰期后强度减半', () => {
  const s = pushEmotion(initState(T0), { v: 0.9, a: 0.8, intensity: 0.8 }, T0);
  near(s.emotion.intensity, 0.8);
  const later = settle(s, T0 + EMOTION_HALF_MS);
  near(later.emotion.intensity, 0.4);
});

test('情绪：足够久之后归零并回到基线', () => {
  const s = pushEmotion(initState(T0), { v: 0.95, a: 0.9, intensity: 1 }, T0);
  const later = settle(s, T0 + 4 * 3600e3);
  assert.equal(later.emotion.intensity, 0);
  near(later.emotion.v, BASELINE.v);
  near(later.emotion.a, BASELINE.a);
});

test('心境：强情绪过后跟过去，不会隔夜丢掉', () => {
  const s = pushEmotion(initState(T0), { v: 0.9, a: 0.5, intensity: 1 }, T0);
  const v1 = s.emotion.v;
  const s8 = settle(s, T0 + 8 * 3600e3);
  const s24 = settle(s8, T0 + 24 * 3600e3);
  const m8 = s8.mood.v;
  const m24 = s24.mood.v;
  assert.ok(m8 > BASELINE.v && m8 < v1, `心境 ${m8} 应落在基线与情绪之间`);
  assert.ok(m24 < m8, '更久之后应向基线回落');
});

test('关系：单次封顶 0.10，日封顶 0.10', () => {
  const s0 = initState(T0);
  const a = applyDamage(s0, 0.5, T0);
  near(a.applied, 0.1);
  near(a.state.relation.guard, 0.3);
  const b = applyDamage(a.state, 0.1, T0 + 1000);
  assert.equal(b.applied, 0, '同一天额度已用完');
  near(b.state.relation.guard, 0.3);
});

test('关系：guard 只升不降，30 天内不回落，之后按月 −0.01', () => {
  const s1 = applyDamage(initState(T0), 0.1, T0).state;
  near(settle(s1, T0 + 29 * DAY_MS).relation.guard, 0.3);
  near(settle(s1, T0 + 59 * DAY_MS).relation.guard, 0.29);
  near(settle(s1, T0 + 89 * DAY_MS).relation.guard, 0.28);
});

test('关系：guard 不超过 0.7', () => {
  let s = initState(T0);
  for (let i = 0; i < 20; i++) s = applyDamage(s, 0.1, T0 + i * DAY_MS).state;
  near(s.relation.guard, GUARD_MAX);
});

test('关系：修复按剩余损伤比例，半衰期 4 天', () => {
  const s1 = applyDamage(initState(T0), 0.1, T0).state;
  near(s1.relation.trust, 0.42);
  const s4 = settle(s1, T0 + 4 * DAY_MS);
  near(s4.relation.residual, 0.05);
  near(s4.relation.trust, 0.46);
  near(s4.relation.guard, 0.3, 1e-12); // 忘了不等于原谅
});

test('关系：被认真对待会加温，但一天封顶、不碰 guard', () => {
  const s0 = applyDamage(initState(T0), 0.1, T0).state; // 先欠下一点戒备
  const w = applyWarmth(s0, 0.02, T0);
  assert.ok(w.applied > 0);
  assert.ok(w.state.relation.trust > s0.relation.trust);
  assert.ok(w.state.relation.intimacy > s0.relation.intimacy);
  assert.equal(w.state.relation.guard, s0.relation.guard, '加温不该降低戒备');

  // 一天最多 0.05
  let st = s0;
  for (let i = 0; i < 10; i++) st = applyWarmth(st, 0.02, T0 + i * 1000).state;
  assert.ok(st.relation.dayWarmth <= 0.0501, `实际 ${st.relation.dayWarmth}`);

  // 第二天额度恢复
  const tomorrow = applyWarmth(st, 0.02, T0 + DAY_MS);
  assert.ok(tomorrow.applied > 0);
});

test('人格：触发条件是 ≥5 次且跨 ≥3 天', () => {
  assert.equal(canDrift({ hits: 4, spanDays: 30 }), false);
  assert.equal(canDrift({ hits: 5, spanDays: 2 }), false);
  assert.equal(canDrift({ hits: 5, spanDays: 3 }), true);
});

test('人格：单次 ≤0.02，日累计 ≤0.05', () => {
  const s0 = initState(T0);
  const a = applyDrift(s0, { sensitivity: 0.09, aggression: -0.09 }, T0);
  near(a.applied.sensitivity, 0.02);
  near(a.applied.aggression, -0.02);
  near(a.state.self.dayDrift, 0.04);
  const b = applyDrift(a.state, { sensitivity: 0.09 }, T0 + 1000);
  near(b.applied.sensitivity, 0.01, 1e-12);
  near(b.state.self.dayDrift, 0.05);
});

test('人格：不回拉就永远不回基线（1.5%/天）', () => {
  const s = applyDrift(initState(T0), { sensitivity: 0.03 }, T0).state;
  near(s.self.sensitivity, 0.52, 1e-12);
  const after = settle(s, T0 + 30 * DAY_MS).self.sensitivity;
  assert.ok(after > TRAIT_BASE.sensitivity && after < 0.522, `回拉后 ${after}`);
});

test('重放：同一事件序列两次哈希一致', () => {
  const run = () => {
    let s = initState(T0);
    s = pushEmotion(s, { v: 0.8, a: 0.7, intensity: 0.6 }, T0);
    s = applyDamage(s, 0.05, T0 + 1000).state;
    s = applyDrift(s, { openness: 0.02 }, T0 + 2000).state;
    return stateHash(settle(s, T0 + DAY_MS));
  };
  assert.equal(run(), run());
});

test('重放：时钟回拨不产生负残余、不推进结算点', () => {
  const s1 = applyDamage(initState(T0), 0.1, T0).state;
  const fwd = settle(s1, T0 + DAY_MS);
  const back = settle(fwd, T0);
  assert.ok(back.relation.residual >= 0);
  near(back.relation.residual, fwd.relation.residual);
  near(back.relation.guard, fwd.relation.guard);
});

test('结算幂等：同一时刻连调两次状态不变', () => {
  const s1 = applyDamage(initState(T0), 0.1, T0).state;
  const once = settle(s1, T0 + DAY_MS);
  const twice = settle(once, T0 + DAY_MS);
  assert.equal(stateHash(once), stateHash(twice));
});

test('心境分桶带滞回：桶内抖动不换桶', () => {
  const st = { mood: { v: 0.46 } };
  assert.equal(moodBucket(st, { prev: 4 }), 4, '0.46 在 0.4 桶中心 ±0.02 内');
  assert.equal(moodBucket({ mood: { v: 0.52 } }, { prev: 4 }), 5);
});

test('注入：状态变化会改变措辞，且明说不许说出口', () => {
  const calm = buildContext(initState(T0));
  const poked = pushEmotion(initState(T0), { v: 0.1, a: 0.8, intensity: 1.5 }, T0);
  const annoyed = buildContext(applyDamage(poked, 0.05, T0).state);
  assert.notEqual(calm, annoyed);
  assert.match(calm, /不要说出口/);
  assert.match(annoyed, /事实、数字、承诺/);
  assert.ok(calm.length < 200 && annoyed.length < 200, '注入块要短');
});

test('注入：面板摘要能一眼看懂', () => {
  const st = applyDamage(initState(T0), 0.05, T0).state;
  const line = stateLine(st);
  assert.match(line, /心情/);
  assert.match(line, /信任/);
  assert.equal(moodLabel(0.9), '不错');
  assert.equal(moodLabel(0.1), '不太好');
});

test('每日伤害上限在本地午夜重置，而不是早上八点', () => {
  const night = new Date(2026, 2, 10, 23, 0, 0).getTime();
  const afterMidnight = new Date(2026, 2, 11, 0, 10, 0).getTime();
  let st = initState(night);
  st = applyDamage(st, 0.05, night).state;
  st = applyDamage(st, 0.05, night + 30 * 60e3).state;
  near(st.relation.dayDamage, 0.10); // 当天已经顶到 0.10
  const blocked = applyDamage(st, 0.02, night + 40 * 60e3).state;
  near(blocked.relation.dayDamage, 0.10); // 同一本地日不能再加
  const next = applyDamage(st, 0.02, afterMidnight).state;
  near(next.relation.dayDamage, 0.02); // 过了本地午夜重新计
});
