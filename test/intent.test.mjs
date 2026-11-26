// 她心里还没完成的事：账本、注入、销账、开口判定、驱力、目标。
// 全是纯函数，时钟注入——不走真模型、不读盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_DEFAULTS, MAX_SHOWN, addLoop, bestRun, computeDrives, createIntents, deriveGoal, detectDone,
  detectSpoken, driveLine, dueLoops, expireDue, isOpen, looksLikeShell, makeLoop, markDropped, markMissed,
  markSpoken, mentions, openLoops, parseShare, parseWant, promptLoopLines, renderIntentBlock,
  renderPromiseBlock, shareGate,
} from '../src/intent.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
const at = (ms = 0, hour = 9) => new Date(2026, 0, 1, hour, 0, 0).getTime() + ms;
const DAY_KEY = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const tell = (over = {}) => makeLoop({
  kind: 'tell', about: 'novel', text: '想跟他讲地蛋这名字', source: 'novel:book:140',
  anchor: '地蛋这名字', label: '《放开那个女巫》', weight: 0.6, now: T0, ...over,
});

// ---- 账本 ----

test('造账：必须有出处、有正文、kind 合法；否则宁可不记', () => {
  assert.ok(tell());
  assert.equal(makeLoop({ kind: 'tell', text: '想说', source: '' }), null, '没出处不许记');
  assert.equal(makeLoop({ kind: 'tell', text: '', source: 'x' }), null, '没正文不许记');
  assert.equal(makeLoop({ kind: '瞎写', text: '想说', source: 'x' }), null, 'kind 不合法');
  assert.equal(tell({ text: '啊'.repeat(200) }).text.length, 60, '正文长度封死');
});

test('寿命按 kind 分：想说 48h，想问 48h，想做 36h，没回 6h', () => {
  assert.equal(tell().expiresAt - T0, 48 * HOUR);
  assert.equal(makeLoop({ kind: 'ask', text: '海在哪', source: 's', now: T0 }).expiresAt - T0, 48 * HOUR);
  assert.equal(makeLoop({ kind: 'do', text: '读两章', source: 's', now: T0 }).expiresAt - T0, 36 * HOUR);
  assert.equal(makeLoop({ kind: 'reply', text: '他在问啥', source: 's', now: T0 }).expiresAt - T0, 6 * HOUR);
});

test('同一出处再来一次：合并，不重复占位；不同出处分开记', () => {
  let st = createIntents();
  st = addLoop(st, tell({ text: '第一次' }));
  st = addLoop(st, tell({ text: '第二次', weight: 0.9, now: T0 + HOUR }));
  assert.equal(st.loops.length, 1, '同 kind + 同出处只占一条');
  assert.equal(st.loops[0].text, '第二次', '后一次的想法覆盖');
  assert.equal(st.loops[0].weight, 0.9, '权重取高的');
  st = addLoop(st, tell({ source: 'novel:other', text: '另一件事' }));
  assert.equal(st.loops.length, 2);
});

test('还没到点的不算「可以开口」；到点才算', () => {
  const later = makeLoop({ kind: 'reply', text: '他问了你', source: 'his:1', now: T0, dueAt: T0 + 20 * 60e3 });
  const st = addLoop(createIntents(), later);
  assert.equal(dueLoops(st, T0).length, 0);
  assert.equal(dueLoops(st, T0 + 21 * 60e3).length, 1);
});

test('过期：想说/想做/没回会作废，答应过的不在这种过期里（要认账）', () => {
  let st = createIntents();
  st = addLoop(st, tell());
  st = addLoop(st, makeLoop({ kind: 'promise', text: '回来给你讲', source: 'p:1', now: T0 }));
  const r = expireDue(st, T0 + 49 * HOUR);
  assert.deepEqual(r.expired.length, 1);
  assert.ok(r.state.loops.find((l) => l.kind === 'tell').expiredAt > 0);
  assert.equal(r.state.loops.find((l) => l.kind === 'promise').expiredAt, 0, '承诺不按时间作废');
});

test('销账之后不再是「开着」的，也不会再被选中', () => {
  const l = tell();
  let st = addLoop(createIntents(), l);
  assert.equal(openLoops(st, T0 + HOUR).length, 1);
  st = markSpoken(st, l.id, T0 + HOUR);
  assert.equal(openLoops(st, T0 + HOUR).length, 0);
  st = markDropped(addLoop(createIntents(), tell()), l.id, T0);
  assert.equal(openLoops(st, T0).length, 0);
  // missed 也算关掉（承诺那条单独看 missedAt）
  const p = makeLoop({ kind: 'promise', text: '回来给你讲', source: 'p:1', now: T0 });
  st = markMissed(addLoop(createIntents(), p), p.id, T0);
  assert.equal(openLoops(st, T0).length, 0, '没做到也是关掉的一种');
});

// ---- 注入 ----

test('注入块：最多两条、带时间和出处，没账就不写', () => {
  assert.equal(renderIntentBlock(createIntents(), T0), '');
  let st = createIntents();
  st = addLoop(st, tell());
  st = addLoop(st, makeLoop({ kind: 'reply', text: '在不在', source: 'his:2', now: T0 + 60e3 }));
  st = addLoop(st, makeLoop({ kind: 'do', text: '把书桌归一遍', source: 'imp:3', now: T0 + 2 * 60e3 }));
  const text = renderIntentBlock(st, T0 + 5 * 60e3);
  assert.match(text, /你手里还有件事没跟他说/);
  assert.match(text, /地蛋这名字/);
  assert.match(text, /他问了你「在不在」，你还没回/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, MAX_SHOWN, '不多不少，就两条');
  assert.match(text, /想不想说都行/);
  // 到点之前不出现（还没到能说的时候）
  const later = addLoop(createIntents(), makeLoop({ kind: 'reply', text: '在吗', source: 'his:9', now: T0, dueAt: T0 + HOUR }));
  assert.equal(renderIntentBlock(later, T0), '');
});

test('承诺块：到点没兑现 / 后来没做到，都要写出来；没到点不写', () => {
  const l = makeLoop({ kind: 'promise', text: '回来给你讲结局', source: 'p:1', now: T0, dueAt: T0 + 2 * HOUR });
  let st = addLoop(createIntents(), l);
  assert.equal(renderPromiseBlock(st, T0 + HOUR), '', '还没到点不催');
  assert.match(renderPromiseBlock(st, T0 + 3 * HOUR), /还没兑现/);
  st = markMissed(st, l.id, T0 + DAY);
  assert.match(renderPromiseBlock(st, T0 + DAY), /没做到/);
});

// ---- 解析 ----

test('读她想说的那一句：没有就空，被 token 切断的残片不算话', () => {
  assert.deepEqual(parseShare('有点闷。[读:闷 2 继续]'), { text: '有点闷。[读:闷 2 继续]', share: '' });
  const got = parseShare('有点闷。\n[读:闷 2 继续]\n[想说:想跟他讲地蛋这名字]');
  assert.equal(got.share, '想跟他讲地蛋这名字');
  assert.doesNotMatch(got.text, /想说/);
  assert.equal(parseShare('好。[想说:没有]').share, '', '「没有」就是没有');
  assert.equal(parseShare('好。[想说').share, '', '截断的半个标记不许当话');
  assert.ok(parseShare(`[想说:${'长'.repeat(100)}]`).share.length <= 60);
});

test('读她想做的那一件小事', () => {
  assert.equal(parseWant('嘀咕一句\n[想做:把剩下的两章读完]').want, '把剩下的两章读完');
  assert.equal(parseWant('嘀咕一句').want, '');
  assert.equal(parseWant('[想做:算了]').want, '');
});

test('「说过没有」：引文锚点命中、或者连续四个字对得上', () => {
  assert.equal(bestRun('地蛋这名字太土了', '想跟他讲地蛋这名字'), 5);
  assert.ok(mentions('我跟你说，地蛋这名字笑死', tell()));
  assert.ok(!mentions('今天好累', tell()));
  assert.ok(!mentions('', tell()));
});

test('她真的说出口了：销账；回他话的 reply 账也销', () => {
  let st = createIntents();
  st = addLoop(st, tell());
  st = addLoop(st, makeLoop({ kind: 'reply', text: '在不在', source: 'his:2', now: T0 }));
  const r1 = detectSpoken(st, '没啥好说的', T0 + HOUR);
  assert.deepEqual(r1.spoken.length, 1, '只有 reply 那条被销');
  const r2 = detectSpoken(st, '地蛋这名字太土了', T0 + HOUR);
  assert.equal(r2.spoken.length, 2, '两个都对上');
  assert.equal(openLoops(r2.state, T0 + HOUR).length, 0);
});

test('空壳判定：只有话头没有内容', () => {
  for (const s of ['在吗', '我跟你说个事', '问你个事。', '欸？']) assert.ok(looksLikeShell(s), s);
  for (const s of ['我跟你说，地蛋这名字', '我今天看了本书', '我想你了']) assert.ok(!looksLikeShell(s), s);
});

// ---- 开口判定 ----

const DAY_T0 = at(0);
const quietCfg = { quietFrom: 0, quietTo: 0 }; // 测试里不踩安静时段
const shareCfg = { ...INTENT_DEFAULTS, ...quietCfg };

test('有话说：没账不开口；账没到点不开口', () => {
  const lastUserAt = DAY_T0 - 4 * HOUR;
  const none = shareGate({ now: DAY_T0, cfg: { ...quietCfg }, loops: [], state: {}, lastUserAt, mood: 0.6 });
  assert.equal(none.ok, false);
  assert.match(none.reason, /没有/);
  const later = addLoop(createIntents(), makeLoop({ kind: 'reply', text: '在吗', source: 'his:1', now: DAY_T0, dueAt: DAY_T0 + HOUR }));
  const r = shareGate({ now: DAY_T0, cfg: { ...quietCfg }, loops: later.loops, state: {}, lastUserAt, mood: 0.6 });
  assert.equal(r.ok, false);
});

test('有话说：他安静够久 + 手里有到点的事 = 可以开口，最多带两条', () => {
  let st = createIntents();
  st = addLoop(st, tell({ source: 'n:1' }));
  st = addLoop(st, tell({ source: 'n:2', text: '第二件事' }));
  st = addLoop(st, tell({ source: 'n:3', text: '第三件事' }));
  const lastUserAt = DAY_T0 - 3 * HOUR;
  const r = shareGate({ now: DAY_T0, cfg: shareCfg, loops: st.loops, state: {}, lastUserAt, mood: 0.6 });
  assert.equal(r.ok, true);
  assert.equal(r.loops.length, 2, '一次只递两条，再多就成汇报');
});

test('有话说：他刚说完不插播；睡着的她不说；心情太低不说；安静时段不说', () => {
  const st = addLoop(createIntents(), tell({ now: DAY_T0 - HOUR }));
  const base = { now: DAY_T0, cfg: shareCfg, loops: st.loops, state: {}, mood: 0.6 };
  assert.match(shareGate({ ...base, lastUserAt: DAY_T0 - 5 * 60e3 }).reason, /刚说完/);
  assert.match(shareGate({ ...base, lastUserAt: DAY_T0 - 3 * HOUR, rhythm: { state: 'asleep' } }).reason, /睡/);
  assert.match(shareGate({ ...base, lastUserAt: DAY_T0 - 3 * HOUR, mood: 0.1 }).reason, /心情/);
  const night = new Date(2026, 0, 1, 23, 30).getTime();
  assert.match(shareGate({ ...base, now: night, lastUserAt: night - 3 * HOUR }).reason, /安静时段/);
});

test('有话说：额度用完 / 刚主动过 / 连发在等他，都不说', () => {
  const st = addLoop(createIntents(), tell({ now: DAY_T0 - HOUR }));
  const day = DAY_KEY(DAY_T0);
  const base = { now: DAY_T0, cfg: shareCfg, loops: st.loops, mood: 0.6, lastUserAt: DAY_T0 - 3 * HOUR };
  assert.match(shareGate({ ...base, state: { day, share: { day, n: 2 } } }).reason, /今天说过了/);
  assert.match(shareGate({ ...base, state: { day, lastPokeAt: DAY_T0 - 10 * 60e3 } }).reason, /刚主动过/);
  const hist = [
    { role: 'user', at: DAY_T0 - 5 * HOUR, text: '在吗' },
    { role: 'assistant', at: DAY_T0 - 4 * HOUR, text: '在' },
    { role: 'assistant', at: DAY_T0 - 3 * HOUR, text: '人呢' },
  ];
  assert.match(shareGate({ ...base, history: hist }).reason, /连着/);
});

test('有话说：总主动额度受 proactive 的 maxPerDay 管', () => {
  const st = addLoop(createIntents(), tell({ now: DAY_T0 - HOUR }));
  const day = DAY_KEY(DAY_T0);
  const r = shareGate({
    now: DAY_T0, cfg: shareCfg, pokeCfg: { maxPerDay: 3, quietFrom: 0, quietTo: 0 },
    loops: st.loops, state: { day, count: 3 }, mood: 0.6, lastUserAt: DAY_T0 - 3 * HOUR,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /够多/);
});

// ---- 驱力 ----

test('驱力：全部由真事算，固定输入固定输出', () => {
  const d = computeDrives({
    now: at(0, 10), lastUserAt: at(0, 10) - 4 * HOUR, loops: [], novel: {}, game: {},
    facts: { items: [] }, relation: { intimacy: 0.4 }, emotion: { label: '' },
  });
  assert.equal(d.miss, Math.round((((4 - 1) / 11) * 0.6 + 0.4 * 0.4) * 100) / 100);
  assert.equal(d.share, 0);
  assert.equal(d.proud, 0);
  const again = computeDrives({
    now: at(0, 10), lastUserAt: at(0, 10) - 4 * HOUR, loops: [], novel: {}, game: {},
    facts: { items: [] }, relation: { intimacy: 0.4 }, emotion: { label: '' },
  });
  assert.deepEqual(d, again, '同一输入必须给出同一结果');
});

test('驱力：手里有想说的事，share 就上来；最冲的那股写成一句话', () => {
  const st = addLoop(createIntents(), tell({ now: DAY_T0 - HOUR, weight: 0.9 }));
  const d = computeDrives({
    now: DAY_T0, lastUserAt: DAY_T0 - HOUR, loops: st.loops, novel: {}, game: {},
    facts: { items: [] }, relation: { intimacy: 0.4 }, emotion: {},
  });
  assert.ok(d.share >= 0.3);
  assert.equal(driveLine(d), '有件事想跟他说');
  assert.equal(driveLine({}), '');
});

test('驱力：今天通关了才算「想让他知道你干了什么」', () => {
  const game = { last: { at: DAY_T0 - HOUR, victory: true }, library: { pvz: { cleared: [1] } } };
  const d = computeDrives({
    now: DAY_T0, lastUserAt: DAY_T0 - HOUR, loops: [], novel: {}, game,
    facts: { items: [] }, relation: {}, emotion: {},
  });
  assert.ok(d.proud >= 0.4);
  const oldGame = { last: { at: DAY_T0 - 3 * DAY, victory: true }, library: {} };
  const d2 = computeDrives({
    now: DAY_T0, lastUserAt: DAY_T0 - HOUR, loops: [], novel: {}, game: oldGame,
    facts: { items: [] }, relation: {}, emotion: {},
  });
  assert.equal(d2.proud, 0);
});

// ---- 做完 / 目标 ----

test('做完的事：读过书 / 过了关，按真事件核销', () => {
  let st = createIntents();
  st = addLoop(st, makeLoop({ kind: 'do', about: 'novel', text: '读两章', source: 'imp:1', now: T0 }));
  st = addLoop(st, makeLoop({ kind: 'do', about: 'game', text: '过一关', source: 'imp:2', now: T0, target: { level: 2 } }));
  const r = detectDone(st, { now: T0 + HOUR, novel: { at: T0 + 30 * 60e3 }, game: { last: null, library: { pvz: { cleared: [1] } } } });
  assert.equal(r.done.length, 1, '读书那条完成；第 2 关还没过');
  assert.equal(openLoops(r.state, T0 + HOUR).length, 1);
  const r2 = detectDone(r.state, { now: T0 + 2 * HOUR, novel: {}, game: { library: { pvz: { cleared: [1, 2] } } } });
  assert.equal(r2.done.length, 1);
});

test('跨天目标：只从真进度里算；一天只看一次', () => {
  const novel = { bookName: '放开那个女巫', bookUrl: 'http://x/1', index: 141, bookTotal: 150 };
  const g = deriveGoal(createIntents(), { now: T0, novel, game: {} });
  assert.ok(g);
  assert.match(g.text, /剩下的 8 章读完/);
  assert.equal(g.kind, 'do');
  // 只剩很多章时不立「读完」这个目标，退回到游戏目标
  const far = deriveGoal(createIntents(), { now: T0, novel: { ...novel, index: 10, bookTotal: 150 }, game: {} });
  assert.ok(far);
  assert.match(far.text, /第 1 关/);
  // 游戏目标：第五关之前，第 cleared+1 关
  const gm = deriveGoal(createIntents(), { now: T0, novel: {}, game: { library: { pvz: { cleared: [1, 2] } } } });
  assert.ok(gm);
  assert.match(gm.text, /第 3 关/);
  // 同一天已经看过就不再派生
  const st = { ...addLoop(createIntents(), g), goalDay: DAY_KEY(T0) };
  assert.equal(deriveGoal(st, { now: T0 + HOUR, novel, game: {} }), null);
});

test('开口提示那几行带 id，她挑哪条都认得出', () => {
  const l = tell();
  const lines = promptLoopLines([l], T0);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(l.id));
  assert.match(lines[0], /想跟他说/);
});
