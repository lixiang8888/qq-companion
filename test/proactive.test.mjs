// 主动搭话：不是到点就发，是「期待到了 + 护栏全过」才自己想一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, composePokePrompt, expectAt, inQuietHours, notePoked, noteSaidByUser, noteTurn, noteWait,
  parsePokeReply, pokeGate, typicalGap,
} from '../src/proactive.js';
import { dayKeyOf } from '../src/affect/core.js';

const HOUR = 36e5;
// 本地时间构造：安静时段、日期都按本地钟算，写 UTC 会在别的时区上翻车。
const at = (h, m = 0, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();
const ON = { ...DEFAULTS, enabled: true };
const HISTORY = [
  { role: 'user', text: '早', at: at(9) },
  { role: 'assistant', text: '早呀', at: at(9, 1) },
  { role: 'user', text: '今天开会', at: at(9, 30) },
  { role: 'assistant', text: '累不累', at: at(9, 31) },
];
const CHATTED = { now: at(9, 31), lastUserAt: at(9, 30), history: HISTORY };
const base = { cfg: ON, lastUserAt: at(9, 30), state: { expect: { at: at(12, 31) } }, mood: 0.6 };

test('默认关闭：不开关就不会主动发', () => {
  assert.equal(pokeGate({ ...base, now: at(15), cfg: DEFAULTS }).ok, false);
});

test('期待到了、护栏全过才同意', () => {
  assert.equal(pokeGate({ ...base, now: at(12, 30) }).ok, false); // 还差一分钟
  const r = pokeGate({ ...base, now: at(13) });
  assert.equal(r.ok, true);
  assert.equal(r.idleHours, 4);
});

test('安静时段：不打扰', () => {
  assert.equal(inQuietHours(23, ON), true);
  assert.equal(inQuietHours(7, ON), true);
  assert.equal(inQuietHours(8, ON), false);
  assert.equal(pokeGate({ ...base, now: at(2) }).ok, false);
});

test('每日上限、冷却、连发上限、想的上限', () => {
  const day = dayKeyOf(at(13));
  assert.equal(pokeGate({ ...base, now: at(13), state: { day, count: 3, expect: {} } }).ok, false);
  assert.equal(pokeGate({ ...base, now: at(13), state: { lastPokeAt: at(12, 45), expect: {} } }).ok, false);
  assert.equal(pokeGate({ ...base, now: at(13), state: { lastPokeAt: at(9), expect: {} } }).ok, true);
  assert.equal(pokeGate({ ...base, now: at(13), state: { consecutive: 2, expect: {} } }).ok, false);
  assert.equal(pokeGate({ ...base, now: at(13), state: { thinks: { day, n: 12 }, expect: {} } }).ok, false);
});

test('心情太低：不想理人', () => {
  assert.equal(pokeGate({ ...base, now: at(13), mood: 0.1 }).ok, false);
});

test('还没聊过：不主动找人', () => {
  assert.equal(pokeGate({ ...base, now: at(13), lastUserAt: 0 }).ok, false);
});

test('他先说的、她最后回的：过了期待点她仍然可以开口', () => {
  // 这是以前那个死锁的回归：只要「我上一条还在最后」就永远不许先说话，
  // 而每轮对话都以她说话结束——实战里等于永不开口。
  const state = noteTurn({ ...CHATTED, cfg: ON });
  assert.ok(state.expect.at > at(9, 31));
  assert.equal(pokeGate({ ...base, now: at(13), state }).ok, true);
});

test('他出声了：连发清零、期待点作废', () => {
  const state = noteSaidByUser({ consecutive: 2, expect: { at: at(20) }, count: 1 });
  assert.equal(state.consecutive, 0);
  assert.deepEqual(state.expect, {});
  assert.equal(pokeGate({ ...base, now: at(13), state }).ok, true);
});

test('期待点至少隔开 minIdle，连发一次翻一倍', () => {
  const e0 = expectAt({ now: at(10), lastBotAt: at(10), cfg: ON, consecutive: 0 });
  const e1 = expectAt({ now: at(10), lastBotAt: at(10), cfg: ON, consecutive: 1 });
  const e2 = expectAt({ now: at(10), lastBotAt: at(10), cfg: ON, consecutive: 2 });
  assert.equal((e0.at - at(10)) / HOUR, 3);
  assert.equal((e1.at - at(10)) / HOUR, 6);
  assert.equal((e2.at - at(10)) / HOUR, 12);
  assert.match(e1.why, /连发/);
});

test('期待点落在深夜：挪到早上八点', () => {
  const e = expectAt({ now: at(21), lastBotAt: at(21), cfg: ON });
  const d = new Date(e.at);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getDate(), 2);
  assert.match(e.why, /安静时段/);
});

test('他回得慢，期待点跟着晚（中位数）', () => {
  const slow = [
    { role: 'user', text: 'a', at: at(8) },
    { role: 'user', text: 'b', at: at(12) },
    { role: 'user', text: 'c', at: at(16) },
  ];
  assert.equal(typicalGap(slow), 4 * HOUR);
  const e = expectAt({ now: at(16), lastBotAt: at(16), history: slow, cfg: ON, consecutive: 0 });
  assert.equal((e.at - at(16)) / HOUR, 4);
  assert.equal(typicalGap([]), 0);
});

test('想过了但不说：期待点往后推，算一次「想」，不算连发', () => {
  const s = noteWait({ state: { consecutive: 1 }, now: at(13), minutes: 45 });
  assert.equal(s.expect.at, at(13, 45));
  assert.equal(s.consecutive, 1);
  assert.equal(s.thinks.n, 1);
  assert.equal(noteWait({ state: s, now: at(14) }).thinks.n, 2);
});

test('真发出去了：记一条、连发 +1、换天清零', () => {
  const p1 = notePoked({ state: {}, now: at(13) });
  assert.equal(p1.count, 1);
  assert.equal(p1.consecutive, 1);
  const p2 = notePoked({ state: p1, now: at(15) });
  assert.equal(p2.count, 2);
  assert.equal(p2.consecutive, 2);
  const p3 = notePoked({ state: p2, now: at(13, 0, 2) });
  assert.equal(p3.count, 1);
  assert.equal(p3.consecutive, 3);
});

test('提示文本：说清是他没说话、带由头、脱敏、不许复述', () => {
  const t = composePokePrompt({ clock: '1月1日 周四 13:00', idle: '他已经 4 小时没跟你说话了', lastLine: '今天开会', hint: '他喜欢猫，sk-abcdefgh123', inner: '想问他要不要吃饭', doing: '在翻聊天记录' });
  assert.match(t, /4 小时/);
  assert.match(t, /不是他说的/);
  assert.match(t, /今天开会/);
  assert.ok(!t.includes('sk-abcdefgh'));
  assert.match(t, /"send":false/);
});

test('读懂她的决定：JSON、裹在代码块里的 JSON、坏格式兜底', () => {
  assert.deepEqual(parsePokeReply('{"send":true,"message":"在干嘛"}'), { send: true, message: '在干嘛', search: '' });
  const no = parsePokeReply('```json\n{"send":false,"waitMinutes":30,"reason":"睡了"}\n```');
  assert.equal(no.send, false);
  assert.equal(no.waitMinutes, 30);
  assert.equal(no.reason, '睡了');
  // 只说想查、不说要发：可以
  assert.equal(parsePokeReply('{"send":false,"search":"湖州明天会下雨吗"}').search, '湖州明天会下雨吗');
  // 想说但没话 = 不发
  assert.equal(parsePokeReply('{"send":true,"message":"  "}').send, false);
  assert.equal(parsePokeReply('[沉默]').send, false);
  assert.equal(parsePokeReply('').send, false);
  // 格式坏了：整段当一句话，别因为少个括号整晚不说话
  assert.deepEqual(parsePokeReply('在干嘛呢'), { send: true, message: '在干嘛呢', search: '' });
});
