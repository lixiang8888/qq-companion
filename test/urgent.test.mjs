// 她着急时叫你：私聊戳一戳（轻）→ 窗口抖动（重，一天一次）。
// QQ 没有机器人拨通话的能力，这两级就是能做到的最强提醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, noteNudge, shouldNudge } from '../src/urgent.js';
import { dayKeyOf } from '../src/affect/core.js';

const at = (h, m = 0, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();
const ON = { ...DEFAULTS, enabled: true };
// 他 9:00 说完，她 9:01 回了一句，然后他没声了。
const afterReply = (h = 9, m = 0) => [
  { role: 'user', text: '早', at: at(h, m) },
  { role: 'assistant', text: '醒啦', at: at(h, m + 1) },
];
const URGENT = { label: '低落', v: 0.25, intensity: 0.8 };
const CALM = { label: '被夸', v: 0.8, intensity: 0.4 };
const pokeState = (now, extra = {}) => ({
  nudge: { day: dayKeyOf(now), n: 1, lastAt: now, kind: 'poke', ...extra },
});

test('默认关闭：没有开关就一次都不叫', () => {
  assert.equal(shouldNudge({ now: at(9, 20), history: afterReply(), emotion: URGENT, cfg: DEFAULTS }).ok, false);
});

test('没有等她回话的话：不叫（最后一条是他说的 / 没聊过）', () => {
  const noReply = [{ role: 'user', text: '早', at: at(9) }];
  assert.equal(shouldNudge({ now: at(9, 20), history: noReply, emotion: URGENT, cfg: ON }).ok, false);
  assert.equal(shouldNudge({ now: at(9, 20), history: [], emotion: URGENT, cfg: ON }).ok, false);
});

test('刚说完：至少等 3 分钟，刚说完就戳是催命', () => {
  const r = shouldNudge({ now: at(9, 2), history: afterReply(), emotion: URGENT, cfg: ON });
  assert.equal(r.ok, false);
  assert.match(r.reason, /先等等/);
});

test('心里不急就不叫：强度不够、或者情绪是正向的', () => {
  assert.equal(shouldNudge({ now: at(9, 20), history: afterReply(), emotion: CALM, cfg: ON }).ok, false);
  assert.equal(
    shouldNudge({ now: at(9, 20), history: afterReply(), emotion: { v: 0.25, intensity: 0.4 }, cfg: ON }).ok,
    false,
  );
  // 心情好但很激动（v 高）也不算急——只是高兴而已。
  assert.equal(
    shouldNudge({ now: at(9, 20), history: afterReply(), emotion: { v: 0.8, intensity: 1.2 }, cfg: ON }).ok,
    false,
  );
});

test('真急了、他也确实没回：先戳一戳', () => {
  const r = shouldNudge({ now: at(9, 20), history: afterReply(), emotion: URGENT, cfg: ON });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'poke');
  assert.match(r.why, /急/);
  assert.match(r.why, /19 分钟没接/);
});

test('同一段没回：戳过先等，过了半小时才升级成窗口抖动', () => {
  const hist = afterReply();
  const now = at(9, 20);
  const poke = shouldNudge({ now, history: hist, emotion: URGENT, cfg: ON });
  const state = noteNudge({ state: {}, now, kind: poke.kind });
  // 15 分钟后：刚叫过，先缓缓
  assert.equal(shouldNudge({ now: now + 15 * 60e3, history: hist, state, cfg: ON }).ok, false);
  // 31 分钟后：还没回 → 抖窗口
  const shake = shouldNudge({ now: now + 31 * 60e3, history: hist, state, cfg: ON });
  assert.equal(shake.ok, true);
  assert.equal(shake.kind, 'shake');
  assert.match(shake.why, /急起来了/);
  // 抖过了：等他说，别再没完
  const shaken = noteNudge({ state, now: now + 31 * 60e3, kind: 'shake' });
  assert.equal(shouldNudge({ now: now + 90 * 60e3, history: hist, state: shaken, cfg: ON }).ok, false);
  assert.match(shouldNudge({ now: now + 90 * 60e3, history: hist, state: shaken, cfg: ON }).reason, /抖过/);
});

test('抖窗口一天最多一次：换了一段新的事也只戳不抖', () => {
  const day = dayKeyOf(at(9, 20));
  const state = { nudge: { day, n: 2, lastAt: at(9, 20), kind: 'shake', shakeDay: day, shakeN: 1 } };
  // 他回了、她又说了一句、又没回（新的一段）：距离上次超过 30 分钟，也够急
  const later = [
    { role: 'user', text: '在吗', at: at(11, 0) },
    { role: 'assistant', text: '嗯', at: at(11, 1) },
  ];
  const r = shouldNudge({ now: at(11, 40), history: later, emotion: URGENT, state, cfg: ON });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'poke', '抖窗口今天用完了，只能戳');
});

test('换了一段（他回过话、她又说了新的）：重新从戳开始', () => {
  const now = at(9, 20);
  const old = noteNudge({ state: {}, now: at(8, 0), kind: 'shake' });
  const r = shouldNudge({ now, history: afterReply(), emotion: URGENT, state: old, cfg: ON });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'poke');
});

test('一天次数用完：不叫了', () => {
  const now = at(9, 20);
  const state = pokeState(now, { n: 3, lastAt: now - 40 * 60e3 });
  assert.equal(shouldNudge({ now, history: afterReply(), emotion: URGENT, state, cfg: ON }).ok, false);
});

test('安静时段不叫：半夜抖窗口等于打电话吵醒人', () => {
  const hist = [
    { role: 'user', text: '晚安', at: at(22, 0) },
    { role: 'assistant', text: '晚安', at: at(22, 1) },
  ];
  const r = shouldNudge({ now: at(2, 0, 2), history: hist, emotion: URGENT, cfg: ON });
  assert.equal(r.ok, false);
  assert.match(r.reason, /安静时段/);
});

test('记账：叫了几次、什么方式，抖窗口的当日次数要留住', () => {
  const day = dayKeyOf(at(9, 20));
  const a = noteNudge({ state: {}, now: at(9, 20), kind: 'poke' });
  assert.equal(a.nudge.n, 1);
  assert.equal(a.nudge.kind, 'poke');
  assert.equal(a.nudge.day, day);
  const b = noteNudge({ state: a, now: at(9, 50), kind: 'shake' });
  assert.equal(b.nudge.n, 2);
  assert.equal(b.nudge.shakeN, 1);
  // 同一天晚些再戳一次：抖动计数不能被抹掉（否则一天能抖两次）
  const c = noteNudge({ state: b, now: at(11, 40), kind: 'poke' });
  assert.equal(c.nudge.kind, 'poke');
  assert.equal(c.nudge.shakeN, 1);
});
