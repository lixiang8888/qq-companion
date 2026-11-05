// 发说说的判定：滞回、上位吸收、同类冷却、每日上限。纯函数，不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import { ENTER, EXIT, MIN_GAP_MS, SAME_KIND_MS, dayKeyOf, decidePost, notePosted, weighEvent } from '../src/qzone-post.js';

const H = 3600e3;
const T0 = new Date(2026, 10, 5, 20, 0).getTime(); // 2026-11-05 20:00 本地

test('没有事件就不发', () => {
  const out = decidePost({}, [], T0);
  assert.equal(out.post, false);
  assert.match(out.reason, /没有/);
});

test('关系动得多才够格：0.15 封顶，0.04 不算', () => {
  const top = weighEvent({ kind: 'relation', magnitude: 0.15 });
  assert.ok(Math.abs(top.weight - 1) < 1e-9, `封顶应该是 1，实际 ${top.weight}`);
  assert.equal(weighEvent({ kind: 'relation', magnitude: 0.04 }), null, '不到起算线当没发生');
});

test('上位吸收：几个信号同时来，只取最强的，不叠加', () => {
  const out = decidePost({}, [
    { kind: 'absence', magnitude: 30 * H },   // ≈0.5
    { kind: 'mood', magnitude: 0.9 },         // 0.9
    { kind: 'relation', magnitude: 0.08 },    // ≈0.3
  ], T0);
  assert.equal(out.post, true);
  assert.equal(out.kind, 'mood', '应该是情绪那条，不是拼起来的');
  assert.equal(out.weight, 0.9, '权重不能是 0.5+0.9+0.3');
});

test('幅度算不出来就当没发生（不确定取低一档）', () => {
  assert.equal(decidePost({}, [{ kind: 'mood', magnitude: Number.NaN }], T0).post, false);
  assert.equal(decidePost({}, [{ kind: 'mood' }], T0).post, false);
  assert.equal(decidePost({}, [{ kind: '胡说', magnitude: 1 }], T0).post, false);
});

test('滞回：没进入候选时按 0.55，已经在候选里按 0.45', () => {
  const weak = [{ kind: 'relation', magnitude: 0.10 }]; // (0.10-0.05)/0.10 = 0.5
  assert.equal(decidePost({ armed: false }, weak, T0).post, false, '0.50 < 0.55 不该发');
  assert.equal(decidePost({ armed: true }, weak, T0).post, true, '已经在候选里，0.50 > 0.45 放行');
  assert.ok(EXIT < ENTER);
});

test('同类冷却：同一个原因 20 小时内不再触发', () => {
  const state = { lastKindAt: { mood: T0 - 5 * H } };
  const out = decidePost(state, [{ kind: 'mood', magnitude: 0.95 }], T0);
  assert.equal(out.post, false, '5 小时前刚因为情绪发过，这次跳过');
  assert.ok(SAME_KIND_MS >= 20 * H);
});

test('同类冷却只挡那一类，不挡别的', () => {
  const state = { lastKindAt: { mood: T0 - 5 * H } };
  const out = decidePost(state, [{ kind: 'personality', magnitude: 1 }], T0);
  assert.equal(out.post, true);
  assert.equal(out.kind, 'personality');
});

test('一天一条：当天发过就不再发', () => {
  // 间隔要够（否则先被 20 小时那条拦住），所以只让「当天计数」说话。
  const state = { dayKey: dayKeyOf(T0), countToday: 1, lastPostAt: T0 - 21 * H };
  const later = decidePost(state, [{ kind: 'personality', magnitude: 1 }], T0);
  assert.equal(later.post, false);
  assert.match(later.reason, /今天/);
});

test('最小间隔：20 小时内一条都不发（跨天也不行）', () => {
  const state = notePosted({}, { kind: 'mood', at: T0 });
  const soon = decidePost({ ...state, dayKey: '2000-01-01' }, [{ kind: 'personality', magnitude: 1 }], T0 + MIN_GAP_MS - 1);
  assert.equal(soon.post, false);
});

test('发完更新状态：记下时间、原因、当天计数', () => {
  const state = notePosted({ countToday: 0 }, { kind: 'absence', at: T0 });
  assert.equal(state.lastPostAt, T0);
  assert.equal(state.dayKey, dayKeyOf(T0));
  assert.equal(state.countToday, 1);
  assert.equal(state.lastKindAt.absence, T0);
  assert.equal(state.armed, false);
});

test('日界按本机时区算，不按 UTC', () => {
  const local = new Date(2026, 10, 5, 23, 30).getTime();
  assert.equal(dayKeyOf(local), '2026-11-05', '晚上 11 点半还是 5 号');
});
