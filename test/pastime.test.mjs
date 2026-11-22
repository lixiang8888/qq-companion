// 她的空闲时间怎么选：看书 vs 打僵尸。只用真事算，不掷骰子。
import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePastime } from '../src/pastime.js';

const H = 3600e3;
const NOW = new Date(2026, 10, 22, 20, 0, 0).getTime();

test('只有一样能做就做那一样；都不能做就什么都不做', () => {
  assert.equal(choosePastime({}), 'none');
  assert.equal(choosePastime({ canRead: true }), 'read');
  assert.equal(choosePastime({ canPlay: true }), 'game');
});

test('两边都能做：刚打过游戏就去看书，刚看完书就去打游戏', () => {
  assert.equal(choosePastime({ canRead: true, canPlay: true, lastGameAt: NOW - H, lastReadAt: NOW - 2 * H }), 'read');
  assert.equal(choosePastime({ canRead: true, canPlay: true, lastReadAt: NOW - H, lastGameAt: NOW - 2 * H }), 'game');
});

test('小说读到腻了：换个花样，去打游戏', () => {
  assert.equal(choosePastime({ canRead: true, canPlay: true, bookAttitude: -0.4, lastReadAt: NOW - H, lastGameAt: NOW - 3 * H }), 'game');
});

test('这本她很喜欢，就接着看——哪怕刚看完一章', () => {
  // lastReadAt 更新 → 本来想让她换游戏（+1），但喜欢这本 +1，平手选看书（她原来的习惯）
  assert.equal(choosePastime({ canRead: true, canPlay: true, bookAttitude: 0.6, lastReadAt: NOW - H, lastGameAt: NOW - 3 * H }), 'read');
});

test('上一局刚通关：换换口味去看书', () => {
  assert.equal(choosePastime({
    canRead: true, canPlay: true, now: NOW,
    lastGameAt: NOW - H, lastReadAt: NOW - 3 * H,
    lastGame: { at: NOW - H, victory: true },
  }), 'read');
});

test('上一局输了（24 小时内）：不服气，还想再来一局', () => {
  assert.equal(choosePastime({
    canRead: true, canPlay: true, now: NOW,
    lastReadAt: NOW - 2 * H, lastGameAt: NOW - H,
    lastGame: { at: NOW - H, victory: false },
  }), 'game');
});

test('输的那局已经过了一天多：这股劲过去了', () => {
  assert.equal(choosePastime({
    canRead: true, canPlay: true, now: NOW,
    lastReadAt: NOW - 30 * H, lastGameAt: NOW - 26 * H,
    lastGame: { at: NOW - 26 * H, victory: false },
  }), 'read', '一天多以前的败局不该还拽着她');
});
