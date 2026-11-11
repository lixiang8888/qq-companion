// 上下文块：每一块都要说自己生于何时、能活多久。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR, assemble, blk } from '../src/fresh.js';

const T = Date.UTC(2026, 0, 1, 12);

test('本轮现算的块：不需要 ttl', () => {
  const out = assemble([blk('clock', '此时 12:00', T), blk('situation', '他要一段长的', T)], { now: T });
  assert.equal(out, '此时 12:00\n他要一段长的');
});

test('以前的生成的东西：没写 ttl 就抛，不是警告', () => {
  assert.throws(
    () => assemble([blk('insights', '我最近挺好的', T - HOUR)], { now: T }),
    /没说能活多久/,
    '正是这一类错误：一句话生成一次，之后每轮重放',
  );
});

test('写了 ttl：过期就丢掉，没过期就留着', () => {
  const old = blk('insights', '我最近挺好的', T - 3 * DAY, 2 * DAY);
  const fresh = blk('insights', '我最近挺好的', T - DAY, 2 * DAY);
  assert.equal(assemble([old], { now: T }), '');
  assert.equal(assemble([fresh], { now: T }), '我最近挺好的');
});

test('空块直接跳过，不必写 at（"这一轮没有这块"是合法的）', () => {
  assert.equal(assemble([blk('weather', '', 0), blk('money', '余额 3 元', T)], { now: T }), '余额 3 元');
});

test('忘了传 at 也要抛：这是"我没想到它有多旧"的入口', () => {
  assert.throws(() => assemble([{ key: 'x', text: 'hi', at: undefined, ttl: 0 }], { now: T }), /生于何时/);
});
