// 感知记忆的检索：什么时候去召回、召回门槛、复核结论怎么读、限流、注入行。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECHECK_MAX_PER_HOUR, canRecheck, candidates, noteRecheck, parsePick, perceptionLine, shouldRecall,
} from '../src/perception/recall.js';

const HOUR = 3600e3;
const r = (over) => ({ id: 'p', title: 't', desc: 'd', slots: {}, at: 0, lastSeenAt: 0, hits: 0, ...over });

test('只有出现指代词才去召回', () => {
  assert.equal(shouldRecall('你看那张图'), true);
  assert.equal(shouldRecall('上次发的那个'), true);
  assert.equal(shouldRecall('今天吃了面条'), false);
});

test('召回：找得到那条相关的', () => {
  const records = [
    r({ id: 'p_food', title: '一碗面条', desc: '热气腾腾的面' }),
    r({ id: 'p_girl', title: '粉发女孩', desc: '粉色头发的女孩举着牌子', slots: { look: ['粉发'] } }),
  ];
  const got = candidates(records, '粉头发的那个图', { now: 0 });
  assert.equal(got[0].id, 'p_girl');
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
