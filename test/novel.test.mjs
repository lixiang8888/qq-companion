// 读书后端：三个接口的契约、正文清洗、下一章怎么挑。不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorOf, bookLine, DEFAULT_BASE, cleanText, createNovel, DROP_ATTITUDE, isBored, mindLine, nextRead, noteRead, noteThought, novelLine, parseBookLookup, parseReaction, planRead, reactionEmotion, REACTIONS, recentReactions, REREAD_MIN_ATTITUDE, shouldDrop, THOUGHT_KEEP, THOUGHT_TTL, thoughtLine, updateBook } from '../src/novel.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function client(routes, base) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(href);
    const path = new URL(href).pathname;
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return jsonResponse(routes[path](new URL(href)));
  };
  return { novel: createNovel({ base, fetchImpl }), calls };
}

test('书架：字段取对，空书架不是错误', async () => {
  const { novel } = client({
    '/getBookshelf': () => ({ data: [{ name: '斗破苍穹', author: '天蚕土豆', bookUrl: 'http://x/1', totalChapterNum: 1652, durChapterIndex: 3 }] }),
  });
  const shelf = await novel.shelf();
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].name, '斗破苍穹');
  assert.equal(shelf[0].total, 1652);
  assert.equal(shelf[0].lastIndex, 3);

  const empty = client({ '/getBookshelf': () => ({ isSuccess: false, errorMsg: '还没有添加小说' }) });
  // 「还没有添加小说」是正常状态，不该抛——她只是还没书读。
  assert.deepEqual(await empty.novel.shelf(), []);
  const blank = client({ '/getBookshelf': () => ({ data: [] }) });
  assert.deepEqual(await blank.novel.shelf(), []);
});

test('目录和正文：参数名是 url，正文传的是书的地址不是章节地址', async () => {
  const { novel, calls } = client({
    '/getChapterList': () => ({ data: [{ index: 0, title: '第一章 陨落的天才' }, { index: 1, title: '第二章 斗气大陆' }] }),
    '/getBookContent': () => ({ data: '正文' }),
  });
  const list = await novel.chapters('http://x/1');
  assert.equal(list.length, 2);
  assert.equal(list[1].title, '第二章 斗气大陆');
  await novel.chapter('http://x/1', 7);

  const chUrl = new URL(calls[0]);
  assert.equal(chUrl.pathname, '/getChapterList');
  assert.equal(chUrl.searchParams.get('url'), 'http://x/1');
  const bodyUrl = new URL(calls[1]);
  assert.equal(bodyUrl.searchParams.get('url'), 'http://x/1');
  assert.equal(bodyUrl.searchParams.get('index'), '7');
});

test('正文清洗：站点广告整行丢掉，行首全角缩进去掉', () => {
  const raw = [
    '　　大厅中，萧战以及三位长老正在交谈。',
    '小说尽在 顶点小说，请认准 www.xx.com',
    '　　「他来了。」',
    '   ',
    '　　更多章节请到 https://example.com 阅读',
  ].join('\n');
  const out = cleanText(raw);
  assert.equal(out, '大厅中，萧战以及三位长老正在交谈。\n「他来了。」');
  assert.ok(!out.includes('www.'));
});

test('正文：字数按洗过之后算（太短就是这条源坏了）', async () => {
  const { novel } = client({ '/getBookContent': () => ({ data: '　　第一句。\n小说尽在某某网\n　　第二句。' }) });
  const c = await novel.chapter('http://x/1', 0);
  assert.equal(c.text, '第一句。\n第二句。');
  assert.equal(c.chars, c.text.length);
});

test('挑下一章：接着上次往后；读到底从头再来', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ index: i, title: `第${i + 1}章 标题` }));
  assert.deepEqual(planRead(mk(10), {}).index, 0);
  assert.deepEqual(planRead(mk(10), { index: 3, lastNum: 4 }).index, 4);
  // 读完最后一章：回到第一章重读，标记 wrapped
  const done = planRead(mk(10), { index: 9, lastNum: 10 });
  assert.equal(done.index, 0);
  assert.equal(done.wrapped, true);
  // 空目录不抛
  assert.equal(planRead([], {}).index, 0);
});

test('目录有重复章：不会再读一遍同一章', () => {
  // 真实情况：有的书源把第 2 章列了两次
  const list = [
    { index: 0, title: '第1章 开始' },
    { index: 1, title: '第2章 出发' },
    { index: 2, title: '第2章 出发' },
    { index: 3, title: '第3章 到达' },
  ];
  const next = planRead(list, { index: 1, lastNum: 2, readTitles: ['第2章 出发', '第1章 开始'] });
  assert.equal(next.title, '第3章 到达', '跳过重复的那条，直接读到第 3 章');
  assert.equal(next.gap, 0);
});

test('目录缺章：跳过去，并且如实把缺的数量报出来', () => {
  // 真实情况：第 3 章后面直接是第 6 章
  const list = [
    { index: 0, title: '第1章 一' },
    { index: 1, title: '第2章 二' },
    { index: 2, title: '第3章 三' },
    { index: 3, title: '第6章 六' },
  ];
  const next = planRead(list, { index: 2, lastNum: 3, readTitles: ['第3章 三'] });
  assert.equal(next.title, '第6章 六');
  assert.equal(next.gap, 2, '3 之后是 6，中间缺了 4 和 5');
});

test('没有章号的书（番外/卷名）：退回按下标走，跳过读过的标题', () => {
  const list = [
    { index: 0, title: '序章' },
    { index: 1, title: '番外 一' },
    { index: 2, title: '番外 二' },
  ];
  const next = planRead(list, { index: 0, readTitles: ['序章'] });
  assert.equal(next.title, '番外 一');
});

test('后端没开：给一句人话，不是 TypeError', async () => {
  const novel = createNovel({ base: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => novel.shelf(), /ECONNREFUSED/);
});

test('默认地址就在本机转发的那个口上', () => {
  assert.equal(DEFAULT_BASE, 'http://127.0.0.1:1123');
});

// ---- 什么时候该看、看完怎么记 ----

const H = 3600e3;
const NOON = new Date(2026, 0, 1, 12, 0, 0).getTime();

test('无聊的判据：他安静够久、今天读得不多、心情还行', () => {
  const base = { now: NOON, lastUserAt: NOON - 3 * H, lastReadAt: NOON - 1 * H, readsToday: 0, mood: 0.6 };
  assert.equal(isBored(base), true);
  // 他两小时前刚说过话：还不算无聊
  assert.equal(isBored({ ...base, lastUserAt: NOON - 1 * H }), false);
  // 十分钟内刚读过：不在同一个心跳里连读
  assert.equal(isBored({ ...base, lastReadAt: NOON - 5 * 60e3 }), false);
  // 今天读够了（上限 80 章）
  assert.equal(isBored({ ...base, readsToday: 80 }), false);
  assert.equal(isBored({ ...base, readsToday: 79 }), true);
  // 心情太低：那会儿看书是躲，不是消遣
  assert.equal(isBored({ ...base, mood: 0.2 }), false);
  // 从没说过话 / 没书：都不读
  assert.equal(isBored({ ...base, lastUserAt: 0 }), false);
  assert.equal(isBored({ ...base, hasBook: false }), false);
});

test('读书进度：记下书、章节、章号、感想；换书就重新算', () => {
  const s = noteRead({}, { now: NOON, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 3, title: '第4章 云岚宗', num: 4, thought: `  ${'想'.repeat(300)}  ` });
  assert.equal(s.bookName, '斗破苍穹');
  assert.equal(s.index, 3);
  assert.equal(s.at, NOON);
  assert.equal(s.lastNum, 4);
  assert.equal(s.thought.length, 120, '感想上限 120 字');
  assert.deepEqual(s.readTitles, ['第4章 云岚宗']);

  // 同一本书接着读：章号和标题都累积
  const again = noteRead(s, { now: NOON + 1, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 4, title: '第5章 聚气散', num: 5 });
  assert.equal(again.bookName, '斗破苍穹');
  assert.equal(again.lastNum, 5);
  assert.deepEqual(again.readTitles.slice(0, 2), ['第5章 聚气散', '第4章 云岚宗']);

  // 换了本书：章号和读过的标题都清掉，从这本自己的第 1 章算
  const other = noteRead(again, { now: NOON + 2, book: { bookUrl: 'http://y/2', name: '遮天' }, index: 0, title: '第一章 星空中的青铜巨棺', num: 1 });
  assert.equal(other.bookName, '遮天');
  assert.equal(other.lastNum, 1);
  assert.deepEqual(other.readTitles, ['第一章 星空中的青铜巨棺']);
});

test('注入那一行：说清在看什么、看到哪、当时想什么', () => {
  const s = noteRead({}, { now: NOON, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 2, title: '第三章', thought: '有点替他不值' });
  const line = novelLine(s, NOON + 2 * H);
  assert.match(line, /《斗破苍穹》/);
  assert.match(line, /第 3 章/);
  assert.match(line, /有点替他不值/);
  assert.match(line, /2 小时前/);
  // 没读过就一个字都不写
  assert.equal(novelLine({}, NOON), '');
  assert.equal(novelLine({ bookName: '' }, NOON), '');
});

// ---- 2026-11-18：洗广告（三家源都实测过）、反应→情绪、占位章跳过、[书:] 查阅 ----

test('洗广告：顶点每章开头的站名广告整行丢掉，正文不动', () => {
  const raw = [
    '　　萧炎抬起头来，目光扫过人群。',
    '　　顶点小说 请记住我们的网址：www .x23us.us',
    '　　》二三中文全文字更新,牢记网址:m.23uswx.la',
    '　　「我认输。」',
  ].join('\n');
  const out = cleanText(raw);
  assert.equal(out, '萧炎抬起头来，目光扫过人群。\n「我认输。」');
  assert.ok(!/网址|www|m\.23uswx/.test(out));
});

test('洗广告：夹在长段落里的混淆贴片只删那一段，同行的正文留着', () => {
  const raw = '　　生命是世间最伟大的奇迹。\\wＷｗ。 q Β5 .COM \\． 　　四方上下曰宇。';
  const out = cleanText(raw);
  assert.match(out, /生命是世间最伟大的奇迹/);
  assert.match(out, /四方上下曰宇/);
  assert.ok(!/COM/.test(out), '贴片要删干净');
});

test('反应解析：标记拆出来，标记从感想里剔掉', () => {
  const text = '又是这种打脸桥段，饭都凉了。[读:烦 2 想弃]';
  const r = parseReaction(text, '');
  assert.equal(r.thought, '又是这种打脸桥段，饭都凉了。');
  assert.equal(r.label, '烦');
  assert.equal(r.intensity, 2);
  assert.equal(r.want, '想弃');
  // 没写标记 = 无感；感想照存（那是她的话）
  const plain = parseReaction('还行吧', '');
  assert.equal(plain.label, '无感');
  assert.equal(plain.thought, '还行吧');
  assert.equal(reactionEmotion(plain), null);
});

test('锚点：引文对得上才算读过；对不上再用连续 5 字重合兜底', () => {
  const body = '他紧握的手掌因为大力，尖锐的指甲深深的刺进了掌心之中，带来一阵疼痛。';
  assert.equal(anchorOf('「刺进了掌心」这段看得我手心也跟着疼', body), '刺进了掌心');
  // 没有引号但确实用了原文五个字
  assert.equal(anchorOf('尖锐的指甲刺进了掌心，疼', body), '尖锐的指甲');
  // 泛泛而谈：没有锚点
  assert.equal(anchorOf('这章真好看，主角太惨了', body), '');
  assert.equal(anchorOf('这章真好看', '完全不相干的正文内容在这里'), '');
});

test('反应 → 情绪：七个标签各自的 v/a/d，强度 1~3，无锚点不推', () => {
  for (const [label, want] of Object.entries(REACTIONS)) {
    const r = { label, intensity: 2, anchored: true, thought: 'x', anchor: 'x' };
    const e = reactionEmotion(r);
    if (!want) { assert.equal(e, null, `${label} 不该有情绪`); continue; }
    assert.equal(e.label, label);
    assert.equal(e.v, want.v);
    assert.equal(e.a, want.a);
    assert.equal(e.d, want.d);
    assert.equal(e.intensity, 0.5);
  }
  // 强度换算
  assert.equal(reactionEmotion({ label: '爽', intensity: 1, anchored: true }).intensity, 0.3);
  assert.equal(reactionEmotion({ label: '爽', intensity: 3, anchored: true }).intensity, 0.75);
  // 没锚点：不推情绪（账也没记）
  assert.equal(reactionEmotion({ label: '爽', intensity: 3, anchored: false }), null);
});

test('占位章跳过：推进进度，但不覆盖上一次的感想和标签', () => {
  const book = { bookUrl: 'http://x/1', name: '宿命之环' };
  const read = noteRead({}, { now: NOON, book, index: 0, title: '第一章 欢迎收藏', thought: '好吧', label: '闷', anchor: '好吧' });
  const skipped = noteRead(read, { now: NOON + 1, book, index: 1, title: '第二章 占位', num: 2, skipped: true });
  assert.equal(skipped.index, 1, '进度往前走');
  assert.equal(skipped.lastNum, 2);
  assert.equal(skipped.thought, '好吧', '感想还是上一次的');
  assert.equal(skipped.label, '闷');
  assert.equal(skipped.skippedChapters, 1);
  // 下一次真读到，计数归零
  const back = noteRead(skipped, { now: NOON + 2, book, index: 2, title: '第三章 真东西', num: 3, thought: '这次有点意思', label: '触动' });
  assert.equal(back.skippedChapters, 0);
  assert.equal(back.thought, '这次有点意思');
});

test('注入那一行：刚读完的滋味在，过了 40 分钟就只剩「当时想的是」', () => {
  const s = noteRead({}, { now: NOON, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 2, title: '第三章', thought: '有点替他不值', label: '闷', anchor: '替他不值' });
  assert.match(novelLine(s, NOON + 10 * 60e3), /闷/);
  const later = novelLine(s, NOON + 2 * H);
  assert.doesNotMatch(later, /闷/);
  assert.match(later, /有点替他不值/);
});

test('[书:] 想看什么：目录 / 第 N 章都认，看不懂就不动', () => {
  assert.deepEqual(parseBookLookup('目录'), { kind: 'toc' });
  assert.deepEqual(parseBookLookup('更新到哪了'), { kind: 'toc' });
  assert.deepEqual(parseBookLookup('第12章'), { kind: 'chapter', index: 11 });
  assert.deepEqual(parseBookLookup('12'), { kind: 'chapter', index: 11 });
  assert.equal(parseBookLookup('随便看看'), null);
  assert.equal(parseBookLookup(''), null);
});

test('书架带上源名：换个源之后她/日志能看出是哪家', async () => {
  const { novel } = client({
    '/getBookshelf': () => ({ data: [{ name: '遮天', bookUrl: 'http://x/1', totalChapterNum: 1877, originName: '顶点小说' }] }),
  });
  const [b] = await novel.shelf();
  assert.equal(b.origin, '顶点小说');
});

// ---- 2026-11-18：P2 对书的态度 / 弃书 / 追更 / 重读；P3 念头 ----

const BOOK = (url, name, total = 100) => ({ bookUrl: url, name, total, origin: '顶点小说' });

test('态度账本：连烦态度一路跌到弃书线，连爽是正的但不弃', () => {
  let rec = { name: '斗破苍穹' };
  const seen = [];
  for (let i = 0; i < 5; i++) {
    rec = updateBook(rec, { reaction: { label: '烦', intensity: 2, thought: '又是这一套' }, title: `第${i + 1}章`, now: NOON + i });
    seen.push(rec.attitude);
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1], '每章都在往下掉');
  assert.ok(seen.at(-1) <= DROP_ATTITUDE);
  assert.equal(rec.streak, 5);
  assert.equal(shouldDrop(rec), true);
  assert.equal(rec.recent.length, 5, '最近五章的反应留着，下一次反应要用');
  assert.equal(rec.recent[0].title, '第5章');

  let good = { name: '遮天' };
  for (let i = 0; i < 3; i++) good = updateBook(good, { reaction: { label: '爽', intensity: 2 }, title: `第${i + 1}章`, now: NOON + i });
  assert.ok(good.attitude > REREAD_MIN_ATTITUDE, '读得高兴，值得重读');
  assert.equal(shouldDrop(good), false);
  assert.equal(good.streak, 0);
});

test('态度账本：无感也在缓慢消耗；没锚点的反应不算账', () => {
  let bored = { name: '完美世界' };
  for (let i = 0; i < 10; i++) bored = updateBook(bored, { reaction: { label: '无感' }, title: `第${i + 1}章`, now: NOON + i });
  assert.ok(bored.attitude < 0, '无聊也是消耗');
  assert.ok(bored.attitude > -0.3, '但很慢（每章 −0.03），十章还不该弃');
  assert.equal(shouldDrop(bored), false);

  const none = updateBook({ name: 'x', attitude: 0.2 }, { reaction: { label: '' }, title: '第1章', now: NOON });
  assert.equal(none.attitude, 0.2, '引不出原文的反应该一个字都不动');
  assert.deepEqual(none.recent, []);
  assert.equal(none.lastLabel, '');
});

test('弃书判据：前三章不判、连烦 5 章、连说两次想弃', () => {
  assert.equal(shouldDrop({ reads: 2, streak: 9, attitude: -1 }), false, '开头难看很正常');
  assert.equal(shouldDrop({ reads: 3, streak: 5, attitude: 0 }), true);
  assert.equal(shouldDrop({ reads: 3, streak: 1, wantDrop: 2, attitude: 0 }), true);
  assert.equal(shouldDrop({ reads: 3, streak: 1, wantDrop: 1, attitude: -0.4 }), false);
  assert.equal(shouldDrop({}), false);
});

test('下一本读哪：接着读 / 重读 / 换一本 / 追更等着', () => {
  const shelf = [BOOK('u1', '斗破苍穹'), BOOK('u2', '缺章源', 0), BOOK('u3', '完美世界')];
  // 没有能读的：等着，不空转
  assert.equal(nextRead({ shelf: [], books: {}, state: {} }).kind, 'wait');
  assert.equal(nextRead({ shelf: [BOOK('u1', 'x', 0)], books: {}, state: {} }).kind, 'wait', '0 章是取目录失败，跳过');
  // 上次那本没读完 → 接着读
  const cont = nextRead({ shelf, books: { u1: { reads: 3 } }, state: { bookUrl: 'u1' } });
  assert.equal(cont.kind, 'continue');
  assert.equal(cont.book.bookUrl, 'u1');
  // 读完了、态度好 → 重读同一本
  const re = nextRead({ shelf, books: { u1: { reads: 30, attitude: 0.4, finishedAt: NOON } }, state: { bookUrl: 'u1' } });
  assert.equal(re.kind, 'reread');
  assert.equal(re.book.bookUrl, 'u1');
  // 读完了、态度不好 → 换一本没读过的
  const sw = nextRead({ shelf, books: { u1: { reads: 30, attitude: -0.6, finishedAt: NOON } }, state: { bookUrl: 'u1' } });
  assert.equal(sw.kind, 'switch');
  assert.equal(sw.book.bookUrl, 'u3');
  // 弃过的不再选
  const afterDrop = nextRead({ shelf, books: { u1: { droppedAt: NOON } }, state: { bookUrl: 'u1' } });
  assert.equal(afterDrop.kind, 'switch');
  assert.equal(afterDrop.book.bookUrl, 'u3');
  // 上次那本弃了、另有一本读了一半：先接着那本，别当没读过（否则会一直等下去）
  const half = nextRead({ shelf, books: { u1: { droppedAt: NOON }, u3: { reads: 4 } }, state: { bookUrl: 'u1' } });
  assert.equal(half.kind, 'switch');
  assert.equal(half.book.bookUrl, 'u3');
  // 全弃了 → 追更等着
  assert.equal(nextRead({ shelf, books: { u1: { droppedAt: NOON }, u3: { droppedAt: NOON } }, state: { bookUrl: 'u1' } }).kind, 'wait');
  // 同一本只重读一次
  const once = nextRead({ shelf: [BOOK('u1', 'x')], books: { u1: { reads: 30, attitude: 0.9, finishedAt: NOON, reReadAt: NOON + 1 } }, state: { bookUrl: 'u1' } });
  assert.equal(once.kind, 'wait');
});

test('对书态度那一行：真的占分量才说', () => {
  const st = { bookUrl: 'u1', bookName: '斗破苍穹', at: NOON, books: { u1: { name: '斗破苍穹', attitude: -0.35 } } };
  assert.match(bookLine(st), /《斗破苍穹》有点腻/);
  assert.match(bookLine({ ...st, books: { u1: { name: '斗破苍穹', attitude: 0.6 } } }), /挺喜欢/);
  assert.match(bookLine({ ...st, books: { u1: { name: '斗破苍穹', attitude: -0.6 } } }), /快看不下去了/);
  assert.equal(bookLine({ ...st, books: { u1: { name: '斗破苍穹', attitude: 0.1 } } }), '');
  assert.equal(bookLine({}), '');
});

test('念头：36 小时内注入，过期就不提；超过 20 条只留最近的', () => {
  const st = noteThought({}, '他好像也是这样，嘴上不说', NOON);
  assert.equal(st.thoughts.length, 1);
  assert.match(thoughtLine(st, NOON + H), /嘴上不说/);
  assert.equal(thoughtLine(st, NOON + 40 * H), '');
  assert.equal(thoughtLine({}, NOON), '');

  let many = {};
  for (let i = 0; i < 25; i++) many = noteThought(many, `念头 ${i}`, NOON + i);
  assert.equal(many.thoughts.length, THOUGHT_KEEP);
  assert.equal(many.thoughts.at(-1).text, '念头 24');
  assert.equal(noteThought({}, '   ', NOON).thoughts, undefined, '空念头不记');
  assert.equal(noteThought({}, '想'.repeat(300), NOON).thoughts[0].text.length, 100);
});

test('每轮只注入一条读书的内容：念头 > 对书态度 > 读到哪', () => {
  const base = {
    bookUrl: 'u1', bookName: '斗破苍穹', index: 2, title: '第3章', thought: '有点替他不值',
    at: NOON, books: { u1: { name: '斗破苍穹', attitude: -0.4 } },
  };
  const withAttitude = mindLine(base, NOON);
  assert.match(withAttitude.text, /有点腻/, '有态度就报态度');
  assert.equal(withAttitude.ttl, 12 * H);
  const withThought = mindLine(noteThought(base, '主角太倔了', NOON), NOON);
  assert.match(withThought.text, /这两天自己在想/);
  assert.equal(withThought.ttl, THOUGHT_TTL);
  const plain = mindLine({ ...base, books: {} }, NOON);
  assert.match(plain.text, /《斗破苍穹》/);
  assert.match(plain.text, /有点替他不值/);
  assert.deepEqual(mindLine({}, NOON), { text: '', at: NOON, ttl: 12 * H });
});

test('最近几章的反应：新的在前、能按时间切、跨书汇总', () => {
  const st = {
    books: {
      u1: { name: '斗破苍穹', recent: [{ title: '第2章', label: '闷', at: NOON - H }, { title: '第1章', label: '爽', at: NOON - 2 * H }] },
      u2: { name: '遮天', recent: [{ title: '第1章', label: '触动', at: NOON }] },
    },
  };
  assert.deepEqual(recentReactions(st, { limit: 5 }).map((r) => r.book), ['遮天', '斗破苍穹', '斗破苍穹']);
  assert.deepEqual(recentReactions(st, { since: NOON - H / 2 }).map((r) => r.label), ['触动']);
  assert.deepEqual(recentReactions({}, {}), []);
});
