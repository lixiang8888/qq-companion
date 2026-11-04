// 主动搭话的闸门：默认关闭，过不了就不发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, isSilent, notePoke, pokeDecision, pokePrompt } from '../src/proactive.js';
import { dayKeyOf } from '../src/affect/core.js';

const HOUR = 36e5;
// 2026-01-01 14:00 UTC（避开安静时段）
const NOW = Date.UTC(2026, 0, 1, 14, 0, 0);
const ON = { ...DEFAULTS, enabled: true };
const base = { now: NOW, cfg: ON, lastUserAt: NOW - 5 * HOUR, lastBotAt: NOW - 6 * HOUR, pokes: {}, mood: 0.6 };

test('默认关闭：不开关就不会主动发', () => {
  assert.equal(pokeDecision({ ...base, cfg: DEFAULTS }).ok, false);
});

test('条件都满足才同意，并算出隔了几小时', () => {
  const r = pokeDecision(base);
  assert.equal(r.ok, true);
  assert.equal(r.idleHours, 5);
});

test('安静时段：不打扰', () => {
  const night = Date.UTC(2026, 0, 1, 2, 0, 0);
  assert.equal(pokeDecision({ ...base, now: night, lastUserAt: night - 5 * HOUR }).ok, false);
});

test('每日上限与冷却', () => {
  const day = dayKeyOf(NOW); // 本地日，不是 UTC 日
  assert.equal(pokeDecision({ ...base, pokes: { day, count: 3 } }).ok, false);
  assert.equal(pokeDecision({ ...base, pokes: { lastPokeAt: NOW - 10 * 60e3 } }).ok, false);
  assert.equal(pokeDecision({ ...base, pokes: { lastPokeAt: NOW - 3 * HOUR } }).ok, true);
});

test('我上一条还没被回：不追', () => {
  assert.equal(pokeDecision({ ...base, lastBotAt: NOW - HOUR }).ok, false);
});

test('刚聊过：不打扰', () => {
  assert.equal(pokeDecision({ ...base, lastUserAt: NOW - 10 * 60e3 }).ok, false);
});

test('心情太低：不想理人', () => {
  assert.equal(pokeDecision({ ...base, mood: 0.1 }).ok, false);
});

test('提醒文本带小时数和由头，且脱敏', () => {
  const t = pokePrompt({ idleHours: 5, memory: '他喜欢猫，sk-abcdefgh123' });
  assert.match(t, /5 小时/);
  assert.match(t, /不是他说的/);
  assert.ok(!t.includes('sk-abcdefgh'));
  assert.equal(isSilent('[沉默]'), true);
  assert.equal(isSilent('  [沉默] '), true);
  assert.equal(isSilent('在吗'), false);
});

test('记账：同一天累加，换天清零', () => {
  const p1 = notePoke({ pokes: {}, now: NOW });
  assert.equal(p1.count, 1);
  const p2 = notePoke({ pokes: p1, now: NOW + HOUR });
  assert.equal(p2.count, 2);
  const p3 = notePoke({ pokes: p2, now: NOW + 24 * HOUR });
  assert.equal(p3.count, 1);
});
