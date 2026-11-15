// 感知记忆的检索：什么时候去召回、召回门槛、复核结论怎么读、限流、注入行。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECHECK_MAX_PER_HOUR, canRecheck, candidates, noteRecheck, parsePick, perceptionLine, recentLine, recentShots,
} from '../src/perception/recall.js';

const HOUR = 3600e3;
const r = (over) => ({ id: 'p', title: 't', desc: 'd', slots: {}, at: 0, lastSeenAt: 0, hits: 0, ...over });

test('召回：找得到那条相关的', () => {
  const records = [
    r({ id: 'p_food', title: '一碗面条', desc: '热气腾腾的面' }),
    r({ id: 'p_girl', title: '粉发女孩', desc: '粉色头发的女孩举着牌子', slots: { look: ['粉发'] } }),
  ];
  const got = candidates(records, '粉头发的那个图', { now: 0 });
  assert.equal(got[0].rec.id, 'p_girl');
});

test('门槛：完全不相关就返回空，不硬凑', () => {
  const records = [r({ id: 'p_food', title: '一碗面条', desc: '热气腾腾的面' })];
  assert.deepEqual(candidates(records, '量子力学图灵机', { now: 0 }), []);
});

test('parsing 复核结果：数字、JSON、都不是', () => {
  assert.equal(parsePick('2', 3), 2);
  assert.equal(parsePick('{"pick":3}', 3), 3);
  assert.equal(parsePick('都不是', 3), 0);
  assert.equal(parsePick('{"pick":9}', 3), 0, '越界当没选中');
  assert.equal(parsePick('', 3), 0);
});

test('限流：一小时最多 5 次', () => {
  let state = {};
  for (let i = 0; i < RECHECK_MAX_PER_HOUR; i++) {
    assert.equal(canRecheck(state, i), true);
    state = noteRecheck(state, i);
  }
  assert.equal(canRecheck(state, 100), false);
  assert.equal(canRecheck(state, HOUR + 1), true, '一小时后就放过');
});

test('注入行：带时间、来源、标题', () => {
  const line = perceptionLine(r({ title: '粉发女孩' }), new Date(2026, 10, 14, 21, 3).getTime());
  assert.match(line, /11-14 21:03/);
  assert.match(line, /他发的/);
  assert.match(line, /粉发女孩/);
});

test('老记录缺字段（迁移来的、没有 title/slots）也不炸', () => {
  const legacy = [{ id: 'p_old', desc: '一张很老的图', at: 0 }];
  assert.doesNotThrow(() => candidates(legacy, '那张老图', { now: 0 }));
  assert.match(perceptionLine({ id: 'p_old', at: 0 }, 0), /一张没起名的图|他发的/);
});

// ---- 第二轮：近窗口 / 每轮都搜 / 重看原图 ----

const recentRec = (over = {}) => ({ id: 'p_r', title: '截图', desc: '一张截图，上面是报错信息', slots: {}, at: 0, hits: 0, file: 'f.jpg', thumb: 'f.thumb.jpg', ...over });

test('近窗口：24 小时内的都算，25 小时前的只在新近轮次里才留', () => {
  const now = 10 * 24 * 3600e3;
  const shots = [
    recentRec({ id: 'p_new', at: now - 23 * 3600e3 }),
    recentRec({ id: 'p_old', at: now - 25 * 3600e3 }),
  ];
  assert.deepEqual(recentShots(shots, { now }).map((r) => r.id), ['p_new']);
  // 最近 30 轮里出现过它 → 即使超过 24 小时也留下（那轮对话的起点比图更早）
  const history = [{ role: 'user', text: '看这个', at: now - 26 * 3600e3 }];
  assert.deepEqual(recentShots(shots, { now, history }).map((r) => r.id), ['p_new', 'p_old']);
});

test('近窗口：最多 3 条，近的在前', () => {
  const now = 10 * 24 * 3600e3;
  const shots = [1, 2, 3, 4].map((i) => recentRec({ id: `p_${i}`, at: now - i * 60e3 }));
  const got = recentShots(shots, { now });
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((r) => r.id), ['p_1', 'p_2', 'p_3']);
});

test('近窗口的行用完整描述，不是标题', () => {
  const now = 10 * 24 * 3600e3;
  const line = recentLine(recentRec({ at: now - 60e3 }), now);
  assert.match(line, /报错信息/);
  assert.doesNotMatch(line, /^\- .*截图$/);
});
