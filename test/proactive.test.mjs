// 主动搭话：不是到点就发，是「期待到了 + 护栏全过」才自己想一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, composePokePrompt, expectAt, inQuietHours, isPresent, notePoked, noteSaidByUser, noteTick, noteTurn, noteWait,
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
  assert.deepEqual(parsePokeReply('{"send":true,"message":"在干嘛"}'), { send: true, message: '在干嘛', search: '', doing: '', think: '' });
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
  assert.deepEqual(parsePokeReply('在干嘛呢'), { send: true, message: '在干嘛呢', search: '', doing: '', think: '' });
});

test('她想的那句话和接下来要干什么：解析出来、长度封死', () => {
  const r = parsePokeReply('{"send":false,"doing":"在收拾桌上的东西","think":"想问他要不要吃饭"}');
  assert.equal(r.doing, '在收拾桌上的东西');
  assert.equal(r.think, '想问他要不要吃饭');
  // 这两个字段会直接进下一次的系统提示，长度必须封死（信任边界）。
  const long = parsePokeReply(`{"send":false,"doing":"${'长'.repeat(80)}","think":"${'想'.repeat(200)}"}`);
  assert.equal(long.doing.length, 30);
  assert.equal(long.think.length, 60);
  // 发出去的那条也带着这两个键：一次调用既决定说话，也决定她待会儿干什么。
  const sent = parsePokeReply('{"send":true,"message":"在干嘛","doing":"在等热水","think":"他还没回"}');
  assert.equal(sent.send, true);
  assert.equal(sent.doing, '在等热水');
  assert.equal(sent.think, '他还没回');
});

test('提示文本：外面真发生了什么，写在明处，且脱敏', () => {
  const t = composePokePrompt({
    clock: '1月1日 周四 13:00',
    idle: '他已经 4 小时没跟你说话了',
    events: [{ kind: 'screen', text: '他那边屏幕上现在是「报错信息」' }, { kind: 'silence', text: '他已经 6 小时没跟你说话了' }],
  });
  assert.match(t, /外面真的发生了什么/);
  assert.match(t, /报错信息/);
  assert.match(t, /"doing"/);
  assert.match(t, /"think"/);
  // 没有事件就不该出现那一节：空标题比空内容更让人乱编。
  assert.ok(!composePokePrompt({ clock: '13:00' }).includes('外面真的发生了什么'));
});

test('记账：真的调了模型才算「想过」，跨日归零', () => {
  const day = new Date(2026, 0, 1, 13, 0, 0).getTime();
  const a = noteTick({}, { now: day, events: 2 });
  assert.equal(a.ticks.n, 1);
  assert.equal(a.lastEvents, 2);
  const b = noteTick(a, { now: day + 60e3, events: 0 });
  assert.equal(b.ticks.n, 2);
  assert.equal(b.lastEvents, 0);
  // 第二天从 1 重新数
  assert.equal(noteTick(b, { now: day + 86400e3, events: 0 }).ticks.n, 1);
  // 别的状态不能被她顺手吃掉
  assert.equal(noteTick({ count: 2, consecutive: 1 }, { now: day }).count, 2);
});

test('等待时间按配置的安静时段算，不用默认那份', () => {
  // 他把安静时段设成 1 点到 9 点。07:50 说「晚点再说 45 分钟」= 08:35，那还在睡。
  const cfg = { quietFrom: 1, quietTo: 9 };
  const day = new Date(2026, 0, 1, 7, 50, 0).getTime();
  const s = noteWait({ state: {}, now: day, minutes: 45, cfg });
  const hour = new Date(s.expect.at).getHours();
  assert.equal(hour, 9, '该挪到 9 点起床，而不是默认的 8 点');
});
// ---- 2026-11-22：在场状态（聊天中途消失）与深夜例外 ----

test('在场：他刚说过话、最后一条是她回的 = 还在聊；超时或最后一条是他的 = 不在场', () => {
  const hist = [
    { role: 'user', text: '洗完是不', at: at(9, 30) },
    { role: 'assistant', text: '你倒是说完啊', at: at(9, 31) },
  ];
  assert.equal(isPresent({ now: at(9, 40), lastUserAt: at(9, 30), history: hist, cfg: ON }), true, '五分钟前还在聊');
  assert.equal(isPresent({ now: at(10, 20), lastUserAt: at(9, 30), history: hist, cfg: ON }), false, '五十分钟前：不在场了');
  assert.equal(isPresent({ now: at(9, 40), lastUserAt: 0, history: hist, cfg: ON }), false, '没聊过');
  assert.equal(isPresent({ now: at(9, 40), lastUserAt: at(9, 30), history: [{ role: 'user', at: at(9, 30) }], cfg: ON }), false, '最后一条是他说的：还没轮到她等');
});

test('期待点：在场按分钟（5~20），不在场才按小时', () => {
  const hist = [{ role: 'user', text: '在吗', at: at(9) }, { role: 'assistant', text: '在', at: at(9, 1) }];
  const here = expectAt({ now: at(9, 2), lastUserAt: at(9), lastBotAt: at(9, 1), history: hist, cfg: ON, present: true });
  assert.ok(here.at - at(9, 1) <= 20 * 60e3, '在场最多 20 分钟');
  assert.ok(here.at - at(9, 1) >= 5 * 60e3, '在场至少 5 分钟');
  assert.match(here.why, /还在等你|刚刚的节奏/);
  const gone = expectAt({ now: at(9, 2), lastUserAt: at(9), lastBotAt: at(9, 1), history: hist, cfg: ON, present: false });
  assert.ok(gone.at - at(9, 1) >= 180 * 60e3, '不在场回到至少 3 小时');
});

test('在场追问：豁免 minGap，一段对话最多插一句，每天两次', () => {
  const now = at(9, 30);
  const base = { now, cfg: ON, lastUserAt: at(9, 29), mood: 0.6, present: true, state: { expect: { at: at(9, 28) } } };
  const ok = pokeGate(base);
  assert.equal(ok.ok, true, '刚说过话 + 在场：minGap 不能挡');
  assert.equal(ok.active, true);
  // 已经插过一句：不再插，等他接
  assert.equal(pokeGate({ ...base, state: { ...base.state, consecutive: 1 } }).ok, false);
  assert.match(pokeGate({ ...base, state: { ...base.state, consecutive: 1 } }).reason, /等他接/);
  // 一天两次用完就没了
  const used = { expect: { at: at(9, 28) }, active: { day: dayKeyOf(now), n: 2, lastAt: at(8) } };
  assert.equal(pokeGate({ ...base, state: used }).ok, false);
  assert.match(pokeGate({ ...base, state: used }).reason, /插过话/);
  // 每小时一次：刚插过就等一小时
  const justNow = { expect: { at: at(9, 28) }, active: { day: dayKeyOf(now), n: 1, lastAt: now - 5 * 60e3 } };
  assert.match(pokeGate({ ...base, state: justNow }).reason, /刚才已经问过/);
});

test('深夜不是铁律：情绪重或者他还没睡，一夜给一次', () => {
  const night = at(2, 0);
  const base = { now: night, cfg: ON, lastUserAt: at(1, 40), mood: 0.6, state: { expect: { at: at(1, 30) } } };
  // 他还没睡（30 分钟前说过话）：可以搭一句，标成深夜例外
  const awake = pokeGate(base);
  assert.equal(awake.ok, true);
  assert.equal(awake.night, true);
  // 他睡了、她情绪也平：安静
  const calm = pokeGate({ ...base, lastUserAt: at(23, 30) });
  assert.equal(calm.ok, false);
  assert.match(calm.reason, /安静时段/);
  // 情绪重：占主导，给一次
  const moved = pokeGate({ ...base, lastUserAt: at(23, 30), emotion: { label: '触动', intensity: 0.8 } });
  assert.equal(moved.ok, true);
  // 这一夜已经用过一次：不再吵
  const used = { ...base, state: { expect: { at: at(1, 30) }, night: { day: dayKeyOf(night), n: 1 } } };
  assert.match(pokeGate(used).reason, /安静时段/);
});

test('在场时「晚点再想」也只在几分钟量级', () => {
  const st = noteWait({ state: {}, now: at(9, 30), minutes: 45, cfg: ON, present: true });
  assert.ok(st.expect.at - at(9, 30) <= 20 * 60e3, '不能按 45 分钟把对话放下');
  const gone = noteWait({ state: {}, now: at(9, 30), minutes: 45, cfg: ON, present: false });
  assert.equal(gone.expect.at - at(9, 30), 45 * 60e3);
});
