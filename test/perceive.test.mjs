// 她的世界有没有变：只报真事，报过的不再报，全都正常就一条都没有。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVENTS, PICTURE_MS, SILENCE_MS, WEATHER_STALE_MS, gapWords, perceive, startOfDay } from '../src/perceive.js';

const HOUR = 36e5;
// 本地时间构造：事件里「早上 6-10 点」是按本地钟算的，写 UTC 会在别的时区上翻车。
const at = (h, m = 0, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();
const NOON = at(12);
const kinds = (r) => r.events.map((e) => e.kind);

test('什么都没发生的时候，一条事件都没有', () => {
  const r = perceive({
    now: NOON,
    screenOn: false,
    weatherOn: false,
    lastUserAt: NOON - 10 * 60e3, // 十分钟前刚聊过
    pending: [],
    memory: { records: [] },
    balance: null,
    doing: '',
    life: { doing: '', until: 0 },
    lastPictureAt: 0,
  });
  assert.deepEqual(r.events, []);
  // seen 也不该凭空长出东西：它只记「报过什么」。
  assert.deepEqual(r.seen, {});
});

test('屏幕：标题变了才报，同一块屏幕不重复报', () => {
  const base = { now: NOON, screenOn: true, screen: { at: NOON, title: 'h-D-ACE 记忆人格模块修改' } };
  const first = perceive(base);
  assert.deepEqual(kinds(first), ['screen']);
  assert.match(first.events[0].text, /记忆人格模块修改/);
  // 还是同一个标题：她已经知道了，不再报。
  assert.deepEqual(perceive({ ...base, seen: first.seen }).events, []);
  // 换了窗口：报新的。
  const next = perceive({ ...base, screen: { at: NOON, title: '哔哩哔哩' }, seen: first.seen });
  assert.deepEqual(kinds(next), ['screen']);
  assert.match(next.events[0].text, /哔哩哔哩/);
  // 屏幕感知关着的时候，看到什么都不能说。
  assert.deepEqual(perceive({ ...base, screenOn: false }).events, []);
});

test('天气：过期了才提，而且只在早上提', () => {
  const staleAt = (now) => ({ weather: { at: now - WEATHER_STALE_MS - HOUR } });
  const on = { weatherOn: true };
  // 中午提「该看天气了」没有意义，只会让她半夜/中午冒一句不合时宜的话。
  assert.deepEqual(perceive({ now: NOON, ...on, ...staleAt(NOON) }).events, []);
  assert.deepEqual(kinds(perceive({ now: at(8), ...on, ...staleAt(at(8)) })), ['weather']);
  // 早上但刚查过：不用提。
  assert.deepEqual(perceive({ now: at(8), ...on, weather: { at: at(7) } }).events, []);
  // 关闭状态不提。
  assert.deepEqual(perceive({ now: at(8), weatherOn: false, ...staleAt(at(8)) }).events, []);
});

test('沉默：六小时才算一件事，五小时不算', () => {
  const five = perceive({ now: NOON, lastUserAt: NOON - SILENCE_MS + HOUR });
  assert.deepEqual(five.events, []);
  const six = perceive({ now: NOON, lastUserAt: NOON - SILENCE_MS - HOUR });
  assert.deepEqual(kinds(six), ['silence']);
  assert.match(six.events[0].text, /7 小时/);
  // 从来没说过话：不报（那是「还没开始」，不是「他很久没理我」）。
  assert.deepEqual(perceive({ now: NOON, lastUserAt: 0 }).events, []);
});

test('没问完的话：取第一条，截断', () => {
  const r = perceive({ now: NOON, pending: ['你还没说那本书叫什么', '第二个问题'] });
  assert.deepEqual(kinds(r), ['unfinished']);
  assert.match(r.events[0].text, /那本书叫什么/);
});

test('记忆：今天多记了几件才报，同一个数字不重复报', () => {
  const today = (n) => ({ records: Array.from({ length: n }, () => ({ createdAt: startOfDay(NOON) + 60e3 })) });
  const r = perceive({ now: NOON, memory: today(3) });
  assert.deepEqual(kinds(r), ['memory']);
  assert.match(r.events[0].text, /3 件事/);
  assert.deepEqual(perceive({ now: NOON, memory: today(3), seen: r.seen }).events, []);
  // 又多了一条：数字变了，值得再说一次（但她要不要开口由闸门管）。
  assert.match(perceive({ now: NOON, memory: today(4), seen: r.seen }).events[0].text, /4 件事/);
  // 昨天的记忆不算今天。
  assert.deepEqual(perceive({ now: NOON, memory: { records: [{ createdAt: startOfDay(NOON) - HOUR }] } }).events, []);
});

test('钱：低于警戒线只报一次，不每十分钟报一次账', () => {
  const base = { now: NOON, balance: 1.96, lowBalance: 5 };
  const r = perceive(base);
  assert.deepEqual(kinds(r), ['money']);
  assert.match(r.events[0].text, /1\.96/);
  assert.deepEqual(perceive({ ...base, seen: r.seen }).events, []);
  // 余额正常 / 查不到余额：都不提。
  assert.deepEqual(perceive({ now: NOON, balance: 88, lowBalance: 5 }).events, []);
  assert.deepEqual(perceive({ now: NOON, balance: null, lowBalance: 5 }).events, []);
});

test('当下：说好的事做完了才算一件事', () => {
  assert.deepEqual(kinds(perceive({ now: NOON, life: { doing: '在看书', until: NOON - 60e3 } })), ['doing']);
  // 还在做：不用管。
  assert.deepEqual(perceive({ now: NOON, life: { doing: '在看书', until: NOON + 60e3 } }).events, []);
  // 没在做什么：没有可结束的。
  assert.deepEqual(perceive({ now: NOON, life: { doing: '', until: NOON - 60e3 } }).events, []);
});

test('图：同一张只说一次，隔了一天就不算「刚才」', () => {
  const shotAt = NOON - 2 * HOUR;
  const r = perceive({ now: NOON, lastPictureAt: shotAt });
  assert.deepEqual(kinds(r), ['picture']);
  assert.match(r.events[0].text, /2 小时前/);
  assert.deepEqual(perceive({ now: NOON, lastPictureAt: shotAt, seen: r.seen }).events, []);
  // 新的那张：再说一次。
  assert.equal(perceive({ now: NOON, lastPictureAt: shotAt + 60e3, seen: r.seen }).events.length, 1);
  assert.deepEqual(perceive({ now: NOON, lastPictureAt: NOON - PICTURE_MS - HOUR }).events, []);
});

test('游戏：她刚玩完一局就报一次，换成真材料（哪款、发生了什么）', () => {
  const game = { last: { at: NOON - 5 * 60e3, game: 'g2048', title: '2048', facts: '推了 40 手，最后 512 分', label: '爽' } };
  const r = perceive({ now: NOON, game });
  assert.deepEqual(kinds(r), ['game']);
  assert.match(r.events[0].text, /2048/);
  assert.match(r.events[0].text, /512 分/);
  assert.match(r.events[0].text, /爽/);
  assert.deepEqual(perceive({ now: NOON, game, seen: r.seen }).events, []);
  // 没有真材料（facts）的旧记录不硬报——宁可不说。
  assert.deepEqual(kinds(perceive({ now: NOON, game: { last: { at: NOON - 60e3, title: '2048' } } })), []);
});

test('事件堆起来也不超过上限：context 里堆九条她会答非所问', () => {
  const t = at(8); // 早上：连天气都算一条，八种全中
  const r = perceive({
    now: t,
    screenOn: true,
    screen: { at: t, title: '某窗口' },
    weatherOn: true,
    weather: { at: t - 48 * HOUR },
    lastUserAt: t - 8 * HOUR,
    pending: ['还有一句没问'],
    memory: { records: [{ createdAt: t }] },
    balance: 0.5,
    lowBalance: 5,
    life: { doing: '在发呆', until: t - 60e3 },
    lastPictureAt: t - 60e3,
  });
  assert.equal(MAX_EVENTS, 6);
  assert.equal(r.events.length, MAX_EVENTS, '八种事件只带前六条');
  // 截断是按表顺序取的：前面几条才是她最该知道的。
  assert.equal(r.events[0].kind, 'screen');
});

test('事件文本进系统提示，长度必须封死（信任边界）', () => {
  const longTitle = '标'.repeat(200);
  const r = perceive({ now: NOON, screenOn: true, screen: { at: NOON, title: longTitle } });
  assert.ok(r.events[0].text.length <= 80, `实际 ${r.events[0].text.length}`);
  // 换行/连续空格压成一个：一行一条，不能撑破提示的结构。
  const messy = perceive({ now: NOON, screenOn: true, screen: { at: NOON, title: 'a\n\n b' } });
  assert.ok(!messy.events[0].text.includes('\n'));
});

test('时长说成人话', () => {
  assert.equal(gapWords(3 * HOUR), '3 小时');
  assert.equal(gapWords(25 * 60e3), '25 分钟');
  assert.equal(gapWords(0), '1 分钟');
});

// ---- 2026-11-22：她自己的书和念头，也是她主动开口的话题来源 ----

test('书：六小时内看过就报一条，报过的不重复报', () => {
  const novel = { bookName: '放开那个女巫', title: '第四章 火焰', label: '闷', anchor: '她在等待死亡', at: NOON - 2 * HOUR };
  const base = { now: NOON, screenOn: false, weatherOn: false, lastUserAt: NOON - 10 * 60e3, pending: [], memory: { records: [] }, balance: null, life: { doing: '', until: 0 }, lastPictureAt: 0 };
  const r = perceive({ ...base, novel });
  assert.deepEqual(kinds(r), ['novel']);
  assert.match(r.events[0].text, /放开那个女巫/);
  assert.match(r.events[0].text, /第四章 火焰/);
  assert.match(r.events[0].text, /闷/);
  // 同一次阅读不重复报
  assert.deepEqual(kinds(perceive({ ...base, novel, seen: r.seen })), []);
  // 太久了就不算「刚在看」
  assert.deepEqual(kinds(perceive({ ...base, novel: { ...novel, at: NOON - 7 * HOUR } })), []);
});

test('念头：36 小时内想过的事可以拿来开头，同一句不重复报', () => {
  const base = { now: NOON, screenOn: false, weatherOn: false, lastUserAt: NOON - 10 * 60e3, pending: [], memory: { records: [] }, balance: null, life: { doing: '', until: 0 }, lastPictureAt: 0 };
  const novel = { thoughts: [{ text: '他为什么总是不说呢', at: NOON - 20 * HOUR }] };
  const r = perceive({ ...base, novel });
  assert.deepEqual(kinds(r), ['thought']);
  assert.match(r.events[0].text, /他为什么总是不说呢/);
  assert.deepEqual(kinds(perceive({ ...base, novel, seen: r.seen })), []);
  // 超过 36 小时：过期，不提
  assert.deepEqual(kinds(perceive({ ...base, novel: { thoughts: [{ text: '旧念头', at: NOON - 40 * HOUR }] } })), []);
});
