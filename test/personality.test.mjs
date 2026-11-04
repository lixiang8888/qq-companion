// 人格漂移：证据累积 → 月度结算 → 快照回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, TRAIT_BASE, initState } from '../src/affect/core.js';
import { eligiblePatterns, monthlyDrift, notePattern, rollbackTraits, traitLine } from '../src/affect/personality.js';
import { buildContext } from '../src/affect/inject.js';

const T0 = Date.UTC(2026, 0, 5);

test('证据：同模式够 5 次且跨 3 天才算数', () => {
  let st = initState(T0);
  for (let i = 0; i < 4; i++) st = notePattern(st, '被冷落', { attachment: 0.01 }, T0 + i * DAY_MS);
  assert.equal(eligiblePatterns(st, T0).length, 0, '4 次不够');
  st = notePattern(st, '被冷落', { attachment: 0.01 }, T0 + 3 * DAY_MS);
  assert.equal(eligiblePatterns(st, T0 + 3 * DAY_MS).length, 1);
});

test('5 次挤在同一天：跨度不够，不结算', () => {
  let st = initState(T0);
  for (let i = 0; i < 5; i++) st = notePattern(st, '被冷落', { attachment: 0.01 }, T0 + i * 1000);
  assert.equal(eligiblePatterns(st, T0).length, 0);
});

test('月度结算：同月不重复，跨月才漂，且留快照、写叙事', () => {
  let st = initState(T0);
  for (let i = 0; i < 5; i++) st = notePattern(st, '被冷落', { attachment: 0.02 }, T0 + i * DAY_MS);

  const same = monthlyDrift(st, T0 + 5 * DAY_MS);
  assert.equal(same.changed, false, '同一个月的第一次只登记月份');

  const next = monthlyDrift(same.state, Date.UTC(2026, 1, 3));
  assert.equal(next.changed, true);
  assert.ok(next.applied.attachment > 0);
  assert.ok(next.state.self.attachment > TRAIT_BASE.attachment);
  assert.equal(next.state.self.snapshots.length, 1);
  assert.match(next.state.self.narrative, /在意/);
  assert.deepEqual(next.state.self.patterns, {}, '结算后清零');

  const again = monthlyDrift(next.state, Date.UTC(2026, 1, 20));
  assert.equal(again.changed, false, '一个月只结算一次');
});

test('单次幅度受限：结算不会把性格一次改掉', () => {
  let st = initState(T0);
  for (let i = 0; i < 5; i++) st = notePattern(st, '总被凶', { aggression: 0.5 }, T0 + i * DAY_MS);
  const r = monthlyDrift(st, Date.UTC(2026, 1, 2));
  assert.ok(r.applied.aggression <= 0.0201, `实际 ${r.applied.aggression}`);
});

test('回滚：只动特质，快照被消费掉', () => {
  let st = initState(T0);
  for (let i = 0; i < 5; i++) st = notePattern(st, '被冷落', { attachment: 0.02 }, T0 + i * DAY_MS);
  const r = monthlyDrift(st, Date.UTC(2026, 1, 2));
  const at = r.state.self.snapshots[0].at;
  const back = rollbackTraits(r.state, at);
  assert.equal(back.ok, true);
  assert.equal(back.state.self.attachment, TRAIT_BASE.attachment);
  assert.equal(back.state.self.snapshots.length, 0);
  assert.equal(rollbackTraits(r.state, 1).ok, false, '不存在的快照不许假装成功');
});

test('快照最多 20 版', () => {
  let st = initState(T0);
  st.self.snapshots = Array.from({ length: 20 }, (_, i) => ({ at: i + 1, traits: { ...TRAIT_BASE }, narrative: '' }));
  for (let i = 0; i < 5; i++) st = notePattern(st, '被冷落', { attachment: 0.02 }, T0 + i * DAY_MS);
  const r = monthlyDrift(st, Date.UTC(2026, 1, 2));
  assert.equal(r.state.self.snapshots.length, 20);
});

test('注入：反复漂移之后会说自己变了，且回拉让漂移收敛', () => {
  let st = initState(T0);
  for (let m = 0; m < 10; m++) {
    const base = Date.UTC(2026, m, 2);
    for (let i = 0; i < 5; i++) st = notePattern(st, '被冷落', { attachment: 0.02 }, base + i * DAY_MS);
    st = monthlyDrift(st, Date.UTC(2026, m + 1, 2)).state;
  }
  const dev = st.self.attachment - TRAIT_BASE.attachment;
  assert.ok(dev >= 0.05, `十个月后应看得出变化，实际 ${dev}`);
  assert.ok(dev < 0.09, `回拉应压住累积，实际 ${dev}`);
  assert.match(traitLine(st), /黏|在意/);
  const text = buildContext(st);
  assert.match(text, /在意|黏/);
  assert.match(text, /不要说出口/);
});
