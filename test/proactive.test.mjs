// 主动搭话：不是到点就发，是「期待到了 + 护栏全过」才自己想一次。
//
// 2026-11-23 改：她「等没等回、几句没回、从什么时候开始等」全从历史现算（openThread /
// waitingState），不再存 consecutive / expect / leftOnRead 那套影子状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, composePokePrompt, expectAt, inQuietHours, isPresent, notePoked, noteSaidByUser, noteTick, noteWait,
  openThread, parsePokeReply, pokeGate, typicalGap, waitingState,
} from '../src/proactive.js';
import { dayKeyOf } from '../src/affect/core.js';

const HOUR = 36e5;
const DAY = 24 * HOUR;
// 本地时间构造：安静时段、日期都按本地钟算，写 UTC 会在别的时区上翻车。
const at = (h, m = 0, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();
const ON = { ...DEFAULTS, enabled: true };
// 他 9:30 说完，她 9:31 回了一句，然后他没声了——期待点 = 9:31 + 3 小时。
const CHAT = [
  { role: 'user', text: '今天开会', at: at(9, 30) },
  { role: 'assistant', text: '累不累', at: at(9, 31) },
];
const base = { cfg: ON, history: CHAT, mood: 0.6 };
const asst = (h, m = 0) => ({ role: 'assistant', text: '喂', at: at(h, m) });

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
  assert.equal(pokeGate({ ...base, now: at(13), state: { day, count: 3 } }).ok, false);
  assert.equal(pokeGate({ ...base, now: at(13), state: { lastPokeAt: at(12, 45) } }).ok, false);
  // 她上一次追问是 11:00，一次没回就翻倍：期待点挪到 17:00。
  const one = [...CHAT, asst(11, 0)];
  assert.equal(pokeGate({ ...base, now: at(13), history: one, state: { lastPokeAt: at(11) } }).ok, false);
  assert.equal(pokeGate({ ...base, now: at(18), history: one, state: { lastPokeAt: at(11) } }).ok, true);
  // 连发两条都没回：先等他说
  const two = [...CHAT, asst(11, 0), asst(15, 0)];
  assert.equal(pokeGate({ ...base, now: at(18), history: two, state: { lastPokeAt: at(15) } }).ok, false);
  assert.match(pokeGate({ ...base, now: at(18), history: two, state: { lastPokeAt: at(15) } }).reason, /连发 2 条/);
  assert.equal(pokeGate({ ...base, now: at(13), state: { thinks: { day, n: 12 } } }).ok, false);
});

test('心情太低：不想理人', () => {
  assert.equal(pokeGate({ ...base, now: at(13), mood: 0.1 }).ok, false);
});

test('还没聊过：不主动找人', () => {
  assert.equal(pokeGate({ ...base, now: at(13), history: [], lastUserAt: 0 }).ok, false);
});

test('期待点是现算的：他先说的、她最后回的，过了期待点她仍然可以开口', () => {
  // 这是以前那个死锁的回归：只要「我上一条还在最后」就永远不许先说话，
  // 而每轮对话都以她说话结束——实战里等于永不开口。
  const r = pokeGate({ ...base, now: at(13) });
  assert.equal(r.ok, true);
  assert.ok(r.expectAt <= at(13), '期待点 12:31 已经过去（过点后按当下算）');
});

test('他出声了：「晚点再想」作废', () => {
  const state = noteSaidByUser({ waitUntil: at(20), waitWhy: '等', count: 1 });
  assert.equal(state.waitUntil, 0);
  assert.equal(state.count, 1);
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

test('想过了但不说：她亲口说「晚点再想」，到点前不再重问，算一次「想」', () => {
  const s = noteWait({ state: {}, now: at(13), minutes: 45 });
  assert.equal(s.waitUntil, at(13, 45));
  assert.equal(s.thinks.n, 1);
  assert.equal(noteWait({ state: s, now: at(14) }).thinks.n, 2);
  // 期待点已经过了（12:31），但她说 45 分钟后再想：13:30 还在等，13:46 才准想。
  assert.equal(pokeGate({ ...base, now: at(13, 30), state: s }).ok, false);
  assert.match(pokeGate({ ...base, now: at(13, 30), state: s }).reason, /期待的时间/);
  assert.equal(pokeGate({ ...base, now: at(13, 46), state: s }).ok, true);
});

test('等待时间按配置的安静时段算，不用默认那份', () => {
  // 他把安静时段设成 1 点到 9 点。07:50 说「晚点再说 45 分钟」= 08:35，那还在睡。
  const cfg = { quietFrom: 1, quietTo: 9 };
  const day = new Date(2026, 0, 1, 7, 50, 0).getTime();
  const s = noteWait({ state: {}, now: day, minutes: 45, cfg });
  const hour = new Date(s.waitUntil).getHours();
  assert.equal(hour, 9, '该挪到 9 点起床，而不是默认的 8 点');
});

test('在场时「晚点再想」也只在几分钟量级', () => {
  const st = noteWait({ state: {}, now: at(9, 30), minutes: 45, cfg: ON, present: true });
  assert.ok(st.waitUntil - at(9, 30) <= 20 * 60e3, '不能按 45 分钟把对话放下');
  const gone = noteWait({ state: {}, now: at(9, 30), minutes: 45, cfg: ON, present: false });
  assert.equal(gone.waitUntil - at(9, 30), 45 * 60e3);
});

test('真发出去了：记一条、换天清零、破例单独记', () => {
  const p1 = notePoked({ state: {}, now: at(13) });
  assert.equal(p1.count, 1);
  assert.equal(p1.waitUntil, 0);
  const p2 = notePoked({ state: p1, now: at(15) });
  assert.equal(p2.count, 2);
  const p3 = notePoked({ state: p2, now: at(13, 0, 2) });
  assert.equal(p3.count, 1);
  const broke = notePoked({ state: {}, now: at(13), breaking: true });
  assert.equal(broke.breakAt, at(13));
});

// ---- 2026-11-23：她说了话没人接，是历史里的事实，不是计数器 ----

test('openThread：尾巴上最后一条 user 之后，她说了几句就是从几句现算', () => {
  assert.deepEqual(openThread([]), { unanswered: 0, lastAt: 0, lastText: '' });
  assert.deepEqual(openThread([{ role: 'user', at: at(9), text: 'a' }]), { unanswered: 0, lastAt: 0, lastText: '' });
  const one = openThread(CHAT);
  assert.equal(one.unanswered, 1);
  assert.equal(one.lastAt, at(9, 31));
  assert.equal(one.lastText, '累不累');
  const three = openThread([...CHAT, asst(11, 0), asst(12, 0)]);
  assert.equal(three.unanswered, 3);
  assert.equal(three.lastAt, at(12));
  // 他后来回了一句：这次等待结束，重新算。
  const answered = openThread([...CHAT, asst(11, 0), { role: 'user', text: '在', at: at(12, 5) }]);
  assert.equal(answered.unanswered, 0);
});

test('waitingState：正常等 → 被晾 → 她自己收掉（12 小时）', () => {
  assert.equal(waitingState({ now: at(9, 40), history: CHAT, cfg: ON }).stage, 'waiting');
  const ignored = waitingState({ now: at(10, 0), history: CHAT, cfg: ON });
  assert.equal(ignored.stage, 'ignored');
  assert.equal(ignored.waitedMs, 29 * 60e3);
  assert.equal(waitingState({ now: at(9, 31) + 12 * HOUR, history: CHAT, cfg: ON }).stage, 'ignored', '正好 12 小时还算在等');
  assert.equal(waitingState({ now: at(9, 31) + 12 * HOUR + 60e3, history: CHAT, cfg: ON }).stage, 'dropped');
  assert.equal(waitingState({ now: at(10), history: [], cfg: ON }).stage, 'none');
});

test('连发到上限之后，他几天不理她：允许破例问一句，但三天只给一次', () => {
  const two = [...CHAT, asst(11, 0), asst(15, 0)];
  const last = at(15);
  const state = { lastPokeAt: last };
  // 才过两天：还是等他说
  const soon = pokeGate({ ...base, now: last + 2 * DAY, history: two, state });
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /连发 2 条/);
  // 过了三天：破例问一句，而且标明这是破例
  const broke = pokeGate({ ...base, now: last + 3 * DAY, history: two, state });
  assert.equal(broke.ok, true);
  assert.equal(broke.break, true);
  assert.match(broke.why, /再问一句/);
  // 破例过之后三天内不再破例
  const again = pokeGate({ ...base, now: last + 4 * DAY, history: two, state: { ...state, breakAt: last + 3 * DAY } });
  assert.equal(again.ok, false);
});

// ---- 提示文本 ----

test('提示文本：说清是他没说话、带由头、脱敏、不许复述', () => {
  const t = composePokePrompt({ clock: '1月1日 周四 13:00', idle: '他已经 4 小时没跟你说话了', lastLine: '今天开会', hint: '他喜欢猫，sk-abcdefgh123', inner: '想问他要不要吃饭', doing: '在翻聊天记录' });
  assert.match(t, /4 小时/);
  assert.match(t, /不是他说的/);
  assert.match(t, /今天开会/);
  assert.ok(!t.includes('sk-abcdefgh'));
  assert.match(t, /"send":false/);
});

test('提示文本：她上一句还没人接，写给她看（免得又从头问一遍）', () => {
  const t = composePokePrompt({ clock: '13:00', idle: '他已经 4 小时没跟你说话了', waiting: '在干嘛' });
  assert.match(t, /「在干嘛」他还没回/);
  assert.ok(!composePokePrompt({ clock: '13:00' }).includes('他还没回'));
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
  assert.equal(noteTick({ count: 2, lastPokeAt: 1 }, { now: day }).count, 2);
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
  const now = at(9, 50);
  const hist = [
    { role: 'user', text: '洗完是不', at: at(9, 29) },
    { role: 'assistant', text: '人呢', at: at(9, 29, 0) },
  ];
  // 她 9:29 回的，期待点 9:49；9:50 他还没接，可以插一句。
  const base = { now, cfg: ON, history: hist, mood: 0.6 };
  const ok = pokeGate(base);
  assert.equal(ok.ok, true, '刚说过话 + 在场：minGap 不能挡');
  assert.equal(ok.active, true);
  // 已经插过一句：不再插，等他接（尾巴上多出来的那句 assistant 就是插的话）
  const inserted = [...hist, asst(9, 45)];
  assert.equal(pokeGate({ ...base, history: inserted }).ok, false);
  assert.match(pokeGate({ ...base, history: inserted }).reason, /等他接/);
  // 一天两次用完就没了
  const day = dayKeyOf(now);
  const used = { active: { day, n: 2, lastAt: at(8) } };
  assert.equal(pokeGate({ ...base, state: used }).ok, false);
  assert.match(pokeGate({ ...base, state: used }).reason, /插过话/);
  // 每小时一次：刚插过就等一小时
  const justNow = { active: { day, n: 1, lastAt: now - 5 * 60e3 } };
  assert.match(pokeGate({ ...base, state: justNow }).reason, /刚才已经问过/);
});

test('深夜不是铁律：情绪重或者他还没睡，一夜给一次', () => {
  const night = at(2, 0);
  // 她 23:00 说完那句，期待点正好是 02:00——深夜例外只跟情绪/他还没睡有关，不再被期待点挡。
  const hist = [
    { role: 'user', text: '还不睡', at: at(22, 50, 1) },
    { role: 'assistant', text: '你先睡', at: at(23, 0, 1) },
  ];
  const base = { now: night, cfg: ON, history: hist, mood: 0.6 };
  // 他睡了、她情绪也平：安静
  const calm = pokeGate(base);
  assert.equal(calm.ok, false);
  assert.match(calm.reason, /安静时段/);
  // 情绪重：占主导，给一次
  const moved = pokeGate({ ...base, emotion: { label: '触动', intensity: 0.8 } });
  assert.equal(moved.ok, true);
  assert.equal(moved.night, true);
  // 这一夜已经用过一次：不再吵
  const used = { night: { day: dayKeyOf(night), n: 1 } };
  assert.match(pokeGate({ ...base, state: used, emotion: { label: '触动', intensity: 0.8 } }).reason, /安静时段/);
  // 他还没睡（半小时内说过话）：可以搭一句，标成深夜例外
  const awakeHist = [
    { role: 'user', text: '还不睡', at: at(1, 40) },
    { role: 'assistant', text: '你先睡', at: at(1, 40) },
  ];
  const awake = pokeGate({ now: at(2, 5), cfg: ON, history: awakeHist, mood: 0.6 });
  assert.equal(awake.ok, true);
  assert.equal(awake.night, true);
});
